/**
 * シードごとに 1 つの部屋（Durable Object）を持つ中継サーバ。
 *
 * 地形は各自のブラウザがシードから同じものを再現するので、ここでは一切送らない。
 * 流れるのは座標と向きだけ。
 */

/** 1 部屋の上限。友達と歩く用途なので、これで足りなければ設計を見直す合図。 */
const MAX_PLAYERS = 32;

const MAX_NAME_LENGTH = 16;

interface PlayerState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  flying: boolean;
}

/** WebSocket に紐づけて保存する情報。休眠から復帰しても残る。 */
interface Attachment {
  /** サーバが振る表示用の識別子。他人の画面のアバターを結びつける。 */
  id: string;
  /** ブラウザが持つ固定の識別子。再接続しても同じ。古い自分を消すのに使う。 */
  cid: string;
  name: string;
  state: PlayerState | null;
}

/** 合言葉に使える文字と同じで、cid の検証にも流用できる長さ。 */
function cleanCid(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^a-z0-9]/gi, '').slice(0, 32);
}

/** 表示名は他人の画面に出るので、長さと文字種を絞る。 */
function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // 制御文字と改行を落としてから詰める。
  const trimmed = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

/** 受け取った座標をそのまま信じない。NaN や巨大値で他人の描画を壊さないため。 */
function cleanState(raw: unknown): PlayerState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    return Math.max(-1e7, Math.min(1e7, v));
  };
  const x = num(s.x), y = num(s.y), z = num(s.z), yaw = num(s.yaw);
  if (x === null || y === null || z === null || yaw === null) return null;
  return { x, y, z, yaw, flying: s.flying === true };
}

export class Room {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
    // クライアントの "ping" に休眠したまま "pong" を返す。
    // 無通信でも回線が生き続けるので、立ち止まっていて切られる事故を防ぐ。
    // 自動応答なので DO を起こさず、課金も増えない。
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    if (this.state.getWebSockets().length >= MAX_PLAYERS) {
      return new Response('room full', { status: 503 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // 休眠 API で受ける。全員が黙っている間はメモリから降りて課金されない。
    this.state.acceptWebSocket(server);
    server.serializeAttachment({
      id: crypto.randomUUID().slice(0, 8),
      cid: '',
      name: '',
      state: null,
    } satisfies Attachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    if (typeof raw !== 'string' || raw.length > 512) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const me = ws.deserializeAttachment() as Attachment | null;
    if (!me) return;

    if (msg.t === 'hello') {
      // 名前が未設定の間は他人から見えない扱いにしている。
      if (me.name) return;
      me.name = cleanName(msg.name) || '名無し';
      me.cid = cleanCid(msg.cid);
      me.state = cleanState(msg.s);
      ws.serializeAttachment(me);

      // 同じブラウザの古い接続か。cid が空（cid を送らない古い版）は
      // 別人として扱う。空同士を「同じ」と見なすと、他人が消えてしまう。
      const isOldSelf = (a: Attachment | null): boolean =>
        a !== null && me.cid !== '' && a.cid === me.cid;

      // 再接続の後始末。古い自分がまだ残っていたら閉じ、他人にも退場を伝える。
      // close は遅れて届くことがあるため、下の others でも弾く。
      for (const other of this.state.getWebSockets()) {
        if (other === ws) continue;
        if (isOldSelf(other.deserializeAttachment() as Attachment | null)) {
          try {
            other.close(1000, 'replaced');
          } catch {
            // 既に閉じかけていれば無視。
          }
        }
      }

      // join と同じ形（id / name / s）で返す。受け手が場合分けせずに済むように。
      // 古い自分（＝同じ cid）は必ず除く。close の遅延に関係なく死体を出さない。
      const others: { id: string; name: string; s: PlayerState | null }[] = [];
      for (const other of this.state.getWebSockets()) {
        if (other === ws) continue;
        const a = other.deserializeAttachment() as Attachment | null;
        if (a?.name && !isOldSelf(a)) others.push({ id: a.id, name: a.name, s: a.state });
      }
      ws.send(JSON.stringify({ t: 'welcome', id: me.id, players: others }));
      this.broadcast(ws, { t: 'join', id: me.id, name: me.name, s: me.state });
      return;
    }

    if (msg.t === 'state') {
      if (!me.name) return;
      const s = cleanState(msg.s);
      if (!s) return;
      me.state = s;
      ws.serializeAttachment(me);
      this.broadcast(ws, { t: 'state', id: me.id, s });
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.announceLeave(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.announceLeave(ws);
  }

  private announceLeave(ws: WebSocket): void {
    const me = ws.deserializeAttachment() as Attachment | null;
    if (me?.name) this.broadcast(ws, { t: 'leave', id: me.id });
  }

  /** 送信側には返さない。送信は課金対象外なので、人数分素直に配ってよい。 */
  private broadcast(from: WebSocket, payload: unknown): void {
    const text = JSON.stringify(payload);
    for (const ws of this.state.getWebSockets()) {
      if (ws === from) continue;
      try {
        ws.send(text);
      } catch {
        // 切断途中のソケットは無視する。close イベントで片付く。
      }
    }
  }
}
