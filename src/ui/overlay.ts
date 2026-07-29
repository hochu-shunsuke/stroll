import { SeedField } from './seedField';
import { formatFriendDistance, type FriendEdgeIndicator } from './friendCompass';

export interface OverlayHandlers {
  onStart: (resume: boolean, pointerType: string) => void;
  /** 合言葉が変わったとき。世界ごと作り直すので読み込み直す。 */
  onSeed: (seed: string) => void;
}

const NAME_KEY = 'stroll:name';
const MAX_NAME_LENGTH = 16;

interface FriendMarkerElements {
  root: HTMLElement;
  arrow: HTMLElement;
  name: HTMLElement;
  distance: HTMLElement;
}

/**
 * 開始画面と、歩いている間の最小限の表示。
 * 情報量は抑える（画面が賑やかだと落ち着かないため）。
 */
export class Overlay {
  private root: HTMLElement;
  private veil: HTMLElement;
  private status: HTMLElement;
  private startBtn: HTMLButtonElement;
  private freshBtn: HTMLButtonElement;
  private hud: HTMLElement;
  private flightHud: HTMLElement;
  private friendCompass: HTMLElement;
  private keyboardGuide: HTMLElement;
  private toast: HTMLElement;
  private seed: string;
  private handlers: OverlayHandlers;
  private toastTimer = 0;

  /** 他の人の画面に出る表示名。 */
  name: string;

  private peers: HTMLElement;
  private peersText = '';
  private flightText = '';
  private friendMarkers = new Map<string, FriendMarkerElements>();
  private keyboardGuideTimer = 0;
  private keyboardGuideShown = false;
  private touch: boolean;
  private touchCapable: boolean;
  private resumable: boolean;
  private ready = false;
  private entered = false;

  constructor(
    root: HTMLElement,
    seed: string,
    touch: boolean,
    touchCapable: boolean,
    resumable: boolean,
    handlers: OverlayHandlers,
  ) {
    this.root = root;
    this.seed = seed;
    this.touch = touch;
    this.touchCapable = touchCapable;
    this.resumable = resumable;
    this.handlers = handlers;
    const browserHint =
      touch && !('requestFullscreen' in document.documentElement)
        ? '<p class="browser-hint">外部ブラウザで開くかホーム画面に追加すると、より広く遊べます。</p>'
        : '';

    this.name = (readStorage(NAME_KEY) ?? '').slice(0, MAX_NAME_LENGTH);

    this.root.innerHTML = `
      <div class="veil">
        <div class="card">
          <header class="brand">
            <h1>stroll</h1>
            <p class="lead">空から見つけて、降りて歩く。目的も、期限もない。</p>
          </header>

          <div class="fields">
            <label class="field">
              <span class="field-label">名前</span>
              <input class="name" type="text" maxlength="${MAX_NAME_LENGTH}"
                placeholder="友達に表示される名前" value="${escapeHtml(this.name)}" />
            </label>
            <div class="field">
              <span class="field-label">合言葉</span>
              <div class="seed-row"></div>
              <p class="hint">同じ合言葉なら、同じ地形。</p>
            </div>
          </div>

          <div class="entry-actions">
            <button class="start" disabled>地形を生成しています…</button>
            <button class="fresh${resumable ? '' : ' hidden'}" disabled>開始地点から入る</button>
          </div>
          <button class="share">この世界のURLをコピー</button>
          ${browserHint}

          <details class="controls">
            <summary>操作</summary>
            <ul class="keys">
              <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 歩く</li>
              <li><kbd>Shift</kbd> 走る／高速飛行</li>
              <li><kbd>Space</kbd> 跳ぶ</li>
              <li><kbd>F</kbd> 飛ぶ／降りる</li>
              <li><kbd>R</kbd> 自動飛行</li>
              <li><kbd>M</kbd> 消音</li>
              <li><kbd>Esc</kbd> 一時停止</li>
            </ul>
            <p class="controls-note">飛行中は <kbd>Space</kbd> 上昇、<kbd>C</kbd> 下降。自動飛行中は視点が自由で、左右だけを押すと新しい進路を保ちます。</p>
          </details>
        </div>
      </div>
      <div class="hud">
        <span class="hud-seed">${escapeHtml(seed)}</span>
        <span class="hud-peers"></span>
      </div>
      <div class="flight-hud"></div>
      <div class="friend-compass" aria-label="友達の方向" aria-hidden="true"></div>
      <div class="keyboard-guide" aria-label="操作方法" aria-hidden="true">
        <span><kbd>WASD</kbd> 移動</span>
        <span><kbd>マウス</kbd> 見る</span>
        <span><kbd>Shift</kbd> 加速</span>
        <span><kbd>Space</kbd> 跳ぶ／上昇</span>
        <span><kbd>C</kbd> 下降</span>
        <span><kbd>F</kbd> 飛行</span>
        <span><kbd>R</kbd> AUTO</span>
        <span><kbd>Esc</kbd> 休憩</span>
      </div>
      <div class="toast"></div>
    `;

    this.veil = this.root.querySelector('.veil')!;
    this.status = this.root.querySelector('.lead')!;
    this.startBtn = this.root.querySelector('.start')!;
    this.freshBtn = this.root.querySelector('.fresh')!;
    this.hud = this.root.querySelector('.hud')!;
    this.flightHud = this.root.querySelector('.flight-hud')!;
    this.friendCompass = this.root.querySelector('.friend-compass')!;
    this.keyboardGuide = this.root.querySelector('.keyboard-guide')!;
    this.toast = this.root.querySelector('.toast')!;

    this.peers = this.root.querySelector('.hud-peers')!;

    this.bindEntryButton(this.startBtn, () => this.resumable);
    this.bindEntryButton(this.freshBtn, () => false);
    this.root.querySelector('.share')!.addEventListener('click', () => this.copyUrl());

    const nameInput = this.root.querySelector('.name') as HTMLInputElement;
    nameInput.addEventListener('input', () => {
      this.name = nameInput.value.slice(0, MAX_NAME_LENGTH);
      writeStorage(NAME_KEY, this.name);
    });
    // 名前欄で Enter を押したらそのまま歩き出せるようにする。
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !this.startBtn.disabled) {
        e.preventDefault();
        this.handlers.onStart(this.resumable, 'keyboard');
      }
    });

    // 合言葉は 8 マスのコマ割りで入力する。8 個埋まったら確定する。
    // 入力の途中で作り直すと一文字打つたびに世界が変わるので、揃うまで待つ。
    const seedField = new SeedField(seed, (next) => {
      if (next !== this.seed) this.handlers.onSeed(next);
    });
    this.root.querySelector('.seed-row')!.appendChild(seedField.element);
  }

  /**
   * iOS Safari はタッチ由来の click を MouseEvent、または pointerType="mouse" として
   * 送る版がある。click だけを見ると PC 用 Pointer Lock へ入り、開始できなくなる。
   * 直前の pointerdown は正しく touch なので、そちらを優先して入口を決める。
   */
  private bindEntryButton(
    button: HTMLButtonElement,
    resume: () => boolean,
  ): void {
    let recentPointerType = '';
    let recentPointerAt = 0;

    button.addEventListener('pointerdown', (event) => {
      recentPointerType = event.pointerType;
      recentPointerAt = performance.now();
    });
    button.addEventListener('pointerup', () => {
      // 長押しでも click 直前の入力として扱えるよう、離した時刻へ更新する。
      recentPointerAt = performance.now();
    });
    button.addEventListener('pointercancel', () => {
      recentPointerType = '';
      recentPointerAt = 0;
    });
    button.addEventListener('click', (event) => {
      const clickPointerType =
        typeof PointerEvent !== 'undefined' && event instanceof PointerEvent
          ? event.pointerType
          : event instanceof MouseEvent
            ? 'mouse'
            : '';
      const clickDetail = event instanceof MouseEvent ? event.detail : 0;
      const pointerType = resolveEntryPointerType(
        performance.now() - recentPointerAt < 1_500 ? recentPointerType : '',
        clickPointerType,
        this.touchCapable,
        clickDetail,
      );
      recentPointerType = '';
      recentPointerAt = 0;
      this.handlers.onStart(resume(), pointerType);
    });
  }

  /**
   * 画面の隅に「今この世界に何人いるか」を出す。
   * 毎フレーム呼ばれるので、変わっていないときは触らない。
   */
  setPeers(count: number, message: string | null): void {
    const text = message ?? (count > 0 ? `ほかに ${count} 人` : '');
    if (text === this.peersText) return;
    this.peersText = text;
    this.peers.textContent = text;
  }

  /**
   * 友達を、その人がいる方向の画面端へ置く。
   * 同じ方向に複数人いるときは端に沿って交互にずらし、完全には重ねない。
   * 名前は通信由来なので innerHTML へ入れず、必ず textContent で組み立てる。
  */
  setFriendDirections(friends: readonly FriendEdgeIndicator[]): void {
    // 1部屋は最大10人なので、自分以外の9人を全員出せる。
    const limit = 9;
    const visible = friends.slice(0, limit);
    const centerX = innerWidth / 2;
    const centerY = innerHeight / 2;
    const leftBound = Math.min(centerX, this.touch ? 80 : 96);
    const rightBound = Math.max(centerX, innerWidth - (this.touch ? 116 : 96));
    const topBound = Math.min(centerY, this.touch ? 62 : 64);
    const bottomBound = Math.max(centerY, innerHeight - (this.touch ? 74 : 126));
    const activeIds = new Set<string>();
    const placedMarkers: { x: number; y: number; width: number }[] = [];

    for (const friend of visible) {
      activeIds.add(friend.id);
      const distanceText = formatFriendDistance(friend.distance);
      let directionX = friend.directionX;
      let directionY = friend.directionY;
      let directionLength = Math.hypot(directionX, directionY);
      if (directionLength < 0.001) {
        directionX = 0;
        directionY = -1;
        directionLength = 1;
      }

      const reachX =
        directionX >= 0 ? rightBound - centerX : centerX - leftBound;
      const reachY =
        directionY >= 0 ? bottomBound - centerY : centerY - topBound;
      const scaleX =
        Math.abs(directionX) > 0.0001 ? reachX / Math.abs(directionX) : Infinity;
      const scaleY =
        Math.abs(directionY) > 0.0001 ? reachY / Math.abs(directionY) : Infinity;
      const edgeScale = Math.min(scaleX, scaleY);

      let markerX = centerX + directionX * edgeScale;
      let markerY = centerY + directionY * edgeScale;
      let markerTopBound = topBound;
      let markerBottomBound = bottomBound;
      const pointsToTouchButtons =
        this.touch &&
        directionX > 0 &&
        Math.abs(directionX) > Math.abs(directionY) * 0.65;
      if (pointsToTouchButtons) {
        // 右端には休憩・AUTO・飛行・上昇が並ぶ。方向は右のまま、
        // そのボタン列の間にある安全な区間へ寄せる。
        markerTopBound = Math.max(topBound, 78);
        markerBottomBound = Math.min(bottomBound, Math.max(78, innerHeight - 258));
        markerY = Math.max(markerTopBound, Math.min(markerBottomBound, markerY));
      }

      // 先に置いた人と重なる場合は、端の接線に沿って交互に逃がす。
      const estimatedWidth = Math.min(
        190,
        52 + Array.from(friend.name).length * 8 + distanceText.length * 5.5,
      );
      const tangentX = -directionY / directionLength;
      const tangentY = directionX / directionLength;
      const sideEdge = Math.abs(directionX) > Math.abs(directionY);
      const laneStep = sideEdge ? 38 : Math.max(108, estimatedWidth);
      const baseX = markerX;
      const baseY = markerY;
      let overlaps = false;
      for (let attempt = 0; attempt < 11; attempt++) {
        const lane =
          attempt === 0
            ? 0
            : Math.ceil(attempt / 2) * (attempt % 2 === 1 ? 1 : -1);
        const candidateX = Math.max(
          leftBound,
          Math.min(rightBound, baseX + tangentX * lane * laneStep),
        );
        const candidateY = Math.max(
          markerTopBound,
          Math.min(markerBottomBound, baseY + tangentY * lane * laneStep),
        );
        overlaps = placedMarkers.some(
          (placed) =>
            Math.abs(candidateX - placed.x) <
              (estimatedWidth + placed.width) / 2 + 7 &&
            Math.abs(candidateY - placed.y) < 36,
        );
        markerX = candidateX;
        markerY = candidateY;
        if (!overlaps) break;
      }
      // 極端に背が低い横画面で接線方向に逃げ場がない場合は、
      // 画面中心側へ2列目・3列目を作る。
      if (overlaps) {
        const inwardStep = sideEdge ? estimatedWidth + 10 : 40;
        for (let lane = 1; lane <= 4; lane++) {
          const candidateX = Math.max(
            leftBound,
            Math.min(
              rightBound,
              baseX - (directionX / directionLength) * lane * inwardStep,
            ),
          );
          const candidateY = Math.max(
            topBound,
            Math.min(
              bottomBound,
              baseY - (directionY / directionLength) * lane * inwardStep,
            ),
          );
          overlaps = placedMarkers.some(
            (placed) =>
              Math.abs(candidateX - placed.x) <
                (estimatedWidth + placed.width) / 2 + 7 &&
              Math.abs(candidateY - placed.y) < 36,
          );
          markerX = candidateX;
          markerY = candidateY;
          if (!overlaps) break;
        }
      }
      placedMarkers.push({ x: markerX, y: markerY, width: estimatedWidth });

      let marker = this.friendMarkers.get(friend.id);
      if (!marker) {
        const root = document.createElement('div');
        root.className = 'friend-edge-marker';

        const arrow = document.createElement('span');
        arrow.className = 'friend-arrow';
        arrow.ariaHidden = 'true';
        arrow.textContent = '↑';

        const name = document.createElement('span');
        name.className = 'friend-name';

        const distance = document.createElement('span');
        distance.className = 'friend-distance';

        root.append(arrow, name, distance);
        this.friendCompass.appendChild(root);
        marker = { root, arrow, name, distance };
        this.friendMarkers.set(friend.id, marker);
      }

      marker.root.ariaLabel = `${friend.name}、${distanceText}`;
      marker.root.style.left = `${markerX}px`;
      marker.root.style.top = `${markerY}px`;
      marker.arrow.style.transform = `rotate(${friend.rotation}rad)`;
      marker.name.textContent = friend.name;
      marker.distance.textContent = distanceText;
    }

    for (const [id, marker] of this.friendMarkers) {
      if (activeIds.has(id)) continue;
      marker.root.remove();
      this.friendMarkers.delete(id);
    }

    this.friendCompass.classList.toggle('on', friends.length > 0);
    this.friendCompass.ariaHidden = friends.length > 0 ? 'false' : 'true';
  }

  /** PC で最初に世界へ入ったときだけ、操作を15秒見せる。 */
  showKeyboardGuide(): void {
    if (this.touch || this.keyboardGuideShown) return;
    this.keyboardGuideShown = true;
    this.keyboardGuide.classList.add('on');
    this.keyboardGuide.ariaHidden = 'false';
    clearTimeout(this.keyboardGuideTimer);
    this.keyboardGuideTimer = window.setTimeout(() => {
      this.keyboardGuide.classList.remove('on');
      this.keyboardGuide.ariaHidden = 'true';
    }, 15_000);
  }

  /** 足元の地形が揃ったら歩き始められるようにする。 */
  setReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.startBtn.disabled = false;
    this.freshBtn.disabled = false;
    this.updateStartLabel();
  }

  setInputMode(touch: boolean): void {
    this.touch = touch;
    if (touch) {
      this.keyboardGuide.classList.remove('on');
      this.keyboardGuide.ariaHidden = 'true';
    }
    if (this.ready) this.updateStartLabel();
  }

  /** 一度入った後の休憩画面では、初回の復帰選択をもう出さない。 */
  setEntered(): void {
    this.entered = true;
    this.freshBtn.classList.add('hidden');
    if (this.ready) this.updateStartLabel();
  }

  private updateStartLabel(): void {
    if (this.entered) {
      this.startBtn.textContent = this.touch ? 'タップして続ける' : 'クリックして続ける';
      return;
    }
    if (this.resumable) {
      this.startBtn.textContent = this.touch ? 'タップして続きから' : '続きから入る';
      return;
    }
    this.startBtn.textContent = this.touch ? 'タップして世界へ入る' : 'この世界へ入る';
  }

  setFlightInfo(flying: boolean, speed: number, altitude: number, auto: boolean): void {
    if (!flying) {
      if (this.flightText === '') return;
      this.flightText = '';
      this.flightHud.textContent = '';
      this.flightHud.classList.remove('on');
      return;
    }
    const label = auto ? 'AUTO · ' : '';
    const text = `${label}${Math.round(speed * 3.6)} km/h · 高度 ${Math.round(altitude)} m`;
    if (text === this.flightText) return;
    this.flightText = text;
    this.flightHud.textContent = text;
    this.flightHud.classList.add('on');
  }

  setActionLabel(label: string): void {
    this.startBtn.disabled = false;
    this.startBtn.textContent = label;
  }

  show(message?: string): void {
    this.veil.classList.remove('hidden');
    this.hud.classList.add('dim');
    this.friendCompass.classList.add('dim');
    this.keyboardGuide.classList.remove('on');
    this.friendCompass.ariaHidden = 'true';
    this.keyboardGuide.ariaHidden = 'true';
    if (message) this.status.textContent = message;
  }

  hide(): void {
    this.veil.classList.add('hidden');
    this.hud.classList.remove('dim');
    this.friendCompass.classList.remove('dim');
    this.friendCompass.ariaHidden =
      this.friendCompass.classList.contains('on') ? 'false' : 'true';
  }

  private async copyUrl(): Promise<void> {
    // 合言葉は `#` に載せる。クエリも余計な記号も付けない。
    const url = `${location.origin}${location.pathname}#${this.seed}`;
    try {
      await navigator.clipboard.writeText(url);
      this.flash('リンクをコピーしました。友達と同じ世界を歩けます。');
    } catch {
      this.flash(url);
    }
  }

  flash(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('on'), 2600);
  }
}

/**
 * 開始操作に使われた入力。引数だけの純粋関数にして Safari の互換経路をテストする。
 */
export function resolveEntryPointerType(
  recentPointerType: string,
  clickPointerType: string,
  touchCapable: boolean,
  clickDetail: number,
): string {
  // キーボードで button を起動した click は detail=0。タッチ端末でも区別できる。
  if (clickDetail === 0) return 'keyboard';
  if (recentPointerType) return recentPointerType;
  // iOS Safari 18.2 はタッチ由来の click を mouse と報告する。
  if (touchCapable && (clickPointerType === '' || clickPointerType === 'mouse')) {
    return 'touch';
  }
  return clickPointerType || 'keyboard';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 保存領域を閉じた内ブラウザでも、名前入力とプレイは続けられる。
  }
}
