import * as THREE from 'three';

const VIEWPORT_MARGIN_X = 0.08;
const VIEWPORT_MARGIN_Y = 0.12;
/** この距離なら、視界内では鳥の頭上にある名前だけで十分。 */
export const NEAR_FRIEND_HUD_DISTANCE = 70;
export const VERTICAL_CUE_MINIMUM = 12;

export interface FriendPosition {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  /** 省略時は友達。光の輪だけ見た目を区別する。 */
  kind?: 'destination';
}

export type FriendIndicatorMode = 'near' | 'onscreen' | 'offscreen';

export interface FriendIndicator {
  id: string;
  name: string;
  /** 水平面上の距離。高さは verticalDifference で別に伝える。 */
  distance: number;
  verticalDifference: number;
  mode: FriendIndicatorMode;
  /** 画面中心を 0、右・下を正とした正規化座標。 */
  directionX: number;
  directionY: number;
  /** 上向き矢印を画面中心から外へ向ける角度（rad）。 */
  rotation: number;
  kind?: 'destination';
}

const targetWorld = new THREE.Vector3();
const projected = new THREE.Vector3();
const toTarget = new THREE.Vector3();
const cameraRight = new THREE.Vector3();
const cameraUp = new THREE.Vector3();
const cameraForward = new THREE.Vector3();

/**
 * 友達の3D位置を、実際のカメラへ投影する。
 *
 * 視界内なら対象の画面上の位置をそのまま返し、画面外だけ端ナビへ回す。
 * 高さ差は方角へ混ぜず、別の数値として保持する。
 */
export function friendIndicators(
  camera: THREE.Camera,
  origin: { x: number; y: number; z: number },
  friends: readonly FriendPosition[],
): FriendIndicator[] {
  camera.updateMatrixWorld();
  cameraRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  cameraUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
  cameraForward.set(0, 0, -1).applyQuaternion(camera.quaternion);

  return friends
    .map((friend) => {
      const dx = friend.x - origin.x;
      const dy = friend.y - origin.y;
      const dz = friend.z - origin.z;
      const distance = Math.hypot(dx, dz);

      targetWorld.set(friend.x, friend.y, friend.z);
      toTarget.copy(targetWorld).sub(camera.position);
      const length = toTarget.length();
      if (length > 0) toTarget.multiplyScalar(1 / length);

      const viewX = toTarget.dot(cameraRight);
      const viewY = toTarget.dot(cameraUp);
      const viewForward = toTarget.dot(cameraForward);
      const inFront = viewForward > 0.001;

      projected.copy(targetWorld).project(camera);
      const onscreen =
        inFront &&
        projected.x >= -1 + VIEWPORT_MARGIN_X &&
        projected.x <= 1 - VIEWPORT_MARGIN_X &&
        projected.y >= -1 + VIEWPORT_MARGIN_Y &&
        projected.y <= 1 - VIEWPORT_MARGIN_Y;

      let mode: FriendIndicatorMode;
      let directionX: number;
      let directionY: number;
      if (onscreen) {
        mode =
          friend.kind !== 'destination' && Math.hypot(dx, dy, dz) < NEAR_FRIEND_HUD_DISTANCE
            ? 'near'
            : 'onscreen';
        directionX = projected.x;
        directionY = -projected.y;
      } else {
        mode = 'offscreen';
        if (inFront && Number.isFinite(projected.x) && Number.isFinite(projected.y)) {
          directionX = projected.x;
          directionY = -projected.y;
        } else {
          // 真後ろは射影が反転する。カメラの右・上成分で左右を保ちつつ、
          // 後方であることを下端として補う。
          directionX = viewX;
          directionY = -viewY + 0.32;
        }
        if (Math.hypot(directionX, directionY) < 0.04) {
          directionX = 0;
          directionY = 1;
        }
      }

      return {
        id: friend.id,
        name: friend.name,
        distance,
        verticalDifference: dy,
        mode,
        directionX,
        directionY,
        rotation: Math.atan2(directionX, -directionY),
        ...(friend.kind ? { kind: friend.kind } : {}),
      };
    })
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name, 'ja'));
}

export function formatFriendDistance(distance: number, compact = false): string {
  const metres = Math.max(0, distance);
  const gap = compact ? '' : ' ';
  if (metres < 1_000) return `${Math.round(metres)}${gap}m`;
  if (metres < 10_000) return `${(metres / 1_000).toFixed(1)}${gap}km`;
  return `${Math.round(metres / 1_000)}${gap}km`;
}

export function formatVerticalDifference(difference: number, compact = false): string {
  if (Math.abs(difference) < VERTICAL_CUE_MINIMUM) return '';
  const gap = compact ? '' : ' ';
  return `${difference > 0 ? '↑' : '↓'}${gap}${Math.round(Math.abs(difference))}${gap}m`;
}
