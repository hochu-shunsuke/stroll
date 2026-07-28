import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createServer } from 'vite';

/**
 * 広い世界を眺めるための飛行体験を固定する。
 *
 * 地形生成そのものではなく、PC とタッチが共有する Player の挙動を調べる。
 * 速度を変えるときは、チャンク生成が追従できるかも実機で確認してから更新すること。
 */

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

const flatTerrain = {
  heightOnGrid: () => 0,
  waterLevelAt: () => Number.NEGATIVE_INFINITY,
};

const rampTerrain = {
  // 100m 先から緩やかに標高が上がる。前方走査があれば、麓に着く前に上昇を始める。
  heightOnGrid: (_x, z) => Math.max(0, Math.min(100, (-z - 100) * 0.18)),
  waterLevelAt: () => Number.NEGATIVE_INFINITY,
};

function run(player, camera, seconds, step = 1 / 60) {
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    player.update(step, camera, true);
  }
}

try {
  const { Player, FLY_CRUISE_SPEED, FLY_BOOST_SPEED } =
    await server.ssrLoadModule('/src/player/controller.ts');

  {
    const player = new Player(flatTerrain, 0, 0);
    const camera = new THREE.PerspectiveCamera();
    player.toggleFlying();
    player.setMoveAxis(0, 1, 0);
    run(player, camera, 3);
    assert(
      Math.abs(player.speed - FLY_CRUISE_SPEED) < 0.2,
      `巡航速度が ${player.speed.toFixed(2)} m/s になっています`,
    );
  }

  {
    const player = new Player(flatTerrain, 0, 0);
    const camera = new THREE.PerspectiveCamera();
    player.toggleFlying();
    player.setMoveAxis(0, 1, 1);
    run(player, camera, 3);
    assert(
      player.speed >= FLY_BOOST_SPEED - 0.2,
      `高速飛行が ${player.speed.toFixed(2)} m/s までしか出ません`,
    );
    assert(
      player.speed <= FLY_BOOST_SPEED + 0.01,
      `高速飛行が上限を越えています: ${player.speed.toFixed(2)} m/s`,
    );
  }

  {
    const player = new Player(rampTerrain, 0, 0);
    const camera = new THREE.PerspectiveCamera();
    player.position.y = 60;
    player.toggleFlying();
    player.toggleAutoFlight();
    // 自動飛行を始めてから横を向く。進路だけは開始時のまま保たれるべき。
    player.onLook(700, 0, 0.0022);
    run(player, camera, 3);

    assert(player.position.z < -190, '自動飛行が前へ進んでいません');
    assert(
      Math.abs(player.position.x) < 1,
      `視点変更につられて進路がずれています: x=${player.position.x.toFixed(2)}`,
    );
    assert(
      player.altitudeAboveGround >= 50,
      `前方の斜面に対する高度が不足しています: ${player.altitudeAboveGround.toFixed(1)} m`,
    );
  }

  {
    const player = new Player(flatTerrain, 0, 0);
    const camera = new THREE.PerspectiveCamera();
    player.position.y = 60;
    player.toggleFlying();
    player.toggleAutoFlight();
    // 横へいっぱい倒すのは急旋回であって、高速飛行の指示ではない。
    player.setMoveAxis(1, 0, 1);
    run(player, camera, 3);
    assert(
      player.speed <= FLY_CRUISE_SPEED + 0.2,
      `タッチ旋回だけで高速になっています: ${player.speed.toFixed(2)} m/s`,
    );
  }

  {
    const original = new Player(flatTerrain, 0, 0);
    original.position.set(120, 88, -340);
    original.yaw = 1.25;
    original.pitch = -0.3;
    original.toggleFlying();

    const restored = new Player(flatTerrain, 0, 0);
    restored.restore(original.snapshot());
    assert.deepEqual(restored.snapshot(), original.snapshot(), '保存した位置へ正しく復帰できません');
    assert.equal(restored.autoFlight, false, '再開直後から自動飛行してはいけません');
  }

  console.log(
    'PASS  飛行体験',
    `巡航 ${FLY_CRUISE_SPEED} m/s`,
    `高速 ${FLY_BOOST_SPEED} m/s`,
    '自動飛行の進路・安全高度・位置復帰',
  );
} finally {
  await server.close();
}
