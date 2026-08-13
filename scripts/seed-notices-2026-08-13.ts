/* 공지 두 건 — 블랙잭 칩 표기 오류 수정(제보 보상) · 홀덤 바운티 두 모드 출시.
 *
 * 같은 글을 로컬과 실서버에 똑같이 넣기 위한 스크립트다 — 손으로 옮겨 적으면 두 곳의
 * 글이 미묘하게 달라진다. 8월 10일자 스크립트와 같은 틀이다.
 *
 * 실행:
 *   npx tsx scripts/seed-notices-2026-08-13.ts              (없으면 등록, 있으면 건너뜀)
 *   FORCE=1 npx tsx scripts/seed-notices-2026-08-13.ts      (이미 있어도 이 내용으로 덮어씀)
 *   DB_PATH=/data npx tsx scripts/seed-notices-2026-08-13.ts  (서버 안에서)
 *
 * 본문의 숫자는 코드에서 읽어 온다(BUG_REPORT_BOUNTY · 바운티 몫 범위 · 봉투 범위표).
 * 보상액이나 규칙을 고치는 날 공지만 옛말이 되는 것을 막기 위해서다 — 지난번에
 * "그래프의 신" 설명이 통산 기준으로 남아 있던 것과 같은 사고다.
 */
import { createNotice, updateNotice, NOTICE_KINDS, type NoticeSection } from '../src/db/notices';
import { BUG_REPORT_BOUNTY } from '../src/services/rewards';
import {
  BOUNTY_PCT_MIN, BOUNTY_PCT_MAX, BOUNTY_PCT_DEFAULT, envelopeRange,
} from '../src/services/tournament';
import { getDb } from '../src/db/schema';

const db = getDb();
const exists = (id: string): boolean =>
  (db.prepare(`SELECT COUNT(*) AS n FROM notices WHERE id = ?`).get(id) as { n: number }).n > 0;
const FORCE = process.env.FORCE === '1';

const p = (n: number): string => n.toLocaleString('ko-KR') + 'P';

/* 봉투 범위표를 코드에서 읽어 본문 표를 만든다. 손으로 적으면 표를 조절하는 날
   공지가 거짓이 된다 — 이 값은 모드의 균형 그 자체다. */
const ENV_ROWS: string[][] = [3, 4, 5, 6, 7, 8, 9].map(n => {
  const r = envelopeRange(n);
  return [`${n}명`, `${(100 / n).toFixed(1)}%`, `${r.lo} ~ ${r.hi}%`];
});

/* 5인·바운티 50% 예시. 계산 예시는 숫자를 직접 적는 대신 여기서 만들어,
   기본 몫이 바뀌면 예시도 함께 따라오게 한다. */
const EX_MULT = 10_000;
const EX_N = 5;
const EX_TOTAL = EX_MULT * EX_N;
const EX_BTY = Math.floor(EX_MULT * BOUNTY_PCT_DEFAULT / 100) * EX_N;
const EX_PRIZE = EX_TOTAL - EX_BTY;
const EX_RANGE = envelopeRange(EX_N);

interface Draft {
  id: string; date: string; kind: typeof NOTICE_KINDS[number];
  title: string; summary: string; sections: NoticeSection[];
}

const DRAFTS: Draft[] = [
  {
    id: '2026-08-13-blackjack-chip-ui',
    date: '2026-08-13',
    kind: '업데이트',
    title: '블랙잭에서 지운 칩이 되살아나던 문제',
    summary: `동전을 지우고 골드바를 올렸는데 동전이 다시 나타나던 문제를 고쳤습니다. `
      + `찾아 주신 J1 님께 ${p(BUG_REPORT_BOUNTY)}를 보냈습니다.`,
    sections: [
      {
        heading: '동전을 지웠는데 다시 나타났습니다',
        paras: [
          '동전 몇 개를 올려 두고 [Clear Screen] 으로 지운 다음, 같은 자리에 골드바를 '
            + '올리면 — 골드바가 놓여야 할 자리에 <b>방금 지운 동전이 그대로 다시 '
            + '나타났습니다.</b>',
          '다행히 <b>돈은 한 푼도 어긋나지 않았습니다.</b> 베팅 금액도, 정산도 처음부터 '
            + '정상이었고 화면만 옛 칩을 붙들고 있었습니다. 그래도 자기가 얼마를 걸었는지 '
            + '화면을 못 믿게 되는 문제라, 받자마자 최우선으로 잡았습니다.',
        ],
      },
      {
        heading: '이제 이렇게 동작합니다',
        bullets: [
          '자리를 비우면 그 자리의 칩 기록도 <b>그 즉시</b> 함께 사라집니다.',
          '혹시 다른 경로로 어긋나더라도, <b>화면에 놓인 칩의 합이 실제 베팅 금액과 다르면 '
            + '곧바로 다시 그립니다.</b> 화면이 스스로 제 금액을 찾아옵니다.',
          '같은 일이 되풀이되지 않도록 자동 검사를 걸어 뒀습니다.',
        ],
      },
      {
        heading: '찾아 주셔서 고맙습니다',
        paras: [
          '금액은 멀쩡한데 그림만 어긋나는 종류라, 직접 앉아서 칩을 올려 보지 않으면 '
            + '알아채기 어려운 문제였습니다. 알려 주신 덕분에 하루 안에 고쳤습니다.',
        ],
        table: {
          head: ['닉네임', '찾아 주신 것', '보낸 포인트'],
          rows: [['J1', '블랙잭 — 지운 칩이 다시 나타나는 문제', p(BUG_REPORT_BOUNTY)]],
        },
      },
      {
        heading: '이상한 걸 보시면 알려 주세요',
        paras: [
          `"이거 원래 이런 건가?" 싶은 순간이 있으면 그게 대개 버그입니다. `
            + `디스코드 채널에 한 줄만 남겨 주세요. 확인해서 고치고, 찾아 주신 분께는 `
            + `이번처럼 ${p(BUG_REPORT_BOUNTY)}를 보냅니다.`,
        ],
      },
    ],
  },
  {
    id: '2026-08-13-holdem-bounty-modes',
    date: '2026-08-13',
    kind: '신규',
    title: '상대의 목에 값이 걸립니다 — 바운티 헌터 · 미스터리 바운티',
    summary: '이제 오래 버티는 것만이 답이 아닙니다. 상대를 떨어뜨리면 그 사람 머리에 걸린 '
      + '상금이 그대로 내 것이 됩니다. 금액이 다 보이는 모드와, 잡아 봐야 아는 모드 '
      + '두 가지가 열립니다.',
    sections: [
      {
        heading: '지금까지는 버티는 게 전부였습니다',
        paras: [
          '먼저 털리면 그날 판은 그걸로 끝이었습니다. 등수만 상금을 나눴으니까요. '
            + '누굴 잡았는지, 어떻게 잡았는지는 아무 값도 없었습니다.',
          '이제 <b>사람마다 머리에 값이 걸립니다.</b> 그 사람을 떨어뜨린 사람이 그 값을 '
            + '가져갑니다. 세 번째 판에 털려 나가도, 그 전에 두 명을 잡았다면 '
            + '주머니는 채우고 나갑니다.',
        ],
        bullets: [
          '상대를 탈락시키면 그 사람 바운티를 <b>전액</b> 가져갑니다. 절반도, 나눠 갖기도 아닙니다.',
          '내 머리 값은 <b>끝까지 그대로입니다.</b> 잡을수록 내가 비싸지는 일은 없습니다 — '
            + '사냥꾼이 사냥감이 되지 않습니다.',
          '아무도 못 잡고 우승해도 괜찮습니다. <b>내 머리 값은 우승하면 내가 회수합니다.</b>',
          '모아 둔 바운티는 <b>대회가 끝날 때 한 번에</b> 들어옵니다. '
            + '진행 중에는 상금 탭의 <b>바운티 획득</b> 표에서 누가 얼마 벌었는지 볼 수 있습니다.',
          '걷은 바운티는 <b>1P도 남기지 않고</b> 전부 참가자에게 돌아갑니다.',
        ],
      },
      {
        heading: '바운티 헌터 — 누가 얼마인지 다 보입니다',
        paras: [
          '모든 사람 머리 위에 <b>금빛 명찰</b>이 걸립니다. 저 사람을 잡으면 얼마인지 '
            + '처음부터 알고 앉는 판입니다.',
          '그래서 누구를 노릴지 고를 수 있습니다. 스택이 큰 사람을 피해 갈 수도, '
            + '값이 붙은 사람을 향해 밀어 넣을 수도 있습니다.',
        ],
        bullets: [
          '금액은 전원 같고, 대회가 끝날 때까지 바뀌지 않습니다.',
          `순위 상금과 바운티를 어떤 비율로 나눌지는 대회마다 정해집니다`
            + `(${BOUNTY_PCT_MIN}~${BOUNTY_PCT_MAX}%). 시작 전에 <b>상금 탭</b>에서 확인하세요.`,
        ],
      },
      {
        heading: '미스터리 바운티 — 잡아 봐야 압니다',
        paras: [
          '이 모드에서는 <b>머리 위에 아무것도 적히지 않습니다.</b> 저 사람이 얼마인지 '
            + '아무도 모릅니다 — 본인조차 모릅니다.',
          '누군가를 떨어뜨리면 테이블 한가운데 <b>전광판</b>이 올라옵니다. 숫자가 '
            + '정신없이 굴러가다가 — 딱 멈춥니다. 그 한순간이 그 사람 목값이 세상에 '
            + '공개되는 유일한 자리입니다.',
          '첫 판에 터진 숏스택이 잭팟을 들고 있었을 수도 있습니다. 반대로 끝까지 '
            + '살아남은 칩 리더가 알고 보니 제일 싼 목이었을 수도 있습니다.',
        ],
        bullets: [
          '금액은 <b>대회마다 새로 뽑습니다.</b> 같은 인원이라도 어제와 다릅니다 — 외울 수 없습니다.',
          '한 판에 여러 명이 터지면 <b>한 사람씩 차례로</b> 전광판이 돕니다.',
          '내 목값은 우승하면 내가 받습니다 — 끝까지 아무도 나를 잡지 못하면 그때 열립니다.',
          '빈 봉투는 없습니다. 다만 편차는 큽니다 — 아래 표를 보세요.',
        ],
      },
      {
        heading: '얼마까지 나올 수 있나',
        paras: [
          '한 사람 목값이 전체 바운티의 몇 %까지 갈 수 있는지 정해 두었습니다. '
            + '인원이 많아지면 한 사람 몫의 평균이 작아지니 범위도 같이 내려갑니다.',
        ],
        table: { head: ['참가 인원', '평균', '나올 수 있는 범위'], rows: ENV_ROWS },
        bullets: [
          `${EX_N}명이면 한 목값이 전체 바운티의 `
            + `<b>${EX_RANGE.lo}% ~ ${EX_RANGE.hi}%</b> 사이에서 나옵니다.`,
          '상한을 둔 이유가 있습니다 — 한 사람이 다 가져가 버리면 나머지 목값이 '
            + '껍데기가 되고, 그러면 "누가 그 한 명을 잡느냐" 하나로 대회가 줄어듭니다.',
        ],
      },
      {
        heading: '숫자로 보면',
        paras: [
          `${EX_N}명 · 1인당 ${p(EX_MULT)} · 바운티 몫 ${BOUNTY_PCT_DEFAULT}% 인 `
            + `대회를 예로 들어 보겠습니다.`,
        ],
        table: {
          head: ['항목', '금액', '나누는 방식'],
          rows: [
            ['총 상금', p(EX_TOTAL), `1인당 ${p(EX_MULT)} × ${EX_N}명`],
            ['순위 상금', p(EX_PRIZE), '등수로 나눕니다'],
            ['바운티', p(EX_BTY), '누구를 잡았는지로 나눕니다'],
          ],
        },
        bullets: [
          `<b>바운티 헌터</b>에서는 다섯 명 머리에 똑같이 `
            + `${p(Math.floor(EX_MULT * BOUNTY_PCT_DEFAULT / 100))}씩 걸립니다. `
            + `두 명을 잡으면 ${p(Math.floor(EX_MULT * BOUNTY_PCT_DEFAULT / 100) * 2)}, `
            + `거기서 우승까지 하면 내 목값 `
            + `${p(Math.floor(EX_MULT * BOUNTY_PCT_DEFAULT / 100))}이 돌아와 `
            + `${p(Math.floor(EX_MULT * BOUNTY_PCT_DEFAULT / 100) * 3)}. 순위 상금은 별도입니다.`,
          `<b>미스터리 바운티</b>에서는 같은 ${p(EX_BTY)}가 다섯 조각으로 무작위로 쪼개집니다 — `
            + `가장 싼 목이 ${p(Math.floor(EX_BTY * EX_RANGE.lo / 100))}, `
            + `가장 비싼 목이 ${p(Math.floor(EX_BTY * EX_RANGE.hi / 100))} 선까지 갑니다. `
            + `누가 어느 쪽인지는 잡아 봐야 압니다.`,
          '순위 상금 나누는 방식은 예전 그대로입니다 — 등수 계산이 달라지지 않았습니다.',
        ],
      },
      {
        heading: '떨어질 때는 조용히 안 나갑니다',
        paras: [
          '바운티가 걸린 대회에서는 탈락이 확정되는 순간 <b>총성이 세 번 울리고 프로필에 '
            + '총자국이 박힙니다.</b> 목에 값이 걸린 판이니 나가는 자리도 그만한 대접을 '
            + '해 드립니다.',
          '카드와 칩 정산이 전부 끝난 뒤에 시작하니 결과를 가리지는 않습니다.',
        ],
        bullets: [
          '순서는 [카드 공개 → 칩 이동 → 탈락 연출 → 목값 공개 → 획득 표시] 입니다.',
          '소리가 부담스러우면 화면 오른쪽 위 <b>음량 조절</b>로 줄이거나 끌 수 있습니다.',
        ],
      },
      {
        heading: '언제 열리나',
        paras: [
          '기존 프리롤 토너먼트는 그대로 돌아갑니다. 새 모드는 따로 열리고, '
            + '어느 모드인지는 로비의 대회 카드와 <b>상금 탭</b>에 적힙니다.',
          '참가 방법도, 시작 시각도 예전과 같습니다. 자리에 앉기만 하면 됩니다.',
        ],
        bullets: [
          '바운티가 없는 일반 대회에서는 머리 위 명찰도, 총성도 나오지 않습니다 — '
            + '예전 그대로입니다.',
        ],
      },
      {
        heading: '한마디',
        paras: [
          '이제 자리에 앉은 사람 전부가 상금입니다. 누굴 노릴지 고르고, 노려지는 것도 '
            + '감당해 보세요.',
          '해 보시고 이상하거나 아쉬운 점은 디스코드 채널로 알려 주세요. 바로 손보겠습니다.',
        ],
      },
    ],
  },
];

let added = 0, updated = 0, skipped = 0;
for (const d of DRAFTS) {
  const body = {
    date: d.date, kind: d.kind,
    // 제목 앞의 태그는 kind 에서 짓는다 — 손으로 적으면 배지와 어긋난다
    title: `[${d.kind}] ${d.title}`,
    summary: d.summary, sections: d.sections, active: true,
  };
  if (exists(d.id)) {
    if (!FORCE) { console.log('건너뜀 (이미 있음):', d.id); skipped++; continue; }
    const r = updateNotice(d.id, body);
    if (r.ok) { console.log('덮어씀:', d.id); updated++; }
    else console.log('실패:', d.id, r.error);
    continue;
  }
  const r = createNotice({ id: d.id, ...body });
  if (r.ok) { console.log('등록:', d.id, '—', body.title); added++; }
  else { console.log('실패:', d.id, r.error); process.exitCode = 1; }
}
console.log(`\n등록 ${added}건 · 덮어씀 ${updated}건 · 건너뜀 ${skipped}건`);
