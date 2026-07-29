import assert from 'node:assert/strict';
import { windProfile } from '../src/audio/ambience.ts';

const stopped = windProfile(0);
const walking = windProfile(4);
const cruise = windProfile(78);
const fastest = windProfile(112);

assert.equal(stopped.gain, 0, '停止中に風が鳴ります');
assert.equal(walking.gain, 0, '静音閾値で風が鳴ります');
assert(
  cruise.gain < 0.07,
  `通常飛行の風が強すぎます: ${cruise.gain.toFixed(3)}`,
);
assert(
  fastest.gain <= 0.105,
  `最高速の風が上限を越えています: ${fastest.gain.toFixed(3)}`,
);
assert(
  cruise.cutoff < 350,
  `通常飛行の高域が開きすぎています: ${cruise.cutoff.toFixed(0)} Hz`,
);
assert(
  fastest.cutoff <= 430,
  `最高速の高域が開きすぎています: ${fastest.cutoff.toFixed(0)} Hz`,
);
assert(fastest.gain > cruise.gain, '加速しても風の強さが変わりません');

console.log(
  'PASS  飛行風',
  `巡航 ${cruise.gain.toFixed(3)} / ${cruise.cutoff.toFixed(0)}Hz`,
  `最高速 ${fastest.gain.toFixed(3)} / ${fastest.cutoff.toFixed(0)}Hz`,
  '白色ノイズなし',
);
