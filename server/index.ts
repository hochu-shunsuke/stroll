import { isSeed } from '../shared/seed';
import { Room } from './room';

export { Room };

export interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}

/**
 * 合言葉として扱わないパス。ここに載っているものは世界の名前になれない。
 * 静的ファイルは先に配信側が拾うので、ここに並べる必要はない。
 */
const RESERVED = new Set(['ws', 'assets']);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 部屋への接続。合言葉がそのまま部屋の名前になる。
    if (url.pathname === '/ws') {
      const seed = url.searchParams.get('seed');
      // 決まりに合わないものは部屋を作らせない。ここを通すと、
      // 好き勝手な名前の部屋がいくらでも生えてしまう。
      if (!isSeed(seed)) {
        return new Response('invalid seed', { status: 400 });
      }
      return env.ROOMS.get(env.ROOMS.idFromName(seed)).fetch(request);
    }

    // ここに来るのは、静的ファイルに該当しなかった要求だけ。
    // 合言葉のパス（/abc123）なら、本体をそのまま返す。
    const name = url.pathname.slice(1);
    if (isSeed(name) && !RESERVED.has(name)) {
      return env.ASSETS.fetch(new Request(new URL('/', url), request));
    }

    return new Response('not found', { status: 404 });
  },
};
