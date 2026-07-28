import * as THREE from 'three';
import { LOD_STEPS } from '../world/chunk';
import {
  SEA_LEVEL,
  STEEPEST_LANDFORM_SLOPE,
  STEEPEST_RIVER_BANK,
  STEEPEST_SHORE,
  type Terrain,
} from '../world/terrain';

/**
 * 目線の高さ。通信で送る y はこの高さの値なので、
 * 他人のアバターの身長もこれに合わせる必要がある。
 */
export const EYE_HEIGHT = 1.68;
const WALK_SPEED = 5.4;
const SPRINT_SPEED = 10.5;
const SWIM_SPEED = 3.2;
/** 空から地形を探す通常速度。PC・タッチで同じ値を使う。 */
export const FLY_CRUISE_SPEED = 78;
/** 遠くの地形へ移る高速飛行。 */
export const FLY_BOOST_SPEED = 112;
/** 視線と独立して上下するときの速さ。 */
const FLY_VERTICAL_SPEED = 32;
/** オートフライトが地形との間に保つ最低高度。 */
const AUTO_CLEARANCE = 52;
const AUTO_TURN_RATE = 1.05;
const AUTO_LOOK_AHEAD = [70, 170, 320] as const;
const GRAVITY = 26;
const JUMP_SPEED = 7.2;
/** 這い上がれる斜面の限界。水平 1 進む間に登れる高さ。 */
const MAX_CLIMB = 1.15;

// 台地の縁がこれより急だと、歩いて上に行けない台地ができる。
// 突き合わせを player 側に置いているのは、MAX_CLIMB を world 側に書き写すと
// 同じ定数が 2 か所に散り、片方だけ変えたときに型検査を通って壊れるため。
if (STEEPEST_LANDFORM_SLOPE > MAX_CLIMB) {
  throw new Error(
    '台地の縁が MAX_CLIMB より急です。' +
      'terrain.ts の PLATEAU_RISE_MAX を下げるか landform.ts の EDGE_WIDTH を広げてください',
  );
}

// 谷の斜面も同じ。渡れない谷は散歩を途切れさせる。
if (STEEPEST_RIVER_BANK > MAX_CLIMB) {
  throw new Error(
    '谷の斜面が MAX_CLIMB より急です。' +
      'terrain.ts の RIVER_DEPTH を下げるか RIVER_HALF を広げてください',
  );
}

// 湖の岸も同じ。上がれない湖に落ちると出られなくなる。
if (STEEPEST_SHORE > MAX_CLIMB) {
  throw new Error(
    '湖の岸が MAX_CLIMB より急です。' +
      'lake.ts の SINK / LAKE_DEPTH を下げるか SHORE_WIDTH を広げてください',
  );
}
/** 泳ぎに切り替わる水深。 */
const SWIM_DEPTH = 1.3;
/** 二度押しと見なす間隔（ミリ秒）。 */
const DOUBLE_TAP_MS = 280;
/** 一歩の歩幅。走ると大きく踏み出すので、足音は速くなりすぎない。 */
const STRIDE_WALK = 2.05;
const STRIDE_SPRINT = 3.2;
const STRIDE_SWIM = 1.5;

export interface PlayerSnapshot {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flying: boolean;
}

export class Player {
  readonly position = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  flying = false;
  autoFlight = false;

  /** 足が地面に着いた瞬間に呼ばれる。0..1 の強さ付き。 */
  onFootstep: ((intensity: number) => void) | null = null;
  /** 落下から着地した瞬間に呼ばれる。 */
  onLand: ((intensity: number) => void) | null = null;

  private velocity = new THREE.Vector3();
  private verticalVelocity = 0;
  private grounded = false;
  private bobPhase = 0;
  private eyeOffset = EYE_HEIGHT;
  private keys = new Set<string>();
  private lastTap = new Map<string, number>();
  private sprinting = false;
  private stepDistance = 0;
  /** タッチのスティック。倒した量がそのまま速度になる。 */
  private axisX = 0;
  private axisY = 0;
  /** 0=通常、1=全速。外周で滑らかに上がり、速度を段差にしない。 */
  private axisBoost = 0;
  private autoHeading = 0;
  private autoAltitude = 0;
  private cameraRoll = 0;
  private readonly targetVelocity = new THREE.Vector3();
  private terrain: Terrain;
  private groundStep = LOD_STEPS[0];

  constructor(terrain: Terrain, startX: number, startZ: number) {
    this.terrain = terrain;
    this.position.set(startX, this.groundAt(startX, startZ) + EYE_HEIGHT, startZ);
  }

  private groundAt(x: number, z: number): number {
    return this.terrain.heightOnGrid(x, z, this.groundStep);
  }

  /** 海または内陸湖の水面。水のない陸では海面を返す。 */
  private waterSurfaceAt(x: number, z: number): number {
    const lake = this.terrain.waterLevelAt(x, z);
    return Number.isFinite(lake) ? lake : SEA_LEVEL;
  }

  onKey(code: string, down: boolean, repeat = false, detectDoubleTap = true): void {
    if (!down) {
      // 前進をやめたらダッシュも解除する（Minecraft と同じ感覚）。
      if (code === 'KeyW' || code === 'ArrowUp') this.sprinting = false;
      this.keys.delete(code);
      return;
    }

    // キーリピートは二度押しに数えない。
    if (!repeat) {
      const now = performance.now();
      const prev = this.lastTap.get(code) ?? -Infinity;
      const doubleTapped = detectDoubleTap && now - prev < DOUBLE_TAP_MS;
      // 一度成立させたら記録を捨てる。三度押しで再発火させないため。
      if (detectDoubleTap) this.lastTap.set(code, doubleTapped ? -Infinity : now);

      if (doubleTapped) {
        if (code === 'KeyW' || code === 'ArrowUp') this.sprinting = true;
        if (code === 'Space') this.toggleFlying();
      }
      if (code === 'KeyF') this.toggleFlying();
      if (code === 'KeyR') this.toggleAutoFlight();
    }

    this.keys.add(code);
  }

  toggleFlying(): boolean {
    this.flying = !this.flying;
    this.verticalVelocity = 0;
    if (this.flying) {
      this.grounded = false;
    } else {
      this.autoFlight = false;
      // 飛行を切ると落下に移るので、横の勢いだけ残す。
      this.velocity.y = 0;
    }
    return this.flying;
  }

  /**
   * 現在の向きと高さで巡航する。視点はその後も自由に動かせる。
   * 地上で誤って押しても突然浮き上がらないよう、飛行中だけ受け付ける。
   */
  toggleAutoFlight(): boolean {
    if (!this.flying) return false;
    this.autoFlight = !this.autoFlight;
    if (this.autoFlight) {
      this.autoHeading = this.yaw;
      this.autoAltitude = Math.max(
        this.position.y,
        this.groundAt(this.position.x, this.position.z) + AUTO_CLEARANCE,
      );
    }
    return this.autoFlight;
  }

  /**
   * タッチのスティックを反映する。x が右、y が前。
   * 長さがそのまま速度の割合になるので、そっと歩くこともできる。
   */
  setMoveAxis(x: number, y: number, boost: number): void {
    this.axisX = x;
    this.axisY = y;
    this.axisBoost = THREE.MathUtils.clamp(boost, 0, 1);
  }

  clearKeys(): void {
    this.keys.clear();
    this.sprinting = false;
    this.lastTap.clear();
    this.axisX = 0;
    this.axisY = 0;
    this.axisBoost = 0;
  }

  onLook(dx: number, dy: number, sensitivity: number): void {
    this.yaw -= dx * sensitivity;
    this.pitch -= dy * sensitivity;
    const limit = Math.PI / 2 - 0.02;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
  }

  /**
   * 現在の移動速度 (m/s)。風の音の大きさになる。
   * 歩行中は重力を verticalVelocity で別に持っているので、
   * ここで合算しないと落下やジャンプが速度に現れない。
   */
  get speed(): number {
    if (this.flying) return this.velocity.length();
    return Math.hypot(this.velocity.x, this.velocity.z, this.verticalVelocity);
  }

  get altitudeAboveGround(): number {
    return Math.max(0, this.position.y - this.groundAt(this.position.x, this.position.z));
  }

  snapshot(): PlayerSnapshot {
    return {
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
      yaw: this.yaw,
      pitch: this.pitch,
      flying: this.flying,
    };
  }

  restore(snapshot: PlayerSnapshot): void {
    this.position.set(snapshot.x, snapshot.y, snapshot.z);
    this.yaw = snapshot.yaw;
    this.pitch = THREE.MathUtils.clamp(snapshot.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
    this.flying = snapshot.flying;
    this.autoFlight = false;
    this.velocity.set(0, 0, 0);
    this.verticalVelocity = 0;
    this.grounded = false;
    const floor = this.groundAt(snapshot.x, snapshot.z) + (snapshot.flying ? 1.2 : EYE_HEIGHT);
    if (this.position.y < floor) this.position.y = floor;
  }

  /** 水に浸かっているか（UI と移動速度の切り替えに使う）。 */
  get swimming(): boolean {
    if (this.flying) return false;
    const x = this.position.x;
    const z = this.position.z;
    return this.groundAt(x, z) < this.waterSurfaceAt(x, z) - SWIM_DEPTH;
  }

  update(dt: number, camera: THREE.PerspectiveCamera, reducedMotion = false): void {
    const k = this.keys;
    let fwd = 0;
    let side = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) fwd += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) fwd -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) side += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) side -= 1;

    const len = Math.hypot(fwd, side);
    if (len > 0) {
      fwd /= len;
      side /= len;
    }

    // 前に進んでいない間はダッシュを維持しない。
    if (fwd <= 0) this.sprinting = false;

    // スティックが倒れていればそちらを使う。キーと違って中間の速さを持てる。
    if (this.axisX !== 0 || this.axisY !== 0) {
      fwd = this.axisY;
      side = this.axisX;
    }

    const swimming = this.swimming;
    const keyBoost =
      this.sprinting || k.has('ShiftLeft') || k.has('ShiftRight') ? 1 : 0;
    const boost = Math.max(keyBoost, this.axisBoost);

    if (this.flying) {
      this.updateFly(dt, fwd, side, boost, keyBoost);
    } else {
      this.updateWalk(dt, fwd, side, boost, swimming);
    }

    // 歩いている間だけ、視点をごくわずかに上下させる。
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (!this.flying && this.grounded && speed > 0.5) {
      this.bobPhase += dt * speed * 1.15;
    }
    const bob = this.flying || reducedMotion ? 0 : Math.sin(this.bobPhase * 2) * 0.055;
    const rollTarget = this.flying && !reducedMotion ? -side * 0.065 : 0;
    this.cameraRoll += (rollTarget - this.cameraRoll) * (1 - Math.exp(-7 * dt));

    camera.position.set(
      this.position.x,
      this.position.y + bob,
      this.position.z,
    );
    camera.rotation.set(this.pitch, this.yaw, this.cameraRoll, 'YXZ');
  }

  private updateFly(
    dt: number,
    fwd: number,
    side: number,
    boost: number,
    keyBoost: number,
  ): void {
    if (this.autoFlight) {
      this.updateAutoFlight(dt, fwd, side, keyBoost);
      return;
    }

    const throttle = Math.min(1, Math.hypot(fwd, side));
    const speed = THREE.MathUtils.lerp(FLY_CRUISE_SPEED, FLY_BOOST_SPEED, boost) * throttle;

    // 見ている方向にそのまま進む。上を向けば上がり、下を向けば下がる。
    // 左右移動だけは水平に保たないと、傾いたときに操作が読めなくなる。
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.targetVelocity.set(
      -sy * cp * fwd + cy * side,
      sp * fwd,
      -cy * cp * fwd - sy * side,
    );
    if (this.targetVelocity.lengthSq() > 0) {
      this.targetVelocity.normalize().multiplyScalar(speed);
    }

    // 視線と関係なく真上・真下へ動きたいとき用。
    if (this.keys.has('Space')) this.targetVelocity.y += FLY_VERTICAL_SPEED;
    if (
      this.keys.has('ControlLeft') ||
      this.keys.has('ControlRight') ||
      this.keys.has('KeyC')
    ) {
      this.targetVelocity.y -= FLY_VERTICAL_SPEED;
    }

    this.velocity.lerp(this.targetVelocity, 1 - Math.exp(-6 * dt));
    this.position.addScaledVector(this.velocity, dt);
    this.keepAboveGround();
  }

  private updateAutoFlight(dt: number, fwd: number, side: number, keyBoost: number): void {
    this.autoHeading -= side * AUTO_TURN_RATE * dt;
    const cy = Math.cos(this.autoHeading);
    const sy = Math.sin(this.autoHeading);

    // 現在地だけでなく前方も見ておく。山へ着いてから急上昇すると画面が跳ねる。
    let safeAltitude = this.groundAt(this.position.x, this.position.z) + AUTO_CLEARANCE;
    for (const distance of AUTO_LOOK_AHEAD) {
      const ground = this.groundAt(
        this.position.x - sy * distance,
        this.position.z - cy * distance,
      );
      safeAltitude = Math.max(safeAltitude, ground + AUTO_CLEARANCE);
    }
    this.autoAltitude = Math.max(this.autoAltitude, safeAltitude);

    if (this.keys.has('Space')) this.autoAltitude += FLY_VERTICAL_SPEED * dt;
    if (
      this.keys.has('ControlLeft') ||
      this.keys.has('ControlRight') ||
      this.keys.has('KeyC')
    ) {
      this.autoAltitude -= FLY_VERTICAL_SPEED * dt;
    }
    // 下降操作中でも、現在地と前方の地形に必要な余裕は割り込ませない。
    this.autoAltitude = Math.max(this.autoAltitude, safeAltitude);

    const speedScale = THREE.MathUtils.clamp(1 + fwd * 0.22, 0.62, 1.22);
    // タッチの「外周」は前へ倒したときだけ高速扱いにする。
    // 横へ旋回・後ろへ減速するために大きく倒しても、逆に加速させない。
    const autoBoost = Math.max(keyBoost, this.axisBoost * Math.max(0, fwd));
    // スティック前後は巡航の微調整、外周・Shift は高速飛行。
    // 両方を足してもストリーミングが追従できる上限を越えないようにする。
    const speed = THREE.MathUtils.clamp(
      FLY_CRUISE_SPEED * speedScale +
        (FLY_BOOST_SPEED - FLY_CRUISE_SPEED) * autoBoost,
      FLY_CRUISE_SPEED * 0.62,
      FLY_BOOST_SPEED,
    );
    const vertical = THREE.MathUtils.clamp(
      (this.autoAltitude - this.position.y) * 0.72,
      -18,
      FLY_VERTICAL_SPEED,
    );
    this.targetVelocity.set(-sy * speed, vertical, -cy * speed);
    this.velocity.lerp(this.targetVelocity, 1 - Math.exp(-2.8 * dt));
    this.position.addScaledVector(this.velocity, dt);
    this.keepAboveGround();
  }

  private keepAboveGround(): void {
    // 地面にめり込まないようにだけ押し戻す。
    const floor = this.groundAt(this.position.x, this.position.z) + 1.2;
    if (this.position.y < floor) this.position.y = floor;
    this.grounded = false;
  }

  private updateWalk(dt: number, fwd: number, side: number, boost: number, swimming: boolean): void {
    this.targetVelocity.set(0, 0, 0);
    if (fwd !== 0 || side !== 0) {
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      // 倒し具合をそのまま速度の割合にする。キー入力なら常に 1。
      const throttle = Math.min(1, Math.hypot(fwd, side));
      // 水平面だけを進む。見上げても足取りは変わらない。
      this.targetVelocity
        .set(-sy * fwd + cy * side, 0, -cy * fwd - sy * side)
        .normalize();
      const speed = swimming
        ? SWIM_SPEED
        : THREE.MathUtils.lerp(WALK_SPEED, SPRINT_SPEED, boost);
      this.targetVelocity.multiplyScalar(speed * throttle);
    }

    // 加減速をなめらかに。急に止まらない方が歩いている感じになる。
    const accel = 1 - Math.exp(-(this.grounded || swimming ? 11 : 3.5) * dt);
    this.velocity.x += (this.targetVelocity.x - this.velocity.x) * accel;
    this.velocity.z += (this.targetVelocity.z - this.velocity.z) * accel;

    const stepX = this.velocity.x * dt;
    const stepZ = this.velocity.z * dt;
    const groundHere = this.groundAt(this.position.x, this.position.z);
    const fromX = this.position.x;
    const fromZ = this.position.z;

    // X と Z を別々に判定すると、崖に当たっても壁沿いに滑れる。
    if (stepX !== 0) {
      const nx = this.position.x + stepX;
      const gh = this.groundAt(nx, this.position.z);
      if (gh - groundHere <= Math.abs(stepX) * MAX_CLIMB + 0.05) {
        this.position.x = nx;
      } else {
        this.velocity.x = 0;
      }
    }
    if (stepZ !== 0) {
      const nz = this.position.z + stepZ;
      const gh = this.groundAt(this.position.x, nz);
      if (gh - groundHere <= Math.abs(stepZ) * MAX_CLIMB + 0.05) {
        this.position.z = nz;
      } else {
        this.velocity.z = 0;
      }
    }

    const ground = this.groundAt(this.position.x, this.position.z);
    const moved = Math.hypot(this.position.x - fromX, this.position.z - fromZ);

    if (swimming) {
      // 海でも内陸湖でも、その場所の水面に浮かぶ。湖を海抜 0m と決め打ちすると、
      // 高い湖の底を歩いてしまう。
      const surface = this.waterSurfaceAt(this.position.x, this.position.z) + 0.35;
      this.position.y += (surface - this.position.y) * (1 - Math.exp(-6 * dt));
      this.verticalVelocity = 0;
      this.grounded = false;
      this.eyeOffset = EYE_HEIGHT;
      this.accumulateStep(moved, STRIDE_SWIM, 0.55);
      return;
    }

    const feetTarget = ground + this.eyeOffset;

    if (this.grounded) {
      const sprinting = boost > 0.45;
      this.accumulateStep(
        moved,
        THREE.MathUtils.lerp(STRIDE_WALK, STRIDE_SPRINT, boost),
        sprinting ? 1 : 0.72,
      );

      if (this.keys.has('Space')) {
        this.verticalVelocity = JUMP_SPEED;
        this.grounded = false;
        this.position.y += this.verticalVelocity * dt;
      } else {
        // 接地中は段差を吸収して、面の継ぎ目でガタつかせない。
        this.position.y += (feetTarget - this.position.y) * (1 - Math.exp(-16 * dt));
      }
    } else {
      this.verticalVelocity -= GRAVITY * dt;
      this.position.y += this.verticalVelocity * dt;
      if (this.position.y <= feetTarget) {
        // 落ちてきた勢いをそのまま着地音の大きさにする。
        const impact = Math.min(1, Math.abs(this.verticalVelocity) / 14);
        this.position.y = feetTarget;
        this.verticalVelocity = 0;
        this.grounded = true;
        this.stepDistance = 0;
        if (impact > 0.15) this.onLand?.(0.4 + impact * 0.6);
      }
    }
  }

  /** 歩いた距離を貯めて、歩幅ごとに 1 歩鳴らす。 */
  private accumulateStep(moved: number, stride: number, intensity: number): void {
    if (moved < 1e-4) return;
    this.stepDistance += moved;
    if (this.stepDistance < stride) return;
    this.stepDistance -= stride;
    this.onFootstep?.(intensity);
  }
}
