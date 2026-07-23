import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hash2 } from '../core/rng';
import {
  KIND_AUTUMN,
  KIND_BROADLEAF,
  KIND_BUSH,
  KIND_PINE,
  KIND_ROCK,
  KIND_SAKURA,
} from '../world/vegetationKinds';

/** ジオメトリ全体を単色の頂点カラーで塗る（フラットシェーディング用）。 */
function paint(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
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
  return g;
}

function at(geo: THREE.BufferGeometry, y: number, x = 0, z = 0): THREE.BufferGeometry {
  geo.translate(x, y, z);
  return geo;
}

const TRUNK = 0x6b5744;

function makeBroadleaf(): THREE.BufferGeometry {
  // 丸い塊を 3 つずらして重ね、シルエットが単調にならないようにする。
  return mergeGeometries([
    paint(at(new THREE.CylinderGeometry(0.2, 0.34, 3.4, 6), 1.7), TRUNK),
    paint(at(new THREE.IcosahedronGeometry(1.95, 0), 4.6), 0x5f8250),
    paint(at(new THREE.IcosahedronGeometry(1.45, 0), 5.6, 1.1, 0.5), 0x6d8f59),
    paint(at(new THREE.IcosahedronGeometry(1.25, 0), 4.1, -1.2, -0.7), 0x527347),
  ])!;
}

/** 広葉樹と同じ形で、葉だけ 3 色に塗った木を作る。色の宝物の森に使う。 */
function makeTintedTree(leafA: number, leafB: number, leafC: number): THREE.BufferGeometry {
  return mergeGeometries([
    paint(at(new THREE.CylinderGeometry(0.2, 0.34, 3.4, 6), 1.7), TRUNK),
    paint(at(new THREE.IcosahedronGeometry(1.95, 0), 4.6), leafA),
    paint(at(new THREE.IcosahedronGeometry(1.45, 0), 5.6, 1.1, 0.5), leafB),
    paint(at(new THREE.IcosahedronGeometry(1.25, 0), 4.1, -1.2, -0.7), leafC),
  ])!;
}

function makePine(): THREE.BufferGeometry {
  return mergeGeometries([
    paint(at(new THREE.CylinderGeometry(0.16, 0.3, 2.6, 6), 1.3), TRUNK),
    paint(at(new THREE.ConeGeometry(1.9, 2.8, 7), 3.0), 0x46654a),
    paint(at(new THREE.ConeGeometry(1.45, 2.4, 7), 4.7), 0x4d6e50),
    paint(at(new THREE.ConeGeometry(0.95, 2.0, 7), 6.2), 0x557857),
  ])!;
}

function makeRock(): THREE.BufferGeometry {
  // 正二十面体の角をずらして岩らしくする。
  // この形は非インデックスで、同じ角が複数の頂点として重複している。
  // 頂点番号で乱数を引くと同じ角が別々に動いて面が裂けるので、
  // 座標から乱数を引く。同じ角は座標が一致するので、必ず一緒に動く。
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const p = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const key = (Math.round(x * 64) * 73856093) ^ (Math.round(y * 64) * 19349663) ^ (Math.round(z * 64) * 83492791);
    const s = 0.72 + hash2(key, 0, 991) * 0.55;
    p.setXYZ(i, x * s, y * s * 0.75, z * s);
  }
  return paint(geo, 0x8a857a);
}

function makeBush(): THREE.BufferGeometry {
  return mergeGeometries([
    paint(at(new THREE.IcosahedronGeometry(0.6, 0), 0.4), 0x6f8a56),
    paint(at(new THREE.IcosahedronGeometry(0.42, 0), 0.6, 0.5, 0.3), 0x7d9660),
  ])!;
}

let cache: { geometries: THREE.BufferGeometry[]; material: THREE.Material } | null = null;

/** 木・岩の形と材質は全チャンクで共有する。 */
export function vegetation() {
  if (!cache) {
    const geometries: THREE.BufferGeometry[] = [];
    geometries[KIND_BROADLEAF] = makeBroadleaf();
    geometries[KIND_PINE] = makePine();
    geometries[KIND_ROCK] = makeRock();
    geometries[KIND_BUSH] = makeBush();
    // 秋: オレンジと金だけ。赤は目が疲れるので入れない。
    geometries[KIND_AUTUMN] = makeTintedTree(0xc4692b, 0xd89a34, 0xcf8a2e);
    // 桜: 淡い桃色。
    geometries[KIND_SAKURA] = makeTintedTree(0xe6a9c4, 0xefc0d6, 0xdb96b6);
    for (const g of geometries) g.computeBoundingSphere();
    cache = {
      geometries,
      material: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    };
  }
  return cache;
}
