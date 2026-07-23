/**
 * レア区画＝宝物。
 *
 * 気候（気温 × 湿り気）で敷き詰まる普通のバイオームとは別の仕組み。
 * 広い大地にまれにだけ現れ、そこだけ気候を無視して別の景色になる。
 * 実在しない色でも、季節が固定された森でもいい。あると嬉しいものを置く。
 *
 * 宝物を増やすには SPECIAL_BIOMES に 1 行足す。
 *   色の草原 → meadow(名前, 出やすさ, 地面色)
 *   色の森   → forest(名前, 出やすさ, 地面色, 木の種類)   ※木は vegetationKinds に足す
 *   全く別のもの → SpecialBiome を直に書く（型は平たいまま残してある）
 */

import { hash2 } from '../core/rng';
import { Noise2D, smoothstep } from './noise';
import { KIND_AUTUMN, KIND_SAKURA } from './vegetationKinds';

/** sRGB の 16 進を three の作業色空間（リニア）へ。地形と宝物で共有する。 */
export function srgb(hex: number): [number, number, number] {
  const f = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return [f(((hex >> 16) & 255) / 255), f(((hex >> 8) & 255) / 255), f((hex & 255) / 255)];
}

export interface SpecialBiome {
  /** 記録・デバッグ用の名前。 */
  name: string;
  /**
   * 出現しやすさ 0..1。全宝物の合計がおよそ「特別な区画になる割合」。
   * ここを大きくすると宝物が宝物でなくなるので、合計 0.1 未満に抑える。
   */
  rarity: number;
  /** 地面の色（リニア RGB）。気候の地面色をこれで上書きする。 */
  ground: readonly [number, number, number];
  /**
   * 植える木の種類（scatter.ts の KIND_*）。null なら木を出さず、開けたままにする。
   * この区画では普通の植生が引っ込み、これだけが立つ。
   */
  treeKind: number | null;
  /** 木の配置間隔。小さいほど密。 */
  treeSpacing: number;
  /** 木の生えやすさ 0..1。 */
  treeDensity: number;
}

/**
 * 色の木が密に立つ森。地面の色と木を渡すだけで作れる。
 * 秋・桜のような「色づいた林」はこれ。
 */
function forest(name: string, rarity: number, groundHex: number, treeKind: number): SpecialBiome {
  return { name, rarity, ground: srgb(groundHex), treeKind, treeSpacing: 6, treeDensity: 0.9 };
}

/**
 * 木のない、色だけの草原。地面の色を渡すだけ。
 * 青・薄紫のような「非現実の色の大地」はこれ。
 */
function meadow(name: string, rarity: number, groundHex: number): SpecialBiome {
  return { name, rarity, ground: srgb(groundHex), treeKind: null, treeSpacing: 0, treeDensity: 0 };
}

// 宝物の一覧。ここに 1 行足すと宝物が増える。
// 森・草原はヘルパで書けるが、全く別のもの（霧・オブジェクトなど）は
// SpecialBiome を直に書けばよい。型は平たいまま残してある。
export const SPECIAL_BIOMES: SpecialBiome[] = [
  forest('autumn', 0.035, 0x9a7842, KIND_AUTUMN), // 永遠の秋。落ち葉色 × オレンジ金の木
  forest('sakura', 0.03, 0xc9a7b0, KIND_SAKURA), // 桜。淡い桃色 × 桃色の木
  meadow('blue-meadow', 0.02, 0x6f8fb0), // 青い草原
  meadow('violet-meadow', 0.02, 0x9a8fc0), // 薄紫の草原（夕暮れ色）
];

export interface SpecialHit {
  /** SPECIAL_BIOMES の添字。宝物でなければ -1。 */
  index: number;
  /** その場所での宝物の強さ 0..1（中心で 1、外縁で 0）。 */
  strength: number;
}

export const NO_SPECIAL: SpecialHit = { index: -1, strength: 0 };

/** 宝物の抽選に使う大きな升目（メートル）。気候帯よりさらに大きく取る。 */
const CELL = 1600;

/**
 * その地点が宝物区画に入っているか。
 *
 * 大きな升目ごとに抽選し、当たった升目の中に円形の島を作る。
 * 島の縁はノイズで崩して、四角い升目の形が透けないようにする。
 *
 * seedSalt でシードを混ぜる。これを忘れると全世界で宝物の場所が同じになる。
 * edgeNoise（縁を崩す形）も Terrain がシードから作ったものを渡す。
 */
export function specialAt(x: number, z: number, edgeNoise: Noise2D, seedSalt: number): SpecialHit {
  const cx = Math.floor(x / CELL);
  const cz = Math.floor(z / CELL);
  const s1 = (0x51ec1a1 ^ seedSalt) >>> 0;

  // どの宝物か（または、はずれ）。
  const roll = hash2(cx, cz, s1);
  let acc = 0;
  let index = -1;
  for (let i = 0; i < SPECIAL_BIOMES.length; i++) {
    acc += SPECIAL_BIOMES[i].rarity;
    if (roll < acc) {
      index = i;
      break;
    }
  }
  if (index < 0) return NO_SPECIAL;

  // 升目の中で島の中心を少しずらす。升目の中央固定だと並びが読める。
  const centerX = (cx + 0.3 + hash2(cx, cz, (s1 + 1) >>> 0) * 0.4) * CELL;
  const centerZ = (cz + 0.3 + hash2(cx, cz, (s1 + 2) >>> 0) * 0.4) * CELL;
  const radius = CELL * (0.26 + hash2(cx, cz, (s1 + 3) >>> 0) * 0.12);

  const d = Math.hypot(x - centerX, z - centerZ);
  // 縁を波打たせる。半径をノイズで伸び縮みさせるだけ。
  const wobble = 1 + 0.28 * edgeNoise.noise(x * 0.008, z * 0.008);
  const edge = radius * wobble;
  // edge の 0.65 倍より内側で 1、edge で 0。
  const strength = smoothstep(edge, edge * 0.65, d);
  if (strength <= 0) return NO_SPECIAL;

  return { index, strength };
}
