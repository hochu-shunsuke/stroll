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

const plateauTerrain = {
  heightOnGrid: () => 120,
  waterLevelAt: () => Number.NEGATIVE_INFINITY,
};

function run(player, camera, seconds, step = 1 / 60) {
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    player.update(step, camera, true);
  }
}

try {
  const [
    { Player, EYE_HEIGHT, FLY_CRUISE_SPEED, FLY_BOOST_SPEED },
    { resolveEntryPointerType },
    { friendEdgeIndicators, formatFriendDistance },
  ] = await Promise.all([
    server.ssrLoadModule('/src/player/controller.ts'),
    server.ssrLoadModule('/src/ui/overlay.ts'),
    server.ssrLoadModule('/src/ui/friendCompass.ts'),
  ]);

  assert.equal(
    resolveEntryPointerType('touch', 'mouse', true, 1),
    'touch',
    'iOS Safariの誤ったclick.pointerTypeよりpointerdownを優先できません',
  );
  assert.equal(
    resolveEntryPointerType('', 'mouse', true, 1),
    'touch',
    '古いiOS SafariのMouseEvent clickをタッチへ戻せません',
  );
  assert.equal(
    resolveEntryPointerType('mouse', 'mouse', true, 1),
    'mouse',
    'タッチ対応端末で実際に使ったマウスを奪っています',
  );
  assert.equal(
    resolveEntryPointerType('touch', '', true, 0),
    'keyboard',
    '直前にタッチしていてもキーボード操作をタッチへ誤分類しています',
  );

  {
    const directions = friendEdgeIndicators(0, 0, 0, 0, 0, [
      { id: 'right-back', name: '右後ろ', x: 100, y: 0, z: 100 },
      { id: 'front', name: '前', x: 0, y: 0, z: -20 },
      { id: 'front-up', name: '上前方', x: 0, y: 40, z: -30 },
      { id: 'back', name: '後ろ', x: 0, y: 0, z: 60 },
    ]);
    assert.deepEqual(
      directions.map((direction) => direction.name),
      ['前', '上前方', '後ろ', '右後ろ'],
      '友達が近い順に並んでいません',
    );
    assert(directions[0].directionY < 0, '正面の友達を上端へ示していません');
    assert(
      directions.find((direction) => direction.name === '右後ろ').directionX > 0,
      '右後ろの友達を右端へ示していません',
    );
    assert(
      directions.find((direction) => direction.name === '上前方').directionY <
        directions[0].directionY,
      '上前方の友達が正面より上寄りになっていません',
    );
    assert(
      directions.find((direction) => direction.name === '後ろ').directionY > 0,
      '後ろの友達を下端へ示していません',
    );
    assert.equal(formatFriendDistance(999.4), '999 m');
    assert.equal(formatFriendDistance(1_260), '1.3 km');
    assert.equal(formatFriendDistance(12_600), '13 km');
  }

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
    player.position.y = 60;
    // 空から地形を見下ろす角度でも、上昇ボタン中は前進と上昇が同時に成立する。
    player.pitch = -1.2;
    player.setMoveAxis(0, 1, 0);
    player.onKey('Space', true, false, false);
    run(player, camera, 1);
    player.onKey('Space', false, false, false);
    assert(
      player.position.z < -20,
      `見下ろし中の前進距離が不足しています: ${player.position.z.toFixed(1)} m`,
    );
    assert(
      player.position.y > 85,
      `前進と同時に上昇できていません: ${player.position.y.toFixed(1)} m`,
    );
  }

  for (const pitch of [0.6, -0.6]) {
    const player = new Player(flatTerrain, 0, 0);
    const camera = new THREE.PerspectiveCamera();
    player.position.y = 100;
    player.toggleFlying();
    player.pitch = pitch;
    player.setMoveAxis(0, 1, 0);
    run(player, camera, 1);
    assert(
      player.position.z < -45,
      `視線方向へ十分に前進していません: ${player.position.z.toFixed(1)} m`,
    );
    assert(
      pitch > 0 ? player.position.y > 130 : player.position.y < 70,
      `視線の上下が飛行方向へ反映されていません: pitch=${pitch}, y=${player.position.y.toFixed(1)}`,
    );
  }

  {
    const player = new Player(plateauTerrain, 0, 0);
    assert(
      Math.abs(player.altitudeAboveGround - EYE_HEIGHT) < 0.01,
      `地表高が正しくありません: ${player.altitudeAboveGround.toFixed(2)} m`,
    );
    assert(
      Math.abs(player.altitudeAboveSeaLevel - (120 + EYE_HEIGHT)) < 0.01,
      `HUD用高度が海面基準ではありません: ${player.altitudeAboveSeaLevel.toFixed(2)} m`,
    );
  }

  {
    const player = new Player(flatTerrain, 0, 0);
    const camera = new THREE.PerspectiveCamera();
    player.position.y = 60;
    player.toggleFlying();
    player.toggleAutoFlight();
    // 前へ倒した指のわずかな横ずれは、AUTO の針路を永久に変えてはいけない。
    player.setMoveAxis(0.25, 0.85, 0);
    run(player, camera, 2);
    assert(
      Math.abs(player.position.x) < 1,
      `斜め前進のぶれで進路がずれています: x=${player.position.x.toFixed(2)}`,
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
    run(player, camera, 1.2);
    assert(
      player.speed <= FLY_CRUISE_SPEED + 0.2,
      `タッチ旋回だけで高速になっています: ${player.speed.toFixed(2)} m/s`,
    );
    const beforeRelease = player.position.clone();
    player.setMoveAxis(0, 0, 0);
    run(player, camera, 1.5);
    assert(
      Math.abs(player.position.x - beforeRelease.x) > 40,
      '明確に設定した新しい進路が、入力を離した後に保持されていません',
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
