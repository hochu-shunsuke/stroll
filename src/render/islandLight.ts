import * as THREE from 'three';
import type { BakedLighting } from '../world/lighting';

/**
 * 焼き込んだ光（world/lighting.ts、カメラの周りの地図。render/regionField.ts）を描画に渡す。
 * 地面と木が同じものを引く。hakoniwa と同じ作り。
 *
 * 太陽の影は直接光だけに、空の見え方は環境光（空と地面の照り返し）だけに掛ける。
 * 影の中でも空からの光は届くので、真っ黒にはならない。
 * uniform は全部の材質で同じ物を共有する。setIslandLight() で差し替えれば全部に行き渡る。
 */

/** 影の中に残す直接光の割合。 */
const SHADOW_FILL = 0.15;
/** 影の中で空の光（青い環境光）を足す割合。 */
const SHADOW_SKY = 0.45;
/** 空の見え方（谷の暗さ）の効き。1 で測った通り。 */
const SKY_STRENGTH = 0.8;
/** 光が届いたとき、影を浮かび上がらせる時間（秒）。島を見せてから光が遅れて届くため。 */
const FADE_IN = 0.6;

export const islandLightUniforms = {
  uIslandLight: { value: null as THREE.DataTexture | null },
  uIslandLightN: { value: 2 },
  uIslandLightOn: { value: 0 },
  /** 光の格子の中心と一辺（m）。 */
  uIslandLightOrigin: { value: new THREE.Vector2() },
  uIslandLightSize: { value: 1 },
};

/** 断片シェーダーの宣言。islandLightAt(xz) は [太陽が当たる割合, 空が見える割合]。地図の外は両方 1。 */
export const ISLAND_LIGHT_PARS = /* glsl */ `
  uniform sampler2D uIslandLight;
  uniform float uIslandLightN;
  uniform float uIslandLightOn;
  uniform vec2 uIslandLightOrigin;
  uniform float uIslandLightSize;
  vec2 islandLightAt(vec2 xz) {
    if (uIslandLightOn <= 0.0) return vec2(1.0);
    vec2 uv = (xz - uIslandLightOrigin) / uIslandLightSize + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec2(1.0);
    // 格子の点が画素の中心に来るように。
    uv = (uv * (uIslandLightN - 1.0) + 0.5) / uIslandLightN;
    return mix(vec2(1.0), texture2D(uIslandLight, uv).rg, uIslandLightOn);
  }
`;

/**
 * 光を掛ける文。xz は光を引く世界座標の式。
 * 影はただ暗くせず、空の青い光で照らされた色にする（朝日の影が青く見えるのと同じ）。
 * 直接光を消すだけだと、朝日が低くて山の影が島の半分を覆うため、緑が濁って島全体が沈んだ。
 */
function islandLightApply(xz: string): string {
  return /* glsl */ `
    vec2 islandLit = islandLightAt(${xz});
    float islandShade = 1.0 - islandLit.x;
    reflectedLight.directDiffuse *= 1.0 - islandShade * ${(1 - SHADOW_FILL).toFixed(2)};
    reflectedLight.indirectDiffuse *= mix(1.0, islandLit.y, ${SKY_STRENGTH.toFixed(2)})
      * (1.0 + islandShade * ${SHADOW_SKY.toFixed(2)});
  `;
}

/** Lambert 系の材質のシェーダーに、島の光を差し込む。xz は断片シェーダーで使える世界座標の式。 */
export function injectIslandLight(shader: THREE.WebGLProgramParametersWithUniforms, xz: string): void {
  Object.assign(shader.uniforms, islandLightUniforms);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${ISLAND_LIGHT_PARS}`)
    .replace('#include <aomap_fragment>', `${islandLightApply(xz)}\n#include <aomap_fragment>`);
}

/**
 * 光を差し替える。格子は (originX, originZ) を中心に一辺 size m。
 * 地図を作り直しても重なる所の値は同じなので、差し替えで景色は跳ばない。
 */
export function setIslandLight(lighting: BakedLighting, size: number, originX: number, originZ: number): void {
  const u = islandLightUniforms;
  u.uIslandLightSize.value = size;
  u.uIslandLightOrigin.value.set(originX, originZ);
  const wasOff = u.uIslandLight.value === null;
  u.uIslandLight.value?.dispose();
  const { n, data } = lighting;
  const tex = new THREE.DataTexture(data, n, n, THREE.RGFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  u.uIslandLight.value = tex;
  u.uIslandLightN.value = n;
  if (wasOff) u.uIslandLightOn.value = 0;
}

/** 毎フレーム呼ぶ。光が届いた直後だけ、影をゆっくり浮かび上がらせる。 */
export function updateIslandLight(dt: number): void {
  const u = islandLightUniforms;
  if (u.uIslandLight.value && u.uIslandLightOn.value < 1) {
    u.uIslandLightOn.value = Math.min(1, u.uIslandLightOn.value + dt / FADE_IN);
  }
}
