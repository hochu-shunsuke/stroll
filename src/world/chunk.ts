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

/**
 * 色を塗るための地形の性質（傾き・曲がり）を測る間隔（m）。LOD によらず同じ尺度で測るので、
 * 遠近で色と明暗が跳ばない。CHUNK_SIZE を割り切ること（隣のチャンクと格子を揃える）。
 */
const FIELD_STEP = 16;
if (CHUNK_SIZE % FIELD_STEP !== 0) {
  throw new Error('FIELD_STEP は CHUNK_SIZE を割り切ってください');
}

export interface ChunkArrays {
  /** 頂点を共有する格子（(n+1)² 点）と、外周のスカートの下端（4(n+1) 点）。 */
  position: Float32Array;
  normal: Float32Array;
  /**
   * 地面の層（world/surfaceShade.ts）。color = 土台の色、rock = 岩の色、
   * surf = [岩の量, 雪の量, 凹みの明暗 ÷ 2]。境目は画素ごとに切る（render/terrainMaterial.ts）。
   *
   * rock と surf は 0..255 に詰める（材質側で 0..1 に戻す）。浮動小数のままだと GPU のメモリが
   * 無駄に増える。土台の色は暗い色の段差が目立つので浮動小数のまま。
   */
  color: Float32Array;
  rock: Uint8Array;
  surf: Uint8Array;
  index: Uint16Array | Uint32Array;
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
 * チャンクの地形メッシュ。頂点を共有し、法線は格子の中心差分で取る（なめらかな陰影）。
 * 座標はチャンク原点からの相対値（遠方での精度を保つため）。
 *
 * **色は面ごとに決めない。** 層と量を頂点ごとに持ち、境目と細かい質感は画素ごとに作る
 * （render/terrainMaterial.ts）。面ごとに 1 色だった頃は、雪と岩の境が格子に揃って
 * 市松模様になった（遠くの粗いチャンクほど四角が大きい）。
 * 以前のローポリ（面の法線・面ごとの明暗）は、hakoniwa と同じなめらかな表面に置き換えた（利用者の判断）。
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
  // 外周に 1 リング余分に取っているのは、法線の中心差分が隣の点を要るため。これが無いと
  // チャンクの継ぎ目にだけ陰影の線が出る。
  const W = n + 3;
  const hs = new Float32Array(W * W);
  for (let j = -1; j <= n + 1; j++) {
    for (let i = -1; i <= n + 1; i++) {
      hs[(j + 1) * W + (i + 1)] = terrain.heightAt(ox + i * step, oz + j * step);
    }
  }
  // i, j は -1 から n+1 まで引ける。
  const H = (i: number, j: number) => hs[(j + 1) * W + (i + 1)];

  // 色を塗るための傾きと曲がりは、LOD によらず 16m 間隔で測る（225 点。最密チャンクの 2% 増し）。
  const M = CHUNK_SIZE / FIELD_STEP;
  const FW = M + 3;
  const fh = new Float32Array(FW * FW);
  for (let j = -1; j <= M + 1; j++) {
    for (let i = -1; i <= M + 1; i++) {
      fh[(j + 1) * FW + (i + 1)] = terrain.heightAt(ox + i * FIELD_STEP, oz + j * FIELD_STEP);
    }
  }
  const F = (i: number, j: number) => fh[(j + 1) * FW + (i + 1)];
  const fslope = new Float32Array((M + 1) * (M + 1));
  const fcurv = new Float32Array((M + 1) * (M + 1));
  for (let j = 0; j <= M; j++) {
    for (let i = 0; i <= M; i++) {
      const dx = (F(i + 1, j) - F(i - 1, j)) / (2 * FIELD_STEP);
      const dz = (F(i, j + 1) - F(i, j - 1)) / (2 * FIELD_STEP);
      fslope[j * (M + 1) + i] = Math.sqrt(dx * dx + dz * dz);
      fcurv[j * (M + 1) + i] =
        (F(i, j) - (F(i - 1, j) + F(i + 1, j) + F(i, j - 1) + F(i, j + 1)) * 0.25) / FIELD_STEP;
    }
  }
  const fields = { slope: 0, curvature: 0 };
  /** チャンク内の相対座標で、16m の格子から傾きと曲がりを双一次で引く。 */
  const fieldsLocal = (lx: number, lz: number) => {
    const u = lx / FIELD_STEP;
    const v = lz / FIELD_STEP;
    const i = Math.min(M - 1, u | 0);
    const j = Math.min(M - 1, v | 0);
    const fu = u - i;
    const fv = v - j;
    const k = j * (M + 1) + i;
    const lerp = (a: Float32Array) =>
      (a[k] + (a[k + 1] - a[k]) * fu) * (1 - fv) + (a[k + M + 1] + (a[k + M + 2] - a[k + M + 1]) * fu) * fv;
    fields.slope = lerp(fslope);
    fields.curvature = lerp(fcurv);
    return fields;
  };

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

  const w = n + 1;
  const grid = w * w;
  const vertexCount = grid + 4 * w;
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const color = new Float32Array(vertexCount * 3);
  const rock = new Uint8Array(vertexCount * 3);
  const surf = new Uint8Array(vertexCount * 3);
  const layers = new Float32Array(SURFACE_STRIDE);
  const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);

  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const v = j * w + i;
      const h = H(i, j);
      const x = ox + i * step;
      const z = oz + j * step;
      const dx = (H(i + 1, j) - H(i - 1, j)) / (2 * step);
      const dz = (H(i, j + 1) - H(i, j - 1)) / (2 * step);
      const len = Math.sqrt(dx * dx + 1 + dz * dz);
      position[v * 3] = i * step;
      position[v * 3 + 1] = h;
      position[v * 3 + 2] = j * step;
      normal[v * 3] = -dx / len;
      normal[v * 3 + 1] = 1 / len;
      normal[v * 3 + 2] = -dz / len;

      terrain.surface(
        x,
        z,
        h,
        Math.sqrt(dx * dx + dz * dz),
        fieldsLocal(i * step, j * step),
        terrain.temperatureAt(x, z, h),
        moistureLocal(i * step, j * step),
        terrain.specialAt(x, z),
        layers,
        0,
      );
      color[v * 3] = layers[0];
      color[v * 3 + 1] = layers[1];
      color[v * 3 + 2] = layers[2];
      rock[v * 3] = byte(layers[3]);
      rock[v * 3 + 1] = byte(layers[4]);
      rock[v * 3 + 2] = byte(layers[5]);
      surf[v * 3] = byte(layers[6]);
      surf[v * 3 + 1] = byte(layers[7]);
      surf[v * 3 + 2] = byte(layers[8] * 0.5);
    }
  }

  // スカート: 外周を真下に下ろし、LOD 差でできる隙間から空が覗くのを防ぐ。
  // 下端の点は上端の点と同じ色・法線にする（隙間から見えても地面の続きに見える）。
  const S = CHUNK_SIZE;
  const D = SKIRT_DEPTH;
  const bottom = (edge: number, k: number) => grid + edge * w + k;
  const copyVertex = (to: number, x: number, y: number, z: number, from: number) => {
    position[to * 3] = x;
    position[to * 3 + 1] = y;
    position[to * 3 + 2] = z;
    for (let c = 0; c < 3; c++) {
      normal[to * 3 + c] = normal[from * 3 + c];
      color[to * 3 + c] = color[from * 3 + c];
      rock[to * 3 + c] = rock[from * 3 + c];
      surf[to * 3 + c] = surf[from * 3 + c];
    }
  };
  for (let k = 0; k <= n; k++) {
    copyVertex(bottom(0, k), k * step, H(k, 0) - D, 0, k);
    copyVertex(bottom(1, k), k * step, H(k, n) - D, S, n * w + k);
    copyVertex(bottom(2, k), 0, H(0, k) - D, k * step, k * w);
    copyVertex(bottom(3, k), S, H(n, k) - D, k * step, k * w + n);
  }

  const index = vertexCount > 65535
    ? new Uint32Array(n * n * 6 + n * 24)
    : new Uint16Array(n * n * 6 + n * 24);
  let q = 0;
  const tri = (a: number, b: number, c: number) => {
    index[q++] = a;
    index[q++] = b;
    index[q++] = c;
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const v00 = j * w + i;
      const v10 = v00 + 1;
      const v01 = v00 + w;
      const v11 = v01 + 1;
      // 割り方の判定は terrain.ts に 1 つだけ置いてある。heightOnGrid も同じものを
      // 使うので、足元と見た目が必ず一致する。ここでベタ書きに戻さないこと。
      if (splitsAlongMainDiagonal(H(i, j), H(i + 1, j), H(i, j + 1), H(i + 1, j + 1))) {
        tri(v00, v01, v11);
        tri(v00, v11, v10);
      } else {
        tri(v00, v01, v10);
        tri(v01, v11, v10);
      }
    }
  }
  for (let k = 0; k < n; k++) {
    // z = 0 の辺
    tri(k, k + 1, bottom(0, k));
    tri(k + 1, bottom(0, k + 1), bottom(0, k));
    // z = S の辺
    tri(n * w + k + 1, n * w + k, bottom(1, k));
    tri(n * w + k + 1, bottom(1, k), bottom(1, k + 1));
    // x = 0 の辺
    tri((k + 1) * w, k * w, bottom(2, k));
    tri((k + 1) * w, bottom(2, k), bottom(2, k + 1));
    // x = S の辺
    tri(k * w + n, (k + 1) * w + n, bottom(3, k));
    tri((k + 1) * w + n, bottom(3, k + 1), bottom(3, k));
  }

  return { position, normal, color, rock, surf, index, water: buildWater(terrain, ox, oz, step, n, H) };
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
