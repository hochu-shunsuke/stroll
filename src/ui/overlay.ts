export interface OverlayHandlers {
  onStart: () => void;
  onVolume: (value: number) => void;
  /** 合言葉が変わったとき。世界ごと作り直すので読み込み直す。 */
  onSeed: (seed: string) => void;
}

const VOLUME_KEY = 'stroll:volume';
const NAME_KEY = 'stroll:name';
const MAX_NAME_LENGTH = 16;
/** サーバ側の上限と揃えること。 */
const MAX_SEED_LENGTH = 64;

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

  /** 0..1。前回の設定を覚えておく。 */
  volume: number;
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

    const saved = Number(localStorage.getItem(VOLUME_KEY));
    this.volume = Number.isFinite(saved) && saved >= 0 && saved <= 1 ? saved : 0.75;
    this.name = (localStorage.getItem(NAME_KEY) ?? '').slice(0, MAX_NAME_LENGTH);

    this.root.innerHTML = `
      <div class="veil">
        <div class="card">
          <h1>stroll</h1>
          <p class="lead">歩くだけの世界です。目的も、期限もありません。</p>
          <button class="start" disabled>地形を生成しています…</button>
          <ul class="keys">
            <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 歩く</li>
            <li><kbd>W</kbd><kbd>W</kbd> 走る</li>
            <li><kbd>Space</kbd> 跳ぶ</li>
            <li><kbd>Space</kbd><kbd>Space</kbd> 飛ぶ / 戻す</li>
            <li><kbd>M</kbd> 消音</li>
            <li><kbd>Esc</kbd> 一時停止</li>
          </ul>
          <p class="note note-keys">飛行中は見ている方へ進みます。<kbd>Space</kbd> で上昇、<kbd>Shift</kbd> で下降。</p>
          <label class="field">
            <span>名前</span>
            <input class="name" type="text" maxlength="${MAX_NAME_LENGTH}"
              placeholder="友達に表示される名前" value="${escapeHtml(this.name)}" />
          </label>
          <label class="field">
            <span>合言葉</span>
            <input class="seed-input" type="text" maxlength="${MAX_SEED_LENGTH}"
              placeholder="好きな言葉" value="${escapeHtml(seed)}" />
          </label>
          <p class="hint">同じ合言葉なら同じ地形。友達と一緒に歩けます。</p>
          <label class="field">
            <span>音量</span>
            <input class="vol" type="range" min="0" max="1" step="0.01" value="${this.volume}" />
          </label>
          <button class="share">この世界のURLをコピー</button>
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

    const slider = this.root.querySelector('.vol') as HTMLInputElement;
    slider.addEventListener('input', () => {
      this.volume = Number(slider.value);
      localStorage.setItem(VOLUME_KEY, String(this.volume));
      this.handlers.onVolume(this.volume);
    });

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

    // 合言葉を変えると地形も部屋も別物になるので、確定したときだけ反映する。
    // 入力の途中で world を作り直すと、一文字打つたびに世界が変わってしまう。
    const seedInput = this.root.querySelector('.seed-input') as HTMLInputElement;
    const applySeed = () => {
      const next = seedInput.value.trim().slice(0, MAX_SEED_LENGTH);
      if (!next || next === this.seed) {
        seedInput.value = this.seed;
        return;
      }
      this.handlers.onSeed(next);
    };
    seedInput.addEventListener('change', applySeed);
    seedInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      applySeed();
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
    const url = new URL(location.href);
    url.searchParams.set('seed', this.seed);
    try {
      await navigator.clipboard.writeText(url.toString());
      this.flash('URLをコピーしました。同じ地形が開きます。');
    } catch {
      this.flash(url.toString());
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
