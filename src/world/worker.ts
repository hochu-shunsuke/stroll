/// <reference lib="webworker" />
import { LOD_STEPS, buildChunkArrays } from './chunk';
import { buildScatterData } from './scatter';
import { Terrain } from './terrain';

export interface BuildRequest {
  type: 'build';
  id: number;
  cx: number;
  cz: number;
  lod: number;
}

export type WorkerRequest = { type: 'init'; seed: string } | BuildRequest;

export interface BuiltBatch {
  kind: number;
  matrices: Float32Array;
  colors: Float32Array;
}

export interface BuiltChunk {
  type: 'built';
  id: number;
  cx: number;
  cz: number;
  lod: number;
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  batches: BuiltBatch[];
}

let terrain: Terrain | null = null;

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;

  if (msg.type === 'init') {
    terrain = new Terrain(msg.seed);
    return;
  }

  if (!terrain) return;

  const { id, cx, cz, lod } = msg;
  const geo = buildChunkArrays(terrain, cx, cz, LOD_STEPS[lod]);
  const batches = buildScatterData(terrain, cx, cz, lod);

  const payload: BuiltChunk = {
    type: 'built',
    id, cx, cz, lod,
    position: geo.position,
    normal: geo.normal,
    color: geo.color,
    batches,
  };

  // 転送してコピーを避ける（生成した配列はこの後 Worker 側では使わない）。
  const transfer: Transferable[] = [
    geo.position.buffer as ArrayBuffer,
    geo.normal.buffer as ArrayBuffer,
    geo.color.buffer as ArrayBuffer,
  ];
  for (const b of batches) {
    transfer.push(b.matrices.buffer as ArrayBuffer, b.colors.buffer as ArrayBuffer);
  }

  (self as unknown as Worker).postMessage(payload, transfer);
};
