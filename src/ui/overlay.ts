import { SeedField } from './seedField';

export interface OverlayHandlers {
  onStart: () => void;
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
  private hud: HTMLElement;
  private toast: HTMLElement;
  private seed: string;
  private handlers: OverlayHandlers;
  private toastTimer = 0;

  /** 他の人の画面に出る表示名。 */
  name: string;

  private peers: HTMLElement;
  private peersText = '';
  private touch: boolean;

  constructor(root: HTMLElement, seed: string, touch: boolean, handlers: OverlayHandlers) {
    this.root = root;
    this.seed = seed;
    this.touch = touch;
    this.handlers = handlers;

    this.name = (localStorage.getItem(NAME_KEY) ?? '').slice(0, MAX_NAME_LENGTH);

    this.root.innerHTML = `
      <div class="veil">
        <div class="card">
          <header class="brand">
            <h1>stroll</h1>
            <p class="lead">歩くだけの世界。目的も、期限もない。</p>
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

          <button class="start" disabled>地形を生成しています…</button>
          <button class="share">この世界のURLをコピー</button>

          <details class="controls">
            <summary>操作</summary>
            <ul class="keys">
              <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 歩く</li>
              <li><kbd>W</kbd><kbd>W</kbd> 走る</li>
              <li><kbd>Space</kbd> 跳ぶ</li>
              <li><kbd>Space</kbd><kbd>Space</kbd> 飛ぶ</li>
              <li><kbd>M</kbd> 消音</li>
              <li><kbd>Esc</kbd> 一時停止</li>
            </ul>
            <p class="controls-note">飛行中は見ている方へ進みます。<kbd>Space</kbd> 上昇、<kbd>Shift</kbd> 下降。</p>
          </details>
        </div>
      </div>
      <div class="hud">
        <span class="hud-seed">${escapeHtml(seed)}</span>
        <span class="hud-peers"></span>
      </div>
      <div class="toast"></div>
    `;

    this.veil = this.root.querySelector('.veil')!;
    this.status = this.root.querySelector('.lead')!;
    this.startBtn = this.root.querySelector('.start')!;
    this.hud = this.root.querySelector('.hud')!;
    this.toast = this.root.querySelector('.toast')!;

    this.peers = this.root.querySelector('.hud-peers')!;

    this.startBtn.addEventListener('click', () => this.handlers.onStart());
    this.root.querySelector('.share')!.addEventListener('click', () => this.copyUrl());

    const nameInput = this.root.querySelector('.name') as HTMLInputElement;
    nameInput.addEventListener('input', () => {
      this.name = nameInput.value.slice(0, MAX_NAME_LENGTH);
      localStorage.setItem(NAME_KEY, this.name);
    });
    // 名前欄で Enter を押したらそのまま歩き出せるようにする。
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !this.startBtn.disabled) {
        e.preventDefault();
        this.handlers.onStart();
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
    if (!this.startBtn.disabled) return;
    this.startBtn.disabled = false;
    this.startBtn.textContent = this.touch
      ? 'タップして歩きはじめる'
      : 'クリックして歩きはじめる';
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
