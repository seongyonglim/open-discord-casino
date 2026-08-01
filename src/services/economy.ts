// 출석/포인트 이코노미 — KST(서울) 기준 날짜로 하루 1회 출석, 주말 2배, 연속출석 보너스
import { getWebUser, performCheckIn, upsertUser, type PointsGrant } from '../db/queries';

const DAILY_WEEKDAY = 100;
const DAILY_WEEKEND = 200;
const WEEKLY_STREAK_BONUS = 500;
const MONTHLY_STREAK_BONUS = 1000;

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
  const granted = grants.reduce((sum, g) => sum + g.delta, 0);
  return { alreadyCheckedIn: false, streak: newStreak, balance, granted, breakdown: grants };
}
