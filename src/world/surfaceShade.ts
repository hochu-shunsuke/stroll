import { clamp, mix, smoothstep } from './noise';
import { SPECIAL_BIOMES, type SpecialHit, srgb } from './special';

// 色は hakoniwa と揃えてある（あちらで地形の性質ごとに塗り分けて見た目を詰めた）。
const C_SAND = srgb(0xd8c79c);
export const C_SNOW = srgb(0xeef2f4);
const C_SCRUB = srgb(0x8a8052);
const C_DRY = srgb(0xbcae78);
const C_LUSH = srgb(0x3c6a3a);
const C_SCREE = srgb(0x9d988c);
/** 水の中の地面。浅瀬は砂が透けて見え、深くなるほど青緑に沈む。 */
const C_SEABED = srgb(0x2f5b5c);

/** 岩の種類。[明るい面, 暗い面]。rockTone（-1..1）で地方ごとに混ぜる。 */
const ROCKS: readonly (readonly [readonly number[], readonly number[]])[] = [
  [srgb(0x93918b), srgb(0x62615d)], // 花崗岩
  [srgb(0xab7c5d), srgb(0x75503d)], // 砂岩
  [srgb(0x5e5956), srgb(0x3b3735)], // 玄武岩
  [srgb(0xbfb8a7), srgb(0x8f887a)], // 石灰岩
];

// 曲がりによる明暗（擬似 AO）。凹みを暗く、盛り上がりを明るくして、影を落とさずに形を読ませる。
// 16m 尺度の曲がりで測る（チャンクの格子で測ると LOD ごとに明暗が変わり、細部で面ごとに跳ぶ）。
// x/(1+x) で柔らかく飽和させる（clamp で切ると 1 割以上の面が一律に張り付いて黒い斑になる）。
const CURVATURE_GAIN = 6;
const CURVATURE_DARK = 0.3;
const CURVATURE_LIGHT = 0.15;

/**
 * 気候帯ごとの地面の色。気温 3 段 × 湿り気 3 段の格子を双一次で混ぜる。
 *
 * **段の位置は実測の分位点に置いてある（下の STOPS）。** 名目の 0..1 に置くと、
 * 気温は中央値 0.41・9 割地点でも 0.75 までしか行かないので、端の色（砂漠・
 * 密林）に一生たどり着かなかった。世界が黄緑一色に見えていた原因のひとつ。
 *
 * **真ん中の湿り気に独自の色を与えたのが要。** 世界の 6 割はここに居るのに、
 * 以前は「乾と湿の中間色」しか無く、サバンナもタイガも表現できなかった。
 * Minecraft のバイオームを調べて分かった一番大きな穴がこれ。
 */
const TEMP_STOPS = [0.14, 0.45, 0.76] as const;
const MOIST_STOPS = [0.15, 0.42, 0.66] as const;

// [湿り気の段 * 3 + 気温の段]。気温は寒→温→暑、湿り気は乾→中→湿。
const CLIMATE = [
  // 乾
  srgb(0x87958d), // 寒・乾: ツンドラ（青みのある灰緑）
  srgb(0xb4b56d), // 温・乾: 乾いた草原（黄緑）
  srgb(0xd5bd82), // 暑・乾: 砂漠（明るい黄土）
  // 中
  srgb(0x58756b), // 寒・中: タイガ（暗い青緑）
  srgb(0x6f9850), // 温・中: 森
  srgb(0xb8974e), // 暑・中: サバンナ（金茶）
  // 湿
  C_SNOW, //         寒・湿: 雪
  srgb(0x427744), // 温・湿: 深い森（深い緑）
  srgb(0x3f8e42), // 暑・湿: みずみずしい密林
] as const;

/** 段の並びの中で t がどの区間に居るかと、その中の位置（smoothstep 済み）。 */
function segment(stops: readonly number[], t: number): [number, number] {
  if (t <= stops[1]) return [0, smoothstep(stops[0], stops[1], t)];
  return [1, smoothstep(stops[1], stops[2], t)];
}

/**
 * 1 点ぶんの地面の層の並び。
 *   0..2 土台の色（草・土・砂・海底）、3..5 岩の色、6 岩の量、7 雪の量、8 凹みの明暗（1 で変化なし）
 *
 * **ここでは色を混ぜ切らない。** 層と量を頂点ごとに返し、境目は画素ごとに揺らして切る
 * （render/terrainMaterial.ts）。四角形ごとに 1 色に混ぜ切っていた頃は、雪と岩の境が
 * 格子に揃い、遠くの粗いチャンクほど大きな市松模様になった（利用者の指摘）。
 */
export const SURFACE_STRIDE = 9;

/** 色を塗るための 16m 尺度の地形の性質（チャンクが 16m 間隔の格子で測って渡す）。 */
export interface SurfaceFields {
  /** 傾き（勾配の大きさ）。 */
  slope: number;
  /** 曲がり。正 = 尾根、負 = 谷筋（m あたり）。 */
  curvature: number;
}

const RGB = new Float32Array(3);
const ROCK = new Float32Array(3);

function blend(target: ArrayLike<number>, t: number): void {
  if (t <= 0) return;
  RGB[0] = mix(RGB[0], target[0], t);
  RGB[1] = mix(RGB[1], target[1], t);
  RGB[2] = mix(RGB[2], target[2], t);
}

/** rockTone（-1..1）から岩の明るい面・暗い面を混ぜて out に書く。 */
function rockColor(rockTone: number, dark: number, out: Float32Array): void {
  const pos = clamp((rockTone * 0.5 + 0.5) * 3, 0, 3);
  const a = Math.min(2, pos | 0);
  const t = smoothstep(0, 1, pos - a);
  for (let c = 0; c < 3; c++) {
    const light = mix(ROCKS[a][0][c], ROCKS[a + 1][0][c], t);
    const shadow = mix(ROCKS[a][1][c], ROCKS[a + 1][1][c], t);
    out[c] = mix(light, shadow, dark);
  }
}

/**
 * 地面の層。気温 × 湿り気で気候帯が決まり、そこへ地形の形（尾根・谷筋・傾き）と標高を重ねる。
 *   - 谷筋（曲がりが負）: 湿って緑が濃い。雪も溜まる
 *   - 尾根（曲がりが正）: 乾いて明るい。岩が出やすく、雪は飛ばされる
 *   - 乾いた斜面は低木と枯れ草の色、湿った斜面は緑のまま急な所まで上がる
 *   - 岩は地方ごとに種類が違う（花崗岩・砂岩・玄武岩・石灰岩）
 *   - 崖の下の緩んだ所には崖錐（明るい礫）
 * 傾きは 16m 尺度のものを主に使う。細部の傾きで切り替えると雪と岩がドットの模様になる。
 * patch（-1..1）は数十 m のむら、rockTone（-1..1）は地方ごとの岩の種類。色は 0..1 のリニア RGB。
 */
export function surfaceTerrain(
  h: number,
  slopeLocal: number,
  f: SurfaceFields,
  temp: number,
  moisture: number,
  special: SpecialHit,
  patch: number,
  rockTone: number,
  out: Float32Array,
  o: number,
): void {
  // 気候帯の地面色。3×3 の格子から囲む 4 色を取り、双一次で混ぜる。
  const [ti, tk] = segment(TEMP_STOPS, temp);
  const [mi, mk] = segment(MOIST_STOPS, moisture);
  const c0 = mi * 3 + ti;
  for (let c = 0; c < 3; c++) {
    RGB[c] = mix(
      mix(CLIMATE[c0][c], CLIMATE[c0 + 1][c], tk),
      mix(CLIMATE[c0 + 3][c], CLIMATE[c0 + 4][c], tk),
      mk,
    );
  }
  // 草地のむら。明るい側は少し黄みへ、暗い側は少し青みへ。
  RGB[0] *= 1 + patch * 0.08;
  RGB[1] *= 1 + patch * 0.07;
  RGB[2] *= 1 - patch * 0.04;

  // 宝物区画: 気候の地面色を宝物の色で上書きする。
  // 浜辺・水中・岩・雪より前に混ぜるので、宝物の中でも崖や水際は自然に残る。
  if (special.index >= 0) blend(SPECIAL_BIOMES[special.index].ground, special.strength);

  const slope = f.slope;
  const ridge = smoothstep(0.015, 0.12, f.curvature);
  const gully = smoothstep(0.015, 0.14, -f.curvature);
  const wet = clamp(moisture * 0.85 + gully * 0.3, 0, 1);

  // 斜面の植生: 乾いた斜面と尾根は低木と枯れ草、湿った谷筋は濃い緑。
  blend(C_SCRUB, (smoothstep(0.25, 0.6, slope) * 0.75 + ridge * 0.3) * (1 - wet));
  blend(C_LUSH, gully * wet * 0.55);
  blend(C_DRY, ridge * 0.35 * (1 - wet));

  // 崖錐: 急な斜面のすぐ下の、窪んで緩んだ所に明るい礫。
  blend(
    C_SCREE,
    smoothstep(0.45, 0.7, slope) * (1 - smoothstep(0.8, 1.0, slope)) *
      smoothstep(0.005, 0.06, -f.curvature) * (1 - moisture * 0.6) * 0.7,
  );

  // 岩: 急な所と高い所。尾根では出やすく、谷筋では土と植生に覆われる。
  // 閾値は stroll の地形に合わせてある（hakoniwa の侵食した島より斜面が緩く、山が低い）。
  const rocky = clamp(
    smoothstep(0.55, 0.95, slope + Math.max(0, slopeLocal - slope) * 0.2 + patch * 0.06) +
      ridge * smoothstep(0.4, 0.75, slope) * 0.45 +
      smoothstep(35, 80, h) * 0.75 +
      smoothstep(0.24, 0.12, temp) * smoothstep(0.35, 0.7, slope) * 0.5,
    0,
    1,
  ) * (1 - gully * 0.55);
  // 暗い面は高い所と谷側、明るい面は尾根。
  const dark = clamp(0.35 + smoothstep(40, 120, h) * 0.3 - ridge * 0.35 + gully * 0.2, 0, 1);
  rockColor(rockTone, dark, ROCK);

  // 浜辺と、水の中の砂地。岩は砂に埋もれる。
  const sand = 1 - smoothstep(1.2, 4.5, h);
  const seabed = smoothstep(-1.5, -12, h);
  blend(C_SAND, sand);
  blend(C_SEABED, seabed);

  // 雪: 寒い所の、急すぎない面。谷筋に溜まり、尾根では飛ばされる。陸の上だけ。
  const snow =
    smoothstep(0.16, 0.03, temp + patch * 0.03 + ridge * 0.04 - gully * 0.04) *
    (1 - smoothstep(0.75, 1.1, slope)) *
    smoothstep(0.5, 3, h);

  const g = f.curvature * CURVATURE_GAIN;
  const k = g / (1 + Math.abs(g));

  out[o] = RGB[0];
  out[o + 1] = RGB[1];
  out[o + 2] = RGB[2];
  out[o + 3] = ROCK[0];
  out[o + 4] = ROCK[1];
  out[o + 5] = ROCK[2];
  out[o + 6] = rocky * (1 - sand) * (1 - seabed);
  out[o + 7] = snow;
  out[o + 8] = 1 + k * (k < 0 ? CURVATURE_DARK : CURVATURE_LIGHT);
}
