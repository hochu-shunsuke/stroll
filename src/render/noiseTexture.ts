import * as THREE from 'three';
import { mulberry32 } from '../core/rng';

/**
 * 地面の細かい質感に使うノイズ。起動時に 1 度だけ作る 256² のテクスチャで、
 * 4 つの色の通り道に別々のなめらかなノイズ（1 周 32 マス、上下左右がつながる）を入れる。
 *
 * **シェーダーの中でノイズを計算しない。** 画素ごとに 12 段のノイズ（1 段でハッシュ 4 回）を
 * 計算すると、このテクスチャを引く形より約 1.4 倍重かった（M3、全面の描画を交互に測った中央値）。
 * テクスチャを大きさを変えて 3 回引けば、12 個のノイズが揃う。遠くの細かすぎる模様は
 * ミップマップが均すので、ちらつきを消す計算も要らない。
 *
 * 表示専用なので決定性の決まりの外（島ごとに変える必要もない）。
 */

const SIZE = 256;
/** 1 周のマス数。1 マス = SIZE / CELLS 画素。 */
export const NOISE_CELLS = 32;

export function createNoiseTexture(): THREE.DataTexture {
  const rand = mulberry32(0x6e01_5e11);
  const grids = [0, 1, 2, 3].map(() => Float32Array.from({ length: NOISE_CELLS * NOISE_CELLS }, rand));
  const data = new Uint8Array(SIZE * SIZE * 4);
  const per = SIZE / NOISE_CELLS;
  const fade = (t: number) => t * t * (3 - 2 * t);
  for (let j = 0; j < SIZE; j++) {
    const v = j / per;
    const j0 = Math.floor(v);
    const fv = fade(v - j0);
    const j1 = (j0 + 1) % NOISE_CELLS;
    for (let i = 0; i < SIZE; i++) {
      const u = i / per;
      const i0 = Math.floor(u);
      const fu = fade(u - i0);
      const i1 = (i0 + 1) % NOISE_CELLS;
      for (let c = 0; c < 4; c++) {
        const g = grids[c];
        const a = g[j0 * NOISE_CELLS + i0];
        const b = g[j0 * NOISE_CELLS + i1];
        const d = g[j1 * NOISE_CELLS + i0];
        const e = g[j1 * NOISE_CELLS + i1];
        const value = (a + (b - a) * fu) * (1 - fv) + (d + (e - d) * fu) * fv;
        data[(j * SIZE + i) * 4 + c] = Math.round(value * 255);
      }
    }
  }
  const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
