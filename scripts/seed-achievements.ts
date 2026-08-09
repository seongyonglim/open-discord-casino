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
    id: 'ho-straight-flush',
    gameType: 'HOLDEM',
    title: '스트레이트 플러시',
    description: '홀덤 쇼다운에서 스트레이트 플러시를 공개합니다.',
    /* 프리롤은 참가비가 0 이라 기준을 두면 영영 판정되지 않는다. 그래도 되는 이유는
       홀덤이 하루 한 번 열리는 대회라서다 — 소액으로 여러 번 돌릴 수가 없다.
       참가비가 있는 대회가 열리면 그 금액이 그대로 이 문을 지난다. */
    minBet: 0,
    sortAt: 5,
    // 판정: src/db/holdem.ts endHand — 쇼다운에 공개된 손의 족보 이름으로 본다
  },
  {
    id: 'bj-stand-6',
    gameType: 'BLACKJACK',
    title: '너 버스트할거 잖아',
    description: '6점 이하에서 카드를 더 받지 않고 서서, 딜러가 버스트해 이깁니다.',
    minBet: MIN_BET,
    sortAt: 11,
    // 판정: src/web/games/blackjack.ts — 선 점수 ≤ 6 · 딜러 버스트 · 승리
  },
  {
    id: 'bj-7-cards',
    gameType: 'BLACKJACK',
    title: '카드 야르',
    description: '한 판에 카드를 7장 이상 받고도 21을 넘기지 않고 이깁니다.',
    minBet: MIN_BET,
    sortAt: 12,
    // 판정: src/web/games/blackjack.ts — 7장 이상 · 버스트 아님 · 승리
  },
  {
    id: 'pk-quads-plus',
    gameType: 'POKER',
    title: '한탕주의자',
    /* 설명에 "포카드 이상"을 그대로 쓴다 — 화면의 베팅 칸 이름과 같은 말이라야
       어디에 걸어야 하는지 찾을 수 있다. */
    description: '완성 족보 예측에서 «포카드 이상»에 걸어 맞힙니다.',
    minBet: 500,
    sortAt: 25,
    // 판정: src/web/games/poker.ts — 마지막 등급 칸(b4) 베팅이 적중했을 때
  },
  {
    id: 'mi-23-of-24',
    gameType: 'MINES',
    title: '안전불감증',
    description: '지뢰 1개 판에서 23칸을 열고, 마지막 한 칸을 남긴 채 캐시아웃합니다.',
    minBet: MIN_BET,
    sortAt: 40,
    // 판정: src/web/games/mines.ts — 지뢰 1개 · 연 칸 23 · 캐시아웃
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
    id: 'la-right-7',
    gameType: 'LADDER',
    title: '극우 이대남',
    description: '사다리게임에서 출발 «우»에만 걸어 7연승합니다. 쉬어가는 판은 연승이 끊기지 않습니다.',
    /* 문지기는 연승을 쌓는 자리에 있다(queries/ladder). 1,000P 미만 베팅은 연승에
       영향을 주지 않으므로, 여기서 다시 재면 "일곱 번째 판을 얼마 걸었나"를 묻는 셈이
       되어 뜻이 달라진다. */
    minBet: 0,
    sortAt: 30,
    // 판정: src/web/games/ladder.ts — user_streaks 의 ladder_right_win 이 7 이상일 때
  },
  {
    id: 'relief-10-day',
    gameType: 'ALL',
    title: '부지런한 파산러',
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
/* 감사가 이 파일을 여러 번 불러 표를 다시 채운다(그때마다 출력이 쏟아지면 정작 검사
   결과가 안 보인다). 조용히 돌리려면 QUIET=1 을 준다 — 운영에서 손으로 돌릴 때는
   무엇이 들어갔는지 눈으로 봐야 하므로 기본은 출력하는 쪽이다. */
if (process.env.QUIET !== '1') {
  console.log(`등록/갱신 ${made}건 · 표에 있는 과제 ${listAchievements().length}개`);
  for (const a of listAchievements()) {
    console.log(`  [${a.game_type}] ${a.id} · ${a.title}`
      + (a.is_hidden ? ' (히든)' : '') + ` · 최소 ${a.min_bet.toLocaleString('ko-KR')}P`);
  }
}
