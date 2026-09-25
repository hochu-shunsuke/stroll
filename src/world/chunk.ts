import { hash2 } from '../core/rng';
import { CLIMATE_STEP } from './climate';
import { SURFACE_STRIDE } from './surfaceShade';
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

// 割り切れないと格子が隣のチャンクとずれ、継ぎ目に湿り気の段差＝色の帯が出る。
if (CHUNK_SIZE % CLIMATE_STEP !== 0) {
  throw new Error('CLIMATE_STEP は CHUNK_SIZE を割り切ってください');
}

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
  /**
   * 地面の層（world/surfaceShade.ts）。color = 土台の色、rock = 岩の色、
   * surf = [岩の量, 雪の量, 面の明暗 ÷ 2]。量は頂点ごとの値で面の中をなめらかにつなぎ、
   * 境目は画素ごとに切る（render/terrainMaterial.ts）。面の明暗だけは面ごとの値。
   *
   * rock と surf は 0..255 に詰める（材質側で 0..1 に戻す）。浮動小数のままだと、
   * 描画中の全チャンクで GPU のメモリが約 25MB 増える（詰めると約 6MB）。
   * 土台の色は暗い色の段差が目立つので浮動小数のまま。
   */
  color: Float32Array;
  rock: Uint8Array;
  surf: Uint8Array;
  /**
   * 内陸の水面の三角形（座標だけ）。無ければ長さ 0。
   *
   * 外洋はカメラ追従の 1 枚板が描くので、ここに出すのは**海抜より上の水**だけ。
   * 水面の高さは terrain.waterLevelAt() が返す（湖は区画ごとに 1 つの定数なので
   * 必ず水平になる）。材質は render/water.ts のものを使い回す ── あちらは
   * 頂点の世界座標だけで波と映り込みを作るので、板でも湖でも同じに動く。
   */
  water: Float32Array;
}

/**
 * チャンクの地形メッシュを、面ごとの法線を持つ生の配列として作る。
 * フラットシェーディングのローポリ質感を出すため、頂点は共有しない。
 * 座標はチャンク原点からの相対値（遠方での精度を保つため）。
 *
 * **色は面ごとに決めない。** 雪と岩の量は格子の点ごとに求め、面の中はなめらかにつなぎ、
 * 境目は画素ごとに切る。四角形ごとに 1 色に決めていた頃は、雪と岩の境が格子に揃って
 * 階段と市松模様になった（遠くの粗いチャンクほど四角が大きい。利用者の指摘）。
 * ローポリの味は、面の法線（陰影）と面ごとのわずかな明暗の揺らぎで残す。
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

  // 湿り気は粗い格子で引いて補間する（CLIMATE_STEP 参照）。
  const cg = CHUNK_SIZE / CLIMATE_STEP;
  const cw = cg + 1;
  const mgrid = new Float32Array(cw * cw);
  for (let j = 0; j < cw; j++) {
    for (let i = 0; i < cw; i++) {
      mgrid[j * cw + i] = terrain.moistureAt(ox + i * CLIMATE_STEP, oz + j * CLIMATE_STEP);
    }
  }
  /** チャンク内の相対座標で湿り気を引く。 */
  const moistureLocal = (lx: number, lz: number) => {
    const u = lx / CLIMATE_STEP;
    const v = lz / CLIMATE_STEP;
    const i = Math.min(cg - 1, u | 0);
    const j = Math.min(cg - 1, v | 0);
    const fu = u - i;
    const fv = v - j;
    const a = mgrid[j * cw + i];
    const b = mgrid[j * cw + i + 1];
    const c = mgrid[(j + 1) * cw + i];
    const d = mgrid[(j + 1) * cw + i + 1];
    return (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
  };

  // 地面の層は格子の点ごとに 1 度だけ求める（四角形の 2 枚の三角形と、隣の四角形で共有する）。
  // 傾きは中心差分。四角形の「高低差 ÷ 対角」と尺度を揃えるため 0.85 を掛ける
  // （あちらは勾配の向きによって 0.71〜1.0 倍になる）。岩の閾値 0.42〜0.72 はそのまま使える。
  const w = n + 1;
  const layers = new Float32Array(w * w * SURFACE_STRIDE);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = ox + i * step;
      const z = oz + j * step;
      const h = H(i, j);
      const dx = (H(i + 1, j) - H(i - 1, j)) / (2 * step);
      const dz = (H(i, j + 1) - H(i, j - 1)) / (2 * step);
      const slope = Math.min(1, Math.sqrt(dx * dx + dz * dz) * 0.85);
      terrain.surface(
        h,
        slope,
        terrain.temperatureAt(x, z, h),
        moistureLocal(i * step, j * step),
        terrain.specialAt(x, z),
        layers,
        (j * w + i) * SURFACE_STRIDE,
      );
    }
  }

  const triCount = n * n * 2 + n * 8;
  const position = new Float32Array(triCount * 9);
  const normal = new Float32Array(triCount * 9);
  const color = new Float32Array(triCount * 9);
  const rock = new Uint8Array(triCount * 9);
  const surf = new Uint8Array(triCount * 9);
  const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  let p = 0;

  let nx = 0, ny = 0, nz = 0;
  /** 3 点から面の法線を求めて nx, ny, nz に置く。 */
  const faceNormal = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx2: number, cy2: number, cz2: number,
  ) => {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx2 - ax, e2y = cy2 - ay, e2z = cz2 - az;
    nx = e1y * e2z - e1z * e2y;
    ny = e1z * e2x - e1x * e2z;
    nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
  };

  /** 格子の点 (i, j) を頂点として書く。層はその点のもの、法線と面の明暗は面のもの。 */
  const vertex = (i: number, j: number, face: number) => {
    const o = (j * w + i) * SURFACE_STRIDE;
    position[p] = i * step; position[p + 1] = H(i, j); position[p + 2] = j * step;
    normal[p] = nx; normal[p + 1] = ny; normal[p + 2] = nz;
    color[p] = layers[o]; color[p + 1] = layers[o + 1]; color[p + 2] = layers[o + 2];
    rock[p] = byte(layers[o + 3]); rock[p + 1] = byte(layers[o + 4]); rock[p + 2] = byte(layers[o + 5]);
    surf[p] = byte(layers[o + 6]); surf[p + 1] = byte(layers[o + 7]); surf[p + 2] = byte(face * 0.5);
    p += 3;
  };

  /** 三角形 1 枚。a, b, c は格子の点 (i, j)。 */
  const tri = (
    ai: number, aj: number,
    bi: number, bj: number,
    ci: number, cj: number,
    face: number,
  ) => {
    faceNormal(
      ai * step, H(ai, aj), aj * step,
      bi * step, H(bi, bj), bj * step,
      ci * step, H(ci, cj), cj * step,
    );
    vertex(ai, aj, face);
    vertex(bi, bj, face);
    vertex(ci, cj, face);
  };

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const h00 = H(i, j), h10 = H(i + 1, j), h01 = H(i, j + 1), h11 = H(i + 1, j + 1);

      // 曲率: 周りの四角形より低ければ凹み（負）、高ければ盛り上がり（正）。
      // step で割ると LOD が変わっても同じ強さの明暗になる。
      // 四角形あたり 1 度でよい（形の単位は四角形なので）。
      const curv =
        (Q(i, j) - (Q(i - 1, j) + Q(i + 1, j) + Q(i, j - 1) + Q(i, j + 1)) * 0.25) / step;
      const shape = faceShape(curv);

      // 割り方の判定は terrain.ts に 1 つだけ置いてある。heightOnGrid も同じものを
      // 使うので、足元と見た目が必ず一致する。ここでベタ書きに戻さないこと。
      if (splitsAlongMainDiagonal(h00, h10, h01, h11)) {
        tri(i, j, i, j + 1, i + 1, j + 1, shape * jitter(i, j, 0));
        tri(i, j, i + 1, j + 1, i + 1, j, shape * jitter(i, j, 1));
      } else {
        tri(i, j, i, j + 1, i + 1, j, shape * jitter(i, j, 0));
        tri(i, j + 1, i + 1, j + 1, i + 1, j, shape * jitter(i, j, 1));
      }
    }
  }

  // スカート: 外周を真下に下ろし、LOD 差でできる隙間から空が覗くのを防ぐ。
  // 下端は格子の外なので、層を直接書く（暗い土の色。隙間から見えても目立たない）。
  const S = CHUNK_SIZE;
  const D = SKIRT_DEPTH;
  /** 格子の外の点（スカートの下端など）を、暗い土の色で書く。 */
  const skirtVertex = (x: number, y: number, z: number) => {
    position[p] = x; position[p + 1] = y; position[p + 2] = z;
    normal[p] = nx; normal[p + 1] = ny; normal[p + 2] = nz;
    color[p] = SKIRT_COLOR[0]; color[p + 1] = SKIRT_COLOR[1]; color[p + 2] = SKIRT_COLOR[2];
    rock[p] = byte(SKIRT_COLOR[0]); rock[p + 1] = byte(SKIRT_COLOR[1]); rock[p + 2] = byte(SKIRT_COLOR[2]);
    surf[p] = 0; surf[p + 1] = 0; surf[p + 2] = byte(0.5);
    p += 3;
  };
  const skirt = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx2: number, cy2: number, cz2: number,
  ) => {
    faceNormal(ax, ay, az, bx, by, bz, cx2, cy2, cz2);
    skirtVertex(ax, ay, az);
    skirtVertex(bx, by, bz);
    skirtVertex(cx2, cy2, cz2);
  };
  for (let i = 0; i < n; i++) {
    const xa = i * step, xb = (i + 1) * step;
    let a = H(i, 0), b = H(i + 1, 0);
    skirt(xa, a, 0, xb, b, 0, xa, a - D, 0);
    skirt(xb, b, 0, xb, b - D, 0, xa, a - D, 0);

    a = H(i, n); b = H(i + 1, n);
    skirt(xb, b, S, xa, a, S, xa, a - D, S);
    skirt(xb, b, S, xa, a - D, S, xb, b - D, S);
  }
  for (let j = 0; j < n; j++) {
    const za = j * step, zb = (j + 1) * step;
    let a = H(0, j), b = H(0, j + 1);
    skirt(0, b, zb, 0, a, za, 0, a - D, za);
    skirt(0, b, zb, 0, a - D, za, 0, b - D, zb);

    a = H(n, j); b = H(n, j + 1);
    skirt(S, a, za, S, b, zb, S, a - D, za);
    skirt(S, b, zb, S, b - D, zb, S, a - D, za);
  }

  return { position, normal, color, rock, surf, water: buildWater(terrain, ox, oz, step, n, H) };
}

/**
 * 内陸の水面を三角形にする。地面より上に水がある四角形だけを出す。
 *
 * 地形と同じ格子を使う。水際で地形メッシュと食い違うと隙間が見えるため。
 * 水面は水平なので法線も色も要らない（材質が世界座標から作る）。
 */
function buildWater(
  terrain: Terrain,
  ox: number,
  oz: number,
  step: number,
  n: number,
  H: (i: number, j: number) => number,
): Float32Array {
  // **まず粗い格子で湖があるか調べる。** waterLevelAt は湖の判定に地形を 1 度
  // 引くので重く、格子点ごとに呼ぶと湖のあるチャンクだけ生成が 2 倍になる
  // （25.7ms → 51.3ms。一度これで壊した）。
  // 湖は差し渡し 290m 以上なので、48m 間隔で調べれば必ず引っかかる。
  const PROBE = Math.max(step, 48);
  const pn = Math.ceil(CHUNK_SIZE / PROBE);
  let hasLake = false;
  for (let j = 0; j <= pn && !hasLake; j++) {
    for (let i = 0; i <= pn; i++) {
      const px = Math.min(i * PROBE, CHUNK_SIZE);
      const pz = Math.min(j * PROBE, CHUNK_SIZE);
      if (terrain.waterLevelAt(ox + px, oz + pz) > -Infinity) {
        hasLake = true;
        break;
      }
    }
  }
  if (!hasLake) return new Float32Array(0);

  // 湖があると分かったチャンクだけ、格子点ごとに水面を引く。
  const w = n + 1;
  const ws = new Float32Array(w * w);
  let any = false;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const v = terrain.waterLevelAt(ox + i * step, oz + j * step);
      ws[j * w + i] = v;
      if (v > -Infinity && v > H(i, j)) any = true;
    }
  }
  if (!any) return new Float32Array(0);

  const out: number[] = [];
  const put = (i: number, j: number, y: number) => {
    out.push(i * step, y, j * step);
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      // **1 隅でも水面下なら張る。** 岸の内側まで水を伸ばして、地形に隠させる。
      //
      // 「4 隅すべてが水面下のときだけ」にすると、水のポリゴンが格子に沿った
      // 階段で終わる。地形は水面線をなめらかに横切るので、階段と本当の水際の
      // 間に切れ込みが並び、水際がガタついて見える（実際にそうなった）。
      // 広めに張って深度で切らせれば、境界線は画素単位でなめらかになる。
      let level = -Infinity;
      let wet = false;
      for (const [di, dj] of CORNERS) {
        const lv = ws[(j + dj) * w + (i + di)];
        if (lv === -Infinity) continue;
        if (lv > level) level = lv;
        if (lv > H(i + di, j + dj)) wet = true;
      }
      if (!wet) continue;
      put(i, j, level);
      put(i, j + 1, level);
      put(i + 1, j + 1, level);
      put(i, j, level);
      put(i + 1, j + 1, level);
      put(i + 1, j, level);
    }
  }
  return new Float32Array(out);
}

const CORNERS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

/** スカートの色。隙間から見えても目立たない暗い土。 */
const SKIRT_COLOR = [0.05, 0.045, 0.042] as const;

/**
 * 曲率による面の明暗。凹みを暗くすることで、影を落とさずに形を読ませる。
 * 面ごとのランダムな明暗だけでは、平らな面の上では「模様」に見えて形に見えない。
 * x/(1+|x|) で柔らかく飽和させる（clamp で切ると黒い斑になる。CURVATURE_GAIN 参照）。
 */
function faceShape(curv: number): number {
  const g = curv * CURVATURE_GAIN;
  const k = g / (1 + Math.abs(g));
  return 1 + k * (k < 0 ? CURVATURE_DARK : CURVATURE_LIGHT);
}

/**
 * 面ごとのわずかな揺らぎ。曲率がほぼ 0 の平地が均一になりすぎるのを防ぐ（ローポリの面が読める）。
 * 曲率と競合しないよう、以前の ±6% から ±3% に落としてある。
 */
function jitter(i: number, j: number, which: number): number {
  return 0.97 + hash2(i, j * 2 + which, 7717) * 0.06;
}
