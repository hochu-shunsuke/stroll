import assert from 'node:assert/strict';
import { createServer } from 'vite';

/**
 * 雲の「どこかに切れ目があるか」ではなく、画面の何割を占めるかを測る。
 *
 * シェーダと同じ値ノイズを CPU で再現し、PC の横長画面で見上げた空を
 * 複数シード・複数方向から標本化する。GLSL の式を変えた場合は、この写しも
 * 同時に更新して、実画面との比較から閾値を決め直すこと。
 */

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

try {
  const [{ MORNING }, { hashSeed }] = await Promise.all([
    server.ssrLoadModule('/src/render/sky.ts'),
    server.ssrLoadModule('/src/core/rng.ts'),
  ]);

  const fract = (x) => x - Math.floor(x);
  const mix = (a, b, t) => a + (b - a) * t;
  const mod = (x, y) => x - y * Math.floor(x / y);
  const smoothstep = (a, b, x) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  function hash21(x, y, seedX, seedY) {
    x = mod(x, 71);
    y = mod(y, 71);
    let a = fract(x * 0.1031 + seedX);
    let b = fract(y * 0.103 + seedY);
    let c = fract(x * 0.0973 + seedX);
    const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
    a += d;
    b += d;
    c += d;
    return fract((a + b) * c);
  }

  function valueNoise(x, y, seedX, seedY) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    let fx = fract(x);
    let fy = fract(y);
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    return mix(
      mix(hash21(ix, iy, seedX, seedY), hash21(ix + 1, iy, seedX, seedY), fx),
      mix(hash21(ix, iy + 1, seedX, seedY), hash21(ix + 1, iy + 1, seedX, seedY), fx),
      fy,
    );
  }

  function cloudFbm(x, y, seedX, seedY) {
    let sum = 0;
    let amplitude = 0.5;
    for (let i = 0; i < 5; i++) {
      sum += valueNoise(x, y, seedX, seedY) * amplitude;
      // GLSL の mat2 は列優先。sky.ts の
      // mat2(0.86, -0.51, 0.51, 0.86) * p と同じ向きにする。
      const nx = (0.86 * x + 0.51 * y) * 2.03 + 1.7;
      const ny = (-0.51 * x + 0.86 * y) * 2.03 + 1.7;
      x = nx;
      y = ny;
      amplitude *= 0.5;
    }
    return sum;
  }

  const WIDTH = 40;
  const SKY_ROWS = 14;
  const FOV_TAN = Math.tan((68 * Math.PI) / 360);
  const ASPECT = 1.5;
  const VISIBLE_ALPHA = 0.05;
  const DENSE_ALPHA = 0.1;

  function viewMetrics(seed, yaw) {
    const cloudSeed = hashSeed(seed)[0];
    const seedX = (cloudSeed & 0xffff) / 0xffff;
    const seedY = ((cloudSeed >>> 16) & 0xffff) / 0xffff;
    const mask = new Uint8Array(WIDTH * SKY_ROWS);
    let visible = 0;
    let dense = 0;

    for (let iy = 0; iy < SKY_ROWS; iy++) {
      for (let ix = 0; ix < WIDTH; ix++) {
        let x = (((ix + 0.5) / WIDTH) * 2 - 1) * ASPECT * FOV_TAN;
        let y = (1 - ((iy + 0.5) / (SKY_ROWS * 2)) * 2) * FOV_TAN;
        let z = -1;
        const length = Math.hypot(x, y, z);
        x /= length;
        y /= length;
        z /= length;

        const worldX = Math.cos(yaw) * x + Math.sin(yaw) * z;
        const worldZ = -Math.sin(yaw) * x + Math.cos(yaw) * z;
        const projectedY = Math.max(y, 0.075);
        const noise = cloudFbm(
          (worldX / projectedY) * MORNING.cloudScale,
          (worldZ / projectedY) * MORNING.cloudScale,
          seedX,
          seedY,
        );
        const alpha =
          smoothstep(MORNING.cloudLow, MORNING.cloudHigh, noise) *
          smoothstep(0.015, 0.22, y) *
          MORNING.cloudAmount;
        const index = iy * WIDTH + ix;
        if (alpha > VISIBLE_ALPHA) {
          visible++;
          mask[index] = 1;
        }
        if (alpha > DENSE_ALPHA) dense++;
      }
    }

    const seen = new Uint8Array(mask.length);
    const queue = new Int32Array(mask.length);
    let largest = 0;
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || seen[start]) continue;
      let head = 0;
      let tail = 1;
      let size = 0;
      queue[0] = start;
      seen[start] = 1;
      while (head < tail) {
        const current = queue[head++];
        const cx = current % WIDTH;
        const cy = Math.floor(current / WIDTH);
        size++;
        for (const next of [current - 1, current + 1, current - WIDTH, current + WIDTH]) {
          if (next < 0 || next >= mask.length || seen[next] || !mask[next]) continue;
          const nx = next % WIDTH;
          const ny = Math.floor(next / WIDTH);
          if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue;
          seen[next] = 1;
          queue[tail++] = next;
        }
      }
      largest = Math.max(largest, size);
    }

    return {
      visible: visible / mask.length,
      dense: dense / mask.length,
      largest: largest / mask.length,
    };
  }

  const percentile = (values, p) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * p)];
  };

  const views = [];
  for (let i = 0; i < 200; i++) {
    const seed = `s${i.toString(36).padStart(7, '0')}`;
    for (let direction = 0; direction < 8; direction++) {
      views.push(viewMetrics(seed, (direction / 8) * Math.PI * 2));
    }
  }

  const visible = views.map((view) => view.visible);
  const largest = views.map((view) => view.largest);
  const visibleMean = visible.reduce((sum, value) => sum + value, 0) / visible.length;

  assert(visibleMean < 0.25, `平均の雲占有率が高すぎます: ${(visibleMean * 100).toFixed(1)}%`);
  assert(
    percentile(visible, 0.9) < 0.48,
    `p90 の雲占有率が高すぎます: ${(percentile(visible, 0.9) * 100).toFixed(1)}%`,
  );
  assert(
    percentile(visible, 0.99) < 0.68,
    `p99 の雲占有率が高すぎます: ${(percentile(visible, 0.99) * 100).toFixed(1)}%`,
  );
  assert(
    percentile(largest, 0.99) < 0.65,
    `p99 の最大雲塊が大きすぎます: ${(percentile(largest, 0.99) * 100).toFixed(1)}%`,
  );

  // 実際に「空の大半が雲」と報告された画面。太陽を正面にした向きで固定する。
  const elevation = (MORNING.elevation * Math.PI) / 180;
  const azimuth = (MORNING.azimuth * Math.PI) / 180;
  const sunX = Math.cos(elevation) * Math.sin(azimuth);
  const sunZ = Math.cos(elevation) * Math.cos(azimuth);
  const reported = viewMetrics('635c8zxx', Math.atan2(-sunX, -sunZ));
  assert(
    reported.visible < 0.15,
    `635c8zxx の雲占有率が再び高くなりました: ${(reported.visible * 100).toFixed(1)}%`,
  );
  assert(
    reported.dense < 0.08,
    `635c8zxx の濃い雲が再び増えました: ${(reported.dense * 100).toFixed(1)}%`,
  );

  console.log(
    'PASS  雲の画面占有率',
    `平均 ${(visibleMean * 100).toFixed(1)}%`,
    `p90 ${(percentile(visible, 0.9) * 100).toFixed(1)}%`,
    `p99 ${(percentile(visible, 0.99) * 100).toFixed(1)}%`,
    `最大雲塊p99 ${(percentile(largest, 0.99) * 100).toFixed(1)}%`,
    `635c8zxx ${(reported.visible * 100).toFixed(1)}%`,
  );
} finally {
  await server.close();
}
