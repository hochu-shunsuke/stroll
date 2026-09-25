import type * as THREE from 'three';
import type { FieldRequest, FieldResult, FieldInit } from '../world/fieldWorker';
import { setIslandLight } from './islandLight';
import type { Water } from './water';

/**
 * カメラの周りの地図（地面の高さと焼き込んだ光）を、動くのに合わせて作り直す。
 *   - 高さ → 海のシェーダー（水深で浅瀬の色・深みの色・岸の泡）
 *   - 光 → 地面と木の材質（山の影・谷の暗さ）
 * stroll は無限の世界なので、hakoniwa のように島全体を 1 度で計算できない。代わりに、
 * 描画の届く範囲（約 1.9km、その先は霧）より広い 6km 四方を地図にして、約 1km 動くごとに作り直す。
 * 計算は専用の Worker（world/fieldWorker.ts）で、チャンクの生成を待たせない。
 */

/** 地図の一辺（m）と格子の間隔（m）。 */
const FIELD_SIZE = 6144;
const FIELD_STEP = 16;
/** 地図の中心をこの刻みに揃える。カメラがこれだけ動くと作り直す（地図の端まで常に 2km 以上残る）。 */
const RECENTER = 1024;

export class RegionField {
  private readonly worker: Worker;
  private readonly n = FIELD_SIZE / FIELD_STEP + 1;
  private nextId = 1;
  private busy = false;
  /** 最後に頼んだ地図の中心。 */
  private cx = Number.NaN;
  private cz = Number.NaN;
  /** 最後に作るのにかかった時間（ms）。 */
  lastMs = 0;

  constructor(
    seed: string,
    private readonly water: Water,
    private readonly sunDirection: THREE.Vector3,
  ) {
    this.worker = new Worker(new URL('../world/fieldWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<FieldResult>) => this.onResult(ev.data);
    this.worker.postMessage({ type: 'init', seed } satisfies FieldInit);
  }

  /** 毎フレーム呼ぶ。カメラが地図の中心から離れたら作り直しを頼む。 */
  update(x: number, z: number): void {
    const cx = Math.round(x / RECENTER) * RECENTER;
    const cz = Math.round(z / RECENTER) * RECENTER;
    if (this.busy || (cx === this.cx && cz === this.cz)) return;
    this.cx = cx;
    this.cz = cz;
    this.busy = true;
    const s = this.sunDirection;
    this.worker.postMessage({
      type: 'field',
      id: this.nextId++,
      cx,
      cz,
      size: FIELD_SIZE,
      n: this.n,
      sun: [s.x, s.y, s.z],
    } satisfies FieldRequest);
  }

  private onResult(r: FieldResult): void {
    this.busy = false;
    this.lastMs = r.ms;
    this.water.setHeightMap(r.height, r.n, r.size, r.cx, r.cz);
    setIslandLight({ n: r.n, data: r.light }, r.size, r.cx, r.cz);
  }
}
