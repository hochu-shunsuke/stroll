import { hash2 } from '../core/rng';
import type { Terrain } from './terrain';

/** 1 チャンクの一辺（ワールド単位 ≒ メートル）。 */
export const CHUNK_SIZE = 192;

/** 遠くのチャンクほど粗く作る。値は頂点間隔で、CHUNK_SIZE を割り切ること。 */
export const LOD_STEPS = [2, 4, 8, 16, 48];

/** 各 LOD が担当する距離（チャンク数、チェビシェフ距離）。 */
export const LOD_RINGS = [1, 2, 4, 7, 10];

// 片方だけ増減させると、存在しない粗さを引いて地形が壊れる。
if (LOD_STEPS.length !== LOD_RINGS.length) {
  throw new Error('LOD_STEPS と LOD_RINGS は同じ長さにしてください');
}

/** 継ぎ目の隙間を隠すためにチャンク外周から下ろすスカートの深さ。 */
const SKIRT_DEPTH = 30;

export interface ChunkArrays {
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
}

/**
 * チャンクの地形メッシュを、面ごとの法線と色を持つ生の配列として作る。
 * フラットシェーディングのローポリ質感を出すため、頂点は共有しない。
 * 座標はチャンク原点からの相対値（遠方での精度を保つため）。
 */
export function buildChunkArrays(
  terrain: Terrain,
  cx: number,
  cz: number,
  step: number,
): ChunkArrays {
  const n = CHUNK_SIZE / step;
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;

  // 高さは格子点ごとに一度だけ計算する（ノイズ評価がこの処理の大半を占めるため）。
  const hs = new Float32Array((n + 1) * (n + 1));
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      hs[j * (n + 1) + i] = terrain.heightAt(ox + i * step, oz + j * step);
    }
  }
  const H = (i: number, j: number) => hs[j * (n + 1) + i];

  const triCount = n * n * 2 + n * 8;
  const position = new Float32Array(triCount * 9);
  const normal = new Float32Array(triCount * 9);
  const color = new Float32Array(triCount * 9);
  const faceColor = new Float32Array(3);
  let p = 0;

  /** 三角形 1 枚を、面法線と単一の面色で書き込む。 */
  const tri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx2: number, cy2: number, cz2: number,
    r: number, g: number, b: number,
  ) => {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx2 - ax, e2y = cy2 - ay, e2z = cz2 - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;

    position[p] = ax; position[p + 1] = ay; position[p + 2] = az;
    position[p + 3] = bx; position[p + 4] = by; position[p + 5] = bz;
    position[p + 6] = cx2; position[p + 7] = cy2; position[p + 8] = cz2;
    for (let k = 0; k < 9; k += 3) {
      normal[p + k] = nx; normal[p + k + 1] = ny; normal[p + k + 2] = nz;
      color[p + k] = r; color[p + k + 1] = g; color[p + k + 2] = b;
    }
    p += 9;
  };

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = i * step, z0 = j * step;
      const x1 = x0 + step, z1 = z0 + step;
      const h00 = H(i, j), h10 = H(i + 1, j), h01 = H(i, j + 1), h11 = H(i + 1, j + 1);
      // 気候は四角形の中心で 1 度だけ引く。面ごとに引くほどの精度は要らない。
      const cx = ox + x0 + step * 0.5;
      const cz = oz + z0 + step * 0.5;
      const moisture = terrain.moistureAt(cx, cz);
      const temp = terrain.temperatureAt(cx, cz, (h00 + h11) * 0.5);

      // heightOnGrid の三角形分割と必ず同じ切り方にすること（足元が浮かないため）。
      shadeTri(terrain, h00, h01, h11, step, temp, moisture, i, j, 0, faceColor);
      tri(x0, h00, z0, x0, h01, z1, x1, h11, z1, faceColor[0], faceColor[1], faceColor[2]);

      shadeTri(terrain, h00, h11, h10, step, temp, moisture, i, j, 1, faceColor);
      tri(x0, h00, z0, x1, h11, z1, x1, h10, z0, faceColor[0], faceColor[1], faceColor[2]);
    }
  }

  // スカート: 外周を真下に下ろし、LOD 差でできる隙間から空が覗くのを防ぐ。
  const sr = 0.05, sg = 0.045, sb = 0.042;
  const S = CHUNK_SIZE;
  const D = SKIRT_DEPTH;
  for (let i = 0; i < n; i++) {
    const xa = i * step, xb = (i + 1) * step;
    let a = H(i, 0), b = H(i + 1, 0);
    tri(xa, a, 0, xb, b, 0, xa, a - D, 0, sr, sg, sb);
    tri(xb, b, 0, xb, b - D, 0, xa, a - D, 0, sr, sg, sb);

    a = H(i, n); b = H(i + 1, n);
    tri(xb, b, S, xa, a, S, xa, a - D, S, sr, sg, sb);
    tri(xb, b, S, xa, a - D, S, xb, b - D, S, sr, sg, sb);
  }
  for (let j = 0; j < n; j++) {
    const za = j * step, zb = (j + 1) * step;
    let a = H(0, j), b = H(0, j + 1);
    tri(0, b, zb, 0, a, za, 0, a - D, za, sr, sg, sb);
    tri(0, b, zb, 0, a - D, za, 0, b - D, zb, sr, sg, sb);

    a = H(n, j); b = H(n, j + 1);
    tri(S, a, za, S, b, zb, S, a - D, za, sr, sg, sb);
    tri(S, b, zb, S, b - D, zb, S, a - D, za, sr, sg, sb);
  }

  return { position, normal, color };
}

/** 三角形 1 枚の色を、その 3 頂点の高さと傾きから決める。 */
function shadeTri(
  terrain: Terrain,
  ha: number,
  hb: number,
  hc: number,
  step: number,
  temp: number,
  moisture: number,
  i: number,
  j: number,
  which: number,
  out: Float32Array,
): void {
  const h = (ha + hb + hc) / 3;
  // 三角形内の高低差を水平方向の広がりで割ると、傾きの目安になる。
  const spread = Math.max(Math.abs(ha - hb), Math.abs(hb - hc), Math.abs(ha - hc));
  const slope = Math.min(1, spread / (step * 1.4142));
  terrain.shade(h, slope, temp, moisture, out, 0);

  // 面ごとにわずかな明暗を与え、ローポリの一枚一枚が見えるようにする。
  const t = 0.94 + hash2(i, j * 2 + which, 7717) * 0.12;
  out[0] *= t;
  out[1] *= t;
  out[2] *= t;
}
