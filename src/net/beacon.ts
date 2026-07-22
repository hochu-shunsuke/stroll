/**
 * 数を 1 つ増やすだけの合図。
 *
 * 送るのは項目名だけで、識別子も座標も送らない。返事も待たない。
 * 失敗しても黙って諦める。計測のために体験が止まってはいけない。
 */
export type Beacon =
  | 'load-invited'
  | 'load-direct'
  | 'start-invited'
  | 'start-direct';

export function count(event: Beacon): void {
  // 開発中は同じオリジンに中継サーバがいないので送らない。
  if (!import.meta.env.PROD) return;
  // keepalive を付けると、この直後に画面が変わっても送信が続く。
  void fetch(`/hit?e=${event}`, { method: 'POST', keepalive: true }).catch(() => {});
}
