import * as THREE from 'three';
import { hash2 } from '../core/rng';
import type { PlayerState } from '../net/connection';
import { EYE_HEIGHT } from '../player/controller';
import { RENDER_ORDER } from './order';

/** 名前が読めなくなる距離。これより遠い相手のラベルは消す。 */
const LABEL_RANGE = 70;
/** 受信位置へ寄せる速さ。10Hz の飛び飛びの座標をなめらかに見せる。 */
const FOLLOW_RATE = 11;

interface Avatar {
  group: THREE.Group;
  label: THREE.Sprite;
  material: THREE.MeshLambertMaterial;
  target: THREE.Vector3;
  /** 座標がまだ一度も届いていない相手は描かない。 */
  placed: boolean;
}

function paint(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const count = g.getAttribute('position').count;
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

let bodyGeometry: THREE.BufferGeometry | null = null;

/**
 * 丸い筒。顔も手足も付けない。
 *
 * 人型に寄せるほど不気味になったので、素直に「そこに誰かがいる」だけを示す形にした。
 * 身長は本人の目線の高さと同じ。届く y が目線の高さなので、
 * 足を地面に着けるにはこの分だけ下げる必要がある。
 * 体は白く塗っておき、プレイヤーごとの色はマテリアル側で乗算する。
 */
function body(): THREE.BufferGeometry {
  if (bodyGeometry) return bodyGeometry;
  const radius = 0.3;
  const height = EYE_HEIGHT;
  bodyGeometry = paint(
    new THREE.CapsuleGeometry(radius, height - radius * 2, 6, 16).translate(0, height / 2, 0),
    0xffffff,
  );
  return bodyGeometry;
}

/** ID 全体を畳んで 0..1 の色相にする。似た ID でも色が近くならないように。 */
function hueOf(id: string): number {
  let a = 0;
  let b = 0;
  for (let i = 0; i < id.length; i++) {
    a = (a * 31 + id.charCodeAt(i)) | 0;
    b = (b * 17 + id.charCodeAt(i) * (i + 1)) | 0;
  }
  return hash2(a, b, 4801);
}

/** 名前を描いた板。距離で小さくなるが、読めるうちは常に正面を向く。 */
function makeLabel(name: string): THREE.Sprite {
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
  sprite.position.y = 2.05;
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

    // 体の色を ID から決める。誰がどれか見分けがつくように。
    // 明るめ・低めの彩度にして、風景から浮かないパステルに寄せる。
    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading: true,
    });
    material.color.setHSL(hueOf(id), 0.5, 0.7);

    const group = new THREE.Group();
    group.add(new THREE.Mesh(body(), material));

    const label = makeLabel(name);
    group.add(label);

    // 座標を伴わずに入ってくることがある。その場合は原点に立たせず、
    // 最初の座標が届くまで隠しておく。
    if (state) group.position.set(state.x, state.y - EYE_HEIGHT, state.z);
    group.visible = state !== null;

    this.scene.add(group);
    this.avatars.set(id, {
      group,
      label,
      material,
      target: group.position.clone(),
      placed: state !== null,
    });
  }

  setState(id: string, state: PlayerState): void {
    const a = this.avatars.get(id);
    if (!a) return;
    a.target.set(state.x, state.y - EYE_HEIGHT, state.z);
    if (!a.placed) {
      // 初回は補間せずその場に置く。遠くから滑って来ると驚くので。
      a.group.position.copy(a.target);
      a.group.visible = true;
      a.placed = true;
    }
  }

  remove(id: string): void {
    const a = this.avatars.get(id);
    if (!a) return;
    this.scene.remove(a.group);
    a.material.dispose();
    a.label.material.map?.dispose();
    a.label.material.dispose();
    this.avatars.delete(id);
  }

  update(dt: number, camera: THREE.Camera): void {
    const follow = 1 - Math.exp(-FOLLOW_RATE * dt);

    for (const a of this.avatars.values()) {
      a.group.position.lerp(a.target, follow);

      const distance = a.group.position.distanceTo(camera.position);
      a.label.visible = distance < LABEL_RANGE;
    }
  }

}
