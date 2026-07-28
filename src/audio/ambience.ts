import type { AudioEngine } from './engine';

export interface AmbienceParams {
  /** 移動速度 (m/s)。風の音はこれだけで決まる。 */
  speed: number;
  /** 0..1。周りの木の多さ。鳥の鳴く頻度になる。 */
  moisture: number;
  /** 地面からの高さ。高空で地上の鳥を耳元に鳴らさない。 */
  altitude: number;
}

/** この速度までは無音。歩いているだけで風が鳴ると落ち着かない。 */
const SILENT_BELOW = 4;
/** 巡航の風。高速域は別の細い風切り音へ受け渡す。 */
const CRUISE_FULL_AT = 82;
const MAX_GAIN = 0.17;
const FAST_FROM = 58;
const FAST_FULL_AT = 112;
const FAST_MAX_GAIN = 0.11;

/**
 * 風は自分が動いたときだけ鳴る。立ち止まれば静かになる。
 * 時間で勝手に吹かせると、鳴りっぱなしで疲れるだけだった。
 * 鳥は別枠で、たまに鳴く。
 */
export class Ambience {
  private engine: AudioEngine;
  private gain: GainNode;
  private filter: BiquadFilterNode;
  private fastGain: GainNode;
  private fastFilter: BiquadFilterNode;
  private birdBus: GainNode;
  private birdTimer = 6;

  constructor(engine: AudioEngine) {
    this.engine = engine;
    const ctx = engine.ctx;

    const src = engine.loopNoise('brown');
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 200;
    this.filter.Q.value = 0.7;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    src.connect(this.filter).connect(this.gain).connect(engine.master);

    const fast = engine.loopNoise('white');
    this.fastFilter = ctx.createBiquadFilter();
    this.fastFilter.type = 'bandpass';
    this.fastFilter.frequency.value = 950;
    this.fastFilter.Q.value = 0.55;
    this.fastGain = ctx.createGain();
    this.fastGain.gain.value = 0;
    fast.connect(this.fastFilter).connect(this.fastGain).connect(engine.master);

    this.birdBus = ctx.createGain();
    this.birdBus.gain.value = 1;
    this.birdBus.connect(engine.master);
    const send = ctx.createGain();
    send.gain.value = 0.8;
    this.birdBus.connect(send).connect(engine.reverbSend);
  }

  update(dt: number, p: AmbienceParams): void {
    const now = this.engine.ctx.currentTime;

    // 速いほど強く、そして高く鳴る。速度感がそのまま音になる。
    const t = Math.min(
      1,
      Math.max(0, (p.speed - SILENT_BELOW) / (CRUISE_FULL_AT - SILENT_BELOW)),
    );
    const level = Math.pow(t, 1.15) * MAX_GAIN;
    // 加速に少し遅れて追いつく程度の速さで。即座に切り替わると不自然。
    this.gain.gain.setTargetAtTime(level, now, 0.18);
    this.filter.frequency.setTargetAtTime(190 + t * 760, now, 0.25);

    // 速い風だけを高い帯域へ足す。巡航と高速移動を耳でも区別できる。
    const fast = Math.min(1, Math.max(0, (p.speed - FAST_FROM) / (FAST_FULL_AT - FAST_FROM)));
    this.fastGain.gain.setTargetAtTime(Math.pow(fast, 1.35) * FAST_MAX_GAIN, now, 0.16);
    this.fastFilter.frequency.setTargetAtTime(850 + fast * 1350, now, 0.2);

    const birdProximity = 1 - smoothstep(24, 115, p.altitude);
    this.birdBus.gain.setTargetAtTime(birdProximity, now, 0.5);

    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      const trees = Math.min(1, Math.max(0, (p.moisture - 0.35) / 0.35));
      this.birdTimer = 7 + Math.random() * 18;
      if (birdProximity > 0.08 && trees > 0.3 && Math.random() < trees) {
        this.chirp(trees * birdProximity);
      }
    }
  }

  /** 数音の短いさえずり。音程と間を毎回変える。 */
  private chirp(loudness: number): void {
    const ctx = this.engine.ctx;
    const t0 = ctx.currentTime + 0.02;
    const base = 1500 + Math.random() * 1900;
    const notes = 2 + ((Math.random() * 3) | 0);

    for (let i = 0; i < notes; i++) {
      const t = t0 + i * (0.075 + Math.random() * 0.09);
      const f = base * (0.82 + Math.random() * 0.4);
      const dur = 0.05 + Math.random() * 0.06;

      const osc = ctx.createOscillator();
      osc.type = Math.random() < 0.5 ? 'sine' : 'triangle';
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * (1.15 + Math.random() * 0.5), t + dur * 0.4);
      osc.frequency.exponentialRampToValueAtTime(f * 0.85, t + dur);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05 * loudness, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      osc.connect(g).connect(this.birdBus);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }
  }
}

function smoothstep(a: number, b: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
