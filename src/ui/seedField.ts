import { SEED_LENGTH, isSeed, randomSeed } from '../../shared/seed';

/**
 * 合言葉を 1 文字ずつ 8 マスで入力する欄。隣にサイコロ（引き直し）。
 *
 * 固定長を見た目で伝えたいので、1 つの入力欄ではなくマスに割っている。
 * マスを埋めると次へ進み、8 個埋まると確定する。
 */
export class SeedField {
  readonly element: HTMLElement;
  private cells: HTMLInputElement[] = [];
  private onCommit: (seed: string) => void;

  constructor(initial: string, onCommit: (seed: string) => void) {
    this.onCommit = onCommit;

    this.element = document.createElement('div');
    this.element.className = 'seed-field';

    const boxes = document.createElement('div');
    boxes.className = 'seed-boxes';
    for (let i = 0; i < SEED_LENGTH; i++) {
      const cell = document.createElement('input');
      cell.className = 'seed-cell';
      cell.type = 'text';
      cell.inputMode = 'text';
      cell.autocapitalize = 'off';
      cell.autocomplete = 'off';
      cell.spellcheck = false;
      cell.maxLength = 1;
      cell.value = initial[i] ?? '';
      cell.dataset.index = String(i);
      this.wire(cell, i);
      this.cells.push(cell);
      boxes.appendChild(cell);
    }

    const dice = document.createElement('button');
    dice.type = 'button';
    dice.className = 'seed-dice';
    dice.title = '別の世界を引く';
    dice.setAttribute('aria-label', '別の世界を引く');
    dice.textContent = '⚄';
    dice.addEventListener('click', () => {
      this.set(randomSeed());
      this.commit();
    });

    this.element.append(boxes, dice);
  }

  /** 今の 8 マスを繋げた文字列。 */
  get value(): string {
    return this.cells.map((c) => c.value).join('');
  }

  /** 8 文字を各マスに配る。 */
  set(seed: string): void {
    for (let i = 0; i < SEED_LENGTH; i++) {
      this.cells[i].value = seed[i] ?? '';
    }
  }

  private wire(cell: HTMLInputElement, index: number): void {
    cell.addEventListener('input', () => {
      // 使える文字だけ残す。貼り付けで複数入っても 1 文字に詰める。
      const cleaned = cell.value.toLowerCase().replace(/[^a-z0-9]/g, '');
      cell.value = cleaned.slice(-1);
      // 何か入ったら次のマスへ。最後のマスが埋まれば確定を試す。
      if (cell.value && index < SEED_LENGTH - 1) {
        this.cells[index + 1].focus();
        this.cells[index + 1].select();
      } else if (cell.value && index === SEED_LENGTH - 1) {
        this.commit();
      }
    });

    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !cell.value && index > 0) {
        // 空のマスで消したら前へ戻る。連続して消せるように。
        e.preventDefault();
        this.cells[index - 1].focus();
        this.cells[index - 1].value = '';
      } else if (e.key === 'ArrowLeft' && index > 0) {
        this.cells[index - 1].focus();
      } else if (e.key === 'ArrowRight' && index < SEED_LENGTH - 1) {
        this.cells[index + 1].focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.commit();
      }
    });

    cell.addEventListener('focus', () => cell.select());

    // 8 文字まとめて貼り付けられたら、全マスに配る。
    cell.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData?.getData('text') ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, SEED_LENGTH);
      if (!text) return;
      // 貼り付けた位置から順に埋める。
      for (let i = 0; i < text.length && index + i < SEED_LENGTH; i++) {
        this.cells[index + i].value = text[i];
      }
      const last = Math.min(index + text.length, SEED_LENGTH - 1);
      this.cells[last].focus();
      if (isSeed(this.value)) this.commit();
    });
  }

  /** 8 マスが揃っていれば確定を通知する。揃っていなければ何もしない。 */
  private commit(): void {
    const seed = this.value;
    if (isSeed(seed)) this.onCommit(seed);
  }
}
