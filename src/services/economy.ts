// 출석/포인트 이코노미 — KST(서울) 기준 날짜로 하루 1회 출석, 주말 2배, 연속출석 보너스
import { getWebUser, performCheckIn, upsertUser, type PointsGrant } from '../db/queries';

export const DAILY_WEEKDAY = 1000;
export const DAILY_WEEKEND = 2000;
export const WEEKLY_STREAK_BONUS = 5000;
export const MONTHLY_STREAK_BONUS = 10000;

// 출석판·안내 문구는 반드시 이 함수로 만든다. 문자열에 숫자를 직접 적어두면
// 보상을 조정할 때 한쪽만 고쳐서 실제 지급액과 안내가 어긋난다.
export function rewardSummary(): string {
  const p = (n: number) => n.toLocaleString('ko-KR');
  return `평일 ${p(DAILY_WEEKDAY)}P · 주말 ${p(DAILY_WEEKEND)}P · `
    + `7일 연속 +${p(WEEKLY_STREAK_BONUS)}P · 30일 연속 +${p(MONTHLY_STREAK_BONUS)}P`;
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
    { reason: 'attendance', delta: isKstWeekend(now) ? DAILY_WEEKEND : DAILY_WEEKDAY },
  ];
  // 주간·월간 보너스는 서로 독립이다. 210일처럼 7과 30의 공배수인 날에는 둘 다 지급한다.
  if (newStreak % 7 === 0) {
    grants.push({ reason: 'weekly_streak_bonus', delta: WEEKLY_STREAK_BONUS });
  }
  if (newStreak % 30 === 0) {
    grants.push({ reason: 'monthly_streak_bonus', delta: MONTHLY_STREAK_BONUS });
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
