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
  uniform vec3 uMid;
  uniform vec3 uDeep;
  uniform vec3 uSkyColor;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform sampler2D uHeightMap;
  uniform float uHeightN;
  uniform float uIslandSize;
  uniform vec2 uHeightOrigin;
  uniform sampler2D uWaves;
  varying vec3 vWorld;

  #include <fog_pars_fragment>

  // 波の模様（render/waveTexture.ts）。r,g = 傾き、b = 傾きの 2 乗、a = 高さ。
  // 大きさと向きと流れる向きを変えて 3 回引く。ミップマップで遠くほど均され、
  // 均されて消えた波の傾きは「分散」として残る（照り返しの広がりに使う）。
  void waveLayer(vec2 uv, float gain, inout vec2 slope, inout float variance, inout float height) {
    vec4 t = texture2D(uWaves, uv);
    vec2 s = (t.xy * 2.0 - 1.0) * WAVE_SLOPE;
    float meanSq = t.z * 2.0 * WAVE_SLOPE * WAVE_SLOPE;
    slope += s * gain;
    variance += max(0.0, meanSq - dot(s, s)) * gain * gain;
    height += (t.w - 0.5) * gain;
  }

  // 地面の高さ（m）。格子の 4 点を読んで双一次で補間する（浮動小数のテクスチャは
  // 端末によって線形補間できないため、自分で混ぜる）。格子の外は外洋の深さ。
  // 格子は uHeightOrigin を中心に一辺 uIslandSize（カメラの周りの地図。render/regionField.ts）。
  float groundAt(vec2 xz) {
    if (uHeightN < 2.0) return -70.0;
    vec2 g = ((xz - uHeightOrigin) / uIslandSize + 0.5) * (uHeightN - 1.0);
    if (g.x < 0.0 || g.y < 0.0 || g.x > uHeightN - 1.0 || g.y > uHeightN - 1.0) return -70.0;
    vec2 i = min(floor(g), vec2(uHeightN - 2.0));
    vec2 f = g - i;
    ivec2 c = ivec2(i);
    float a = texelFetch(uHeightMap, c, 0).r;
    float b = texelFetch(uHeightMap, c + ivec2(1, 0), 0).r;
    float d = texelFetch(uHeightMap, c + ivec2(0, 1), 0).r;
    float e = texelFetch(uHeightMap, c + ivec2(1, 1), 0).r;
    return mix(mix(a, b, f.x), mix(d, e, f.x), f.y);
  }

  // 泡の粒。小さい座標だけで引く（スマホ GPU の精度でも崩れないように）。
  float hash12(vec2 p) {
    p = mod(p, 97.0);
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
               mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  void main() {
    vec2 p = vWorld.xz;

    // 波: 数十 m のうねり、数 m の風の波、数十 cm のさざ波。大きさの比を整数にしない（繰り返しが揃わない）。
    // 流れる速さは実際の波（長いほど速い）に寄せつつ、テクスチャが滑って見えない程度に抑える。
    vec2 slope = vec2(0.0);
    float variance = 0.0006;
    float height = 0.0;
    waveLayer(p / 337.0 + uTime * vec2(0.0072, 0.0031), 0.3, slope, variance, height);
    waveLayer(mat2(0.8, -0.6, 0.6, 0.8) * p / 61.0 + uTime * vec2(-0.021, 0.013), 0.35, slope, variance, height);
    waveLayer(mat2(0.28, 0.96, -0.96, 0.28) * p / 17.3 + uTime * vec2(0.047, -0.031), 0.3, slope, variance, height);
    vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));

    vec3 viewDir = normalize(cameraPosition - vWorld);
    float facing = clamp(dot(n, viewDir), 0.0, 1.0);
    float fres = pow(1.0 - facing, 3.0);

    // 水深で色を変える。浅瀬は明るいエメラルドで底が透け、深みは濃い青に沈む。
    float depth = max(0.0, vWorld.y - groundAt(p));
    vec3 body = mix(uShallow, uMid, smoothstep(0.4, 7.0, depth));
    body = mix(body, uDeep, smoothstep(7.0, 45.0, depth));
    body *= mix(0.85, 1.0, facing);
    // うねりの山は少し明るく、谷は少し暗く（遠くでは均されて消える）。
    body *= 1.0 + height * 0.25 * smoothstep(3.0, 15.0, depth);
    vec3 col = mix(body, uSkyColor, clamp(fres * 1.1, 0.0, 0.85));

    // 太陽の照り返し。波の面の傾きが、太陽を目に返す向きにどれだけ散っているかで決める
    // （傾きの分布を正規分布とみなす。Bruneton et al. 2010）。近くでは面ごとに光り、
    // 遠くでは均された波の分散で広がって、太陽の下に光の道ができる。
    vec3 h = normalize(uSunDir + viewDir);
    vec2 zeta = h.xz / max(h.y, 0.05) + slope;
    float glint = exp(-0.5 * dot(zeta, zeta) / variance) / (6.2832 * variance);
    float schlick = 0.02 + 0.98 * pow(1.0 - clamp(dot(viewDir, h), 0.0, 1.0), 5.0);
    col += uSunColor * min(glint * schlick * 0.35, 3.0);

    // 波打ち際の泡: 水際から数 m の帯と、岸へ寄せてくる白波の筋。
    // **水深ではなく、水際からの距離で置く。** 水深で「0.1〜1.4m」と決めると、遠浅の浜では
    // その帯が数十 m に広がり、砂浜に白い影が染み出して見えた（利用者の指摘）。
    // 距離は 水深 ÷ 海底の傾き で見積もる。傾きを引くのは浅い所だけ（深い所は泡が無いので飛ばす）。
    // 水深 0 のちょうど上には置かない。地面との描き合いで泡ごとちらつく。
    float foam = 0.0;
    float grain = 0.5;
    if (depth < 4.0) {
      float probe = uIslandSize / (uHeightN - 1.0) * 0.5;
      vec2 grad = vec2(
        groundAt(p + vec2(probe, 0.0)) - groundAt(p - vec2(probe, 0.0)),
        groundAt(p + vec2(0.0, probe)) - groundAt(p - vec2(0.0, probe))
      ) / (2.0 * probe);
      float shore = depth / max(length(grad), 0.02);
      grain = vnoise(p * 0.18 + vec2(uTime * 0.25, -uTime * 0.18));
      float band = smoothstep(0.08, 0.3, depth) * (1.0 - smoothstep(2.5 + grain * 3.0, 6.0 + grain * 3.0, shore));
      float surf = sin(shore * 0.42 - uTime * 1.3 + grain * 3.0);
      float lines = smoothstep(0.78, 0.97, surf) * smoothstep(3.0, 7.0, shore) * (1.0 - smoothstep(14.0, 26.0, shore))
        * smoothstep(0.2, 0.5, depth) * (1.0 - smoothstep(0.9, 1.8, depth));
      foam = clamp(max(band * (0.55 + 0.45 * grain), lines * 0.55), 0.0, 1.0);
      // 波が寄せるのは海だけ。川と湖（海面より高い水）では、岸にうっすらした縁だけ残す。
      // 海と同じ泡を立てると、川の両岸が白い土手のように見えた。
      if (vWorld.y > 0.5) foam = band * (1.0 - smoothstep(0.8, 2.0, shore)) * 0.3;
    }
    col = mix(col, vec3(0.95, 0.97, 0.98), foam * 0.85);

    // 浅いほど透けて底が見える。深い所と、斜めから見た所は映り込みで不透明に近づく。
    float alpha = mix(0.45, 0.94, smoothstep(0.3, 10.0, depth));
    alpha = max(alpha, fres * 0.95);
    alpha = max(alpha, foam * 0.9);
    // 水深 0 に近づくほど透明にする。水面と地面の深度がほぼ同じ帯は、どちらが手前か
    // 描くたびに入れ替わる。そこで水を消しておけば、ちらつきが見えない。
    alpha *= smoothstep(0.0, 0.12, depth);
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
        // 浅瀬のエメラルド → 中くらいの青緑 → 深い青（hakoniwa と同じ）。
        uShallow: { value: col(0x5fd3c4) },
        uMid: { value: col(0x1f9bb0) },
        uDeep: { value: col(0x1a4f7c) },
        // カメラの周りの地面の高さ（水深を求める。render/regionField.ts が作る）。
        // 届くまでは空で、全部を深い海として描く。
        uHeightMap: { value: null as THREE.Texture | null },
        uHeightN: { value: 0 },
        uIslandSize: { value: 1 },
        uHeightOrigin: { value: new THREE.Vector2() },
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

  /**
   * 地面の高さの格子を渡す（水深で海の色と岸の泡を決めるため）。
   * 格子は (originX, originZ) を中心に一辺 size m（カメラの周りの地図。render/regionField.ts）。
   */
  setHeightMap(height: Float32Array, n: number, size: number, originX: number, originZ: number): void {
    const u = this.material.uniforms;
    (u.uHeightMap.value as THREE.Texture | null)?.dispose();
    const tex = new THREE.DataTexture(height, n, n, THREE.RedFormat, THREE.FloatType);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    u.uHeightMap.value = tex;
    u.uHeightN.value = n;
    u.uIslandSize.value = size;
    (u.uHeightOrigin.value as THREE.Vector2).set(originX, originZ);
  }

  update(camera: THREE.Camera, elapsed: number): void {
    updateWaterTime(elapsed);
    // 波は世界座標で計算しているので、面をずらしても模様は動かない。
    this.mesh.position.x = camera.position.x;
    this.mesh.position.z = camera.position.z;
  }

}
