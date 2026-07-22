import * as THREE from 'three';

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
  /** 太陽の仰角（度）。 */
  elevation: number;
  /** 太陽の方位（度）。 */
  azimuth: number;
  sunIntensity: number;
  ambientSky: number;
  ambientGround: number;
  ambientIntensity: number;
  fogDensity: number;
}

/** 穏やかな朝。落ち着いて歩ける明るさに寄せている。 */
export const MORNING: SkyPreset = {
  zenith: 0x5d8fd0,
  horizon: 0xc7dbe6,
  ground: 0xa9b6b4,
  sun: 0xffe9c4,
  elevation: 34,
  azimuth: 128,
  sunIntensity: 2.6,
  ambientSky: 0x9dc0e8,
  ambientGround: 0x6b6a55,
  ambientIntensity: 1.15,
  fogDensity: 0.00055,
};

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
    this.mesh.renderOrder = -1000;
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

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
