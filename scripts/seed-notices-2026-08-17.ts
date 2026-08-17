/* 공지 한 건 — 채팅 기능 출시.
 *
 * 같은 글을 로컬과 실서버에 똑같이 넣기 위한 스크립트다 — 손으로 옮겨 적으면 두 곳의
 * 글이 미묘하게 달라진다. 8월 13일자 스크립트와 같은 틀이다.
 *
 * 실행:
 *   npx tsx scripts/seed-notices-2026-08-17.ts              (없으면 등록, 있으면 건너뜀)
 *   FORCE=1 npx tsx scripts/seed-notices-2026-08-17.ts      (이미 있어도 이 내용으로 덮어씀)
 *   DB_PATH=/data npx tsx scripts/seed-notices-2026-08-17.ts  (서버 안에서)
 *
 * 본문의 숫자는 코드에서 읽어 온다(길이 상한 · 도배 문지기 · 보관 줄 수). 규칙을 고치는
 * 날 공지만 옛말이 되는 것을 막기 위해서다 — 지난번에 "그래프의 신" 설명이 통산 기준으로
 * 남아 있던 것과 같은 사고다.
 *
 * 주의: createNotice 는 active 로 넣으면 디스코드 공지 웹훅을 쏜다. updateNotice 는
 * 쏘지 않으므로, 글만 고칠 때는 FORCE=1 로 돌리면 채널이 조용하다.
 */
import { createNotice, updateNotice, NOTICE_KINDS, type NoticeSection } from '../src/db/notices';
import {
  CHAT_MAX_LEN, CHAT_KEEP, CHAT_BURST, CHAT_BURST_MS,
} from '../src/db/queries/chat';
import { getDb } from '../src/db/schema';

const db = getDb();
const exists = (id: string): boolean =>
  (db.prepare(`SELECT COUNT(*) AS n FROM notices WHERE id = ?`).get(id) as { n: number }).n > 0;
const FORCE = process.env.FORCE === '1';

const BURST_SEC = Math.round(CHAT_BURST_MS / 1000);

interface Draft {
  id: string; date: string; kind: typeof NOTICE_KINDS[number];
  title: string; summary: string; sections: NoticeSection[];
}

const DRAFTS: Draft[] = [
  {
    id: '2026-08-17-chat',
    date: '2026-08-17',
    kind: '신규',
    title: '채팅 기능이 추가되었습니다',
    summary: '게임을 하면서 채팅할 수 있습니다. 화면 오른쪽 아래에 있고, '
      + '홀덤 테이블에서는 말한 사람 자리 위에 말풍선이 뜹니다.',
    sections: [
      {
        heading: '우측하단에서 바로',
        paras: [
          '게임을 하면서 채팅할 수 있는 기능이 추가되었습니다. 접혀 있을 때도 '
            + '<b>마지막으로 오간 말이 보이고</b>, 누르면 펼쳐집니다.',
        ],
        bullets: [
          '<b>방은 하나입니다.</b> 어느 게임에 있든 같은 대화가 보이고, 줄마다 '
            + '[홀덤] [바카라] 처럼 어디서 말했는지 붙습니다.',
          '안 읽은 말이 있으면 <b>숫자가 깜빡입니다.</b> 화면을 옮겨도 읽은 지점을 기억합니다.',
          '랭킹 통합 순위 <b>1~3위</b>는 이름 앞에 메달(🥇 🥈 🥉)이 붙습니다.',
        ],
      },
      {
        heading: '홀덤 테이블에서는 자리 위에 뜹니다',
        bullets: [
          '말한 분의 자리 위에 <b>4초간</b> 말풍선이 뜹니다. 카드나 칩은 가리지 않습니다.',
          '긴 말은 <b>세 줄까지</b> 보입니다. 전체는 채팅창에 그대로 남습니다.',
          '<b>폴드해도</b> 말풍선은 그대로 뜹니다. 자리는 흐려져도 말은 안 흐려집니다.',
          '탈락한 뒤에도 <b>관전하면서 채팅할 수 있습니다.</b>',
        ],
      },
      {
        heading: '규칙',
        bullets: [
          `한 번에 <b>${CHAT_MAX_LEN}자</b>까지, <b>${BURST_SEC}초에 ${CHAT_BURST}줄</b>까지 `
            + `보낼 수 있습니다.`,
          `최근 <b>${CHAT_KEEP}줄</b>이 남고 그보다 오래된 말은 사라집니다.`,
          '보기 어려운 말은 운영진이 가릴 수 있습니다. '
            + '<b>게임과 포인트에는 아무 영향이 없습니다.</b>',
        ],
      },
      {
        heading: '피드백 주세요',
        paras: [
          '써 보시고 불편하거나 아쉬운 점은 디스코드 채널로 남겨 주세요. '
            + '피드백 주시면 반영하겠습니다.',
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
