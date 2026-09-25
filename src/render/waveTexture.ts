import * as THREE from 'three';
import { mulberry32 } from '../core/rng';

/**
 * 波の模様。起動時に 1 度だけ作る 256² のテクスチャで、水のシェーダーが大きさと向きを変えて
 * 3 回引く（render/water.ts）。
 *
 * **シェーダーの中で波を計算しない。** 調べて測った結果（M3、1280×800 の全面、交互に 12 回ずつの中央値）:
 *   - 正弦波 4 本を差分で 4 回引く（元の作り）: 1.17ms。周期がそろい、遠くで斜めの格子模様になる
 *   - 手続きノイズ 3 段を差分で 3 回引く: 2.54ms（2.2 倍）
 *   - このテクスチャを 3 回引く: 0.80ms（3 割減）。模様は繰り返さず、遠くでもちらつかない
 * テクスチャはミップマップで遠くほど自動で均されるので、細かい波が点の格子に化けない。
 *
 * 中身は LEAN マッピング（Olano & Baker 2010）の形。r,g = 傾き、b = 傾きの 2 乗、a = 高さ。
 * ミップマップで平均すると「傾きの 2 乗の平均 − 平均の傾きの 2 乗」が、見えなくなった波の
 * 傾きの分散になる。シェーダーはこれで太陽の照り返しの広がりを決める（Bruneton et al. 2010 の
 * 「幾何から BRDF へのなめらかな移行」）。近くでは波の 1 枚ずつがきらめき、遠くでは
 * 太陽の下に広い光の道ができる ── 飛行機から見た海と同じ見え方。
 *
 * 海面は波のスペクトルから逆フーリエ変換で作る（256² で数 ms）。フーリエ変換の結果は
 * もともと上下左右がつながるので継ぎ目が出ない。引く側で 3 段の大きさの比を整数にしない
 * （337 : 61 : 17.3）ので、繰り返しもそろわない。
 * 表示専用なので決定性の決まりの外（島ごとに変える必要もない）。
 */

const SIZE = 256;
/** 符号化できる傾きの上限。シェーダーの WAVE_SLOPE と同じ値にする。 */
export const WAVE_SLOPE = 0.6;
/** 風の向き（ラジアン）。 */
const WIND = 0.4;
/** 一番強い波の波長（画素）。これより長い波は急に弱まる。 */
const PEAK = 48;
/** これより短い波は弱める（画素）。1 画素の模様がミップマップ前にちらつかないように。 */
const SMALLEST = 3;

/** 長さ n（2 のべき）の複素数列を、その場で逆フーリエ変換する（正規化はしない）。 */
function ifft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** 2 次元の逆フーリエ変換（行、列の順）。実部を返す。 */
function ifft2(re: Float64Array, im: Float64Array): Float32Array {
  const rowR = new Float64Array(SIZE);
  const rowI = new Float64Array(SIZE);
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < SIZE; a++) {
      for (let b = 0; b < SIZE; b++) {
        const o = pass === 0 ? a * SIZE + b : b * SIZE + a;
        rowR[b] = re[o];
        rowI[b] = im[o];
      }
      ifft(rowR, rowI);
      for (let b = 0; b < SIZE; b++) {
        const o = pass === 0 ? a * SIZE + b : b * SIZE + a;
        re[o] = rowR[b];
        im[o] = rowI[b];
      }
    }
  }
  return Float32Array.from(re);
}

/**
 * 海の波のスペクトル（Phillips、Tessendorf 2001）から、止まった 1 枚の海面を作る。
 * 波長ごとの強さと、風の向きへの偏りを持った無数の波の和になる。
 * 少数の正弦波の和だと、短い波が数本だけ目立って網目の模様になった（一度これで作って見えた）。
 */
function oceanSpectrum(): { h: Float32Array; sx: Float32Array; sz: Float32Array } {
  const rand = mulberry32(0x5eed_a11e);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const count = SIZE * SIZE;
  const hr = new Float64Array(count);
  const hi = new Float64Array(count);
  const xr = new Float64Array(count);
  const xi = new Float64Array(count);
  const zr = new Float64Array(count);
  const zi = new Float64Array(count);
  const wx = Math.cos(WIND);
  const wz = Math.sin(WIND);
  const peakK = (2 * Math.PI) / PEAK;
  const smallK = (2 * Math.PI) / SMALLEST;
  for (let j = 0; j < SIZE; j++) {
    for (let i = 0; i < SIZE; i++) {
      // 周波数の番号を -SIZE/2..SIZE/2 に。
      const m = i < SIZE / 2 ? i : i - SIZE;
      const n = j < SIZE / 2 ? j : j - SIZE;
      const o = j * SIZE + i;
      const g1 = gauss();
      const g2 = gauss();
      if (m === 0 && n === 0) continue;
      const kx = (2 * Math.PI * m) / SIZE;
      const kz = (2 * Math.PI * n) / SIZE;
      const k = Math.hypot(kx, kz);
      const align = (kx * wx + kz * wz) / k;
      // 風に沿う波ほど強く、風と直角の波はほぼ無し。逆向きの波も少し残す（真っ直ぐな縞にしない）。
      const dir = align * align * (align < 0 ? 0.35 : 1);
      const phillips =
        (Math.exp(-1 / ((k / peakK) * (k / peakK))) / (k * k * k * k)) * dir * Math.exp(-(k / smallK) * (k / smallK));
      const amp = Math.sqrt(phillips / 2);
      const ar = g1 * amp;
      const ai = g2 * amp;
      hr[o] = ar;
      hi[o] = ai;
      // 傾き = i k h
      xr[o] = -kx * ai;
      xi[o] = kx * ar;
      zr[o] = -kz * ai;
      zi[o] = kz * ar;
    }
  }
  return { h: ifft2(hr, hi), sx: ifft2(xr, xi), sz: ifft2(zr, zi) };
}

export function createWaveTexture(): THREE.DataTexture {
  const count = SIZE * SIZE;
  const { h, sx, sz } = oceanSpectrum();

  // 傾きの 99.5% が WAVE_SLOPE に収まるよう縮める（まれな尖りで全体の精度を落とさない）。
  const mags = Array.from(sx, (v, o) => Math.max(Math.abs(v), Math.abs(sz[o]))).sort((a, b) => a - b);
  const slopeScale = WAVE_SLOPE / mags[Math.floor(count * 0.995)];
  let hMax = 0;
  for (let o = 0; o < count; o++) hMax = Math.max(hMax, Math.abs(h[o]));

  const data = new Uint8Array(count * 4);
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let o = 0; o < count; o++) {
    const x = Math.max(-WAVE_SLOPE, Math.min(WAVE_SLOPE, sx[o] * slopeScale));
    const z = Math.max(-WAVE_SLOPE, Math.min(WAVE_SLOPE, sz[o] * slopeScale));
    data[o * 4] = byte(x / WAVE_SLOPE * 0.5 + 0.5);
    data[o * 4 + 1] = byte(z / WAVE_SLOPE * 0.5 + 0.5);
    data[o * 4 + 2] = byte((x * x + z * z) / (2 * WAVE_SLOPE * WAVE_SLOPE));
    data[o * 4 + 3] = byte(h[o] / hMax * 0.5 + 0.5);
  }

  const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
