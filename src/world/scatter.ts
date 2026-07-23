import { hash2 } from '../core/rng';
import { clamp, smoothstep } from './noise';
import { CHUNK_SIZE } from './chunk';
import type { Terrain } from './terrain';

export const KIND_BROADLEAF = 0;
export const KIND_PINE = 1;
export const KIND_ROCK = 2;
export const KIND_BUSH = 3;

export interface ScatterBatch {
  kind: number;
  /** 4x4 行列を並べた列（16 要素 × インスタンス数）。 */
  matrices: Float32Array;
  /** インスタンスごとの色ムラ（3 要素 × インスタンス数）。 */
  colors: Float32Array;
}

interface KindSpec {
  kind: number;
  /** 配置候補の格子間隔。 */
  spacing: number;
  salt: number;
  /** この LOD 以下のチャンクにだけ生やす。 */
  maxLod: number;
  /** 置くならスケールを、置かないなら 0 を返す。 */
  place(h: number, slope: number, temp: number, moisture: number, r: number): number;
}

const SPECS: KindSpec[] = [
  {
    // 広葉樹: 温帯〜暖帯の湿った所。寒い地方と砂漠には生えない。
    kind: KIND_BROADLEAF,
    spacing: 7,
    salt: 1301,
    maxLod: 1,
    place: (h, slope, temp, moisture, r) => {
      if (h < 3.2 || h > 52 || slope > 0.42) return 0;
      const climate = smoothstep(0.34, 0.68, moisture) * band(temp, 0.4, 0.62, 0.9);
      const density = climate * (1 - smoothstep(34, 52, h)) * 0.9;
      if (r > density) return 0;
      return 0.75 + ((r * 977) % 1) * 0.6;
    },
  },
  {
    // 針葉樹: 涼しい所。寒帯や山の中腹を担う。
    kind: KIND_PINE,
    spacing: 8,
    salt: 4409,
    maxLod: 1,
    place: (h, slope, temp, moisture, r) => {
      if (h < 6 || h > 96 || slope > 0.5) return 0;
      const climate = smoothstep(0.22, 0.55, moisture) * band(temp, 0.12, 0.34, 0.6);
      const density = climate * 0.85;
      if (r > density) return 0;
      return 0.8 + ((r * 613) % 1) * 0.7;
    },
  },
  {
    // 岩: 気候によらず、急斜面と高所に転がる。
    kind: KIND_ROCK,
    spacing: 17,
    salt: 7717,
    maxLod: 1,
    place: (h, slope, _temp, _moisture, r) => {
      if (h < 1.0) return 0;
      const density = (0.12 + smoothstep(0.3, 0.7, slope) * 0.5 + smoothstep(50, 90, h) * 0.3) * 0.6;
      if (r > density) return 0;
      return 0.6 + ((r * 331) % 1) * 2.4;
    },
  },
  {
    // 低木: 暖かく湿った所の下草。砂漠と寒帯には出さない。
    kind: KIND_BUSH,
    spacing: 5,
    salt: 2237,
    maxLod: 0,
    place: (h, slope, temp, moisture, r) => {
      if (h < 2.4 || h > 60 || slope > 0.55) return 0;
      const climate = smoothstep(0.28, 0.6, moisture) * band(temp, 0.35, 0.6, 0.92);
      const density = climate * 0.55;
      if (r > density) return 0;
      return 0.7 + ((r * 149) % 1) * 0.9;
    },
  },
];

/**
 * 値が [lo, hi] の帯に入っているほど 1 に近づく（山なりの窓）。
 * 気温の得意な範囲を植生ごとに切り出すのに使う。
 */
function band(v: number, lo: number, mid: number, hi: number): number {
  return v < mid ? smoothstep(lo, mid, v) : smoothstep(hi, mid, v);
}

/** 3 点差分で地面の傾き（0=平ら, 1=垂直に近い）を測る。 */
function slopeAt(t: Terrain, x: number, z: number, h: number): number {
  const d = 2.5;
  const dx = (t.heightAt(x + d, z) - h) / d;
  const dz = (t.heightAt(x, z + d) - h) / d;
  return clamp(Math.hypot(dx, dz) / 1.6, 0, 1);
}

/**
 * Y 軸回転 → X 軸の微傾き → スケール、を合成した 4x4 行列を列優先で書き出す。
 * （Worker 側に three を持ち込まないため手計算する）
 */
function composeInto(
  out: Float32Array,
  o: number,
  px: number, py: number, pz: number,
  yaw: number, tilt: number,
  sx: number, sy: number, sz: number,
): void {
  const cb = Math.cos(yaw), sb = Math.sin(yaw);
  const ca = Math.cos(tilt), sa = Math.sin(tilt);
  out[o + 0] = cb * sx;        out[o + 1] = 0 * sx;   out[o + 2] = -sb * sx;      out[o + 3] = 0;
  out[o + 4] = sb * sa * sy;   out[o + 5] = ca * sy;  out[o + 6] = cb * sa * sy;  out[o + 7] = 0;
  out[o + 8] = sb * ca * sz;   out[o + 9] = -sa * sz; out[o + 10] = cb * ca * sz; out[o + 11] = 0;
  out[o + 12] = px;            out[o + 13] = py;      out[o + 14] = pz;           out[o + 15] = 1;
}

/**
 * チャンク内の木・岩の配置を計算する。
 * 位置はワールド座標のハッシュだけで決まるので、チャンク境界で不自然に途切れず、
 * 読み込み直しても同じ場所に生える。
 * 座標はチャンク原点からの相対値。
 */
export function buildScatterData(
  terrain: Terrain,
  cx: number,
  cz: number,
  lod: number,
): ScatterBatch[] {
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  const batches: ScatterBatch[] = [];

  for (const spec of SPECS) {
    if (lod > spec.maxLod) continue;

    const g0 = Math.floor(ox / spec.spacing);
    const g1 = Math.floor((ox + CHUNK_SIZE - 0.001) / spec.spacing);
    const k0 = Math.floor(oz / spec.spacing);
    const k1 = Math.floor((oz + CHUNK_SIZE - 0.001) / spec.spacing);

    // 上限いっぱいで確保し、最後に実数へ切り詰める。
    const cap = (g1 - g0 + 1) * (k1 - k0 + 1);
    const matrices = new Float32Array(cap * 16);
    const colors = new Float32Array(cap * 3);
    let count = 0;

    for (let gx = g0; gx <= g1; gx++) {
      for (let gz = k0; gz <= k1; gz++) {
        const r = hash2(gx, gz, spec.salt);
        const x = (gx + hash2(gx, gz, spec.salt + 1)) * spec.spacing;
        const z = (gz + hash2(gx, gz, spec.salt + 2)) * spec.spacing;
        if (x < ox || x >= ox + CHUNK_SIZE || z < oz || z >= oz + CHUNK_SIZE) continue;

        const h = terrain.heightAt(x, z);
        // 水面下と、明らかに条件外の場所は重い判定に入る前に落とす。
        if (h < 0.8) continue;
        const moisture = terrain.moistureAt(x, z);
        const temp = terrain.temperatureAt(x, z, h);
        const slope = slopeAt(terrain, x, z, h);
        const scale = spec.place(h, slope, temp, moisture, r);
        if (scale <= 0) continue;

        const yaw = hash2(gx, gz, spec.salt + 3) * Math.PI * 2;
        // わずかに傾いている方が並木らしくならず自然に見える。
        const tilt = (hash2(gx, gz, spec.salt + 4) - 0.5) * 0.14;
        const sy = scale * (0.85 + hash2(gx, gz, spec.salt + 5) * 0.4);
        composeInto(matrices, count * 16, x - ox, h - 0.25, z - oz, yaw, tilt, scale, sy, scale);

        const t = 0.86 + hash2(gx, gz, spec.salt + 6) * 0.3;
        colors[count * 3] = t;
        colors[count * 3 + 1] = t * (0.94 + hash2(gx, gz, spec.salt + 7) * 0.12);
        colors[count * 3 + 2] = t * 0.93;
        count++;
      }
    }

    if (count === 0) continue;
    batches.push({
      kind: spec.kind,
      matrices: matrices.slice(0, count * 16),
      colors: colors.slice(0, count * 3),
    });
  }

  return batches;
}
