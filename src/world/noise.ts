import { mulberry32 } from '../core/rng';

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

// 8 方向の勾配ベクトル。2D simplex はこれで十分な等方性が出る。
const GRAD = new Float32Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1]);

/** シードから決まる 2D simplex ノイズ。戻り値はおおよそ [-1, 1]。 */
export class Noise2D {
  private perm = new Uint8Array(512);
  private permMod8 = new Uint8Array(512);

  constructor(seed: number) {
    const rand = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    // Fisher-Yates
    for (let i = 255; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0;
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod8[i] = this.perm[i] % 8;
    }
  }

  noise(xin: number, yin: number): number {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);

    let i1: number, j1: number;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    } else {
      i1 = 0;
      j1 = 1;
    }

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;

    let n = 0;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = this.permMod8[ii + this.perm[jj]] * 2;
      t0 *= t0;
      n += t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0);
    }

    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = this.permMod8[ii + i1 + this.perm[jj + j1]] * 2;
      t1 *= t1;
      n += t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1);
    }

    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = this.permMod8[ii + 1 + this.perm[jj + 1]] * 2;
      t2 *= t2;
      n += t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2);
    }

    return 70 * n;
  }
}

/** 重ね合わせノイズ。大きなうねりの上に細かい起伏を足していく。 */
export function fbm(
  n: Noise2D,
  x: number,
  y: number,
  octaves: number,
  freq: number,
  lacunarity = 2.0,
  gain = 0.5,
): number {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let f = freq;
  for (let o = 0; o < octaves; o++) {
    sum += amp * n.noise(x * f, y * f);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/**
 * 尾根状ノイズ。絶対値を折り返すことで山の稜線ができる。
 * 戻り値は [0, 1]。
 */
export function ridged(
  n: Noise2D,
  x: number,
  y: number,
  octaves: number,
  freq: number,
  lacunarity = 2.0,
  gain = 0.5,
): number {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let f = freq;
  let prev = 1;
  for (let o = 0; o < octaves; o++) {
    const r = 1 - Math.abs(n.noise(x * f, y * f));
    const v = r * r * prev;
    prev = v;
    sum += amp * v;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
