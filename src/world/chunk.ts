import { hash2 } from '../core/rng';
import type { SpecialHit } from './special';
import { splitsAlongMainDiagonal, type Terrain } from './terrain';

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

// 曲率による明暗（擬似 AO）。凹みを暗く、盛り上がりを明るくして、
// 影を落とさずに地形の形を読ませる。
//
// **上限で頭打ちにしないこと。** 曲率は 2 階差分なので分布の裾が極端に長い。
// 実測（step=2）で中央 0.008 に対し 99% は 0.30 と 38 倍ある。clamp で切ると
// 1 割以上の面が一律 -34% に張り付き、縁の硬い黒い斑が斜面に散る。
// x/(1+x) で柔らかく飽和させると、裾は伸びるが張り付かない。
//
// GAIN は地形の性質が変わるたびに合わせ直すこと。地形をスプラインで作り直した
// とき、旧地形に合わせた 12 のままにして斜面が斑になった（一度これで壊した）。
const CURVATURE_GAIN = 6;
/** 凹み側。本物の AO も凹みの方が強く効くので、明るくする側より大きく取る。 */
const CURVATURE_DARK = 0.34;
/** 盛り上がり側。 */
const CURVATURE_LIGHT = 0.2;

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
  // 外周に 1 リング余分に取っているのは曲率が隣の四角形を要るため。これが無いと
  // チャンクの継ぎ目にだけ明暗の線が出る。格子点は (n+1)^2 → (n+3)^2（step=2 で +4%）。
  const W = n + 3;
  const hs = new Float32Array(W * W);
  for (let j = -1; j <= n + 1; j++) {
    for (let i = -1; i <= n + 1; i++) {
      hs[(j + 1) * W + (i + 1)] = terrain.heightAt(ox + i * step, oz + j * step);
    }
  }
  // i, j は -1 から n+1 まで引ける。
  const H = (i: number, j: number) => hs[(j + 1) * W + (i + 1)];

  /** 四角形 1 枚の平均の高さ。曲率をこの単位で測る。 */
  const Q = (i: number, j: number) =>
    (H(i, j) + H(i + 1, j) + H(i, j + 1) + H(i + 1, j + 1)) * 0.25;

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
      const special = terrain.specialAt(cx, cz);

      // 曲率: 周りの四角形より低ければ凹み（負）、高ければ盛り上がり（正）。
      // step で割ると LOD が変わっても同じ強さの明暗になる。
      // 気候と同じく四角形あたり 1 度でよい（形の単位は四角形なので）。
      const curv =
        (Q(i, j) - (Q(i - 1, j) + Q(i + 1, j) + Q(i, j - 1) + Q(i, j + 1)) * 0.25) / step;

      // 傾きは四角形あたり 1 度だけ。気候と同じ扱い。
      // 三角形ごとに測ると、同じ四角形の 2 枚で値が食い違う（実測で step=48 の
      // 90% が 0.15 ちがう）。岩色の切り替えは 0.42〜0.72 の幅 0.3 しかないので、
      // 隣り合う三角形で岩と草が交互になり、斜面に細かい斜めの縞が出ていた。
      const lo = Math.min(h00, h10, h01, h11);
      const hi = Math.max(h00, h10, h01, h11);
      const slope = Math.min(1, (hi - lo) / (step * 1.4142));

      // 割り方の判定は terrain.ts に 1 つだけ置いてある。heightOnGrid も同じものを
      // 使うので、足元と見た目が必ず一致する。ここでベタ書きに戻さないこと。
      if (splitsAlongMainDiagonal(h00, h10, h01, h11)) {
        shadeTri(terrain, h00, h01, h11, slope, temp, moisture, special, curv, i, j, 0, faceColor);
        tri(x0, h00, z0, x0, h01, z1, x1, h11, z1, faceColor[0], faceColor[1], faceColor[2]);

        shadeTri(terrain, h00, h11, h10, slope, temp, moisture, special, curv, i, j, 1, faceColor);
        tri(x0, h00, z0, x1, h11, z1, x1, h10, z0, faceColor[0], faceColor[1], faceColor[2]);
      } else {
        shadeTri(terrain, h00, h01, h10, slope, temp, moisture, special, curv, i, j, 0, faceColor);
        tri(x0, h00, z0, x0, h01, z1, x1, h10, z0, faceColor[0], faceColor[1], faceColor[2]);

        shadeTri(terrain, h01, h11, h10, slope, temp, moisture, special, curv, i, j, 1, faceColor);
        tri(x0, h01, z1, x1, h11, z1, x1, h10, z0, faceColor[0], faceColor[1], faceColor[2]);
      }
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

/** 三角形 1 枚の色を、その 3 頂点の高さと傾き、そして四角形の曲率から決める。 */
function shadeTri(
  terrain: Terrain,
  ha: number,
  hb: number,
  hc: number,
  slope: number,
  temp: number,
  moisture: number,
  special: SpecialHit,
  curv: number,
  i: number,
  j: number,
  which: number,
  out: Float32Array,
): void {
  const h = (ha + hb + hc) / 3;
  terrain.shade(h, slope, temp, moisture, special, out, 0);

  // 曲率による明暗。凹みを暗くすることで、影を落とさずに形を読ませる。
  // 面ごとのランダムな明暗だけでは、平らな面の上では「模様」に見えて形に見えない。
  // x/(1+|x|) で柔らかく飽和させる（clamp で切ると黒い斑になる。CURVATURE_GAIN 参照）。
  const g = curv * CURVATURE_GAIN;
  const k = g / (1 + Math.abs(g));
  const shape = 1 + k * (k < 0 ? CURVATURE_DARK : CURVATURE_LIGHT);

  // わずかな揺らぎ。曲率がほぼ 0 の平地が均一になりすぎるのを防ぐ。
  // 曲率と競合しないよう、以前の ±6% から ±3% に落としてある。
  const jitter = 0.97 + hash2(i, j * 2 + which, 7717) * 0.06;

  const t = shape * jitter;
  out[0] *= t;
  out[1] *= t;
  out[2] *= t;
}
