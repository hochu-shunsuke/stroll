import * as THREE from 'three';
import type { PlayerState } from '../net/connection';
import { EYE_HEIGHT } from '../player/controller';
import { createBird, poseBird, type BirdRig } from './birds';
import { RENDER_ORDER } from './order';

/** 名前が読めなくなる距離。これより遠い相手のラベルは消す。 */
const LABEL_RANGE = 70;
/** この距離では鳥自体も数px以下になる。方向はHUDへ任せ、描画を止める。 */
const AVATAR_RANGE = 220;
/** 受信位置へ寄せる速さ。10Hz の飛び飛びの座標をなめらかに見せる。 */
const FOLLOW_RATE = 11;

interface Avatar {
  name: string;
  group: THREE.Group;
  label: THREE.Sprite;
  bird: BirdRig;
  target: THREE.Vector3;
  targetYaw: number;
  flying: boolean;
  phase: number;
  flightBlend: number;
  groundMotion: number;
  /** 座標がまだ一度も届いていない相手は描かない。 */
  placed: boolean;
}

/** 名前を描いた板。距離で小さくなるが、読めるうちは常に正面を向く。 */
function makeLabel(name: string, labelHeight: number): THREE.Sprite {
  const pad = 16;
  const font = 44;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `500 ${font}px ui-sans-serif, system-ui, sans-serif`;
  const width = Math.ceil(measure.measureText(name).width) + pad * 2;
  const height = font + pad * 2;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.font = `500 ${font}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  ctx.fillStyle = 'rgba(14, 22, 28, 0.62)';
  ctx.beginPath();
  ctx.roundRect(0, 0, width, height, height / 2);
  ctx.fill();

  ctx.fillStyle = '#eef2f3';
  ctx.fillText(name, width / 2, height / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: true,
      // 深度を書かないこと。書くと透明な角の部分まで手前の物として扱われ、
      // 後から描かれる水面がその四角形の範囲だけ消えて、湖底が黒く見える。
      depthWrite: false,
    }),
  );
  // 水より後に描く。水はカメラ追従の板なので、放っておくと
  // 常に名前の上に被さり、水辺でだけ文字が読めなくなる。
  sprite.renderOrder = RENDER_ORDER.label;

  const scale = 0.55;
  sprite.scale.set((width / height) * scale, scale, 1);
  sprite.position.y = labelHeight;
  return sprite;
}

/**
 * 他プレイヤーの表示。
 * 座標は 10Hz でしか届かないので、そのまま置くとカクつく。
 * 受信値を「目標」として、毎フレームそこへ寄せることでなめらかに見せている。
 */
export class Avatars {
  private scene: THREE.Scene;
  private avatars = new Map<string, Avatar>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  add(id: string, name: string, state: PlayerState | null): void {
    if (this.avatars.has(id)) return;

    // 接続IDから安定して鳥を選ぶ。同じ相手が見る人ごとに別の姿にならない。
    const bird = createBird(id);
    const group = new THREE.Group();
    group.add(bird.root);

    const label = makeLabel(name, bird.labelHeight);
    group.add(label);

    // 座標を伴わずに入ってくることがある。その場合は原点に立たせず、
    // 最初の座標が届くまで隠しておく。
    if (state) group.position.set(state.x, state.y - EYE_HEIGHT, state.z);
    group.rotation.y = state?.yaw ?? 0;
    group.visible = state !== null;
    const flightBlend = state?.flying ? 1 : 0;
    poseBird(bird, 0, flightBlend, 0);

    this.scene.add(group);
    this.avatars.set(id, {
      name,
      group,
      label,
      bird,
      target: group.position.clone(),
      targetYaw: state?.yaw ?? 0,
      flying: state?.flying ?? false,
      phase: 0,
      flightBlend,
      groundMotion: 0,
      placed: state !== null,
    });
  }

  setState(id: string, state: PlayerState): void {
    const a = this.avatars.get(id);
    if (!a) return;
    a.target.set(state.x, state.y - EYE_HEIGHT, state.z);
    a.targetYaw = state.yaw;
    a.flying = state.flying;
    if (!a.placed) {
      // 初回は補間せずその場に置く。遠くから滑って来ると驚くので。
      a.group.position.copy(a.target);
      a.group.rotation.y = state.yaw;
      a.group.visible = true;
      a.placed = true;
    }
  }

  remove(id: string): void {
    const a = this.avatars.get(id);
    if (!a) return;
    this.scene.remove(a.group);
    for (const geometry of a.bird.geometries) geometry.dispose();
    a.label.material.map?.dispose();
    a.label.material.dispose();
    this.avatars.delete(id);
  }

  update(dt: number, camera: THREE.Camera): void {
    const follow = 1 - Math.exp(-FOLLOW_RATE * dt);

    for (const a of this.avatars.values()) {
      const beforeX = a.group.position.x;
      const beforeZ = a.group.position.z;
      a.group.position.lerp(a.target, follow);
      const moved = Math.hypot(
        a.group.position.x - beforeX,
        a.group.position.z - beforeZ,
      );
      const motionTarget = !a.flying && moved > 0.002 ? 1 : 0;
      a.groundMotion +=
        (motionTarget - a.groundMotion) * (1 - Math.exp(-9 * dt));
      a.flightBlend +=
        ((a.flying ? 1 : 0) - a.flightBlend) * (1 - Math.exp(-6 * dt));
      a.phase += dt;
      poseBird(a.bird, a.phase, a.flightBlend, a.groundMotion);

      // -π/π を跨ぐときも長い方へ一周せず、短い向きで振り返る。
      const turn = Math.atan2(
        Math.sin(a.targetYaw - a.group.rotation.y),
        Math.cos(a.targetYaw - a.group.rotation.y),
      );
      a.group.rotation.y += turn * (1 - Math.exp(-10 * dt));

      const distance = a.group.position.distanceTo(camera.position);
      a.group.visible = a.placed && distance < AVATAR_RANGE;
      a.label.visible = distance < LABEL_RANGE;
    }
  }

  /**
   * HUD 用の現在位置。受信した飛び飛びの target ではなく、画面上で補間済みの
   * 位置を返し、方向矢印だけが先に跳ねないようにする。
   */
  friendPositions(): {
    id: string;
    name: string;
    x: number;
    y: number;
    z: number;
  }[] {
    const positions: {
      id: string;
      name: string;
      x: number;
      y: number;
      z: number;
    }[] = [];
    for (const [id, a] of this.avatars) {
      if (!a.placed) continue;
      positions.push({
        id,
        name: a.name,
        x: a.group.position.x,
        y: a.group.position.y + EYE_HEIGHT,
        z: a.group.position.z,
      });
    }
    return positions;
  }
}
