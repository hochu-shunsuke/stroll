/// <reference lib="webworker" />
import { bakeLighting } from './lighting';
import { Terrain } from './terrain';

/**
 * カメラの周りの地図を作る Worker（render/regionField.ts が使う）。
 * 地面の高さを格子で引き、そこから太陽の影と空の見え方を焼き込む。
 * 高さは海のシェーダーが水深（海の色・岸の泡）に、光は地面と木の材質が使う。
 * チャンクの Worker とは分ける（チャンクの生成を待たせないため）。
 */

export interface FieldInit {
  type: 'init';
  seed: string;
}

export interface FieldRequest {
  type: 'field';
  id: number;
  /** 地図の中心（世界座標、m）と一辺（m）、1 辺の点数。 */
  cx: number;
  cz: number;
  size: number;
  n: number;
  /** 太陽へ向かう単位ベクトル。 */
  sun: [number, number, number];
}

export interface FieldResult {
  id: number;
  cx: number;
  cz: number;
  size: number;
  n: number;
  height: Float32Array;
  /** [太陽が当たる割合, 空が見える割合] を 0..255 で 2 つずつ。 */
  light: Uint8Array;
  ms: number;
}

let terrain: Terrain | null = null;

self.onmessage = (ev: MessageEvent<FieldInit | FieldRequest>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    terrain = new Terrain(msg.seed);
    return;
  }
  if (!terrain) return;
  const started = performance.now();
  const { id, cx, cz, size, n, sun } = msg;
  const height = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = cz + (j / (n - 1) - 0.5) * size;
    for (let i = 0; i < n; i++) {
      height[j * n + i] = terrain.heightAt(cx + (i / (n - 1) - 0.5) * size, z);
    }
  }
  const { data } = bakeLighting(height, n, size / (n - 1), sun);
  const result: FieldResult = { id, cx, cz, size, n, height, light: data, ms: performance.now() - started };
  (self as unknown as Worker).postMessage(result, [height.buffer, data.buffer]);
};
