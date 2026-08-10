/* 연승 같은 "이어지는 값".
 *
 * 전적(game_stats)과 다르다. 전적은 지나간 판을 세는 기록이고 이건 지금 이어지는
 * 중인 상태다 — 한 번 끊기면 0 으로 돌아간다. 랭킹에 섞이면 안 되므로 표를 따로 둔다.
 *
 * kind 로 나눠 담아서, 새 연승 과제가 생겨도 표를 더 만들지 않는다.
 */
import { one, run } from './queries';

export type StreakKind =
  /** 사다리 — 출발 «우»에만 걸어 이긴 연속 판수 (queries/ladder) */
  | 'ladder_right_win'
  /** 바카라 — «플레이어»에만 걸어 이긴 연속 판수 (queries/bacc) */
  | 'bacc_player_win';

export function getStreak(userId: string, kind: StreakKind): number {
  return one<{ value: number }>(
    `SELECT value FROM user_streaks WHERE user_id = ? AND kind = ?`, userId, kind)?.value ?? 0;
}

/** 하나 올리고 올린 값을 준다. */
export function bumpStreak(userId: string, kind: StreakKind): number {
  run(`INSERT INTO user_streaks (user_id, kind, value, updated_at) VALUES (?, ?, 1, unixepoch())
       ON CONFLICT(user_id, kind)
       DO UPDATE SET value = value + 1, updated_at = unixepoch()`, userId, kind);
  return getStreak(userId, kind);
}

/** 0 으로. 이미 0 이면 줄을 만들지 않는다 — 한 번도 안 이어진 사람의 빈 줄이 쌓일 이유가 없다. */
export function resetStreak(userId: string, kind: StreakKind): void {
  run(`UPDATE user_streaks SET value = 0, updated_at = unixepoch()
        WHERE user_id = ? AND kind = ? AND value != 0`, userId, kind);
}
