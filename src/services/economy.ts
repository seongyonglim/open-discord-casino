// 출석/포인트 이코노미 — KST(서울) 기준 날짜로 하루 1회 출석, 주말 2배, 연속출석 보너스
import { getWebUser, performCheckIn, upsertUser, type PointsGrant } from '../db/queries';
import { rewards } from './rewards';
import { rewardBuff } from './buff';

/* 시즌마다 줄 금액은 services/rewards 의 표에 있다. 여기서 곱하거나 더하지 않는다 —
   실제 지급액이 두 곳의 계산을 거치면 어느 쪽이 진짜인지 알 수 없게 된다.
   (도전과제 버프만 예외다. 그건 시즌 표가 아니라 사람마다 다른 값이라, 아래 checkIn 에서
    한 번만 곱한다 — 이 함수들은 끝까지 "기본 보상"을 돌려준다.) */
export const dailyWeekday = () => rewards().daily;
export const dailyWeekend = () => rewards().dailyWeekend;
export const weeklyStreakBonus = () => rewards().weeklyStreak;
export const fullStreakBonus = () => rewards().fullStreak;

/* 개근 기준. 7 일과 28 일이고, 28 은 7 의 배수다 — 28 일째에는 두 조건이 함께 맞는다.
   그날은 개근상 하나만 준다(아래 checkIn 의 else if). 둘 다 주면 "28일 개근상"이
   사실상 "28일 개근상 + 주간 보너스"가 되어, 화면에 적힌 금액과 들어오는 금액이 다르다. */
export const STREAK_WEEK_DAYS = 7;
export const STREAK_FULL_DAYS = 28;

// 출석판·안내 문구는 반드시 이 함수로 만든다. 문자열에 숫자를 직접 적어두면
// 보상을 조정할 때 한쪽만 고쳐서 실제 지급액과 안내가 어긋난다.
export function rewardSummary(): string {
  const p = (n: number) => n.toLocaleString('ko-KR');
  return `평일 ${p(dailyWeekday())}P · 주말 ${p(dailyWeekend())}P · `
    + `${STREAK_WEEK_DAYS}일 연속 +${p(weeklyStreakBonus())}P · `
    + `${STREAK_FULL_DAYS}일 연속 +${p(fullStreakBonus())}P`;
}

function kstDateStr(ms: number): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

function isKstWeekend(ms: number): boolean {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short' }).format(new Date(ms));
  return weekday === 'Sat' || weekday === 'Sun';
}

export interface CheckInResult {
  alreadyCheckedIn: boolean;
  streak: number;
  balance: number;
  granted: number;
  breakdown: PointsGrant[];
  /** 이번 지급에 적용된 도전과제 버프 (%). 화면에 알려 주려고 함께 돌려준다. */
  buffPercent: number;
}

// 출석 체크인 실행 (하루 1회, KST 자정 기준 리셋). 디스코드 버튼과 웹 페이지 양쪽에서 호출.
export function checkIn(userId: string, username: string, avatar: string | null): CheckInResult {
  upsertUser(userId, username, avatar);
  const user = getWebUser(userId)!;
  const now = Date.now();
  const today = kstDateStr(now);

  if (user.last_checkin_date === today) {
    return { alreadyCheckedIn: true, streak: user.current_streak, balance: user.balance,
      granted: 0, breakdown: [], buffPercent: rewardBuff(userId).percent };
  }

  const yesterday = kstDateStr(now - 24 * 60 * 60 * 1000);
  const newStreak = user.last_checkin_date === yesterday ? user.current_streak + 1 : 1;

  const grants: PointsGrant[] = [
    { reason: 'attendance', delta: isKstWeekend(now) ? dailyWeekend() : dailyWeekday() },
  ];
  /* 28 일은 7 의 배수라 두 조건이 함께 맞는 날이 반드시 온다. 그날은 개근상만 준다 —
     둘 다 주면 안내에 적힌 개근상 금액과 실제로 들어오는 금액이 달라진다. */
  if (newStreak % STREAK_FULL_DAYS === 0) {
    grants.push({ reason: 'full_streak_bonus', delta: fullStreakBonus() });
  } else if (newStreak % STREAK_WEEK_DAYS === 0) {
    grants.push({ reason: 'weekly_streak_bonus', delta: weeklyStreakBonus() });
  }

  /* 도전과제 버프. 여기 한 곳에서만 곱한다 — 위의 grants 는 전부 기본 보상이고,
     실제로 원장에 남는 값은 이 아래의 값이다. 포인트는 내림이다.
     버프가 0% 인 사람에게는 곱해도 값이 그대로라 분기를 두지 않는다. */
  const buff = rewardBuff(userId);
  for (const g of grants) g.delta = Math.floor(g.delta * buff.mult);

  const balance = performCheckIn(userId, newStreak, today, grants);
  // null이면 위 날짜 비교와 트랜잭션 사이에 다른 요청이 먼저 오늘을 선점했다는 뜻이다.
  // 그쪽이 이미 지급받았으므로 여기서는 "이미 출석함"으로 돌려준다.
  if (balance === null) {
    const now2 = getWebUser(userId)!;
    return { alreadyCheckedIn: true, streak: now2.current_streak, balance: now2.balance,
      granted: 0, breakdown: [], buffPercent: buff.percent };
  }
  const granted = grants.reduce((sum, g) => sum + g.delta, 0);
  return { alreadyCheckedIn: false, streak: newStreak, balance, granted,
    breakdown: grants, buffPercent: buff.percent };
}
