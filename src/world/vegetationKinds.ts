/**
 * 植生の種類番号。配置（scatter）・形（vegetation）・宝物（special）が
 * この番号で結びつく。どこかが import し合って循環しないよう、
 * 番号の定義だけをここに置き、このファイルは何も import しない。
 */
export const KIND_BROADLEAF = 0;
export const KIND_PINE = 1;
export const KIND_ROCK = 2;
export const KIND_BUSH = 3;
// 色の宝物の森で使う、色違いの木。形は広葉樹と同じで葉の色だけ違う。
export const KIND_AUTUMN = 4; // 秋（オレンジ・金）
export const KIND_SAKURA = 5; // 桜（桃色）
