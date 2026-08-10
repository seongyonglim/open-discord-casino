/* 도전과제 보상 버프.
 *
 * 달성한 과제 하나당 지급 보상이 5% 늘어난다. 합연산이다 — 열 개면 1.05^10(≈1.63배)이
 * 아니라 1 + 10×0.05 = 1.5배다. 곱연산으로 두면 과제가 늘어날 때 지급액이 눈덩이처럼
 * 커지고, "몇 %인가"를 사람이 머리로 계산할 수 없다.
 *
 * 어디에 붙는가: 지급 보상에만 붙는다 — 출석 체크(일일 · 7일 개근 · 28일 개근)와
 * 파산 지원금이다. 게임 배당에는 붙지 않는다. 배당에 붙이면 하우스 엣지가 사람마다
 * 달라져 게임의 확률 설계가 무너진다(그건 보상이 아니라 규칙이다).
 *
 * 왜 시즌과 무관한가: 도전과제는 시즌이 바뀌어도 남는 유일한 기록이다. 그래서 이 버프는
 * "그 계정이 지금까지 해낸 것"에 대한 보상이고, 시즌 초기화의 예외가 하나 더 생기는
 * 것이 아니라 이미 있던 예외를 쓰는 것이다.
 *
 * 반올림은 하지 않는다 — 포인트는 언제나 내림이다.
 */
import { unlockedCountOf } from '../db/achievements';

/** 과제 하나당 가산율. */
export const BUFF_PER_ACHIEVEMENT = 0.05;

export interface RewardBuff {
  /** 달성한 과제 수 */
  count: number;
  /** 가산율(%) — 화면에 "+N%"로 적는 값 */
  percent: number;
  /** 기본 보상에 곱할 값 */
  mult: number;
}

export function rewardBuff(userId: string): RewardBuff {
  const count = unlockedCountOf(userId);
  return {
    count,
    /* 퍼센트도 계산해서 준다. 화면에서 count × 5 를 다시 곱하게 두면 가산율을 바꾸는 날
       화면만 옛 숫자로 남는다 — 실제 지급액과 안내가 갈라지는 그 사고다. */
    percent: Math.round(count * BUFF_PER_ACHIEVEMENT * 100),
    mult: 1 + count * BUFF_PER_ACHIEVEMENT,
  };
}

/** 기본 보상에 버프를 적용한 실지급액. 내림이다. */
export function buffed(base: number, userId: string): number {
  return Math.floor(base * rewardBuff(userId).mult);
}

/** "도전과제 버프 +15% 적용 중" — 버프가 없으면 빈 문자열이다(0% 는 적을 이유가 없다). */
export function buffNote(userId: string): string {
  const b = rewardBuff(userId);
  if (b.percent <= 0) return '';
  return `도전과제 버프 +${b.percent}% 적용 중 (달성 ${b.count}개)`;
}
