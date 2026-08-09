/* 도전과제를 표에 넣는다.
 *
 * 과제는 코드가 아니라 데이터다 — 화면은 이 표를 읽어 그릴 뿐이라, 여기 줄을 넣으면
 * 배포 없이도 화면에 뜬다. 다만 "언제 달성인가"는 게임 코드가 판정하므로, 새 과제를
 * 넣을 때는 그 판정도 함께 붙여야 한다(아래 각 줄의 주석에 어디서 판정하는지 적었다).
 *
 * 같은 id 로 다시 돌리면 내용만 덮어쓴다 — 이미 달성한 사람의 기록은 건드리지 않는다.
 *
 * 로컬:  npx tsx scripts/seed-achievements.ts
 * 운영:  flyctl ssh console -C "env DB_PATH=/data npx tsx scripts/seed-achievements.ts"
 */
import { upsertAchievement, listAchievements } from '../src/db/achievements';

/** 게임을 해서 깨는 과제의 공통 기준. 단판 베팅이 이 금액 이상일 때만 판정한다. */
const MIN_BET = 1_000;

const ITEMS: Parameters<typeof upsertAchievement>[0][] = [
  {
    id: 'bj-hit-21',
    gameType: 'BLACKJACK',
    title: '김재원이 되어 보자',
    description: '20에 만족하지 않고 히트해서 21을 만듭니다.',
    minBet: MIN_BET,
    sortAt: 10,
    // 판정: src/web/games/blackjack.ts — 히트 직후, 직전 합이 20이고 결과가 21일 때
  },
  {
    id: 'crash-x100',
    gameType: 'CRASH',
    title: '도파민 중독',
    description: '100배 이상에서 캐시아웃합니다.',
    minBet: MIN_BET,
    sortAt: 20,
    // 판정: src/web/games/crash.ts — 캐시아웃 배율이 100 이상일 때(자동 캐시아웃 포함)
  },
  {
    id: 'crash-profit-1m',
    gameType: 'CRASH',
    title: '그래프의 신',
    /* "한 시즌 동안"을 반드시 적는다. 전적과 순수익은 시즌이 바뀌면 0에서 다시 시작하는데,
       그 말을 안 해 두면 지난 시즌에 벌어 둔 것이 합쳐질 거라고 읽게 된다.
       달성 기록 자체는 시즌과 무관하게 영구히 남는다 — 그건 목록 맨 위에 적혀 있다. */
    description: '한 시즌 동안 그래프게임 순수익 100만P를 달성합니다.',
    minBet: MIN_BET,
    sortAt: 21,
    // 판정: src/web/games/crash.ts — season_stats 의 이번 시즌 graph 순수익(returned - staked)
  },
  {
    id: 'relief-10-day',
    gameType: 'ALL',
    title: '건실한 파산러',
    description: '하루에 파산 지원금을 10번 이상 받습니다.',
    /* 지원금에는 베팅이 없다. 기준을 그대로 두면 이 과제는 영영 판정되지 않는다 —
       문지기는 "게임을 해서 깨는 과제"를 위한 것이고 이건 그쪽이 아니다. */
    minBet: 0,
    /* 공개로 연다. 감춰 두면 "하루에 열 번 파산한다"는 농담 자체가 전달되지 않고,
       조건을 모르는 사람에게는 그냥 잠긴 칸 하나가 는 것과 같다. */
    isHidden: false,
    sortAt: 90,
    // 판정: src/discord/interactions.ts — 지원금 지급 성공 직후, 오늘(KST) 받은 횟수
  },
];

let made = 0;
for (const a of ITEMS) {
  const r = upsertAchievement(a);
  if (!r.ok) { console.error(`거절: ${a.id} — ${r.error}`); process.exitCode = 1; continue; }
  made++;
}
console.log(`등록/갱신 ${made}건 · 표에 있는 과제 ${listAchievements().length}개`);
for (const a of listAchievements()) {
  console.log(`  [${a.game_type}] ${a.id} · ${a.title}`
    + (a.is_hidden ? ' (히든)' : '') + ` · 최소 ${a.min_bet.toLocaleString('ko-KR')}P`);
}
