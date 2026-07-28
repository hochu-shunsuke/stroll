import { SeedField } from './seedField';

export interface OverlayHandlers {
  onStart: (resume: boolean, pointerType: string) => void;
  /** 合言葉が変わったとき。世界ごと作り直すので読み込み直す。 */
  onSeed: (seed: string) => void;
}

const NAME_KEY = 'stroll:name';
const MAX_NAME_LENGTH = 16;

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
  private toast: HTMLElement;
  private seed: string;
  private handlers: OverlayHandlers;
  private toastTimer = 0;

  /** 他の人の画面に出る表示名。 */
  name: string;

  private peers: HTMLElement;
  private peersText = '';
  private flightText = '';
  private touch: boolean;
  private resumable: boolean;
  private ready = false;
  private entered = false;

  constructor(
    root: HTMLElement,
    seed: string,
    touch: boolean,
    resumable: boolean,
    handlers: OverlayHandlers,
  ) {
    this.root = root;
    this.seed = seed;
    this.touch = touch;
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
            <p class="controls-note">飛行中は <kbd>Space</kbd> 上昇、<kbd>C</kbd> 下降。自動飛行中は視点を自由に動かせます。</p>
          </details>
        </div>
      </div>
      <div class="hud">
        <span class="hud-seed">${escapeHtml(seed)}</span>
        <span class="hud-peers"></span>
      </div>
      <div class="flight-hud"></div>
      <div class="toast"></div>
    `;

    this.veil = this.root.querySelector('.veil')!;
    this.status = this.root.querySelector('.lead')!;
    this.startBtn = this.root.querySelector('.start')!;
    this.freshBtn = this.root.querySelector('.fresh')!;
    this.hud = this.root.querySelector('.hud')!;
    this.flightHud = this.root.querySelector('.flight-hud')!;
    this.toast = this.root.querySelector('.toast')!;

    this.peers = this.root.querySelector('.hud-peers')!;

    this.startBtn.addEventListener('click', (event) => {
      this.handlers.onStart(this.resumable, pointerTypeOf(event));
    });
    this.freshBtn.addEventListener('click', (event) => {
      this.handlers.onStart(false, pointerTypeOf(event));
    });
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
   * 画面の隅に「今この世界に何人いるか」を出す。
   * 毎フレーム呼ばれるので、変わっていないときは触らない。
   */
  setPeers(count: number, message: string | null): void {
    const text = message ?? (count > 0 ? `ほかに ${count} 人` : '');
    if (text === this.peersText) return;
    this.peersText = text;
    this.peers.textContent = text;
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
    if (message) this.status.textContent = message;
  }

  hide(): void {
    this.veil.classList.add('hidden');
    this.hud.classList.remove('dim');
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

function pointerTypeOf(event: Event): string {
  return typeof PointerEvent !== 'undefined' && event instanceof PointerEvent
    ? event.pointerType
    : 'keyboard';
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
