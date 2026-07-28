import type { Player } from '../player/controller';

/** スティックを倒しきったとみなす距離（px）。 */
const STICK_RADIUS = 58;
/** これ以下のブレは無視する。指を置いただけで歩き出さないように。 */
const DEAD_ZONE = 7;
/** ここから外周へ向かって、歩行→走行／巡航→高速を滑らかに繋ぐ。 */
const BOOST_FROM = 0.72;
/** 指での視点移動の倍率。画面上を指が動く距離は短いので、マウスより速くする。 */
const LOOK_SCALE = 2.4;

export interface TouchControlsOptions {
  root: HTMLElement;
  surface: HTMLElement;
  player: Player;
  lookSensitivity: number;
  isPlaying: () => boolean;
  onPause: () => void;
  /** タッチ対応PCで、実際に指が使われたときだけ入力表示を切り替える。 */
  onTouchInput?: () => void;
}

export interface TouchControls {
  /** 歩いている間だけ出す。開始画面の上に重ねない。 */
  setActive(active: boolean): void;
  /** 飛行・オート状態に応じて、必要なボタンだけを見せる。 */
  update(): void;
}

/**
 * 最初にタッチUIを見せるべき端末か。タッチ対応ノートPCを永久に
 * スマホ扱いしないため、指があるかではなく主入力の性質を見る。
 */
export function isTouchDevice(): boolean {
  return matchMedia('(pointer: coarse)').matches && !matchMedia('(hover: hover)').matches;
}

/** 初期表示とは別に、指そのものが使えるかを調べる。 */
export function hasTouchInput(): boolean {
  return matchMedia('(any-pointer: coarse)').matches || navigator.maxTouchPoints > 0;
}

/**
 * 指で歩くための操作。
 *
 * 画面の左半分に触れるとそこがスティックの中心になる。
 * 決まった位置に置くと持ち方によって届かないので、触れた場所を中心にしている。
 * 右半分はどこを触っても視点操作。
 */
export function createTouchControls(opts: TouchControlsOptions): TouchControls {
  const { root, surface, player, lookSensitivity, isPlaying, onPause, onTouchInput } = opts;

  const layer = document.createElement('div');
  layer.className = 'touch';
  layer.innerHTML = `
    <div class="stick"><span class="stick-knob"></span></div>
    <button class="touch-btn touch-jump" aria-label="跳ぶ"></button>
    <button class="touch-btn touch-flight" aria-label="飛ぶ／降りる"></button>
    <button class="touch-btn touch-auto" aria-label="オートフライト">AUTO</button>
    <button class="touch-btn touch-pause" aria-label="一時停止"></button>
  `;
  root.appendChild(layer);

  const stick = layer.querySelector('.stick') as HTMLElement;
  const knob = layer.querySelector('.stick-knob') as HTMLElement;
  const jump = layer.querySelector('.touch-jump') as HTMLElement;
  const flight = layer.querySelector('.touch-flight') as HTMLElement;
  const auto = layer.querySelector('.touch-auto') as HTMLElement;
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
    player.setMoveAxis(0, 0, 0);
    stick.classList.remove('on');
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    if (!isPlaying()) return;
    onTouchInput?.();
    // ボタンの上で始まった操作は、そちらの担当。
    if ((e.target as HTMLElement).closest('.touch-btn')) return;
    try {
      surface.setPointerCapture(e.pointerId);
    } catch {
      // 一部の WebView は capture を持たない。通常の pointerup だけで続行できる。
    }

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
        player.setMoveAxis(0, 0, 0);
        knob.style.transform = 'translate(-50%, -50%)';
        return;
      }

      // 倒しきっても円の外には出さない。
      const clamped = Math.min(distance, STICK_RADIUS);
      dx = (dx / distance) * clamped;
      dy = (dy / distance) * clamped;
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

      const amount = clamped / STICK_RADIUS;
      const boostLinear = Math.max(0, Math.min(1, (amount - BOOST_FROM) / (1 - BOOST_FROM)));
      const boost = boostLinear * boostLinear * (3 - 2 * boostLinear);
      // 画面の下方向が後ろなので、y は符号を反転する。
      player.setMoveAxis(
        (dx / clamped) * amount,
        (-dy / clamped) * amount,
        boost,
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

  const captureButton = (button: HTMLElement, e: PointerEvent) => {
    if (e.pointerType === 'mouse') return false;
    e.preventDefault();
    onTouchInput?.();
    try {
      button.setPointerCapture(e.pointerId);
    } catch {
      // capture が無くても button 自体の pointerup で解除できる。
    }
    return true;
  };

  // タッチでは飛行を独立ボタンにしたので、ジャンプ二度押しを誤発火させない。
  const onJumpDown = (e: PointerEvent) => {
    if (!captureButton(jump, e)) return;
    player.onKey('Space', true, false, false);
  };
  const onJumpUp = () => player.onKey('Space', false, false, false);

  surface.addEventListener('pointerdown', onPointerDown);
  surface.addEventListener('pointermove', onPointerMove);
  surface.addEventListener('pointerup', onPointerUp);
  surface.addEventListener('pointercancel', onPointerUp);
  surface.addEventListener('lostpointercapture', onPointerUp);
  jump.addEventListener('pointerdown', onJumpDown);
  jump.addEventListener('pointerup', onJumpUp);
  jump.addEventListener('pointercancel', onJumpUp);
  flight.addEventListener('pointerdown', (e) => {
    if (!captureButton(flight, e)) return;
    player.toggleFlying();
  });
  auto.addEventListener('pointerdown', (e) => {
    if (!captureButton(auto, e)) return;
    player.toggleAutoFlight();
  });
  pause.addEventListener('click', onPause);

  return {
    setActive(active: boolean) {
      layer.classList.toggle('on', active);
      if (!active) {
        releaseStick();
        lookPointer = null;
        player.onKey('Space', false, false, false);
      }
    },
    update() {
      flight.classList.toggle('active', player.flying);
      auto.classList.toggle('available', player.flying);
      auto.classList.toggle('active', player.autoFlight);
    },
  };
}
