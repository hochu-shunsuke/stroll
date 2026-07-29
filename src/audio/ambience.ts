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
/** 最高速でようやく最大になる。巡航時から風が主張しすぎないようにする。 */
const WIND_FULL_AT = 112;
const WIND_MAX_GAIN = 0.105;
const WIND_CUTOFF_MIN = 140;
const WIND_CUTOFF_MAX = 430;

export interface WindProfile {
  gain: number;
  cutoff: number;
}

/**
 * 速度から風の音量と低域フィルターを決める。
 * 高速専用の白色ノイズは耳障りなシャー音になるため、ここには足さない。
 */
export function windProfile(speed: number): WindProfile {
  const t = Math.min(
    1,
    Math.max(0, (speed - SILENT_BELOW) / (WIND_FULL_AT - SILENT_BELOW)),
  );
  return {
    gain: Math.pow(t, 1.35) * WIND_MAX_GAIN,
    cutoff: WIND_CUTOFF_MIN + t * (WIND_CUTOFF_MAX - WIND_CUTOFF_MIN),
  };
}

/**
 * 風は自分が動いたときだけ鳴る。立ち止まれば静かになる。
 * 時間で勝手に吹かせると、鳴りっぱなしで疲れるだけだった。
 * 鳥は別枠で、たまに鳴く。
 */
export class Ambience {
  private engine: AudioEngine;
  private gain: GainNode;
  private filter: BiquadFilterNode;
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

    this.birdBus = ctx.createGain();
    this.birdBus.gain.value = 1;
    this.birdBus.connect(engine.master);
    const send = ctx.createGain();
    send.gain.value = 0.8;
    this.birdBus.connect(send).connect(engine.reverbSend);
  }

  update(dt: number, p: AmbienceParams): void {
    const now = this.engine.ctx.currentTime;

    // ブラウンノイズの低い風だけを、加速に少し遅れて追従させる。
    const wind = windProfile(p.speed);
    this.gain.gain.setTargetAtTime(wind.gain, now, 0.24);
    this.filter.frequency.setTargetAtTime(wind.cutoff, now, 0.32);

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
