/**
 * 植生の種類番号。配置（scatter）・形（vegetation）・宝物（special）が
 * この番号で結びつく。どこかが import し合って循環しないよう、
 * 番号の定義だけをここに置き、このファイルは何も import しない。
 *
 * **同じ木でも形は複数持たせること。** 1 種類 = 1 メッシュだと、同じ形が
 * 何百本も並んで壁紙に見える。配置（scatter.ts の `kinds`）で振り分ける。
 */

// 広葉樹の 3 つの形。丸い / 背が高い / 横に広がる。
export const KIND_BROADLEAF = 0;
export const KIND_BROADLEAF_TALL = 6;
export const KIND_BROADLEAF_WIDE = 7;

// 針葉樹の 3 つの形。細い若木 / 成木 / 疎らな老木。
export const KIND_PINE = 1;
export const KIND_PINE_YOUNG = 8;
export const KIND_PINE_OLD = 9;

export const KIND_ROCK = 2;

// 雨陰の乾いた土地に立つ枯れ木と、暑く湿った海辺の椰子。
export const KIND_DEAD = 10;
export const KIND_PALM = 11;
export const KIND_BUSH = 3;

// 色の宝物の森で使う、色違いの木。形は広葉樹と同じで葉の色だけ違う。
export const KIND_AUTUMN = 4; // 秋（オレンジ・金）
export const KIND_SAKURA = 5; // 桜（桃色）
