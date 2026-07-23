const { isSeed, normalizeSeed, keepSeedChars, randomSeed } =
  await import('../shared/seed.ts');

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`);
};

check('8文字の英数字は通る', isSeed('abc12345'));
check('7文字は弾く', !isSeed('abc1234'));
check('9文字は弾く', !isSeed('abc123456'));
check('大文字はそのままでは弾く', !isSeed('ABC12345'));
check('記号は弾く', !isSeed('abc/1234'));
check('日本語は弾く', !isSeed('さくら1234'));
check('空は弾く', !isSeed(''));
check('スラッシュは弾く（パスが割れるため）', !isSeed('a/b/c123'));

check('大文字は小文字に直して受ける', normalizeSeed('AOZORA12') === 'aozora12');
check('前後の空白は落として受ける', normalizeSeed('  aozora12 ') === 'aozora12');
check('決まりに合わなければ null', normalizeSeed('さくら') === null);
check('長すぎるものは切らずに null', normalizeSeed('abcdefghi') === null);

check('入力途中の記号は落ちる', keepSeedChars('a-b_c/1!23') === 'abc123');
check('長い貼り付けはそのまま返す(切り詰めは呼び側)', keepSeedChars('abcdefghijkl') === 'abcdefghijkl');
check('大文字は小文字になる', keepSeedChars('SaKuRaBc') === 'sakurabc');

const seeds = new Set();
for (let i = 0; i < 3000; i++) {
  const s = randomSeed();
  if (!isSeed(s)) { check('生成したものが決まりに合わない', false, s); break; }
  seeds.add(s);
}
check('生成したものは必ず決まりに合う', true);
check('3000個作って重複しない', seeds.size === 3000, `${seeds.size} 種類`);
check('紛らわしい文字を使わない', ![...seeds].some((s) => /[01lo]/.test(s)));

console.log(`\n${pass} / ${pass + fail} 通過`);
process.exit(fail === 0 ? 0 : 1);
