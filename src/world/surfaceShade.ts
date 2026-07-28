import { clamp, mix, smoothstep } from './noise';
import { SPECIAL_BIOMES, type SpecialHit, srgb } from './special';

// 落ち着いた自然色を保ちつつ、遠目にも気候帯が読める程度に色相を離す。
const C_SEABED = srgb(0x4d5a52);
const C_SAND = srgb(0xcbbd97);
const C_ROCK = srgb(0x878175);
const C_ROCK_DARK = srgb(0x6b6760);
const C_SNOW = srgb(0xe7ecef);

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
 * 面の色。気温 × 湿り気で気候帯が決まり、そこへ標高・傾きの効果を重ねる。
 * out に 0..1 のリニア RGB を書き込む。
 */
export function shadeTerrain(
  h: number,
  slope: number,
  temp: number,
  moisture: number,
  special: SpecialHit,
  out: Float32Array,
  o: number,
): void {
  // 岩肌: 急斜面ほど、そして高所ほど土が乗らない。
  const rocky = clamp(
    smoothstep(0.42, 0.72, slope) + smoothstep(35, 80, h) * 0.75,
    0,
    1,
  );

  // 気候帯の地面色。3×3 の格子から囲む 4 色を取り、双一次で混ぜる。
  const [ti, tk] = segment(TEMP_STOPS, temp);
  const [mi, mk] = segment(MOIST_STOPS, moisture);
  const o0 = mi * 3 + ti;
  const c00 = CLIMATE[o0];
  const c10 = CLIMATE[o0 + 1];
  const c01 = CLIMATE[o0 + 3];
  const c11 = CLIMATE[o0 + 4];
  let r = mix(mix(c00[0], c10[0], tk), mix(c01[0], c11[0], tk), mk);
  let g = mix(mix(c00[1], c10[1], tk), mix(c01[1], c11[1], tk), mk);
  let b = mix(mix(c00[2], c10[2], tk), mix(c01[2], c11[2], tk), mk);

  // 宝物区画: 気候の地面色を宝物の色で上書きする。
  // 浜辺・水中・岩・雪より前に混ぜるので、宝物の中でも崖や水際は自然に残る。
  if (special.index >= 0) {
    const sp = SPECIAL_BIOMES[special.index].ground;
    r = mix(r, sp[0], special.strength);
    g = mix(g, sp[1], special.strength);
    b = mix(b, sp[2], special.strength);
  }

  // 浜辺: どの気候でも水際は砂に寄る。
  const beach = 1 - smoothstep(1.2, 4.5, h);
  r = mix(r, C_SAND[0], beach);
  g = mix(g, C_SAND[1], beach);
  b = mix(b, C_SAND[2], beach);

  // 水中: 見えるのは浅瀬だけだが、透けたときに砂が続くと自然。
  const under = smoothstep(-1.5, -9, h);
  r = mix(r, C_SEABED[0], under);
  g = mix(g, C_SEABED[1], under);
  b = mix(b, C_SEABED[2], under);

  // 岩。高いところほど暗く冷たい灰に。
  const rockMix = smoothstep(28, 68, h);
  const rr = mix(C_ROCK[0], C_ROCK_DARK[0], rockMix);
  const rg = mix(C_ROCK[1], C_ROCK_DARK[1], rockMix);
  const rb = mix(C_ROCK[2], C_ROCK_DARK[2], rockMix);
  r = mix(r, rr, rocky);
  g = mix(g, rg, rocky);
  b = mix(b, rb, rocky);

  // 雪: 十分に寒く、あまり急でない面に積もる。気温は標高でも下がるので、
  //     暑い地方でも高い山の頂は白くなる（頂上では lapse で気温が 0 に張り付く）。
  //
  // **閾値は 0.22 から下げてある。** 上の格子にタイガ（寒・中）を足したのに、
  // 前の閾値だと寒い側の 6 割が雪で塗り潰されて、その色が一度も見えなかった。
  const snow = smoothstep(0.16, 0.03, temp) * (1 - smoothstep(0.55, 0.85, slope));
  r = mix(r, C_SNOW[0], snow);
  g = mix(g, C_SNOW[1], snow);
  b = mix(b, C_SNOW[2], snow);

  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
}
