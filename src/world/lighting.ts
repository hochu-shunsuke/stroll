/**
 * 光を焼き込む。太陽の影（山が落とす影）と、空の見え方（谷や峡谷ほど空が狭く暗い）。
 * hakoniwa（有限の島）と同じ計算を、カメラの周りの地図（render/regionField.ts）にかける。
 *
 * 太陽は動かないので、地図を作るたびに 1 度だけ計算し、描くときはテクスチャを 1 回
 * 引くだけにする（render/islandLight.ts）。影をその場で計算するシャドウマップ
 * （毎フレームもう 1 度描く）より軽く、長い影も落ちる。地図の外の山の影は入らない。
 *
 * どちらも高さの格子の上で、その点から水平に進んで「地平線の高さ」を測る（horizon mapping）。
 *   - 太陽: 太陽の方位へ進み、地平線が太陽より高ければ影。境目は角度でぼかす（遠い山の影ほど縁が柔らかい）
 *   - 空: 8 方位の地平線の高さから、空が見える割合を出す
 * 進む幅は遠くほど広げ、光が島で一番高い所を越えたら打ち切る。
 *
 * 表示専用（決定性の決まりの外）。
 */

/** 太陽の影の縁のぼかし（地平線の傾きの差）。約 2°。 */
const SUN_SOFT = 0.035;
/** 太陽の影を測る間隔（格子の点いくつごと）。間は補間する。朝日は低く、影は長いので 2 点ごとで足りる。 */
const SUN_EVERY = 2;
/** 空を測る方位の数と、測る距離（m）、間隔。空の見え方は影よりゆっくり変わる。 */
const SKY_DIRECTIONS = 8;
const SKY_REACH = 700;
const SKY_EVERY = 3;
/** これより低い地平線は空をほとんど欠かない（仰角 6° で 1 方位の 1 割）。見つけたら打ち切る目安。 */
const SKY_NEGLIGIBLE = 0.1;

export interface BakedLighting {
  /** 1 辺の点数（高さの格子と同じ）。 */
  n: number;
  /** 2 つずつ並べた 0..255。[太陽が当たる割合, 空が見える割合]。 */
  data: Uint8Array;
}

/**
 * sun は太陽へ向かう単位ベクトル（render/sky.ts の sunDirection）。
 * height は n×n の格子、cell は格子の間隔（m）。水面より下は水面の高さとして扱う（影は水面に落ちる）。
 */
export function bakeLighting(
  height: Float32Array,
  n: number,
  cell: number,
  sun: readonly [number, number, number],
): BakedLighting {
  const h = new Float32Array(n * n);
  let top = 0;
  for (let k = 0; k < h.length; k++) {
    h[k] = Math.max(0, height[k]);
    if (h[k] > top) top = h[k];
  }
  /** 格子の位置（点の番号単位、小数可）で高さを引く。格子の外は海面。 */
  const at = (u: number, v: number): number => {
    if (u < 0 || v < 0 || u > n - 1 || v > n - 1) return 0;
    const i = Math.min(n - 2, u | 0);
    const j = Math.min(n - 2, v | 0);
    const fu = u - i;
    const fv = v - j;
    const k = j * n + i;
    return (h[k] + (h[k + 1] - h[k]) * fu) * (1 - fv) + (h[k + n] + (h[k + n + 1] - h[k + n]) * fu) * fv;
  };
  /**
   * (i, j) から方向 (dx, dz) へ進み、見上げる地平線の傾きの最大を返す。
   * 傾きが stopAbove を越えうる地形がこの先に無くなったら打ち切る（島で一番高い所が基準）。
   */
  const horizon = (i: number, j: number, dx: number, dz: number, reach: number, stopAbove: number): number => {
    const h0 = h[j * n + i];
    let best = -Infinity;
    let t = 1;
    const far = reach / cell;
    while (t <= far) {
      const s = (at(i + dx * t, j + dz * t) - h0) / (t * cell);
      if (s > best) best = s;
      if (h0 + Math.max(best, stopAbove) * t * cell > top) break;
      t += Math.max(1, t * 0.08);
    }
    return best;
  };

  const flat = Math.hypot(sun[0], sun[2]) || 1;
  const sdx = sun[0] / flat;
  const sdz = sun[2] / flat;
  const sunSlope = sun[1] / flat;
  const sunLit = coarse(n, SUN_EVERY, (i, j) => {
    const s = horizon(i, j, sdx, sdz, Infinity, sunSlope - SUN_SOFT);
    return smooth(-SUN_SOFT, SUN_SOFT, sunSlope - s);
  });

  const dirs: [number, number][] = [];
  for (let d = 0; d < SKY_DIRECTIONS; d++) {
    const a = (d / SKY_DIRECTIONS) * Math.PI * 2 + 0.2;
    dirs.push([Math.cos(a), Math.sin(a)]);
  }
  const skyOpen = coarse(n, SKY_EVERY, (i, j) => {
    let open = 0;
    for (const [dx, dz] of dirs) {
      const s = Math.max(0, horizon(i, j, dx, dz, SKY_REACH, SKY_NEGLIGIBLE));
      // 地平線の仰角の sin だけ空が欠ける。
      open += 1 - s / Math.sqrt(1 + s * s);
    }
    return open / SKY_DIRECTIONS;
  });

  const data = new Uint8Array(n * n * 2);
  for (let k = 0; k < n * n; k++) {
    data[k * 2] = Math.round(sunLit[k] * 255);
    data[k * 2 + 1] = Math.round(skyOpen[k] * 255);
  }
  return { n, data };
}

/** every 点ごとに f を測り、間を双一次で補間して n×n に広げる。 */
function coarse(n: number, every: number, f: (i: number, j: number) => number): Float32Array {
  const m = Math.ceil((n - 1) / every) + 1;
  const c = new Float32Array(m * m);
  for (let cj = 0; cj < m; cj++) {
    for (let ci = 0; ci < m; ci++) {
      c[cj * m + ci] = f(Math.min(n - 1, ci * every), Math.min(n - 1, cj * every));
    }
  }
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const v = Math.min(m - 1.0001, j / every);
    const cj = v | 0;
    const fv = v - cj;
    for (let i = 0; i < n; i++) {
      const u = Math.min(m - 1.0001, i / every);
      const ci = u | 0;
      const fu = u - ci;
      const k = cj * m + ci;
      out[j * n + i] = (c[k] + (c[k + 1] - c[k]) * fu) * (1 - fv) + (c[k + m] + (c[k + m + 1] - c[k + m]) * fu) * fv;
    }
  }
  return out;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
