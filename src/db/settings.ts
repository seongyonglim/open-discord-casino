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
import { rewards } from '../services/rewards';

export interface TournamentConfig {
  /* 자정으로부터의 분(0~1439). 시간만 받으면 22:30 같은 일정을 만들 수 없다. */
  regOpenMin: number;       // 등록이 열리는 시각 (KST)
  startMin: number;         // 시작 예정 시각 (KST)
  graceMin: number;         // 최소 인원을 기다리는 시간 (분). 시작 시각 이후로 잰다
  lateRegMin: number;       // 실제 시작 후 늦은 등록을 받는 시간 (분)
  startingStack: number;    // 시작 칩
  levelMin: number;         // 블라인드 상승 주기 (분)
  weekdayMultiplier: number;  // 상금 풀 = 등록자 수 × 배수
  weekendMultiplier: number;
  prizeFixed: number;       // 0보다 크면 인원과 무관하게 이 금액을 상금 풀로 쓴다
  /* 참가비 기본값. 0 이면 프리롤이고 그것이 기본이다.
     "참가 방식"을 따로 두지 않는 이유가 있다 — 방식과 금액을 각각 저장하면 둘이
     어긋나는 상태(바이인인데 0원, 프리롤인데 500원)가 생기고, 그때 어느 쪽을 믿을지
     아무도 모른다. 금액 하나만 두면 0 인가 아닌가로 방식이 저절로 정해진다. */
  buyIn: number;
}
/* 순위별 분배 비율은 여기서 다루지 않는다. ITM 인원(참가자의 30%)과 순위별 비중은
   검증된 산식이라 그대로 둔다 — 운영자가 고치는 것은 "풀의 크기"까지다. */

/**
 * 코드의 기본값. DB 에 아무것도 없을 때 이 값이 그대로 쓰인다.
 *
 * 프리롤 상금은 시즌마다 다르다 — services/rewards 의 표에서 그대로 가져온다.
 * 여기서 곱하지 않는다. 다른 값(칩·블라인드·시각)은 시즌과 무관하다. 그건 판의 모양이지
 * 보상이 아니다.
 *
 * 운영자가 [자동 개최 전용 템플릿]에서 값을 저장해 뒀다면 그 값이 이긴다 — 명시한 값을 코드가
 * 조용히 덮으면 안 된다. 다만 시즌이 올라 기본값이 커졌는데 저장된 값만 옛날에 머물러
 * 있으면 공지한 것과 실제가 어긋나므로, multiplierBehindSeason 이 그 사실을 알려 준다.
 */
export function defaultConfig(): TournamentConfig {
  const r = rewards();
  return {
    regOpenMin: T.REG_OPEN_HOUR * 60,
    startMin: T.START_HOUR * 60,
    graceMin: Math.round(T.GRACE_SEC / 60),
    lateRegMin: Math.round(T.LATE_REG_SEC / 60),
    startingStack: T.STARTING_STACK,
    levelMin: Math.round(T.LEVEL_DURATION_SEC / 60),
    weekdayMultiplier: r.freerollPerHead,
    weekendMultiplier: r.freerollPerHeadWeekend,
    prizeFixed: 0,
    buyIn: 0,
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
    /* 예전에는 시간 단위(regOpenHour)로 저장했다. 그 값이 남아 있으면 분으로 올려 읽는다 —
       설정을 다시 저장하지 않아도 예전과 같은 시각이 나와야 한다. */
    regOpenMin: numOf('regOpenMin', numOf('regOpenHour', d.regOpenMin / 60) * 60),
    startMin: numOf('startMin', numOf('startHour', d.startMin / 60) * 60),
    graceMin: numOf('graceMin', d.graceMin),
    lateRegMin: numOf('lateRegMin', d.lateRegMin),
    startingStack: numOf('startingStack', d.startingStack),
    levelMin: numOf('levelMin', d.levelMin),
    weekdayMultiplier: numOf('weekdayMultiplier', d.weekdayMultiplier),
    weekendMultiplier: numOf('weekendMultiplier', d.weekendMultiplier),
    prizeFixed: numOf('prizeFixed', d.prizeFixed),
    buyIn: numOf('buyIn', d.buyIn),
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

  const clock = (n: number) => int(n) && n >= 0 && n <= 23 * 60 + 59;
  if (!clock(c.regOpenMin)) bad.push('등록 시작 시각이 올바르지 않습니다');
  if (!clock(c.startMin)) bad.push('대회 시작 시각이 올바르지 않습니다');
  if (clock(c.regOpenMin) && clock(c.startMin) && c.regOpenMin >= c.startMin) {
    bad.push('등록 시작 시각은 대회 시작 시각보다 앞서야 합니다');
  }
  if (!int(c.graceMin) || c.graceMin <= 0) bad.push('대기 시간은 1분 이상이어야 합니다');
  if (clock(c.startMin) && int(c.graceMin) && c.startMin + c.graceMin > 24 * 60) {
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
  /* 참가비는 사람 잔액에서 실제로 빠져나가는 돈이다. 음수·소수가 여기를 지나면
     그대로 원장에 남는다. */
  if (!int(c.buyIn) || c.buyIn < 0) bad.push('참가비는 0 이상의 정수여야 합니다');
  return bad;
}

export function saveConfig(c: TournamentConfig): { ok: true } | { ok: false; errors: string[] } {
  const errors = validateConfig(c);
  if (errors.length) return { ok: false, errors };
  return tx(() => {
    const put = (k: string, v: string) =>
      run(`INSERT INTO holdem_settings (key, value, updated_at) VALUES (?, ?, unixepoch())
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, k, v);
    put('regOpenMin', String(c.regOpenMin));
    put('startMin', String(c.startMin));
    put('graceMin', String(c.graceMin));
    put('lateRegMin', String(c.lateRegMin));
    put('startingStack', String(c.startingStack));
    put('levelMin', String(c.levelMin));
    put('weekdayMultiplier', String(c.weekdayMultiplier));
    put('weekendMultiplier', String(c.weekendMultiplier));
    put('prizeFixed', String(c.prizeFixed));
    put('buyIn', String(c.buyIn));
    return { ok: true as const };
  });
}

/** 이 표에 함께 사는 열쇠들. 되돌리기가 건드릴 것과 아닌 것을 여기서 가른다. */
const CONFIG_KEYS = [
  'regOpenMin', 'startMin', 'graceMin', 'lateRegMin', 'startingStack', 'levelMin',
  'weekdayMultiplier', 'weekendMultiplier', 'prizeFixed', 'buyIn',
  // 예전 표기(시 단위). 남아 있으면 되돌린 뒤에도 그 값이 읽히므로 함께 지운다
  'regOpenHour', 'startHour',
];

/**
 * 템플릿을 코드 기본값으로 되돌린다.
 *
 * 열쇠를 하나씩 지운다. 예전에는 `DELETE FROM holdem_settings` 로 표를 통째로 비웠는데,
 * 그 표에는 반복 개최 설정(recurEnabled·recurMode…)과 "어느 차례까지 만들었는가"
 * (recurLastAt)도 함께 산다. 그래서 [기본값으로]를 한 번 누르면
 *   · 켜 두었던 반복 개최가 조용히 꺼지고,
 *   · 이미 만든 차례의 표시가 사라져 지웠던 대회가 다시 만들어졌다.
 * 두 번째가 특히 나쁘다 — 되살아남을 막으려고 둔 장치가 관계없는 버튼에 풀렸다.
 */
export function resetConfig(): void {
  return tx(() => {
    for (const k of CONFIG_KEYS) run(`DELETE FROM holdem_settings WHERE key = ?`, k);
  });
}

/**
 * 시즌의 기본 상금이 올랐는데 저장된 값만 그 아래에 멈춰 있는가.
 *
 * 운영자가 명시한 값은 코드가 덮지 않는다(그게 옳다). 다만 시즌 1이 열려 기본 상금이
 * 올랐는데 저장된 값이 오픈베타 시절 그대로면, 공지한 것과 실제가 어긋난다.
 * 조용히 어긋나 있는 것이 제일 나쁘므로 화면이 이 사실을 띄운다.
 */
export function multiplierBehindSeason(): { behind: true; now: number; expected: number } | null {
  const v = raw();
  if (v.weekdayMultiplier == null) return null;      // 저장된 값이 없으면 기본값이 그대로 쓰인다
  const now = Number(v.weekdayMultiplier);
  const expected = rewards().freerollPerHead;
  if (!Number.isFinite(now) || now >= expected) return null;
  return { behind: true, now, expected };
}

/** 아직 시작하지 않은 대회가 있으면 그 행에도 새 설정을 반영한다(다음 대회 = 아직 안 연 판). */
export function pendingTournamentCount(): number {
  return one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM holdem_tournaments
      WHERE started_at IS NULL AND cancelled_at IS NULL`)!.n;
}
