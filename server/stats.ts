/**
 * 数を数えるだけの入れ物。
 *
 * 記録するのは 4 つの合計値だけで、誰が来たかは一切残さない。
 * Cookie も識別子も IP も保存しないので、同意バナーが要らない。
 * 「静かに歩く」体験の入口にバナーを挟みたくないため、これは仕様。
 *
 * 知りたいのは PV ではなく、この 1 点：
 *   共有された URL を受け取った人が、実際に歩き始めたか。
 * 「一緒に歩ける」が売りである以上、1 人が何人連れてくるかが全てで、
 * これが 1 を超えないうちは、広告を打っても穴の空いたバケツになる。
 */
const COUNTERS = [
  /** 合言葉つきの URL で来た（＝誰かに誘われた）。 */
  'load-invited',
  /** 何も付いていない URL で来た（＝自分で見つけた）。 */
  'load-direct',
  /** 誘われて来て、実際に歩き出した。 */
  'start-invited',
  /** 自分で来て、実際に歩き出した。 */
  'start-direct',
] as const;

type Counter = (typeof COUNTERS)[number];

function isCounter(value: unknown): value is Counter {
  return typeof value === 'string' && (COUNTERS as readonly string[]).includes(value);
}

function rate(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

export class Stats {
  private storage: DurableObjectStorage;

  constructor(state: DurableObjectState) {
    this.storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/bump') {
      const key = url.searchParams.get('k');
      // 知らない名前は数えない。外から好き勝手な項目を生やされないように。
      if (!isCounter(key)) return new Response('unknown counter', { status: 400 });
      // Durable Object は 1 つずつしか動かないので、読んで足して書くだけで competing しない。
      const current = (await this.storage.get<number>(key)) ?? 0;
      await this.storage.put(key, current + 1);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/read') {
      const n: Record<Counter, number> = {
        'load-invited': 0,
        'load-direct': 0,
        'start-invited': 0,
        'start-direct': 0,
      };
      for (const key of COUNTERS) {
        n[key] = (await this.storage.get<number>(key)) ?? 0;
      }

      return Response.json({
        誘われて来た: n['load-invited'],
        自分で来た: n['load-direct'],
        誘われて歩き出した: n['start-invited'],
        自分で来て歩き出した: n['start-direct'],
        // 誘われた人のうち、実際に歩き出した割合。招待が機能しているかの本体。
        招待の成立率: `${rate(n['start-invited'], n['load-invited'])}%`,
        自力訪問の成立率: `${rate(n['start-direct'], n['load-direct'])}%`,
        // 歩き出した人 1 人あたり、何人を連れてきたか。1 を超えたら勝手に広がる。
        連れてきた人数: (() => {
          const walkers = n['start-invited'] + n['start-direct'];
          if (walkers === 0) return 0;
          return Math.round((n['load-invited'] / walkers) * 100) / 100;
        })(),
      });
    }

    return new Response('not found', { status: 404 });
  }
}
