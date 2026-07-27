import { hash2 } from '../core/rng';
import { clamp, mix, smoothstep } from './noise';
import { CHUNK_SIZE } from './chunk';
import { NO_SPECIAL, SPECIAL_BIOMES, type SpecialHit } from './special';
import type { Terrain } from './terrain';
import {
  KIND_BROADLEAF,
  KIND_BROADLEAF_TALL,
  KIND_BROADLEAF_WIDE,
  KIND_BUSH,
  KIND_DEAD,
  KIND_PALM,
  KIND_PINE,
  KIND_PINE_OLD,
  KIND_PINE_YOUNG,
  KIND_ROCK,
} from './vegetationKinds';

export { KIND_BROADLEAF, KIND_BUSH, KIND_PINE, KIND_ROCK } from './vegetationKinds';

export interface ScatterBatch {
  kind: number;
  /** 4x4 行列を並べた列（16 要素 × インスタンス数）。 */
  matrices: Float32Array;
  /** インスタンスごとの色ムラ（3 要素 × インスタンス数）。 */
  colors: Float32Array;
}

/**
 * place() に渡る文脈。
 *
 * **slope と talus は触ると heightAt が 3 回走る。** 安い判定（標高・気候・
 * かたまり・乱数）で先に落としてから、最後に見ること。分割代入で受け取ると
 * 全部その場で評価されてしまうので、`c.slope` の形で使う。
 */
interface PlaceContext {
  readonly h: number;
  readonly slope: number;
  readonly temp: number;
  readonly moisture: number;
  /** その場所の宝物区画（なければ index < 0）。 */
  readonly special: SpecialHit;
  /** 森のかたまり。密度に掛けると塊と空き地ができる。 */
  readonly grove: number;
  /** 頭上の崖の急さ。0 なら平ら、1 以上なら上に崖がある。 */
  readonly talus: number;
  /** この候補の乱数 0..1。 */
  readonly r: number;
}

interface KindSpec {
  /**
   * この spec が出す形の一覧。候補ごとにハッシュで 1 つ選ぶ。
   * 1 つしか無いと、同じ形が何百本も並んで壁紙に見える。
   */
  kinds: number[];
  /** 配置候補の格子間隔。 */
  spacing: number;
  salt: number;
  /** この LOD 以下のチャンクにだけ生やす。 */
  maxLod: number;
  /**
   * たまに現れる巨木の割合（0 なら出ない）。
   * 同じ大きさばかりだと並木に見えるので、スケールの対比を作る。
   * 空から見たときに一番効く。
   */
  giantChance?: number;
  /** 開始地点の視界を塞ぐ高さのもの。低木と岩は false のまま。 */
  blocksSpawn?: boolean;
  /**
   * 頂点色に掛ける気候ごとの色味。形だけでなく色も土地に従わせる。
   * 1 を基準にした倍率で、派手な塗り替えではなくわずかな方向付けに使う。
   */
  tint?: readonly [number, number, number];
  /** 置くならスケールを、置かないなら 0 を返す。 */
  place(ctx: PlaceContext): number;
}

/** 巨木の倍率。 */
// 基準の大きさ（0.75〜1.35）と縦の伸び（0.85〜1.25）にも掛かるので、
// ここを 3.4 にすると実際には 5.7 倍まで伸びて記念樹みたいになる（一度なった）。
const GIANT_MIN = 1.55;
const GIANT_MAX = 2.05;
const DEFAULT_TINT = [1, 1, 1] as const;

/**
 * 気候で決まる普通の植生。
 * 宝物区画では木が引っ込む（宝物の木に場所を譲る）。岩だけは残す。
 *
 * 基準標高の再配分後、同じ 96 チャンクで全配置 11,979 → 11,795、
 * 木 6,498 → 6,575 になるよう密度を再較正してある。
 */
const CLIMATE_SPECS: KindSpec[] = [
  {
    // 広葉樹: 温帯〜暖帯の湿った所。寒い地方と砂漠には生えない。
    kinds: [KIND_BROADLEAF, KIND_BROADLEAF_TALL, KIND_BROADLEAF_WIDE],
    spacing: 7,
    salt: 1301,
    maxLod: 1,
    giantChance: 0.012,
    blocksSpawn: true,
    tint: [0.98, 1.08, 0.9],
    // ctx.slope は heightAt を 3 回呼ぶ。安い判定で落としてから最後に見ること。
    place: (c) => {
      if (c.h < 3.2 || c.h > 52) return 0;
      const climate = smoothstep(0.34, 0.68, c.moisture) * band(c.temp, 0.4, 0.62, 0.9);
      const density =
        climate * c.grove * (1 - smoothstep(34, 52, c.h)) * 0.7 * (1 - c.special.strength);
      if (c.r > density) return 0;
      if (c.slope > 0.42) return 0;
      return 0.75 + ((c.r * 977) % 1) * 0.6;
    },
  },
  {
    // 針葉樹: 涼しい所。寒帯や山の中腹を担う。
    kinds: [KIND_PINE, KIND_PINE_YOUNG, KIND_PINE_OLD],
    spacing: 8,
    salt: 4409,
    maxLod: 1,
    giantChance: 0.01,
    blocksSpawn: true,
    tint: [0.86, 1.0, 1.06],
    place: (c) => {
      if (c.h < 6 || c.h > 96) return 0;
      const climate = smoothstep(0.22, 0.55, c.moisture) * band(c.temp, 0.12, 0.34, 0.6);
      const density = climate * c.grove * 0.77 * (1 - c.special.strength);
      if (c.r > density) return 0;
      if (c.slope > 0.5) return 0;
      return 0.8 + ((c.r * 613) % 1) * 0.7;
    },
  },
  {
    // 椰子: 暑く湿った低地。既にある形を密林の目印として使う。
    kinds: [KIND_PALM],
    spacing: 13,
    salt: 5519,
    maxLod: 1,
    giantChance: 0.006,
    blocksSpawn: true,
    tint: [0.95, 1.1, 0.82],
    place: (c) => {
      if (c.h < 2.8 || c.h > 42) return 0;
      const heat = smoothstep(0.62, 0.82, c.temp);
      const wet = smoothstep(0.44, 0.7, c.moisture);
      // 一面へ均等に撒かず、林と空き地をはっきり分ける。形の強い椰子は
      // 広葉樹と同じ密度で並べると、一本ずつではなく模様として見えてしまう。
      const clump = mix(0.14, 1.25, smoothstep(0.68, 1.32, c.grove));
      const density =
        heat * wet * clump * 0.42 * (1 - c.special.strength);
      if (c.r > density) return 0;
      if (c.slope > 0.38) return 0;
      return 0.78 + ((c.r * 419) % 1) * 0.48;
    },
  },
  {
    // 枯れ木: 暑く乾いた草原〜砂漠。空白だけだった乾燥帯に輪郭を与える。
    kinds: [KIND_DEAD],
    spacing: 18,
    salt: 6323,
    maxLod: 1,
    blocksSpawn: true,
    tint: [1.08, 0.98, 0.78],
    place: (c) => {
      if (c.h < 2.8 || c.h > 64) return 0;
      const heat = smoothstep(0.52, 0.78, c.temp);
      const dry = 1 - smoothstep(0.13, 0.34, c.moisture);
      const density = heat * dry * 0.3 * (1 - c.special.strength);
      if (c.r > density) return 0;
      if (c.slope > 0.44) return 0;
      return 0.72 + ((c.r * 733) % 1) * 0.55;
    },
  },
  {
    // 岩: 崖の下に落ちて溜まる（talus）。宝物区画でも残す。
    //
    // 以前は「傾きが急な所」に置くだけだった。それだと岩が崖の"面"に貼り付き、
    // なぜそこにあるのか説明がつかない。実際の転石は上の崖から落ちてきて、
    // 傾きが緩んだ所に溜まる。talus（上り方向の崖の急さ）を見るとそれが出る。
    kinds: [KIND_ROCK],
    spacing: 17,
    salt: 7717,
    maxLod: 1,
    tint: [1.02, 1, 0.96],
    place: (c) => {
      if (c.h < 1.0) return 0;
      // 密度は最大でも (0.05+0.75+0.2)*0.75 = 0.75。先に落として崖の判定を省く。
      if (c.r > 0.75) return 0;
      // 上に崖があり、かつ自分はそこまで急でない ＝ 溜まり場。
      const pile = smoothstep(0.5, 1.4, c.talus) * (1 - smoothstep(0.45, 0.85, c.slope));
      const density = (0.05 + pile * 0.75 + smoothstep(50, 90, c.h) * 0.2) * 0.75;
      if (c.r > density) return 0;
      return 0.6 + ((c.r * 331) % 1) * 2.4;
    },
  },
  {
    // 低木: 暖かく湿った所の下草。砂漠と寒帯には出さない。
    kinds: [KIND_BUSH],
    spacing: 5,
    salt: 2237,
    maxLod: 0,
    tint: [0.96, 1.08, 0.84],
    place: (c) => {
      if (c.h < 2.4 || c.h > 60) return 0;
      const climate = smoothstep(0.28, 0.6, c.moisture) * band(c.temp, 0.35, 0.6, 0.92);
      // 下草は森の中で濃い。かたまりの効きは木より弱くする（空き地にも少し残す）。
      const density = climate * mix(1, c.grove, 0.65) * 0.44 * (1 - c.special.strength);
      if (c.r > density) return 0;
      if (c.slope > 0.55) return 0;
      return 0.7 + ((c.r * 149) % 1) * 0.9;
    },
  },
];

/**
 * 宝物の木。宝物区画に入っているときだけ、その区画の木を生やす。
 * SPECIAL_BIOMES から自動で作るので、宝物を足せばここも自動で増える。
 */
const SPECIAL_SPECS: KindSpec[] = SPECIAL_BIOMES.flatMap((biome, index) => {
  if (biome.treeKind === null) return [];
  return [
    {
      kinds: [biome.treeKind],
      spacing: biome.treeSpacing,
      salt: 9001 + index * 13,
      maxLod: 1,
      giantChance: 0.012,
      blocksSpawn: true,
      place: (c) => {
        // 自分の宝物区画の中だけ。強さが弱い縁ほどまばらに。
        if (c.special.index !== index) return 0;
        if (c.h < 1.5) return 0;
        if (c.r > biome.treeDensity * c.special.strength * mix(1, c.grove, 0.6)) return 0;
        if (c.slope > 0.5) return 0;
        return 0.8 + ((c.r * 811) % 1) * 0.6;
      },
    },
  ];
});

const SPECS: KindSpec[] = [...CLIMATE_SPECS, ...SPECIAL_SPECS];

/**
 * 値が [lo, hi] の帯に入っているほど 1 に近づく（山なりの窓）。
 * 気温の得意な範囲を植生ごとに切り出すのに使う。
 */
function band(v: number, lo: number, mid: number, hi: number): number {
  return v < mid ? smoothstep(lo, mid, v) : smoothstep(hi, mid, v);
}

/**
 * 開始地点のまわりに、視界を塞ぐ木が生えるか。
 *
 * 候補格子・乱数・各 biome の place() を本番配置と共有する。別の簡易判定を
 * 書くと「空き地を選んだつもりなのに木の中」という食い違いが再発するため。
 * 湿り気だけはチャンク補間前の値だが、波長 1,100m 以上なので半径数mでは同じ。
 */
export function hasTallVegetationNear(
  terrain: Terrain,
  centerX: number,
  centerZ: number,
  radius: number,
): boolean {
  const r2 = radius * radius;
  for (const spec of SPECS) {
    if (!spec.blocksSpawn) continue;
    const g0 = Math.floor((centerX - radius) / spec.spacing);
    const g1 = Math.floor((centerX + radius) / spec.spacing);
    const k0 = Math.floor((centerZ - radius) / spec.spacing);
    const k1 = Math.floor((centerZ + radius) / spec.spacing);
    for (let gx = g0; gx <= g1; gx++) {
      for (let gz = k0; gz <= k1; gz++) {
        const x = (gx + hash2(gx, gz, spec.salt + 1)) * spec.spacing;
        const z = (gz + hash2(gx, gz, spec.salt + 2)) * spec.spacing;
        if ((x - centerX) ** 2 + (z - centerZ) ** 2 >= r2) continue;

        const h = terrain.heightAt(x, z);
        if (h < 0.8 || h < terrain.waterLevelAt(x, z) + 0.6) continue;
        CTX.h = h;
        CTX.r = hash2(gx, gz, spec.salt);
        CTX.moisture = terrain.moistureAt(x, z);
        CTX.temp = terrain.temperatureAt(x, z, h);
        CTX.special = terrain.specialAt(x, z);
        CTX.grove = terrain.groveAt(x, z);
        CTX._t = terrain;
        CTX._x = x;
        CTX._z = z;
        CTX._ready = false;
        if (spec.place(CTX) > 0) return true;
      }
    }
  }
  return false;
}

/** 3 点差分で地面の傾きを測り、あわせて「上の崖の急さ」も出す。 */
function slopeAndTalus(t: Terrain, x: number, z: number, h: number, out: Float32Array): void {
  const d = 2.5;
  const dx = (t.heightAt(x + d, z) - h) / d;
  const dz = (t.heightAt(x, z + d) - h) / d;
  const g = Math.hypot(dx, dz);
  out[0] = clamp(g / 1.6, 0, 1);
  if (g < 1e-4) {
    out[1] = 0;
    return;
  }
  // 上り方向へ 14m 進んだ先がどれだけ高いか ＝ 頭上の崖の急さ。
  // 転石はここから落ちてくる。
  const up = t.heightAt(x + (dx / g) * TALUS_LOOK, z + (dz / g) * TALUS_LOOK);
  out[1] = clamp((up - h) / TALUS_LOOK, 0, 2);
}

/** 頭上の崖を探す距離（m）。 */
const TALUS_LOOK = 14;

/**
 * 湿り気を引く格子の間隔（m）。chunk.ts の CLIMATE_STEP と同じ理由。
 *
 * 雨陰が入って moistureAt が 0.08μs → 3.79μs（40 倍）になった。植生は
 * 1 チャンクで 3,311 回呼ぶので、これだけで 12.5ms かかっていた。
 * 起動時の生成コストの 6 割が植生になり、初回表示が目に見えて遅くなった。
 * 湿り気は波長 1,100m 以上でゆっくり変わるので、格子で引いて補間してよい。
 */
const CLIMATE_STEP = 24;

// slopeAndTalus の受け皿。候補ごとに配列を作らないため。
const ST = new Float32Array(2);

/**
 * place() に渡す文脈。使い回して割り当てを避ける。
 *
 * slope と talus は heightAt を 3 回呼ぶので、**参照されたときだけ**計算する。
 * ほとんどの候補は密度の抽選で先に落ちるので、そこまで到達しない。
 */
const CTX = {
  h: 0,
  temp: 0,
  moisture: 0,
  special: NO_SPECIAL as SpecialHit,
  grove: 0,
  r: 0,
  // 以下は遅延評価のための内部状態。
  _t: null as Terrain | null,
  _x: 0,
  _z: 0,
  _ready: false,
  _calc(): void {
    if (this._ready) return;
    this._ready = true;
    slopeAndTalus(this._t!, this._x, this._z, this.h, ST);
  },
  get slope(): number {
    this._calc();
    return ST[0];
  },
  get talus(): number {
    this._calc();
    return ST[1];
  },
};

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

  // 湿り気は粗い格子で引いて補間する（CLIMATE_STEP 参照）。
  // 格子は CHUNK_SIZE を割り切るので、隣のチャンクと世界座標で一致する。
  const cg = CHUNK_SIZE / CLIMATE_STEP;
  const cw = cg + 1;
  const mgrid = new Float32Array(cw * cw);
  for (let j = 0; j < cw; j++) {
    for (let i = 0; i < cw; i++) {
      mgrid[j * cw + i] = terrain.moistureAt(ox + i * CLIMATE_STEP, oz + j * CLIMATE_STEP);
    }
  }
  const moistureAt = (x: number, z: number) => {
    const u = (x - ox) / CLIMATE_STEP;
    const v = (z - oz) / CLIMATE_STEP;
    const i = Math.min(cg - 1, Math.max(0, u | 0));
    const j = Math.min(cg - 1, Math.max(0, v | 0));
    const fu = u - i;
    const fv = v - j;
    const a = mgrid[j * cw + i];
    const b = mgrid[j * cw + i + 1];
    const c = mgrid[(j + 1) * cw + i];
    const d = mgrid[(j + 1) * cw + i + 1];
    return (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
  };

  for (const spec of SPECS) {
    if (lod > spec.maxLod) continue;

    const g0 = Math.floor(ox / spec.spacing);
    const g1 = Math.floor((ox + CHUNK_SIZE - 0.001) / spec.spacing);
    const k0 = Math.floor(oz / spec.spacing);
    const k1 = Math.floor((oz + CHUNK_SIZE - 0.001) / spec.spacing);

    // 形ごとに別の InstancedMesh になるので、配列も形ごとに持つ。
    // 上限いっぱいで確保し、最後に実数へ切り詰める。
    const cap = (g1 - g0 + 1) * (k1 - k0 + 1);
    const nv = spec.kinds.length;
    const mats: Float32Array[] = [];
    const cols: Float32Array[] = [];
    const counts: number[] = [];
    for (let v = 0; v < nv; v++) {
      mats.push(new Float32Array(cap * 16));
      cols.push(new Float32Array(cap * 3));
      counts.push(0);
    }

    for (let gx = g0; gx <= g1; gx++) {
      for (let gz = k0; gz <= k1; gz++) {
        const r = hash2(gx, gz, spec.salt);
        const x = (gx + hash2(gx, gz, spec.salt + 1)) * spec.spacing;
        const z = (gz + hash2(gx, gz, spec.salt + 2)) * spec.spacing;
        if (x < ox || x >= ox + CHUNK_SIZE || z < oz || z >= oz + CHUNK_SIZE) continue;

        const h = terrain.heightAt(x, z);
        // 水面下と、明らかに条件外の場所は重い判定に入る前に落とす。
        if (h < 0.8) continue;
        // **内陸の湖も水面下。** ここは海面（0m）しか見ていなかったので、
        // 湖の中に木がびっしり生えていた。湖の水面は場所ごとに高さが違うので、
        // 海と同じ判定では拾えない。heightAt が既に区画を引いているため、
        // ここでの引き直しは覚えてある値の読み出しで済む。
        if (h < terrain.waterLevelAt(x, z) + 0.6) continue;
        CTX.h = h;
        CTX.r = r;
        CTX.moisture = moistureAt(x, z);
        CTX.temp = terrain.temperatureAt(x, z, h);
        CTX.special = terrain.specialAt(x, z);
        CTX.grove = terrain.groveAt(x, z);
        // 傾きと転石はここでは計算しない。place() が触ったときだけ求める。
        CTX._t = terrain;
        CTX._x = x;
        CTX._z = z;
        CTX._ready = false;
        let scale = spec.place(CTX);
        if (scale <= 0) continue;

        // たまに巨木。大きさが揃っていると並木に見えるので、対比を作る。
        if (spec.giantChance) {
          const g = hash2(gx, gz, spec.salt + 8);
          if (g < spec.giantChance) scale *= mix(GIANT_MIN, GIANT_MAX, g / spec.giantChance);
        }

        // どの形にするか。同じ形ばかりだと壁紙に見える。
        const v = nv === 1 ? 0 : Math.min(nv - 1, (hash2(gx, gz, spec.salt + 9) * nv) | 0);
        const matrices = mats[v];
        const colors = cols[v];
        const count = counts[v];

        const yaw = hash2(gx, gz, spec.salt + 3) * Math.PI * 2;
        // わずかに傾いている方が並木らしくならず自然に見える。
        const tilt = (hash2(gx, gz, spec.salt + 4) - 0.5) * 0.14;
        const sy = scale * (0.85 + hash2(gx, gz, spec.salt + 5) * 0.4);
        composeInto(matrices, count * 16, x - ox, h - 0.25, z - oz, yaw, tilt, scale, sy, scale);

        // 明るさに加えて色相も振る。以前は明度だけだったので、同じ緑が
        // 並んで壁紙に見えていた。黄緑〜青緑に散らすと森らしくなる。
        const bright = 0.82 + hash2(gx, gz, spec.salt + 6) * 0.36;
        const hue = hash2(gx, gz, spec.salt + 7) - 0.5;
        const tint = spec.tint ?? DEFAULT_TINT;
        colors[count * 3] = bright * tint[0] * (1 + hue * 0.16);
        colors[count * 3 + 1] = bright * tint[1];
        colors[count * 3 + 2] = bright * tint[2] * (1 - hue * 0.18);
        counts[v] = count + 1;
      }
    }

    for (let v = 0; v < nv; v++) {
      if (counts[v] === 0) continue;
      batches.push({
        kind: spec.kinds[v],
        matrices: mats[v].slice(0, counts[v] * 16),
        colors: cols[v].slice(0, counts[v] * 3),
      });
    }
  }

  return batches;
}
