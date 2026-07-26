import * as THREE from 'three';
import { RENDER_ORDER } from './order';

const vert = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const frag = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  varying vec3 vDir;

  void main() {
    vec3 d = normalize(vDir);

    // 天頂へ向かうほど濃い青に。指数を寝かせて地平付近を広く取る。
    float t = pow(clamp(d.y, 0.0, 1.0), 0.62);
    vec3 col = mix(uHorizon, uZenith, t);

    // 地平線より下は霞んだ地面色へ落として、遠景と繋げる。
    col = mix(col, uGround, smoothstep(0.0, -0.12, d.y));

    // 太陽の方向だけ地平が暖かくなる。
    float sd = max(dot(d, uSunDir), 0.0);
    col += uSunColor * pow(sd, 4.0) * 0.10 * (1.0 - t);
    col += uSunColor * pow(sd, 64.0) * 0.35;
    col += uSunColor * pow(sd, 2200.0) * 3.0;

    gl_FragColor = vec4(col, 1.0);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** sRGB の 16 進を three の作業色空間へ。 */
function col(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
}

export interface SkyPreset {
  zenith: number;
  horizon: number;
  ground: number;
  sun: number;
  /** 太陽の仰角（度）。低いほど面の向きによる明暗の差が開く。 */
  elevation: number;
  /** 太陽の方位（度）。 */
  azimuth: number;
  sunIntensity: number;
  ambientSky: number;
  ambientGround: number;
  ambientIntensity: number;
  fogDensity: number;
  /** この高さより上は霧が普通の濃さに戻る（m）。 */
  fogHeightTop: number;
  /** 海抜 0m での霧の増し方。1.0 なら濃さが 2 倍。 */
  fogHeightBoost: number;
}

/**
 * 朝もや。太陽を低くして面ごとの明暗を開き、低い土地に靄を溜める。
 *
 * 仰角を 34° から 13° に下げたぶん、平らな地面が受ける光は 1/2.5 になる。
 * sunIntensity を上げているのはそれを戻すため。結果として「平らな面は控えめ、
 * 太陽を向いた斜面は強く」となり、同じ地形でも起伏が読めるようになる。
 */
export const MORNING: SkyPreset = {
  zenith: 0x6c9ad9,
  // 地平は白〜桜色の靄。霧の色もこれを使うので、遠景がそのまま空へ溶ける。
  horizon: 0xf2e4dc,
  ground: 0xdccfc4,
  // 低い朝日。淡い金。
  sun: 0xffd9a8,
  elevation: 13,
  azimuth: 128,
  sunIntensity: 4.2,
  ambientSky: 0xa9c8e8,
  ambientGround: 0x6f6d58,
  // 環境光を下げて、太陽に仕事をさせる。下げすぎると朝の柔らかさが消える。
  ambientIntensity: 0.85,
  // 400m で約 14%、1200m で約 75% 霞む。以前は 400m で 5% しか霞まず、
  // 遠くの山が手前の丘と同じ濃さで描かれて奥行きが潰れていた。
  fogDensity: 0.00095,
  fogHeightTop: 32,
  fogHeightBoost: 1.1,
};

// ---------------------------------------------------------------------------
// 高さで濃くなる霧
//
// three の霧は距離だけで決まるので、低い土地に朝もやを溜められない。
// 霧の計算そのもの（ShaderChunk）を差し替えて、断片の「高さ」も見るようにする。
//
// 差し替えを 1 か所に集めているのは、地形・植生・水面がそれぞれ別のマテリアルで、
// 材質ごとに足すと 3 か所が独立に同じ判断をすることになるため。ここだけで決める。
//
// 触るときの注意:
//  - 濃さと高さは**シェーダに直接埋め込んでいる**。uniform にすると three が
//    霧の uniform を配る仕組み（scene.fog 由来の色と濃さだけ）に乗らず、
//    マテリアルによって値が届いたり届かなかったりする。
//  - 使えるのは `position` と `modelMatrix` だけ。水面は独自の頂点シェーダで
//    `transformed` を持たない。`instanceMatrix` は植生（InstancedMesh）にしか無い。
//  - FogExp2 前提で書いている（線形の Fog に変えると fogDensity が来ず落ちる）。
//    scene.fog をこのファイルで作っているので、対応関係はここで閉じている。
// ---------------------------------------------------------------------------
let heightFogInstalled = false;

function installHeightFog(preset: SkyPreset): void {
  if (heightFogInstalled) return;
  heightFogInstalled = true;

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
    #ifdef USE_FOG
      varying float vFogDepth;
      varying float vFogHeight;
    #endif
  `;

  THREE.ShaderChunk.fog_vertex = /* glsl */ `
    #ifdef USE_FOG
      vFogDepth = - mvPosition.z;
      vec4 fogWorldPos = vec4( position, 1.0 );
      #ifdef USE_INSTANCING
        fogWorldPos = instanceMatrix * fogWorldPos;
      #endif
      vFogHeight = ( modelMatrix * fogWorldPos ).y;
    #endif
  `;

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
    #ifdef USE_FOG
      uniform vec3 fogColor;
      uniform float fogDensity;
      varying float vFogDepth;
      varying float vFogHeight;
    #endif
  `;

  THREE.ShaderChunk.fog_fragment = /* glsl */ `
    #ifdef USE_FOG
      // 低い土地ほど霧が濃い。丘は靄の上に抜け、水際と低地に残る。
      float fogLow = 1.0 - smoothstep( 0.0, ${preset.fogHeightTop.toFixed(1)}, vFogHeight );
      float fogD = fogDensity * ( 1.0 + ${preset.fogHeightBoost.toFixed(2)} * fogLow );
      float fogFactor = 1.0 - exp( - fogD * fogD * vFogDepth * vFogDepth );
      gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
    #endif
  `;
}

/**
 * 空・光・霧をまとめて管理する。
 * 空のドームはカメラに追従させるので、どこまで歩いても抜けない。
 */
export class Sky {
  readonly sunDirection = new THREE.Vector3();
  private mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private sunLight: THREE.DirectionalLight;
  private ambient: THREE.HemisphereLight;

  constructor(scene: THREE.Scene, preset: SkyPreset = MORNING) {
    // マテリアルが 1 つも作られる前に済ませる。シェーダは最初の描画で組まれるので
    // ここで十分だが、霧を持つのはこのクラスなので置き場所もここに揃えている。
    installHeightFog(preset);

    const el = THREE.MathUtils.degToRad(preset.elevation);
    const az = THREE.MathUtils.degToRad(preset.azimuth);
    this.sunDirection.set(
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      Math.cos(el) * Math.cos(az),
    );

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uZenith: { value: col(preset.zenith) },
        uHorizon: { value: col(preset.horizon) },
        uGround: { value: col(preset.ground) },
        uSunColor: { value: col(preset.sun) },
        uSunDir: { value: this.sunDirection.clone() },
      },
      vertexShader: vert,
      fragmentShader: frag,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.material);
    this.mesh.scale.setScalar(6000);
    this.mesh.frustumCulled = false;
    // 最初に描いて、あとから地形で上書きさせる。
    this.mesh.renderOrder = RENDER_ORDER.sky;
    scene.add(this.mesh);

    this.sunLight = new THREE.DirectionalLight(col(preset.sun), preset.sunIntensity);
    this.sunLight.position.copy(this.sunDirection).multiplyScalar(500);
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);

    this.ambient = new THREE.HemisphereLight(
      col(preset.ambientSky),
      col(preset.ambientGround),
      preset.ambientIntensity,
    );
    scene.add(this.ambient);

    // 霧の色は地平線と揃える。遠景が空に溶けて奥行きが出る。
    scene.fog = new THREE.FogExp2(col(preset.horizon), preset.fogDensity);
  }

  /** 空ドームと日光をカメラに追従させる。 */
  update(camera: THREE.Camera): void {
    this.mesh.position.copy(camera.position);
    this.sunLight.target.position.copy(camera.position);
    this.sunLight.position.copy(camera.position).addScaledVector(this.sunDirection, 500);
  }

}
