/* 시즌별 보상 금액.
 *
 * 왜 표인가 — 처음에는 "시즌 1부터 5배"라는 배수로 짰다가 되돌렸다. 배수는 두 가지가
 * 나쁘다.
 *
 *   1. 실제로 얼마를 주는지가 곱셈 결과라 코드를 봐서는 모른다. 나중에 기준값을 한 번
 *      건드리면 모든 시즌의 금액이 같이 움직이는데, 고치는 사람은 그걸 눈치채기 어렵다.
 *   2. 대회 설정에는 이미 "배수(multiplier)"라는 다른 뜻의 값이 있다 — 참가자 1인당
 *      얼마를 상금 풀에 얹는가. 그 위에 또 배수를 얹으면 어느 배수를 말하는지 흐려진다.
 *
 * 그래서 시즌마다 줄 금액을 그대로 적는다. 보면 바로 알 수 있고, 한 시즌의 값을 고쳐도
 * 다른 시즌이 따라 움직이지 않는다.
 *
 * 표에 없는 시즌은 "그보다 작거나 같은 번호 중 가장 큰 것"을 쓴다. 시즌 2가 열려도
 * 여기에 2번 줄을 안 적었으면 1번 줄이 그대로 이어진다 — 시즌이 넘어가는 순간
 * 보상이 0이 되거나 오픈베타 값으로 되돌아가는 일이 없어야 한다.
 *
 * 지난 시즌의 지급 내역을 다시 계산하지는 않는다. 원장에 그때의 금액으로 남아 있고
 * 그게 사실이다. 이 표는 "지금부터 얼마를 주는가"만 정한다.
 */
import { currentSeasonNumber } from '../db/queries';

export interface RewardTable {
  /** 출석 — 평일 */
  daily: number;
  /** 출석 — 주말 */
  dailyWeekend: number;
  /** 7일 연속 */
  weeklyStreak: number;
  /** 30일 연속 */
  monthlyStreak: number;
  /** 파산 지원금 */
  relief: number;
  /** 프리롤 상금 풀 — 참가자 1인당 (평일) */
  freerollPerHead: number;
  /** 프리롤 상금 풀 — 참가자 1인당 (주말) */
  freerollPerHeadWeekend: number;
}

/* 번호 순으로 적는다. 새 시즌의 값을 바꾸려면 그 줄만 고치면 된다. */
export const REWARDS_BY_SEASON: { season: number; r: RewardTable }[] = [
  {
    season: 0,           // 오픈베타
    r: {
      daily: 1_000,
      dailyWeekend: 2_000,
      weeklyStreak: 5_000,
      monthlyStreak: 10_000,
      relief: 200,
      freerollPerHead: 1_000,
      freerollPerHeadWeekend: 2_000,
    },
  },
  {
    season: 1,           // 2026-08-10 시작. 오픈베타 대비 다섯 배
    r: {
      daily: 5_000,
      dailyWeekend: 10_000,
      weeklyStreak: 25_000,
      monthlyStreak: 50_000,
      relief: 1_000,
      freerollPerHead: 5_000,
      freerollPerHeadWeekend: 10_000,
    },
  },
];

/** 그 시즌에 적용되는 표. 없으면 그보다 작은 번호 중 가장 큰 것을 쓴다. */
export function rewardsForSeason(season: number): RewardTable {
  let found = REWARDS_BY_SEASON[0].r;
  for (const row of REWARDS_BY_SEASON) {
    if (row.season <= season) found = row.r;
  }
  return found;
}

/**
 * 지금 시즌의 표.
 *
 * 왜 날짜가 아니라 시즌 번호로 고르는가. 시즌은 운영자가 [시즌 마감]을 눌러 넘어간다 —
 * 날짜에 걸어 두면 시즌 0이 아직 안 닫혔는데 보상만 먼저 오르거나, 시즌 1이 열렸는데
 * 보상은 그대로인 구간이 생긴다. 둘 다 "시즌 1부터"라는 약속을 어긴다.
 * 번호를 보면 그 두 경우가 아예 생기지 않고, 당일에 배포하거나 값을 고칠 일도 없다.
 */
export function rewards(): RewardTable {
  return rewardsForSeason(currentSeasonNumber());
}
