/**
 * 合言葉の決まり。クライアントとサーバの両方がこのファイルを使う。
 *
 * 同じ検証を 2 か所に書くと必ずズレる。片方だけ緩いと、
 * 弾いたつもりのものが通ってしまう。だからここ 1 つに集約している。
 *
 * 英数字 8 文字に固定しているのは 3 つの理由から:
 *   - URL のパスにそのまま置ける（`/` も空白も符号化も出てこない）
 *   - 書き写せる上限に収まる（口で伝える限界は超える）
 *   - 長さが決まっていれば「途中まで入力した状態」を判定しなくて済む
 *
 * 8 文字 = 36^8 ≒ 2.8 兆通り。数を増やしても地形の多様性は変わらない
 * （それは heightAt / shade の話）。ここは「途方もない場所の一つ」という
 * 手触りのためで、その手触り自体が体験の一部。桁はそのために選んでいる。
 */

/** 合言葉に使える文字。小文字と数字だけ。 */
const SEED_PATTERN = /^[a-z0-9]{8}$/;

export const SEED_LENGTH = 8;

/**
 * 自動生成に使う文字。読み間違えやすい 0 O 1 l を外してある。
 * 口頭やメモで渡されても取り違えないように。
 * （利用者が自分で決める場合はこの制限を掛けない。`sakura` などを許すため）
 */
const GENERATOR_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function isSeed(value: unknown): value is string {
  return typeof value === 'string' && SEED_PATTERN.test(value);
}

/**
 * 入力を合言葉として解釈する。大文字と前後の空白は直して受け入れる。
 * 決まりに合わないものは null を返す。呼び出し側で必ず分岐すること。
 */
export function normalizeSeed(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  return isSeed(value) ? value : null;
}

/**
 * 使える文字（小文字と数字）だけを残す。大文字は小文字に直す。
 * 入力欄が 1 文字ごとに通す。使える文字の定義をここ 1 つに閉じ込めるため、
 * 入力側で正規表現を書き散らかさない。
 */
export function keepSeedChars(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * 新しい合言葉を作る。
 *
 * 32 文字から 8 文字なので約 1.1 兆通り。ここを狭めると、
 * 無関係な人同士が同じ世界に居合わせてしまう（1 人で歩きたい人には事故になる）。
 */
export function randomSeed(): string {
  const bytes = new Uint8Array(SEED_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) {
    out += GENERATOR_ALPHABET[byte % GENERATOR_ALPHABET.length];
  }
  return out;
}
