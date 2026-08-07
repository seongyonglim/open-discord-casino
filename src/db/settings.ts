/* 대회 운영 설정.
 *
 * 코드에 박혀 있던 값을 운영자가 고칠 수 있게 한다. 규칙은 둘이다.
 *
 *   1. 값이 없으면 코드의 기본값을 쓴다. DB 가 비어 있어도, 새 항목을 추가한 직후에도
 *      서버는 예전과 똑같이 동작해야 한다.
 *   2. 바꾼 값은 "다음에 만들어질 대회"부터 적용된다. 진행 중인 대회는 만들어질 때의
 *      값을 자기 행에 갖고 있고 그것만 본다 — 여기 값을 바꿔도 블라인드가 뛰거나
 *      늦게 온 사람만 다른 스택을 받는 일이 생기지 않는다.
 *
 * 검증은 여기서 한다. 화면에서만 막으면 API 를 직접 부르는 순간 뚫린다.
 */
import { one, all, run, tx } from './queries';
import * as T from '../services/tournament';

export interface TournamentConfig {
  regOpenHour: number;      // 등록이 열리는 시각 (KST, 0~23)
  startHour: number;        // 시작 예정 시각 (KST, 0~23)
  graceMin: number;         // 최소 인원을 기다리는 시간 (분). 시작 시각 이후로 잰다
  lateRegMin: number;       // 실제 시작 후 늦은 등록을 받는 시간 (분)
  startingStack: number;    // 시작 칩
  levelMin: number;         // 블라인드 상승 주기 (분)
  weekdayMultiplier: number;  // 상금 풀 = 등록자 수 × 배수
  weekendMultiplier: number;
  prizeFixed: number;       // 0보다 크면 인원과 무관하게 이 금액을 상금 풀로 쓴다
}
/* 순위별 분배 비율은 여기서 다루지 않는다. ITM 인원(참가자의 30%)과 순위별 비중은
   검증된 산식이라 그대로 둔다 — 운영자가 고치는 것은 "풀의 크기"까지다. */

/** 코드의 기본값. DB 에 아무것도 없을 때 이 값이 그대로 쓰인다. */
export function defaultConfig(): TournamentConfig {
  return {
    regOpenHour: T.REG_OPEN_HOUR,
    startHour: T.START_HOUR,
    graceMin: Math.round(T.GRACE_SEC / 60),
    lateRegMin: Math.round(T.LATE_REG_SEC / 60),
    startingStack: T.STARTING_STACK,
    levelMin: Math.round(T.LEVEL_DURATION_SEC / 60),
    weekdayMultiplier: T.WEEKDAY_MULTIPLIER,
    weekendMultiplier: T.WEEKEND_MULTIPLIER,
    prizeFixed: 0,
  };
}

function raw(): Record<string, string> {
  const rows = all<{ key: string; value: string }>(`SELECT key, value FROM holdem_settings`);
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function getConfig(): TournamentConfig {
  const d = defaultConfig();
  const v = raw();
  const numOf = (k: string, fallback: number) => {
    const n = Number(v[k]);
    return v[k] != null && Number.isFinite(n) ? n : fallback;
  };
  return {
    regOpenHour: numOf('regOpenHour', d.regOpenHour),
    startHour: numOf('startHour', d.startHour),
    graceMin: numOf('graceMin', d.graceMin),
    lateRegMin: numOf('lateRegMin', d.lateRegMin),
    startingStack: numOf('startingStack', d.startingStack),
    levelMin: numOf('levelMin', d.levelMin),
    weekdayMultiplier: numOf('weekdayMultiplier', d.weekdayMultiplier),
    weekendMultiplier: numOf('weekendMultiplier', d.weekendMultiplier),
    prizeFixed: numOf('prizeFixed', d.prizeFixed),
  };
}

/**
 * 검증. 화면이 아니라 여기가 마지막 문이다.
 *
 * 시각의 선후는 반드시 지켜져야 한다: 등록 열림 < 시작 < 대기 마감.
 * 대기 마감은 시작 시각에 graceMin 을 더해 만들어지므로 graceMin > 0 이면 성립한다.
 * 자정을 넘기는 일정(예: 등록 23시, 시작 0시)은 막는다 — date_str 하나로 하루를 묶는
 * 구조라 시작이 다음 날로 넘어가면 어느 날의 대회인지가 어긋난다.
 */
export function validateConfig(c: TournamentConfig): string[] {
  const bad: string[] = [];
  const int = (n: number) => Number.isFinite(n) && Math.floor(n) === n;
  const hour = (n: number) => int(n) && n >= 0 && n <= 23;

  if (!hour(c.regOpenHour)) bad.push('등록 시작 시각은 0~23 사이의 정수여야 합니다');
  if (!hour(c.startHour)) bad.push('대회 시작 시각은 0~23 사이의 정수여야 합니다');
  if (hour(c.regOpenHour) && hour(c.startHour) && c.regOpenHour >= c.startHour) {
    bad.push('등록 시작 시각은 대회 시작 시각보다 앞서야 합니다');
  }
  if (!int(c.graceMin) || c.graceMin <= 0) bad.push('대기 시간은 1분 이상이어야 합니다');
  if (hour(c.startHour) && int(c.graceMin) && c.startHour * 60 + c.graceMin > 24 * 60) {
    bad.push('대기 마감이 자정을 넘습니다 — 하루에 대회 하나라는 구조가 어긋납니다');
  }
  if (!int(c.lateRegMin) || c.lateRegMin <= 0) bad.push('레이트 레지 시간은 1분 이상이어야 합니다');
  if (!int(c.startingStack) || c.startingStack <= 0) bad.push('시작 칩은 1 이상이어야 합니다');
  if (!int(c.levelMin) || c.levelMin <= 0) bad.push('블라인드 주기는 1분 이상이어야 합니다');
  for (const [k, label] of [['weekdayMultiplier', '평일 배수'], ['weekendMultiplier', '주말 배수']] as const) {
    const n = c[k];
    if (!int(n) || n < 0) bad.push(`${label}는 0 이상의 정수여야 합니다`);
  }
  if (!int(c.prizeFixed) || c.prizeFixed < 0) bad.push('고정 상금 풀은 0 이상의 정수여야 합니다');
  return bad;
}

export function saveConfig(c: TournamentConfig): { ok: true } | { ok: false; errors: string[] } {
  const errors = validateConfig(c);
  if (errors.length) return { ok: false, errors };
  return tx(() => {
    const put = (k: string, v: string) =>
      run(`INSERT INTO holdem_settings (key, value, updated_at) VALUES (?, ?, unixepoch())
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, k, v);
    put('regOpenHour', String(c.regOpenHour));
    put('startHour', String(c.startHour));
    put('graceMin', String(c.graceMin));
    put('lateRegMin', String(c.lateRegMin));
    put('startingStack', String(c.startingStack));
    put('levelMin', String(c.levelMin));
    put('weekdayMultiplier', String(c.weekdayMultiplier));
    put('weekendMultiplier', String(c.weekendMultiplier));
    put('prizeFixed', String(c.prizeFixed));
    return { ok: true as const };
  });
}

/** 설정을 전부 지워 코드 기본값으로 되돌린다. */
export function resetConfig(): void {
  run(`DELETE FROM holdem_settings`);
}

/** 아직 시작하지 않은 대회가 있으면 그 행에도 새 설정을 반영한다(다음 대회 = 아직 안 연 판). */
export function pendingTournamentCount(): number {
  return one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM holdem_tournaments
      WHERE started_at IS NULL AND cancelled_at IS NULL`)!.n;
}
