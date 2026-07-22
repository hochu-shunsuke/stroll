import type { AudioEngine } from './engine';

/** 踏み込みの低音。足音の主役はこちら。 */
const THUMP_FREQ = 64;
const THUMP_GAIN = 0.26;
/** 擦れの成分。低く抑えて、上に乗せる程度に留める。 */
const SCUFF_FREQ = 520;
const SCUFF_GAIN = 0.11;
const SCUFF_DURATION = 0.07;

/**
 * 足音。硬いものを踏んだときの低い衝撃を狙っている。
 * 材質では変えない。歩いている間ずっと鳴るものなので、
 * 種類を増やすより 1 つを気持ちよくする方が効く。
 */
export class Footsteps {
  private engine: AudioEngine;
  /** 左右で微妙に音を変えるための切り替え。 */
  private foot = 0;

  constructor(engine: AudioEngine) {
    this.engine = engine;
  }

  step(intensity: number): void {
    this.foot ^= 1;
    // 左右差と個体差。この揺らぎがないと足音は一気に嘘くさくなる。
    const detune = (this.foot ? 1.06 : 0.94) * (0.93 + Math.random() * 0.14);
    this.play(intensity * (0.88 + Math.random() * 0.24), detune, 1);
  }

  /** 着地音。踏み込みだけ強くした 1 発。 */
  land(intensity: number): void {
    this.play(intensity, 0.84, 2.0);
  }

  private play(level: number, detune: number, weight: number): void {
    const ctx = this.engine.ctx;
    const t = ctx.currentTime + 0.005;

    // 低音の衝撃。少し下がりながら消えると「硬いものを踏んだ」感じになる。
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(THUMP_FREQ * detune, t);
    osc.frequency.exponentialRampToValueAtTime(THUMP_FREQ * 0.62 * detune, t + 0.09);

    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(THUMP_GAIN * level * weight, t + 0.006);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.13 * weight);

    osc.connect(og).connect(this.engine.master);
    osc.start(t);
    osc.stop(t + 0.2 * weight);

    // 擦れ。低く切ったノイズを短く。
    const dur = SCUFF_DURATION * (0.9 + Math.random() * 0.2) * weight;
    const src = ctx.createBufferSource();
    src.buffer = this.engine.white;
    src.playbackRate.value = detune;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = SCUFF_FREQ * detune;
    filter.Q.value = 0.9;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(SCUFF_GAIN * level, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(filter).connect(g).connect(this.engine.master);

    // 反響は薄く。足音は自分の足元の音なので、遠くに響かせない。
    const send = ctx.createGain();
    send.gain.value = 0.08;
    g.connect(send).connect(this.engine.reverbSend);

    // 3 秒のバッファのどこから切り出すかを毎回変える。
    src.start(t, Math.random() * (this.engine.white.duration - dur - 0.05), dur + 0.05);
    src.stop(t + dur + 0.05);
  }
}
