import { hash2 } from '../core/rng';
import { Noise2D, fbm, mix, smoothstep, spline } from './noise';

/**
 * 内陸の湖。
 *
 * **なぜ湖はできて、川はできなかったのか。**
 * 水面は「その場所の水面の高さ」を返す純粋関数でなければならない。川は水面が
 * 流れに沿って下がる必要があるが、地形は排水路ではないので、川筋に沿った高さが
 * 上下してしまう（実測で川筋方向に ±60m で 7.0m）。中心線に射影しても直らなかった。
 *
 * **湖は水面が区画ごとに 1 つの定数なので、定義上かならず水平になる。**
 * 宝物・台地と同じ「升目で抽選して円形の区画を作る」機構がそのまま使える。
 *
 * 水面の高さは、その区画の中心での**大陸度スプラインの値**から決める。
 * heightAt をそこで呼ぶと再帰するし、局所の高さを使うと水面が傾く。
 * 大陸度は波長 2,900m でゆっくり変わるので、区画の中心で 1 度引けば足りる。
 *
 * **平らな地方にしか作らないこと。** 起伏の大きい所に置くと、湖の縁より
 * 外の地面の方が低くなり、水が縁から溢れて宙に浮いて見える。
 */

export interface LakeHit {
  /** 湖の中の度合い。中心で 1、水際で 0。 */
  strength: number;
  /**
   * 水際のすぐ外側の度合い。1 が水際、外へ向かって 0 になる。
   *
   * **ここで地面を水面より上へ持ち上げないと水が溢れる。** 湖を「掘る」だけだと、
   * 周りの地面が水面より低い場合に水が宙に浮いて見える（実測で 53.7% がそうなった）。
   * 現実の湖にも必ず縁がある。
   */
  rim: number;
  /** 水面の高さ（m）。区画ごとに 1 つの定数なので必ず水平。 */
  level: number;
}

export const NO_LAKE: LakeHit = { strength: 0, rim: 0, level: -Infinity };

/** 抽選に使う升目（メートル）。 */
const CELL = 1450;
/** 升目が湖を持つ確率。 */
const RARITY = 0.34;
/** 湖の半径（升目に対する割合）。 */
const RADIUS_MIN = 0.1;
const RADIUS_MAX = 0.19;
/** 縁を波打たせる強さと細かさ。細かく振ると岸が急になるので控えめに。 */
const WOBBLE = 0.2;
const WOBBLE_FREQ = 0.0021;
/** 岸の帯の幅（m）。ここで水面から周りの地面へ上がる。 */
export const SHORE_WIDTH = 46;
/** 水際の外側で、地面を持ち上げる帯の幅（m）。 */
const RIM_WIDTH = 70;
/** 縁を水面よりどれだけ高くするか（m）。 */
export const RIM_HEIGHT = 2.2;
/** 水面を周りの基準の高さからどれだけ下げるか。 */
const SINK = 5.5;
/** 湖の一番深いところの深さ。 */
export const LAKE_DEPTH = 7.5;
/** 中心の実地形が水面からこれ以上離れていたら作らない（m）。 */
const LEVEL_TOLERANCE = 9;

/**
 * 岸のいちばん急なところの傾き。
 * `1.5` は smoothstep の最大傾斜が平均の 1.5 倍だから。
 * 台地の縁と川岸で 2 回この項を忘れて崖を作っている。
 */
export const STEEPEST_SHORE = (1.5 * (RIM_HEIGHT + LAKE_DEPTH)) / SHORE_WIDTH;

/** 抽選に当たった区画の湖。区画ごとに 1 度だけ決めればよいもの。 */
export interface LakeCell {
  centerX: number;
  centerZ: number;
  radius: number;
  /** 水面の高さ。区画で 1 つの定数なので、湖は必ず水平になる。 */
  level: number;
}

/** 座標から湖の区画番号を出す。呼び側がここを見て記憶する。 */
export function lakeCellOf(x: number, z: number): [number, number] {
  return [Math.floor(x / CELL), Math.floor(z / CELL)];
}

/**
 * 区画に湖があるか、あるならどこにどの高さで。
 *
 * **重い判定はここに全部集めてある**（地形を 1 回引く）。区画あたり 1 度だけ
 * 呼べばよいので、呼び側が結果を記憶すること。点ごとに呼ぶと、湖のある
 * チャンクだけ生成が 2〜3 倍になる（一度これで壊した）。
 *
 * @param baseSpline 大陸度 → 基準の高さ のスプライン（terrain.ts から渡す）。
 *   湖側で高さの決め方を持たないことで、地形の設定変更が水面にも自動で効く。
 * @param groundAt 湖を入れる前の地面の高さ。
 */
export function lakeCellAt(
  cx: number,
  cz: number,
  contNoise: Noise2D,
  eroNoise: Noise2D,
  seedSalt: number,
  baseSpline: readonly (readonly [number, number])[],
  groundAt: (x: number, z: number) => number,
): LakeCell | null {
  const s1 = (0x6d2b79f5 ^ seedSalt) >>> 0;
  if (hash2(cx, cz, s1) >= RARITY) return null;

  const centerX = (cx + 0.28 + hash2(cx, cz, (s1 + 1) >>> 0) * 0.44) * CELL;
  const centerZ = (cz + 0.28 + hash2(cx, cz, (s1 + 2) >>> 0) * 0.44) * CELL;

  // **平らな地方にしか作らない。** 起伏の大きい所に置くと、湖の縁より外の
  // 地面の方が低くなり、水が溢れて宙に浮いて見える。
  // 点ごとに判定すると湖の中で強さがばらついて縁が閉じない（実測で 58% が漏れた）。
  const eroAtCenter = fbm(eroNoise, centerX, centerZ, 3, 0.0011);
  if (smoothstep(-0.02, 0.3, eroAtCenter) < 0.5) return null;

  const contAtCenter = fbm(contNoise, centerX, centerZ, 3, 0.00035);
  const level = spline(baseSpline, contAtCenter) - SINK;

  // **基準の高さと実際の地形が離れている所には作らない。**
  // ずれていると湖が斜面や台地の縁に乗って、片側だけ水が溢れる
  // （実測で 7% の湖が高所の斜面でそうなった）。
  if (Math.abs(groundAt(centerX, centerZ) - level) > LEVEL_TOLERANCE) return null;

  const radius = CELL * mix(RADIUS_MIN, RADIUS_MAX, hash2(cx, cz, (s1 + 3) >>> 0));
  return { centerX, centerZ, radius, level };
}

/** その地点が湖のどこに当たるか。区画が分かっていれば安い（ノイズ 1 回）。 */
export function lakeShapeAt(x: number, z: number, cell: LakeCell, edgeNoise: Noise2D): LakeHit {
  const d = Math.hypot(x - cell.centerX, z - cell.centerZ);
  const edge = cell.radius * (1 + WOBBLE * edgeNoise.noise(x * WOBBLE_FREQ, z * WOBBLE_FREQ));
  if (d >= edge + RIM_WIDTH) return NO_LAKE;
  const strength = smoothstep(edge, edge - SHORE_WIDTH, d);
  const rim = smoothstep(edge + RIM_WIDTH, edge, d);
  if (strength <= 0 && rim <= 0) return NO_LAKE;
  return { strength, rim, level: cell.level };
}
