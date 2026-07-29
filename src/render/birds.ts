import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const BIRD_KINDS = ['seagull', 'chick', 'chicken', 'swallow'] as const;
export type BirdKind = (typeof BIRD_KINDS)[number];

export interface BirdRig {
  kind: BirdKind;
  root: THREE.Group;
  leftWing: THREE.Group;
  rightWing: THREE.Group;
  legs: THREE.Group[];
  geometries: THREE.BufferGeometry[];
  labelHeight: number;
  flapSpeed: number;
  flapAmount: number;
  foldAngle: number;
}

interface BirdDesign {
  body: number;
  belly: number;
  head: number;
  wing: number;
  wingTip: number;
  beak: number;
  feet: number;
  bodyPosition: [number, number, number];
  bodyScale: [number, number, number];
  headPosition: [number, number, number];
  headScale: number;
  beakPosition: [number, number, number];
  beakScale: [number, number, number];
  wingPosition: [number, number, number];
  wingLength: number;
  wingWidth: number;
  legTop: number;
  legLength: number;
  labelHeight: number;
  flapSpeed: number;
  flapAmount: number;
  foldAngle: number;
}

const DESIGNS: Record<BirdKind, BirdDesign> = {
  seagull: {
    body: 0xe6e9e8,
    belly: 0xf4f4ef,
    head: 0xf1f2ed,
    wing: 0xaab3b6,
    wingTip: 0x3e494e,
    beak: 0xe8a84d,
    feet: 0xd9954a,
    bodyPosition: [0, 0.86, 0],
    bodyScale: [0.43, 0.43, 0.64],
    headPosition: [0, 1.27, -0.4],
    headScale: 0.3,
    beakPosition: [0, 1.24, -0.73],
    beakScale: [0.12, 0.28, 0.12],
    wingPosition: [0.32, 0.98, -0.01],
    wingLength: 1.05,
    wingWidth: 0.78,
    legTop: 0.53,
    legLength: 0.34,
    labelHeight: 1.82,
    flapSpeed: 7.2,
    flapAmount: 0.58,
    foldAngle: 1.27,
  },
  chick: {
    body: 0xf1c941,
    belly: 0xf8db5d,
    head: 0xf5d34c,
    wing: 0xdcae2f,
    wingTip: 0xd09d25,
    beak: 0xe98a34,
    feet: 0xdc7d2e,
    bodyPosition: [0, 0.62, 0],
    bodyScale: [0.48, 0.5, 0.48],
    headPosition: [0, 1.03, -0.25],
    headScale: 0.36,
    beakPosition: [0, 1.0, -0.61],
    beakScale: [0.11, 0.22, 0.11],
    wingPosition: [0.37, 0.7, 0],
    wingLength: 0.48,
    wingWidth: 0.68,
    legTop: 0.29,
    legLength: 0.25,
    labelHeight: 1.58,
    flapSpeed: 12.5,
    flapAmount: 0.82,
    foldAngle: 1.16,
  },
  chicken: {
    body: 0xd7a766,
    belly: 0xead3a0,
    head: 0xe2bc7c,
    wing: 0x9e7045,
    wingTip: 0x664735,
    beak: 0xe79a3f,
    feet: 0xc98038,
    bodyPosition: [0, 0.76, 0.04],
    bodyScale: [0.5, 0.58, 0.58],
    headPosition: [0, 1.31, -0.34],
    headScale: 0.33,
    beakPosition: [0, 1.27, -0.7],
    beakScale: [0.12, 0.24, 0.12],
    wingPosition: [0.4, 0.86, 0.02],
    wingLength: 0.67,
    wingWidth: 0.76,
    legTop: 0.39,
    legLength: 0.34,
    labelHeight: 1.92,
    flapSpeed: 9.4,
    flapAmount: 0.7,
    foldAngle: 1.22,
  },
  swallow: {
    body: 0x365563,
    belly: 0xe8e6da,
    head: 0x304f5d,
    wing: 0x294854,
    wingTip: 0x1d3742,
    beak: 0x9c593d,
    feet: 0x8f5841,
    bodyPosition: [0, 0.76, -0.02],
    bodyScale: [0.32, 0.36, 0.58],
    headPosition: [0, 1.08, -0.43],
    headScale: 0.27,
    beakPosition: [0, 1.06, -0.7],
    beakScale: [0.08, 0.18, 0.08],
    wingPosition: [0.25, 0.87, -0.03],
    wingLength: 1.14,
    wingWidth: 0.6,
    legTop: 0.46,
    legLength: 0.2,
    labelHeight: 1.65,
    flapSpeed: 11.2,
    flapAmount: 0.78,
    foldAngle: 1.32,
  },
};

const BODY_GEO = new THREE.IcosahedronGeometry(1, 1);
const SMALL_GEO = new THREE.IcosahedronGeometry(1, 0);
const BEAK_GEO = new THREE.ConeGeometry(1, 1, 4);
const LEG_GEO = new THREE.CylinderGeometry(1, 1, 1, 5);
const COMB_GEO = new THREE.SphereGeometry(1, 5, 3);
const BIRD_MATERIAL = new THREE.MeshLambertMaterial({
  vertexColors: true,
  flatShading: true,
  side: THREE.DoubleSide,
});

function polygon(points: readonly [number, number, number][]): THREE.BufferGeometry {
  const positions: number[] = [];
  for (let i = 1; i < points.length - 1; i++) {
    positions.push(...points[0], ...points[i], ...points[i + 1]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** 根元から横へ広がり、後縁だけ少し長い低ポリの翼。 */
const WING_GEO = polygon([
  [0, 0, 0],
  [0.5, 0.025, -0.24],
  [1, 0, -0.04],
  [0.78, -0.02, 0.24],
  [0.22, 0, 0.34],
]);

/** 翼端の色分け。かもめの黒い先端やツバメの濃い先端に使う。 */
const WING_TIP_GEO = polygon([
  [0.67, 0.006, -0.13],
  [1.01, 0.006, -0.04],
  [0.78, 0.006, 0.24],
  [0.58, 0.006, 0.17],
]);

/** ツバメの二股の尾に使う細い羽。 */
const TAIL_FEATHER_GEO = polygon([
  [-0.07, 0, 0],
  [0.07, 0, 0],
  [0.035, 0, 0.8],
  [0, 0, 1.05],
]);

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 同じ接続IDなら、見る人や参加順に関係なく同じ鳥になる。 */
export function birdKindForId(id: string): BirdKind {
  return BIRD_KINDS[hashString(id) % BIRD_KINDS.length];
}

function createMaterial(
  color: number,
  materials: THREE.MeshLambertMaterial[],
  doubleSided = false,
): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({
    color,
    flatShading: true,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
  materials.push(material);
  return material;
}

function addMesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  position: readonly [number, number, number],
  scale: readonly [number, number, number],
  rotation: readonly [number, number, number] = [0, 0, 0],
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  mesh.rotation.set(...rotation);
  parent.add(mesh);
  return mesh;
}

function createWing(
  root: THREE.Group,
  side: -1 | 1,
  design: BirdDesign,
  wingMaterial: THREE.Material,
  tipMaterial: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();
  group.position.set(
    design.wingPosition[0] * side,
    design.wingPosition[1],
    design.wingPosition[2],
  );
  root.add(group);

  addMesh(
    group,
    WING_GEO,
    wingMaterial,
    [0, 0, 0],
    [design.wingLength * side, 1, design.wingWidth],
  );
  addMesh(
    group,
    WING_TIP_GEO,
    tipMaterial,
    [0, 0, 0],
    [design.wingLength * side, 1, design.wingWidth],
  );
  return group;
}

function addLegs(
  root: THREE.Group,
  design: BirdDesign,
  material: THREE.Material,
): THREE.Group[] {
  const legs: THREE.Group[] = [];
  for (const side of [-1, 1] as const) {
    const leg = new THREE.Group();
    leg.position.set(side * 0.16, design.legTop, 0.02);
    root.add(leg);
    addMesh(
      leg,
      LEG_GEO,
      material,
      [0, -design.legLength / 2, 0],
      [0.035, design.legLength, 0.035],
    );
    addMesh(
      leg,
      LEG_GEO,
      material,
      [0, -design.legLength, -0.09],
      [0.025, 0.22, 0.025],
      [-Math.PI / 2, 0, 0],
    );
    legs.push(leg);
  }
  return legs;
}

function addEyes(
  root: THREE.Group,
  head: readonly [number, number, number],
  headScale: number,
  material: THREE.Material,
): void {
  for (const side of [-1, 1] as const) {
    addMesh(
      root,
      SMALL_GEO,
      material,
      [
        side * headScale * 0.67,
        head[1] + headScale * 0.2,
        head[2] - headScale * 0.73,
      ],
      [headScale * 0.11, headScale * 0.13, headScale * 0.09],
    );
  }
}

function addTail(
  root: THREE.Group,
  kind: BirdKind,
  design: BirdDesign,
  material: THREE.Material,
): void {
  const back = design.bodyPosition[2] + design.bodyScale[2] * 0.78;
  const y = design.bodyPosition[1] + design.bodyScale[1] * 0.05;
  if (kind === 'swallow') {
    for (const side of [-1, 1] as const) {
      addMesh(
        root,
        TAIL_FEATHER_GEO,
        material,
        [side * 0.06, y, back],
        [side * 0.5, 1, 0.72],
        [0.12, side * -0.22, 0],
      );
    }
    return;
  }

  for (const side of [-1, 0, 1] as const) {
    addMesh(
      root,
      BEAK_GEO,
      material,
      [side * 0.12, y, back + Math.abs(side) * 0.03],
      [0.1, kind === 'chicken' ? 0.48 : 0.34, 0.07],
      [Math.PI / 2 - 0.12, 0, side * 0.08],
    );
  }
}

function addKindDetails(
  root: THREE.Group,
  kind: BirdKind,
  design: BirdDesign,
  materials: THREE.MeshLambertMaterial[],
): void {
  if (kind === 'chick') {
    const blush = createMaterial(0xe99b76, materials);
    for (const side of [-1, 1] as const) {
      addMesh(
        root,
        SMALL_GEO,
        blush,
        [side * 0.31, 0.98, -0.48],
        [0.065, 0.045, 0.035],
      );
    }
    return;
  }

  if (kind === 'chicken') {
    const red = createMaterial(0xb94738, materials);
    for (let i = 0; i < 3; i++) {
      addMesh(
        root,
        COMB_GEO,
        red,
        [(i - 1) * 0.075, 1.61 + (i === 1 ? 0.05 : 0), -0.35 + Math.abs(i - 1) * 0.025],
        [0.09, 0.13, 0.08],
      );
    }
    addMesh(root, SMALL_GEO, red, [0, 1.14, -0.61], [0.1, 0.14, 0.07]);
    return;
  }

  if (kind === 'swallow') {
    const throat = createMaterial(0x9d5545, materials);
    addMesh(
      root,
      BODY_GEO,
      throat,
      [0, design.headPosition[1] - 0.12, design.headPosition[2] - 0.17],
      [0.16, 0.15, 0.11],
    );
  }
}

/**
 * 直下にある色別メッシュを、頂点色付きの1メッシュへ焼き固める。
 * 1羽17〜21 draw call のままだと9人集まったスマホで重いので、
 * 胴体1・左右の翼2・左右の脚2の計5 draw call にする。
 */
function bakeDirectMeshes(
  group: THREE.Group,
  geometries: THREE.BufferGeometry[],
): void {
  const meshes = group.children.filter(
    (child): child is THREE.Mesh =>
      child instanceof THREE.Mesh &&
      child.geometry instanceof THREE.BufferGeometry &&
      child.material instanceof THREE.MeshLambertMaterial,
  );
  if (meshes.length === 0) return;

  const parts = meshes.map((mesh) => {
    mesh.updateMatrix();
    const source = mesh.geometry.index
      ? mesh.geometry.toNonIndexed()
      : mesh.geometry.clone();
    source.applyMatrix4(mesh.matrix);
    source.deleteAttribute('uv');

    const color = (mesh.material as THREE.MeshLambertMaterial).color;
    const count = source.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    source.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return source;
  });

  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('鳥モデルの結合に失敗しました');
  for (const mesh of meshes) group.remove(mesh);
  for (const part of parts) part.dispose();
  group.add(new THREE.Mesh(merged, BIRD_MATERIAL));
  geometries.push(merged);
}

export function createBird(id: string): BirdRig {
  const kind = birdKindForId(id);
  const design = DESIGNS[kind];
  const materials: THREE.MeshLambertMaterial[] = [];
  const root = new THREE.Group();

  const body = createMaterial(design.body, materials);
  const belly = createMaterial(design.belly, materials);
  const head = createMaterial(design.head, materials);
  const wing = createMaterial(design.wing, materials, true);
  const wingTip = createMaterial(design.wingTip, materials, true);
  const beak = createMaterial(design.beak, materials);
  const feet = createMaterial(design.feet, materials);
  const eye = createMaterial(0x172126, materials);

  addMesh(root, BODY_GEO, body, design.bodyPosition, design.bodyScale);
  addMesh(
    root,
    BODY_GEO,
    belly,
    [
      0,
      design.bodyPosition[1] - design.bodyScale[1] * 0.04,
      design.bodyPosition[2] - design.bodyScale[2] * 0.64,
    ],
    [
      design.bodyScale[0] * 0.68,
      design.bodyScale[1] * 0.72,
      design.bodyScale[2] * 0.28,
    ],
  );
  addMesh(
    root,
    BODY_GEO,
    head,
    design.headPosition,
    [design.headScale, design.headScale, design.headScale],
  );
  addMesh(
    root,
    BEAK_GEO,
    beak,
    design.beakPosition,
    design.beakScale,
    [-Math.PI / 2, 0, 0],
  );

  addEyes(root, design.headPosition, design.headScale, eye);
  addTail(root, kind, design, wingTip);
  addKindDetails(root, kind, design, materials);

  const leftWing = createWing(root, -1, design, wing, wingTip);
  const rightWing = createWing(root, 1, design, wing, wingTip);
  const legs = addLegs(root, design, feet);
  const geometries: THREE.BufferGeometry[] = [];
  bakeDirectMeshes(root, geometries);
  bakeDirectMeshes(leftWing, geometries);
  bakeDirectMeshes(rightWing, geometries);
  for (const leg of legs) bakeDirectMeshes(leg, geometries);
  for (const material of materials) material.dispose();

  return {
    kind,
    root,
    leftWing,
    rightWing,
    legs,
    geometries,
    labelHeight: design.labelHeight,
    flapSpeed: design.flapSpeed,
    flapAmount: design.flapAmount,
    foldAngle: design.foldAngle,
  };
}

/** 飛行と地上を滑らかにつなぐ。種類ごとに翼の速さと大きさだけ変える。 */
export function poseBird(
  bird: BirdRig,
  time: number,
  flightBlend: number,
  groundMotion: number,
): void {
  const flap = Math.sin(time * bird.flapSpeed) * bird.flapAmount * flightBlend;
  const groundFlutter =
    Math.sin(time * bird.flapSpeed * 0.45) * 0.035 * (1 - flightBlend);

  bird.rightWing.rotation.y = -bird.foldAngle * (1 - flightBlend);
  bird.leftWing.rotation.y = bird.foldAngle * (1 - flightBlend);
  bird.rightWing.rotation.z = flap + groundFlutter;
  bird.leftWing.rotation.z = -flap - groundFlutter;

  const hop =
    Math.abs(Math.sin(time * 7.5)) * 0.045 * groundMotion * (1 - flightBlend);
  bird.root.position.y =
    hop + flightBlend * (0.07 + Math.sin(time * 2.2) * 0.025);
  bird.root.rotation.x = -0.14 * flightBlend;

  for (let i = 0; i < bird.legs.length; i++) {
    const step = Math.sin(time * 8 + i * Math.PI) * 0.38 * groundMotion;
    bird.legs[i].rotation.x = flightBlend * 1.08 + step * (1 - flightBlend);
  }
}
