import { Room } from './room';

export { Room };

export interface Env {
  ROOMS: DurableObjectNamespace;
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

    // ここに来るのは、静的ファイルにも該当しなかった要求だけ。
    return new Response('not found', { status: 404 });
  },
};
