import * as THREE from 'three';
import { Ambience } from './audio/ambience';
import { AudioEngine } from './audio/engine';
import { Footsteps } from './audio/footsteps';
import { Connection, type NetStatus, type PlayerState } from './net/connection';
import { Player } from './player/controller';
import { Avatars } from './render/avatars';
import { MORNING, Sky } from './render/sky';
import { Water } from './render/water';
import { ChunkManager } from './render/chunkManager';
import { Terrain } from './world/terrain';
import { Overlay } from './ui/overlay';
import { normalizeSeed, randomSeed } from '../shared/seed';
import { createTouchControls, isTouchDevice, type TouchControls } from './ui/touch';

const LOOK_SENSITIVITY = 0.0022;

/**
 * 歩き出すのに気持ちのいい場所を探す。
 * 海の真ん中や崖の上から始まると、それだけで台無しになるので。
 */
function findSpawn(terrain: Terrain): { x: number; z: number } {
  const check = (x: number, z: number, minMoist: number) => {
    const h = terrain.heightAt(x, z);
    if (h < 4 || h > 26) return false;
    const d = 3;
    const dx = (terrain.heightAt(x + d, z) - h) / d;
    const dz = (terrain.heightAt(x, z + d) - h) / d;
    if (Math.hypot(dx, dz) > 0.35) return false;
    return terrain.moistureAt(x, z) >= minMoist;
  };

  // まず「緑があって平らな低地」を、なければ条件を緩めて探す。
  for (const minMoist of [0.45, 0.0]) {
    for (let r = 0; r < 7000; r += 44) {
      for (let a = 0; a < 24; a++) {
        const ang = (a / 24) * Math.PI * 2 + r * 0.011;
        const x = Math.cos(ang) * r;
        const z = Math.sin(ang) * r;
        if (check(x, z, minMoist)) return { x, z };
      }
    }
  }
  return { x: 0, z: 0 };
}

function main(): void {
  // 合言葉はパスに置く。/abc123 のように、余計な記号を挟まない形にしている。
  // 決まりに合わないものが来たら黙って新しい世界を作る（エラー画面は出さない）。
  const requested = location.pathname.slice(1);
  const fromPath = normalizeSeed(requested);
  const seed = fromPath ?? randomSeed();
  if (fromPath !== seed) {
    history.replaceState(null, '', `/${seed}`);
  }
  // 読めない合言葉で来た人に黙って別の世界を渡すと、
  // 着いたつもりで誰もいない場所を歩くことになる。必ず伝える。
  const badSeed = requested.length > 0 && fromPath === null;

  const touch = isTouchDevice();
  // 判定はここ 1 か所だけ。CSS もこの結果を見る。
  // 以前は CSS・overlay・touch がそれぞれ独立に判定していて、
  // 端末によって「指の説明が出るのに操作ボタンが無い」状態が起きた。
  document.documentElement.dataset.input = touch ? 'touch' : 'keys';

  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  // スマホは画素密度が高い割に描画性能が低い。上限を下げて滑らかさを優先する。
  renderer.setPixelRatio(Math.min(devicePixelRatio, touch ? 1.5 : 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.3, 9000);
  camera.rotation.order = 'YXZ';

  const terrain = new Terrain(seed);
  const sky = new Sky(scene, MORNING);
  const water = new Water(scene, sky.sunDirection, MORNING.horizon, MORNING.sun);
  const chunks = new ChunkManager(scene, seed);

  const spawn = findSpawn(terrain);
  const player = new Player(terrain, spawn.x, spawn.z);
  // 最初に目に入る向きは、太陽に少し背を向けた方が景色が読みやすい。
  player.yaw = Math.atan2(-sky.sunDirection.x, -sky.sunDirection.z) + Math.PI;
  // 一度だけ反映しておく。これをしないと、歩き出すまでカメラが原点に留まり、
  // 開始画面の背景がこれから立つ場所と別の景色になる。
  player.update(0, camera);

  const avatars = new Avatars(scene);
  let connection: Connection | null = null;
  let netMessage: string | null = null;

  const NET_MESSAGES: Record<NetStatus, string | null> = {
    connecting: '接続中…',
    open: null,
    lost: '接続が切れました。繋ぎ直しています',
    unreachable: '1人で歩いています',
  };

  // 本番はページを配っている Worker がそのまま中継も兼ねるので、行き先は同一オリジンで確定。
  // ここで環境変数を見ないのは意図的。一度 .env.local の開発用アドレスが本番に焼き込まれ、
  // 別の端末から誰にも会えなくなったことがある。設定で壊せる余地を残さない。
  // 開発中だけは vite と wrangler がポート違いなので設定を使う。無ければ通信しない。
  const relayUrl = import.meta.env.PROD
    ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    : (import.meta.env.VITE_RELAY_URL as string | undefined);

  // 音は最初の操作まで作れない（ブラウザの自動再生制限）。
  let audio: AudioEngine | null = null;
  let ambience: Ambience | null = null;
  let footsteps: Footsteps | null = null;

  // 歩いている最中かどうか。
  // PC はポインタロックの有無と一致するが、タッチ端末にはロックが無いので
  // 状態そのものを持ち、入力方式に依存しない形にしている。
  let playing = false;
  let badSeedShown = false;
  let touchControls: TouchControls | null = null;

  const PAUSE_HINT = touch
    ? '休憩中。タップすると続きから歩けます。'
    : '休憩中。クリックすると続きから歩けます。';

  /** 初回の挨拶にも毎回の送信にも同じものを使う。片方だけ変わると位置がずれる。 */
  const playerState = (): PlayerState => ({
    x: player.position.x,
    y: player.position.y,
    z: player.position.z,
    yaw: player.yaw,
    flying: player.flying,
  });

  // 以下を関数宣言にしてあるのは、overlay より前に置いても初期化前参照にならないため。
  // アロー関数の const にすると、呼ばれる順番だけが頼りの危うい形になる。
  const overlay = new Overlay(document.getElementById('ui')!, seed, touch, {
    onStart: () => handleStart(),
    onVolume: (v) => audio?.setVolume(v),
    // 地形も部屋も合言葉から作られるので、作り直すより読み込み直す方が確実。
    onSeed: (next) => {
      location.href = `/${next}`;
    },
  });

  function startAudio(): void {
    if (audio) {
      audio.resume();
      return;
    }
    audio = new AudioEngine();
    ambience = new Ambience(audio);
    footsteps = new Footsteps(audio);
    audio.setVolume(overlay.volume);
    player.onFootstep = (intensity) => footsteps!.step(intensity);
    player.onLand = (intensity) => footsteps!.land(intensity);
  }

  function connect(): void {
    if (connection || !relayUrl) return;
    connection = new Connection({
      url: relayUrl,
      seed,
      name: overlay.name || '名無し',
      getState: playerState,
      handlers: {
        onJoin: (peer) => avatars.add(peer.id, peer.name, peer.state),
        onLeave: (id) => avatars.remove(id),
        onState: (id, state) => avatars.setState(id, state),
        onStatus: (status) => {
          netMessage = NET_MESSAGES[status];
        },
      },
    });
  }

  function startPlaying(): void {
    playing = true;
    overlay.hide();
    touchControls?.setActive(true);
  }

  function stopPlaying(): void {
    playing = false;
    // 押しっぱなし・倒しっぱなしの判定が残らないように全部戻す。
    player.clearKeys();
    // 隠さないと、開始画面の上にボタンが重なって表示されてしまう。
    touchControls?.setActive(false);
    overlay.show(PAUSE_HINT);
  }

  function handleStart(): void {
    startAudio();
    connect();

    if (touch) {
      startPlaying();
      return;
    }
    // Esc を押した直後はブラウザがしばらくロックを受け付けない。
    // 拒否されても例外にせず、押し直すよう促すだけにする。
    const request = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    request?.catch?.(() => overlay.flash('少し待ってから、もう一度クリックしてください'));
  }

  if (touch) {
    touchControls = createTouchControls({
      root: document.getElementById('ui')!,
      surface: canvas,
      player,
      lookSensitivity: LOOK_SENSITIVITY,
      isPlaying: () => playing,
      onPause: stopPlaying,
    });
  }

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') e.preventDefault();
    if (!playing) return;
    if (e.code === 'KeyM' && !e.repeat) {
      const muted = audio?.toggleMute() ?? false;
      overlay.flash(muted ? '音を切りました' : '音を戻しました');
      return;
    }
    player.onKey(e.code, true, e.repeat);
  });
  window.addEventListener('keyup', (e) => {
    if (playing) player.onKey(e.code, false);
  });

  window.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    player.onLook(e.movementX, e.movementY, LOOK_SENSITIVITY);
  });

  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === canvas) {
      startPlaying();
    } else if (!touch) {
      stopPlaying();
    }
  });

  // 別のアプリに移ったら止める。スマホでは戻ってきたとき勝手に歩いていると困る。
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && playing) stopPlaying();
  });

  const timer = new THREE.Timer();
  let elapsed = 0;

  renderer.setAnimationLoop(() => {
    // タブを離れて戻ったときに一気に進まないよう上限を掛ける。
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    elapsed += dt;

    if (playing) {
      player.update(dt, camera);
    }

    chunks.update(player.position.x, player.position.z);
    if (chunks.ready) {
      overlay.setReady();
      if (badSeed && !badSeedShown) {
        badSeedShown = true;
        overlay.flash('その合言葉は読めませんでした。新しい世界を作りました。');
      }
    }

    ambience?.update(dt, {
      speed: player.speed,
      moisture: terrain.moistureAt(player.position.x, player.position.z),
    });

    if (connection) {
      // 動いていなければ、この呼び出しは何も送らない。
      connection.update(performance.now(), playerState());
      overlay.setPeers(connection.peerCount, netMessage);
    }
    avatars.update(dt, camera);

    sky.update(camera);
    water.update(camera, elapsed);
    renderer.render(scene, camera);
  });
}

main();
