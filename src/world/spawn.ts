import { hasTallVegetationNear } from './scatter';
import type { Terrain } from './terrain';

/**
 * 歩き出すのに気持ちのいい場所を探す。
 * 海の真ん中や崖の上から始まると、それだけで台無しになるので。
 */
export function findSpawn(terrain: Terrain): { x: number; z: number } {
  const check = (
    x: number,
    z: number,
    minMoist: number,
    requireInland: boolean,
    requireTemperate: boolean,
  ) => {
    const h = terrain.heightAt(x, z);
    if (h < 4 || h > 26) return false;
    // heightAt は湖の中では湖底を返す。浅く平らな湖底は安全な低地に見えるため、
    // 標高だけでなく内陸水面の有無を明示的に調べる。
    if (Number.isFinite(terrain.waterLevelAt(x, z))) return false;
    const d = 3;
    const dx = (terrain.heightAt(x + d, z) - h) / d;
    const dz = (terrain.heightAt(x, z + d) - h) / d;
    if (Math.hypot(dx, dz) > 0.35) return false;
    if (terrain.moistureAt(x, z) < minMoist) return false;
    if (requireTemperate) {
      const temp = terrain.temperatureAt(x, z, h);
      if (temp < 0.3 || temp > 0.72) return false;
    }

    // 最初の景色が海岸だと、陸が大きくても「小島」に感じる。
    // 候補が見つかったときだけ周囲を粗く調べ、約 600m の範囲に海が無い所を優先する。
    // 全探索点で調べると起動時の heightAt が増えすぎるので、安い条件を全部通った後に置く。
    if (requireInland) {
      const radius = 600;
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2;
        if (terrain.heightAt(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius) < 0) {
          return false;
        }
      }
    }
    // 木の中から始まると、世界の広がりより幹と樹冠が先に画面を埋める。
    // 本番の植生配置と同じ判定で、小さな空き地を選ぶ。
    if (hasTallVegetationNear(terrain, x, z, 14)) return false;
    return true;
  };

  // まず「海から離れた、緑があって平らな低地」を探す。
  // その世界に無ければ、海からの距離→湿り気の順に条件を緩める。
  for (const [minMoist, requireInland, requireTemperate] of [
    [0.45, true, true],
    [0.0, true, true],
    [0.45, true, false],
    [0.0, true, false],
    [0.45, false, false],
    [0.0, false, false],
  ] as const) {
    for (let r = 0; r < 7000; r += 44) {
      for (let a = 0; a < 24; a++) {
        const ang = (a / 24) * Math.PI * 2 + r * 0.011;
        const x = Math.cos(ang) * r;
        const z = Math.sin(ang) * r;
        if (check(x, z, minMoist, requireInland, requireTemperate)) return { x, z };
      }
    }
  }
  return { x: 0, z: 0 };
}
