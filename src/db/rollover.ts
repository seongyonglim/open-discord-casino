/* 프리롤 이월 — 열리지 못한 회차의 상금을 다음 회차로 넘긴다.
 *
 * ── 무엇을 넘기는가
 * 금액이 아니라 "몇 번 밀렸는가"를 센다. 프리롤 상금은 인당 배수 × 참가자 수라서,
 * 취소된 회차에는 참가자가 두 명일 수도 없을 수도 있다. 그때 배정됐던 금액을 그대로
 * 넘기면 아무도 신청 안 한 날은 0P 가 쌓여, 정작 사람이 안 모여서 못 연 판일수록
 * 다음 판이 초라해진다 — 이월을 두는 이유와 정반대다.
 *
 * 그래서 배수를 곱한다. 세 번 밀렸으면 다음 판은 인당 네 배다.
 *
 *   인당 5,000P 짜리 프리롤이 3일 연속 못 열림 → 4일째 인당 20,000P
 *
 * 사람에게 설명하기도 이 쪽이 쉽다("3일 밀렸으니 4배"). 참가자 수와 무관해서
 * 취소된 날 누가 신청했는지 따질 필요도 없다.
 *
 * ── 왜 상한을 두는가
 * 배수는 서비스가 새로 발행하는 포인트다(프리롤은 참가비가 없다). 상한이 없으면
 * 대회를 한 달 안 열었을 때 인당 상금이 서른 배가 되고, 그 판 하나가 시즌의 잔액
 * 분포를 통째로 바꾼다. 다섯 배에서 멈춘다 — 그 이상은 "밀렸다"가 아니라 운영을
 * 안 한 것이고, 그건 이월로 갚을 일이 아니다.
 *
 * ── 언제 늘고 언제 0 이 되는가
 *   늘어난다: 시작 시각 + 유예까지 최소 인원이 안 차서 자동 취소될 때만.
 *             운영자가 손으로 접은 판은 세지 않는다 — 실수로 연 판을 접을 때마다
 *             이월이 쌓이면 그건 이월이 아니라 사고다.
 *   0 이 된다: 대회가 정상적으로 끝나 상금이 지급됐을 때.
 *
 * ── 참가비 대회는 해당 없다
 * 걷은 돈이 곧 상금이라 서비스가 얹는 배수가 없다. 이월할 것이 없다.
 */
import { all, run } from './queries';

/** 이월 배수의 상한. 기본 1배(이월 없음) 위로 네 번까지만 쌓인다. */
export const ROLLOVER_MAX = 5;

const KEY = 'rolloverSkips';

function raw(): number {
  const rows = all<{ value: string }>(
    `SELECT value FROM holdem_settings WHERE key = ?`, KEY);
  const n = Math.floor(Number(rows[0]?.value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 지금까지 밀린 횟수. 0 이면 이월이 없다. */
export function rolloverSkips(): number {
  return Math.min(raw(), ROLLOVER_MAX - 1);
}

/** 다음 판에 걸릴 배수. 밀린 적이 없으면 1 이다. */
export function rolloverFactor(): number {
  return 1 + rolloverSkips();
}

/** 최소 인원 미달로 자동 취소됐을 때 한 칸 올린다. 상한을 넘으면 그대로 둔다. */
export function bumpRollover(): number {
  const next = Math.min(raw() + 1, ROLLOVER_MAX - 1);
  put(next);
  return next;
}

/** 대회가 정상적으로 끝나 상금이 나갔다 — 다음 판은 다시 제 값이다. */
export function clearRollover(): void {
  put(0);
}

/**
 * 운영자가 값을 직접 맞춘다.
 *
 * 평소에는 서버가 알아서 센다. 이 길이 필요한 경우는 하나뿐이다 — 이 기능이 생기기
 * 전에 이미 못 열린 회차가 있을 때. 서버는 그것을 모르므로 사람이 알려 줘야 한다.
 * 상한은 여기서도 지킨다: 화면이 막아도 API 를 직접 부르면 뚫리기 때문이다.
 */
export function setRollover(skips: number): void {
  put(Math.min(Math.max(0, Math.floor(skips)), ROLLOVER_MAX - 1));
}

function put(n: number): void {
  run(`INSERT INTO holdem_settings (key, value, updated_at) VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    KEY, String(Math.max(0, Math.floor(n))));
}

/**
 * 이 대회에 걸릴 인당 금액.
 *
 * 참가비 대회에는 이월이 없다 — 걷은 돈이 상금이라 서비스가 얹는 배수가 없다.
 * 보장 상금(prize_fixed)만 있는 판도 마찬가지다: 배수가 0 이면 곱해도 0 이다.
 */
export function rolledMultiplier(t: { prize_multiplier: number; buy_in: number }): number {
  if (t.buy_in > 0) return Math.max(0, Math.floor(t.prize_multiplier));
  return Math.max(0, Math.floor(t.prize_multiplier)) * rolloverFactor();
}
