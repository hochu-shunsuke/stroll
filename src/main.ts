import * as THREE from 'three';
import { Ambience } from './audio/ambience';
import { AudioEngine } from './audio/engine';
import { Footsteps } from './audio/footsteps';
import { Connection, type NetStatus, type PlayerState } from './net/connection';
import { Player, type PlayerSnapshot } from './player/controller';
import { Avatars } from './render/avatars';
import { MORNING, Sky } from './render/sky';
import { Water } from './render/water';
import { ChunkManager } from './render/chunkManager';
import { Terrain } from './world/terrain';
import { Overlay } from './ui/overlay';
import { normalizeSeed, randomSeed } from '../shared/seed';
import { hashSeed } from './core/rng';
import {
  createTouchControls,
  hasTouchInput,
  isTouchDevice,
  type TouchControls,
} from './ui/touch';
import { findSpawn } from './world/spawn';

const LOOK_SENSITIVITY = 0.0022;
const POSITION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const MOBILE_PIXEL_BUDGET = 1_400_000;
const DESKTOP_PIXEL_BUDGET = 8_000_000;

interface SavedPosition extends PlayerSnapshot {
  savedAt: number;
}

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

interface WakeLockNavigator {
  wakeLock?: {
    request(type: 'screen'): Promise<WakeLockSentinelLike>;
  };
}

function main(): void {
  // 合言葉は URL の `#` より後ろに置く（/#k7p2mq9x）。
  // `#` 以降はサーバに送られないので、打ち間違えても 404 にならず、
  // 経路の場合分けも要らない。合言葉を変えるのもページ内で完結する。
  const requested = location.hash.slice(1);
  const fromHash = normalizeSeed(requested);
  const seed = fromHash ?? randomSeed();
  if (fromHash !== seed) {
    history.replaceState(null, '', `#${seed}`);
  }
  // 読めない合言葉で来た人に黙って別の世界を渡すと、
  // 着いたつもりで誰もいない場所を歩くことになる。必ず伝える。
  const badSeed = requested.length > 0 && fromHash === null;

  const preferredTouch = isTouchDevice();
  const touchCapable = hasTouchInput();
  let inputMode: 'touch' | 'keys' = preferredTouch ? 'touch' : 'keys';
  // 判定はここ 1 か所だけ。CSS もこの結果を見る。
  // 以前は CSS・overlay・touch がそれぞれ独立に判定していて、
  // 端末によって「指の説明が出るのに操作ボタンが無い」状態が起きた。
  document.documentElement.dataset.input = inputMode;

  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  // スマホは画素密度が高い割に描画性能が低い。上限を下げて滑らかさを優先する。
  const resizeRenderer = () => {
    const width = Math.max(1, innerWidth);
    const height = Math.max(1, innerHeight);
    const budget = inputMode === 'touch' ? MOBILE_PIXEL_BUDGET : DESKTOP_PIXEL_BUDGET;
    const budgetRatio = Math.sqrt(budget / (width * height));
    const deviceCap = inputMode === 'touch' ? 1.5 : 2;
    renderer.setPixelRatio(Math.max(0.75, Math.min(devicePixelRatio, deviceCap, budgetRatio)));
    renderer.setSize(width, height);
  };
  resizeRenderer();
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.3, 9000);
  camera.rotation.order = 'YXZ';

  const terrain = new Terrain(seed);
  // 雲の並びも合言葉から決める。同じ世界なら空も同じ。
  const sky = new Sky(scene, MORNING, hashSeed(seed)[0]);
  const water = new Water(scene, sky.sunDirection, MORNING.horizon, MORNING.sun);
  // 湖の水面はチャンクが作るが、材質は海と共有する。
  const chunks = new ChunkManager(scene, seed, water.material);

  const spawn = findSpawn(terrain);
  const player = new Player(terrain, spawn.x, spawn.z);
  // 最初に目に入る向きは、太陽から約 65° 横。
  // 真後ろ（順光）だと影が自分の裏に隠れて景色が平坦に見え、正面（逆光）だと眩しい。
  // 横から当たる光が、起伏が一番読める向き。
  player.yaw = Math.atan2(-sky.sunDirection.x, -sky.sunDirection.z) + Math.PI * 0.36;
  // 一度だけ反映しておく。これをしないと、歩き出すまでカメラが原点に留まり、
  // 開始画面の背景がこれから立つ場所と別の景色になる。
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  player.update(0, camera, reducedMotion);

  const positionKey = `stroll:position:${seed}`;
  const savedPosition = loadPosition(positionKey);

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
  let entryChosen = false;
  let contextLost = false;
  let wakeLock: WakeLockSentinelLike | null = null;
  let lastAutoFlight = false;
  let saveElapsed = 0;

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
  const overlay = new Overlay(
    document.getElementById('ui')!,
    seed,
    inputMode === 'touch',
    savedPosition !== null,
    {
      onStart: (resume, pointerType) => handleStart(resume, pointerType),
      // 地形も部屋も合言葉から作られるので、作り直すより読み込み直す方が確実。
      onSeed: (next) => {
        // 世界そのものを作り直すので、合言葉を差し替えてから読み込み直す。
        location.hash = next;
        location.reload();
      },
    },
  );

  const setInputMode = (next: 'touch' | 'keys') => {
    if (inputMode === next) return;
    inputMode = next;
    if (next === 'touch' && document.pointerLockElement) document.exitPointerLock();
    document.documentElement.dataset.input = next;
    overlay.setInputMode(next === 'touch');
    touchControls?.setActive(playing && next === 'touch');
    resizeRenderer();
  };

  function startAudio(): void {
    if (audio) {
      audio.resume();
      return;
    }
    audio = new AudioEngine();
    ambience = new Ambience(audio);
    footsteps = new Footsteps(audio);
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
    touchControls?.setActive(inputMode === 'touch');
    if (player.autoFlight) void requestWakeLock();
  }

  function stopPlaying(): void {
    savePosition();
    playing = false;
    // 押しっぱなし・倒しっぱなしの判定が残らないように全部戻す。
    player.clearKeys();
    // 隠さないと、開始画面の上にボタンが重なって表示されてしまう。
    touchControls?.setActive(false);
    void releaseWakeLock();
    overlay.show(
      inputMode === 'touch'
        ? '休憩中。タップすると続きから遊べます。'
        : '休憩中。クリックすると続きから遊べます。',
    );
  }

  function handleStart(resume: boolean, pointerType: string): void {
    if (contextLost) {
      location.reload();
      return;
    }

    const startedWithTouch = pointerType === 'touch' || pointerType === 'pen';
    setInputMode(startedWithTouch ? 'touch' : 'keys');

    if (!entryChosen) {
      entryChosen = true;
      if (resume && savedPosition) {
        player.restore(savedPosition);
        player.update(0, camera, reducedMotion);
      } else {
        try {
          localStorage.removeItem(positionKey);
        } catch {
          // 保存領域を閉じた内ブラウザでも、新しく始める操作自体は通す。
        }
      }
      overlay.setEntered();
    }

    startAudio();
    connect();

    if (inputMode === 'touch') {
      void enterFullscreen();
      startPlaying();
      return;
    }
    // Esc を押した直後はブラウザがしばらくロックを受け付けない。
    // 拒否されても例外にせず、押し直すよう促すだけにする。
    void requestMouseLock();
  }

  if (touchCapable) {
    touchControls = createTouchControls({
      root: document.getElementById('ui')!,
      surface: canvas,
      player,
      lookSensitivity: LOOK_SENSITIVITY,
      isPlaying: () => playing,
      onPause: stopPlaying,
      onTouchInput: () => setInputMode('touch'),
    });
  }

  let resizeQueued = false;
  const scheduleResize = () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      const width = Math.max(1, innerWidth);
      const height = Math.max(1, innerHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      resizeRenderer();
    });
  };
  window.addEventListener('resize', scheduleResize);
  window.visualViewport?.addEventListener('resize', scheduleResize);

  async function enterFullscreen(): Promise<void> {
    if (document.fullscreenElement) return;
    const root = document.documentElement as HTMLElement & {
      requestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
    };
    if (!root.requestFullscreen) return;
    try {
      await root.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      // 内ブラウザはメソッドがあっても拒否する。通常表示のまま遊べればよい。
      overlay.flash('全画面にできないため、この表示領域のまま遊びます。');
    }
  }

  async function requestMouseLock(): Promise<void> {
    try {
      await canvas.requestPointerLock({ unadjustedMovement: true } as PointerLockOptions);
    } catch {
      try {
        await canvas.requestPointerLock();
      } catch {
        overlay.flash('少し待ってから、もう一度クリックしてください');
      }
    }
  }

  async function requestWakeLock(): Promise<void> {
    if (!playing || !player.autoFlight || document.hidden || wakeLock) return;
    try {
      const nav = navigator as unknown as WakeLockNavigator;
      wakeLock = (await nav.wakeLock?.request('screen')) ?? null;
    } catch {
      // 省電力設定や内ブラウザが拒否しても、オートフライト自体は続ける。
    }
  }

  async function releaseWakeLock(): Promise<void> {
    const lock = wakeLock;
    wakeLock = null;
    try {
      await lock?.release();
    } catch {
      // 既にブラウザ側で解除済みなら何もしない。
    }
  }

  const updateCameraFeel = (dt: number) => {
    const aspect = Math.max(0.35, camera.aspect);
    const portrait = THREE.MathUtils.clamp((0.75 - aspect) / 0.3, 0, 1);
    const baseFov = THREE.MathUtils.lerp(68, 82, portrait);
    const speedFov =
      player.flying && !reducedMotion
        ? THREE.MathUtils.clamp((player.speed - 28) / 84, 0, 1) * 6
        : 0;
    const target = baseFov + speedFov;
    const next = THREE.MathUtils.lerp(camera.fov, target, 1 - Math.exp(-5 * dt));
    if (Math.abs(next - camera.fov) > 0.01) {
      camera.fov = next;
      camera.updateProjectionMatrix();
    }
  };

  const sceneFog = scene.fog instanceof THREE.FogExp2 ? scene.fog : null;
  const updateAerialVisibility = (dt: number, altitude: number) => {
    if (!sceneFog) return;
    const clear = THREE.MathUtils.smoothstep(altitude, 35, 220);
    const target = MORNING.fogDensity * THREE.MathUtils.lerp(1, 0.5, clear);
    sceneFog.density = THREE.MathUtils.lerp(
      sceneFog.density,
      target,
      1 - Math.exp(-2.5 * dt),
    );
  };

  const savePosition = () => {
    if (!entryChosen) return;
    const data: SavedPosition = { ...player.snapshot(), savedAt: Date.now() };
    try {
      localStorage.setItem(positionKey, JSON.stringify(data));
    } catch {
      // 内ブラウザの保存領域が使えなくてもプレイは止めない。
    }
  };

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    contextLost = true;
    savePosition();
    stopPlaying();
    overlay.show('描画を復旧します。下のボタンを押してください。');
    overlay.setActionLabel('再読み込み');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    if (contextLost) location.reload();
  });

  window.addEventListener('pagehide', savePosition);
  window.addEventListener('blur', () => {
    if (playing) player.clearKeys();
  });

  document.addEventListener('fullscreenchange', scheduleResize);

  /*
   * resize は visualViewport からも来る。アドレスバーが動く内ブラウザで
   * canvas とタッチ座標の基準を食い違わせない。
   */
  window.addEventListener('orientationchange', scheduleResize);

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
      setInputMode('keys');
      startPlaying();
    } else if (inputMode === 'keys' && playing) {
      stopPlaying();
    }
  });

  // 別のアプリに移ったら止める。スマホでは戻ってきたとき勝手に歩いていると困る。
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && playing) {
      savePosition();
      stopPlaying();
    } else if (!document.hidden && playing && player.autoFlight) {
      void requestWakeLock();
    }
  });

  const timer = new THREE.Timer();
  let elapsed = 0;
  let lastIdleRender = -Infinity;

  renderer.setAnimationLoop(() => {
    // タブを離れて戻ったときに一気に進まないよう上限を掛ける。
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    elapsed += dt;

    if (playing) {
      player.update(dt, camera, reducedMotion);
      saveElapsed += dt;
      if (saveElapsed >= 5) {
        saveElapsed = 0;
        savePosition();
      }
    }

    chunks.update(player.position.x, player.position.z);
    if (chunks.ready) {
      overlay.setReady();
      if (badSeed && !badSeedShown) {
        badSeedShown = true;
        overlay.flash('その合言葉は読めませんでした。新しい世界を作りました。');
      }
    }

    const altitude = player.altitudeAboveGround;
    updateCameraFeel(dt);
    updateAerialVisibility(dt, altitude);
    touchControls?.update();
    overlay.setFlightInfo(player.flying, player.speed, altitude, player.autoFlight);

    if (player.autoFlight !== lastAutoFlight) {
      lastAutoFlight = player.autoFlight;
      if (player.autoFlight) {
        overlay.flash('AUTO：視点は自由。左右を大きく入れると進路を変えます。');
        void requestWakeLock();
      } else {
        void releaseWakeLock();
      }
    }

    ambience?.update(dt, {
      speed: player.speed,
      moisture: terrain.moistureAt(player.position.x, player.position.z),
      altitude,
    });

    if (connection) {
      // 動いていなければ、この呼び出しは何も送らない。
      connection.update(performance.now(), playerState());
      overlay.setPeers(connection.peerCount, netMessage);
    }
    avatars.update(dt, camera);

    const shouldRender = playing || elapsed - lastIdleRender >= 1 / 20;
    if (shouldRender) {
      lastIdleRender = elapsed;
      sky.update(camera, elapsed);
      water.update(camera, elapsed);
      renderer.render(scene, camera);
    }
  });
}

function loadPosition(key: string): SavedPosition | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<SavedPosition>;
    const numbers = [value.x, value.y, value.z, value.yaw, value.pitch, value.savedAt];
    if (!numbers.every((number) => typeof number === 'number' && Number.isFinite(number))) {
      return null;
    }
    if (typeof value.flying !== 'boolean') return null;
    if (Date.now() - value.savedAt! > POSITION_MAX_AGE) return null;
    if (Math.abs(value.x!) > 10_000_000 || Math.abs(value.z!) > 10_000_000) return null;
    if (value.y! < -1_000 || value.y! > 20_000) return null;
    return value as SavedPosition;
  } catch {
    return null;
  }
}

main();
