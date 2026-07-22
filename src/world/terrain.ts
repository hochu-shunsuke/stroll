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
const C_GRASS_DRY = srgb(0x9aa76b);
const C_GRASS = srgb(0x7d9862);
const C_FOREST = srgb(0x5c7a51);
const C_ROCK = srgb(0x878175);
const C_ROCK_DARK = srgb(0x6b6760);
const C_SNOW = srgb(0xe6ebee);

export class Terrain {
  readonly seed: string;
  private nContinent: Noise2D;
  private nErosion: Noise2D;
  private nRidge: Noise2D;
  private nHill: Noise2D;
  private nDetail: Noise2D;
  private nLake: Noise2D;
  private nMoisture: Noise2D;

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
   * 面の色。標高・傾き・湿り気で植生が変わる。
   * out に 0..1 のリニア RGB を書き込む。
   */
  shade(h: number, slope: number, moisture: number, out: Float32Array, o: number): void {
    // 岩肌: 急斜面ほど、そして高所ほど土が乗らない。
    const rocky = clamp(
      smoothstep(0.42, 0.72, slope) + smoothstep(52, 88, h) * 0.75,
      0,
      1,
    );

    // 草の色は湿り気で乾いた黄緑〜深い森の緑へ。
    let r = mix(C_GRASS_DRY[0], C_GRASS[0], smoothstep(0.3, 0.62, moisture));
    let g = mix(C_GRASS_DRY[1], C_GRASS[1], smoothstep(0.3, 0.62, moisture));
    let b = mix(C_GRASS_DRY[2], C_GRASS[2], smoothstep(0.3, 0.62, moisture));
    const forest = smoothstep(0.6, 0.85, moisture);
    r = mix(r, C_FOREST[0], forest);
    g = mix(g, C_FOREST[1], forest);
    b = mix(b, C_FOREST[2], forest);

    // 浜辺: 水際は砂に。
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

    // 雪: 高所の、そこまで急でない面に積もる。
    const snow = smoothstep(84, 106, h) * (1 - smoothstep(0.55, 0.85, slope));
    r = mix(r, C_SNOW[0], snow);
    g = mix(g, C_SNOW[1], snow);
    b = mix(b, C_SNOW[2], snow);

    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
  }
}
