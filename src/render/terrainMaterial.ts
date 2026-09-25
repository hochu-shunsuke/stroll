import * as THREE from 'three';
import { C_SNOW } from '../world/surfaceShade';
import { NOISE_CELLS, createNoiseTexture } from './noiseTexture';

/**
 * 地面の材質。チャンクの頂点は 3 つの層を持つ（world/surfaceShade.ts）──
 * 土台の色、岩の色、岩と雪の量。ここで画素ごとに混ぜる。
 *
 * **境目は画素ごとに、世界座標のノイズで揺らしてから切る。** 四角形ごとに 1 色で塗っていた頃は、
 * 雪と岩の境が格子に揃って階段と市松模様になった（遠くの粗いチャンクほど四角が大きい）。
 * 量は頂点の間でなめらかにつながるので、境目は格子と関係なく自然な線になる。
 *
 * ローポリの見た目（面ごとの陰影と、面ごとのわずかな明暗）はそのまま残す。
 * 面の明暗は雪の上では弱める。強いままだと、白い雪原に灰色の四角が並ぶ。
 *
 * ノイズは起動時に作ったテクスチャから引く（render/noiseTexture.ts）。画素ごとに計算するより軽く、
 * 細かすぎる模様はミップマップが均すので、遠くでちらつかない。崖では模様が縦に引き伸ばされないよう、
 * 面の向きに合わせて 3 方向から貼って混ぜる。
 */

const SNOW = new THREE.Vector3(C_SNOW[0], C_SNOW[1], C_SNOW[2]);

let noise: THREE.DataTexture | null = null;

const PARS_VERTEX = /* glsl */ `
  attribute vec3 rock;
  attribute vec3 surf;
  varying vec3 vRock;
  varying vec3 vSurf;
  varying vec3 vTerrainPos;
  varying vec3 vTerrainNormal;
`;

const VERTEX = /* glsl */ `
  vRock = rock;
  vSurf = surf;
  vTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);
`;

const PARS_FRAGMENT = /* glsl */ `
  uniform vec3 uSnow;
  uniform sampler2D uNoise;
  varying vec3 vRock;
  varying vec3 vSurf;
  varying vec3 vTerrainPos;
  varying vec3 vTerrainNormal;

  // 1 マス cell（m）の大きさで、4 つの独立なノイズ（中心 0）を引く。w は 3 方向の重み。
  vec4 terrainNoise(vec3 pos, vec3 w, float cell, mat2 turn) {
    float s = 1.0 / (cell * NOISE_CELLS);
    vec4 top = texture2D(uNoise, turn * pos.xz * s);
    vec4 front = texture2D(uNoise, turn * pos.xy * s + 0.37);
    vec4 side = texture2D(uNoise, turn * pos.zy * s + 0.71);
    return top * w.y + front * w.z + side * w.x - 0.5;
  }
  // 境目を揺らしてから切る。量が 0 や 1 の所は揺らさない。soft は境目の幅（0.5 で元の混ぜ方と同じ）。
  float terrainCut(float amount, float wobble, float soft) {
    return smoothstep(0.5 - soft, 0.5 + soft, amount + wobble * 4.0 * amount * (1.0 - amount));
  }
`;

const COLOR_FRAGMENT = /* glsl */ `
  vec3 tw = pow(abs(normalize(vTerrainNormal)), vec3(4.0));
  tw /= tw.x + tw.y + tw.z;
  // 数十 m のまとまりと、数 m の細かいぎざぎざ。大きさの比を整数にせず、向きも回す。
  float wobble = terrainNoise(vTerrainPos, tw, 21.0, mat2(1.0, 0.0, 0.0, 1.0)).r * 0.55
    + terrainNoise(vTerrainPos, tw, 5.3, mat2(0.8, -0.6, 0.6, 0.8)).r * 0.35
    + terrainNoise(vTerrainPos, tw, 1.45, mat2(0.28, 0.96, -0.96, 0.28)).r * 0.18;
  // 雪の縁ははっきり、岩と土の境は柔らかく（落ち着いた色調を保つ）。
  float rockMask = terrainCut(vSurf.x, wobble, 0.22);
  float snowMask = terrainCut(vSurf.y, wobble * 0.8 - 0.05, 0.1);
  vec3 albedo = mix(mix(vColor.rgb, vRock, rockMask), uSnow, snowMask);
  // 面の明暗は ÷2 で詰めてある（1 を越える明るい面があるため）。
  float face = vSurf.z * 2.0;
  face = mix(face, 1.0 - (1.0 - face) * 0.35, snowMask);
  diffuseColor.rgb *= albedo * face;
`;

export function createTerrainMaterial(): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader) => {
    noise ??= createNoiseTexture();
    shader.uniforms.uSnow = { value: SNOW };
    shader.uniforms.uNoise = { value: noise };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PARS_VERTEX}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n#define NOISE_CELLS ${NOISE_CELLS.toFixed(1)}\n${PARS_FRAGMENT}`,
      )
      .replace('#include <color_fragment>', COLOR_FRAGMENT);
  };
  material.customProgramCacheKey = () => 'terrain-layers';
  return material;
}
