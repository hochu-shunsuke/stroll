/**
 * 地形の種類（landform）。
 *
 * 気候（色と植生を選ぶ）や宝物（色と植生を上書きする）と同じく (x,z) とシードの
 * 純粋関数だが、これだけは **標高そのもの** を変える。
 *
 * なぜ要るか:
 * heightAt() は世界中で 1 つの式だった。つまみは大陸ノイズと侵食ノイズの 2 つだけで、
 * 高さの源が尾根ノイズしかない。尾根は定義上、峰が尖る。つまり
 * **「高い」が必ず「急」とセットになる。**
 * 実測すると「標高 20〜50m で なだらか」な場所は陸の 0.1% しかなく、
 * 高いところに立って見下ろす体験が世界に存在しなかった。
 * 塗り（気候・宝物）は場所ごとに変わるのに、骨格だけが世界中で同じだった。
 *
 * 種類を増やす手順:
 *   ① LANDFORM_RARITY に出やすさを 1 つ足す（添字が種類の番号になる）
 *   ② terrain.ts の heightAt にその種類の高さを書く
 *
 * **予算の急所**: heightAt は 1 チャンクあたり約 9,400 回呼ばれる。
 * 種類を全部評価すると生成が種類の数だけ重くなる。
 * ある地点は 1 つの種類にだけ属し、縁で強さが 0 に落ちる形にしてあるので、
 * 評価すべき高さの式は常に 1 つで済む。**この性質を壊さないこと。**
 */

import { hash2 } from '../core/rng';
import { Noise2D, mix, smoothstep } from './noise';

/** 台地。高くて平らな天面と、急な縁を持つ。 */
export const LF_PLATEAU = 0;

/**
 * 種類ごとの出やすさ。添字が種類の番号（LF_*）。
 * 合計が「升目が特別な地形になる割合」。1.0 にすると平原が消える。
 */
const LANDFORM_RARITY = [0.42];

export interface LandformHit {
  /** LANDFORM_RARITY の添字（LF_*）。ふつうの地形なら -1。 */
  index: number;
  /** 中心からの距離（メートル）。 */
  dist: number;
  /** 縁の位置（中心からの距離、メートル）。dist < edge の内側だけが区画。 */
  edge: number;
  /** 陸らしさ 0..1。海岸で 0 に落ちる。強さに掛けること。 */
  onLand: number;
  /** その区画ごとに決まる乱数 0..1。高さの振れ幅などに使う。 */
  variant: number;
}

export const NO_LANDFORM: LandformHit = {
  index: -1,
  dist: 0,
  edge: 0,
  onLand: 0,
  variant: 0,
};

/**
 * 抽選に使う升目（メートル）。
 * 台地どうしの間隔はおよそ `CELL / sqrt(出やすさの合計)`。
 * 広げすぎると歩いても出会えず、詰めすぎると台地だらけで平原が特別でなくなる。
 */
const CELL = 1250;

/** 区画の半径は CELL のこの割合。 */
const RADIUS_MIN = 0.19;
const RADIUS_MAX = 0.30;

/** 縁を波打たせる強さ（半径に対する割合）と、その細かさ。 */
const WOBBLE = 0.18;
const WOBBLE_FREQ = 0.0016;

/**
 * 縁の帯の**基準**の幅（メートル）。落差が PLATEAU_RISE_MAX のときの幅。
 *
 * **実際の幅は terrain.ts が落差に比例させて広げる。** 幅を固定していた頃は、
 * 落差が想定の 38m を超えた 30% の縁が全部そのぶん急になり、最大 116m の
 * 落差が 72m の帯に押し込まれて壁になっていた。
 * 幅を落差に比例させると、落差が何メートルでも縁の傾きは一定になる。
 */
export const EDGE_WIDTH = 72;

/** 縁の幅を広げてよい上限の倍率。これ以上は落差そのものを抑える。 */
export const EDGE_WIDEN_MAX = 2.4;

/**
 * 縁の位置そのものが、歩くにつれてずれる速さ。
 *
 * **ここを勘定に入れ忘れると縁が想定より急になる（実際に踏んだ）。**
 * 縁は `radius * (1 + WOBBLE * noise)` なので、1m 動く間に縁の位置が
 * この割合だけずれる。中心から離れる速さ 1 にこれが上乗せされるため、
 * 縁の傾きは `(1 + EDGE_WOBBLE_RATE)` 倍に急になる。
 *
 * 2.5 は simplex ノイズの勾配の大きさの目安（実測の上側）。
 */
export const EDGE_WOBBLE_RATE = CELL * RADIUS_MAX * WOBBLE * WOBBLE_FREQ * 2.5;

/**
 * その地点の地形の種類。
 *
 * 宝物（special.ts）と同じく、大きな升目ごとに抽選し、当たった升目の中に
 * 円形の区画を作る。縁はノイズで崩して升目の形が透けないようにする。
 *
 * 宝物と違うのは縁の落とし方。宝物は半径に対する割合でなめらかに落とすが、
 * 台地は崖にしたいので **固定幅の帯** で落とす。区画が大きくても崖は急なまま。
 *
 * seedSalt でシードを混ぜる。忘れると全世界で地形の配置が同じになる。
 */
export function landformAt(
  x: number,
  z: number,
  land: number,
  edgeNoise: Noise2D,
  seedSalt: number,
): LandformHit {
  // 海には作らない。陸の縁では弱まり、海岸へなだらかに溶ける。
  const onLand = smoothstep(0.32, 0.72, land);
  if (onLand <= 0) return NO_LANDFORM;

  const cx = Math.floor(x / CELL);
  const cz = Math.floor(z / CELL);
  const s1 = (0x3f7a91c ^ seedSalt) >>> 0;

  // どの種類か（または、ふつうの地形か）。
  const roll = hash2(cx, cz, s1);
  let acc = 0;
  let index = -1;
  for (let i = 0; i < LANDFORM_RARITY.length; i++) {
    acc += LANDFORM_RARITY[i];
    if (roll < acc) {
      index = i;
      break;
    }
  }
  if (index < 0) return NO_LANDFORM;

  // 升目の中で中心をずらす。中央固定だと並びが読める。
  const centerX = (cx + 0.3 + hash2(cx, cz, (s1 + 1) >>> 0) * 0.4) * CELL;
  const centerZ = (cz + 0.3 + hash2(cx, cz, (s1 + 2) >>> 0) * 0.4) * CELL;
  const radius = CELL * mix(RADIUS_MIN, RADIUS_MAX, hash2(cx, cz, (s1 + 3) >>> 0));

  const d = Math.hypot(x - centerX, z - centerZ);
  // 縁を波打たせる。半径をノイズで伸び縮みさせるだけ。
  // 細かく波打たせるほど縁が急になる（EDGE_WOBBLE_RATE 参照）。
  // 輪郭を崩したいだけなので、区画の差し渡しより長い波長でゆっくり振る。
  const edge = radius * (1 + WOBBLE * edgeNoise.noise(x * WOBBLE_FREQ, z * WOBBLE_FREQ));
  // 区画の外。**ここが早期打ち切りの条件**で、縁の帯の幅とは無関係に
  // `d >= edge` だけで決まる。帯を内側へ広げても（terrain.ts が落差に応じて
  // そうする）この判定は変わらない ＝ 予算の前提が壊れない。
  if (d >= edge) return NO_LANDFORM;

  return { index, dist: d, edge, onLand, variant: hash2(cx, cz, (s1 + 4) >>> 0) };
}
