import * as THREE from 'three';
import {
  DESTINATION_RING_RADIUS,
  type Destination,
} from '../world/destination';
import { RENDER_ORDER } from './order';

const ARRIVAL_RADIUS = DESTINATION_RING_RADIUS * 0.82;

/**
 * 遠くから見つけ、飛び抜けられる白い光の輪。
 * 発光テクスチャなどの外部アセットは使わず、2本のトーラスだけで作る。
 */
export class DestinationRing {
  private group = new THREE.Group();
  private coreMaterial: THREE.MeshBasicMaterial;
  private glowMaterial: THREE.MeshBasicMaterial;
  private arrived = false;

  constructor(
    scene: THREE.Scene,
    destination: Destination,
    origin: { x: number; z: number },
  ) {
    this.coreMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.94,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.glowMaterial = new THREE.MeshBasicMaterial({
      color: 0xeaf7ff,
      transparent: true,
      opacity: 0.18,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });

    const core = new THREE.Mesh(
      new THREE.TorusGeometry(DESTINATION_RING_RADIUS, 1.8, 8, 72),
      this.coreMaterial,
    );
    const glow = new THREE.Mesh(
      new THREE.TorusGeometry(DESTINATION_RING_RADIUS, 7.5, 8, 72),
      this.glowMaterial,
    );
    core.renderOrder = RENDER_ORDER.destination;
    glow.renderOrder = RENDER_ORDER.destination;
    this.group.add(glow, core);
    scene.add(this.group);
    this.setDestination(destination, origin);
  }

  /** 次の渡り先へ輪を移し、到達判定も新しい区間として始め直す。 */
  setDestination(
    destination: Destination,
    origin: { x: number; z: number },
  ): void {
    this.group.position.set(destination.x, destination.y, destination.z);
    // 区間の出発地点から輪の面へまっすぐ入れる向きにする。
    const dx = destination.x - origin.x;
    const dz = destination.z - origin.z;
    this.group.rotation.y = Math.atan2(dx, dz);
    this.group.visible = true;
    this.arrived = false;
  }

  /** 到達後は、次の光を選ぶまで世界から輪そのものを消す。 */
  hide(): void {
    this.group.visible = false;
  }

  /**
   * 輪をわずかに呼吸させる。初めて輪の内側へ入ったフレームだけ true。
   */
  update(elapsed: number, position: THREE.Vector3): boolean {
    if (!this.group.visible) return false;

    const pulse = 0.5 + 0.5 * Math.sin(elapsed * 2.1);
    const scale = 1 + pulse * 0.025;
    this.group.scale.setScalar(scale);
    this.coreMaterial.opacity = 0.88 + pulse * 0.1;
    this.glowMaterial.opacity = 0.12 + pulse * 0.12;

    if (this.arrived || position.distanceTo(this.group.position) > ARRIVAL_RADIUS) {
      return false;
    }
    this.arrived = true;
    return true;
  }
}
