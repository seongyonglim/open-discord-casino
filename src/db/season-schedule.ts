/* 시즌 종료 예약.
 *
 * 시즌 전환은 지금까지 운영자가 버튼을 눌러야만 일어났다. 공지에 "8월 10일"이라고
 * 적어 두었으면 그 시각에 실제로 넘어가야 하는데, 사람이 자정에 깨어 있어야 한다는 뜻이
 * 되어서는 곤란하다.
 *
 * 이 서비스에는 서버 타이머가 없다(fly 가 유휴 시 프로세스를 통째로 재우기 때문이다).
 * 그래서 반복 개최와 같은 방식을 쓴다 — 예약 시각을 적어 두고, 요청이 들어올 때마다
 * "지났나"를 본다. 자정에 아무도 없으면 첫 접속에서 넘어간다.
 *
 * 늦게 넘어가는 것이 문제가 되는 자리가 하나 있다: 보상 금액이 시즌 번호로 정해지므로
 * (services/rewards), 전환이 밀린 사이에 출석한 사람은 옛 금액을 받는다. 그래서
 * 출석·지원금처럼 돈이 나가는 길에서도 이 함수를 먼저 부른다.
 */
import { one, run, all, tx } from './queries';
import { closeSeason } from './queries/season';

function settings(): Record<string, string> {
  const rows = all<{ key: string; value: string }>(`SELECT key, value FROM holdem_settings`);
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function put(key: string, value: string): void {
  run(`INSERT INTO holdem_settings (key, value, updated_at) VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key, value);
}

export interface SeasonSchedule {
  /** 이 시각(unix초)이 지나면 지금 시즌을 닫는다. 없으면 예약 없음. */
  closeAt: number | null;
  /** 다음 시즌 이름. 비우면 이름 없이 열린다. */
  nextName: string;  /** 다음 시즌 시작 잔액. 지금까지 0 이었고 그 값이 기본이다. */
  seed: number;
}

/* 마감 몇 초 전부터 '정산 중'으로 볼지.
   5분을 두는 이유: 이 서비스의 판은 전부 몇 초에서 몇십 초 안에 끝난다(가장 긴 그래프
   라운드도 1분 남짓). 5분이면 락다운 순간에 열려 있던 판이 전부 제 힘으로 끝날 시간이고,
   그래도 남은 것은 강제 정산한다. 더 짧게 두면 강제 정산에 걸리는 판이 늘고, 더 길게
   두면 아무 일도 없는 시간이 길어진다. */
export const LOCKDOWN_SEC = 5 * 60;

export interface SeasonLockdown {
  /** 지금이 마감 정산 구간인가 */
  active: boolean;
  /** 마감 예정 시각 (예약이 없으면 null) */
  closeAt: number | null;
  /** 마감까지 남은 초 */
  secondsLeft: number;
}

/**
 * 시즌 마감 직전 락다운 상태.
 *
 * 타이머를 두지 않는다 — fly 는 아무도 안 쓰면 프로세스를 재우므로 "5분 전에 무언가를
 * 실행"하는 방식은 이 서비스에서 성립하지 않는다. 대신 요청이 들어올 때마다 예약 시각과
 * 지금을 비교해 상태를 계산한다(반복 개최·시즌 마감도 같은 방식이다).
 *
 * 마감이 지나면 ensureSeasonClosed 가 시즌을 넘기고 예약을 지운다 → closeAt 이 null 이 되어
 * 락다운도 저절로 풀린다. 풀어 주는 코드를 따로 두지 않는 이유가 그것이다.
 */
export function seasonLockdown(now = Math.floor(Date.now() / 1000)): SeasonLockdown {
  const closeAt = getSeasonSchedule().closeAt;
  if (closeAt == null) return { active: false, closeAt: null, secondsLeft: 0 };
  return {
    active: now >= closeAt - LOCKDOWN_SEC,
    closeAt,
    secondsLeft: Math.max(0, closeAt - now),
  };
}

export function getSeasonSchedule(): SeasonSchedule {
  const v = settings();
  const at = Number(v.seasonCloseAt);
  return {
    closeAt: v.seasonCloseAt != null && Number.isFinite(at) && at > 0 ? Math.floor(at) : null,
    nextName: v.seasonNextName ?? '',    seed: Number.isFinite(Number(v.seasonNextSeed)) ? Math.floor(Number(v.seasonNextSeed)) : 0,
  };
}

export function saveSeasonSchedule(s: SeasonSchedule): { ok: true } | { ok: false; error: string } {
  if (s.closeAt != null && (!Number.isFinite(s.closeAt) || s.closeAt <= 0)) {
    return { ok: false, error: '종료 예약 시각이 올바르지 않습니다' };
  }
  if (!Number.isFinite(s.seed) || s.seed < 0 || Math.floor(s.seed) !== s.seed) {
    return { ok: false, error: '시작 잔액은 0 이상의 정수여야 합니다' };
  }
  return tx(() => {
    put('seasonCloseAt', s.closeAt == null ? '' : String(s.closeAt));
    put('seasonNextName', s.nextName.trim().slice(0, 40));    put('seasonNextSeed', String(s.seed));
    return { ok: true as const };
  });
}

export function clearSeasonSchedule(): void {
  put('seasonCloseAt', '');
}

/**
 * 예약 시각이 지났으면 시즌을 닫는다. 요청마다 불리므로 값싸고 조용해야 한다.
 *
 * 닫고 나면 예약을 지운다 — 남겨 두면 다음 시즌도 곧바로 닫힌다. 그 한 줄이 없으면
 * 요청 몇 번에 시즌이 연달아 넘어가고, 그때마다 전원의 잔액이 초기화된다.
 *
 * 넘어간 뒤에는 아무것도 안 한다(예약이 비어 있다). 다음 전환은 다시 예약해야 한다 —
 * 시즌 길이를 자동으로 정하지 않는 것은 의도한 것이다. 언제 끝낼지는 그때 정한다.
 */
export function ensureSeasonClosed(now = Math.floor(Date.now() / 1000)): void {
  const s = getSeasonSchedule();
  if (s.closeAt == null || now < s.closeAt) return;
  /* 열린 시즌이 없으면 닫을 것도 없다. 예약만 지운다 — 안 지우면 매 요청마다
     closeSeason 을 부르고 매번 실패한다. */
  const open = one<{ id: number }>(
    `SELECT id FROM seasons WHERE closed_at IS NULL ORDER BY number DESC LIMIT 1`);
  if (!open) { clearSeasonSchedule(); return; }
  const r = closeSeason({ seed: s.seed, nextName: s.nextName });
  /* 성공했을 때만 예약을 지운다. 실패(열린 시즌 없음)는 위에서 걸렀으므로 여기 오면
     성공이지만, 결과를 보지 않고 지우면 나중에 조건이 늘었을 때 조용히 건너뛴다. */
  if (r.ok) clearSeasonSchedule();
}
