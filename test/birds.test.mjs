import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

try {
  const {
    BIRD_KINDS,
    birdKindForId,
    createBird,
    poseBird,
  } = await server.ssrLoadModule('/src/render/birds.ts');

  const examples = new Map();
  for (let i = 0; i < 200; i++) {
    const id = `bird-test-${i}`;
    const kind = birdKindForId(id);
    assert.equal(
      birdKindForId(id),
      kind,
      '同じ接続IDの鳥が呼ぶたびに変わっています',
    );
    if (!examples.has(kind)) examples.set(kind, id);
  }
  assert.deepEqual(
    [...examples.keys()].sort(),
    [...BIRD_KINDS].sort(),
    '4種類のうち選ばれない鳥があります',
  );

  for (const kind of BIRD_KINDS) {
    const bird = createBird(examples.get(kind));
    assert.equal(bird.kind, kind);

    let meshes = 0;
    let triangles = 0;
    bird.root.traverse((object) => {
      if (!object.isMesh) return;
      meshes++;
      const geometry = object.geometry;
      triangles += geometry.index
        ? geometry.index.count / 3
        : geometry.getAttribute('position').count / 3;
    });
    assert.equal(meshes, 5, `${kind} が5 draw callに収まっていません`);
    assert(
      triangles <= 500,
      `${kind} が500三角形を越えています: ${triangles}`,
    );

    poseBird(bird, 0.2, 0, 1);
    assert(
      Math.abs(bird.leftWing.rotation.y) > 1,
      `${kind} の地上翼が畳まれていません`,
    );
    poseBird(bird, 0.2, 1, 0);
    assert(
      Math.abs(bird.leftWing.rotation.y) < 1e-6,
      `${kind} の飛行翼が開いていません`,
    );

    for (const geometry of bird.geometries) geometry.dispose();
  }

  console.log(
    'PASS  鳥アバター',
    BIRD_KINDS.join(' / '),
    '各5 draw call・500三角形以下',
  );
} finally {
  await server.close();
}
