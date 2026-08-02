// 재난 지원금 (파산 구제) — 잔액이 0이 된 사람이 다시 게임을 시작할 수 있게 하는 소액 지급.
//
// 설계 의도:
//  · "0포인트일 때만" 이라는 조건이 이 기능의 안전장치다. 잔액이 조금이라도 남아 있으면 받을 수 없으므로,
//    이걸로 포인트를 쌓아 올릴 수는 없다(받은 200P를 다 잃어야 다음 신청 자격이 생긴다).
//  · 4시간 쿨다운은 "다 잃고 바로 또 받기"를 막아 지원금이 무한 재화가 되지 않게 한다.
//  · 지급 조건 검사와 실제 지급은 queries.claimRelief가 한 트랜잭션에서 처리한다(이중 지급 방지).
import { claimRelief, getReliefStatus, type ReliefStatus } from '../db/queries';

export const RELIEF_AMOUNT = 200;
export const RELIEF_COOLDOWN_SEC = 4 * 60 * 60;

export interface ReliefView extends ReliefStatus {
  amount: number;
  cooldownSec: number;
  claimable: boolean;
  waitSec: number;      // 쿨다운이 남아 있으면 남은 초, 아니면 0
  blockedBy: 'none' | 'not_broke' | 'cooldown';
}

export function reliefView(userId: string): ReliefView | undefined {
  const st = getReliefStatus(userId, RELIEF_COOLDOWN_SEC);
  if (!st) return undefined;
  const now = Math.floor(Date.now() / 1000);
  const waitSec = st.nextAvailableAt == null ? 0 : Math.max(0, st.nextAvailableAt - now);
  // 잔액 조건을 먼저 본다 — 포인트가 남아 있으면 쿨다운과 무관하게 신청 대상이 아니다
  const blockedBy = st.balance !== 0 ? 'not_broke' : waitSec > 0 ? 'cooldown' : 'none';
  return { ...st, amount: RELIEF_AMOUNT, cooldownSec: RELIEF_COOLDOWN_SEC,
    claimable: blockedBy === 'none', waitSec, blockedBy };
}

export function claim(userId: string) {
  return claimRelief(userId, RELIEF_AMOUNT, RELIEF_COOLDOWN_SEC);
}
