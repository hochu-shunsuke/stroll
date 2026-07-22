import * as THREE from 'three';
import { vegetation } from './vegetation';
import { CHUNK_SIZE, LOD_RINGS } from '../world/chunk';
import type { BuiltChunk, WorkerRequest } from '../world/worker';

const MAX_RING = LOD_RINGS[LOD_RINGS.length - 1];

interface Chunk {
  mesh: THREE.Mesh;
  scatter: THREE.Group | null;
  lod: number;
  cx: number;
  cz: number;
}

interface Pending {
  key: string;
  cx: number;
  cz: number;
  lod: number;
  dist: number;
}

/**
 * プレイヤーの周りのチャンクを、距離に応じた粗さで出し入れする。
 * 生成は Worker に投げるので、歩いている間にカクつかない。
 */
export class ChunkManager {
  private scene: THREE.Scene;
  private material: THREE.Material;
  private chunks = new Map<string, Chunk>();
  private inFlight = new Map<number, string>();
  private queue: Pending[] = [];
  private workers: Worker[] = [];
  private freeWorkers: Worker[] = [];
  private nextId = 1;
  private lastChunkX = Number.NaN;
  private lastChunkZ = Number.NaN;

  /** 足元付近のチャンクが揃ったか（開始画面を閉じる判定に使う）。 */
  ready = false;

  constructor(scene: THREE.Scene, seed: string) {
    this.scene = scene;
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });

    const count = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('../world/worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<BuiltChunk>) => this.onBuilt(w, ev.data);
      w.postMessage({ type: 'init', seed } satisfies WorkerRequest);
      this.workers.push(w);
      this.freeWorkers.push(w);
    }
  }

  private key(cx: number, cz: number): string {
    return `${cx},${cz}`;
  }

  /** チェビシェフ距離から、そのチャンクを作るべき粗さを決める。範囲外は -1。 */
  private lodFor(dist: number): number {
    for (let i = 0; i < LOD_RINGS.length; i++) {
      if (dist <= LOD_RINGS[i]) return i;
    }
    return -1;
  }

  update(x: number, z: number): void {
    const pcx = Math.floor(x / CHUNK_SIZE);
    const pcz = Math.floor(z / CHUNK_SIZE);

    // プレイヤーが別のチャンクへ移った時だけ、必要な差分を洗い直す。
    if (pcx !== this.lastChunkX || pcz !== this.lastChunkZ) {
      this.lastChunkX = pcx;
      this.lastChunkZ = pcz;
      this.rebuildQueue(pcx, pcz);
      this.evict(pcx, pcz);
    }

    this.dispatch();

    if (!this.ready) {
      // 中心の 3x3 が揃えば歩き始められる。
      let ok = true;
      for (let dx = -1; dx <= 1 && ok; dx++) {
        for (let dz = -1; dz <= 1 && ok; dz++) {
          if (!this.chunks.has(this.key(pcx + dx, pcz + dz))) ok = false;
        }
      }
      this.ready = ok;
    }
  }

  private rebuildQueue(pcx: number, pcz: number): void {
    this.queue.length = 0;
    for (let dz = -MAX_RING; dz <= MAX_RING; dz++) {
      for (let dx = -MAX_RING; dx <= MAX_RING; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dz));
        const lod = this.lodFor(dist);
        if (lod < 0) continue;

        const cx = pcx + dx;
        const cz = pcz + dz;
        const key = this.key(cx, cz);
        const existing = this.chunks.get(key);
        if (existing && existing.lod === lod) continue;
        this.queue.push({ key, cx, cz, lod, dist });
      }
    }
    // 近いものから作る。
    this.queue.sort((a, b) => a.dist - b.dist);
  }

  private dispatch(): void {
    while (this.freeWorkers.length > 0 && this.queue.length > 0) {
      const job = this.queue.shift()!;

      // 既に同じ粗さで作り終えている／作成中なら飛ばす。
      const existing = this.chunks.get(job.key);
      if (existing && existing.lod === job.lod) continue;
      let already = false;
      for (const k of this.inFlight.values()) {
        if (k === job.key) { already = true; break; }
      }
      if (already) continue;

      const w = this.freeWorkers.pop()!;
      const id = this.nextId++;
      this.inFlight.set(id, job.key);
      w.postMessage({ type: 'build', id, cx: job.cx, cz: job.cz, lod: job.lod } satisfies WorkerRequest);
    }
  }

  private onBuilt(w: Worker, data: BuiltChunk): void {
    this.freeWorkers.push(w);
    this.inFlight.delete(data.id);

    const key = this.key(data.cx, data.cz);

    // 届いた頃には遠ざかっていることがある。その場合は捨てる。
    const dist = Math.max(
      Math.abs(data.cx - this.lastChunkX),
      Math.abs(data.cz - this.lastChunkZ),
    );
    const desired = this.lodFor(dist);
    if (desired < 0) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(data.color, 3));
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(data.cx * CHUNK_SIZE, 0, data.cz * CHUNK_SIZE);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    let scatter: THREE.Group | null = null;
    if (data.batches.length > 0) {
      const veg = vegetation();
      scatter = new THREE.Group();
      scatter.position.copy(mesh.position);
      scatter.matrixAutoUpdate = false;
      scatter.updateMatrix();
      for (const b of data.batches) {
        const n = b.matrices.length / 16;
        const inst = new THREE.InstancedMesh(veg.geometries[b.kind], veg.material, n);
        inst.instanceMatrix = new THREE.InstancedBufferAttribute(b.matrices, 16);
        inst.instanceColor = new THREE.InstancedBufferAttribute(b.colors, 3);
        inst.instanceMatrix.needsUpdate = true;
        inst.computeBoundingSphere();
        scatter.add(inst);
      }
    }

    // 差し替えは新しいものを足してから古いものを外す（一瞬の穴を作らないため）。
    this.scene.add(mesh);
    if (scatter) this.scene.add(scatter);

    const old = this.chunks.get(key);
    if (old) this.disposeChunk(old);

    this.chunks.set(key, { mesh, scatter, lod: data.lod, cx: data.cx, cz: data.cz });

    // 生成中にプレイヤーが動いて、必要な粗さが変わっていることがある。
    // ここで積み直さないと、次にチャンク境界を跨ぐまで粗いまま残る。
    if (desired !== data.lod) {
      this.queue.push({ key, cx: data.cx, cz: data.cz, lod: desired, dist });
      this.queue.sort((a, b) => a.dist - b.dist);
    }
  }

  private evict(pcx: number, pcz: number): void {
    for (const [key, chunk] of this.chunks) {
      const dist = Math.max(Math.abs(chunk.cx - pcx), Math.abs(chunk.cz - pcz));
      if (dist > MAX_RING) {
        this.disposeChunk(chunk);
        this.chunks.delete(key);
      }
    }
  }

  private disposeChunk(chunk: Chunk): void {
    this.scene.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
    if (chunk.scatter) {
      this.scene.remove(chunk.scatter);
      for (const child of chunk.scatter.children) {
        // ジオメトリと材質は共有なので、インスタンス側だけ解放する。
        if (child instanceof THREE.InstancedMesh) child.dispose();
      }
    }
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    for (const chunk of this.chunks.values()) this.disposeChunk(chunk);
    this.chunks.clear();
    this.material.dispose();
  }

}
