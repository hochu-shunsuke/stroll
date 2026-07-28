import * as THREE from 'three';
import { MORNING, Sky } from '../render/sky';
import { TREE_CATALOG, buildCatalogGeometry } from '../render/treeCatalog';

/**
 * 木の見本帳（開発用）。`npm run dev` で /trees.html を開くと出る。
 *
 * 本番のビルドには入らない。vite の入口は index.html だけで、
 * ここは build.rollupOptions.input に載せていないため。
 *
 * 世界の中で木を確かめようとすると、探して歩いて撮る必要があって遅い。
 * 同じ光と霧のまま、全種類を横に並べて一度に見られるようにする。
 */

const canvas = document.getElementById('view') as HTMLCanvasElement;
const labelRoot = document.getElementById('labels')!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 3000);

// 本番と同じ光と霧。ここで良く見えても本番で違ったら意味がない。
const sky = new Sky(scene, MORNING);
// 霧は見本帳では邪魔なので薄くする。
scene.fog = new THREE.FogExp2(new THREE.Color().setHex(MORNING.horizon, THREE.SRGBColorSpace), 0.0009);

const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

// 地面。
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), material);
{
  const g = ground.geometry as THREE.PlaneGeometry;
  g.rotateX(-Math.PI / 2);
  const c = new Float32Array(g.getAttribute('position').count * 3);
  for (let i = 0; i < c.length; i += 3) {
    c[i] = 0.34;
    c[i + 1] = 0.42;
    c[i + 2] = 0.25;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
}
scene.add(ground);

const SPACING = 11;
const PER_ROW = 5;
interface Slot {
  pos: THREE.Vector3;
  el: HTMLDivElement;
}
const slots: Slot[] = [];
let meshes: THREE.Mesh[] = [];

function rebuild(salt: number): void {
  for (const m of meshes) {
    scene.remove(m);
    m.geometry.dispose();
  }
  meshes = [];
  for (const s of slots) s.el.remove();
  slots.length = 0;

  TREE_CATALOG.forEach((entry, i) => {
    const col = i % PER_ROW;
    const row = Math.floor(i / PER_ROW);
    // 同じ種類を 3 本並べて、個体差が出ているかを見る。
    for (let k = 0; k < 3; k++) {
      const geo = buildCatalogGeometry(entry, salt * 7919 + i * 131 + k);
      const mesh = new THREE.Mesh(geo, material);
      mesh.position.set(
        (col - (PER_ROW - 1) / 2) * SPACING + (k - 1) * 3.0,
        0,
        row * SPACING - 6,
      );
      scene.add(mesh);
      meshes.push(mesh);
      if (k === 1) {
        const el = document.createElement('div');
        el.className = 'lbl';
        const tris = geo.getAttribute('position').count / 3;
        geo.computeBoundingBox();
        const h = geo.boundingBox!.max.y - geo.boundingBox!.min.y;
        el.innerHTML = `<b>${entry.name}</b><span>${tris} 面 / ${h.toFixed(1)}m</span>`;
        labelRoot.appendChild(el);
        slots.push({ pos: mesh.position.clone(), el });
      }
    }
  });
}

let salt = 1;
rebuild(salt);

// ── 簡単な軌道カメラ ──
let yaw = 0.5;
let pitch = 0.28;
let dist = 46;
const target = new THREE.Vector3(0, 4, (Math.ceil(TREE_CATALOG.length / PER_ROW) - 1) * SPACING * 0.5);
let dragging = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
});
addEventListener('pointerup', () => {
  dragging = false;
});
addEventListener('pointermove', (e: PointerEvent) => {
  if (!dragging) return;
  yaw -= (e.clientX - lastX) * 0.005;
  pitch = Math.max(-0.15, Math.min(1.2, pitch + (e.clientY - lastY) * 0.004));
  lastX = e.clientX;
  lastY = e.clientY;
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  dist = Math.max(6, Math.min(160, dist * (1 + Math.sign(e.deltaY) * 0.1)));
}, { passive: false });
addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'r' || e.key === 'R') rebuild(++salt);
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const v = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  camera.position.set(
    target.x + Math.sin(yaw) * Math.cos(pitch) * dist,
    target.y + Math.sin(pitch) * dist,
    target.z + Math.cos(yaw) * Math.cos(pitch) * dist,
  );
  camera.lookAt(target);
  sky.update(camera);

  for (const s of slots) {
    v.copy(s.pos);
    v.y += 0.2;
    v.project(camera);
    const on = v.z < 1;
    s.el.style.display = on ? '' : 'none';
    if (on) {
      s.el.style.left = `${((v.x + 1) / 2) * innerWidth}px`;
      s.el.style.top = `${((-v.y + 1) / 2) * innerHeight + 6}px`;
    }
  }

  renderer.render(scene, camera);
});
