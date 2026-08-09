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
  nextName: string;
  nextReward: string;
  /** 다음 시즌 시작 잔액. 지금까지 0 이었고 그 값이 기본이다. */
  seed: number;
}

export function getSeasonSchedule(): SeasonSchedule {
  const v = settings();
  const at = Number(v.seasonCloseAt);
  return {
    closeAt: v.seasonCloseAt != null && Number.isFinite(at) && at > 0 ? Math.floor(at) : null,
    nextName: v.seasonNextName ?? '',
    nextReward: v.seasonNextReward ?? '',
    seed: Number.isFinite(Number(v.seasonNextSeed)) ? Math.floor(Number(v.seasonNextSeed)) : 0,
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
    put('seasonNextName', s.nextName.trim().slice(0, 40));
    put('seasonNextReward', s.nextReward.trim().slice(0, 200));
    put('seasonNextSeed', String(s.seed));
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
  const r = closeSeason({ seed: s.seed, nextName: s.nextName, nextReward: s.nextReward });
  /* 성공했을 때만 예약을 지운다. 실패(열린 시즌 없음)는 위에서 걸렀으므로 여기 오면
     성공이지만, 결과를 보지 않고 지우면 나중에 조건이 늘었을 때 조용히 건너뛴다. */
  if (r.ok) clearSeasonSchedule();
}
