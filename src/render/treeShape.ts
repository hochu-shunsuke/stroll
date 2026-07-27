import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../core/rng';
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

/**
 * 木の形を作る。開発用の見本帳（/trees.html）と本番が同じものを見る。
 *
 * **なぜ枝が要るのか。**
 * 以前は球と円錐を棒に刺して木にしていた。だが目が「木」と認識するのは
 * 細部ではなく**枝の構造が作るシルエット**で、球の集まりは幾何学の塊に見える。
 *
 * 枝の伸ばし方には、文献にある 3 つの効きどころを入れてある。
 *  - **growthForce**: 枝が光（真上）へ向き直る。小さい枝ほど強く効く
 *  - **gnarliness**: 細い枝ほど強くねじれ曲がる
 *  - **主軸の継続**: 分岐しても幹が 1 本上へ伸び続ける。これが無いと
 *    Y 字が繰り返すだけの人工的な形になる
 *
 * 形は起動時に一度だけ作って全チャンクで使い回すので、ここが重くても
 * 生成コストには乗らない。ただし 1 本あたりの面数はインスタンス数だけ
 * 描かれるので抑える（1 本 300〜700 面が目安）。
 */

const UP = new THREE.Vector3(0, 1, 0);

/** ジオメトリ全体を単色の頂点カラーで塗る（フラットシェーディング用）。 */
export function paint(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const count = g.getAttribute('position').count;
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  return g;
}

export interface TreeParams {
  trunkLength: number;
  trunkRadius: number;
  /** 枝分かれの深さ。2 で 幹→枝→小枝。 */
  levels: number;
  /** 1 段あたりの脇枝の数。主軸はこれとは別に 1 本続く。 */
  splitMin: number;
  splitMax: number;
  lengthRatio: number;
  radiusRatio: number;
  /** 主軸を続けるか。false だと Y 字だけの木になる。 */
  keepLeader: boolean;
  /** 脇枝が親から開く角度（度）。 */
  spreadMin: number;
  spreadMax: number;
  /** 枝が真上へ向き直る強さ 0..1。小さい枝ほど強く効く。 */
  growthForce: number;
  /** 枝のねじれ。細い枝ほど強く曲がる。 */
  gnarliness: number;
  /** 脇枝が親のどのあたりから出るか（0=根元, 1=先端）。 */
  branchFromMin: number;
  branchFromMax: number;
  /** 枝先の葉の塊の大きさ。0 なら葉を付けない（枯れ木）。 */
  leafSize: number;
  /** 葉を平たくする率。1 で球、0.35 で葉先のような板。 */
  leafFlatten: number;
  bark: number;
  leaves: readonly number[];
}

/** 1 本の枝を、先細りの角柱として +Y 方向に作る。 */
function branchGeometry(length: number, r0: number, r1: number, curve: number): THREE.BufferGeometry {
  const SIDES = 5;
  const SEG = curve === 0 ? 1 : 3;
  const pos: number[] = [];
  const ring = (t: number) => {
    const r = r0 + (r1 - r0) * t;
    const off = curve * length * t * t;
    const out: number[][] = [];
    for (let s = 0; s < SIDES; s++) {
      const a = (s / SIDES) * Math.PI * 2;
      out.push([Math.cos(a) * r + off, length * t, Math.sin(a) * r]);
    }
    return out;
  };
  const rings = [];
  for (let i = 0; i <= SEG; i++) rings.push(ring(i / SEG));
  for (let i = 0; i < SEG; i++) {
    const a = rings[i];
    const b = rings[i + 1];
    for (let s = 0; s < SIDES; s++) {
      const t = (s + 1) % SIDES;
      pos.push(...a[s], ...b[s], ...b[t]);
      pos.push(...a[s], ...b[t], ...a[t]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/** 葉の塊。正二十面体を潰して、角をずらす。 */
function leafGeometry(size: number, flatten: number, salt: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(size, 0).toNonIndexed();
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    // **座標から乱数を引くこと。** 非インデックスなので同じ角が複数の頂点として
    // 重複しており、頂点番号で引くと同じ角が別々に動いて面が裂ける（岩で踏んだ）。
    const key =
      ((Math.round((x / size) * 64) * 73856093) ^
        (Math.round((y / size) * 64) * 19349663) ^
        (Math.round((z / size) * 64) * 83492791) ^
        salt) >>>
      0;
    const s = 0.74 + mulberry32(key)() * 0.5;
    p.setXYZ(i, x * s, y * s * flatten, z * s);
  }
  return g;
}

/** dir に垂直な単位ベクトル。 */
function perpendicular(dir: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const a = Math.abs(dir.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0);
  return out.crossVectors(dir, a).normalize();
}

export function buildTree(params: TreeParams, seed: number): THREE.BufferGeometry {
  const rand = mulberry32(seed >>> 0);
  const rr = (lo: number, hi: number) => lo + rand() * (hi - lo);
  const parts: THREE.BufferGeometry[] = [];

  interface Node {
    pos: THREE.Vector3;
    dir: THREE.Vector3;
    length: number;
    radius: number;
    level: number;
  }
  const queue: Node[] = [
    {
      pos: new THREE.Vector3(),
      dir: UP.clone(),
      length: params.trunkLength,
      radius: params.trunkRadius,
      level: 0,
    },
  ];

  const q = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);

  let guard = 0;
  while (queue.length > 0 && guard++ < 500) {
    const n = queue.shift()!;
    const tip = n.radius * params.radiusRatio;

    // 細い枝ほど強くねじれる（gnarliness は半径に反比例）。
    const curve = (params.gnarliness / (1 + n.radius * 8)) * rr(-1, 1);
    const g = branchGeometry(n.length, n.radius, tip, curve);
    q.setFromUnitVectors(UP, n.dir);
    const toWorld = new THREE.Matrix4().compose(n.pos, q, one);
    parts.push(paint(g.applyMatrix4(toWorld), params.bark));

    // **子と葉は、曲げたあとの中心線の上に置くこと。**
    // 枝の形は curve で横にずらしてあるのに、子をまっすぐな位置に置いていたため、
    // 曲がった枝ほど子が離れて宙に浮いていた（実際に踏んだ）。
    //
    // 局所座標での中心線と、その接線（＝子が伸びる向き）。
    //   中心線(t) = ( curve * L * t^2 , L * t , 0 )
    //   接線(t)   = ( 2 * curve * L * t , L , 0 ) を正規化
    const centerAt = (t: number, out: THREE.Vector3) =>
      out.set(curve * n.length * t * t, n.length * t, 0).applyMatrix4(toWorld);
    const tangentAt = (t: number, out: THREE.Vector3) =>
      out
        .set(2 * curve * n.length * t, n.length, 0)
        .normalize()
        .transformDirection(toWorld);

    const tipPos = centerAt(1, new THREE.Vector3());

    const putLeaf = (at: THREE.Vector3, size: number) => {
      const leaf = leafGeometry(size, params.leafFlatten, (rand() * 0xffffff) | 0);
      const shade = params.leaves[Math.floor(rand() * params.leaves.length)];
      parts.push(paint(leaf.translate(at.x, at.y, at.z), shade));
    };

    if (n.level >= params.levels) {
      if (params.leafSize > 0) putLeaf(tipPos, params.leafSize * rr(0.78, 1.3));
      continue;
    }

    // 内側の枝の先にも小さめの葉を置く。枝先だけだと塊が離れて「団子」に見え、
    // 樹冠にならない。1 段内側を埋めると 1 つの冠として繋がる。
    if (params.leafSize > 0 && n.level > 0) {
      putLeaf(tipPos, params.leafSize * rr(0.7, 1.0));
    }

    // 子の向き。growthForce で真上へ引き戻す（小さい枝ほど強く効く）。
    const force = params.growthForce * (1 - n.level / (params.levels + 1));
    const child = (pitchDeg: number, yawRad: number, from: number) => {
      // 生え際は、曲げたあとの中心線の上。向きもそこでの接線から起こす。
      const base = tangentAt(from, new THREE.Vector3());
      perpendicular(base, axis);
      const dir = base.clone();
      dir.applyAxisAngle(axis, THREE.MathUtils.degToRad(pitchDeg));
      dir.applyAxisAngle(base, yawRad);
      dir.lerp(UP, force).normalize();
      const pos = centerAt(from, new THREE.Vector3());
      // 親の中へ少しめり込ませる。継ぎ目の隙間はこれで消える。
      const bury = n.radius * 0.9;
      pos.addScaledVector(dir, -bury);
      queue.push({
        pos,
        dir,
        length: n.length * params.lengthRatio * rr(0.82, 1.15) + bury,
        radius: tip * rr(0.82, 1.02),
        level: n.level + 1,
      });
    };

    // 主軸。ほぼ真っ直ぐ続く。これが「1 本の木」の背骨になる。
    if (params.keepLeader) child(rr(2, 12), rand() * Math.PI * 2, 1.0);

    const count = Math.round(rr(params.splitMin, params.splitMax));
    const base = rand() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      child(
        rr(params.spreadMin, params.spreadMax),
        base + (i / count) * Math.PI * 2 + rr(-0.5, 0.5),
        rr(params.branchFromMin, params.branchFromMax),
      );
    }
  }

  return mergeGeometries(parts)!;
}

// ---------------------------------------------------------------------------
// 針葉樹
//
// 主幹が最後まで真っ直ぐ伸びるので、枝から再帰するより「幹＋段」が正しい。
// **幹を一番上の段の頂点より上へ出さないこと。** 突き出すと串刺しに見える（踏んだ）。
// ---------------------------------------------------------------------------

export interface ConiferParams {
  tiers: number;
  baseRadius: number;
  taper: number;
  /** 段の高さ / 半径。大きいほど尖る。 */
  aspect: number;
  /** 段をどれだけ詰めるか。0.6 なら 4 割重なる。 */
  overlap: number;
  /** 根元の、段の無い幹の長さ。 */
  clear: number;
  bark: number;
  greens: readonly number[];
}

export function buildConifer(p: ConiferParams, seed: number): THREE.BufferGeometry {
  const rand = mulberry32(seed >>> 0);
  const tierY: number[] = [];
  const tierR: number[] = [];
  let y = p.clear;
  let r = p.baseRadius;
  for (let i = 0; i < p.tiers; i++) {
    const jitter = 0.84 + rand() * 0.32;
    tierY.push(y);
    tierR.push(r * jitter);
    y += r * jitter * p.aspect * p.overlap;
    r *= p.taper;
  }
  // 幹をどこで止めるか。**「一番上の段の頂点まで」では駄目**（一度これで
  // 串刺しになった）。円錐は先端に向かって半径が 0 に収束するので、頂点の
  // 近くでは必ず幹の方が太くなって突き出す。
  //
  // 円錐の半径が幹の 2 倍以上ある高さまでで止める。
  //   円錐の半径(t) = tierR * (1 - t)   ここで t は段の中の高さの割合
  //   tierR * (1 - t) >= trunkTop * 2.2  を解く
  const lastR = tierR[p.tiers - 1];
  const lastH = lastR * p.aspect;
  const trunkTopR = p.baseRadius * 0.08;
  const safe = Math.max(0, 1 - (trunkTopR * 2.2) / lastR);
  const trunkTop = tierY[p.tiers - 1] + lastH * safe;

  const parts: THREE.BufferGeometry[] = [
    paint(
      new THREE.CylinderGeometry(trunkTopR, p.baseRadius * 0.2, trunkTop, 6).translate(
        0,
        trunkTop * 0.5,
        0,
      ),
      p.bark,
    ),
  ];
  for (let i = 0; i < p.tiers; i++) {
    const hgt = tierR[i] * p.aspect;
    const g = new THREE.ConeGeometry(tierR[i], hgt, 7);
    g.rotateY(rand() * Math.PI * 2);
    // 段ごとにわずかに傾けて、積み木らしさを消す。
    g.rotateX((rand() - 0.5) * 0.11);
    parts.push(paint(g.translate(0, tierY[i] + hgt * 0.5, 0), p.greens[i % p.greens.length]));
  }
  return mergeGeometries(parts)!;
}

// ---------------------------------------------------------------------------
// 見本帳
// ---------------------------------------------------------------------------

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
 * 片方だけに足すと見本帳と世界が食い違うので、必ずここに書くこと。
 */
export const TREE_CATALOG: CatalogEntry[] = [
  { name: '広葉樹 丸', kind: KIND_BROADLEAF, build: (s) => buildTree(BROADLEAF, s) },
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
    // 幹を長くした。短いと草むらに見える（踏んだ）。
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
    build: (s) =>
      buildTree(
        {
          ...BROADLEAF,
          trunkLength: 6.2,
          trunkRadius: 0.22,
          levels: 1,
          splitMin: 5.0,
          splitMax: 7.0,
          lengthRatio: 0.34,
          radiusRatio: 0.5,
          keepLeader: false,
          spreadMin: 62,
          spreadMax: 94,
          growthForce: 0,
          gnarliness: 2.4,
          branchFromMin: 1.0,
          branchFromMax: 1.0,
          leafSize: 0.8,
          leafFlatten: 0.3,
          bark: 0x7d6a4c,
          leaves: [0x4f7a3c, 0x5c8a45, 0x69954f],
        },
        s,
      ),
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
    build: (s) => buildTree({ ...BROADLEAF, leaves: [0xc4692b, 0xd89a34, 0xcf8a2e, 0xb85f26] }, s),
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

export function buildCatalogGeometry(entry: CatalogEntry, seed: number): THREE.BufferGeometry {
  const g = entry.build(seed);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
