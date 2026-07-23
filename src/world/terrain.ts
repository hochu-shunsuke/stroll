import { hashSeed } from '../core/rng';
import { Noise2D, clamp, fbm, mix, ridged, smoothstep } from './noise';

export const SEA_LEVEL = 0;

/** sRGB の 16 進を three の作業色空間（リニア）へ。 */
function srgb(hex: number): [number, number, number] {
  const f = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return [f(((hex >> 16) & 255) / 255), f(((hex >> 8) & 255) / 255), f((hex & 255) / 255)];
}

// 落ち着いた、彩度を抑えた自然の色。
const C_SEABED = srgb(0x4d5a52);
const C_SAND = srgb(0xcbbd97);
const C_ROCK = srgb(0x878175);
const C_ROCK_DARK = srgb(0x6b6760);

// 気候帯ごとの地面の色。気温（寒→暑）× 湿り（乾→湿）の格子で決まる。
// 乾いた側（寒→温→暑）
const C_TUNDRA = srgb(0x8f948a); // 寒・乾: 色あせた灰緑
const C_GRASS_DRY = srgb(0x9aa76b); // 温・乾: 乾いた黄緑（草原）
const C_DESERT = srgb(0xcbbe95); // 暑・乾: 砂
// 湿った側（寒→温→暑）
const C_SNOW = srgb(0xe7ecef); // 寒・湿: 雪
const C_FOREST = srgb(0x5c7a51); // 温・湿: 深い森
const C_JUNGLE = srgb(0x577f43); // 暑・湿: みずみずしい密林

// shade() の途中計算に使い回す。面ごとに配列を作らないため。
const DRY: [number, number, number] = [0, 0, 0];
const WET: [number, number, number] = [0, 0, 0];

/** 3 段階の色を t(0..1) で補間する。気温の寒→温→暑に沿って地面色を作る。 */
function ramp3(
  cold: readonly number[],
  mid: readonly number[],
  hot: readonly number[],
  t: number,
  out: [number, number, number],
): void {
  if (t < 0.5) {
    const k = smoothstep(0, 0.5, t);
    out[0] = mix(cold[0], mid[0], k);
    out[1] = mix(cold[1], mid[1], k);
    out[2] = mix(cold[2], mid[2], k);
  } else {
    const k = smoothstep(0.5, 1, t);
    out[0] = mix(mid[0], hot[0], k);
    out[1] = mix(mid[1], hot[1], k);
    out[2] = mix(mid[2], hot[2], k);
  }
}

export class Terrain {
  readonly seed: string;
  private nContinent: Noise2D;
  private nErosion: Noise2D;
  private nRidge: Noise2D;
  private nHill: Noise2D;
  private nDetail: Noise2D;
  private nLake: Noise2D;
  private nMoisture: Noise2D;
  private nTemperature: Noise2D;

  constructor(seed: string) {
    this.seed = seed;
    const [a, b, c, d] = hashSeed(seed);
    this.nContinent = new Noise2D(a);
    this.nErosion = new Noise2D(b);
    this.nRidge = new Noise2D(c);
    this.nHill = new Noise2D(d);
    this.nDetail = new Noise2D((a ^ 0x9e3779b9) >>> 0);
    this.nLake = new Noise2D((b ^ 0x85ebca6b) >>> 0);
    this.nMoisture = new Noise2D((c ^ 0xc2b2ae35) >>> 0);
    this.nTemperature = new Noise2D((d ^ 0x27d4eb2f) >>> 0);
  }

  /** 陸らしさ 0..1。島と外洋の骨格。 */
  private landAt(x: number, z: number): number {
    const c = fbm(this.nContinent, x, z, 5, 0.00035);
    return smoothstep(-0.06, 0.26, c);
  }

  /** 平坦さ 0..1。低いほど山がちになる。 */
  private flatnessAt(x: number, z: number): number {
    const e = fbm(this.nErosion, x, z, 3, 0.0007) * 0.5 + 0.5;
    return smoothstep(0.18, 0.74, e);
  }

  moistureAt(x: number, z: number): number {
    return clamp(fbm(this.nMoisture, x, z, 3, 0.0009) * 0.5 + 0.5, 0, 1);
  }

  /**
   * 気温 0..1（0 が寒い、1 が暑い）。気候帯を分ける 3 本目の軸。
   * 湿り気より粗いノイズにして、気候帯を大きく取る（歩いてしばらくで変わる）。
   * 標高が上がるほど冷える。おかげで暑い地方でも高い山の上は雪になる。
   */
  temperatureAt(x: number, z: number, h: number): number {
    // 振れ幅 0.75。0.5 だと温帯に寄りすぎて砂漠や雪にほぼ出会えなかった。
    // これで寒・暑が各 1 割ほど現れつつ、温帯が過半を保つ。
    const base = clamp(fbm(this.nTemperature, x, z, 3, 0.0006) * 0.75 + 0.5, 0, 1);
    // 標高による冷え込み。海抜 8m から効き始め、120m 上がると 0.6 下がる。
    const lapse = Math.max(0, h - 8) * 0.005;
    return clamp(base - lapse, 0, 1);
  }

  /**
   * 標高。海面は 0。
   * 大陸 → 侵食（平原か山か） → 尾根 → 丘 → 細部 → 湖のくぼみ、の順に積む。
   */
  heightAt(x: number, z: number): number {
    const land = this.landAt(x, z);
    const flat = this.flatnessAt(x, z);

    // 海底は緩やかに深く、陸は海面より少し上から始まる。
    const base = mix(-34, 7, land);

    // 山: 平坦でない場所ほど、かつ大陸の内側ほど高く伸びる。
    const r = ridged(this.nRidge, x, z, 5, 0.0011);
    const mountain = Math.pow(r, 1.9) * Math.pow(1 - flat, 1.5) * Math.pow(land, 1.6) * 135;

    // 丘: 平原にも軽い起伏を残す（真っ平らは退屈なので）。
    const hill = fbm(this.nHill, x, z, 4, 0.0045) * 10 * land * mix(1.0, 0.45, flat);

    // 細部: ローポリの面が単調にならない程度に。
    const detail = fbm(this.nDetail, x, z, 3, 0.019) * 1.8 * land;

    // 湖: 平らな低地にだけ、なめらかな盆地を掘る。掘った底が海面下なら水が入る。
    const lk = fbm(this.nLake, x, z, 3, 0.0013) * 0.5 + 0.5;
    const lakeMask = smoothstep(0.63, 0.88, lk) * flat * land;
    const lake = lakeMask * 22;

    return base + mountain + hill + detail - lake;
  }

  /**
   * チャンクメッシュと同じ三角形分割で標高を補間する。
   * プレイヤーの足元が見た目の地面とズレないようにするため。
   */
  heightOnGrid(x: number, z: number, step: number): number {
    const x0 = Math.floor(x / step) * step;
    const z0 = Math.floor(z / step) * step;
    const u = (x - x0) / step;
    const v = (z - z0) / step;

    const h00 = this.heightAt(x0, z0);
    const h11 = this.heightAt(x0 + step, z0 + step);
    if (v >= u) {
      const h01 = this.heightAt(x0, z0 + step);
      return h00 * (1 - v) + h01 * (v - u) + h11 * u;
    }
    const h10 = this.heightAt(x0 + step, z0);
    return h00 * (1 - u) + h10 * (u - v) + h11 * v;
  }

  /**
   * 面の色。気温 × 湿り気で気候帯が決まり、そこへ標高・傾きの効果を重ねる。
   * out に 0..1 のリニア RGB を書き込む。
   */
  shade(h: number, slope: number, temp: number, moisture: number, out: Float32Array, o: number): void {
    // 岩肌: 急斜面ほど、そして高所ほど土が乗らない。
    const rocky = clamp(
      smoothstep(0.42, 0.72, slope) + smoothstep(52, 88, h) * 0.75,
      0,
      1,
    );

    // 気候帯の地面色。まず乾いた側と湿った側を気温で作り、湿り気で混ぜる。
    ramp3(C_TUNDRA, C_GRASS_DRY, C_DESERT, temp, DRY);
    ramp3(C_SNOW, C_FOREST, C_JUNGLE, temp, WET);
    const wetness = smoothstep(0.35, 0.68, moisture);
    let r = mix(DRY[0], WET[0], wetness);
    let g = mix(DRY[1], WET[1], wetness);
    let b = mix(DRY[2], WET[2], wetness);

    // 浜辺: どの気候でも水際は砂に寄る。
    const beach = 1 - smoothstep(1.2, 4.5, h);
    r = mix(r, C_SAND[0], beach);
    g = mix(g, C_SAND[1], beach);
    b = mix(b, C_SAND[2], beach);

    // 水中: 見えるのは浅瀬だけだが、透けたときに砂が続くと自然。
    const under = smoothstep(-1.5, -9, h);
    r = mix(r, C_SEABED[0], under);
    g = mix(g, C_SEABED[1], under);
    b = mix(b, C_SEABED[2], under);

    // 岩。高いところほど暗く冷たい灰に。
    const rockMix = smoothstep(40, 80, h);
    const rr = mix(C_ROCK[0], C_ROCK_DARK[0], rockMix);
    const rg = mix(C_ROCK[1], C_ROCK_DARK[1], rockMix);
    const rb = mix(C_ROCK[2], C_ROCK_DARK[2], rockMix);
    r = mix(r, rr, rocky);
    g = mix(g, rg, rocky);
    b = mix(b, rb, rocky);

    // 雪: 十分に寒く、あまり急でない面に積もる。気温は標高でも下がるので、
    //     暑い地方でも高い山の頂は白くなる。
    const snow = smoothstep(0.22, 0.08, temp) * (1 - smoothstep(0.55, 0.85, slope));
    r = mix(r, C_SNOW[0], snow);
    g = mix(g, C_SNOW[1], snow);
    b = mix(b, C_SNOW[2], snow);

    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
  }
}
