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

  /**
   * 値と導関数を同時に返す。out に [値, ∂/∂x, ∂/∂y] を書き込む。
   *
   * 導関数が要るのは、侵食されたような地形を作るため（fbmEroded 参照）。
   * 差分で求めると 3 回引くことになるが、simplex は解析的に出せる。
   *
   * 各角の寄与は t^4 * (g・p) の形。t = 0.5 - |p|^2 なので dt/dp = -2p。
   *   d/dp [ t^4 * (g・p) ] = -8 t^3 (g・p) p + t^4 g
   * 傾いた座標 (i, j) は升目の中で定数なので、そのまま入力の導関数になる。
   */
  noiseD(xin: number, yin: number, out: Float32Array): void {
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
    let dx = 0;
    let dy = 0;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = this.permMod8[ii + this.perm[jj]] * 2;
      const gx = GRAD[g];
      const gy = GRAD[g + 1];
      const dot = gx * x0 + gy * y0;
      const t2 = t0 * t0;
      const t4 = t2 * t2;
      n += t4 * dot;
      const c = -8 * t2 * t0 * dot;
      dx += c * x0 + t4 * gx;
      dy += c * y0 + t4 * gy;
    }

    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = this.permMod8[ii + i1 + this.perm[jj + j1]] * 2;
      const gx = GRAD[g];
      const gy = GRAD[g + 1];
      const dot = gx * x1 + gy * y1;
      const t2 = t1 * t1;
      const t4 = t2 * t2;
      n += t4 * dot;
      const c = -8 * t2 * t1 * dot;
      dx += c * x1 + t4 * gx;
      dy += c * y1 + t4 * gy;
    }

    let t2c = 0.5 - x2 * x2 - y2 * y2;
    if (t2c > 0) {
      const g = this.permMod8[ii + 1 + this.perm[jj + 1]] * 2;
      const gx = GRAD[g];
      const gy = GRAD[g + 1];
      const dot = gx * x2 + gy * y2;
      const t2 = t2c * t2c;
      const t4 = t2 * t2;
      n += t4 * dot;
      const c = -8 * t2 * t2c * dot;
      dx += c * x2 + t4 * gx;
      dy += c * y2 + t4 * gy;
    }

    out[0] = 70 * n;
    out[1] = 70 * dx;
    out[2] = 70 * dy;
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

// fbmEroded の途中計算に使い回す。1 呼び出しごとに配列を作らないため。
const ND = new Float32Array(3);

/**
 * 侵食の効きの強さ。減衰は `1 / (1 + erosion * |累積した傾き|^2)`。
 *
 * **この係数を省くと壊れる（一度壊した）。** 元になった式は導関数の大きさが
 * 0〜1 に収まる前提で書かれているが、ここの noiseD は値と同じ 70 倍で返すので
 * 実際の |傾き| は 2.7〜9.5 になる。係数なしだと減衰が中央 0.035 まで落ち、
 * 「侵食」ではなく「細部の全消し」になる。62% の場所で細部が消え、残る 2% との
 * 境目が等高線状の縞として見えていた。
 *
 * 0.035 なら、平らな所は細部の 5 割が残り、急な所は 2 割まで落ちる。
 */
const EROSION_STRENGTH = 0.035;

/**
 * 侵食されたように見える fBm。
 *
 * ふつうの fBm は、どの場所にも同じだけ細かい起伏を足す。だから山も谷も同じ
 * ざらつきになり、どこまで行っても同じ表情になる。
 *
 * ここでは、**それまでのオクターブの傾きが大きいところほど、細かい起伏を弱める**。
 *
 *   sum += amp * n / (1 + |これまでの導関数|^2)
 *
 * 結果として谷底は平らに、尾根は鋭くなる。水の流れを一切計算していないのに、
 * 侵食された地形の見た目になる。**(x,y) だけの純粋関数のまま。**
 *
 * オクターブごとに座標を回すのは、升目に沿った縞が出るのを防ぐため。
 */
export function fbmEroded(
  n: Noise2D,
  x: number,
  y: number,
  octaves: number,
  freq: number,
  erosion = EROSION_STRENGTH,
  gain = 0.5,
): number {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let px = x * freq;
  let py = y * freq;
  // 累積した傾き。これが減衰のつまみになる。
  let dx = 0;
  let dy = 0;

  for (let o = 0; o < octaves; o++) {
    n.noiseD(px, py, ND);
    dx += ND[1];
    dy += ND[2];
    sum += (amp * ND[0]) / (1 + erosion * (dx * dx + dy * dy));
    norm += amp;
    amp *= gain;
    // 2 倍に拡大しつつ約 37° 回す。
    const nx = (px * 0.8 - py * 0.6) * 2;
    py = (px * 0.6 + py * 0.8) * 2;
    px = nx;
  }
  return sum / norm;
}

/**
 * 折れ点を持つ区分曲線。ノイズの値を高さや振れ幅へ写す。
 *
 * **なぜ掛け算ではなくこれなのか。**
 * なめらかな関数どうしの掛け算は、必ずなめらかで単峰な結果になる。だから
 * 「山が多いか少ないか」しか作れず、「ここから先は台地」という段を作れない。
 * 区分曲線なら、**平らな区間が平原と台地を、急な区間が崖と海岸線を作る。**
 * 地形の種類が、抽選ではなく世界中で連続的に生まれる。
 *
 * pts は [入力, 出力] を入力の昇順で並べたもの。区間内は smoothstep で繋ぐ
 * （線形だと折れ目がそのまま地形の筋になって見える）。
 */
export function spline(pts: readonly (readonly [number, number])[], x: number): number {
  if (x <= pts[0][0]) return pts[0][1];
  const last = pts.length - 1;
  if (x >= pts[last][0]) return pts[last][1];
  for (let i = 0; i < last; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    if (x <= bx) return mix(ay, by, smoothstep(ax, bx, x));
  }
  return pts[last][1];
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
