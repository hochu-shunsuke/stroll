import { mix, smoothstep } from './noise';
import { SPECIAL_BIOMES, type SpecialHit } from './special';
import {
  KIND_BROADLEAF,
  KIND_BROADLEAF_TALL,
  KIND_BROADLEAF_WIDE,
  KIND_BUSH,
  KIND_DEAD,
  KIND_PALM,
  KIND_PINE,
  KIND_PINE_OLD,
  KIND_PINE_YOUNG,
  KIND_ROCK,
} from './vegetationKinds';

/**
 * place() に渡る文脈。
 *
 * slope と talus は触ると heightAt が 3 回走る。安い判定で先に落とし、
 * 最後に `c.slope` / `c.talus` の形で参照する。分割代入すると遅延評価が消える。
 */
export interface PlaceContext {
  readonly h: number;
  readonly slope: number;
  readonly temp: number;
  readonly moisture: number;
  readonly special: SpecialHit;
  readonly grove: number;
  readonly talus: number;
  readonly r: number;
}

export interface KindSpec {
  /** 候補ごとに選ぶ形。同じ形だけを並べて壁紙にしない。 */
  kinds: number[];
  spacing: number;
  salt: number;
  maxLod: number;
  giantChance?: number;
  blocksSpawn?: boolean;
  /** 宝物専用ならその添字。区画外で地形・気候を引く前に候補を落とす。 */
  specialIndex?: number;
  tint?: readonly [number, number, number];
  /** 置くならスケールを、置かないなら 0 を返す。 */
  place(ctx: PlaceContext): number;
}

/** 巨木の倍率。基準スケールと縦の伸びにも掛かるため、ここだけを大きくしすぎない。 */
export const GIANT_MIN = 1.55;
export const GIANT_MAX = 2.05;
export const DEFAULT_TINT = [1, 1, 1] as const;

/**
 * 値が [lo, hi] の帯に入っているほど 1 に近づく（山なりの窓）。
 */
function band(v: number, lo: number, mid: number, hi: number): number {
  return v < mid ? smoothstep(lo, mid, v) : smoothstep(hi, mid, v);
}

/**
 * 気候で決まる普通の植生。
 * 宝物区画では木が引っ込む（宝物の木に場所を譲る）。岩だけは残す。
 */
const CLIMATE_SPECS: KindSpec[] = [
  {
    // 広葉樹: 温帯〜暖帯の湿った所。寒い地方と砂漠には生えない。
    kinds: [KIND_BROADLEAF, KIND_BROADLEAF_TALL, KIND_BROADLEAF_WIDE],
    spacing: 7,
    salt: 1301,
    maxLod: 1,
    giantChance: 0.012,
    blocksSpawn: true,
    tint: [0.98, 1.08, 0.9],
    place: (c) => {
      if (c.h < 3.2 || c.h > 52) return 0;
      const climate =
        smoothstep(0.34, 0.68, c.moisture) * band(c.temp, 0.4, 0.62, 0.9);
      const density =
        climate *
        c.grove *
        (1 - smoothstep(34, 52, c.h)) *
        0.7 *
        (1 - c.special.strength);
      if (c.r > density) return 0;
      if (c.slope > 0.42) return 0;
      return 0.75 + ((c.r * 977) % 1) * 0.6;
    },
  },
  {
    // 針葉樹: 涼しい所。寒帯や山の中腹を担う。
    kinds: [KIND_PINE, KIND_PINE_YOUNG, KIND_PINE_OLD],
    spacing: 8,
    salt: 4409,
    maxLod: 1,
    giantChance: 0.01,
    blocksSpawn: true,
    tint: [0.86, 1.0, 1.06],
    place: (c) => {
      if (c.h < 6 || c.h > 96) return 0;
      const climate =
        smoothstep(0.22, 0.55, c.moisture) * band(c.temp, 0.12, 0.34, 0.6);
      const density = climate * c.grove * 0.77 * (1 - c.special.strength);
      if (c.r > density) return 0;
      if (c.slope > 0.5) return 0;
      return 0.8 + ((c.r * 613) % 1) * 0.7;
    },
  },
  {
    // 椰子: 暑く湿った低地。林と空き地をはっきり分ける。
    kinds: [KIND_PALM],
    spacing: 13,
    salt: 5519,
    maxLod: 1,
    giantChance: 0.006,
    blocksSpawn: true,
    tint: [0.95, 1.1, 0.82],
    place: (c) => {
      if (c.h < 2.8 || c.h > 42) return 0;
      const heat = smoothstep(0.62, 0.82, c.temp);
      const wet = smoothstep(0.44, 0.7, c.moisture);
      const clump = mix(0.14, 1.25, smoothstep(0.68, 1.32, c.grove));
      const density = heat * wet * clump * 0.42 * (1 - c.special.strength);
      if (c.r > density) return 0;
      if (c.slope > 0.38) return 0;
      return 0.78 + ((c.r * 419) % 1) * 0.48;
    },
  },
  {
    // 枯れ木: 暑く乾いた草原〜砂漠。
    kinds: [KIND_DEAD],
    spacing: 18,
    salt: 6323,
    maxLod: 1,
    blocksSpawn: true,
    tint: [1.08, 0.98, 0.78],
    place: (c) => {
      if (c.h < 2.8 || c.h > 64) return 0;
      const heat = smoothstep(0.52, 0.78, c.temp);
      const dry = 1 - smoothstep(0.13, 0.34, c.moisture);
      const density = heat * dry * 0.3 * (1 - c.special.strength);
      if (c.r > density) return 0;
      if (c.slope > 0.44) return 0;
      return 0.72 + ((c.r * 733) % 1) * 0.55;
    },
  },
  {
    // 岩: 崖の面ではなく、上の崖から落ちて傾きが緩んだ所へ溜める。
    kinds: [KIND_ROCK],
    spacing: 17,
    salt: 7717,
    maxLod: 1,
    tint: [1.02, 1, 0.96],
    place: (c) => {
      if (c.h < 1.0) return 0;
      if (c.r > 0.75) return 0;
      const pile =
        smoothstep(0.5, 1.4, c.talus) *
        (1 - smoothstep(0.45, 0.85, c.slope));
      const density =
        (0.05 + pile * 0.75 + smoothstep(50, 90, c.h) * 0.2) * 0.75;
      if (c.r > density) return 0;
      return 0.6 + ((c.r * 331) % 1) * 2.4;
    },
  },
  {
    // 低木: 暖かく湿った所の下草。
    kinds: [KIND_BUSH],
    spacing: 5,
    salt: 2237,
    maxLod: 0,
    tint: [0.96, 1.08, 0.84],
    place: (c) => {
      if (c.h < 2.4 || c.h > 60) return 0;
      const climate =
        smoothstep(0.28, 0.6, c.moisture) * band(c.temp, 0.35, 0.6, 0.92);
      const density =
        climate *
        mix(1, c.grove, 0.65) *
        0.44 *
        (1 - c.special.strength);
      if (c.r > density) return 0;
      if (c.slope > 0.55) return 0;
      return 0.7 + ((c.r * 149) % 1) * 0.9;
    },
  },
];

/**
 * 宝物区画の木。SPECIAL_BIOMES から自動生成するため、区画を足せばここも増える。
 */
const SPECIAL_SPECS: KindSpec[] = SPECIAL_BIOMES.flatMap((biome, index) => {
  if (biome.treeKind === null) return [];
  return [
    {
      kinds: [biome.treeKind],
      spacing: biome.treeSpacing,
      salt: 9001 + index * 13,
      maxLod: 1,
      giantChance: 0.012,
      blocksSpawn: true,
      specialIndex: index,
      place: (c) => {
        if (c.special.index !== index) return 0;
        if (c.h < 1.5) return 0;
        if (
          c.r >
          biome.treeDensity * c.special.strength * mix(1, c.grove, 0.6)
        ) {
          return 0;
        }
        if (c.slope > 0.5) return 0;
        return 0.8 + ((c.r * 811) % 1) * 0.6;
      },
    },
  ];
});

export const VEGETATION_SPECS: KindSpec[] = [
  ...CLIMATE_SPECS,
  ...SPECIAL_SPECS,
];
