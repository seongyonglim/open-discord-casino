// 개인회생 지원금 (파산 구제) — 잔액이 0이 된 사람이 다시 게임을 시작할 수 있게 하는 소액 지급.
//
// 설계 의도:
//  · "0포인트일 때만" 이라는 조건이 이 기능의 안전장치다. 잔액이 조금이라도 남아 있으면 받을 수 없으므로,
//    이걸로 포인트를 쌓아 올릴 수는 없다(받은 200P를 다 잃어야 다음 신청 자격이 생긴다).
//  · 4시간 쿨다운은 "다 잃고 바로 또 받기"를 막아 지원금이 무한 재화가 되지 않게 한다.
//  · 지급 조건 검사와 실제 지급은 queries.claimRelief가 한 트랜잭션에서 처리한다(이중 지급 방지).
import { claimRelief } from '../db/queries';

export const RELIEF_AMOUNT = 200;
export const RELIEF_COOLDOWN_SEC = 4 * 60 * 60;

export function claim(userId: string) {
  return claimRelief(userId, RELIEF_AMOUNT, RELIEF_COOLDOWN_SEC);
}
