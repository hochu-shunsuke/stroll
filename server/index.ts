import { isSeed } from '../shared/seed';
import { Room } from './room';

export { Room };

export interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}

/**
 * 合言葉は URL の `#` より後ろに載る（例: /#k7p2mq9x）。
 * `#` 以降はブラウザがサーバに送らないので、サーバから見える経路は常に `/` だけ。
 *
 * おかげで、合言葉を打ち間違えても 404 が起きようがない（サーバが見ないから）。
 * 経路の場合分けも、予約語も、静的ファイルとの衝突も、まるごと不要になる。
 * サーバがやるのは中継（/ws）だけ。あとは本体を返す。
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 部屋への接続。合言葉はここでは query に載る（サーバに渡す必要があるため）。
    // 利用者が見る URL とは別物で、これは内部の受け渡し。
    if (url.pathname === '/ws') {
      const seed = url.searchParams.get('seed');
      // 決まりに合わないものは部屋を作らせない。ここを通すと、
      // 好き勝手な名前の部屋がいくらでも生えてしまう。
      if (!isSeed(seed)) {
        return new Response('invalid seed', { status: 400 });
      }
      return env.ROOMS.get(env.ROOMS.idFromName(seed)).fetch(request);
    }

    // 実在する静的ファイル（/ や /assets/*）はここに来る前に配信側が返す。
    // ここへ来るのは打ち間違いのパスなので、404 を出さず本体を見せておく。
    // 合言葉は `#` に載っているから、本体が起動すればそのまま正しい世界になる。
    return env.ASSETS.fetch(new Request(new URL('/', url), request));
  },
};
