export interface FriendPosition {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
}

export interface FriendEdgeIndicator {
  id: string;
  name: string;
  /** プレイヤーからの直線距離（m）。 */
  distance: number;
  /** 画面中心から見た向き。x は右、y は下が正。 */
  directionX: number;
  directionY: number;
  /** 上向き矢印を画面中心から外へ向ける角度（rad）。 */
  rotation: number;
}

/**
 * 友達への3次元の向きを、画面のどの端へ出すかに変換する。
 *
 * 左右・上下はカメラに対する見かけの位置を優先する。真正面／真後ろは
 * 画面上のずれがゼロになるため、前方を上端、後方を下端として補う。
 * forward を少しだけ上下へ混ぜることで、右後方は右端寄りのまま、
 * 前方・後方の違いも端上の位置から読める。
 */
export function friendEdgeIndicators(
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
  friends: readonly FriendPosition[],
): FriendEdgeIndicator[] {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);

  return friends
    .map((friend) => {
      const dx = friend.x - x;
      const dy = friend.y - y;
      const dz = friend.z - z;
      const distance = Math.hypot(dx, dy, dz);
      const inverseDistance = distance > 0 ? 1 / distance : 0;
      const nx = dx * inverseDistance;
      const ny = dy * inverseDistance;
      const nz = dz * inverseDistance;

      // カメラの右・上・前ベクトルへ射影する（roll は小さい演出なので無視）。
      const right = nx * cy - nz * sy;
      const up = nx * sy * sp + ny * cp + nz * cy * sp;
      const forward = nx * -sy * cp + ny * sp + nz * -cy * cp;

      let directionX = right;
      let directionY = -up - forward * 0.28;
      if (Math.hypot(directionX, directionY) < 0.04) {
        directionX = 0;
        directionY = forward >= 0 ? -1 : 1;
      }

      return {
        id: friend.id,
        name: friend.name,
        distance,
        directionX,
        directionY,
        rotation: Math.atan2(directionX, -directionY),
      };
    })
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name, 'ja'));
}

export function formatFriendDistance(distance: number): string {
  const metres = Math.max(0, distance);
  if (metres < 1_000) return `${Math.round(metres)} m`;
  if (metres < 10_000) return `${(metres / 1_000).toFixed(1)} km`;
  return `${Math.round(metres / 1_000)} km`;
}
