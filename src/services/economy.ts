// 출석/포인트 이코노미 — KST(서울) 기준 날짜로 하루 1회 출석, 주말 2배, 연속출석 보너스
import { getWebUser, performCheckIn, upsertUser, type PointsGrant } from '../db/queries';
import { rewards } from './rewards';

/* 시즌마다 줄 금액은 services/rewards 의 표에 있다. 여기서 곱하거나 더하지 않는다 —
   실제 지급액이 두 곳의 계산을 거치면 어느 쪽이 진짜인지 알 수 없게 된다. */
export const dailyWeekday = () => rewards().daily;
export const dailyWeekend = () => rewards().dailyWeekend;
export const weeklyStreakBonus = () => rewards().weeklyStreak;
export const monthlyStreakBonus = () => rewards().monthlyStreak;

// 출석판·안내 문구는 반드시 이 함수로 만든다. 문자열에 숫자를 직접 적어두면
// 보상을 조정할 때 한쪽만 고쳐서 실제 지급액과 안내가 어긋난다.
export function rewardSummary(): string {
  const p = (n: number) => n.toLocaleString('ko-KR');
  return `평일 ${p(dailyWeekday())}P · 주말 ${p(dailyWeekend())}P · `
    + `7일 연속 +${p(weeklyStreakBonus())}P · 30일 연속 +${p(monthlyStreakBonus())}P`;
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
}

// 출석 체크인 실행 (하루 1회, KST 자정 기준 리셋). 디스코드 버튼과 웹 페이지 양쪽에서 호출.
export function checkIn(userId: string, username: string, avatar: string | null): CheckInResult {
  upsertUser(userId, username, avatar);
  const user = getWebUser(userId)!;
  const now = Date.now();
  const today = kstDateStr(now);

  if (user.last_checkin_date === today) {
    return { alreadyCheckedIn: true, streak: user.current_streak, balance: user.balance, granted: 0, breakdown: [] };
  }

  const yesterday = kstDateStr(now - 24 * 60 * 60 * 1000);
  const newStreak = user.last_checkin_date === yesterday ? user.current_streak + 1 : 1;

  const grants: PointsGrant[] = [
    { reason: 'attendance', delta: isKstWeekend(now) ? dailyWeekend() : dailyWeekday() },
  ];
  // 주간·월간 보너스는 서로 독립이다. 210일처럼 7과 30의 공배수인 날에는 둘 다 지급한다.
  if (newStreak % 7 === 0) {
    grants.push({ reason: 'weekly_streak_bonus', delta: weeklyStreakBonus() });
  }
  if (newStreak % 30 === 0) {
    grants.push({ reason: 'monthly_streak_bonus', delta: monthlyStreakBonus() });
  }

  const balance = performCheckIn(userId, newStreak, today, grants);
  // null이면 위 날짜 비교와 트랜잭션 사이에 다른 요청이 먼저 오늘을 선점했다는 뜻이다.
  // 그쪽이 이미 지급받았으므로 여기서는 "이미 출석함"으로 돌려준다.
  if (balance === null) {
    const now2 = getWebUser(userId)!;
    return { alreadyCheckedIn: true, streak: now2.current_streak, balance: now2.balance, granted: 0, breakdown: [] };
  }
  const granted = grants.reduce((sum, g) => sum + g.delta, 0);
  return { alreadyCheckedIn: false, streak: newStreak, balance, granted, breakdown: grants };
}
