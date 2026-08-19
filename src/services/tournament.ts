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
    /* 시작 전에는 좌석이 아직 없다 — 좌석은 대회가 시작될 때 한꺼번에 만들어진다.
       그래서 여기서 seatedCount 를 보면 언제나 0 이고, 정원 검사가 한 번도 걸리지
       않았다. 아홉 자리 판에 열 명, 스무 명이 그냥 들어왔고 그렇게 시작하면 있지도
       않은 좌석 번호가 생긴다.
       시작 전에 세어야 하는 것은 앉은 사람이 아니라 신청한 사람이다. */
    return registeredCount >= MAX_PLAYERS
      ? { ok: false, reason: 'table_full' } : { ok: true };
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

/* ── PKO(Progressive Knockout) 바운티 ──────────────────────────────
   참가비가 두 통으로 갈린다: 순수 상금 팟과 바운티 펀드. 바운티 펀드는 참가자들의
   "머리 값"이 되고, 떨어뜨린 사람이 그 자리에서 절반을 현금으로 받고 나머지 절반을
   자기 머리에 얹는다. 그래서 오래 살아남아 많이 떨어뜨린 사람의 머리 값이 계속 커진다.

   ── 왜 비율을 두 개 두지 않는가
   요구서는 "현금 100% + 머리 50%"였다. 그건 KO 마다 펀드에 없는 50% 를 만들어 내는
   규칙이라, 같은 요구서의 "1P 의 오차도 없이 분배"와 동시에 성립하지 않는다.
   그래서 비율을 하나만 둔다 — 머리로 갈 몫만 정하고 현금은 "나머지 전부"다.
   두 상수를 따로 두면 둘의 합이 100% 가 아닌 값으로 설정되는 순간 총액이 어긋나는데,
   포인트는 잔액 = 원장 누적합이 유일한 불변식이라 그 어긋남이 곧 버그다.
   지금 구조에서는 상수를 어떤 값으로 바꿔도 head + cash === bounty 가 유지된다. */

/** 바운티 몫의 기본값(%). 운영자가 대회마다 고칠 수 있고, 안 정하면 이 값이다. */
export const BOUNTY_PCT_DEFAULT = 50;
/** 바운티 몫으로 넣을 수 있는 범위(%). 0 이면 바운티가 없어 모드의 뜻이 사라진다. */
export const BOUNTY_PCT_MIN = 10;
export const BOUNTY_PCT_MAX = 100;

/** 대회 행의 bounty_pct 를 안전한 범위로 다듬는다. 화면과 서버가 같은 규칙을 써야 한다. */
export function clampBountyPct(v: number | null | undefined): number {
  const n = Math.floor(Number(v ?? BOUNTY_PCT_DEFAULT));
  if (!Number.isFinite(n)) return BOUNTY_PCT_DEFAULT;
  return Math.min(BOUNTY_PCT_MAX, Math.max(BOUNTY_PCT_MIN, n));
}

/* 머리 값이 자라던 규칙(프로그레시브)을 걷어냈다. 잡은 사람이 잡힌 사람 바운티를 전액
   가져가고, 자기 머리 값은 오르지 않는다.

   왜: 프로그레시브는 인원이 많아야 뜻이 생긴다. 머리 값이 자라 사냥감이 되고, 그 사냥감을
   잡으려는 판이 또 벌어지는 것이 재미인데 — 6 인이면 KO 가 다섯 번뿐이라 자랄 시간이
   없다. 복잡도만 지불하고 효과는 못 받는다.

   그리고 프로그레시브는 돈을 우승자 쪽으로 다시 흘려보낸다. 탈락할 때 그동안 머리에
   쌓아 둔 몫을 잡은 사람에게 통째로 넘기기 때문이다. 6 인 100 회 실측:

     프로그레시브  우승자가 바운티 갈래의 89.5% · 3 위 평균 538P
     전액 독식      우승자가 바운티 갈래의 78.6% · 3 위 평균 1,800P

   독식은 계산도 닫혀 있다 — 우승자 바운티 = 한 사람 몫 × (1 + 내 KO 수). 설명이 한 줄로
   끝나고("5,000P 짜리 목이 여섯 개, 잡으면 5,000P"), 잡은 순간 확정이라 중간에 떨어진
   사람도 자기가 잡은 만큼은 지킨다.

   그래서 미스터리 바운티와 지급 규칙이 같아졌다 — 두 모드는 금액이 무작위인지(봉투)로만
   갈린다. bountySplit(머리/현금 쪼개기)도 함께 지웠다: 쓰는 곳이 없어졌고, 남겨 두면
   splitBounty(공동 KO 몫 나누기)와 이름이 비슷해 헷갈릴 뿐이다. */

/* ── 미스터리 바운티 봉투 ──────────────────────────────────────────
   사람마다 머리에 걸린 금액이 다르고, 잡히기 전까지 아무도 모른다.

   왜 이렇게 하나: 인원이 3~9 명이면 KO 가 2~8 번뿐이다. 금액이 전부 같으면 그 몇 번이
   전부 같은 무게가 되어 "누굴 잡을까"에 답이 하나뿐이다(큰 스택). 금액을 흩고 감추면
   그 관계가 끊어져서, 첫 판에 터진 숏칩이 잭팟을 들고 있을 수도 있다.

   ── 고정 표를 버린 이유 ─────────────────────────────────────────
   처음에는 가중치를 표로 박아 뒀다([38, 18, 13, 10, 8, 6, 3, 2, 2]). 그러면 인원이
   같으면 금액도 늘 같다 — 6 인이면 언제나 40.9 / 19.4 / 14.0 / 10.8 / 8.6 / 6.5% 다.
   누가 어느 봉투를 받는지만 무작위였고, 금액표는 한 번 보면 외워졌다.
   그건 "미스터리"가 아니라 "자리 뽑기"다.

   그래서 금액 자체를 매 대회 새로 뽑는다. 1% 단위 100 칸을 무작위로 나눈다.

   세 가지를 지킨다.
     1) 아무도 빈 봉투를 받지 않는다 — 바닥을 먼저 깔고 나머지를 흩는다.
        0P 짜리 봉투는 열리는 순간이 허탕이라 연출이 죽는다.
     2) 한 봉투가 너무 크지 않다 — 상한을 둔다. 상한이 없으면 5 인에서 89%,
        3 인에서 96% 짜리 봉투가 나왔다(실측). 그러면 나머지 넷은 껍데기가 되고,
        대회가 "그 한 명을 누가 잡느냐" 하나로 줄어든다.
     3) 그래도 잭팟이 생길 여지는 남긴다 — 가중치를 지수분포(-ln U)로 뽑는다.
        100 칸을 그냥 고르게 나눠 주면 큰 수의 법칙에 눌려 전부 비슷해지고,
        그러면 1)·2) 와 반대로 "전부 평범한" 대회가 되어 봉투를 열 이유가 없다.

   무작위 원천은 부르는 쪽이 넘긴다. 여기서 crypto 를 직접 쓰면 같은 인원·같은 펀드에서
   결과가 매번 달라져 검사가 불가능해진다 — 감사는 고정 수열을 넣어 성질을 확인한다. */
/** 몫을 1% 단위로 쪼갠다 — 100 칸을 나눠 갖는다. */
const ENVELOPE_UNITS = 100;

/* 인원별 봉투 몫의 범위(총 바운티의 %). 계산식이 아니라 표로 둔다 — 눈으로 보고
   조절할 수 있어야 하는 값이고, 식으로 두면 한 인원을 고치려다 전부 흔든다.

   상한을 왜 인원에 따라 낮추는가: 3 인에서 50% 는 나머지 둘이 25% 씩이라 괜찮지만,
   9 인에서 50% 는 나머지 여덟이 6% 씩이 되어 껍데기가 된다. 그래서 "평균의 두 배 반"
   근처로 맞춰 내려온다 — 어느 인원에서도 잭팟이 평균의 2~2.7배다.

   하한은 평균의 절반 근처다. 바닥이 전체의 절반쯤(lo × n ≈ 45~50)을 먹고, 남은 절반을
   무작위로 흩는다 — 바닥이 너무 높으면 흩을 칸이 없어 전부 비슷해지고(9 인에 10% 를
   깔면 흩을 칸이 10 개뿐이다), 너무 낮으면 껍데기 봉투가 생긴다.

     인원   평균    범위        바닥 합   잭팟/평균
      3    33.3%   15 ~ 50%     45%       1.5배
      4    25.0%   12 ~ 50%     48%       2.0배
      5    20.0%   10 ~ 45%     50%       2.3배
      6    16.7%    8 ~ 40%     48%       2.4배
      7    14.3%    7 ~ 36%     49%       2.5배
      8    12.5%    6 ~ 32%     48%       2.6배
      9    11.1%    5 ~ 30%     45%       2.7배 */
const ENVELOPE_RANGE: Record<number, { lo: number; hi: number }> = {
  3: { lo: 15, hi: 50 },
  4: { lo: 12, hi: 50 },
  5: { lo: 10, hi: 45 },
  6: { lo: 8, hi: 40 },
  7: { lo: 7, hi: 36 },
  8: { lo: 6, hi: 32 },
  9: { lo: 5, hi: 30 },
};

/**
 * 이 인원에서 봉투 하나가 받을 수 있는 몫의 범위(%).
 *
 * 표에 없는 인원(2 인 이하, 10 인 이상)은 표의 비율을 그대로 이어 쓴다 — 대회는 3 인
 * 이상 9 인 이하지만(MIN_PLAYERS·MAX_PLAYERS), 늦은 등록이 상한 위로 갈 수 있고
 * 검사는 경계 밖도 넣어 본다. 그때도 lo × n ≤ 100 ≤ hi × n 이어야 칸을 다 놓을 수 있다.
 */
export function envelopeRange(n: number): { lo: number; hi: number } {
  const count = Math.max(1, Math.floor(n));
  const fixed = ENVELOPE_RANGE[count];
  if (fixed) return fixed;
  if (count === 1) return { lo: ENVELOPE_UNITS, hi: ENVELOPE_UNITS };
  const avg = ENVELOPE_UNITS / count;
  const lo = Math.max(1, Math.floor(avg * 0.45));
  /* 상한은 두 조건 사이에 있어야 한다.
       아래로: 평균보다 커야 100 칸을 다 놓을 수 있다.
       위로:   나머지 전원이 하한을 받을 자리를 남겨야 한다 — 안 그러면 한 봉투가
               상한까지 갔을 때 누군가는 하한 아래로 내려간다. 2 인에서 실제로 그랬다
               (lo 22% · hi 135% → 78/22 로 갈려 하한이 깨졌다). */
  const room = ENVELOPE_UNITS - lo * (count - 1);
  return {
    lo,
    hi: Math.max(Math.ceil(avg), Math.min(Math.floor(avg * 2.7), room)),
  };
}

/**
 * 펀드를 n 개의 봉투로 나눈다. 합이 정확히 펀드다 — 내림으로 남는 몫은 가장 큰 봉투에
 * 얹는다(버리면 총액이 안 맞고, 여러 봉투에 흩으면 어느 것이 잭팟인지 흐려진다).
 *
 * 순서는 뽑힌 그대로 돌려준다. 누구에게 어느 봉투가 가는지는 부르는 쪽이 섞는다.
 *
 * @param rand [0,1) 을 돌려주는 함수. 안 주면 균등 분포를 쓴다 — 그때는 결과가 매번
 *   달라지므로, 검사는 반드시 고정 수열을 넣어야 한다.
 */
export function mysteryEnvelopes(
  fund: number, n: number, rand: () => number = () => Math.random(),
): number[] {
  const total = Math.max(0, Math.floor(fund));
  const count = Math.max(0, Math.floor(n));
  if (count === 0) return [];
  if (count === 1) return [total];

  const { lo, hi } = envelopeRange(count);
  /* 바닥을 먼저 깔고 남은 칸을 흩는다. 바닥이 100 칸을 넘으면(표 밖의 큰 인원) 흩을 것이
     없으므로 균등하게 나눈다 — 그때는 미스터리가 성립하지 않지만, 금액이 틀리는 것보다는
     낫다(합은 어떤 경우에도 펀드와 같아야 한다). */
  const base = Math.min(lo, Math.floor(ENVELOPE_UNITS / count));
  const units = Array.from({ length: count }, () => base);
  let left = ENVELOPE_UNITS - base * count;

  /* 지수 가중치. u 가 0 이면 -ln u 가 무한이 되므로 0 을 피한다 — rand() 가 0 을 돌려줄
     수 있고(Math.random 은 [0,1)), 그러면 한 봉투가 칸을 독식한다. */
  const w = Array.from({ length: count }, () => {
    const u = Math.min(1, Math.max(1e-9, rand()));
    return -Math.log(u);
  });

  /* 칸을 하나씩 놓는다. 가중치대로 고르되 상한에 닿은 봉투는 건너뛴다.
     한꺼번에 비율로 나누고 나서 상한으로 자르면 잘라낸 만큼이 붕 떠서 다시 나눠야 하고,
     그 재분배가 또 상한을 넘을 수 있다(반복해야 수렴한다). 한 칸씩 놓으면 상한을 넘을
     수가 없고 합도 정확하다 — 100 칸 × 9 명이라 비용도 없다. */
  for (let guard = 0; left > 0 && guard < ENVELOPE_UNITS * 4; guard++) {
    let wSum = 0;
    for (let i = 0; i < count; i++) if (units[i] < hi) wSum += w[i];
    if (wSum <= 0) break;                 // 전부 상한 — 아래에서 균등하게 밀어 넣는다
    let pick = Math.min(1, Math.max(0, rand())) * wSum;
    let at = -1;
    for (let i = 0; i < count; i++) {
      if (units[i] >= hi) continue;
      pick -= w[i];
      at = i;                             // 마지막으로 자격이 있던 자리 — 부동소수 오차 대비
      if (pick <= 0) break;
    }
    if (at < 0) break;
    units[at]++;
    left--;
  }
  /* 상한 때문에 남은 칸이 있으면(전원이 상한에 닿았다 — 인원이 아주 적을 때) 순서대로
     하나씩 밀어 넣는다. 버리면 합이 펀드와 어긋난다. */
  for (let i = 0; left > 0; i = (i + 1) % count) { units[i]++; left--; }

  /* 칸 → 금액. 1 칸이 펀드의 1% 인데 그 값이 정수가 아닐 수 있으므로(펀드 3P) 여기서도
     내림한다. 합이 정확히 펀드여야 한다 — 이 대회의 유일한 불변식이 "걷은 펀드가 1P 도
     남지 않고 나간다"다. */
  const out = units.map(x => Math.floor(total * x / ENVELOPE_UNITS));

  /* 남는 1P 들을 얹는다. 한 봉투에 몰지 않고 **상한 안에서 큰 것부터 하나씩** 돌린다.
     예전에는 가장 큰 봉투에 전부 얹었는데, 펀드가 아주 작으면 그 한 봉투가 범위표를
     훌쩍 넘었다 — 3인 15P 에서 60%(표는 15~50%), 9인 15P 에서 73%까지 나왔다.
     상한이 다 차면(아주 작은 펀드) 남은 것은 순서대로 넣는다. 합을 지키는 것이 먼저다. */
  const cap = units.map((_, i) => Math.max(out[i], Math.floor(total * hi / ENVELOPE_UNITS)));
  const bySize = out.map((v, i) => ({ i, v })).sort((a, b) => b.v - a.v || a.i - b.i);
  let rest = total - out.reduce((a, b) => a + b, 0);
  for (let pass = 0; rest > 0 && pass < 4; pass++) {
    for (const s of bySize) {
      if (rest <= 0) break;
      if (out[s.i] >= cap[s.i]) continue;
      out[s.i]++; rest--;
    }
    if (pass === 3 || !bySize.some(s => out[s.i] < cap[s.i])) break;
  }
  for (let i = 0; rest > 0; i = (i + 1) % count) { out[i]++; rest--; }

  /* 빈 봉투를 되살린다. 0P 짜리 봉투는 열리는 순간이 허탕이고, 그보다 나쁘게는 정산이
     bounty<=0 에서 조기 반환해 개봉 연출이 통째로 생략된다(실측: 펀드 3P·3인 → [2,1,0]).
     펀드가 인원보다 크면 [1,1,1] 이 가능한데 그 배분이 안 나오고 있었다.
     가장 큰 봉투에서 1P 씩 옮긴다 — 옮기기만 하므로 합은 변하지 않는다. */
  if (total >= count) {
    for (let i = 0; i < count; i++) {
      if (out[i] > 0) continue;
      let big = 0;
      for (let k = 1; k < count; k++) if (out[k] > out[big]) big = k;
      if (out[big] <= 1) break;                 // 더 뺄 데가 없다
      out[big]--; out[i]++;
    }
  }
  return out;
}

/**
 * 참가비 한 사람분 중 바운티 펀드로 가는 몫. 내림한다(포인트는 늘 내린다).
 *
 * 비율은 대회마다 다르다 — 운영자가 정한다. 안 주면 기본값(50%)이다.
 * 미스터리 모드는 100 을 넘겨 전액을 바운티로 쓴다.
 */
export function bountyShare(buyIn: number, pct: number = BOUNTY_PCT_DEFAULT): number {
  const b = Math.max(0, Math.floor(buyIn));
  return Math.floor(b * clampBountyPct(pct) / 100);
}

/** 참가비 한 사람분 중 순수 상금 팟으로 가는 몫. 나머지 전부라 둘의 합이 참가비다. */
export function prizeShare(buyIn: number, pct: number = BOUNTY_PCT_DEFAULT): number {
  const b = Math.max(0, Math.floor(buyIn));
  return b - bountyShare(b, pct);
}

/**
 * 바운티 하나를 여러 명이 나눠 가질 때(팟을 나눠 이겨 KO 가 공동인 경우) 몫을 정한다.
 * 내림으로 나눈 뒤 남는 1P 들을 앞사람부터 하나씩 얹는다 — 합이 정확히 원래 값이다.
 * 버리면 그만큼이 펀드에 남아 "왜 총액이 안 맞나"가 되고, 올리면 없는 돈이 나간다.
 */
export function splitBounty(bounty: number, ways: number): number[] {
  const b = Math.max(0, Math.floor(bounty));
  const n = Math.max(0, Math.floor(ways));
  if (n === 0) return [];
  const base = Math.floor(b / n);
  const rest = b - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}
