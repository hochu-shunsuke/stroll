import { hashSeed } from '../core/rng';
import { Climate } from './climate';
import {
  LAKE_DEPTH,
  type LakeCell,
  type LakeHit,
  NO_LAKE,
  RIM_HEIGHT,
  lakeCellAt,
  lakeCellOf,
  lakeShapeAt,
} from './lake';
import { mix, Noise2D, smoothstep } from './noise';
import { type SpecialHit, specialAt } from './special';
import { shadeTerrain } from './surfaceShade';
import { TerrainShape } from './terrainShape';

export const SEA_LEVEL = 0;

/** 湖の底を海面からどれだけ上に保つか（m）。 */
const LAKE_BED_MIN = 0.6;
/** 湖の水面が海面よりこれだけ高くないと作らない（m）。 */
const LAKE_MIN_ABOVE_SEA = 2.0;

export { STEEPEST_SHORE } from './lake';
export {
  STEEPEST_LANDFORM_SLOPE,
  STEEPEST_RIVER_BANK,
} from './terrainShape';

/**
 * 四角形をどちらの対角線で 2 つの三角形に割るか。true なら h00-h11。
 *
 * chunk.ts と heightOnGrid は必ずこの同じ関数を使う。高低差が小さい方を
 * 選ぶことで遠景の山肌に同じ向きの斜め縞が出るのを防ぐ。
 */
export function splitsAlongMainDiagonal(
  h00: number,
  h10: number,
  h01: number,
  h11: number,
): boolean {
  return Math.abs(h00 - h11) <= Math.abs(h01 - h10);
}

/**
 * ワールド生成の公開窓口。
 *
 * 標高骨格・気候・表面色の実装は別モジュールへ分けるが、描画・植生・プレイヤーは
 * この facade だけを見る。外向きの API と、同じシードから同じ景色が出る保証を
 * 保ったまま内部を変更できるようにする。
 */
export class Terrain {
  readonly seed: string;
  private readonly shape: TerrainShape;
  private readonly climate: Climate;
  private readonly nLakeEdge: Noise2D;
  /** 区画ごとの湖の記憶。判定が重いので使い回す。 */
  private readonly lakeCells = new Map<string, LakeCell | null>();
  private readonly lakeSalt: number;
  private readonly nSpecialEdge: Noise2D;
  private readonly specialSalt: number;

  constructor(seed: string) {
    this.seed = seed;
    const [a, b, c, d] = hashSeed(seed);
    this.shape = new TerrainShape(a, b, c, d);
    this.climate = new Climate(a, b, c, d, this.shape.massAt);
    this.nLakeEdge = new Noise2D((c ^ 0x3b9aca07) >>> 0);
    // 区画抽選にもシードを混ぜる。忘れると全世界で同じ位置になる。
    this.lakeSalt = (a ^ 0x5bd1e995) >>> 0;
    this.nSpecialEdge = new Noise2D((a ^ 0x165667b1) >>> 0);
    this.specialSalt = (b ^ 0x9e3779b1) >>> 0;
  }

  /** 宝物区画の判定。詳しくは special.ts。 */
  specialAt(x: number, z: number): SpecialHit {
    return specialAt(x, z, this.nSpecialEdge, this.specialSalt);
  }

  /** 森のかたまり 0..1.4。植生の密度に掛ける。 */
  groveAt(x: number, z: number): number {
    return this.climate.groveAt(x, z);
  }

  /** 湿り気 0..1。独立ノイズへ山塊による雨陰を重ねる。 */
  moistureAt(x: number, z: number): number {
    return this.climate.moistureAt(x, z);
  }

  /** 気温 0..1（0 が寒い、1 が暑い）。標高が上がるほど冷える。 */
  temperatureAt(x: number, z: number, h: number): number {
    return this.climate.temperatureAt(x, z, h);
  }

  /**
   * 湖の判定。重い区画抽選と水面の高さは区画ごとに一度だけ計算して記憶する。
   */
  private lakeHit(x: number, z: number): LakeHit {
    const [cx, cz] = lakeCellOf(x, z);
    const key = `${cx},${cz}`;
    let cell = this.lakeCells.get(key);
    if (cell === undefined) {
      cell = lakeCellAt(
        cx,
        cz,
        this.shape.continentNoise,
        this.shape.erosionNoise,
        this.lakeSalt,
        this.shape.baseHeightAt,
        this.shape.heightAt,
      );
      // 際限なく溜めない。区画は 1,450m 四方なので、この頃には遠方しか残らない。
      if (this.lakeCells.size > 2048) this.lakeCells.clear();
      this.lakeCells.set(key, cell);
    }
    // 海面すれすれでは海の板と重なって二重になるため湖を作らない。
    if (cell === null || cell.level <= SEA_LEVEL + LAKE_MIN_ABOVE_SEA) return NO_LAKE;
    return lakeShapeAt(x, z, cell, this.nLakeEdge);
  }

  /**
   * その地点の内陸水面。水が無ければ -Infinity。
   * 外洋は render/water.ts の一枚板が担当する。
   */
  waterLevelAt(x: number, z: number): number {
    const lake = this.lakeHit(x, z);
    if (lake.strength <= 0) return -Infinity;
    return lake.level;
  }

  /**
   * 標高。海面は 0。TerrainShape の地形骨格へ、水平な内陸湖を重ねる。
   */
  heightAt(x: number, z: number): number {
    let h = this.shape.heightAt(x, z);

    const lake = this.lakeHit(x, z);
    if (lake.strength > 0) {
      // 湖の内側は水際で水面と一致し、中心へ向かって一定深さまで下がる。
      // 海の板が湖底から見えないよう、底は海面より上に保つ。
      h = Math.max(SEA_LEVEL + LAKE_BED_MIN, lake.level - LAKE_DEPTH * lake.strength);
    } else if (lake.rim > 0) {
      // rim を裏返した out は水際で 0、帯の外で 1。
      const out = 1 - lake.rim;
      const wall = lake.level + RIM_HEIGHT * smoothstep(0, 0.5, out);

      // 水際側では溢れ止めを保ち、帯の外へ向かって滑らかに自然地形へ戻す。
      // 全幅で Math.max(h, wall) すると帯の端に高さの不連続ができる。
      const guard = Math.max(0, wall - h) * (1 - smoothstep(0.45, 1, out));
      h = mix(wall, h + guard, smoothstep(0.1, 0.6, out));
    }
    return h;
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
    const h10 = this.heightAt(x0 + step, z0);
    const h01 = this.heightAt(x0, z0 + step);
    const h11 = this.heightAt(x0 + step, z0 + step);

    if (splitsAlongMainDiagonal(h00, h10, h01, h11)) {
      if (v >= u) return h00 * (1 - v) + h01 * (v - u) + h11 * u;
      return h00 * (1 - u) + h10 * (u - v) + h11 * v;
    }
    if (u + v <= 1) return h00 * (1 - u - v) + h01 * v + h10 * u;
    return h01 * (1 - u) + h10 * (1 - v) + h11 * (u + v - 1);
  }

  /**
   * 面の色。気温 × 湿り気へ標高・傾き・特殊区画の効果を重ねる。
   * out に 0..1 のリニア RGB を書き込む。
   */
  shade(
    h: number,
    slope: number,
    temp: number,
    moisture: number,
    special: SpecialHit,
    out: Float32Array,
    o: number,
  ): void {
    shadeTerrain(h, slope, temp, moisture, special, out, o);
  }
}
