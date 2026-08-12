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
import { upsertAchievement, listAchievements, retireAchievement } from '../src/db/achievements';

/** 게임을 해서 깨는 과제의 공통 기준. 단판 베팅이 이 금액 이상일 때만 판정한다. */
const MIN_BET = 1_000;

/* 뜻이 바뀌어 id 째로 갈아엎은 과제. 여기 적어 두면 표에서 지운다 — 안 지우면 예전 줄이
   그대로 남아 아무도 깰 수 없는 칸이 하나 늘어난다(씨앗은 덮어쓸 뿐 지우지는 않는다).
   달성한 사람이 있으면 지우지 않는다. 그때는 id 를 두고 내용만 고쳐야 한다.
     bj-hit-21    → bj-double-21 : 히트가 아니라 더블다운으로 조건을 바꿨다.
     mi-23-of-24  → mi-24-of-24  : 한 칸 남기고 나오는 게 아니라 끝까지 다 여는 것으로 바꿨다. */
const RETIRED = ['bj-hit-21', 'mi-23-of-24'];

const ITEMS: Parameters<typeof upsertAchievement>[0][] = [
  {
    id: 'ho-bounty-4',
    gameType: 'HOLDEM',
    title: '죽음의 바운티 헌터',
    description: '한 토너먼트에서 상대 플레이어를 4명 이상 직접 탈락(KO)시키고 우승을 차지합니다.',
    /* 프리롤은 참가비가 0 이라 기준을 두면 영영 판정되지 않는다. 그래도 되는 이유는
       홀덤이 하루 한 번 열리는 대회라서다 — 소액으로 여러 번 돌릴 수가 없다. */
    minBet: 0,
    sortAt: 6,
    // 판정: src/db/holdem.ts awardBounty — 대회가 끝날 때 우승자의 ko_count 를 본다
  },
  {
    id: 'bj-double-21',
    gameType: 'BLACKJACK',
    title: '김재원이 되어 보자',
    description: '20에 만족하지 않고 더블다운해서 21을 만듭니다.',
    minBet: MIN_BET,
    sortAt: 10,
    // 판정: src/web/games/blackjack.ts — 더블다운 직후, 직전 합이 20이고 결과가 21일 때
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
    description: '6점 이하에서 카드를 더 받지 않고 스탠드 후, 딜러가 버스트해 승리합니다.',
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
    id: 'mi-24-of-24',
    gameType: 'MINES',
    title: '안전불감증',
    description: '지뢰 1개 판에서 24칸을 전부 열어 클리어에 성공합니다.',
    minBet: MIN_BET,
    sortAt: 40,
    // 판정: src/web/games/mines.ts handleReveal — 지뢰 1개 · 24칸을 다 열어 자동 정산될 때
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
    /* 여기만 기준이 없다. 재는 것이 한 판이 아니라 한 시즌의 합계라서다.
       1,000P 문지기는 "소액으로 수천 번 돌려 긁어내는 것"을 막는 장치인데, 순수익
       100만은 그 방법으로 도달할 수 있는 값이 아니다 — 막을 것이 없는 자리다.
       그대로 두면 100만을 이미 넘겨 놓고도 마지막 판을 999P 로 걸었다는 이유로 안 열리고,
       사람은 카드에 적힌 «베팅 1,000P 이상»과 «한 시즌 순수익»을 어떻게 같이 읽어야
       하는지 알 수 없다. 실제로 그 질문을 받았다. */
    minBet: 0,
    sortAt: 21,
    // 판정: src/web/games/crash.ts — season_stats 의 이번 시즌 graph 순수익(returned - staked)
  },
  {
    id: 'crash-x1-01',
    gameType: 'CRASH',
    title: '0.01초의 광기',
    description: '그래프가 1.01배 이하일 때 손으로 캐시아웃합니다.',
    /* 1.01x 는 시작하자마자 지나가는 배율이라 기다릴 것이 없다. 그래도 기준을 둔다 —
       손이 빠른가를 재는 과제이지만, 1P 로 수십 판을 갈아 가며 맞히는 것과 제 돈을 걸고
       맞히는 것은 다르다. 다른 게임 과제와 같은 1,000P 로 맞춘다. */
    minBet: MIN_BET,
    /* 히든. 조건을 미리 알려 주면 자동 캐시아웃을 1.01x 로 걸어 두고 한 판 만에 끝내는
       사람이 나온다(그 경로는 판정에서 막아 두었다 — crash.ts). 우연히 손이 미끄러진
       사람이 "이런 것도 있었나" 하고 발견하는 편이 이 과제답다. */
    isHidden: true,
    sortAt: 22,
    // 판정: src/web/games/crash.ts — 캐시아웃 배율이 정확히 1.01 이고 예약 정산이 아닐 때
  },
  {
    id: 'mi-1-of-25',
    gameType: 'MINES',
    title: '1/25의 사나이',
    description: '지뢰 24개 판에서 단 하나뿐인 안전 칸을 딱 열어 캐시아웃합니다.',
    minBet: MIN_BET,
    sortAt: 41,
    // 판정: src/web/games/mines.ts handleReveal — 안전 칸이 하나뿐인 판을 다 열었을 때(자동 정산)
  },
  {
    id: 'la-right-7',
    gameType: 'LADDER',
    title: '극우 이대남',
    description: '사다리게임에서 출발 «우»에만 걸어 7연승합니다. 쉬어가는 판은 연승이 끊기지 않습니다.',
    /* 진짜 문지기는 연승을 쌓는 자리에 있다(queries/ladder) — 1,000P 미만으로 이긴 판은
       연승에 아예 들어가지 않는다. 여기에도 같은 값을 적는 건 화면 때문이다: 0 으로 두면
       카드에 «베팅 1,000P 이상»이 안 붙어서, 규칙은 있는데 어디에도 안 적힌 상태가 된다. */
    minBet: MIN_BET,
    sortAt: 30,
    // 판정: src/web/games/ladder.ts — user_streaks 의 ladder_right_win 이 7 이상일 때
  },
  {
    id: 'bc-player-7',
    gameType: 'BACCARAT',
    title: '플레이어의 수호신',
    /* "오직"과 "쉬어가는 판"을 둘 다 적는다. 앞의 말이 없으면 뱅커와 양다리를 걸어도
       되는 것으로 읽고, 뒤의 말이 없으면 한 판이라도 빠지면 끊긴다고 읽는다.
       타이도 적는다 — 무승부에서 연승이 깨진 것으로 오해할 수 있다. */
    description: '바카라에서 «플레이어»에만 걸어 7연승합니다. '
      + '쉬어가는 판과 타이(무승부)는 연승이 끊기지 않습니다.',
    minBet: MIN_BET,
    sortAt: 15,
    // 판정: src/web/games/baccarat.ts — user_streaks 의 bacc_player_win 이 7 이상일 때
  },
  {
    id: 'all-first-1',
    gameType: 'ALL',
    title: '나 혼자만 1등',
    description: '한 시즌이 끝나는 시점에 모든 게임의 랭킹 1위를 동시에 차지합니다.',
    /* 시즌 마감에 딱 한 번 판정된다. 그 판의 베팅액이라는 것이 없다. */
    minBet: 0,
    sortAt: 91,
    // 판정: src/db/queries/season.ts closeSeason — 전 종목 1위가 같은 사람일 때
  },
  {
    id: 'roller-coaster',
    gameType: 'ALL',
    title: '롤러코스터',
    description: '하루 안에 보유 포인트가 1,000P 이하까지 떨어진 뒤 100,000P 이상으로 되돌립니다.',
    /* 잔액의 궤적을 보는 과제라 한 판의 베팅액과 상관이 없다. */
    minBet: 0,
    /* 히든. 조건을 알려 주면 "일부러 1,000P 까지 잃는" 것이 최적의 행동이 된다 —
       그건 이 과제가 기리려던 일(잃었다가 되살아났다)의 반대다. */
    isHidden: true,
    sortAt: 92,
    // 판정: src/web/achieve-hook.ts commonAwards — 오늘 출석 뒤 바닥을 찍고 되살아났을 때
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
const gone: string[] = [], kept: string[] = [];
for (const id of RETIRED) {
  const r = retireAchievement(id);
  if (r.removed) gone.push(id);
  else if (r.keptFor > 0) kept.push(`${id}(달성 ${r.keptFor}명 — 안 지움)`);
}
/* 감사가 이 파일을 여러 번 불러 표를 다시 채운다(그때마다 출력이 쏟아지면 정작 검사
   결과가 안 보인다). 조용히 돌리려면 QUIET=1 을 준다 — 운영에서 손으로 돌릴 때는
   무엇이 들어갔는지 눈으로 봐야 하므로 기본은 출력하는 쪽이다. */
if (process.env.QUIET !== '1') {
  console.log(`등록/갱신 ${made}건 · 표에 있는 과제 ${listAchievements().length}개`);
  if (gone.length) console.log(`  폐기: ${gone.join(', ')}`);
  if (kept.length) console.log(`  ${kept.join(', ')}`);
  for (const a of listAchievements()) {
    console.log(`  [${a.game_type}] ${a.id} · ${a.title}`
      + (a.is_hidden ? ' (히든)' : '') + ` · 최소 ${a.min_bet.toLocaleString('ko-KR')}P`);
  }
}
