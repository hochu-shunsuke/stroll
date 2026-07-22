import * as THREE from 'three';
import { LOD_STEPS } from '../world/chunk';
import { SEA_LEVEL, type Terrain } from '../world/terrain';

/**
 * 目線の高さ。通信で送る y はこの高さの値なので、
 * 他人のアバターの身長もこれに合わせる必要がある。
 */
export const EYE_HEIGHT = 1.68;
const WALK_SPEED = 5.4;
const SPRINT_SPEED = 10.5;
const SWIM_SPEED = 3.2;
const FLY_SPEED = 26;
const GRAVITY = 26;
const JUMP_SPEED = 7.2;
/** 這い上がれる斜面の限界。水平 1 進む間に登れる高さ。 */
const MAX_CLIMB = 1.15;
/** 泳ぎに切り替わる水深。 */
const SWIM_DEPTH = 1.3;
/** 二度押しと見なす間隔（ミリ秒）。 */
const DOUBLE_TAP_MS = 280;
/** 一歩の歩幅。走ると大きく踏み出すので、足音は速くなりすぎない。 */
const STRIDE_WALK = 2.05;
const STRIDE_SPRINT = 3.2;
const STRIDE_SWIM = 1.5;

export class Player {
  readonly position = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  flying = false;

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
  private axisSprint = false;
  private terrain: Terrain;
  private groundStep = LOD_STEPS[0];

  constructor(terrain: Terrain, startX: number, startZ: number) {
    this.terrain = terrain;
    this.position.set(startX, this.groundAt(startX, startZ) + EYE_HEIGHT, startZ);
  }

  private groundAt(x: number, z: number): number {
    return this.terrain.heightOnGrid(x, z, this.groundStep);
  }

  onKey(code: string, down: boolean, repeat = false): void {
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
      const doubleTapped = now - prev < DOUBLE_TAP_MS;
      // 一度成立させたら記録を捨てる。三度押しで再発火させないため。
      this.lastTap.set(code, doubleTapped ? -Infinity : now);

      if (doubleTapped) {
        if (code === 'KeyW' || code === 'ArrowUp') this.sprinting = true;
        if (code === 'Space') this.toggleFly();
      }
      if (code === 'KeyF') this.toggleFly();
    }

    this.keys.add(code);
  }

  private toggleFly(): void {
    this.flying = !this.flying;
    this.verticalVelocity = 0;
    if (this.flying) {
      this.grounded = false;
    } else {
      // 飛行を切ると落下に移るので、横の勢いだけ残す。
      this.velocity.y = 0;
    }
  }

  /**
   * タッチのスティックを反映する。x が右、y が前。
   * 長さがそのまま速度の割合になるので、そっと歩くこともできる。
   */
  setMoveAxis(x: number, y: number, sprint: boolean): void {
    this.axisX = x;
    this.axisY = y;
    this.axisSprint = sprint;
  }

  clearKeys(): void {
    this.keys.clear();
    this.sprinting = false;
    this.lastTap.clear();
    this.axisX = 0;
    this.axisY = 0;
    this.axisSprint = false;
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

  /** 水に浸かっているか（UI と移動速度の切り替えに使う）。 */
  get swimming(): boolean {
    if (this.flying) return false;
    return this.groundAt(this.position.x, this.position.z) < SEA_LEVEL - SWIM_DEPTH;
  }

  update(dt: number, camera: THREE.PerspectiveCamera): void {
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

    if (this.flying) {
      this.updateFly(dt, fwd, side);
    } else {
      const sprint =
        this.sprinting || this.axisSprint || k.has('ShiftLeft') || k.has('ShiftRight');
      this.updateWalk(dt, fwd, side, sprint, swimming);
    }

    // 歩いている間だけ、視点をごくわずかに上下させる。
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (!this.flying && this.grounded && speed > 0.5) {
      this.bobPhase += dt * speed * 1.15;
    }
    const bob = this.flying ? 0 : Math.sin(this.bobPhase * 2) * 0.055;

    camera.position.set(
      this.position.x,
      this.position.y + bob,
      this.position.z,
    );
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  private updateFly(dt: number, fwd: number, side: number): void {
    const speed = FLY_SPEED * (this.sprinting ? 2.6 : 1);

    // 見ている方向にそのまま進む。上を向けば上がり、下を向けば下がる。
    // 左右移動だけは水平に保たないと、傾いたときに操作が読めなくなる。
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const dir = new THREE.Vector3(
      -sy * cp * fwd + cy * side,
      sp * fwd,
      -cy * cp * fwd - sy * side,
    );

    // 視線と関係なく真上・真下へ動きたいとき用。
    if (this.keys.has('Space')) dir.y += 1;
    if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.keys.has('KeyC')) {
      dir.y -= 1;
    }
    // 1 を超えた分だけ抑える。キー入力は常に 1 なので変わらないが、
    // スティックを半分だけ倒したときは半分の速さで飛ぶ。
    if (dir.lengthSq() > 1) dir.normalize();

    this.velocity.lerp(dir.multiplyScalar(speed), 1 - Math.exp(-8 * dt));
    this.position.addScaledVector(this.velocity, dt);

    // 地面にめり込まないようにだけ押し戻す。
    const floor = this.groundAt(this.position.x, this.position.z) + 1.2;
    if (this.position.y < floor) this.position.y = floor;
    this.grounded = false;
  }

  private updateWalk(dt: number, fwd: number, side: number, sprint: boolean, swimming: boolean): void {
    const target = new THREE.Vector3();
    if (fwd !== 0 || side !== 0) {
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      // 倒し具合をそのまま速度の割合にする。キー入力なら常に 1。
      const throttle = Math.min(1, Math.hypot(fwd, side));
      // 水平面だけを進む。見上げても足取りは変わらない。
      target.set(-sy * fwd + cy * side, 0, -cy * fwd - sy * side).normalize();
      const speed = swimming ? SWIM_SPEED : sprint ? SPRINT_SPEED : WALK_SPEED;
      target.multiplyScalar(speed * throttle);
    }

    // 加減速をなめらかに。急に止まらない方が歩いている感じになる。
    const accel = 1 - Math.exp(-(this.grounded || swimming ? 11 : 3.5) * dt);
    this.velocity.x += (target.x - this.velocity.x) * accel;
    this.velocity.z += (target.z - this.velocity.z) * accel;

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
      // 水面に浮かぶ。海底を歩かせない。
      const surface = SEA_LEVEL + 0.35;
      this.position.y += (surface - this.position.y) * (1 - Math.exp(-6 * dt));
      this.verticalVelocity = 0;
      this.grounded = false;
      this.eyeOffset = EYE_HEIGHT;
      this.accumulateStep(moved, STRIDE_SWIM, 0.55);
      return;
    }

    const feetTarget = ground + this.eyeOffset;

    if (this.grounded) {
      this.accumulateStep(moved, sprint ? STRIDE_SPRINT : STRIDE_WALK, sprint ? 1 : 0.72);

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
