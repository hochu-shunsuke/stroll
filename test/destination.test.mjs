import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

try {
  const [
    { Terrain },
    { findSpawn },
    {
      DESTINATION_DISTANCE,
      DESTINATION_CLEARANCE,
      findDestination,
    },
  ] = await Promise.all([
    server.ssrLoadModule('/src/world/terrain.ts'),
    server.ssrLoadModule('/src/world/spawn.ts'),
    server.ssrLoadModule('/src/world/destination.ts'),
  ]);

  for (const seed of ['k7p2mq9x', '635c8zxx', 'sakurabc']) {
    const terrain = new Terrain(seed);
    const spawn = findSpawn(terrain);
    const first = findDestination(terrain, seed, spawn);
    const second = findDestination(terrain, seed, spawn);
    assert.deepEqual(first, second, `${seed}: 同じ世界で光の輪の位置が変わります`);
    assert(
      Math.abs(Math.hypot(first.x - spawn.x, first.z - spawn.z) - DESTINATION_DISTANCE) <
        1e-6,
      `${seed}: 光の輪が12km先にありません`,
    );
    assert(
      first.y - first.groundY >= DESTINATION_CLEARANCE - 1e-6,
      `${seed}: 光の輪が地形に近すぎます`,
    );
  }

  console.log('PASS  光の輪 同じ合言葉の約12km先・地形から62m以上');
} finally {
  await server.close();
}
