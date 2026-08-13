/* 시즌 1 오픈 · 도전과제 시스템 공지 두 건.
 *
 * 같은 글을 로컬과 실서버에 똑같이 넣기 위한 스크립트다 — 손으로 옮겨 적으면 두 곳의
 * 글이 미묘하게 달라진다. 8월 8일자 스크립트(seed-notices-2026-08.ts)와 같은 틀이다.
 *
 * 실행:
 *   npx tsx scripts/seed-notices-2026-08-10.ts              (없으면 등록, 있으면 건너뜀)
 *   FORCE=1 npx tsx scripts/seed-notices-2026-08-10.ts      (이미 있어도 이 내용으로 덮어씀)
 *   DB_PATH=/data npx tsx scripts/seed-notices-2026-08-10.ts  (서버 안에서)
 *
 * 기본이 "건너뜀"인 이유: 운영자가 화면에서 고친 내용을 스크립트가 조용히 되돌리면 안 된다.
 *
 * 태그는 시스템이 정한 넷 중에서 고른다(NOTICE_KINDS: 업데이트 · 신규 · 시즌 · 점검).
 * 제목 맨 앞의 [태그]도 그 값과 같아야 한다 — 목록에서 배지와 제목이 따로 놀면 안 된다.
 * 그래서 제목은 손으로 적지 않고 아래에서 kind 로 지어 붙인다.
 *
 * 본문의 숫자는 코드에서 읽어 온다(rewardsForSeason · listAchievements). 보상표나 과제
 * 개수를 고치는 날 공지만 옛말이 되는 것을 막기 위해서다 — 지난번에 "그래프의 신"
 * 설명이 통산 기준으로 남아 있던 것과 같은 사고다.
 */
import { createNotice, updateNotice, NOTICE_KINDS, type NoticeSection } from '../src/db/notices';
import { listAchievements } from '../src/db/achievements';
import { rewardsForSeason, BUG_REPORT_BOUNTY } from '../src/services/rewards';
import { BUFF_PER_ACHIEVEMENT } from '../src/services/buff';
import { STREAK_WEEK_DAYS, STREAK_FULL_DAYS } from '../src/services/economy';
import { getDb } from '../src/db/schema';

const db = getDb();
const exists = (id: string): boolean =>
  (db.prepare(`SELECT COUNT(*) AS n FROM notices WHERE id = ?`).get(id) as { n: number }).n > 0;
const FORCE = process.env.FORCE === '1';

const p = (n: number): string => n.toLocaleString('ko-KR') + 'P';
const s0 = rewardsForSeason(0), s1 = rewardsForSeason(1);
/** 버프 가산율(%)과 본문에 쓰는 예시 개수. 둘 다 코드에서 나온 값이다. */
const buffPct = Math.round(BUFF_PER_ACHIEVEMENT * 100);
const buffEx = 10;
const ach = listAchievements();
/** 종목 수 — "12종" 같은 수치를 손으로 적지 않기 위해 표에서 센다. */
const achCount = ach.length;
const gameCount = new Set(ach.map(a => a.game_type)).size;
/* 과제 표가 비어 있으면 본문이 "0종"으로 나간다. 조용히 거짓말을 올리느니 멈추는 편이 낫다 —
   과제 표는 배포가 아니라 씨앗 스크립트로 채워지므로 순서를 거꾸로 밟기 쉽다. */
if (achCount === 0) {
  console.error('도전과제 표가 비어 있다. 먼저 scripts/seed-achievements.ts 를 돌려라.');
  process.exit(1);
}

interface Draft {
  id: string; date: string; kind: typeof NOTICE_KINDS[number];
  title: string; summary: string; sections: NoticeSection[];
}

const DRAFTS: Draft[] = [
  {
    id: '2026-08-10-season-1-open',
    date: '2026-08-10',
    kind: '시즌',
    title: `2026 정규 '시즌 1' 공식 오픈 안내`,
    summary: '8월 10일 0시를 기해 시즌 1이 시작되었습니다. 모든 지급 보상이 다섯 배로 올랐고, '
      + '참가비 토너먼트와 영구 도전과제가 함께 열립니다.',
    sections: [
      {
        heading: '오픈 일시',
        paras: ['2026년 8월 10일 0시 (KST) — 시즌 1 시작'],
        bullets: [
          '시즌 0 (오픈베타) 의 순위는 <b>종료 시점의 보유 포인트로 확정</b>되었습니다.',
          '지난 순위는 랭킹 화면 우측 상단에서 <b>시즌 0 (오픈베타)</b> 를 선택해 계속 확인하실 수 있습니다.',
          '전적·승률·순수익 등 기록은 시즌마다 새로 시작합니다. 도전과제만 예외로 계정에 영구히 남습니다.',
        ],
      },
      {
        heading: '1. 지급 보상 다섯 배 상향',
        paras: [
          '오픈베타 기간 동안 지급액이 적다는 의견을 많이 주셨습니다. '
            + '시즌 1부터 <b>모든 지급 보상을 다섯 배로 올립니다.</b>',
        ],
        table: {
          head: ['항목', '시즌 0', '시즌 1'],
          rows: [
            ['출석 체크 (평일)', p(s0.daily), p(s1.daily)],
            ['출석 체크 (주말)', p(s0.dailyWeekend), p(s1.dailyWeekend)],
            [`${STREAK_WEEK_DAYS}일 연속 개근`, p(s0.weeklyStreak), p(s1.weeklyStreak)],
            [`${STREAK_FULL_DAYS}일 연속 개근`, p(s0.fullStreak), p(s1.fullStreak)],
            ['파산 지원금', p(s0.relief), p(s1.relief)],
            ['프리롤 상금 (1인당 · 평일)', p(s0.freerollPerHead), p(s1.freerollPerHead)],
            ['프리롤 상금 (1인당 · 주말)', p(s0.freerollPerHeadWeekend), p(s1.freerollPerHeadWeekend)],
          ],
        },
        bullets: [
          '출석 연속일수는 시즌과 함께 <b>0일에서 다시 시작</b>합니다. 시작선을 모두 같게 맞추기 위해서입니다.',
          '파산 지원금은 <b>보유 포인트가 정확히 0일 때</b> 받을 수 있습니다. 재청구 간격은 종전과 같습니다.',
        ],
      },
      {
        heading: '2. 참가비 토너먼트 오픈',
        paras: [
          '프리롤과 별도로, <b>참가비를 납부하고 참가하는 정규 토너먼트</b>가 열립니다. '
            + '징수된 참가비가 그대로 상금 풀이 되므로 프리롤보다 큰 규모로 진행됩니다.',
        ],
        bullets: [
          '참가 방식(프리롤 / 바이인)과 참가비는 <b>대회마다 화면에 표시</b>되며, 신청 전에 금액을 다시 확인합니다.',
          '<b>시작 전 신청을 취소하면 전액 환불</b>됩니다.',
          '<b>인원 미달로 대회가 취소되어도 전액 환불</b>됩니다.',
          '보장 상금(GTD)이 걸린 대회는, 징수된 참가비가 보장액에 못 미칠 경우 부족분을 운영에서 충당합니다.',
          '프리롤은 그대로 유지됩니다. 참가비 토너먼트는 선택지가 하나 늘어나는 것입니다.',
        ],
      },
      {
        heading: '3. 영구 도전과제 추가',
        paras: [
          `시즌이 바뀌어도 <b>계정에 영구히 남는 도전과제</b> ${achCount}종이 함께 열립니다. `
            + '자세한 내용은 <b>[신규] 도전과제(업적) 시스템 안내</b> 공지에 적었습니다.',
        ],
      },
      {
        heading: '문의',
        paras: ['이상하거나 불편한 점은 디스코드 채널로 알려주세요. 확인하는 대로 반영하겠습니다.'],
      },
    ],
  },
  {
    id: '2026-08-10-achievements',
    date: '2026-08-10',
    kind: '신규',
    title: `'도전과제(업적)' 시스템 추가 안내`,
    summary: `시즌이 바뀌어도 사라지지 않는 영구 기록입니다. ${achCount}종이 열려 있으며, `
      + '게임으로 깨는 과제는 그 판의 베팅이 카드에 적힌 금액 이상일 때만 판정됩니다.',
    sections: [
      {
        heading: '어디서 보나요',
        paras: ['상단 <b>도전과제</b> 탭에서 전체 목록과 달성률을 확인하실 수 있습니다.'],
      },
      {
        heading: '1. 시즌이 바뀌어도 남습니다',
        paras: [
          '전적·승률·순수익·랭킹은 시즌이 끝나면 모두 0에서 다시 시작합니다. '
            + '<b>도전과제만 예외</b>로, 한 번 달성하면 계정에 영구히 남습니다.',
        ],
        bullets: [
          '달성한 날짜가 카드에 함께 기록됩니다.',
          '카드 아래에 <b>누가 달성했는지</b>가 표시됩니다. 눌러서 전체 명단을 보실 수 있습니다.',
          '이미 달성한 과제는 다시 달성되지 않습니다.',
        ],
      },
      {
        heading: '2. 최소 베팅 금액 기준',
        paras: [
          '게임으로 깨는 과제는 <b>그 판의 베팅이 기준 금액 이상일 때만</b> 판정됩니다. '
            + '소액으로 수천 번 돌려 긁어내는 것을 막기 위한 규칙입니다. '
            + '그렇게 되면 과제가 "무엇을 해냈나"가 아니라 "얼마나 오래 눌렀나"의 기록이 되기 때문입니다.',
        ],
        bullets: [
          '기준 금액은 <b>카드마다 다르며 카드에 그대로 적혀 있습니다</b>. 대부분 1,000P 이상입니다.',
          '베팅과 관계없는 과제(예: 프리롤·지원금)에는 기준이 없으며, 카드에도 표시되지 않습니다.',
          '기준에 못 미치는 판에서 조건을 만족해도 달성되지 않습니다. 금액을 확인한 뒤 도전해 주세요.',
        ],
      },
      {
        heading: '3. 종목',
        paras: [
          `현재 <b>${achCount}종</b>이 열려 있고, <b>${gameCount}개 분류</b>에 나뉘어 있습니다. `
            + '도전과제 화면 상단의 분류 탭으로 게임별로 나눠 보실 수 있습니다.',
        ],
        bullets: [
          '<b>홀덤 프리롤</b> · <b>블랙잭</b> · <b>포커 플립</b> · <b>지뢰찾기</b> · '
            + '<b>그래프게임</b> · <b>사다리게임</b> 그리고 게임과 무관한 <b>공통</b> 과제가 있습니다.',
          '조건을 밝히지 않은 <b>히든 과제</b>도 있습니다. 이름과 조건은 달성 전까지 가려져 있지만, '
            + '<b>누가 달성했는지는 볼 수 있습니다</b>.',
          '과제는 앞으로도 계속 추가됩니다.',
        ],
      },
      {
        heading: '4. 달성하면',
        paras: [
          '조건을 만족하는 순간 화면에 알림이 뜨고, 상단 알림함에도 함께 쌓입니다. '
            + '판이 끝나는 그 자리에서 판정되므로 따로 받아야 할 것은 없습니다.',
        ],
      },
      {
        heading: '문의',
        paras: [
          '조건을 만족했는데 달성되지 않았다면 <b>그 판의 베팅 금액</b>을 먼저 확인해 주세요. '
            + '그래도 이상하면 디스코드 채널로 알려주시면 기록을 확인해 드리겠습니다.',
        ],
      },
    ],
  },
  {
    id: '2026-08-10-buff-and-streak',
    date: '2026-08-10',
    /* 태그는 [업데이트] 다. 요청서의 예시는 [패치노트] 였지만 이 시스템의 태그는 넷뿐이고
       (업데이트 · 신규 · 시즌 · 점검), 없는 값을 넣으면 등록 자체가 거절된다.
       세 항목 중 둘이 "있던 것이 바뀐다"라서 이 서비스의 정의상 업데이트가 맞다. */
    kind: '업데이트',
    title: '도전과제 보상 버프 도입 · 개근 기준 변경 · 제보 보상 상향',
    summary: `도전과제 하나당 출석·지원금 보상이 ${buffPct}% 늘어납니다. `
      + `개근상 기준이 ${STREAK_FULL_DAYS}일로 완화되고, 제보 보상은 ${p(BUG_REPORT_BOUNTY)}로 올랐습니다.`,
    sections: [
      {
        heading: '적용 일시',
        paras: [`2026년 8월 10일 (KST) — 적용 완료`],
      },
      {
        heading: '1. 도전과제 보상 버프',
        paras: [
          `달성한 도전과제 <b>하나당 ${buffPct}%</b>씩, 받으시는 보상이 늘어납니다. `
            + '도전과제를 깨 둘수록 매일 받는 보상이 계속 커집니다.',
        ],
        bullets: [
          `<b>적용 대상</b> — 출석 체크(일일 · ${STREAK_WEEK_DAYS}일 개근 · ${STREAK_FULL_DAYS}일 개근)와 `
            + '파산 지원금입니다.',
          `<b>계산</b> — 합연산입니다. ${buffEx}개를 달성했다면 기본 보상의 `
            + `<b>${Math.round((1 + buffEx * BUFF_PER_ACHIEVEMENT) * 100)}%</b>를 받습니다 — `
            + `${p(s1.daily)} 항목이라면 ${p(Math.floor(s1.daily * (1 + buffEx * BUFF_PER_ACHIEVEMENT)))}입니다.`,
          '<b>게임 배당에는 적용되지 않습니다.</b> 배당에 붙으면 사람마다 게임의 확률이 달라지므로, '
            + '지급 보상에만 붙습니다.',
          '도전과제는 시즌이 바뀌어도 사라지지 않으므로, <b>이 버프도 계속 유지</b>됩니다.',
          '적용 중인 버프는 로비의 <b>연속 출석</b> 칸과 출석·지원금 수령 메시지에 함께 표시됩니다.',
        ],
      },
      {
        heading: `2. 개근상 기준 ${STREAK_FULL_DAYS}일로 완화`,
        paras: [
          `개근상 달성 기준을 <b>30일에서 ${STREAK_FULL_DAYS}일로</b> 완화했습니다. `
            + `${STREAK_FULL_DAYS}일은 정확히 ${STREAK_FULL_DAYS / STREAK_WEEK_DAYS}주라, `
            + '어느 요일에 시작해도 같은 요일에 받게 됩니다.',
        ],
        bullets: [
          `<b>${STREAK_WEEK_DAYS}일 개근</b> +${p(s1.weeklyStreak)} · `
            + `<b>${STREAK_FULL_DAYS}일 개근</b> +${p(s1.fullStreak)}`,
          `${STREAK_FULL_DAYS}일째는 ${STREAK_WEEK_DAYS}일 개근 조건과도 겹치는 날입니다. `
            + `그날은 <b>중복 지급되지 않고 ${STREAK_FULL_DAYS}일 개근상만</b> 단일 지급됩니다 — `
            + `더 큰 쪽이 나갑니다.`,
          '연속일수가 끊기면 1일부터 다시 시작합니다. 출석은 KST 자정에 초기화됩니다.',
        ],
      },
      {
        heading: '3. 버그·개선 제보 보상 5배 상향',
        paras: [
          `OD CASINO 를 함께 고쳐 주시는 분들을 위해, 버그와 개선 의견 제보 보상을 `
            + `기존 2,000P 에서 <b>${p(BUG_REPORT_BOUNTY)}</b> 로 다섯 배 올립니다.`,
        ],
        bullets: [
          '디스코드 채널로 알려주시면 확인 후 지급합니다.',
          '<b>재현 방법</b>(어떤 화면에서 무엇을 눌렀을 때 어떻게 됐는지)이 함께 있으면 큰 도움이 됩니다.',
          '이미 알려진 문제이거나 재현되지 않는 경우에는 지급되지 않을 수 있습니다.',
        ],
      },
      {
        heading: '문의',
        paras: ['이상하거나 불편한 점은 디스코드 채널로 알려주세요. 확인하는 대로 반영하겠습니다.'],
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
