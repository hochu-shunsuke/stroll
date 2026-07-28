import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';

/**
 * ワールド生成の責務を分割するときに、見た目と配置を変えていないことを守る
 * characterization test（現行挙動の固定テスト）。
 *
 * 数値の良し悪しを判定するテストではない。地形を意図して調整した場合は、
 * 画面と統計を確認したうえで UPDATE_WORLD_SNAPSHOT=1 npm test を実行し、
 * 変更後のスナップショットをここへ反映する。
 */

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

try {
  const [{ Terrain }, { buildChunkArrays }, { buildScatterData }, treeModule, { findSpawn }] =
    await Promise.all([
      server.ssrLoadModule('/src/world/terrain.ts'),
      server.ssrLoadModule('/src/world/chunk.ts'),
      server.ssrLoadModule('/src/world/scatter.ts'),
      server.ssrLoadModule('/src/render/treeShape.ts'),
      server.ssrLoadModule('/src/world/spawn.ts'),
    ]);

  const digest = (...parts) => {
    const hash = createHash('sha256');
    for (const part of parts) {
      if (typeof part === 'string') {
        hash.update(part);
      } else {
        hash.update(Buffer.from(part.buffer, part.byteOffset, part.byteLength));
      }
    }
    return hash.digest('hex').slice(0, 20);
  };

  const coordinates = [
    [0, 0],
    [192, -384],
    [1024, 1536],
    [-2400, 800],
    [6144, -4096],
    [-7500, -7000],
    [12345, -6789],
    [-16384, 12288],
  ];
  const seeds = ['k7p2mq9x', 'a76nmz9h', 'itqherf3', 'sakurabc'];

  const terrain = {};
  for (const seed of seeds) {
    const world = new Terrain(seed);
    const values = [];
    for (const [x, z] of coordinates) {
      const h = world.heightAt(x, z);
      const special = world.specialAt(x, z);
      values.push(
        h,
        world.waterLevelAt(x, z),
        world.moistureAt(x, z),
        world.temperatureAt(x, z, h),
        world.groveAt(x, z),
        special.index,
        special.strength,
        world.heightOnGrid(x + 0.625, z + 1.375, 2),
      );
    }
    terrain[seed] = digest(JSON.stringify(values));
  }

  const chunkCases = [
    ['k7p2mq9x', 0, 0, 16],
    ['a76nmz9h', 4, -3, 16],
    ['itqherf3', -5, 2, 16],
  ];
  const chunks = chunkCases.map(([seed, cx, cz, step]) => {
    const arrays = buildChunkArrays(new Terrain(seed), cx, cz, step);
    return {
      case: `${seed}:${cx},${cz}@${step}`,
      lengths: [
        arrays.position.length,
        arrays.normal.length,
        arrays.color.length,
        arrays.water.length,
      ],
      hash: digest(arrays.position, arrays.normal, arrays.color, arrays.water),
    };
  });

  const scatterCases = [
    ['k7p2mq9x', 0, 0, 0],
    ['a76nmz9h', 4, -3, 0],
    ['itqherf3', -5, 2, 1],
  ];
  const scatter = scatterCases.map(([seed, cx, cz, lod]) => {
    const batches = buildScatterData(new Terrain(seed), cx, cz, lod);
    return {
      case: `${seed}:${cx},${cz}@${lod}`,
      kinds: batches.map((batch) => batch.kind),
      counts: batches.map((batch) => batch.matrices.length / 16),
      hash: digest(
        JSON.stringify(batches.map((batch) => batch.kind)),
        ...batches.flatMap((batch) => [batch.matrices, batch.colors]),
      ),
    };
  });

  const trees = treeModule.TREE_CATALOG.map((entry, index) => {
    const geometry = treeModule.buildCatalogGeometry(entry, 0x51f15e + index * 977);
    const position = geometry.getAttribute('position').array;
    const color = geometry.getAttribute('color').array;
    const normal = geometry.getAttribute('normal').array;
    return {
      name: entry.name,
      kind: entry.kind,
      vertices: geometry.getAttribute('position').count,
      hash: digest(position, color, normal),
    };
  });

  const actual = { terrain, chunks, scatter, trees };

  // 以前は湖底の標高だけで開始地点を選んでいたため、浅く平らな湖の中が
  // 「歩きやすい低地」と誤判定された。実際に再現したシードで水面外を保証する。
  for (const seed of ['s000000t', 's000001y', 's000001z', 's0000027', 's000002k']) {
    const world = new Terrain(seed);
    const spawn = findSpawn(world);
    assert.equal(
      Number.isFinite(world.waterLevelAt(spawn.x, spawn.z)),
      false,
      `${seed} の開始地点が湖の中です`,
    );
  }

  if (process.env.UPDATE_WORLD_SNAPSHOT === '1') {
    console.log(JSON.stringify(actual, null, 2));
    process.exitCode = 0;
  } else {
    const expected = {
      terrain: {
        k7p2mq9x: '5213cc7cbcafa0108d63',
        a76nmz9h: '5e9e36f79a6e862ff92f',
        itqherf3: '4325fb15eef782aeaac0',
        sakurabc: '147ef27346d10547f115',
      },
      chunks: [
        {
          case: 'k7p2mq9x:0,0@16',
          lengths: [3456, 3456, 3456, 0],
          hash: '9c0fb47d8afa90752816',
        },
        {
          case: 'a76nmz9h:4,-3@16',
          lengths: [3456, 3456, 3456, 0],
          hash: '28413f9f1582948bd86e',
        },
        {
          case: 'itqherf3:-5,2@16',
          lengths: [3456, 3456, 3456, 0],
          hash: 'f2f5acf370c706b62cca',
        },
      ],
      scatter: [
        {
          case: 'k7p2mq9x:0,0@0',
          kinds: [0, 6, 7, 1, 8, 9, 2, 3],
          counts: [7, 4, 11, 1, 6, 2, 7, 93],
          hash: 'af374320e4ad97f58258',
        },
        {
          case: 'a76nmz9h:4,-3@0',
          kinds: [2],
          counts: [2],
          hash: '0cf7bc71b8d9f3a9191d',
        },
        {
          case: 'itqherf3:-5,2@1',
          kinds: [2],
          counts: [4],
          hash: 'd6b674d85846da640668',
        },
      ],
      trees: [
        { name: '広葉樹 丸', kind: 0, vertices: 2940, hash: 'b36acb91a251fff50c9a' },
        { name: '広葉樹 高', kind: 6, vertices: 3090, hash: '2bba82fde9dd4c5c39a1' },
        { name: '広葉樹 傘', kind: 7, vertices: 3090, hash: '901eebf1c400dab04718' },
        { name: '枯れ木', kind: 10, vertices: 3600, hash: 'ba7706d9b3f9b62d3d93' },
        { name: '椰子', kind: 11, vertices: 690, hash: 'daeede3e4203008c2c4b' },
        { name: '針葉樹 成木', kind: 1, vertices: 282, hash: '81f36e5c00dd3a82d713' },
        { name: '針葉樹 若木', kind: 8, vertices: 198, hash: '1b487e0650b6e033ab92' },
        { name: '針葉樹 老木', kind: 9, vertices: 324, hash: '0fb277db2be270c3a7c3' },
        { name: '秋の木', kind: 4, vertices: 2340, hash: 'f2a9be78a2b496d1d030' },
        { name: '桜', kind: 5, vertices: 2340, hash: 'ef94b35290a0a2d15a4c' },
      ],
    };
    assert.deepEqual(
      actual,
      expected,
      'ワールド生成結果が変わりました。意図した変更なら画面と統計を確認してスナップショットを更新してください。',
    );
    console.log('PASS  ワールド生成（地形・チャンク・植生・木形状）が固定値と一致');
  }
} finally {
  await server.close();
}
