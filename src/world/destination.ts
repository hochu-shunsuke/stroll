import { hashSeed } from '../core/rng';
import type { Terrain } from './terrain';

export const DESTINATION_DISTANCE = 12_000;
export const DESTINATION_RING_RADIUS = 48;
export const DESTINATION_CLEARANCE = 62;

export interface Destination {
  x: number;
  y: number;
  z: number;
  groundY: number;
  distance: number;
}

/**
 * 同じ合言葉なら全員に同じ光の輪を置く。
 *
 * 開始地点からの距離は変えず、円周上の候補から陸の高所を選ぶ。
 * ゴール専用の保存値を持たないため、世界の再現性とURL共有を壊さない。
 */
export function findDestination(
  terrain: Terrain,
  seed: string,
  spawn: { x: number; z: number },
): Destination {
  const offset =
    (hashSeed(`${seed}:light-ring`)[0] / 4_294_967_296) * Math.PI * 2;
  let best: { x: number; z: number; groundY: number; score: number } | null = null;

  for (let i = 0; i < 32; i++) {
    const angle = offset + (i / 32) * Math.PI * 2;
    const x = spawn.x + Math.sin(angle) * DESTINATION_DISTANCE;
    const z = spawn.z + Math.cos(angle) * DESTINATION_DISTANCE;
    const groundY = terrain.heightAt(x, z);
    const water = Number.isFinite(terrain.waterLevelAt(x, z));

    // 高所は遠くから目印になりやすい。ただし極端な峰だけを選ばず、
    // 4方向の周辺地形も高い「山体・丘陵」を少し優先する。
    const sampleRadius = 140;
    const surrounding =
      (terrain.heightAt(x + sampleRadius, z) +
        terrain.heightAt(x - sampleRadius, z) +
        terrain.heightAt(x, z + sampleRadius) +
        terrain.heightAt(x, z - sampleRadius)) /
      4;
    const broadHeight = Math.min(190, Math.max(0, (groundY + surrounding) / 2));
    const landScore = !water && groundY > 4 ? 1_000 : 0;
    const score =
      landScore +
      broadHeight * 2 -
      Math.max(0, groundY - 240) * 3 -
      Math.max(0, groundY - surrounding) * 0.25;

    if (!best || score > best.score) best = { x, z, groundY, score };
  }

  // 候補は必ず1つ以上ある。
  const selected = best!;
  return {
    x: selected.x,
    y: Math.max(86, selected.groundY + DESTINATION_CLEARANCE),
    z: selected.z,
    groundY: selected.groundY,
    distance: DESTINATION_DISTANCE,
  };
}
