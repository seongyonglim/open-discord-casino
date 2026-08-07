/* 토너먼트 엔진 — 일정, 상태 판정, 블라인드 구조, 상금 배분.
 *
 * 홀덤 규칙은 여기 없다(services/holdem.ts). 이 파일은 카드를 모른다.
 * 스펙 9항의 "Tournament Engine과 Hold'em Engine의 완전 분리"가 이 경계다.
 *
 * 서버 타이머를 하나도 쓰지 않는다. 상태·블라인드 레벨·마감 시각을 전부
 * "지금 몇 시인가"에서 계산해 낸다. 이 서버는 접속이 없으면 절전에 들어가므로
 * 타이머를 걸어두면 잠든 사이에 죽는다 — 기존 게임 다섯 개가 모두 이 방식이다.
 */

/* ── 한국 시간 ───────────────────────────────────────────────────────
   토너먼트 시각(21:00 등록 / 22:00 시작)은 KST 기준이다. 서버는 UTC로 돌아간다.
   출석 체크가 쓰는 방식(Intl + Asia/Seoul)을 그대로 따른다 — 직접 +9시간을
   더하면 나중에 서버 로케일이 바뀌었을 때 조용히 어긋난다. */

/** KST 기준 'YYYY-MM-DD' */
export function kstDateStr(ms: number): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

/** KST 기준 요일 (0=일 … 6=토) */
export function kstWeekday(ms: number): number {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short' })
    .format(new Date(ms));
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(s);
}

export function isKstWeekend(ms: number): boolean {
  const d = kstWeekday(ms);
  return d === 0 || d === 6;
}

/** KST 기준 그 날짜의 특정 시각(시:분)을 unix초로. 서머타임이 없는 지역이라 안전하다. */
export function kstTimeToUnix(dateStr: string, hour: number, minute: number): number {
  // 'YYYY-MM-DDTHH:MM:00+09:00' 은 Date가 표준으로 해석한다
  const hh = String(hour).padStart(2, '0'), mm = String(minute).padStart(2, '0');
  return Math.floor(new Date(`${dateStr}T${hh}:${mm}:00+09:00`).getTime() / 1000);
}

/* ── 일정 ────────────────────────────────────────────────────────────
   하루에 토너먼트 하나. 평일은 배수 1,000P · 주말은 2,000P.
   등록 21:00 · 예정 시작 22:00 · 최소 인원 대기 마감 23:00. */
export const REG_OPEN_HOUR = 21;
export const START_HOUR = 22;
export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 9;
/* 최소 인원이 안 채워졌을 때 기다리는 시간.
   20분(22:20 마감)이었는데 너무 짧았다. 3명은 커뮤니티 규모에 비하면 낮은 문턱인데도
   22시 정각에 모이지 못하면 20분 만에 판이 없어졌다 — 늦게 들어온 사람은 "오늘은
   이미 끝났다"만 보게 된다. 한 시간을 주면 22시를 놓쳐도 그날 안에 합류할 수 있다. */
export const GRACE_SEC = 60 * 60;
/** 실제 시작 시각부터 이 시간까지 늦은 등록 허용 */
export const LATE_REG_SEC = 24 * 60;
export const STARTING_STACK = 10_000;

export const WEEKDAY_MULTIPLIER = 1_000;
export const WEEKEND_MULTIPLIER = 2_000;

/* 판이 끝난 뒤에도 테이블을 계속 보여 주는 시간.
   마지막 판의 쇼다운을 끝까지 보여주고, 그 다음 우승 화면을 띄우기 위한 창이다.
   우승 화면은 정산 연출이 끝나야 뜨는데(칩이 승자에게 흡수되기 전에 띄우면 결과를
   먼저 알려 주는 스포일러가 된다), 9인 다인 올인 쇼다운의 정산은 30초를 넘길 수 있다:
   패 공개 5.1초 + 보드 12.02초 + 정산 꼬리 6.35초 + 사이드 팟마다 2.9초.
   그래서 30초로는 연출이 창을 다 먹고 우승 화면이 나올 자리가 없었다. 넉넉히 준다 —
   이 시간이 지나면 화면이 대회를 떠난다. 여기가 db 계층과 web 계층이 함께 쓰는 값이라
   순수 계산 쪽에 둔다(db가 web을 가져오는 방향은 만들지 않는다). */
export const FINISH_LINGER_SEC = 120;

export interface TournamentSchedule {
  /** KST 날짜 — 하루 하나라는 규칙의 키가 된다 */
  dateStr: string;
  regOpenAt: number;
  scheduledStartAt: number;
  /** 최소 인원 대기 마감 (이 시각까지 3명이 안 되면 취소) */
  graceEndsAt: number;
  weekend: boolean;
  prizeMultiplier: number;
  title: string;
}

/** 운영자가 고칠 수 있는 일정 값. 안 주면 이 파일의 기본값을 쓴다. */
export interface ScheduleOverrides {
  /* 자정으로부터의 분(0~1439). 시간만 받으면 22:30 같은 일정을 못 만든다. */
  regOpenMin?: number; startMin?: number; graceSec?: number;
  weekdayMultiplier?: number; weekendMultiplier?: number;
}

export function scheduleForDate(dateStr: string, o: ScheduleOverrides = {}): TournamentSchedule {
  // 요일 판정은 그 날짜의 정오를 기준으로 한다 — 자정 경계에서 흔들리지 않는다
  const noon = kstTimeToUnix(dateStr, 12, 0);
  const weekend = isKstWeekend(noon * 1000);
  const sm = o.startMin ?? START_HOUR * 60;
  const rm = o.regOpenMin ?? REG_OPEN_HOUR * 60;
  const scheduledStartAt = kstTimeToUnix(dateStr, Math.floor(sm / 60), sm % 60);
  return {
    dateStr,
    regOpenAt: kstTimeToUnix(dateStr, Math.floor(rm / 60), rm % 60),
    scheduledStartAt,
    graceEndsAt: scheduledStartAt + (o.graceSec ?? GRACE_SEC),
    weekend,
    prizeMultiplier: weekend
      ? (o.weekendMultiplier ?? WEEKEND_MULTIPLIER)
      : (o.weekdayMultiplier ?? WEEKDAY_MULTIPLIER),
    title: weekend ? '주말 더블 프리롤' : '데일리 프리롤',
  };
}

/* ── 상태 ────────────────────────────────────────────────────────────
   전부 시각에서 유도한다. 저장하는 것은 "되돌릴 수 없는 사실" 셋뿐이다:
   실제 시작 시각(started_at), 종료 시각(finished_at), 취소 여부(cancelled_at).
   나머지는 계산이다 — 그래야 서버가 잠들어 있었어도 깨어나서 올바른 상태를 낸다. */
export type TournamentStatus =
  | 'SCHEDULED' | 'REGISTRATION_OPEN' | 'WAITING_MIN_PLAYERS'
  | 'RUNNING' | 'FINISHED' | 'CANCELLED';

export interface TournamentFacts {
  startedAt: number | null;
  finishedAt: number | null;
  cancelledAt: number | null;
}

export function statusAt(
  now: number, s: TournamentSchedule, f: TournamentFacts, registeredCount: number
): TournamentStatus {
  if (f.finishedAt != null) return 'FINISHED';
  if (f.cancelledAt != null) return 'CANCELLED';
  if (f.startedAt != null) return 'RUNNING';
  if (now < s.regOpenAt) return 'SCHEDULED';
  if (now < s.scheduledStartAt) return 'REGISTRATION_OPEN';
  // 예정 시각이 지났다 — 인원이 차면 시작, 아니면 20분까지 대기, 그래도 안 차면 취소
  if (registeredCount >= MIN_PLAYERS) return 'RUNNING';
  if (now < s.graceEndsAt) return 'WAITING_MIN_PLAYERS';
  return 'CANCELLED';
}

/** 지금 등록할 수 있나. 늦은 등록은 "빈자리가 있을 때만" 허용된다(스펙 3항). */
export function canRegister(
  now: number, s: TournamentSchedule, f: TournamentFacts,
  registeredCount: number, seatedCount: number, lateRegSec = LATE_REG_SEC
): { ok: true } | { ok: false; reason: 'not_open' | 'late_reg_closed' | 'table_full' | 'closed' } {
  const st = statusAt(now, s, f, registeredCount);
  if (st === 'FINISHED' || st === 'CANCELLED') return { ok: false, reason: 'closed' };
  if (st === 'SCHEDULED') return { ok: false, reason: 'not_open' };
  if (st === 'REGISTRATION_OPEN' || st === 'WAITING_MIN_PLAYERS') {
    return seatedCount >= MAX_PLAYERS ? { ok: false, reason: 'table_full' } : { ok: true };
  }
  // RUNNING — 늦은 등록 창 안이고 자리가 남아 있어야 한다
  if (f.startedAt == null) return { ok: false, reason: 'closed' };
  if (now >= f.startedAt + lateRegSec) return { ok: false, reason: 'late_reg_closed' };
  if (seatedCount >= MAX_PLAYERS) return { ok: false, reason: 'table_full' };
  return { ok: true };
}

/** 늦은 등록 남은 시간(초). 창이 닫혔거나 아직 시작 전이면 null. */
/* sec 인자는 그 대회가 만들어질 때 박아 둔 값이다. 안 주면 코드 기본값을 쓴다 —
   설정이 없던 시절에 만들어진 대회도 예전과 똑같이 동작해야 한다. */
export function lateRegLeft(now: number, f: TournamentFacts, sec = LATE_REG_SEC): number | null {
  if (f.startedAt == null) return null;
  const left = f.startedAt + sec - now;
  return left > 0 ? left : null;
}

/* ── 블라인드 구조 ───────────────────────────────────────────────────
   8분씩 16단계. 스펙의 예시(Level 3 = 75/150 Ante 0)와 맞춰 뒀다.

   11단계까지만 두었을 때의 문제: 거기서 블라인드가 멈추므로, 스택이 비슷한 둘이
   남으면 판이 끝나지 않는다. 11레벨(1000/2000 + 앤티 250)에서 9인 총 칩 90,000 은
   한 바퀴 5,250 으로 빠르게 녹지만, 남은 사람이 둘이면 한 바퀴에 3,500 뿐이라
   90,000 을 다 태우는 데 스물여섯 바퀴가 걸린다 — 헤즈업이 한없이 늘어진다.

   그래서 16단계까지 잇는다. 12단계부터는 배수를 키운다(1.5배 안팎 → 2배 가까이):
   여기까지 온 판은 "빨리 끝내야 하는 판"이고, 그 구간에서 블라인드가 완만하면
   레벨을 올리는 의미가 없다. 16레벨(8000/16000 + 앤티 2000)이면 남은 둘의 스택
   합계가 90,000 이어도 한 바퀴에 28,000 이 나가 서너 바퀴 안에 끝난다.

   16단계 이후에도 남아 있으면 마지막 레벨을 유지한다. 그 지점(8분 × 16 = 2시간 8분)은
   한 판의 최대 길이로 잡아 둔 두 시간을 이미 넘긴 자리라, 실제로는 닿지 않는다. */
export const LEVEL_DURATION_SEC = 8 * 60;

export interface BlindLevel { level: number; sb: number; bb: number; ante: number }

export const BLIND_LEVELS: BlindLevel[] = [
  { level: 1, sb: 25, bb: 50, ante: 0 },
  { level: 2, sb: 50, bb: 100, ante: 0 },
  { level: 3, sb: 75, bb: 150, ante: 0 },
  { level: 4, sb: 100, bb: 200, ante: 0 },
  { level: 5, sb: 150, bb: 300, ante: 0 },
  { level: 6, sb: 200, bb: 400, ante: 50 },
  { level: 7, sb: 300, bb: 600, ante: 75 },
  { level: 8, sb: 400, bb: 800, ante: 100 },
  { level: 9, sb: 500, bb: 1000, ante: 125 },
  { level: 10, sb: 700, bb: 1400, ante: 175 },
  { level: 11, sb: 1000, bb: 2000, ante: 250 },
  /* 여기부터는 판을 닫으러 가는 구간이다 — 앞 구간(1.3~1.5배)보다 가파르게 올린다.
     앤티는 계속 빅블라인드의 1/8 로 둔다(앞 구간과 같은 비율이라 감각이 안 바뀐다). */
  { level: 12, sb: 1500, bb: 3000, ante: 375 },
  { level: 13, sb: 2000, bb: 4000, ante: 500 },
  { level: 14, sb: 3000, bb: 6000, ante: 750 },
  { level: 15, sb: 5000, bb: 10_000, ante: 1250 },
  { level: 16, sb: 8000, bb: 16_000, ante: 2000 },
];

/** 시작 후 elapsedSec가 지난 시점의 블라인드 레벨 */
export function levelAt(elapsedSec: number, levelSec = LEVEL_DURATION_SEC): BlindLevel {
  const idx = Math.floor(Math.max(0, elapsedSec) / levelSec);
  return BLIND_LEVELS[Math.min(idx, BLIND_LEVELS.length - 1)];
}

/** 다음 레벨 상승까지 남은 초. 마지막 레벨이면 null. */
export function nextLevelIn(elapsedSec: number, levelSec = LEVEL_DURATION_SEC): number | null {
  const idx = Math.floor(Math.max(0, elapsedSec) / levelSec);
  if (idx >= BLIND_LEVELS.length - 1) return null;
  return (idx + 1) * levelSec - Math.max(0, elapsedSec);
}

/* ── 상금 정책 ───────────────────────────────────────────────────────
   ITM 인원은 참가자의 30%. 스펙 4항은 40%였는데, 상금을 위로 몰아 1위의
   보상을 키우기로 정했다. 실제로 겪는 인원대(3~5명)에서는 두 값이 같아서
   차이가 없고, 6명 이상에서만 지급 인원이 한 명씩 줄어든다.

   비율은 "1위가 가장 크고 아래로 갈수록 감소"하는 등비 수열로 만든다.
   1위 목표 비중을 인원 수에 따라 다르게 잡는 게 중요하다.
   스펙은 40~45%라고 했지만 지급 인원이 1~3명일 때는 그 값이 성립하지 않는다:
   2명에게 40/60으로 주면 2위가 1위보다 많이 받는다. 그래서 소수 인원은
   실제 토너먼트의 관례값(1명 100% · 2명 65% · 3명 50%)을 쓰고,
   4명 이상부터 45%에서 시작해 인원이 늘수록 40%로 수렴시킨다. */

/** 상금 지급 인원 비율 */
export const ITM_RATIO = 0.3;

export function itmCount(n: number): number {
  if (n <= 0) return 0;
  // 최소 1명은 받는다 — 3명 판은 ceil(0.9)=1로 어차피 1명이지만 2인 이하에서도 0이 되면 안 된다
  return Math.max(1, Math.min(n, Math.ceil(n * ITM_RATIO)));
}

function topShareTarget(k: number): number {
  if (k <= 1) return 1;
  if (k === 2) return 0.65;
  if (k === 3) return 0.50;
  // 4명 45% → 인원이 늘수록 40%로 수렴
  return Math.max(0.40, 0.45 - (k - 4) * 0.01);
}

/**
 * 지급 인원 k명의 비율. 합은 정확히 1이고, 앞 순위가 항상 뒤 순위 이상이다.
 * 등비 r을 이분탐색으로 찾는다 — 1위 비중 = (1-r)/(1-r^k) 의 역문제다.
 */
export function prizeShares(k: number): number[] {
  if (k <= 0) return [];
  if (k === 1) return [1];
  const target = topShareTarget(k);
  let lo = 0.01, hi = 0.999;
  for (let i = 0; i < 80; i++) {
    const r = (lo + hi) / 2;
    let sum = 0;
    for (let j = 0; j < k; j++) sum += Math.pow(r, j);
    const top = 1 / sum;
    // r이 커지면 뒤 순위가 커져 1위 비중이 줄어든다 → 단조 감소
    if (top > target) lo = r; else hi = r;
  }
  const r = (lo + hi) / 2;
  const w: number[] = [];
  for (let j = 0; j < k; j++) w.push(Math.pow(r, j));
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map(x => x / sum);
}

/**
 * 상금 풀을 순위별 정수 포인트로 나눈다.
 *
 * 합이 정확히 pool이어야 한다 — 내림만 하면 나머지가 사라지고, 올리면 없던
 * 포인트가 발행된다. 그래서 각자 내림한 뒤 남은 나머지를 나눠 줘야 하는데,
 * 이때 "소수부가 큰 등수부터" 준다(최대잉여법).
 *
 * 나머지를 1위부터 순서대로 얹으면 65/35 배분이 2,601/1,399처럼 나온다 —
 * 1위 몫이 2,600.3이고 2위가 1,399.7인데 남은 1P가 위로 딸려 올라가기 때문이다.
 * 소수부 기준으로 주면 1,399.7이 받아 2,600/1,400이 된다.
 *
 * 순위가 뒤집힐 걱정은 없다: 정수부가 같다면 값이 큰 쪽이 소수부도 반드시 크다.
 * 소수부가 같을 때만 상위 등수를 먼저 준다.
 */
export function prizeAmounts(pool: number, players: number): number[] {
  const k = itmCount(players);
  if (k <= 0 || pool <= 0) return [];
  const exact = prizeShares(k).map(s => pool * s);
  const out = exact.map(v => Math.floor(v));
  const rest = pool - out.reduce((a, b) => a + b, 0);
  const byFrac = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
  for (let n = 0; n < rest; n++) out[byFrac[n % k].i]++;
  return out;
}

/**
 * 총 상금. 참가비가 있느냐로 계산이 갈린다.
 *
 * 프리롤(buyIn = 0) — 예전 그대로다. fixed 가 0보다 크면 인원과 무관하게 그 금액을 쓰고,
 * 아니면 누적 참가자 수 × 배수다(동시 접속자가 아니다 — 스펙 3항). 이 돈은 서비스가
 * 새로 발행하는 포인트다.
 *
 * 참가비 대회(buyIn > 0) — 걷은 돈이 곧 상금이다. 참가자끼리 주고받는 것이므로 서비스가
 * 새로 발행하는 포인트가 없다. 다만 fixed 가 있으면 보장 상금(GTD)으로 쓴다: 걷은 돈이
 * 그에 못 미치면 모자란 만큼만 서비스가 얹는다. 배수는 보지 않는다 — 그건 "머릿수당
 * 얼마를 얹어 주는가"라는 프리롤의 개념이고, 여기서는 참가비가 그 자리를 대신한다.
 * 한 칸에 두 가지 뜻을 담으면 운영자도 우리도 곧 헷갈린다.
 */
export function prizePool(
  uniqueRegistered: number, multiplier: number, fixed = 0, buyIn = 0
): number {
  const n = Math.max(0, Math.floor(uniqueRegistered));
  if (buyIn > 0) return Math.max(n * Math.floor(buyIn), Math.max(0, Math.floor(fixed)));
  if (fixed > 0) return Math.floor(fixed);
  return Math.max(0, n * multiplier);
}
