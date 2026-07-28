import { Noise2D, clamp, fbm, smoothstep } from './noise';

/**
 * 湿り気を引く格子の間隔（m）。CHUNK_SIZE を割り切ること。
 *
 * 湿り気は雨陰の計算を含むので重い。地形と植生はこの同じ間隔で格子を作り、
 * その間を線形補間する。1 か所に置くことで両者の解像度がずれないようにする。
 */
export const CLIMATE_STEP = 24;

// 雨陰は、風上を直線で調べて一番高い障害を探すことで作る。heightAt は
// 重すぎるため、呼び側が渡す粗い山塊（massAt）だけを見る。
const RAIN_SAMPLES = 7;
const RAIN_STEP = 260;
const RAIN_LOW = 18;
const RAIN_HIGH = 64;
const RAIN_STRENGTH = 0.5;

/** 森のかたまりの下限と振れ幅。下限 + 振れ幅/2 が 1.0 になるように取る。 */
const GROVE_FLOOR = 0.42;
const GROVE_RANGE = 1.18;

export type MassAt = (x: number, z: number) => number;

/**
 * ワールドの気温・湿り気・森のまとまりを担当する。
 *
 * 標高の詳細は知らず、雨陰に必要な粗い山塊だけを massAt 経由で受け取る。
 */
export class Climate {
  private readonly nGrove: Noise2D;
  private readonly nMoisture: Noise2D;
  private readonly nTemperature: Noise2D;
  private readonly windX: number;
  private readonly windZ: number;
  private readonly massAt: MassAt;

  constructor(a: number, b: number, c: number, d: number, massAt: MassAt) {
    this.nGrove = new Noise2D((b ^ 0x2545f491) >>> 0);
    this.nMoisture = new Noise2D((c ^ 0xc2b2ae35) >>> 0);
    this.nTemperature = new Noise2D((d ^ 0x27d4eb2f) >>> 0);
    this.massAt = massAt;

    // 卓越風の向き。世界ごとに変わるので、どちら側が乾くかもシード次第になる。
    const windAngle = (((a ^ 0x1b873593) >>> 0) / 0x100000000) * Math.PI * 2;
    this.windX = Math.cos(windAngle);
    this.windZ = Math.sin(windAngle);
  }

  /** 雨陰の強さ 0..1。1 に近いほど乾く。 */
  private rainShadowAt(x: number, z: number): number {
    // 効くのは山の絶対の高さではなく「自分よりどれだけ高いか」。
    const here = this.massAt(x, z);
    let worst = 0;
    for (let i = 1; i <= RAIN_SAMPLES; i++) {
      const d = i * RAIN_STEP;
      const m = this.massAt(x - this.windX * d, z - this.windZ * d);
      const reach = 1 - (i - 1) / RAIN_SAMPLES;
      const blocked = smoothstep(RAIN_LOW, RAIN_HIGH, m - here) * reach;
      if (blocked > worst) worst = blocked;
    }
    return worst;
  }

  /** 森のかたまり 0..1.4。植生の密度に掛ける。 */
  groveAt(x: number, z: number): number {
    const n = fbm(this.nGrove, x, z, 2, 0.009) * 0.5 + 0.5;
    return GROVE_FLOOR + smoothstep(0.28, 0.74, n) * GROVE_RANGE;
  }

  /** 湿り気 0..1。ノイズに雨陰を重ねる。 */
  moistureAt(x: number, z: number): number {
    const base = fbm(this.nMoisture, x, z, 3, 0.0009) * 0.5 + 0.5;
    return clamp(base - this.rainShadowAt(x, z) * RAIN_STRENGTH, 0, 1);
  }

  /** 気温 0..1（0 が寒い、1 が暑い）。標高が上がるほど冷える。 */
  temperatureAt(x: number, z: number, h: number): number {
    const base = clamp(fbm(this.nTemperature, x, z, 3, 0.0006) * 0.75 + 0.5, 0, 1);
    const lapse = Math.max(0, h - 8) * 0.006;
    return clamp(base - lapse, 0, 1);
  }
}
