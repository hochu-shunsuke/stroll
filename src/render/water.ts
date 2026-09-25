import * as THREE from 'three';
import { SEA_LEVEL } from '../world/terrain';
import { RENDER_ORDER } from './order';
import { WAVE_SLOPE, createWaveTexture } from './waveTexture';

const vert = /* glsl */ `
  varying vec3 vWorld;

  #include <fog_pars_vertex>

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;

    #include <fog_vertex>
  }
`;

const frag = /* glsl */ `
  uniform float uTime;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uSkyColor;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform sampler2D uWaves;
  varying vec3 vWorld;

  #include <fog_pars_fragment>

  // 波の模様（render/waveTexture.ts）。r,g = 傾き、b = 傾きの 2 乗、a = 高さ。
  // 大きさと向きと流れる向きを変えて 3 回引く。ミップマップで遠くほど均され、
  // 均されて消えた波の傾きは「分散」として残る（照り返しの広がりに使う）。
  // **少数の正弦波の和に戻さないこと。** 周期が揃って、遠くで斜めの格子模様になる。
  void waveLayer(vec2 uv, float gain, inout vec2 slope, inout float variance, inout float height) {
    vec4 t = texture2D(uWaves, uv);
    vec2 s = (t.xy * 2.0 - 1.0) * WAVE_SLOPE;
    float meanSq = t.z * 2.0 * WAVE_SLOPE * WAVE_SLOPE;
    slope += s * gain;
    variance += max(0.0, meanSq - dot(s, s)) * gain * gain;
    height += (t.w - 0.5) * gain;
  }

  void main() {
    vec2 p = vWorld.xz;

    // 波: 数十 m のうねり、数 m の風の波、数十 cm のさざ波。大きさの比を整数にしない（繰り返しが揃わない）。
    vec2 slope = vec2(0.0);
    float variance = 0.0006;
    float height = 0.0;
    waveLayer(p / 337.0 + uTime * vec2(0.0072, 0.0031), 0.3, slope, variance, height);
    waveLayer(mat2(0.8, -0.6, 0.6, 0.8) * p / 61.0 + uTime * vec2(-0.021, 0.013), 0.35, slope, variance, height);
    waveLayer(mat2(0.28, 0.96, -0.96, 0.28) * p / 17.3 + uTime * vec2(0.047, -0.031), 0.3, slope, variance, height);
    vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));

    vec3 viewDir = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 3.0);

    // 見下ろすほど水の色、浅い角度ほど空の映り込み。うねりの山は少し明るい（遠くでは均されて消える）。
    vec3 body = mix(uDeep, uShallow, clamp(dot(n, viewDir), 0.0, 1.0) * 0.65);
    body *= 1.0 + height * 0.2;
    vec3 col = mix(body, uSkyColor, clamp(fres * 1.25, 0.0, 0.92));

    // 太陽の照り返し。波の面の傾きが、太陽を目に返す向きにどれだけ散っているかで決める
    // （傾きの分布を正規分布とみなす。Bruneton et al. 2010）。近くでは面ごとに光り、
    // 遠くでは均された波の分散で広がって、太陽の下に光の道ができる。
    vec3 h = normalize(uSunDir + viewDir);
    vec2 zeta = h.xz / max(h.y, 0.05) + slope;
    float glint = exp(-0.5 * dot(zeta, zeta) / variance) / (6.2832 * variance);
    float schlick = 0.02 + 0.98 * pow(1.0 - clamp(dot(viewDir, h), 0.0, 1.0), 5.0);
    col += uSunColor * min(glint * schlick * 0.35, 3.0);

    float alpha = mix(0.72, 0.97, fres);
    gl_FragColor = vec4(col, alpha);

    // three の標準マテリアルと同じ順序。霧の色は出力色空間で渡ってくるため最後。
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

function col(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
}

/**
 * 水の材質。海の板と、チャンクごとの内陸水面（湖）が**同じものを共有する**。
 *
 * 別々に作ると、波・色・透明度・描画順のどれかがいつかずれる。
 * この材質は頂点の世界座標だけから波と映り込みを作るので、
 * カメラ追従の板でも、湖の形をした三角形でも、そのまま動く。
 */
let shared: THREE.ShaderMaterial | null = null;

export function waterMaterial(
  sunDirection: THREE.Vector3,
  skyHorizon: number,
  sunHex: number,
): THREE.ShaderMaterial {
  if (!shared) {
    shared = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uShallow: { value: col(0x5c93a0) },
        uDeep: { value: col(0x27505e) },
        uSkyColor: { value: col(skyHorizon) },
        uSunColor: { value: col(sunHex) },
        uSunDir: { value: sunDirection.clone() },
        uWaves: { value: createWaveTexture() },
        ...THREE.UniformsLib.fog,
      },
      vertexShader: vert,
      fragmentShader: `#define WAVE_SLOPE ${WAVE_SLOPE.toFixed(3)}\n${frag}`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
      // 水際では水面と地形の深度がほぼ同じになり、画素ごとに勝敗が揺れて
      // ちらつく（Z ファイティング）。実測で海の水際の 3% が隙間 5cm 未満。
      //
      // **水を奥へ寄せる（正の値）こと。** 水は岸の内側まで張ってあり、
      // 地形に隠されて初めて水際の線ができる。手前へ寄せると水が土手を
      // 突き抜けて、水際が広がってしまう。
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 2,
    });
  }
  return shared;
}

/** 時間を進める。材質を共有しているので、呼ぶのは 1 か所でよい。 */
export function updateWaterTime(elapsed: number): void {
  if (shared) shared.uniforms.uTime.value = elapsed;
}

export class Water {
  /** チャンクごとの内陸水面（湖）も同じものを使う。 */
  readonly material: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;

  constructor(scene: THREE.Scene, sunDirection: THREE.Vector3, skyHorizon: number, sunHex: number) {
    this.material = waterMaterial(sunDirection, skyHorizon, sunHex);

    const geo = new THREE.PlaneGeometry(9000, 9000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.y = SEA_LEVEL;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = RENDER_ORDER.water;
    scene.add(this.mesh);
  }

  update(camera: THREE.Camera, elapsed: number): void {
    updateWaterTime(elapsed);
    // 波は世界座標で計算しているので、面をずらしても模様は動かない。
    this.mesh.position.x = camera.position.x;
    this.mesh.position.z = camera.position.z;
  }

}
