import {
  EDGE_WIDEN_MAX,
  EDGE_WIDTH,
  EDGE_WOBBLE_RATE,
  LF_PLATEAU,
  landformAt,
} from './landform';
import {
  Noise2D,
  clamp,
  fbm,
  fbmD,
  fbmEroded,
  hermiteSpline,
  mix,
  smoothstep,
  spline,
} from './noise';

// 台地が周りの地面から持ち上がる高さ（メートル）。
const PLATEAU_RISE_MIN = 22;
const PLATEAU_RISE_MAX = 38;

/**
 * 台地の縁の最大傾斜。縁の幅を落差に比例させ、落差にも上限を置くことで、
 * この値が実際の上限になる。変更時は player の MAX_CLIMB と突き合わせる。
 */
export const STEEPEST_LANDFORM_SLOPE =
  ((1.5 * PLATEAU_RISE_MAX) / EDGE_WIDTH) * (1 + EDGE_WOBBLE_RATE);

/**
 * 大陸度 → 基準の高さ（m）。折れ点の平らな区間が平原と段を作り、
 * ゼロを跨ぐ位置が海陸比を決める。
 */
const SP_BASE: readonly (readonly [number, number, number])[] = [
  [-1.0, -58, 0],
  [-0.42, -30, 0],
  [-0.24, -7, 0],
  [-0.13, 3, 0],
  [0.04, 10, 0],
  [0.216, 16, 57],
  [0.442, 58, 174],
  [0.64, 90, 153],
  [1.0, 142, 134],
];

const baseHeight = (cont: number): number => hermiteSpline(SP_BASE, cont);

/** 侵食度 → 起伏の振れ幅（m）。高いほど平ら。 */
const SP_RELIEF: readonly (readonly [number, number])[] = [
  [-1.0, 104],
  [-0.55, 68],
  [-0.28, 38],
  [-0.06, 13],
  [0.12, 5],
  [1.0, 4],
];

// 高山は「広い丘陵 → 山地の肩と複数尾根 → 狭い峰」の順で作る。
// 狭い PEAK_SPIRE を主役にすると平地から一本だけ立つ針になる。
const PEAK_MASSIF = 100;
const PEAK_SPIRE = 32;
const UPLAND_RISE = 54;
const RUGGED_SHOULDER = 34;
const RUGGED_RIDGE = 24;
const RUGGED_CONT: [number, number] = [0.16, 0.5];
const RUGGED_ERO: [number, number] = [0, -0.54];
const RUGGED_PV: [number, number] = [-0.4, 0.66];
const PEAK_CONT: [number, number] = [0.38, 0.66];
const PEAK_ERO: [number, number] = [-0.42, -0.7];
const PEAK_PV: [number, number] = [0.15, 0.72];

/** 尾根と谷 → 起伏の中での高さの割合。左の平らな区間が歩ける谷底になる。 */
const SP_PV: readonly (readonly [number, number])[] = [
  [-1.0, -0.34],
  [-0.58, -0.34],
  [-0.22, -0.17],
  [0.3, 0.2],
  [1.0, 0.52],
];

// 海岸で起伏を抑えないと、海面線を何度も跨いでリアス式になる。
const COAST_FLAT_H = 12;
const COAST_FLAT_FLOOR = 0.15;

/**
 * 大陸度 → 起伏の効き方。低地は「歩く場所」として抑え、
 * 内陸は「見る場所」として山を立てる。
 */
const SP_RELIEF_GATE: readonly (readonly [number, number])[] = [
  [-1.0, 0.1],
  [-0.2, 0.2],
  [0.0, 0.3],
  [0.22, 0.44],
  [0.38, 1.0],
  [1.0, 1.0],
];

/** ねじれノイズを折り返して -1（谷底）〜 +1（稜線）にする。 */
function peaksValleys(w: number): number {
  return 1 - Math.abs(3 * Math.abs(w) - 2);
}

/**
 * domain warp。WARP_AMOUNT × WARP_FREQ × ノイズ勾配が 1 を超えると座標が
 * 折り返して指紋状になるので、振幅だけでなく勾配を守ること。
 */
const WARP_FREQ = 0.0007;
const WARP_AMOUNT = 170;

const BASE_JITTER_FREQ = 0.0004;
const BASE_JITTER_AMOUNT = 0.05;

// 連結したゼロ線を浅く彫る涸れ谷。深くすると海面固定の水が低地へ入り、
// 海岸が細切れになるため、川の水面を別に持つまでは 9m に保つ。
const RIVER_FREQ = 0.00055;
const RIVER_HALF = 62;
const RIVER_INNER = 0.25;
const RIVER_DEPTH = 9;

export const STEEPEST_RIVER_BANK =
  (1.5 * RIVER_DEPTH) / (RIVER_HALF * (1 - RIVER_INNER));

// 川の判定に使い回す。1 回ごとに配列を作らないため。
const RD = new Float32Array(3);

/**
 * 湖を入れる前の地形骨格。
 *
 * Terrain は水・気候・特殊区画を束ねる facade として残し、標高の全レイヤーは
 * このクラスへ集約する。湖は continentNoise / erosionNoise / baseHeightAt /
 * heightAt を使うため、同じ骨格を公開して二重実装を防ぐ。
 */
export class TerrainShape {
  readonly continentNoise: Noise2D;
  readonly erosionNoise: Noise2D;
  private readonly nRidge: Noise2D;
  private readonly nDetail: Noise2D;
  private readonly nWarp: Noise2D;
  private readonly nBaseJitter: Noise2D;
  private readonly nRiver: Noise2D;
  private readonly nLandformEdge: Noise2D;
  private readonly landformSalt: number;

  constructor(a: number, b: number, c: number, d: number) {
    this.continentNoise = new Noise2D(a);
    this.erosionNoise = new Noise2D(b);
    this.nRidge = new Noise2D(c);
    this.nDetail = new Noise2D((a ^ 0x9e3779b9) >>> 0);
    this.nWarp = new Noise2D(d);
    this.nBaseJitter = new Noise2D((d ^ 0xa24baed5) >>> 0);
    this.nRiver = new Noise2D((a ^ 0x27220a95) >>> 0);
    this.nLandformEdge = new Noise2D((c ^ 0x7feb352d) >>> 0);
    this.landformSalt = (d ^ 0x846ca68b) >>> 0;
  }

  private continentalnessAt(x: number, z: number): number {
    return fbm(this.continentNoise, x, z, 5, 0.00035);
  }

  private erosionAt(x: number, z: number): number {
    return fbm(this.erosionNoise, x, z, 4, 0.0011);
  }

  private weirdnessAt(x: number, z: number): number {
    return fbm(this.nRidge, x, z, 4, 0.0028);
  }

  /**
   * 粗い山塊の高さ。雨陰専用なので細部・warp・谷・台地を省き、
   * 大陸 3 オクターブ、侵食 2 オクターブだけを見る。
   */
  readonly massAt = (x: number, z: number): number => {
    const cont = fbm(this.continentNoise, x, z, 3, 0.00035);
    const ero = fbm(this.erosionNoise, x, z, 2, 0.0011);
    return (
      this.baseHeightAt(x, z, cont) +
      spline(SP_RELIEF, ero) * spline(SP_RELIEF_GATE, cont) * 0.5
    );
  };

  /** 海岸線を固定したまま、内陸の標高帯だけを場所ごとにずらす。 */
  readonly baseHeightAt = (x: number, z: number, cont: number): number => {
    const inland = smoothstep(0.1, 0.28, cont);
    const jitter =
      this.nBaseJitter.noise(x * BASE_JITTER_FREQ, z * BASE_JITTER_FREQ) *
      BASE_JITTER_AMOUNT *
      inland;
    return baseHeight(cont + jitter);
  };

  /** 湖を入れる前の標高。 */
  readonly heightAt = (x: number, z: number): number => {
    // 大きくゆっくり座標をゆがめ、丸いノイズを蛇行する谷と尾根へ変える。
    const wx = x + this.nWarp.noise(x * WARP_FREQ, z * WARP_FREQ) * WARP_AMOUNT;
    const wz =
      z +
      this.nWarp.noise(x * WARP_FREQ + 137.2, z * WARP_FREQ - 91.7) * WARP_AMOUNT;

    const cont = this.continentalnessAt(x, z);
    const ero = this.erosionAt(wx, wz);
    const pv = peaksValleys(this.weirdnessAt(wx, wz));

    const base = this.baseHeightAt(x, z, cont);
    const coastFlat = mix(COAST_FLAT_FLOOR, 1, smoothstep(0, COAST_FLAT_H, base));
    const relief = spline(SP_RELIEF, ero) * spline(SP_RELIEF_GATE, cont) * coastFlat;
    let h = base + spline(SP_PV, pv) * relief;
    const valley = smoothstep(-0.1, -0.72, pv);

    // 山塊には 2 オクターブの km 単位の骨格だけを使う。細部を混ぜると、
    // 100m ほどで山体が崩れて一点だけの針になる。
    const contBroad = fbm(this.continentNoise, x, z, 2, 0.00035);
    const eroBroad = fbm(this.erosionNoise, wx, wz, 2, 0.0011);
    const massif =
      smoothstep(PEAK_CONT[0], PEAK_CONT[1], contBroad) *
      smoothstep(PEAK_ERO[0], PEAK_ERO[1], eroBroad);
    const upland =
      smoothstep(0.08, 0.46, contBroad) *
      smoothstep(0.02, -0.5, eroBroad);
    const rugged =
      smoothstep(RUGGED_CONT[0], RUGGED_CONT[1], contBroad) *
      smoothstep(RUGGED_ERO[0], RUGGED_ERO[1], eroBroad);
    h += upland * UPLAND_RISE;
    h +=
      rugged *
      (RUGGED_SHOULDER +
        smoothstep(RUGGED_PV[0], RUGGED_PV[1], pv) * RUGGED_RIDGE);
    if (massif > 0) {
      h += massif * PEAK_MASSIF;
      h += massif * smoothstep(PEAK_PV[0], PEAK_PV[1], pv) * PEAK_SPIRE;
    }

    // 谷底では細部を抑え、歩く面を常にがたつかせない。
    h +=
      fbmEroded(this.nDetail, wx, wz, 4, 0.0055) *
      relief *
      0.6 *
      (1 - valley * 0.82);

    // 専用ノイズのゼロ線までの距離で、連結した涸れ谷を彫る。
    fbmD(this.nRiver, x, z, 3, RIVER_FREQ, RD);
    const gradR = Math.hypot(RD[1], RD[2]);
    const toRiver = Math.abs(RD[0]) / Math.max(gradR, 1e-9);
    const calm = 1 - smoothstep(26, 62, relief);
    const river =
      smoothstep(RIVER_HALF, RIVER_HALF * RIVER_INNER, toRiver) *
      smoothstep(-0.04, 0.1, cont) *
      calm;
    if (river > 0) {
      h -= river * RIVER_DEPTH * mix(0.25, 1, smoothstep(2, 22, base));
    }

    // 特殊な地形。通常区画ならここで終わる。
    const land = smoothstep(-0.06, 0.2, cont);
    const lf = landformAt(x, z, land, this.nLandformEdge, this.landformSalt);
    if (lf.index !== LF_PLATEAU) return h;

    // 台地の天面は滑らかな骨格を基準にする。山塊を含めないと山の上で
    // 台地が穴になり、h そのものを使うと尾根が天面へ突き出す。
    const rise = mix(PLATEAU_RISE_MIN, PLATEAU_RISE_MAX, lf.variant);
    const top =
      base +
      upland * UPLAND_RISE +
      rugged * RUGGED_SHOULDER +
      massif * PEAK_MASSIF +
      rise;

    // 幅を落差に比例させ、なお足りない落差には上限を掛ける。
    const drop = Math.abs(top - h);
    const widen = clamp(drop / PLATEAU_RISE_MAX, 1, EDGE_WIDEN_MAX);
    const strength =
      smoothstep(lf.edge, lf.edge - EDGE_WIDTH * widen, lf.dist) * lf.onLand;
    const cap = PLATEAU_RISE_MAX * EDGE_WIDEN_MAX;
    const capped = drop > cap ? h + (top - h) * (cap / drop) : top;
    return mix(h, capped, strength);
  };
}
