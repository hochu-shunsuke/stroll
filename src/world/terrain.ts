import { hashSeed } from '../core/rng';
import {
  LAKE_DEPTH,
  type LakeCell,
  type LakeHit,
  NO_LAKE,
  RIM_HEIGHT,
  lakeCellAt,
  lakeCellOf,
  lakeShapeAt,
} from './lake';
import { EDGE_WIDTH, EDGE_WOBBLE_RATE, LF_PLATEAU, landformAt } from './landform';
import { Noise2D, clamp, fbm, fbmD, fbmEroded, mix, smoothstep, spline } from './noise';
import { SPECIAL_BIOMES, type SpecialHit, specialAt, srgb } from './special';

export const SEA_LEVEL = 0;

// 台地が周りの地面から持ち上がる高さ（メートル）。区画ごとにこの範囲で変わる。
// 陸の標高は中央値 8m・88% が 20m 以下なので、この高さで「見下ろす場所」になる。
const PLATEAU_RISE_MIN = 22;
const PLATEAU_RISE_MAX = 38;

/**
 * 台地の縁の、いちばん急なところの傾き。
 *
 * 縁は landform.ts の EDGE_WIDTH の帯の中で smoothstep で落ちる。
 * smoothstep の最大傾斜は平均の 1.5 倍。さらに縁の位置そのものが歩くにつれて
 * ずれるので、そのぶん急になる（EDGE_WOBBLE_RATE）。
 *
 * **この 2 つ目の項を忘れて一度壊した。** 見積もりでは 1.05 だったが実測の
 * 最大は 4.84 で、縁の 27% が歩いて登れない台地になっていた。
 *
 * player 側の登坂限界（MAX_CLIMB）より急いと、歩いて台地に上がれなくなる。
 * その突き合わせは controller.ts で行う（MAX_CLIMB をここに書き写すと、
 * 同じ定数が 2 か所に散って片方だけ変わる事故になるため）。
 */
export const STEEPEST_LANDFORM_SLOPE =
  ((1.5 * PLATEAU_RISE_MAX) / EDGE_WIDTH) * (1 + EDGE_WOBBLE_RATE);

// ---------------------------------------------------------------------------
// 高さを決めるスプライン
//
// 折れ点が地形の種類を作る。**平らな区間が平原と台地を、急な区間が崖と海岸線を
// 作る。** 掛け算では段を作れないので、ここが「大枠から出る」ための要になる。
//
// つまみ方の勘所:
//  - 2 つの折れ点を近づけるほど、そこが崖になる
//  - 出力が同じ値で並ぶ区間を作ると、そこが広い平地になる
//  - 海の割合は SP_BASE がゼロを跨ぐ入力値で決まる
// ---------------------------------------------------------------------------

/** 大陸度 → 基準の高さ（m）。外洋から奥地まで。 */
const SP_BASE: readonly (readonly [number, number])[] = [
  [-1.0, -58],
  [-0.42, -30],
  [-0.16, -7],
  [-0.05, 3], // 渚。ここが急 ＝ 海岸線がはっきり出る
  [0.04, 10],
  [0.24, 16], // 広い低地。ここが平ら ＝ 平原が広がる
  [0.36, 64], // 内陸の段。ここが急 ＝ 断崖と台地の縁
  [0.58, 88],
  [1.0, 142],
];

/**
 * 侵食度 → 起伏の振れ幅（m）。高いほど平ら。
 *
 * 平らになる側の折れ点を低めに置いてある。侵食度は正規分布に近いので、
 * 折れ点を 0.34 に置くと平原が全体の 1 割ほどしか出ず、歩ける平地が消える
 * （一度これで平原が 36% → 8% に落ちた）。
 */
const SP_RELIEF: readonly (readonly [number, number])[] = [
  // 侵食度は 4 オクターブの fbm なので -0.92 までしか下がらない。
  // 一番左の折れ点には誰も到達しないが、隣との傾きを決めるために置いてある。
  // **ここを高くしても高山は出ない**（そこへ到達する面積が無い）。
  // 高山は下の PEAK_* で別に作る。
  [-1.0, 104],
  [-0.55, 68],
  [-0.28, 38],
  [-0.06, 13],
  [0.12, 5], // ここから先が平ら ＝ どこまでも続く平原
  [1.0, 4],
];

// ---------------------------------------------------------------------------
// 高山
//
// **3 つの条件が揃ったときだけ跳ね上げる。** Minecraft の jaggedness と同じ考えで、
// あちらも「大陸度が高く・侵食が低く・PV が高い所で正になる」と書かれている。
//
// なぜ SP_RELIEF を高くするだけでは駄目だったか: 侵食度が -0.72 より下に来る面積が
// ほぼ無く、スプラインの左端を 104 → 320 にしても最高峰は 140 → 164m しか動かない。
// **折れ点を動かすより、条件の掛け算で希少さを作る方が効く。**
//
// 気温は標高で下がるので、高山は自動的に雪と岩肌になる（shade / scatter が拾う）。
// ---------------------------------------------------------------------------

/**
 * 山塊の持ち上げ（m）。内陸 × 侵食の少なさ だけで決まる。
 * どちらも波長 900m 以上のノイズなので、**山体が km 単位で広がる**。
 *
 * **こちらを主役にすること。** 頂上（PEAK_SPIRE）を主役にすると、尾根の稜線は
 * 細い等高線なので山が針になる（一度 333m・山体 100m の塔ができた。
 * 山頂から 100m 離れただけで 130m まで落ちた）。
 */
const PEAK_MASSIF = 155;
/** その上に尾根の頂上だけをさらに尖らせる（m）。こちらは狭くてよい。 */
const PEAK_SPIRE = 65;
/**
 * 内陸らしさ・侵食の少なさ・尾根の頂上、それぞれの効き始めと効き切り。
 *
 * **窓を広げすぎると山だらけになる。** 一度 [0.25,0.55]×[-0.3,-0.62] にしたら
 * 16km 四方に 52〜55 個の高山が出て、標高 150m 超が陸の 1.7% になった。
 * 「所々にある」は 16km 四方に数個で、陸の 0.2% 程度。
 */
const PEAK_CONT: [number, number] = [0.38, 0.66];
const PEAK_ERO: [number, number] = [-0.42, -0.7];
const PEAK_PV: [number, number] = [0.15, 0.72];

/**
 * 尾根と谷 → 起伏の中での高さの割合。
 *
 * **谷底側に平らな区間を置いているのが要点。** ここが「歩く場所」になる。
 *
 * 以前は `pv * relief * 0.5` と直に掛けていた。すると谷が V 字に尖り、
 * 歩ける床が無くなる。実測でまっすぐ歩くと中央値 104m（19 秒）で壁に当たり、
 * 29% は 50m 未満で行き止まりだった。散歩ではなく障害物競走になっていた。
 *
 * pv は w（ねじれ）が 0 のところで最小になる。w = 0 は等高線なので
 * **谷底はもともと連結したネットワーク**になっている。そこを平らにすると、
 * 山の間を縫って歩ける道が自然にできる。川を入れるならこの同じ場所。
 */
const SP_PV: readonly (readonly [number, number])[] = [
  [-1.0, -0.34],
  [-0.58, -0.34], // ここが平ら ＝ 谷底の床。歩ける回廊になる
  [-0.22, -0.17],
  [0.3, 0.2],
  [1.0, 0.52],
];

/**
 * 海岸の平坦化。基準の高さがこれより低いところでは起伏を弱める。
 *
 * **これが無いと海岸がリアス式になる。** 起伏は基準の高さに足し引きされるので、
 * 基準が海面の近くだと起伏だけで海面線を何度も跨ぐ。実測では、まっすぐ歩くと
 * 1km あたり 2.6 回も水際を跨ぎ、陸の 45% が水際 100m 以内という細切れだった。
 *
 * 同じ対策は外にもある。Minecraft は海岸の侵食度を高めに寄せて起伏を殺し、
 * Dwarf Fortress は「山から海へ向かって標高を平滑化する」処理を回している。
 * 現実の海岸平野が平らなのも同じ理由。
 *
 * 完全に 0 にはしない（浅瀬の海底が真っ平らになると不自然なため）。
 */
const COAST_FLAT_H = 12;
const COAST_FLAT_FLOOR = 0.15;

/**
 * 大陸度 → 起伏の効き方。
 *
 * **「歩く場所」と「見る場所」を分けるのがこのスプラインの仕事。**
 *
 * 低地（大陸度 0.0〜0.25、標高 10〜16m の広い平原）では起伏を抑える。ここは
 * 歩く場所なので、傾きが上がると散歩にならない。内陸（0.38 以上）で一気に上げて、
 * そこを見る場所にする。平原に立って山を眺める、という関係がこれで生まれる。
 *
 * 一度これを一様に上げて失敗した。歩く面の傾きが中央 0.12 → 0.24 に倍増し、
 * まっすぐ歩くと 104m（19 秒）で壁に当たるようになった。連結性は 94〜99% あって
 * どこへでも行けたのに、**ずっと登り降りさせられる**ので散歩にならなかった。
 *
 * 外洋側を低くしているのは、海底に山を作らないため。
 */
const SP_RELIEF_GATE: readonly (readonly [number, number])[] = [
  [-1.0, 0.1],
  [-0.2, 0.2],
  [0.0, 0.3],
  [0.22, 0.44], // 低地 ＝ 歩く場所。起伏を抑える
  [0.38, 1.0], // 内陸 ＝ 見る場所。ここから一気に上げる
  [1.0, 1.0],
];

/**
 * 四角形をどちらの対角線で 2 つの三角形に割るか。true なら h00-h11。
 *
 * **チャンクのメッシュ（chunk.ts）と heightOnGrid は必ずこの同じ関数を使うこと。**
 * 片方だけ変えると足元が地面から浮く。以前は両方が「常に h00-h11」と
 * ベタ書きで揃えていたが、機構では守られていなかった。ここに 1 つ置いて共有する。
 *
 * 常に同じ向きで割ると、対角線に垂直な向きに系統的な畝ができる（＝斜めの縞）。
 * 実測では step=48 で最大 10.8m の段差になり、遠景の山肌に縞として見えていた。
 *
 * 高低差が小さい方の対角線を選ぶと、割る向きが地形に従うので方向の偏りが消え、
 * 中央での誤差も 2 割減る（step=48 で 1.96m → 1.50m）。
 */
export function splitsAlongMainDiagonal(
  h00: number,
  h10: number,
  h01: number,
  h11: number,
): boolean {
  return Math.abs(h00 - h11) <= Math.abs(h01 - h10);
}

/**
 * 尾根と谷。ねじれノイズを折り返して作る。
 * 戻り値は -1（谷底）〜 +1（稜線）。
 *
 * 折り返すのが要点。ふつうのノイズは丸い塊になるが、折り返すと
 * **尾根と谷が交互に並ぶ**構造になる。視界を切る中スケールの起伏はここから出る。
 * w が 0 に近いところが谷筋なので、川を入れるならそこになる。
 */
function peaksValleys(w: number): number {
  return 1 - Math.abs(3 * Math.abs(w) - 2);
}

/**
 * 座標のゆがめ方。
 *
 * **効くのは振幅ではなく「1m 動く間に座標が何 m ずれるか」（勾配）。**
 * 勾配は `WARP_AMOUNT × WARP_FREQ × ノイズの傾き(≒2.5)` で決まる。
 * これが 1.0 を超えると座標が折り返し、**地形が自分自身に重なる**。
 * 見た目は指紋のような渦になる。
 *
 * 一度 0.0016 / 190 にして壊した。勾配が 16% の場所で 1.0 を超え、
 * 山肌に渦模様が出ていた。
 *
 * 振幅は保ったまま波長を伸ばしてある。細かく歪めると指紋になるが、
 * 大きくゆっくり歪めると大地の褶曲のように見える。
 */
const WARP_FREQ = 0.0007;
const WARP_AMOUNT = 170;

// ---------------------------------------------------------------------------
// 雨陰（rain shadow）
//
// 湿り気は独立したノイズだった。実測すると標高との相関が 0.02 ── **完全に
// 無関係**で、砂漠が山の上にあっても密林が乾いた高原にあっても何も止まらない。
// 気候帯の分布は良いのに、置かれる場所に理由が無かった。
//
// 地球では、風が山にぶつかって昇り、冷えて雨を落とす。だから山の風上は湿り、
// 風下は乾く。本来は風に沿った水分輸送のシミュレーションだが、
// **「風上を直線で調べて、一番高い障害を探す」だけでも同じ形が出る。**
// これなら (x,z) の純粋関数のまま書ける。
//
// **予算の急所**: 素朴に heightAt を風上に 12 回呼ぶと 1 チャンクあたり
// +116ms になって破綻する。雨陰に効くのは山の"塊"だけで細部は要らないので、
// 粗い massAt（大陸ノイズ 3 オクターブ + スプライン）だけを見る。
// ---------------------------------------------------------------------------

/** 風上を何点調べるか。 */
const RAIN_SAMPLES = 7;
/** 調べる間隔（m）。SAMPLES × STEP が「山の影が届く距離」になる。 */
const RAIN_STEP = 260;
/** 風上の山が自分より何 m 高ければ影になり始めるか / 乾ききるか。 */
const RAIN_LOW = 22;
const RAIN_HIGH = 78;
/** 森のかたまりの下限と振れ幅。下限 + 振れ幅/2 が 1.0 になるように取る。 */
const GROVE_FLOOR = 0.42;
const GROVE_RANGE = 1.18;

/** 雨陰で湿り気が最大どれだけ下がるか。1.0 にすると砂漠しか出なくなる。 */
const RAIN_STRENGTH = 0.5;

// ---------------------------------------------------------------------------
// 谷筋（将来の川）
//
// 専用の**超低周波**ノイズのゼロ交差を彫る。ゼロ線は等高線なので必ず連結して
// いて、彫るだけで繋がった谷が手に入る。流れの向きは計算しない。
//
// **いまは水を入れていない。涸れ谷である。** 理由は深さの実測にある。
//
//   彫る深さ  川筋を歩いたとき水が続く長さ  海岸への影響
//     9m      水は入らない（涸れ谷）        水際 100m 以内の陸 47%
//    11m      中央  36m（水たまりの列）      —
//    26m      中央 468m（川に見える）        水際 100m 以内の陸 57% ★
//
// 水面が海抜固定の 1 枚板なので、水を入れるには地面を海面下まで彫るしかない。
// 深く彫れば水は繋がるが、そのぶん低地が水没して**海岸がリアス式**になる。
// 実測で水際の交差が 2.5 → 3.5 回/km（4 割増）になった。両立しない。
//
// **本当の壁は「流れの計算」ではなく「水面の設計」。** 水面を場所ごとに持てる
// ようにすれば（terrain / chunk / chunkManager / water の 4 ファイル）、
// RIVER_DEPTH を上げるだけで川になる。谷筋の骨格はそのまま使える。
// ---------------------------------------------------------------------------

/** 谷筋のノイズ。波長 1,800m ＝ ゆったり蛇行する。 */
/** 湖の底を海面からどれだけ上に保つか（m）。 */
const LAKE_BED_MIN = 0.6;
/** 湖の水面が海面よりこれだけ高くないと作らない（m）。 */
const LAKE_MIN_ABOVE_SEA = 2.0;

const RIVER_FREQ = 0.00055;
/** 谷の半幅（m）。中心から左右にこれだけ。 */
const RIVER_HALF = 62;
/** 岸が下り切る内側の位置（半幅に対する割合）。 */
const RIVER_INNER = 0.25;
/**
 * 彫る深さ（m）。水面を場所ごとに持てるようになったら 26 前後まで上げる。
 * いまの 1 枚板のままで上げると海岸がリアス式になる（上の表）。
 */
const RIVER_DEPTH = 9;

/**
 * 谷の斜面の一番急なところの傾き。player の MAX_CLIMB と controller.ts で
 * 突き合わせる（定数を書き写すと片方だけ変わって壊れるため）。
 *
 * **1.5 は smoothstep の最大傾斜が平均の 1.5 倍だから。** この項を忘れて
 * 台地の縁と川岸で 2 回とも崖を作った。深さを変えるときは必ずここを見ること。
 */
export { STEEPEST_SHORE } from './lake';

export const STEEPEST_RIVER_BANK =
  (1.5 * RIVER_DEPTH) / (RIVER_HALF * (1 - RIVER_INNER));

// 川の判定に使い回す。1 回ごとに配列を作らないため。
const RD = new Float32Array(3);

// 落ち着いた、彩度を抑えた自然の色。
const C_SEABED = srgb(0x4d5a52);
const C_SAND = srgb(0xcbbd97);
const C_ROCK = srgb(0x878175);
const C_ROCK_DARK = srgb(0x6b6760);

// 気候帯ごとの地面の色。気温（寒→暑）× 湿り（乾→湿）の格子で決まる。
// 乾いた側（寒→温→暑）
const C_TUNDRA = srgb(0x8f948a); // 寒・乾: 色あせた灰緑
const C_GRASS_DRY = srgb(0x9aa76b); // 温・乾: 乾いた黄緑（草原）
const C_DESERT = srgb(0xcbbe95); // 暑・乾: 砂
// 湿った側（寒→温→暑）
const C_SNOW = srgb(0xe7ecef); // 寒・湿: 雪
const C_FOREST = srgb(0x5c7a51); // 温・湿: 深い森
const C_JUNGLE = srgb(0x577f43); // 暑・湿: みずみずしい密林

// shade() の途中計算に使い回す。面ごとに配列を作らないため。
const DRY: [number, number, number] = [0, 0, 0];
const WET: [number, number, number] = [0, 0, 0];

/** 3 段階の色を t(0..1) で補間する。気温の寒→温→暑に沿って地面色を作る。 */
function ramp3(
  cold: readonly number[],
  mid: readonly number[],
  hot: readonly number[],
  t: number,
  out: [number, number, number],
): void {
  if (t < 0.5) {
    const k = smoothstep(0, 0.5, t);
    out[0] = mix(cold[0], mid[0], k);
    out[1] = mix(cold[1], mid[1], k);
    out[2] = mix(cold[2], mid[2], k);
  } else {
    const k = smoothstep(0.5, 1, t);
    out[0] = mix(mid[0], hot[0], k);
    out[1] = mix(mid[1], hot[1], k);
    out[2] = mix(mid[2], hot[2], k);
  }
}

export class Terrain {
  readonly seed: string;
  private nContinent: Noise2D;
  private nErosion: Noise2D;
  private nRidge: Noise2D;
  private nDetail: Noise2D;
  private nWarp: Noise2D;
  private nLakeEdge: Noise2D;
  /** 区画ごとの湖の記憶。判定が重いので使い回す。 */
  private lakeCells = new Map<string, LakeCell | null>();
  private lakeSalt: number;
  private nRiver: Noise2D;
  private nGrove: Noise2D;
  private nMoisture: Noise2D;
  private nTemperature: Noise2D;
  private nSpecialEdge: Noise2D;
  private specialSalt: number;
  private nLandformEdge: Noise2D;
  private landformSalt: number;
  /** 卓越風の向き（単位ベクトル）。世界ごとに変わる。 */
  private windX: number;
  private windZ: number;

  constructor(seed: string) {
    this.seed = seed;
    const [a, b, c, d] = hashSeed(seed);
    this.nContinent = new Noise2D(a);
    this.nErosion = new Noise2D(b);
    this.nRidge = new Noise2D(c);
    this.nDetail = new Noise2D((a ^ 0x9e3779b9) >>> 0);
    this.nWarp = new Noise2D(d);
    this.nLakeEdge = new Noise2D((c ^ 0x3b9aca07) >>> 0);
    // 湖の抽選にもシードを混ぜる。忘れると全世界で湖の位置が同じになる。
    this.lakeSalt = (a ^ 0x5bd1e995) >>> 0;
    this.nRiver = new Noise2D((a ^ 0x27220a95) >>> 0);
    this.nGrove = new Noise2D((b ^ 0x2545f491) >>> 0);
    this.nMoisture = new Noise2D((c ^ 0xc2b2ae35) >>> 0);
    this.nTemperature = new Noise2D((d ^ 0x27d4eb2f) >>> 0);
    this.nSpecialEdge = new Noise2D((a ^ 0x165667b1) >>> 0);
    // 宝物の抽選にシードを混ぜる種。これがないと全世界で宝物の位置が同じになる。
    this.specialSalt = (b ^ 0x9e3779b1) >>> 0;
    this.nLandformEdge = new Noise2D((c ^ 0x7feb352d) >>> 0);
    // 地形の種類の抽選にも同じくシードを混ぜる。
    this.landformSalt = (d ^ 0x846ca68b) >>> 0;
    // 卓越風の向き。世界ごとに変わるので、どちら側が乾くかもシード次第になる。
    const windAngle = (((a ^ 0x1b873593) >>> 0) / 0x100000000) * Math.PI * 2;
    this.windX = Math.cos(windAngle);
    this.windZ = Math.sin(windAngle);
  }

  /** 宝物区画の判定。詳しくは special.ts。 */
  specialAt(x: number, z: number): SpecialHit {
    return specialAt(x, z, this.nSpecialEdge, this.specialSalt);
  }

  /**
   * 大陸度。低いほど外洋、高いほど奥地。海と陸を分ける軸。
   * ここだけは座標をゆがめない（海岸線の形が壊れるため）。
   */
  private continentalnessAt(x: number, z: number): number {
    return fbm(this.nContinent, x, z, 5, 0.00035);
  }

  /**
   * 侵食度。高いほど平ら、低いほど険しい。「どんな起伏か」を決める軸。
   *
   * 周波数は「平地と山地が入れ替わる間隔」。0.00065（波長 1540m）だと
   * 平原の真ん中に立ったとき山が遠すぎて、視界を切るものが何も無かった。
   * 0.0011（波長 900m）にすると、平地にいても山が視界に入る。
   */
  private erosionAt(x: number, z: number): number {
    return fbm(this.nErosion, x, z, 4, 0.0011);
  }

  /**
   * ねじれ。折り返して尾根と谷にする。0 に近いところが谷筋。
   *
   * 周波数がそのまま「尾根と谷が入れ替わる間隔」になり、視界を切る壁の
   * 大きさを決める。0.0013（波長 770m）では緩すぎて壁にならなかった。
   * 0.0028 なら波長 357m、半波長 180m で起伏ぶん上下するので壁になる。
   */
  private weirdnessAt(x: number, z: number): number {
    return fbm(this.nRidge, x, z, 4, 0.0028);
  }

  /**
   * 粗い「山の塊」の高さ（m）。雨陰の障害物を測るためだけのもの。
   *
   * heightAt をそのまま使うと重すぎるので、大陸度と侵食度のスプラインだけで
   * 尾根の高さを見積もる。細部・warp・谷・台地は雨陰に関係ないので全部省く。
   * 大陸ノイズも 5 → 3 オクターブに落としてある（山の位置は粗い層で決まる）。
   */
  private massAt(x: number, z: number): number {
    const cont = fbm(this.nContinent, x, z, 3, 0.00035);
    const ero = fbm(this.nErosion, x, z, 2, 0.0011);
    // 尾根の高さ ＝ 基準の高さ ＋ 起伏の半分。
    return spline(SP_BASE, cont) + spline(SP_RELIEF, ero) * spline(SP_RELIEF_GATE, cont) * 0.5;
  }

  /**
   * 雨陰の強さ 0..1。1 に近いほど乾く。
   * 風上をたどり、一番高い障害を探す。遠い山ほど効きを弱める。
   */
  private rainShadowAt(x: number, z: number): number {
    // 効くのは山の絶対の高さではなく「自分よりどれだけ高いか」。
    // これを忘れると山の上まで乾いて、陸の 64% が砂漠になる（一度そうした）。
    const here = this.massAt(x, z);
    let worst = 0;
    for (let i = 1; i <= RAIN_SAMPLES; i++) {
      const d = i * RAIN_STEP;
      const m = this.massAt(x - this.windX * d, z - this.windZ * d);
      // 遠い山ほど雨陰が薄れる（間でまた雲が育つため）。
      const reach = 1 - (i - 1) / RAIN_SAMPLES;
      const blocked = smoothstep(RAIN_LOW, RAIN_HIGH, m - here) * reach;
      if (blocked > worst) worst = blocked;
    }
    return worst;
  }

  /**
   * 湿り気 0..1。ノイズに雨陰を重ねる。
   * 自分より高い山が風上にあるほど乾く。おかげで山脈の東西で景色が変わる。
   */
  /**
   * 森のかたまり 0..1.4。植生の密度に掛ける。
   *
   * これが無いと、木は格子点ごとに独立にサイコロを振るだけになる。実測で
   * 20m マスあたりの分散/平均が 0.78 ── **ランダム（1.0）より均一**で、
   * 森ではなく壁紙に見えていた。研究でも、一様配置より競争モデル（同種が
   * 固まる）の方が信じられると出ていて、その差は**空から見たとき**に一番出る。
   *
   * **平均が 1.0 になるように下限と倍率を取ること。** 0 から始めると
   * かたまりが濃くなる代わりに全体の本数まで減る（一度これで木が半減し、
   * 木のほぼ無いチャンクが 24% → 42% になった）。空き地にも下限ぶんは残す。
   *
   * 波長は約 110m ＝ 歩いて 20 秒で森を抜ける大きさ。
   */
  groveAt(x: number, z: number): number {
    const n = fbm(this.nGrove, x, z, 2, 0.009) * 0.5 + 0.5;
    return GROVE_FLOOR + smoothstep(0.28, 0.74, n) * GROVE_RANGE;
  }

  moistureAt(x: number, z: number): number {
    const base = fbm(this.nMoisture, x, z, 3, 0.0009) * 0.5 + 0.5;
    return clamp(base - this.rainShadowAt(x, z) * RAIN_STRENGTH, 0, 1);
  }

  /**
   * 気温 0..1（0 が寒い、1 が暑い）。気候帯を分ける 3 本目の軸。
   * 湿り気より粗いノイズにして、気候帯を大きく取る（歩いてしばらくで変わる）。
   * 標高が上がるほど冷える。おかげで暑い地方でも高い山の上は雪になる。
   */
  temperatureAt(x: number, z: number, h: number): number {
    // 振れ幅 0.75。0.5 だと温帯に寄りすぎて砂漠や雪にほぼ出会えなかった。
    // これで寒・暑が各 1 割ほど現れつつ、温帯が過半を保つ。
    const base = clamp(fbm(this.nTemperature, x, z, 3, 0.0006) * 0.75 + 0.5, 0, 1);
    // 標高による冷え込み。海抜 8m から効き始め、120m 上がると 0.6 下がる。
    const lapse = Math.max(0, h - 8) * 0.005;
    return clamp(base - lapse, 0, 1);
  }

  /**
   * 湖の判定。
   *
   * **重い部分（区画に湖があるか・水面の高さ）は区画ごとに 1 度だけ**計算して
   * 覚えておく。点ごとにやると地形を丸ごと 1 回引くことになり、湖のある
   * チャンクだけ生成が 2〜3 倍になる（一度これで壊した）。
   */
  private lakeHit(x: number, z: number): LakeHit {
    const [cx, cz] = lakeCellOf(x, z);
    const key = `${cx},${cz}`;
    let cell = this.lakeCells.get(key);
    if (cell === undefined) {
      cell = lakeCellAt(
        cx,
        cz,
        this.nContinent,
        this.nErosion,
        this.lakeSalt,
        SP_BASE,
        this.groundBeforeLake,
      );
      // 際限なく溜めない。歩き続けても区画は 1,450m 四方なので、
      // この上限に達する頃には遠く離れた区画しか残っていない。
      if (this.lakeCells.size > 2048) this.lakeCells.clear();
      this.lakeCells.set(key, cell);
    }
    // **海面すれすれの湖は作らない。** 海の板と重なって水面が二重に見える。
    // ここで弾いておかないと、heightAt が窪みを彫ったのに waterLevelAt が
    // 水を返さず、水の無い穴が残る。判定は 1 か所に置くこと。
    if (cell === null || cell.level <= SEA_LEVEL + LAKE_MIN_ABOVE_SEA) return NO_LAKE;
    return lakeShapeAt(x, z, cell, this.nLakeEdge);
  }

  /**
   * 湖を入れる前の地面の高さ。lake.ts へ渡す。
   * heightAt をそのまま渡すと、湖の判定の中から湖の判定を呼んで無限再帰する。
   */
  private groundBeforeLake = (x: number, z: number): number => this.shapeAt(x, z);

  /**
   * その地点の水面の高さ。水が無ければ -Infinity。
   *
   * 外洋と海は 1 枚の板（render/water.ts）が描くので、ここは**海抜より上の水**
   * だけを返す。チャンクごとの水面メッシュがこれを見て三角形を出す。
   */
  waterLevelAt(x: number, z: number): number {
    const lake = this.lakeHit(x, z);
    if (lake.strength <= 0) return -Infinity;
    return lake.level;
  }

  /**
   * 標高。海面は 0。
   *
   * ノイズを足し合わせるのではなく、**3 つのパラメータをスプラインに通す**。
   *
   *   大陸度 → 基準の高さ（外洋 / 渚 / 低地 / 内陸の段 / 奥地）
   *   侵食度 → 起伏の振れ幅（険しい山 〜 真っ平らな平原）
   *   ねじれ → 折り返して尾根と谷にする
   *
   * 以前は `ridged^1.9 × (1-flat)^1.5 × land^1.6 × 135` のように掛け算していた。
   * なめらかな関数の掛け算は必ずなめらかで単峰になるので、作れるのは
   * 「山が多いか少ないか」の度合いだけ。「ここから先は台地」という段を作れない。
   * これが「海の中に平らな島がある」以外の景色を作れなかった原因だった。
   */
  heightAt(x: number, z: number): number {
    let h = this.shapeAt(x, z);

    // 内陸の湖。水面は区画ごとに 1 つの定数なので必ず水平になる（lake.ts）。
    const lake = this.lakeHit(x, z);
    if (lake.strength > 0) {
      // **水際でちょうど水面の高さになるよう、湖の内側は地形を完全に置き換える。**
      // 以前は元の地形と混ぜていたので、水際で強さが 0 に近いと彫りが効かず、
      // 元の地形（水面より 4m 下）がそのまま残って水が段差で終わっていた。
      // strength は中心で 1、水際で 0 なので、これで水深が 0 → LAKE_DEPTH に
      // なめらかに深くなり、水際と地形の交わる線が一致する。
      // **底を海面より下げないこと。** 海の板（y = SEA_LEVEL）は世界中に
      // 敷いてあるので、湖の底が海面より低いと湖の中に海が現れ、水面が
      // 二重に見える（実際にそうなった）。浅い湖は平底になるが、それでよい。
      h = Math.max(SEA_LEVEL + LAKE_BED_MIN, lake.level - LAKE_DEPTH * lake.strength);
    } else if (lake.rim > 0) {
      // 水際の外側。**水面と同じ高さから立ち上げること。**
      // いきなり level + RIM_HEIGHT にすると、水際の全周に RIM_HEIGHT の崖が
      // 立ち、それが格子でサンプルされて水際がギザギザに震えて見える
      // （実測で 2m 進む間に 2.18m の段差 ＝ ちょうど RIM_HEIGHT だった）。
      //
      // rim は水際で 1、外で 0。それを裏返して「水際からの遠さ」にする。
      const out = 1 - lake.rim;
      // 水際からの立ち上がり。out=0（水際）でちょうど水面の高さになる。
      const wall = lake.level + RIM_HEIGHT * smoothstep(0, 0.5, out);
      // 自然の地形へは**時間をかけて**戻す。水際のすぐ外で戻すと、湖が斜面に
      // 接している所で崖になる（実測で 90% 点が 13.7m、最大 66m の段差だった）。
      h = mix(wall, Math.max(h, wall), smoothstep(0.1, 0.6, out));
    }
    return h;
  }

  /** 湖を入れる前の地形。湖の判定がここを呼ぶので、湖を含めてはいけない。 */
  private shapeAt(x: number, z: number): number {
    // 座標をゆがめる（domain warping）。
    // ノイズが等方のままだと、何を重ねても丸い塊にしかならない。
    // ゆがめると谷が蛇行し尾根が曲がる。振幅ではなく形の問題なので、ここが効く。
    const wx = x + this.nWarp.noise(x * WARP_FREQ, z * WARP_FREQ) * WARP_AMOUNT;
    const wz = z + this.nWarp.noise(x * WARP_FREQ + 137.2, z * WARP_FREQ - 91.7) * WARP_AMOUNT;

    const cont = this.continentalnessAt(x, z);
    const ero = this.erosionAt(wx, wz);
    const pv = peaksValleys(this.weirdnessAt(wx, wz));

    const base = spline(SP_BASE, cont);
    // 起伏の大きさ。侵食度で決まり、海では抑え、海岸では殺す（COAST_FLAT_H 参照）。
    const coastFlat = mix(COAST_FLAT_FLOOR, 1, smoothstep(0, COAST_FLAT_H, base));
    const relief = spline(SP_RELIEF, ero) * spline(SP_RELIEF_GATE, cont) * coastFlat;

    // 尾根と谷。谷底側が平らになるようスプラインに通す（SP_PV 参照）。
    let h = base + spline(SP_PV, pv) * relief;

    // 谷底らしさ。1 に近いほど「歩く場所」。
    const valley = smoothstep(-0.1, -0.72, pv);

    // 高山。山塊（広い）と頂上（狭い）を分けて足す（PEAK_MASSIF の解説を参照）。
    //
    // **山塊には滑らかな成分だけを使うこと。** cont は 5 オクターブ、ero は 4 で、
    // どちらも波長 114〜178m の細部まで持っている。そのまま使うと山塊が 100m で
    // 崩れて山が針になる（実測で 1,200m の間に大陸度が 0.19 → 0.53 → -0.30 と振れた）。
    // ここは 2 オクターブに落として、km 単位で変わる骨格だけを見る。
    const contBroad = fbm(this.nContinent, x, z, 2, 0.00035);
    const eroBroad = fbm(this.nErosion, wx, wz, 2, 0.0011);
    const massif =
      smoothstep(PEAK_CONT[0], PEAK_CONT[1], contBroad) *
      smoothstep(PEAK_ERO[0], PEAK_ERO[1], eroBroad);
    if (massif > 0) {
      h += massif * PEAK_MASSIF;
      h += massif * smoothstep(PEAK_PV[0], PEAK_PV[1], pv) * PEAK_SPIRE;
    }

    // 侵食された細部。傾きが大きいところほど細かい起伏が弱まるので、
    // 谷底が平らに、尾根が鋭くなる。水の流れは一切計算していない。
    // 谷底ではさらに抑える。ここは見る場所ではなく歩く場所なので、
    // 細部が残っていると足元が常にがたつく。
    h += fbmEroded(this.nDetail, wx, wz, 4, 0.0055) * relief * 0.6 * (1 - valley * 0.82);

    // 谷筋。専用ノイズのゼロ線までの距離を出して彫る。
    // 幅は勾配で正規化する。値だけで切ると、傾きが緩い所で川が異常に太くなる。
    fbmD(this.nRiver, x, z, 3, RIVER_FREQ, RD);
    const gradR = Math.hypot(RD[1], RD[2]);
    const toRiver = Math.abs(RD[0]) / Math.max(gradR, 1e-9);
    // 山では抑える。険しい所に川を通すと岸が崖の上に乗って不自然になる。
    const calm = 1 - smoothstep(26, 62, relief);
    const river =
      smoothstep(RIVER_HALF, RIVER_HALF * RIVER_INNER, toRiver) *
      smoothstep(-0.04, 0.1, cont) *
      calm;
    // 河口では浅くする。深いまま海に届くと谷ごとに入り江ができる。
    if (river > 0) h -= river * RIVER_DEPTH * mix(0.25, 1, smoothstep(2, 22, base));


    // 地形の種類。ほとんどの場所は「ふつうの地形」で、ここで終わる。
    // 種類ごとの高さは 1 つしか評価しない（landform.ts の予算の注意を参照）。
    const land = smoothstep(-0.06, 0.2, cont);
    const lf = landformAt(x, z, land, this.nLandformEdge, this.landformSalt);
    if (lf.index !== LF_PLATEAU) return h;

    // 台地。天面の基準に base（大陸度スプライン、波長 2900m）を使うのが要点。
    // 台地の差し渡し 500〜750m の中では base がほとんど変わらないので天面が平らになる。
    // h を基準にすると下の尾根がそのまま天面に出て「持ち上げただけの山」に戻る。
    const rise = mix(PLATEAU_RISE_MIN, PLATEAU_RISE_MAX, lf.variant);
    return mix(h, base + rise, lf.strength);
  }

  /**
   * チャンクメッシュと同じ三角形分割で標高を補間する。
   * プレイヤーの足元が見た目の地面とズレないようにするため。
   */
  heightOnGrid(x: number, z: number, step: number): number {
    const x0 = Math.floor(x / step) * step;
    const z0 = Math.floor(z / step) * step;
    const u = (x - x0) / step;
    const v = (z - z0) / step;

    const h00 = this.heightAt(x0, z0);
    const h10 = this.heightAt(x0 + step, z0);
    const h01 = this.heightAt(x0, z0 + step);
    const h11 = this.heightAt(x0 + step, z0 + step);

    if (splitsAlongMainDiagonal(h00, h10, h01, h11)) {
      // 対角線は h00-h11。
      if (v >= u) return h00 * (1 - v) + h01 * (v - u) + h11 * u;
      return h00 * (1 - u) + h10 * (u - v) + h11 * v;
    }
    // 対角線は h01-h10。
    if (u + v <= 1) return h00 * (1 - u - v) + h01 * v + h10 * u;
    return h01 * (1 - u) + h10 * (1 - v) + h11 * (u + v - 1);
  }

  /**
   * 面の色。気温 × 湿り気で気候帯が決まり、そこへ標高・傾きの効果を重ねる。
   * out に 0..1 のリニア RGB を書き込む。
   */
  shade(
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
      smoothstep(0.42, 0.72, slope) + smoothstep(52, 88, h) * 0.75,
      0,
      1,
    );

    // 気候帯の地面色。まず乾いた側と湿った側を気温で作り、湿り気で混ぜる。
    ramp3(C_TUNDRA, C_GRASS_DRY, C_DESERT, temp, DRY);
    ramp3(C_SNOW, C_FOREST, C_JUNGLE, temp, WET);
    const wetness = smoothstep(0.35, 0.68, moisture);
    let r = mix(DRY[0], WET[0], wetness);
    let g = mix(DRY[1], WET[1], wetness);
    let b = mix(DRY[2], WET[2], wetness);

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
    const rockMix = smoothstep(40, 80, h);
    const rr = mix(C_ROCK[0], C_ROCK_DARK[0], rockMix);
    const rg = mix(C_ROCK[1], C_ROCK_DARK[1], rockMix);
    const rb = mix(C_ROCK[2], C_ROCK_DARK[2], rockMix);
    r = mix(r, rr, rocky);
    g = mix(g, rg, rocky);
    b = mix(b, rb, rocky);

    // 雪: 十分に寒く、あまり急でない面に積もる。気温は標高でも下がるので、
    //     暑い地方でも高い山の頂は白くなる。
    const snow = smoothstep(0.22, 0.08, temp) * (1 - smoothstep(0.55, 0.85, slope));
    r = mix(r, C_SNOW[0], snow);
    g = mix(g, C_SNOW[1], snow);
    b = mix(b, C_SNOW[2], snow);

    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
  }
}
