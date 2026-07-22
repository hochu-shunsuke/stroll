import type { Player } from '../player/controller';

/** スティックを倒しきったとみなす距離（px）。 */
const STICK_RADIUS = 58;
/** これ以下のブレは無視する。指を置いただけで歩き出さないように。 */
const DEAD_ZONE = 7;
/** この割合以上倒したら走る。 */
const SPRINT_AT = 0.85;
/** 指での視点移動の倍率。画面上を指が動く距離は短いので、マウスより速くする。 */
const LOOK_SCALE = 1.2;

export interface TouchControlsOptions {
  root: HTMLElement;
  surface: HTMLElement;
  player: Player;
  lookSensitivity: number;
  isPlaying: () => boolean;
  onPause: () => void;
}

export interface TouchControls {
  /** 歩いている間だけ出す。開始画面の上に重ねない。 */
  setActive(active: boolean): void;
  dispose(): void;
}

/** タッチ端末かどうか。細かい判定はせず、指で操作する画面かだけを見る。 */
export function isTouchDevice(): boolean {
  return matchMedia('(pointer: coarse)').matches;
}

/**
 * 指で歩くための操作。
 *
 * 画面の左半分に触れるとそこがスティックの中心になる。
 * 決まった位置に置くと持ち方によって届かないので、触れた場所を中心にしている。
 * 右半分はどこを触っても視点操作。
 */
export function createTouchControls(opts: TouchControlsOptions): TouchControls {
  const { root, surface, player, lookSensitivity, isPlaying, onPause } = opts;

  const layer = document.createElement('div');
  layer.className = 'touch';
  layer.innerHTML = `
    <div class="stick"><span class="stick-knob"></span></div>
    <button class="touch-btn touch-jump" aria-label="跳ぶ"></button>
    <button class="touch-btn touch-pause" aria-label="一時停止"></button>
  `;
  root.appendChild(layer);

  const stick = layer.querySelector('.stick') as HTMLElement;
  const knob = layer.querySelector('.stick-knob') as HTMLElement;
  const jump = layer.querySelector('.touch-jump') as HTMLElement;
  const pause = layer.querySelector('.touch-pause') as HTMLElement;

  /** スティックを操作している指。null なら誰も触っていない。 */
  let movePointer: number | null = null;
  let originX = 0;
  let originY = 0;

  /** 視点を操作している指と、その直前の位置。 */
  let lookPointer: number | null = null;
  let lookX = 0;
  let lookY = 0;

  const releaseStick = () => {
    movePointer = null;
    player.setMoveAxis(0, 0, false);
    stick.classList.remove('on');
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!isPlaying()) return;
    // ボタンの上で始まった操作は、そちらの担当。
    if ((e.target as HTMLElement).closest('.touch-btn')) return;

    if (e.clientX < innerWidth / 2) {
      if (movePointer !== null) return;
      movePointer = e.pointerId;
      originX = e.clientX;
      originY = e.clientY;
      stick.style.left = `${originX}px`;
      stick.style.top = `${originY}px`;
      knob.style.transform = 'translate(-50%, -50%)';
      stick.classList.add('on');
    } else {
      if (lookPointer !== null) return;
      lookPointer = e.pointerId;
      lookX = e.clientX;
      lookY = e.clientY;
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerId === movePointer) {
      let dx = e.clientX - originX;
      let dy = e.clientY - originY;
      const distance = Math.hypot(dx, dy);

      if (distance < DEAD_ZONE) {
        player.setMoveAxis(0, 0, false);
        knob.style.transform = 'translate(-50%, -50%)';
        return;
      }

      // 倒しきっても円の外には出さない。
      const clamped = Math.min(distance, STICK_RADIUS);
      dx = (dx / distance) * clamped;
      dy = (dy / distance) * clamped;
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

      const amount = clamped / STICK_RADIUS;
      // 画面の下方向が後ろなので、y は符号を反転する。
      player.setMoveAxis(
        (dx / clamped) * amount,
        (-dy / clamped) * amount,
        amount >= SPRINT_AT,
      );
      return;
    }

    if (e.pointerId === lookPointer) {
      player.onLook(e.clientX - lookX, e.clientY - lookY, lookSensitivity * LOOK_SCALE);
      lookX = e.clientX;
      lookY = e.clientY;
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerId === movePointer) releaseStick();
    if (e.pointerId === lookPointer) lookPointer = null;
  };

  // 跳ぶボタンは Space と同じ扱いにする。
  // 二度押しで飛行に切り替わる仕組みも、そのまま効く。
  const onJumpDown = (e: PointerEvent) => {
    e.preventDefault();
    player.onKey('Space', true);
  };
  const onJumpUp = () => player.onKey('Space', false);

  surface.addEventListener('pointerdown', onPointerDown);
  surface.addEventListener('pointermove', onPointerMove);
  surface.addEventListener('pointerup', onPointerUp);
  surface.addEventListener('pointercancel', onPointerUp);
  jump.addEventListener('pointerdown', onJumpDown);
  jump.addEventListener('pointerup', onJumpUp);
  jump.addEventListener('pointercancel', onJumpUp);
  pause.addEventListener('click', onPause);

  return {
    setActive(active: boolean) {
      layer.classList.toggle('on', active);
      if (!active) releaseStick();
    },
    dispose() {
      surface.removeEventListener('pointerdown', onPointerDown);
      surface.removeEventListener('pointermove', onPointerMove);
      surface.removeEventListener('pointerup', onPointerUp);
      surface.removeEventListener('pointercancel', onPointerUp);
      layer.remove();
    },
  };
}
