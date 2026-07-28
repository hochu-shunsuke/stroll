import * as THREE from 'three';
import {
  KIND_AUTUMN,
  KIND_BROADLEAF,
  KIND_BROADLEAF_TALL,
  KIND_BROADLEAF_WIDE,
  KIND_DEAD,
  KIND_PALM,
  KIND_PINE,
  KIND_PINE_OLD,
  KIND_PINE_YOUNG,
  KIND_SAKURA,
} from '../world/vegetationKinds';
import { buildConifer } from './coniferShape';
import { buildPalm } from './palmShape';
import { buildTree, type TreeParams } from './treeGeometry';

const BARK = 0x6b5744;
const GREENS = [0x516f45, 0x5c7d4d, 0x688a54, 0x4a6640];

/** 丸い広葉樹。基準になる形。 */
const BROADLEAF: TreeParams = {
  trunkLength: 3.0,
  trunkRadius: 0.28,
  levels: 2,
  splitMin: 2.4,
  splitMax: 3.4,
  lengthRatio: 0.64,
  radiusRatio: 0.6,
  keepLeader: true,
  spreadMin: 32,
  spreadMax: 58,
  growthForce: 0.35,
  gnarliness: 0.5,
  branchFromMin: 0.55,
  branchFromMax: 1.0,
  leafSize: 1.25,
  leafFlatten: 0.85,
  bark: BARK,
  leaves: GREENS,
};

export interface CatalogEntry {
  name: string;
  kind: number;
  build: (seed: number) => THREE.BufferGeometry;
}

/**
 * 出す木の一覧。見本帳（/trees.html）と本番（vegetation.ts）が同じものを見る。
 * 形状ビルダーへ種類を足すだけでは世界に出ないため、公開する木は必ずここへ置く。
 */
export const TREE_CATALOG: CatalogEntry[] = [
  {
    name: '広葉樹 丸',
    kind: KIND_BROADLEAF,
    build: (s) => buildTree(BROADLEAF, s),
  },
  {
    name: '広葉樹 高',
    kind: KIND_BROADLEAF_TALL,
    build: (s) =>
      buildTree(
        {
          ...BROADLEAF,
          trunkLength: 4.8,
          trunkRadius: 0.24,
          lengthRatio: 0.5,
          spreadMin: 20,
          spreadMax: 40,
          growthForce: 0.55,
          branchFromMin: 0.7,
          leafSize: 1.0,
        },
        s,
      ),
  },
  {
    // 幹を短くすると草むらに見える。
    name: '広葉樹 傘',
    kind: KIND_BROADLEAF_WIDE,
    build: (s) =>
      buildTree(
        {
          ...BROADLEAF,
          trunkLength: 3.8,
          trunkRadius: 0.34,
          splitMin: 3.4,
          splitMax: 4.4,
          lengthRatio: 0.62,
          keepLeader: false,
          spreadMin: 56,
          spreadMax: 80,
          growthForce: 0.18,
          branchFromMin: 0.85,
          leafSize: 1.15,
          leafFlatten: 0.62,
        },
        s,
      ),
  },
  {
    name: '枯れ木',
    kind: KIND_DEAD,
    build: (s) =>
      buildTree(
        {
          ...BROADLEAF,
          trunkLength: 3.4,
          trunkRadius: 0.26,
          levels: 3,
          splitMin: 1.5,
          splitMax: 2.3,
          lengthRatio: 0.54,
          spreadMin: 30,
          spreadMax: 58,
          gnarliness: 1.1,
          growthForce: 0.34,
          leafSize: 0,
          bark: 0x7d6d58,
        },
        s,
      ),
  },
  {
    name: '椰子',
    kind: KIND_PALM,
    build: (s) => buildPalm(s),
  },
  {
    name: '針葉樹 成木',
    kind: KIND_PINE,
    build: (s) =>
      buildConifer(
        {
          tiers: 5,
          baseRadius: 1.3,
          taper: 0.79,
          aspect: 1.9,
          overlap: 0.6,
          clear: 1.4,
          bark: BARK,
          greens: [0x3d5a42, 0x456349, 0x4d6b4f, 0x557355],
        },
        s,
      ),
  },
  {
    name: '針葉樹 若木',
    kind: KIND_PINE_YOUNG,
    build: (s) =>
      buildConifer(
        {
          tiers: 3,
          baseRadius: 0.85,
          taper: 0.74,
          aspect: 2.1,
          overlap: 0.58,
          clear: 0.5,
          bark: BARK,
          greens: [0x44634a, 0x4c6b50, 0x547356],
        },
        s,
      ),
  },
  {
    name: '針葉樹 老木',
    kind: KIND_PINE_OLD,
    build: (s) =>
      buildConifer(
        {
          tiers: 6,
          baseRadius: 1.65,
          taper: 0.86,
          aspect: 1.55,
          overlap: 0.68,
          clear: 2.8,
          bark: 0x60503f,
          greens: [0x38543d, 0x3f5c43, 0x466449, 0x4d6c4f],
        },
        s,
      ),
  },
  {
    name: '秋の木',
    kind: KIND_AUTUMN,
    build: (s) =>
      buildTree(
        {
          ...BROADLEAF,
          leaves: [0xc4692b, 0xd89a34, 0xcf8a2e, 0xb85f26],
        },
        s,
      ),
  },
  {
    name: '桜',
    kind: KIND_SAKURA,
    build: (s) =>
      buildTree(
        {
          ...BROADLEAF,
          spreadMin: 40,
          spreadMax: 72,
          growthForce: 0.22,
          leaves: [0xe6a9c4, 0xefc0d6, 0xdb96b6, 0xf0cadb],
        },
        s,
      ),
  },
];

export function buildCatalogGeometry(
  entry: CatalogEntry,
  seed: number,
): THREE.BufferGeometry {
  const g = entry.build(seed);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
