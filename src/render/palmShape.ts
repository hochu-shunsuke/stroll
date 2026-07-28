import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../core/rng';
import { branchGeometry, paint, TREE_UP } from './treeGeometry';

/**
 * 椰子専用の形。
 *
 * 広葉樹の枝分かれを流用すると、幹の先で Y 字が増える苗木に見える。
 * 一本の曲がった幹と、頂点から放射状に垂れる葉で固有の輪郭を作る。
 */

/** 根元から先端へ細くなり、途中で持ち上がってから垂れる一枚の椰子葉。 */
function palmFrondGeometry(
  length: number,
  width: number,
  lift: number,
  drop: number,
  sideBend: number,
): THREE.BufferGeometry {
  const SEGMENTS = 5;
  const pos: number[] = [];
  const rings: [number[], number[]][] = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS;
    const centerX = length * t;
    const centerY = Math.sin(Math.PI * t) * lift - t * t * drop;
    const centerZ = Math.sin(Math.PI * t) * sideBend;
    const blade = width * Math.pow(Math.sin(Math.PI * t), 0.72);
    const half = Math.max(0.035, blade);
    rings.push([
      [centerX, centerY, centerZ - half],
      [centerX, centerY, centerZ + half],
    ]);
  }
  for (let i = 0; i < SEGMENTS; i++) {
    const a = rings[i];
    const b = rings[i + 1];
    // 地上と上空のどちらから見ても消えないよう両面を持たせる。
    pos.push(...a[0], ...b[0], ...b[1], ...a[0], ...b[1], ...a[1]);
    pos.push(...a[1], ...b[1], ...b[0], ...a[1], ...b[0], ...a[0]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

export function buildPalm(seed: number): THREE.BufferGeometry {
  const rand = mulberry32(seed >>> 0);
  const rr = (lo: number, hi: number) => lo + rand() * (hi - lo);
  const parts: THREE.BufferGeometry[] = [];

  const height = rr(6.6, 7.5);
  const curve = rr(0.055, 0.085);
  const trunkYaw = rand() * Math.PI * 2;
  const trunk = branchGeometry(height, 0.3, 0.13, curve);
  trunk.rotateY(trunkYaw);
  parts.push(paint(trunk, 0x806b4b));

  const crown = new THREE.Vector3(
    curve * height,
    height,
    0,
  ).applyAxisAngle(TREE_UP, trunkYaw);
  parts.push(
    paint(
      new THREE.IcosahedronGeometry(0.3, 0).translate(
        crown.x,
        crown.y,
        crown.z,
      ),
      0x526735,
    ),
  );

  const greens = [0x416f37, 0x4d7d3e, 0x5a8947, 0x668f49];
  const count = 9;
  const baseYaw = rand() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const frond = palmFrondGeometry(
      rr(2.8, 3.8),
      rr(0.34, 0.52),
      rr(0.28, 0.62),
      rr(0.72, 1.35),
      rr(-0.28, 0.28),
    );
    frond.rotateY(
      baseYaw + (i / count) * Math.PI * 2 + rr(-0.16, 0.16),
    );
    frond.translate(crown.x, crown.y + rr(-0.05, 0.14), crown.z);
    parts.push(paint(frond, greens[i % greens.length]));
  }

  return mergeGeometries(parts)!;
}
