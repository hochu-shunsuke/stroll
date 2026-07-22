import { Room } from './room';
import { Stats } from './stats';

export { Room, Stats };

export interface Env {
  ROOMS: DurableObjectNamespace;
  STATS: DurableObjectNamespace;
}

/**
 * 集計先の名前。部屋と違って 1 つで足りる。
 *
 * 数え直したくなったらこの文字列を変える。別の入れ物が新しく作られ、
 * 全ての値がゼロから始まる。消すための口を外に開けずに済む。
 */
const STATS_KEY = 'count-1';

function stats(env: Env): DurableObjectStub {
  return env.STATS.get(env.STATS.idFromName(STATS_KEY));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 部屋への接続。シードがそのまま部屋の名前になる。
    if (url.pathname === '/ws') {
      const seed = url.searchParams.get('seed');
      if (!seed || seed.length > 64) {
        return new Response('missing or invalid seed', { status: 400 });
      }
      const id = env.ROOMS.idFromName(seed);
      return env.ROOMS.get(id).fetch(request);
    }

    // 数を 1 つ増やすだけ。何を数えるかは Stats 側が検査する。
    if (url.pathname === '/hit' && request.method === 'POST') {
      const key = url.searchParams.get('e') ?? '';
      return stats(env).fetch(
        new Request(`https://stats/bump?k=${encodeURIComponent(key)}`, { method: 'POST' }),
      );
    }

    // 合計値だけなので隠さない。開けば今の数字が読める。
    if (url.pathname === '/stats') {
      return stats(env).fetch(new Request('https://stats/read'));
    }

    // ここに来るのは、静的ファイルにも該当しなかった要求だけ。
    return new Response('not found', { status: 404 });
  },
};
