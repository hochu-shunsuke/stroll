export interface PlayerState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  flying: boolean;
}

export interface Peer {
  id: string;
  name: string;
  state: PlayerState | null;
}

export type NetStatus = 'connecting' | 'open' | 'lost' | 'unreachable';

export interface ConnectionHandlers {
  onJoin(peer: Peer): void;
  onLeave(id: string): void;
  onState(id: string, state: PlayerState): void;
  onStatus(status: NetStatus): void;
}

/** 送信の最短間隔。動いていてもこれより速くは送らない。 */
const SEND_INTERVAL_MS = 100;
/** これ以下の移動・回転は「止まっている」とみなして送らない。 */
const MOVE_EPSILON = 0.04;
const TURN_EPSILON = 0.012;
const RECONNECT_MS = 3000;
/** 一度も繋がらないまま何回試すか。落ちているサーバを叩き続けない。 */
const MAX_COLD_RETRIES = 3;
/** キープアライブの間隔。無通信で切られる前に届く程度に短く。 */
const PING_INTERVAL_MS = 25000;

/** このブラウザの固定 ID。英数字だけ（サーバ側の検証と揃える）。 */
function randomCid(): string {
  return Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6);
}

/**
 * 部屋への接続。座標だけを中継する。
 *
 * 立ち止まっている間は一切送らない。無料枠を守る一番効く仕組みであり、
 * 散歩ゲームは止まっている時間が長いので効果も大きい。
 */
export class Connection {
  private ws: WebSocket | null = null;
  private lastSentAt = 0;
  private lastSent: PlayerState | null = null;
  private everOpened = false;
  private coldRetries = 0;
  private retryTimer = 0;
  private pingTimer = 0;
  private peers = new Set<string>();
  /**
   * このブラウザの固定 ID。再接続しても変わらない。
   * サーバがこれで「古い自分の接続」を見分けて消す（死体が残らない）。
   */
  private readonly cid = randomCid();

  private url: string;
  private seed: string;
  private name: string;
  private getState: () => PlayerState;
  private handlers: ConnectionHandlers;

  constructor(opts: {
    url: string;
    seed: string;
    name: string;
    getState: () => PlayerState;
    handlers: ConnectionHandlers;
  }) {
    this.url = opts.url;
    this.seed = opts.seed;
    this.name = opts.name;
    this.getState = opts.getState;
    this.handlers = opts.handlers;
    this.connect();
  }

  get peerCount(): number {
    return this.peers.size;
  }

  private connect(): void {
    this.handlers.onStatus('connecting');

    const url = new URL(this.url);
    url.searchParams.set('seed', this.seed);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url.toString());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.everOpened = true;
      this.coldRetries = 0;
      this.handlers.onStatus('open');
      const state = this.getState();
      this.lastSent = state;
      this.lastSentAt = performance.now();
      ws.send(JSON.stringify({ t: 'hello', cid: this.cid, name: this.name, s: state }));
      this.startPing();
    };

    ws.onmessage = (ev) => this.receive(ev.data);

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      clearInterval(this.pingTimer);
      // 残っていた他人を消す。繋ぎ直すと相手側の ID も振り直しになる。
      for (const id of this.peers) this.handlers.onLeave(id);
      this.peers.clear();
      this.scheduleReconnect();
    };

    // onerror の直後に必ず onclose が来るので、ここでは何もしない。
    ws.onerror = () => {};
  }

  /**
   * 無通信でも回線を保つ。立ち止まって座標を送らない間も、
   * 一定間隔で "ping" を送る。サーバは休眠したまま "pong" を自動で返す。
   * 途中の機器が「無通信だから」と回線を切るのを防ぐ。
   */
  private startPing(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('ping');
    }, PING_INTERVAL_MS);
  }

  private scheduleReconnect(): void {
    if (!this.everOpened) {
      this.coldRetries++;
      if (this.coldRetries > MAX_COLD_RETRIES) {
        // サーバが無い／満室。1 人で歩く分には困らないので諦める。
        this.handlers.onStatus('unreachable');
        return;
      }
    }

    this.handlers.onStatus(this.everOpened ? 'lost' : 'connecting');
    clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.connect(), RECONNECT_MS);
  }

  private receive(raw: unknown): void {
    if (typeof raw !== 'string') return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.t === 'welcome') {
      const players = Array.isArray(msg.players) ? msg.players : [];
      for (const p of players) this.addPeer(p);
      return;
    }

    if (msg.t === 'join') {
      this.addPeer({ id: msg.id, name: msg.name, s: msg.s });
      return;
    }

    if (msg.t === 'state') {
      const id = typeof msg.id === 'string' ? msg.id : null;
      if (!id || !this.peers.has(id)) return;
      const state = msg.s as PlayerState | undefined;
      if (state) this.handlers.onState(id, state);
      return;
    }

    if (msg.t === 'leave') {
      const id = typeof msg.id === 'string' ? msg.id : null;
      if (!id || !this.peers.delete(id)) return;
      this.handlers.onLeave(id);
    }
  }

  private addPeer(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const p = raw as Record<string, unknown>;
    if (typeof p.id !== 'string' || typeof p.name !== 'string') return;
    if (this.peers.has(p.id)) return;
    this.peers.add(p.id);
    this.handlers.onJoin({
      id: p.id,
      name: p.name,
      state: (p.s ?? null) as PlayerState | null,
    });
  }

  /**
   * 毎フレーム呼んでよい。実際に送るかどうかはここで決める。
   * 動いていなければ何も起きない。
   */
  update(now: number, state: PlayerState): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (now - this.lastSentAt < SEND_INTERVAL_MS) return;
    if (this.lastSent && !hasMoved(this.lastSent, state)) return;

    this.lastSent = { ...state };
    this.lastSentAt = now;
    this.ws.send(JSON.stringify({ t: 'state', s: state }));
  }
}

function hasMoved(a: PlayerState, b: PlayerState): boolean {
  if (a.flying !== b.flying) return true;
  if (Math.abs(a.yaw - b.yaw) > TURN_EPSILON) return true;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz > MOVE_EPSILON * MOVE_EPSILON;
}
