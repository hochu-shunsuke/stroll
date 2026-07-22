import * as THREE from 'three';
import { SEA_LEVEL } from '../world/terrain';
import { RENDER_ORDER } from './order';

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
  varying vec3 vWorld;

  #include <fog_pars_fragment>

  // 向きと速さの違う波を重ね、周期が読めないようにする。
  float waveHeight(vec2 p) {
    float h = 0.0;
    h += sin(dot(p, vec2(0.062, 0.031)) + uTime * 0.55) * 0.55;
    h += sin(dot(p, vec2(-0.041, 0.074)) + uTime * 0.42) * 0.45;
    h += sin(dot(p, vec2(0.121, -0.096)) + uTime * 0.83) * 0.20;
    h += sin(dot(p, vec2(0.198, 0.164)) + uTime * 1.15) * 0.10;
    return h;
  }

  void main() {
    vec2 p = vWorld.xz;

    // 高さ場の差分から法線を作る。細かいさざ波はここだけで表現する。
    float e = 1.2;
    float hx = waveHeight(p + vec2(e, 0.0)) - waveHeight(p - vec2(e, 0.0));
    float hz = waveHeight(p + vec2(0.0, e)) - waveHeight(p - vec2(0.0, e));
    vec3 n = normalize(vec3(-hx * 0.55, 1.0, -hz * 0.55));

    vec3 viewDir = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 3.0);

    // 見下ろすほど水の色、浅い角度ほど空の映り込み。
    vec3 body = mix(uDeep, uShallow, clamp(dot(n, viewDir), 0.0, 1.0) * 0.65);
    vec3 col = mix(body, uSkyColor, clamp(fres * 1.25, 0.0, 0.92));

    // 太陽の細い帯。穏やかさを壊さない程度に。
    vec3 h = normalize(uSunDir + viewDir);
    float spec = pow(max(dot(n, h), 0.0), 220.0);
    col += uSunColor * spec * 1.6;

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
 * 海面と湖面。1 枚の大きな面をカメラに追従させて無限に見せる。
 * 波は法線だけで作るので、面の分割は粗くてよい。
 */
export class Water {
  private mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene, sunDirection: THREE.Vector3, skyHorizon: number, sunHex: number) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uShallow: { value: col(0x5c93a0) },
        uDeep: { value: col(0x27505e) },
        uSkyColor: { value: col(skyHorizon) },
        uSunColor: { value: col(sunHex) },
        uSunDir: { value: sunDirection.clone() },
        ...THREE.UniformsLib.fog,
      },
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });

    const geo = new THREE.PlaneGeometry(9000, 9000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.y = SEA_LEVEL;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = RENDER_ORDER.water;
    scene.add(this.mesh);
  }

  update(camera: THREE.Camera, elapsed: number): void {
    this.material.uniforms.uTime.value = elapsed;
    // 波は世界座標で計算しているので、面をずらしても模様は動かない。
    this.mesh.position.x = camera.position.x;
    this.mesh.position.z = camera.position.z;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
