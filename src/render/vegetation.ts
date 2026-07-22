import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hash2 } from '../core/rng';
import { KIND_BROADLEAF, KIND_BUSH, KIND_PINE, KIND_ROCK } from '../world/scatter';

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

function makePine(): THREE.BufferGeometry {
  return mergeGeometries([
    paint(at(new THREE.CylinderGeometry(0.16, 0.3, 2.6, 6), 1.3), TRUNK),
    paint(at(new THREE.ConeGeometry(1.9, 2.8, 7), 3.0), 0x46654a),
    paint(at(new THREE.ConeGeometry(1.45, 2.4, 7), 4.7), 0x4d6e50),
    paint(at(new THREE.ConeGeometry(0.95, 2.0, 7), 6.2), 0x557857),
  ])!;
}

function makeRock(): THREE.BufferGeometry {
  // 正二十面体の頂点をずらして角張らせる（この形は元から非インデックス）。
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const p = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const s = 0.72 + hash2(i, 3, 991) * 0.55;
    p.setXYZ(i, p.getX(i) * s, p.getY(i) * s * 0.75, p.getZ(i) * s);
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
    for (const g of geometries) g.computeBoundingSphere();
    cache = {
      geometries,
      material: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    };
  }
  return cache;
}
