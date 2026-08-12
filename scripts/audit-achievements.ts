/* 도전과제 · 알림 감사.
 *
 * 이 두 가지는 판을 돌리지 않아도 확인할 수 있는 규칙이 대부분이라 db 계층에서 직접 본다.
 * 특히 두 가지를 확실히 해 둔다 —
 *   · 달성 기록이 시즌 리셋에도 남는가 (요구사항에서 "절대 초기화되지 않는다"고 못 박은 것)
 *   · 전체 알림의 읽음이 사람마다 따로 매겨지는가 (한 줄을 여럿이 보는 구조라 틀리기 쉽다)
 */
if (!process.env.DB_PATH) {
  const os = require('node:os'), path = require('node:path'), fsx = require('node:fs');
  process.env.DB_PATH = fsx.mkdtempSync(path.join(os.tmpdir(), 'casino-audit-'));
}

import { getDb } from '../src/db/schema';
import * as Q from '../src/db/queries';
import * as A from '../src/db/achievements';
import * as N from '../src/db/notifications';
import * as S from '../src/db/queries/season';
import { createNotice } from '../src/db/notices';
import { grantPoints } from '../src/db/admin';

const db = getDb();
let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
function section(s: string): void { console.log('\n' + s); }

/* 씨앗 스크립트를 다시 돌린다. require 는 한 번만 실행되므로(모듈 캐시) 표를 비운 뒤에
   다시 부르려면 캐시를 지워야 한다 — 처음에 그걸 안 해서 두 번째부터는 빈 표에 대고
   검사하고 있었고, 그 검사들이 전부 조용히 실패했다. */
function seedForWiring(): void {
  process.env.QUIET = '1';              // 씨앗의 출력이 검사 결과를 덮지 않게 한다
  delete require.cache[require.resolve('./seed-achievements')];
  require('./seed-achievements');
}

function wipe(): void {
  db.exec(`DELETE FROM achievements; DELETE FROM user_achievements;
           DELETE FROM notifications; DELETE FROM notification_reads;`);
}
function mkUser(id: string, bal = 10_000): void {
  Q.upsertUser(id, id, null);
  const cur = Q.getWebUser(id)?.balance ?? 0;
  if (cur !== bal) Q.adjustBalance(id, bal - cur, 'audit:seed');
}

async function main(): Promise<void> {
  /* ── 1. 목록과 진행률 ────────────────────────────────────────── */
  section('[1] 도전과제 — 목록 · 진행률');
  {
    wipe();
    mkUser('a1');
    ck('과제가 없으면 목록도 비어 있다', A.achievementsFor('a1').length === 0);
    const p0 = A.achievementProgress(A.achievementsFor('a1'));
    ck('0개일 때 진행률은 0% (0으로 나누지 않는다)', p0.percent === 0 && p0.total === 0);

    A.upsertAchievement({ id: 'ho-1', gameType: 'HOLDEM', title: '첫 우승', description: '한 번 이긴다' });
    A.upsertAchievement({ id: 'bj-1', gameType: 'BLACKJACK', title: '블랙잭', description: '21' });
    A.upsertAchievement({ id: 'mi-1', gameType: 'MINES', title: '지뢰', description: '피한다' });
    A.upsertAchievement({ id: 'al-1', gameType: 'ALL', title: '출석', description: '온다' });
    ck('넣은 만큼 목록에 나온다', A.achievementsFor('a1').length === 4);

    A.unlockAchievement('a1', 'ho-1');
    const p1 = A.achievementProgress(A.achievementsFor('a1'));
    ck('달성 1/4', p1.unlocked === 1 && p1.total === 4, `${p1.unlocked}/${p1.total}`);
    /* 25%가 정확히 나와야 한다. 1/3 처럼 안 떨어지는 값은 내려야 한다 —
       11/12 를 92%로 올리면 다 한 사람과 구분이 안 된다. */
    ck('진행률은 25%', p1.percent === 25, String(p1.percent));
    A.upsertAchievement({ id: 'x-1', gameType: 'ALL', title: 'x', description: '' });
    A.upsertAchievement({ id: 'x-2', gameType: 'ALL', title: 'y', description: '' });
    const p2 = A.achievementProgress(A.achievementsFor('a1'));
    ck('1/6 은 내려서 16%', p2.percent === 16, String(p2.percent));
  }

  /* ── 2. 감춘 과제 ───────────────────────────────────────────── */
  section('[2] 히든 과제 — 달성 전에는 응답에도 없어야 한다');
  {
    wipe();
    mkUser('a2');
    A.upsertAchievement({
      id: 'sec-1', gameType: 'CRASH', title: '김재원의 행보',
      description: '1.01배에서 캐시아웃한다', isHidden: true,
    });
    const before = A.achievementsFor('a2')[0];
    /* 감추는 것은 "무엇을 해야 하나"뿐이다. 제목은 보여준다 — 제목까지 가리면 카드가
       잠긴 칸 하나일 뿐이어서 찾아볼 마음이 안 생기고, 제목으로 조건을 추리하는 것이
       이 과제의 재미다.

       설명은 화면에서 가리는 것으로는 안 된다 — 응답에 들어 있으면 개발자 도구로 그대로
       읽힌다. 그래서 db 계층에서 지운다. */
    ck('달성 전에도 제목은 보인다', before.title === '김재원의 행보', before.title);
    ck('달성 전에는 조건이 응답에 없다', !JSON.stringify(before).includes('1.01'),
      JSON.stringify(before));
    ck('가림 문구가 나온다', before.description === A.HIDDEN_DESC, before.description);
    ck('가림 문구에 자물쇠가 있다', A.HIDDEN_DESC.startsWith('🔒'), A.HIDDEN_DESC);
    ck('가림 문구가 추리를 권한다', A.HIDDEN_DESC.includes('제목을 보고 추리'), A.HIDDEN_DESC);

    A.unlockAchievement('a2', 'sec-1');
    const after = A.achievementsFor('a2')[0];
    ck('달성해도 제목은 그대로다', after.title === '김재원의 행보', after.title);
    ck('달성하면 원래 설명으로 바뀐다', after.description.includes('1.01'), after.description);
    ck('달성 일자가 실려 온다', after.unlockedAt != null && after.unlocked);

    // 남의 화면에서는 설명이 여전히 가려져 있어야 한다
    mkUser('a2b');
    ck('남에게는 설명이 여전히 가려진다',
      A.achievementsFor('a2b')[0].description === A.HIDDEN_DESC);
    ck('남에게도 제목은 보인다', A.achievementsFor('a2b')[0].title === '김재원의 행보');
    ck('로그인 안 한 화면에서도 설명만 가린다',
      A.achievementsFor(null)[0].description === A.HIDDEN_DESC
      && A.achievementsFor(null)[0].title === '김재원의 행보');
  }

  /* ── 3. 달성 처리 ───────────────────────────────────────────── */
  section('[3] 달성 — 두 번 주지 않는다 · 최소 베팅');
  {
    wipe();
    mkUser('a3');
    A.upsertAchievement({ id: 'g-1', gameType: 'MINES', title: '한 번', description: '', minBet: 100 });
    ck('처음 달성은 true', A.unlockAchievement('a3', 'g-1').unlocked);
    ck('두 번째 달성은 false', !A.unlockAchievement('a3', 'g-1').unlocked);
    ck('기록은 한 줄뿐', (db.prepare(
      `SELECT COUNT(*) AS n FROM user_achievements WHERE user_id = 'a3'`).get() as { n: number }).n === 1);
    ck('없는 과제는 달성되지 않는다', !A.unlockAchievement('a3', 'no-such').unlocked);

    /* 최소 베팅 미들웨어. 1P씩 수천 번 돌려 긁어내는 것을 막는 장치라,
       여기가 뚫리면 과제가 "얼마나 오래 눌렀나"의 기록이 된다. */
    wipe();
    A.upsertAchievement({ id: 'm-1', gameType: 'MINES', title: '큰 판', description: '', minBet: 100 });
    let ran = 0;
    const meets = (): boolean => { ran++; return true; };
    ck('99P 는 판정하지 않는다', !A.awardIfBet('a3', 'm-1', 99, meets).unlocked);
    ck('미달이면 조건 함수도 안 돈다', ran === 0, String(ran));
    ck('100P 는 판정한다', A.awardIfBet('a3', 'm-1', 100, meets).unlocked);
    ck('조건 함수가 한 번 돌았다', ran === 1, String(ran));
    ck('이미 달성했으면 다시 안 돈다', !A.awardIfBet('a3', 'm-1', 1000, meets).unlocked && ran === 1,
      String(ran));

    // 조건을 만족하지 않으면 베팅이 충분해도 안 준다
    wipe();
    A.upsertAchievement({ id: 'm-2', gameType: 'MINES', title: '조건', description: '' });
    ck('조건이 거짓이면 안 준다', !A.awardIfBet('a3', 'm-2', 10_000, () => false).unlocked);
    // 과제마다 기준이 다를 수 있다
    wipe();
    A.upsertAchievement({ id: 'm-3', gameType: 'CRASH', title: '고액', description: '', minBet: 5_000 });
    ck('과제별 최소 베팅이 적용된다', !A.awardIfBet('a3', 'm-3', 4_999, () => true).unlocked);
    ck('그 기준을 넘으면 준다', A.awardIfBet('a3', 'm-3', 5_000, () => true).unlocked);
  }

  /* ── 4. 시즌 리셋 ───────────────────────────────────────────── */
  section('[4] 영구 기록 — 시즌이 바뀌어도 남는가');
  {
    wipe();
    mkUser('a4', 50_000);
    A.upsertAchievement({ id: 'p-1', gameType: 'ALL', title: '영구', description: '' });
    A.unlockAchievement('a4', 'p-1');
    const at = A.achievementsFor('a4')[0].unlockedAt;
    ck('달성 상태다', A.achievementsFor('a4')[0].unlocked);

    /* 실제로 시즌을 닫는다. "closeSeason 이 이 표를 안 건드린다"를 코드를 읽어 확인하는
       것으로는 부족하다 — 나중에 그 함수에 DELETE 한 줄이 늘어도 아무도 모른다. */
    db.exec(`DELETE FROM seasons`);
    db.prepare(`INSERT INTO seasons (number, name, reward, started_at) VALUES (1, 's1', '', 0)`).run();
    const closed = S.closeSeason({ seed: 10_000 });
    ck('시즌이 닫혔다', closed.ok, JSON.stringify(closed));
    ck('잔액은 초기화됐다 (검사 전제)', Q.getWebUser('a4')!.balance === 10_000,
      String(Q.getWebUser('a4')!.balance));
    ck('달성 기록은 그대로 남는다', A.achievementsFor('a4')[0].unlocked);
    ck('달성 시각도 그대로다', A.achievementsFor('a4')[0].unlockedAt === at);
    ck('기록 줄 수가 그대로다', (db.prepare(
      `SELECT COUNT(*) AS n FROM user_achievements WHERE user_id = 'a4'`).get() as { n: number }).n === 1);
  }

  /* ── 5. 알림 — 개인 ─────────────────────────────────────────── */
  section('[5] 알림 — 개인 알림은 그 사람만');
  {
    wipe();
    mkUser('n1'); mkUser('n2');
    N.notifyUser('n1', 'SYSTEM', '제목', '내용');
    ck('받은 사람에게 하나', N.listNotifications('n1').length === 1);
    ck('안 읽음 1', N.unreadCount('n1') === 1, String(N.unreadCount('n1')));
    ck('남에게는 안 보인다', N.listNotifications('n2').length === 0);
    ck('남의 안 읽음은 0', N.unreadCount('n2') === 0);

    const id = N.listNotifications('n1')[0].id;
    /* 남의 알림을 id 만 바꿔 가며 읽음으로 만들 수 있으면 안 된다 */
    N.markRead('n2', id);
    ck('남이 읽어도 내 안 읽음은 그대로', N.unreadCount('n1') === 1, String(N.unreadCount('n1')));
    N.markRead('n1', id);
    ck('본인이 읽으면 0', N.unreadCount('n1') === 0);
    ck('읽은 뒤에도 목록에는 남는다', N.listNotifications('n1').length === 1);
    ck('읽음 표시가 붙었다', N.listNotifications('n1')[0].read);
  }

  /* ── 6. 알림 — 전체 ─────────────────────────────────────────── */
  section('[6] 알림 — 전체 알림의 읽음은 사람마다');
  {
    wipe();
    mkUser('b1'); mkUser('b2');
    N.notifyAll('ANNOUNCEMENT', '공지', '내용');
    ck('전체 알림은 줄 하나만 만든다', (db.prepare(
      `SELECT COUNT(*) AS n FROM notifications`).get() as { n: number }).n === 1);
    ck('b1 에게 보인다', N.listNotifications('b1').length === 1);
    ck('b2 에게도 보인다', N.listNotifications('b2').length === 1);
    ck('둘 다 안 읽음 1', N.unreadCount('b1') === 1 && N.unreadCount('b2') === 1);

    /* 여기가 이 구조에서 제일 틀리기 쉬운 자리다. 줄에 달린 is_read 하나로 처리하면
       b1 이 읽는 순간 b2 의 배지까지 사라진다. */
    N.markAllRead('b1');
    ck('b1 은 읽음', N.unreadCount('b1') === 0, String(N.unreadCount('b1')));
    ck('b2 는 여전히 안 읽음', N.unreadCount('b2') === 1, String(N.unreadCount('b2')));
    ck('b1 목록에는 읽음으로 나온다', N.listNotifications('b1')[0].read);
    ck('b2 목록에는 안 읽음으로 나온다', !N.listNotifications('b2')[0].read);
    N.markAllRead('b1');
    ck('두 번 읽어도 터지지 않는다', N.unreadCount('b1') === 0);

    /* 여는 것과 정리하는 것은 다르다. 열었다고 목록까지 비면 읽을 새도 없이 사라진다. */
    ck('읽음만으로는 목록에 남는다', N.listNotifications('b1').length === 1,
      String(N.listNotifications('b1').length));
  }

  /* ── 6-1. 치우기 ────────────────────────────────────────────── */
  section('[6-1] 알림 — [모두 지우기]는 목록에서 뺀다');
  {
    wipe();
    mkUser('d1'); mkUser('d2');
    N.notifyAll('ANNOUNCEMENT', '전체', '내용');
    N.notifyUser('d1', 'POINT_GIFT', '개인', '+100P');
    ck('둘 다 보인다 (검사 전제)', N.listNotifications('d1').length === 2,
      String(N.listNotifications('d1').length));

    N.dismissAll('d1');
    ck('치우면 목록이 빈다', N.listNotifications('d1').length === 0,
      String(N.listNotifications('d1').length));
    ck('안 읽음도 0', N.unreadCount('d1') === 0);
    /* 전체 알림은 한 줄을 여럿이 보므로 지울 수가 없다 — 치움은 사람에게 달린 표시다 */
    ck('남의 목록은 그대로', N.listNotifications('d2').length === 1,
      String(N.listNotifications('d2').length));
    ck('남의 안 읽음도 그대로', N.unreadCount('d2') === 1);
    ck('줄 자체는 남아 있다', (db.prepare(
      `SELECT COUNT(*) AS n FROM notifications`).get() as { n: number }).n === 2);

    // 새로 오는 것은 당연히 다시 쌓인다 — 치움은 그때까지 온 것에만 붙는 표시다
    N.notifyUser('d1', 'SYSTEM', '새 알림', '내용');
    ck('치운 뒤 온 알림은 보인다', N.listNotifications('d1').length === 1);
    ck('배지도 다시 올라간다', N.unreadCount('d1') === 1);
    N.dismissAll('d1');
    ck('두 번 치워도 터지지 않는다', N.listNotifications('d1').length === 0);

    // 치운 공지는 팝업도 뜨지 않는다
    wipe();
    N.notifyAll('ANNOUNCEMENT', '공지', '내용');
    ck('치우기 전에는 팝업 대상', N.popupNotifications('d1').length === 1);
    N.dismissAll('d1');
    ck('치우면 팝업하지 않는다', N.popupNotifications('d1').length === 0);
  }

  /* ── 7. 새로 온 사람 ────────────────────────────────────────── */
  section('[7] 알림 — 가입 전 전체 알림은 안 쌓인다');
  {
    wipe();
    N.notifyAll('ANNOUNCEMENT', '옛 공지', '내용');
    db.prepare(`UPDATE notifications SET created_at = created_at - 86400`).run();
    mkUser('late');
    /* 오늘 처음 들어온 사람의 종에 지난 반년치 공지가 전부 안 읽음으로 달리면,
       새 소식을 알리려고 만든 것이 새 사람에게는 청소해야 할 목록이 된다. */
    ck('가입 전 전체 알림은 안 보인다', N.listNotifications('late').length === 0,
      String(N.listNotifications('late').length));
    ck('안 읽음도 0', N.unreadCount('late') === 0);
    N.notifyAll('ANNOUNCEMENT', '새 공지', '내용');
    ck('가입 후 것은 보인다', N.listNotifications('late').length === 1);
  }

  /* ── 7-1. 공지 팝업 ─────────────────────────────────────────── */
  section('[7-1] 알림 — 하루 안의 안 읽은 공지만 팝업');
  {
    wipe();
    mkUser('p1');
    N.notifyAll('ANNOUNCEMENT', '새 공지사항', '오늘 것');
    ck('오늘 공지는 팝업 대상', N.popupNotifications('p1').length === 1,
      String(N.popupNotifications('p1').length));

    /* 사흘 뒤에 들어온 사람에게 튀어나오면 그건 새 소식이 아니라 방해다.
       유저의 가입 시각도 같이 민다 — 공지만 밀면 "가입 전 공지"가 되어 목록에서도
       빠지고, 그러면 팝업이 아니라 가입 규칙을 검사하게 된다. */
    db.prepare(`UPDATE notifications SET created_at = created_at - ?`).run(N.POPUP_WINDOW_SEC + 60);
    db.prepare(`UPDATE users SET created_at = created_at - ? WHERE id = 'p1'`)
      .run(N.POPUP_WINDOW_SEC + 120);
    ck('하루가 지난 공지는 팝업하지 않는다', N.popupNotifications('p1').length === 0);
    ck('그래도 종에는 남는다', N.listNotifications('p1').length === 1);

    /* 종을 열어 본 사람에게 다시 튀어나오면 안 읽은 것을 알리는 장치가 아니라
       그냥 반복 재생이 된다 */
    wipe();
    N.notifyAll('ANNOUNCEMENT', '새 공지사항', '읽을 것');
    ck('안 읽었으면 팝업', N.popupNotifications('p1').length === 1);
    N.markAllRead('p1');
    ck('읽으면 팝업하지 않는다', N.popupNotifications('p1').length === 0);

    /* 공지만 튀어나온다. 달성은 그 순간에 이미 띄웠고, 포인트는 받은 사실이 잔액에
       남아 있어 놓쳐도 사라지지 않는다 — 공지는 안 보면 그냥 지나간다. */
    wipe();
    A.upsertAchievement({ id: 'pop-a', gameType: 'ALL', title: '과제', description: '' });
    A.unlockAchievement('p1', 'pop-a');
    N.notifyUser('p1', 'POINT_GIFT', '포인트', '+100P');
    N.notifyUser('p1', 'SYSTEM', '시스템', '점검');
    ck('달성·지급·시스템은 팝업 대상이 아니다', N.popupNotifications('p1').length === 0,
      JSON.stringify(N.popupNotifications('p1').map(x => x.type)));
    ck('그것들도 종에는 남는다', N.listNotifications('p1').length === 3,
      String(N.listNotifications('p1').length));

    // 개인 공지도 같은 규칙을 따른다
    wipe();
    N.notifyUser('p1', 'ANNOUNCEMENT', '개인 공지', '내용');
    ck('개인 공지도 팝업 대상', N.popupNotifications('p1').length === 1);
    ck('남에게는 팝업하지 않는다', (mkUser('p2'), N.popupNotifications('p2').length === 0));

    // 가입 전 공지는 팝업도 목록도 없다
    wipe();
    N.notifyAll('ANNOUNCEMENT', '옛 공지', '내용');
    db.prepare(`UPDATE notifications SET created_at = created_at - 600`).run();
    mkUser('p3');
    ck('가입 전 공지는 팝업하지 않는다', N.popupNotifications('p3').length === 0);
  }

  /* ── 8. 세 갈래 연동 ────────────────────────────────────────── */
  section('[8] 연동 — 공지 · 포인트 지급 · 달성');
  {
    wipe();
    db.exec(`DELETE FROM notices`);
    mkUser('c1');
    createNotice({
      id: 'audit-notice-1', date: '2026-08-09', kind: '업데이트',
      title: '테스트 공지', summary: '요약', active: true,
      sections: [{ heading: '바뀐 점', bullets: ['한 줄'] }],
    });
    const an = N.listNotifications('c1').filter(n => n.type === 'ANNOUNCEMENT');
    ck('공지를 올리면 전체 알림이 생긴다', an.length === 1, String(an.length));
    ck('알림에 공지 제목이 담긴다', an[0]?.message.includes('테스트 공지'), an[0]?.message);
    ck('누르면 그 공지로 간다', an[0]?.link === '/notices/audit-notice-1', String(an[0]?.link));

    /* 숨김으로 올린 글은 아직 보여줄 준비가 안 된 글이다 — 알리면 눌러도 볼 것이 없다. */
    createNotice({
      id: 'audit-notice-2', date: '2026-08-09', kind: '업데이트',
      title: '숨긴 공지', summary: '요약', active: false,
      sections: [{ heading: '바뀐 점', bullets: ['한 줄'] }],
    });
    ck('숨김 공지는 알리지 않는다',
      N.listNotifications('c1').filter(n => n.type === 'ANNOUNCEMENT').length === 1);

    const before = Q.getWebUser('c1')!.balance;
    grantPoints('c1', 2_000, '오픈베타 참여 감사');
    const gift = N.listNotifications('c1').filter(n => n.type === 'POINT_GIFT');
    ck('포인트를 주면 알림이 생긴다', gift.length === 1, String(gift.length));
    /* 사유가 없으면 받은 쪽은 그것이 선물인지 정산 오류인지 알 수 없다 */
    ck('사유가 알림에 담긴다', gift[0]?.message.includes('오픈베타 참여 감사'), gift[0]?.message);
    ck('금액도 담긴다', gift[0]?.message.includes('2,000P'), gift[0]?.message);
    ck('잔액도 실제로 늘었다', Q.getWebUser('c1')!.balance === before + 2_000);
    // 회수도 알린다 — 조용히 줄어드는 쪽이 훨씬 나쁘다
    grantPoints('c1', -500, '중복 지급 정정');
    const back = N.listNotifications('c1').filter(n => n.type === 'POINT_GIFT');
    ck('회수도 알린다', back.length === 2, String(back.length));
    ck('회수 알림에 사유가 담긴다', back[0]?.message.includes('중복 지급 정정'), back[0]?.message);

    A.upsertAchievement({ id: 'n-ach', gameType: 'ALL', title: '알림 과제', description: '' });
    A.unlockAchievement('c1', 'n-ach');
    const ach = N.listNotifications('c1').filter(n => n.type === 'ACHIEVEMENT');
    ck('달성하면 알림이 생긴다', ach.length === 1, String(ach.length));
    ck('달성 알림에 과제 이름이 담긴다', ach[0]?.message === '알림 과제', ach[0]?.message);
    ck('두 번째 달성은 알림도 안 만든다',
      (A.unlockAchievement('c1', 'n-ach'), N.listNotifications('c1')
        .filter(n => n.type === 'ACHIEVEMENT').length) === 1);
  }

  /* ── 8-1. 대회 알림 ─────────────────────────────────────────── */
  section('[8-1] 대회 — 등록 시작 · 우승');
  {
    const HD = require('../src/db/holdem') as typeof import('../src/db/holdem');
    const AD = require('../src/db/admin') as typeof import('../src/db/admin');
    const nowSec = (): number => Math.floor(Date.now() / 1000);
    const clear = (): void => {
      db.exec(`DELETE FROM holdem_hand_seats; DELETE FROM holdem_hands;
               DELETE FROM holdem_seats; DELETE FROM holdem_tables;
               DELETE FROM holdem_entries; DELETE FROM holdem_tournaments;`);
    };
    const tourNotis = (u: string, type: string): number =>
      N.listNotifications(u, 100).filter(n => n.type === type).length;

    wipe(); clear();
    mkUser('t1');
    /* 등록 창이 아직 안 열린 판. advanceHoldem 이 몇 번 돌아도 알림이 없어야 한다 —
       "곧 열린다"를 미리 알리면 가 봐야 신청 버튼이 잠겨 있다. */
    AD.createTournament({ title: '예약 판', regOpenAt: nowSec() + 3600, startAt: nowSec() + 7200 });
    HD.advanceHoldem();
    ck('등록 전에는 알리지 않는다', tourNotis('t1', 'TOURNAMENT_OPEN') === 0);

    /* 창이 열린다. 이 게임에는 서버 타이머가 없어서 판정이 요청마다 도는데,
       한 번 참이 되면 계속 참이라 표시가 없으면 요청마다 알림이 나간다. */
    wipe(); clear();
    AD.createTournament({ title: '열린 판', regOpenAt: nowSec() - 60, startAt: nowSec() + 3600 });
    HD.advanceHoldem();
    ck('등록이 열리면 알린다', tourNotis('t1', 'TOURNAMENT_OPEN') === 1,
      String(tourNotis('t1', 'TOURNAMENT_OPEN')));
    for (let i = 0; i < 5; i++) HD.advanceHoldem();
    ck('여러 번 돌아도 한 번만 알린다', tourNotis('t1', 'TOURNAMENT_OPEN') === 1,
      String(tourNotis('t1', 'TOURNAMENT_OPEN')));
    ck('전체 알림이다 (줄 하나)', (db.prepare(
      `SELECT COUNT(*) AS n FROM notifications WHERE type = 'TOURNAMENT_OPEN' AND user_id IS NULL`)
      .get() as { n: number }).n === 1);
    const open = N.listNotifications('t1', 100).find(n => n.type === 'TOURNAMENT_OPEN')!;
    ck('시작 시각이 담긴다', /\d{2}:\d{2} 시작/.test(open.message), open.message);
    ck('누르면 홀덤으로 간다', open.link === '/games/holdem', String(open.link));
    /* 지금 가면 참가할 수 있다는 신호라 팝업으로 띄운다 */
    ck('등록 시작은 팝업 대상',
      N.popupNotifications('t1').some(n => n.type === 'TOURNAMENT_OPEN'));

    /* 시작 시각이 지난 판에는 보내지 않는다. 서버가 몇 시간 죽어 있다가 깨어나면
       이미 끝난 판의 등록 알림이 뒤늦게 나간다 — 가 봐야 없는 판이다. */
    wipe(); clear();
    AD.createTournament({ title: '지난 판', regOpenAt: nowSec() - 7200, startAt: nowSec() - 3600 });
    HD.advanceHoldem();
    ck('시작 시각이 지났으면 안 알린다', tourNotis('t1', 'TOURNAMENT_OPEN') === 0,
      String(tourNotis('t1', 'TOURNAMENT_OPEN')));

    /* 등록 시작 팝업은 두 시간만. 지나고 나서 "등록이 시작됐습니다"가 뜨면
       가 봐야 이미 끝난 판이다. */
    wipe(); clear();
    N.notifyAll('TOURNAMENT_OPEN', '등록 시작', '테스트');
    ck('방금 것은 팝업', N.popupNotifications('t1').length === 1);
    db.prepare(`UPDATE notifications SET created_at = created_at - ?`)
      .run(N.POPUP_WINDOW_TOURNAMENT_SEC + 60);
    db.prepare(`UPDATE users SET created_at = created_at - ? WHERE id = 't1'`)
      .run(N.POPUP_WINDOW_TOURNAMENT_SEC + 120);
    ck('두 시간이 지나면 팝업하지 않는다', N.popupNotifications('t1').length === 0);
    ck('그래도 종에는 남는다', tourNotis('t1', 'TOURNAMENT_OPEN') === 1);

    /* 우승은 지나간 일이라 팝업하지 않는다 — 우승자 본인은 이미 게임 화면에서 봤다 */
    wipe(); clear();
    N.notifyAll('TOURNAMENT_WIN', '우승', '테스트');
    ck('우승은 팝업 대상이 아니다', N.popupNotifications('t1').length === 0);
    ck('종에는 남는다', tourNotis('t1', 'TOURNAMENT_WIN') === 1);
    clear();
  }

  /* ── 8-2. 실제 과제 ─────────────────────────────────────────── */
  section('[8-2] 실제 과제 — 등록 내용과 판정 조건');
  {
    /* 씨앗 스크립트를 부른다. require 는 한 번만 실행되므로(모듈 캐시) 표를 비운 뒤에
       다시 부르려면 캐시를 지워야 한다 — 처음에 그걸 안 해서 두 번째부터는 빈 표에
       대고 검사하고 있었다. */
    const seed = (): void => {
      delete require.cache[require.resolve('./seed-achievements')];
      require('./seed-achievements');
    };
    wipe();
    seed();
    const byId = new Map(A.listAchievements().map(a => [a.id, a]));
    const SEEDED = 16;
    ck('16개 과제가 등록된다', byId.size === SEEDED, String(byId.size));
    /* 게임을 해서 깨는 과제는 전부 1,000P 기준이다 — 1P 씩 수천 번 돌려 긁어내면
       과제가 "무엇을 해냈나"가 아니라 "얼마나 오래 눌렀나"의 기록이 된다. */
    /* 0.01초의 광기도 여기 들어온다. 손이 빠른가를 재는 과제이지만, 1P 로 수십 판을
       갈아 가며 맞히는 것과 제 돈을 걸고 맞히는 것은 다르다. */
    for (const id of ['bj-double-21', 'crash-x100', 'crash-x1-01', 'la-right-7',
      'mi-1-of-25', 'mi-24-of-24', 'bc-player-7']) {
      ck(`${id} 은 1,000P 기준`, byId.get(id)?.min_bet === 1_000, String(byId.get(id)?.min_bet));
    }
    /* 베팅이 없거나, 금액이 뜻을 갖지 않는 과제는 기준도 0 이어야 한다. 그대로 두면
       영영 판정되지 않거나(지원금·프리롤) 상관없는 문지기가 하나 서 있게 된다.
       그래프의 신은 한 판이 아니라 한 시즌의 합계를 재는 과제라 마지막 판의 금액이
       아무 뜻이 없다 — 문구를 읽은 사람이 실제로 "이게 왜 붙어 있냐"고 물었다. */
    for (const id of ['relief-10-day', 'ho-straight-flush', 'crash-profit-1m',
      'all-first-1', 'roller-coaster']) {
      ck(`${id} 은 최소 베팅 0`, byId.get(id)?.min_bet === 0, String(byId.get(id)?.min_bet));
    }
    /* 감춤 기능 자체는 [2] 에서 따로 검사하므로, 여기서는 "씨앗이 실제로 무엇을
       감췄나"만 본다 — 실수로 감춘 채 올리면 조건을 모르는 사람에게는 그냥 잠긴 칸
       하나가 는 것과 같고, 반대로 히든이 풀리면 자동 캐시아웃 1.01x 예약이 정답으로
       돌아다닌다. */
    const hidden = A.listAchievements().filter(a => a.is_hidden === 1).map(a => a.id);
    ck('감춘 과제는 둘 (0.01초의 광기 · 롤러코스터)',
      hidden.slice().sort().join(',') === 'crash-x1-01,roller-coaster',
      hidden.join(',') || '(감춘 것 없음)');
    ck('분류가 맞다',
      byId.get('bj-double-21')?.game_type === 'BLACKJACK'
      && byId.get('crash-x100')?.game_type === 'CRASH'
      && byId.get('crash-profit-1m')?.game_type === 'CRASH'
      && byId.get('crash-x1-01')?.game_type === 'CRASH'
      && byId.get('relief-10-day')?.game_type === 'ALL'
      && byId.get('ho-straight-flush')?.game_type === 'HOLDEM'
      && byId.get('mi-1-of-25')?.game_type === 'MINES'
      && byId.get('bc-player-7')?.game_type === 'BACCARAT'
      && byId.get('ho-bounty-4')?.game_type === 'HOLDEM'
      && byId.get('all-first-1')?.game_type === 'ALL'
      && byId.get('roller-coaster')?.game_type === 'ALL'
      && byId.get('mi-24-of-24')?.game_type === 'MINES'
      && byId.get('la-right-7')?.game_type === 'LADDER');
    // 다시 돌려도 늘지 않는다 — 같은 id 는 덮어쓴다
    seed();
    ck('두 번 돌려도 16개', A.listAchievements().length === SEEDED,
      String(A.listAchievements().length));

    /* ── 폐기한 과제 ────────────────────────────────────────────
       판정이 바뀌어 id 째로 갈아엎으면 예전 줄이 표에 그대로 남는다(씨앗은 덮어쓸 뿐
       지우지 않는다). 그러면 화면에 아무도 깰 수 없는 칸이 하나 늘어난 채로 남는다. */
    const OLD = 'bj-hit-21';
    for (const id of [OLD, 'mi-23-of-24']) {
      A.upsertAchievement({ id, gameType: 'BLACKJACK', title: '옛 과제' });
      ck(`검사 전제: ${id} 이 표에 있다`, !!A.listAchievements().find(a => a.id === id));
    }
    seed();
    for (const id of [OLD, 'mi-23-of-24']) {
      ck(`폐기한 ${id} 을 씨앗이 지운다`, !A.listAchievements().find(a => a.id === id));
    }
    ck('지운 뒤에도 16개', A.listAchievements().length === SEEDED,
      String(A.listAchievements().length));

    /* 이미 달성한 사람이 있으면 지우지 않는다 — 영구히 남는다고 적어 둔 기록이라,
       조용히 지우면 그 사람의 카드가 사라진다. 그때는 id 를 두고 내용만 고쳐야 한다. */
    A.upsertAchievement({ id: OLD, gameType: 'BLACKJACK', title: '옛 과제' });
    mkUser('rt1');
    A.unlockAchievement('rt1', OLD);
    seed();
    ck('달성자가 있으면 안 지운다', !!A.listAchievements().find(a => a.id === OLD));
    ck('그 사람의 기록도 그대로다', A.hasAchievement('rt1', OLD));
    wipe();
    seed();

    /* 1,000P 문지기가 실제로 막는가. 여기가 뚫리면 위의 기준이 글자로만 남는다. */
    mkUser('r1');
    ck('999P 로는 안 준다', !A.awardIfBet('r1', 'crash-x100', 999, () => true).unlocked);
    ck('1,000P 면 준다', A.awardIfBet('r1', 'crash-x100', 1_000, () => true).unlocked);

    /* ── 김재원이 되어 보자 — 판정식 ────────────────────────────
       판정은 web 핸들러에 있지만 식 자체는 여기서 확인할 수 있다:
       더블로 받은 한 장을 뺀 손이 20이고, 받은 뒤가 21. */
    const BJ = require('../src/services/blackjack') as typeof import('../src/services/blackjack');
    const dbl21 = (cards: number[]): boolean =>
      BJ.handTotal(cards.slice(0, -1)).total === 20 && BJ.handTotal(cards).total === 21;
    /* 카드 번호는 0..51 이고 랭크는 card >> 2 다 — 0='2' … 7='9', 8='T', 11='K', 12='A'.
       같은 랭크가 넉 장이므로 무늬를 바꾸려면 1씩 더한다. */
    const card = (rank: number, suit = 0): number => rank * 4 + suit;
    const ACE = 12, TEN = 8, NINE = 7, TWO = 0;
    ck('10+10 에서 A 를 받아 21 → 달성',
      dbl21([card(TEN), card(TEN, 1), card(ACE)]));
    ck('A+9(소프트 20)에서 A 를 받아 21 → 달성',
      dbl21([card(ACE), card(NINE), card(ACE, 1)]));
    ck('19에서 2를 받아 21 → 아니다 (20이 아니었다)',
      dbl21([card(TEN), card(NINE), card(TWO)]) === false);
    ck('20에서 2를 받아 버스트 → 아니다',
      dbl21([card(TEN), card(TEN, 1), card(TWO)]) === false);
    ck('처음부터 21(블랙잭) → 아니다 (한 장 받은 판이 아니다)',
      dbl21([card(ACE), card(TEN)]) === false);
    ck('20에서 10을 받아 버스트 → 아니다',
      dbl21([card(TEN), card(TEN, 1), card(TEN, 2)]) === false);
    /* 검사 전제 — 위 손들이 정말 그 합인지 확인한다. 카드 번호 규칙을 잘못 알면
       위의 검사들이 전부 "우연히 통과"가 된다. */
    ck('검사 전제: 10+10 은 20', BJ.handTotal([card(TEN), card(TEN, 1)]).total === 20);
    ck('검사 전제: A+9 는 20', BJ.handTotal([card(ACE), card(NINE)]).total === 20);
    ck('검사 전제: A+10 은 21', BJ.handTotal([card(ACE), card(TEN)]).total === 21);

    /* ── 그래프의 신 — 경계와 시즌 범위 ──────────────────────── */
    wipe();
    seed();
    mkUser('g1');
    Q.bumpGameStats('g1', 'graph', 1_000, 1_000_000);      // 순수익 999,000
    ck('99만대에서는 안 준다',
      !A.awardIfBet('g1', 'crash-profit-1m', 1_000,
        () => Q.seasonGameProfit('g1', 'graph') >= 1_000_000).unlocked,
      String(Q.seasonGameProfit('g1', 'graph')));
    Q.bumpGameStats('g1', 'graph', 1_000, 2_000);          // 순수익 1,000,000
    ck('정확히 100만이면 준다',
      A.awardIfBet('g1', 'crash-profit-1m', 1_000,
        () => Q.seasonGameProfit('g1', 'graph') >= 1_000_000).unlocked,
      String(Q.seasonGameProfit('g1', 'graph')));
    /* 다른 게임의 수익은 안 센다 — "그래프의 신"이다 */
    wipe();
    seed();
    mkUser('g2');
    Q.bumpGameStats('g2', 'mines', 1_000, 3_000_000);
    ck('다른 게임 수익은 안 센다',
      !A.awardIfBet('g2', 'crash-profit-1m', 1_000,
        () => Q.seasonGameProfit('g2', 'graph') >= 1_000_000).unlocked);

    /* 이 과제에는 최소 베팅이 없다. 재는 것이 한 판이 아니라 한 시즌의 합계라서다 —
       기준을 붙여 두면 100만을 이미 넘겨 놓고도 마지막 판을 999P 로 걸었다는 이유로
       안 열린다. 카드의 «베팅 1,000P 이상»과 «한 시즌 순수익»을 같이 읽을 방법도 없다. */
    wipe();
    seed();
    mkUser('g4');
    Q.bumpGameStats('g4', 'graph', 1_000, 2_000_000);
    ck('소액 판에서도 열린다 (합계를 재는 과제다)',
      A.awardIfBet('g4', 'crash-profit-1m', 999,
        () => Q.seasonGameProfit('g4', 'graph') >= 1_000_000).unlocked,
      String(Q.seasonGameProfit('g4', 'graph')));
    /* 대조군 — 한 판을 재는 과제는 999P 에서 그대로 막힌다 */
    ck('한 판을 재는 과제는 999P 에서 막힌다',
      !A.awardIfBet('g4', 'crash-x100', 999, () => true).unlocked);

    /* 시즌이 바뀌면 0에서 다시 시작한다.
       통산(game_stats)을 보면 지난 시즌에 벌어 둔 것이 합쳐져서, 새 시즌 첫 판에
       바로 열린다 — 화면의 랭킹은 0인데 과제만 열리는 셈이다. 설명이 "한 시즌 동안"이라
       적혀 있으므로 재는 값도 시즌이어야 한다. */
    wipe();
    mkUser('g3');
    Q.bumpGameStats('g3', 'graph', 1_000, 1_002_000);      // 이번 시즌 순수익 1,001,000
    ck('검사 전제: 시즌 순수익이 100만을 넘었다',
      Q.seasonGameProfit('g3', 'graph') >= 1_000_000, String(Q.seasonGameProfit('g3', 'graph')));
    const allTime = (db.prepare(
      `SELECT profit AS n FROM game_stats WHERE user_id = 'g3' AND game = 'graph'`)
      .get() as { n: number }).n;
    S.closeSeason({ seed: 10_000 });
    ck('시즌이 바뀌면 시즌 순수익은 0', Q.seasonGameProfit('g3', 'graph') === 0,
      String(Q.seasonGameProfit('g3', 'graph')));
    ck('통산은 그대로 남아 있다 (그래서 통산을 보면 안 된다)',
      (db.prepare(`SELECT profit AS n FROM game_stats WHERE user_id = 'g3' AND game = 'graph'`)
        .get() as { n: number }).n === allTime, String(allTime));
    seed();
    ck('새 시즌 첫 판에서는 안 준다',
      !A.awardIfBet('g3', 'crash-profit-1m', 1_000,
        () => Q.seasonGameProfit('g3', 'graph') >= 1_000_000).unlocked);

    /* ── 부지런한 파산러 — 하루 경계 ──────────────────────────── */
    wipe();
    seed();
    mkUser('rr');
    const relief = (n: number, at: number): void => {
      for (let i = 0; i < n; i++) {
        db.prepare(`INSERT INTO points_ledger (user_id, delta, reason, balance_after, created_at)
                    VALUES (?, ?, 'disaster_relief', 0, ?)`).run('rr', 1, at);
      }
    };
    const nowMs = Date.now();
    relief(9, Math.floor(nowMs / 1000));
    ck('9번은 아직 아니다', Q.reliefCountToday('rr', nowMs) === 9,
      String(Q.reliefCountToday('rr', nowMs)));
    ck('9번에서는 안 준다',
      !A.awardIfBet('rr', 'relief-10-day', 0, () => Q.reliefCountToday('rr', nowMs) >= 10).unlocked);
    relief(1, Math.floor(nowMs / 1000));
    ck('10번이면 준다',
      A.awardIfBet('rr', 'relief-10-day', 0, () => Q.reliefCountToday('rr', nowMs) >= 10).unlocked);

    /* 어제 받은 것은 오늘 것이 아니다. 하루의 경계는 KST 이고, 그 경계가 틀리면
       자정 전후로 "왜 안 되냐"가 나온다. */
    wipe();
    seed();
    mkUser('rr2');
    const yesterday = Math.floor(nowMs / 1000) - 26 * 3600;
    for (let i = 0; i < 12; i++) {
      db.prepare(`INSERT INTO points_ledger (user_id, delta, reason, balance_after, created_at)
                  VALUES ('rr2', 1, 'disaster_relief', 0, ?)`).run(yesterday);
    }
    ck('어제 12번은 오늘 0번', Q.reliefCountToday('rr2', nowMs) === 0,
      String(Q.reliefCountToday('rr2', nowMs)));

    /* ── KST 자정 경계를 초 단위로 ────────────────────────────────
       "하루"를 UTC 로 재면 KST 로는 오전 9시에 날짜가 바뀐다. 그러면 밤 11시에 아홉 번
       받고 자정 넘어 한 번 더 받은 사람이 달성해야 하는데 안 되고, 반대로 오전 8시에
       받은 것이 전날로 잡힌다. 실제 시각을 만들어 그 경계를 직접 확인한다. */
    {
      wipe();
      seed();
      mkUser('kst');
      // 2026-08-09 00:00 KST = 2026-08-08 15:00 UTC
      const midnight = Math.floor(new Date('2026-08-09T00:00:00+09:00').getTime() / 1000);
      const at = (sec: number): number => midnight + sec;
      const put = (t: number): void => {
        db.prepare(`INSERT INTO points_ledger (user_id, delta, reason, balance_after, created_at)
                    VALUES ('kst', 1, 'disaster_relief', 0, ?)`).run(t);
      };
      const noonMs = (midnight + 12 * 3600) * 1000;   // 그날 낮 12시에서 세어 본다

      put(at(-1));                       // 전날 23:59:59 KST
      ck('자정 1초 전은 어제', Q.reliefCountToday('kst', noonMs) === 0,
        String(Q.reliefCountToday('kst', noonMs)));
      put(at(0));                        // 정각 00:00:00
      ck('자정 정각은 오늘', Q.reliefCountToday('kst', noonMs) === 1,
        String(Q.reliefCountToday('kst', noonMs)));
      put(at(86_399));                   // 23:59:59
      ck('그날 마지막 초도 오늘', Q.reliefCountToday('kst', noonMs) === 2,
        String(Q.reliefCountToday('kst', noonMs)));
      put(at(86_400));                   // 다음 날 00:00:00
      ck('다음 날 정각은 내일', Q.reliefCountToday('kst', noonMs) === 2,
        String(Q.reliefCountToday('kst', noonMs)));

      /* UTC 로 쟀다면 오전 9시 이전 것이 전날로 밀린다. 그 시각의 것이 오늘로 잡히는지
         확인하면 기준이 KST 라는 것이 드러난다. */
      put(at(3 * 3600));                 // 그날 오전 3시 KST (= 전날 18시 UTC)
      ck('KST 오전 3시는 오늘 (UTC 기준이면 어제가 된다)',
        Q.reliefCountToday('kst', noonMs) === 3, String(Q.reliefCountToday('kst', noonMs)));

      /* 밤에 몰아서 받은 경우. 23시에 아홉 번 + 23:59 에 한 번 = 열 번이면 그날 달성이다. */
      wipe();
      seed();
      mkUser('kst2');
      const put2 = (t: number): void => {
        db.prepare(`INSERT INTO points_ledger (user_id, delta, reason, balance_after, created_at)
                    VALUES ('kst2', 1, 'disaster_relief', 0, ?)`).run(t);
      };
      for (let i = 0; i < 9; i++) put2(at(23 * 3600));
      const lateMs = (midnight + 86_399) * 1000;
      ck('밤 11시에 아홉 번은 아직', Q.reliefCountToday('kst2', lateMs) === 9);
      ck('아홉 번에서는 안 준다',
        !A.awardIfBet('kst2', 'relief-10-day', 0,
          () => Q.reliefCountToday('kst2', lateMs) >= 10).unlocked);
      put2(at(86_399));                  // 23:59:59 에 열 번째
      ck('자정 직전 열 번째면 달성',
        A.awardIfBet('kst2', 'relief-10-day', 0,
          () => Q.reliefCountToday('kst2', lateMs) >= 10).unlocked);

      /* 어제 다섯 + 오늘 다섯은 달성이 아니다. 이어서 세면 "하루에"가 아니게 된다. */
      wipe();
      seed();
      mkUser('kst3');
      const put3 = (t: number): void => {
        db.prepare(`INSERT INTO points_ledger (user_id, delta, reason, balance_after, created_at)
                    VALUES ('kst3', 1, 'disaster_relief', 0, ?)`).run(t);
      };
      for (let i = 0; i < 5; i++) put3(at(-3600));      // 전날 23시
      for (let i = 0; i < 5; i++) put3(at(3600));       // 그날 01시
      ck('걸쳐서 열 번은 오늘 다섯 번', Q.reliefCountToday('kst3', noonMs) === 5,
        String(Q.reliefCountToday('kst3', noonMs)));
      ck('걸쳐서 열 번이면 안 준다',
        !A.awardIfBet('kst3', 'relief-10-day', 0,
          () => Q.reliefCountToday('kst3', noonMs) >= 10).unlocked);
    }
    /* 지원금 말고 다른 사유는 안 센다 */
    for (let i = 0; i < 12; i++) {
      db.prepare(`INSERT INTO points_ledger (user_id, delta, reason, balance_after, created_at)
                  VALUES ('rr2', 1, 'attendance', 0, ?)`).run(Math.floor(nowMs / 1000));
    }
    ck('다른 사유는 안 센다', Q.reliefCountToday('rr2', nowMs) === 0,
      String(Q.reliefCountToday('rr2', nowMs)));
  }

  /* ── 8-3. 배선 ──────────────────────────────────────────────── */
  section('[8-3] 배선 — 게임 코드가 실제로 판정을 부르는가');
  {
    /* 조건식이 맞아도 그것을 부르는 자리가 없으면 과제는 영영 잠긴 채로 남는다.
       판정을 게임 안에서 재현하려면 라운드를 통째로 돌려야 하는데(카드가 무작위라
       20에서 A 를 뽑을 때까지 돌려야 한다), 그건 이 감사가 할 일이 아니다.
       대신 "부르는 자리가 있는가"를 소스에서 확인한다 — 배선이 빠지는 것이 실제로
       일어나는 사고이고, 그건 이 방법으로 잡힌다. */
    const read = (p: string): string => require('node:fs').readFileSync(p, 'utf8') as string;
    const bj = read('src/web/games/blackjack.ts');
    ck('블랙잭이 판정을 부른다', bj.includes("'bj-double-21'"));
    ck('블랙잭이 결과를 응답에 싣는다', bj.includes('withUnlocked'));
    /* 더블일 때만 본다. 히트로 21을 만든 판은 이 과제가 아니다 — 더블은 처음 두 장에서만
       되고 판돈이 두 배가 되므로, 같은 21이어도 건 것이 다르다. */
    ck('더블다운일 때만 판정한다', /action === 'double'[\s\S]{0,140}bj-double-21/.test(bj));
    ck('히트로는 안 준다', !/action === 'hit'[\s\S]{0,140}bj-double-21/.test(bj));

    const cr = read('src/web/games/crash.ts');
    ck('그래프가 100배를 판정한다', cr.includes("'crash-x100'"));
    ck('그래프가 순수익을 판정한다', cr.includes("'crash-profit-1m'"));
    ck('그래프가 결과를 응답에 싣는다', cr.includes('withUnlocked'));
    /* 자동 캐시아웃은 라운드를 전진시키는 쪽에서 정산되므로 캐시아웃 핸들러에만
       붙이면 그 경로가 통째로 빠진다. 상태 응답에서 봐야 둘 다 잡힌다. */
    ck('상태 응답에서 판정한다 (자동 캐시아웃도 잡으려면)',
      /handleState[\s\S]{0,300}crashAwards/.test(cr));

    const dc = read('src/discord/interactions.ts');
    ck('지원금이 판정을 부른다', dc.includes("'relief-10-day'"));
    ck('지급에 성공한 뒤에만 판정한다', /if \(!r\.ok\)[\s\S]*relief-10-day/.test(dc));

    /* 홀덤은 판정 자리가 web 이 아니라 db 계층이다 — 판이 끝나는 곳에서만 족보를 알 수
       있고, 그 값은 이미 result.reveal 에 들어 있다. */
    const ht = read('src/db/holdem.ts');
    ck('홀덤이 판정을 부른다', ht.includes("'ho-straight-flush'"));
    ck('쇼다운에 공개된 손만 본다', /reveal[\s\S]{0,400}SF_NAMES/.test(ht));
    ck('로열 플러시도 함께 센다', /SF_NAMES = \[[^\]]*로열 플러시/.test(ht));
    /* 판정이 던져도 판이 멈추면 안 된다 — 여기는 팟이 이미 나뉜 뒤라, 던지면 그 다음
       처리(탈락·다음 판 예약)가 통째로 안 돈다. */
    ck('판정 오류가 판을 멈추지 않는다', /awardStraightFlush[\s\S]*?try \{[\s\S]*?catch/.test(ht));

    /* 씨앗에 있는 과제는 전부 어딘가에서 판정되어야 한다. 표에만 넣고 배선을 잊으면
       화면에는 뜨는데 아무도 못 깨는 과제가 된다 — 그게 제일 알아채기 어렵다. */
    wipe();
    seedForWiring();
    const ld = read('src/web/games/ladder.ts');
    const mn = read('src/web/games/mines.ts');
    const pk = read('src/web/games/poker.ts');
    const bc = read('src/web/games/baccarat.ts');
    /* 판정이 게임 밖에 있는 과제도 있다 — 시즌이 닫히는 순간에만 볼 수 있는 것(전 종목 1위),
       그리고 게임과 무관하게 그 사람의 하루를 보는 것(롤러코스터)이다. 그 자리들도 함께 훑는다:
       빠뜨리면 "표에는 있는데 아무도 못 깨는 과제"가 조용히 생긴다. */
    const sn = read('src/db/queries/season.ts');
    const hook = read('src/web/achieve-hook.ts');
    const wired = bj + cr + dc + ht + ld + mn + pk + bc + sn + hook;
    const unwired = A.listAchievements().filter(a => !wired.includes(`'${a.id}'`));
    ck('배선이 빠진 과제가 없다', unwired.length === 0, unwired.map(a => a.id).join(','));

    /* 설명이 약속한 숫자와 코드가 쓰는 숫자가 같은가.
       배선이 있어도 기준값이 어긋나면 "100배 이상"이라고 적어 놓고 50배에 주게 된다 —
       화면과 코드가 다른 말을 하는 것이라 아무도 이상하다고 못 느낀다. */
    const num = (src: string, name: string): number | null => {
      const m = src.match(new RegExp(name + '\\s*=\\s*([\\d_]+)'));
      return m ? Number(m[1].replace(/_/g, '')) : null;
    };
    const byId2 = new Map(A.listAchievements().map(a => [a.id, a]));
    ck('100배 기준이 설명과 같다',
      num(cr, 'CRASH_X100') === 100 && !!byId2.get('crash-x100')?.description.includes('100배'),
      String(num(cr, 'CRASH_X100')));
    ck('순수익 기준이 설명과 같다',
      num(cr, 'CRASH_PROFIT_GOAL') === 1_000_000
      && !!byId2.get('crash-profit-1m')?.description.includes('100만'),
      String(num(cr, 'CRASH_PROFIT_GOAL')));
    /* 설명이 "한 시즌 동안"이라고 약속했으면 재는 값도 시즌이어야 한다. 통산을 보면
       지난 시즌 것이 합쳐져 랭킹은 0인데 과제만 열린다. */
    /* 호출부를 본다. 그냥 이름이 파일에 있는지만 보면 import 줄 하나로 통과한다 —
       실제로 그렇게 만들었다가, 통산으로 되돌려 놓고도 검사가 초록으로 남는 것을 봤다.
       판정 줄에서 그 함수를 부르는지, 통산 함수를 부르지는 않는지 둘 다 확인한다. */
    ck('순수익을 시즌 기준으로 잰다',
      /crash-profit-1m'[\s\S]{0,120}seasonGameProfit\(/.test(cr)
      && !!byId2.get('crash-profit-1m')?.description.includes('한 시즌'),
      byId2.get('crash-profit-1m')?.description);
    ck('통산 순수익을 쓰지 않는다', !/crash-profit-1m'[\s\S]{0,120}\bgameProfit\(/.test(cr));
    ck('지원금 횟수가 설명과 같다',
      /reliefCountToday\([^)]*\) >= 10/.test(dc)
      && !!byId2.get('relief-10-day')?.description.includes('10번'));
    /* 규칙이 화면 어딘가에 적혀 있는가. 코드에만 있으면 사람은 "왜 안 깨지지"만
       겪는다 — 막는 규칙일수록 보이는 곳에 있어야 한다. */
    const page = read('src/web/achievements.ts');
    ck('최소 베팅 규칙이 화면에 적혀 있다', page.includes('베팅이 기준 금액 이상일 때만'));
    ck('카드마다 기준 금액을 적는다', /ac-need[\s\S]{0,120}minBet/.test(page));
    ck('기준이 0이면 안 적는다 (0P 이상은 뜻이 없다)', /v\.minBet > 0/.test(page));
    /* 감춘 과제에도 적는다. 금액은 조건이 아니라 규칙이고(얼마 이상 걸어야 판정된다),
       그걸 숨기면 "왜 안 깨지지"만 남는다 — 감추는 것은 무엇을 해야 하나뿐이다. */
    ck('감춘 과제에도 기준을 적는다', !/hiddenYet[\s\S]{0,60}v\.minBet > 0/.test(page));
    ck('기준 계산에 감춤 여부가 끼지 않는다', !/hiddenYet/.test(page));

    /* 연승은 정산 자리에서 쌓이고 과제는 화면 쪽에서 연다. 문지기(1,000P)가 정산 쪽에
       있어야 소액으로 쌓는 것을 막는다 — 과제 쪽에 두면 이미 쌓인 연승으로 열려 버린다. */
    const lad = read('src/db/queries/ladder.ts');
    ck('연승 문지기가 정산 자리에 있다', /LADDER_STREAK_MIN_BET = 1_000/.test(lad));
    ck('우가 아니거나 지면 끊는다', /startGuess !== 'R' \|\| !won/.test(lad));
    ck('7연승 기준이 설명과 같다',
      /RIGHT_STREAK_GOAL = 7/.test(ld) && !!byId2.get('la-right-7')?.description.includes('7연승'));
    ck('쉬어가기가 설명에 적혀 있다',
      !!byId2.get('la-right-7')?.description.includes('쉬어가는 판'));

    ck('블랙잭 판정이 20 → 21 이다',
      /before\.total === 20[\s\S]{0,80}=== 21/.test(bj)
      && !!byId2.get('bj-double-21')?.description.includes('21'));

    /* ── 0.01초의 광기 ────────────────────────────────────────────
       "1.01 이하"다. 처음에는 "정확히 1.01"로 두었는데 사실상 불가능했다 — 1.01x 로
       기록되는 구간이 라운드 시작 후 166~330ms(폭 164ms)뿐이고, 서버는 요청이 도착한
       순간으로 배율을 다시 계산하므로 화면에 1.01 이 보여서 눌러도 왕복 지연만큼 지나간
       값이 찍힌다(제보로 확인). 이하로 두면 1.00x 까지 들어와 창이 두 배가 된다.
       위쪽은 여전히 막혀 있어야 한다 — >= 로 적으면 모든 캐시아웃이 여기 걸린다. */
    ck('1.01배 기준이 설명과 같다',
      /CRASH_MIN_X = 1\.01/.test(cr)
      && !!byId2.get('crash-x1-01')?.description.includes('1.01배 이하'),
      byId2.get('crash-x1-01')?.description);
    ck('1.01배 이하를 본다 (이상이 아니다)',
      /cashout_multiplier <= CRASH_MIN_X/.test(cr)
      && !/cashout_multiplier >= CRASH_MIN_X/.test(cr));
    /* 자동 캐시아웃 하한이 1.01x 라(handleBet), 예약으로 얻는 길을 막지 않으면
       이 과제는 "예약 걸 줄 아는가"를 재는 것이 된다. */
    ck('자동 하한이 1.01배와 같다', /a < 1\.01/.test(cr));
    ck('예약으로 나간 판은 안 센다',
      /byHand[\s\S]{0,160}cashout_multiplier <= CRASH_MIN_X/.test(cr)
      && /auto_cashout == null \|\| [^\n]*!== [^\n]*auto_cashout/.test(cr));

    /* ── 지뢰찾기 둘 ──────────────────────────────────────────────
       마지막 칸을 열면 그 자리에서 자동 정산된다 — 판을 끝까지 간 과제의 판정이
       캐시아웃 자리에 있으면 영영 안 열린다. 둘 다 그 자리에 있어야 한다. */
    const iAuto = mn.indexOf('revealed.length === maxSafe');
    const iMi1 = mn.indexOf("'mi-1-of-25'");
    const iMi24 = mn.indexOf("'mi-24-of-24'");
    const iCash = mn.indexOf('export async function handleCashout');
    ck('1/25 판정이 자동 정산 자리에 있다', iAuto > 0 && iMi1 > iAuto && iMi1 < iCash,
      `auto=${iAuto} award=${iMi1} cashout=${iCash}`);
    ck('안전불감증 판정도 그 자리에 있다', iMi24 > iAuto && iMi24 < iCash,
      `award=${iMi24} cashout=${iCash}`);
    ck('안전 칸이 하나뿐인 판만 본다', /'mi-1-of-25',[\s\S]{0,40}maxSafe === 1/.test(mn));
    /* 지뢰 하나 · 24칸 — 연 칸 수만 세면 지뢰 24개 판과 섞인다 */
    ck('지뢰 하나 판에서 24칸을 다 연 것만 본다',
      /'mi-24-of-24',[\s\S]{0,120}mineCount === 1[\s\S]{0,80}TILE_COUNT - 1/.test(mn));
    ck('캐시아웃 자리에는 판정이 남아 있지 않다',
      !mn.slice(iCash).includes('award('), mn.slice(iCash, iCash + 400));
    /* 지뢰 24개가 실제로 고를 수 있는 값이어야 안전 칸 1개짜리 판이 존재한다 */
    ck('지뢰 24개 판이 실제로 있다',
      /ALLOWED_MINE_COUNTS = \[[^\]]*\b24\b/.test(mn)
      && !!byId2.get('mi-1-of-25')?.description.includes('24개'));
    ck('안전불감증 설명이 클리어를 말한다',
      !!byId2.get('mi-24-of-24')?.description.includes('24칸을 전부')
      && !!byId2.get('mi-24-of-24')?.description.includes('클리어'),
      byId2.get('mi-24-of-24')?.description);

    /* 스탠드 과제의 문구도 판정과 같은 말을 해야 한다 — 조건은 안 바뀌었지만
       "서서"를 "스탠드 후"로 고쳤다. 화면의 말과 코드가 갈리지 않는지 본다. */
    ck('스탠드 설명이 판정과 같은 말이다',
      !!byId2.get('bj-stand-6')?.description.includes('스탠드')
      && !!byId2.get('bj-stand-6')?.description.includes('버스트'),
      byId2.get('bj-stand-6')?.description);
  }

  /* ── 8-4. 진짜 핸들러 ───────────────────────────────────────── */
  section('[8-4] 실제 응답 — 게임 핸들러가 달성을 실어 보내는가');
  {
    /* 조건식이 맞고 배선이 있어도, 응답에 실리지 않으면 화면에는 아무 일도 안 일어난다.
       그 마지막 한 칸을 확인하려면 진짜 핸들러를 태워 봐야 한다.
       가짜 응답 객체를 만들어 sendJson 이 준 본문을 받아 본다. */
    const CR = require('../src/web/games/crash') as typeof import('../src/web/games/crash');
    const CQ = require('../src/db/queries/crash') as typeof import('../src/db/queries/crash');

    function callJson(fn: (req: never, res: never, uid: string) => Promise<void>, uid: string):
      Promise<Record<string, unknown>> {
      let body = '';
      const res = {
        writeHead() { /* 헤더는 안 본다 */ },
        end(chunk?: unknown) { if (chunk != null) body += String(chunk); },
        getHeader() { return undefined; },
        setHeader() { /* noop */ },
        headersSent: false,
      };
      return fn({} as never, res as never, uid).then(() => {
        try { return JSON.parse(body) as Record<string, unknown>; } catch { return {}; }
      });
    }

    wipe();
    seedForWiring();
    mkUser('h1');
    db.exec(`DELETE FROM crash_rounds; DELETE FROM crash_bets;`);

    /* 100배에서 캐시아웃한 상태를 만든다. 실제로 100배가 나올 때까지 라운드를 돌릴 수는
       없다(확률 1% 미만에 77초짜리다) — 결과 행을 그 모양으로 놓고 핸들러를 태운다. */
    const round = CQ.advanceCrashRound({
      makeCrashPoint: () => 500, crashDurationMs: () => 1, multiplierAt: () => 1,
    });
    db.prepare(`INSERT INTO crash_bets (round_id, user_id, username, amount, cashout_multiplier, payout)
                VALUES (?, 'h1', 'h1', ?, ?, ?)`).run(round.id, 1_000, 100, 100_000);

    const st = await callJson(CR.handleState, 'h1');
    const un = (st.unlocked ?? []) as { id: string }[];
    ck('상태 응답에 달성이 실려 온다', un.length > 0, JSON.stringify(st.unlocked ?? null));
    ck('도파민 중독이 열렸다', un.some(u => u.id === 'crash-x100'), un.map(u => u.id).join(','));
    ck('실제로 기록에도 남았다', A.hasAchievement('h1', 'crash-x100'));
    /* 두 번째 폴링에도 또 실려 오면 토스트가 매초 뜬다 — 이미 달성한 것은 안 실린다. */
    const again = await callJson(CR.handleState, 'h1');
    ck('다음 폴링에는 안 실린다', again.unlocked === undefined,
      JSON.stringify(again.unlocked ?? null));

    /* 99배는 안 준다. 기준이 실제로 그 자리에 있는지 확인한다. */
    wipe();
    seedForWiring();
    mkUser('h2');
    db.exec(`DELETE FROM crash_bets;`);
    db.prepare(`INSERT INTO crash_bets (round_id, user_id, username, amount, cashout_multiplier, payout)
                VALUES (?, 'h2', 'h2', ?, ?, ?)`).run(round.id, 1_000, 99, 99_000);
    const low = await callJson(CR.handleState, 'h2');
    ck('99배에서는 안 실린다', low.unlocked === undefined, JSON.stringify(low.unlocked ?? null));

    /* 999P 로 100배를 먹어도 안 준다 — 1,000P 문지기가 이 길에서도 서 있는가. */
    wipe();
    seedForWiring();
    mkUser('h3');
    db.exec(`DELETE FROM crash_bets;`);
    db.prepare(`INSERT INTO crash_bets (round_id, user_id, username, amount, cashout_multiplier, payout)
                VALUES (?, 'h3', 'h3', ?, ?, ?)`).run(round.id, 999, 150, 149_850);
    const small = await callJson(CR.handleState, 'h3');
    ck('999P 베팅이면 100배여도 안 준다', small.unlocked === undefined,
      JSON.stringify(small.unlocked ?? null));
    ck('기록에도 안 남는다', !A.hasAchievement('h3', 'crash-x100'));

    /* 안 걸었거나 터진 판에서는 아무것도 안 본다 — 매 폴링마다 도는 자리라 중요하다. */
    wipe();
    seedForWiring();
    mkUser('h4');
    db.exec(`DELETE FROM crash_bets;`);
    const none = await callJson(CR.handleState, 'h4');
    ck('베팅이 없으면 조용하다', none.unlocked === undefined);
    db.prepare(`INSERT INTO crash_bets (round_id, user_id, username, amount, payout)
                VALUES (?, 'h4', 'h4', ?, 0)`).run(round.id, 5_000);
    const bust = await callJson(CR.handleState, 'h4');
    ck('터진 판에서도 조용하다', bust.unlocked === undefined);

    /* ── 0.01초의 광기 ────────────────────────────────────────────
       배율은 소수점 둘째 자리 내림이라 1.01 은 값이 하나로 딱 떨어진다. */
    const crashBet = (uid: string, amount: number, mult: number, auto: number | null): void => {
      db.exec(`DELETE FROM crash_bets;`);
      db.prepare(`INSERT INTO crash_bets (round_id, user_id, username, amount, auto_cashout, cashout_multiplier, payout)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(round.id, uid, uid, amount, auto, mult, Math.floor(amount * mult));
    };
    const madness = async (uid: string, amount: number, mult: number, auto: number | null):
      Promise<boolean> => {
      wipe(); seedForWiring(); mkUser(uid);
      crashBet(uid, amount, mult, auto);
      const d = await callJson(CR.handleState, uid);
      return ((d.unlocked ?? []) as { id: string }[]).some(u => u.id === 'crash-x1-01');
    };

    ck('1.01배에서 손으로 나가면 열린다', await madness('m1', 1_000, 1.01, null));
    ck('1.02배는 안 열린다 (1.01 이하여야 한다)', !await madness('m2', 1_000, 1.02, null));
    /* 1.00x 는 순이익이 0 이다 — 돈을 벌려고 누르는 것이 아니라 이 과제의 이름 그대로다.
       창을 두 배로 넓히는 것이 여기 들인 이유이기도 하다(164ms → 330ms). */
    ck('1.00배도 열린다 (이하 기준)', await madness('m3', 1_000, 1.00, null));
    ck('100배는 이 과제와 무관하다', !await madness('m4', 1_000, 100, null));
    /* 예약을 1.01x 로 걸어 두면 손을 안 대도 그 배율로 정산된다 — 그 길은 막혀 있다. */
    ck('1.01배 예약으로 나간 판은 안 열린다', !await madness('m5', 1_000, 1.01, 1.01));
    /* 예약은 걸어 뒀지만 그 전에 손으로 눌렀다 — 이건 손이 끝낸 판이다. */
    ck('다른 배율을 예약해 뒀어도 손으로 눌렀으면 열린다',
      await madness('m6', 1_000, 1.01, 5));
    /* 1,000P 기준이 붙었다. 손이 빠른가를 재는 과제이지만, 1P 로 수십 판을 갈아 가며
       맞히는 것과 제 돈을 걸고 맞히는 것은 다르다. */
    ck('1P 로는 안 열린다 (1,000P 기준)', !await madness('m7', 1, 1.01, null));
    ck('999P 로도 안 열린다', !await madness('m8', 999, 1.01, null));
    ck('1,000P 면 열린다', await madness('m9', 1_000, 1.01, null));

    /* 그래프의 신 — 시즌 순수익이 100만을 넘은 상태로 캐시아웃하면 열린다. */
    wipe();
    seedForWiring();
    mkUser('h5');
    db.exec(`DELETE FROM crash_bets;`);
    Q.bumpGameStats('h5', 'graph', 1_000, 1_002_000);
    db.prepare(`INSERT INTO crash_bets (round_id, user_id, username, amount, cashout_multiplier, payout)
                VALUES (?, 'h5', 'h5', ?, ?, ?)`).run(round.id, 1_000, 2, 2_000);
    const god = await callJson(CR.handleState, 'h5');
    const gu = (god.unlocked ?? []) as { id: string }[];
    ck('순수익 100만이면 그래프의 신이 열린다', gu.some(u => u.id === 'crash-profit-1m'),
      JSON.stringify(god.unlocked ?? null));
    ck('100배가 아니면 도파민 중독은 안 열린다', !gu.some(u => u.id === 'crash-x100'));
  }

  /* ── 8-5. 홀덤 스트레이트 플러시 ────────────────────────────── */
  section('[8-5] 홀덤 — 실제 판을 끝까지 돌려 스트레이트 플러시를 본다');
  {
    /* 무작위로 스트레이트 플러시가 나올 때까지 돌릴 수는 없다(약 3만 판에 한 번이다).
       그래서 판을 열고 홀 카드와 보드를 심은 뒤 끝까지 돌린다 — 판정이 도는 자리는
       실제 endHand 라, 이 방법으로도 배선·족보·기록이 전부 진짜로 확인된다. */
    const HD = require('../src/db/holdem') as typeof import('../src/db/holdem');
    const AD = require('../src/db/admin') as typeof import('../src/db/admin');
    const nowSec = (): number => Math.floor(Date.now() / 1000);
    const players = ['sf1', 'sf2', 'sf3'];

    function runHand(holes: Record<string, number[]>, board: number[]): void {
      db.exec(`DELETE FROM holdem_hand_seats; DELETE FROM holdem_hands;
               DELETE FROM holdem_seats; DELETE FROM holdem_tables;
               DELETE FROM holdem_entries; DELETE FROM holdem_tournaments;`);
      const made = AD.createTournament({
        title: 'sf 검사', regOpenAt: nowSec() - 60, startAt: nowSec() + 3600,
      });
      if (!made.ok) throw new Error('대회를 못 열었다: ' + made.error);
      for (const p of players) HD.registerHoldem(p, p);
      db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(nowSec() - 1);
      HD.advanceHoldem();
      const table = HD.getTable(made.id)!;
      const hand = HD.getCurrentHand(table.id)!;
      /* 카드를 심는다. 보드는 리버까지 채우고, 스트리트도 리버로 맞춘다 —
         쇼다운으로 끝나야 reveal 이 만들어진다. */
      for (const s of HD.getSeats(table.id)) {
        const hole = holes[s.user_id];
        if (hole) {
          db.prepare(`UPDATE holdem_hand_seats SET hole_json = ? WHERE hand_id = ? AND seat = ?`)
            .run(JSON.stringify(hole), hand.id, s.seat);
        }
      }
      db.prepare(`UPDATE holdem_hands SET board_json = ?, street = 'river' WHERE id = ?`)
        .run(JSON.stringify(board), hand.id);
      // 전원 체크로 리버를 닫으면 쇼다운이 된다
      for (let i = 0; i < 40; i++) {
        const h = HD.getCurrentHand(table.id);
        if (!h || h.ended_at != null || h.to_act_seat == null) break;
        const seat = HD.getSeats(table.id).find(x => x.seat === h.to_act_seat);
        if (!seat) break;
        /* 차례를 "지금 열렸고 제한 시간은 온전히 남았다"로 만든다.
           마감을 과거로 밀면 자동 폴드가 먼저 돌아 쇼다운까지 못 간다 — 실제로 그랬다. */
        db.prepare(`UPDATE holdem_hands SET action_deadline = ? WHERE id = ?`)
          .run(nowSec() + HD.ACTION_SEC, h.id);
        if (!HD.holdemAction(seat.user_id, 'check', 0).ok) HD.holdemAction(seat.user_id, 'call', 0);
      }
    }

    /* 카드 번호는 rank*4 + suit. 스페이드를 0 으로 두고 9-10-J-Q-K 스페이드를 만든다.
       (랭크 0='2' … 7='9', 8='T', 9='J', 10='Q', 11='K', 12='A') */
    const c = (rank: number, suit = 0): number => rank * 4 + suit;
    const SPADE = 0, HEART = 1;

    wipe();
    seedForWiring();
    for (const p of players) mkUser(p, 50_000);
    /* sf1 이 9♠T♠ 를 들고 보드에 J♠Q♠K♠ — 9-K 스트레이트 플러시.
       나머지 둘은 무늬가 다른 낮은 카드라 끼어들지 않는다. */
    runHand(
      { sf1: [c(7, SPADE), c(8, SPADE)], sf2: [c(0, HEART), c(1, HEART)], sf3: [c(2, HEART), c(3, HEART)] },
      [c(9, SPADE), c(10, SPADE), c(11, SPADE), c(0, HEART + 1), c(1, HEART + 1)],
    );
    ck('스트레이트 플러시를 띄운 사람이 달성했다', A.hasAchievement('sf1', 'ho-straight-flush'));
    ck('같은 판의 남은 안 받는다',
      !A.hasAchievement('sf2', 'ho-straight-flush') && !A.hasAchievement('sf3', 'ho-straight-flush'));
    /* 판이 실제로 끝났는지도 본다 — 안 끝났으면 위 검사는 우연히 통과한 것이다 */
    ck('검사 전제: 판이 쇼다운으로 끝났다', (db.prepare(
      `SELECT COUNT(*) AS n FROM holdem_hands WHERE ended_at IS NOT NULL`)
      .get() as { n: number }).n > 0);

    // 두 번째 판을 또 이겨도 기록은 하나
    runHand(
      { sf1: [c(7, SPADE), c(8, SPADE)], sf2: [c(0, HEART), c(1, HEART)], sf3: [c(2, HEART), c(3, HEART)] },
      [c(9, SPADE), c(10, SPADE), c(11, SPADE), c(0, HEART + 1), c(1, HEART + 1)],
    );
    ck('두 번 띄워도 기록은 하나', (db.prepare(
      `SELECT COUNT(*) AS n FROM user_achievements WHERE user_id = 'sf1'
        AND achievement_id = 'ho-straight-flush'`).get() as { n: number }).n === 1);

    /* 로열 플러시도 스트레이트 플러시의 일종이다 — 이름이 달라서 놓치기 쉽다. */
    wipe();
    seedForWiring();
    runHand(
      { sf1: [c(12, SPADE), c(11, SPADE)], sf2: [c(0, HEART), c(1, HEART)], sf3: [c(2, HEART), c(3, HEART)] },
      [c(10, SPADE), c(9, SPADE), c(8, SPADE), c(0, HEART + 1), c(1, HEART + 1)],
    );
    ck('로열 플러시도 달성으로 센다', A.hasAchievement('sf1', 'ho-straight-flush'));

    /* 그냥 플러시는 아니다. 기준이 실제로 그 자리에 있는지 확인한다. */
    wipe();
    seedForWiring();
    runHand(
      { sf1: [c(12, SPADE), c(5, SPADE)], sf2: [c(0, HEART), c(1, HEART)], sf3: [c(2, HEART), c(3, HEART)] },
      [c(9, SPADE), c(7, SPADE), c(3, SPADE), c(0, HEART + 1), c(1, HEART + 1)],
    );
    ck('그냥 플러시는 안 준다', !A.hasAchievement('sf1', 'ho-straight-flush'));

    db.exec(`DELETE FROM holdem_hand_seats; DELETE FROM holdem_hands;
             DELETE FROM holdem_seats; DELETE FROM holdem_tables;
             DELETE FROM holdem_entries; DELETE FROM holdem_tournaments;`);
  }

  /* ── 8-6. 사다리 연승 ───────────────────────────────────────── */
  section('[8-6] 사다리 — 우 7연승 · 쉬어가기는 안 끊긴다');
  {
    const LD = require('../src/db/queries/ladder') as typeof import('../src/db/queries/ladder');
    const LW = require('../src/web/games/ladder') as typeof import('../src/web/games/ladder');
    const ST = require('../src/db/streaks') as typeof import('../src/db/streaks');

    /* 라운드를 하나 만들어 그 결과를 못 박고 정산시킨다. 실제 settleLadderBets 를 태워야
       연승이 진짜로 그 자리에서 쌓이는지 확인된다. */
    function playRound(bets: { user: string; guess: string | null; amount: number }[],
      startSide: 'L' | 'R'): void {
      db.exec(`DELETE FROM ladder_bets; DELETE FROM ladder_rounds;`);
      db.prepare(`INSERT INTO ladder_rounds (phase, betting_ends_at, start_side, end_side, rungs_json)
                  VALUES ('done', 0, ?, 'R', '[]')`).run(startSide);
      const rid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
      for (const b of bets) {
        db.prepare(`INSERT INTO ladder_bets (round_id, user_id, username, start_guess, parity_guess, amount)
                    VALUES (?, ?, ?, ?, NULL, ?)`).run(rid, b.user, b.user, b.guess, b.amount);
      }
      LD.settleLadderBets(rid, startSide, 'R');
    }

    wipe();
    seedForWiring();
    mkUser('L1', 1_000_000);
    const streak = (): number => ST.getStreak('L1', 'ladder_right_win');

    /* 우에 걸고 이기면 쌓인다. 출발이 R 인 라운드에서 R 에 걸면 이긴다. */
    for (let i = 1; i <= 6; i++) {
      playRound([{ user: 'L1', guess: 'R', amount: 1_000 }], 'R');
      ck(`우 승리 ${i}연승`, streak() === i, String(streak()));
    }

    /* 쉬어가는 판. 안 건 판에서는 정산이 이 사람을 훑지 않으므로 값이 그대로다 —
       그것이 곧 "쉬어가기 허용"이고 따로 처리할 것이 없다. */
    playRound([{ user: 'other', guess: 'R', amount: 1_000 }], 'R');
    ck('쉬어간 판은 연승이 유지된다', streak() === 6, String(streak()));
    db.exec(`DELETE FROM ladder_bets;`);      // 아무도 안 건 판
    playRound([], 'R');
    ck('아무도 안 건 판도 그대로', streak() === 6, String(streak()));

    /* 일곱 번째. 이 순간 과제가 열려야 한다. */
    playRound([{ user: 'L1', guess: 'R', amount: 1_000 }], 'R');
    ck('7연승이 됐다', streak() === 7, String(streak()));
    ck('아직은 응답을 안 받아 미달성', !A.hasAchievement('L1', 'la-right-7'));

    /* 과제의 min_bet 이 1,000P 라, 여는 자리에서 "얼마 걸었나"를 같이 넘겨야 한다.
       연승을 이어 온 마지막 판의 베팅액이 그 값이고, 연승은 1,000P 이상으로만 쌓이므로
       이 값은 반드시 기준을 넘는다 — 즉 화면의 문구가 실제로 막는 일은 없다.
       (0 을 넘기면 바로 아래 '응답에 달성이 실려 온다' 가 무너진다) */
    ck('마지막 우 승리 베팅액을 읽는다', LD.lastRightWinBet('L1') === 1_000,
      String(LD.lastRightWinBet('L1')));
    ck('그 값이 과제 기준을 넘는다', LD.lastRightWinBet('L1') >= 1_000);

    /* 화면이 폴링하는 그 응답에서 열린다 — 토스트가 뜨려면 unlocked 가 실려야 한다. */
    let body = '';
    const res = {
      writeHead() { }, end(c?: unknown) { if (c != null) body += String(c); },
      getHeader() { return undefined; }, setHeader() { }, headersSent: false,
    };
    await LW.handleState({} as never, res as never, 'L1');
    const out = JSON.parse(body) as { unlocked?: { id: string }[] };
    ck('상태 응답에 달성이 실려 온다', (out.unlocked ?? []).some(u => u.id === 'la-right-7'),
      JSON.stringify(out.unlocked ?? null));
    ck('기록에도 남았다', A.hasAchievement('L1', 'la-right-7'));

    /* ── 끊기는 조건들 ──────────────────────────────────────── */
    const fresh = (id: string): void => { wipe(); seedForWiring(); mkUser(id, 1_000_000); };
    const runUp = (id: string, n: number): void => {
      for (let i = 0; i < n; i++) playRound([{ user: id, guess: 'R', amount: 1_000 }], 'R');
    };

    fresh('L2'); runUp('L2', 3);
    ck('검사 전제: 3연승', ST.getStreak('L2', 'ladder_right_win') === 3);
    playRound([{ user: 'L2', guess: 'R', amount: 1_000 }], 'L');     // 우에 걸었는데 출발이 좌 → 패배
    ck('우에 걸고 지면 끊긴다', ST.getStreak('L2', 'ladder_right_win') === 0,
      String(ST.getStreak('L2', 'ladder_right_win')));

    fresh('L3'); runUp('L3', 3);
    playRound([{ user: 'L3', guess: 'L', amount: 1_000 }], 'L');     // 좌에 걸고 이겨도
    ck('좌에 걸면 이겨도 끊긴다', ST.getStreak('L3', 'ladder_right_win') === 0,
      String(ST.getStreak('L3', 'ladder_right_win')));

    fresh('L4'); runUp('L4', 3);
    playRound([{ user: 'L4', guess: null, amount: 1_000 }], 'R');    // 홀짝만 건 판
    ck('출발을 안 고르면 끊긴다', ST.getStreak('L4', 'ladder_right_win') === 0,
      String(ST.getStreak('L4', 'ladder_right_win')));

    /* 1,000P 미만은 아예 없던 판으로 본다 — 소액으로 쌓지도, 소액으로 끊기지도 않는다. */
    fresh('L5'); runUp('L5', 3);
    playRound([{ user: 'L5', guess: 'R', amount: 999 }], 'R');
    ck('999P 승리는 연승을 안 올린다', ST.getStreak('L5', 'ladder_right_win') === 3,
      String(ST.getStreak('L5', 'ladder_right_win')));
    playRound([{ user: 'L5', guess: 'L', amount: 999 }], 'L');
    ck('999P 로는 끊기지도 않는다', ST.getStreak('L5', 'ladder_right_win') === 3,
      String(ST.getStreak('L5', 'ladder_right_win')));

    /* 6연승에서는 아직 안 열린다 — 기준이 실제로 7 인가. */
    fresh('L6'); runUp('L6', 6);
    let b6 = '';
    const res6 = {
      writeHead() { }, end(c?: unknown) { if (c != null) b6 += String(c); },
      getHeader() { return undefined; }, setHeader() { }, headersSent: false,
    };
    await LW.handleState({} as never, res6 as never, 'L6');
    ck('6연승에서는 안 열린다', (JSON.parse(b6) as { unlocked?: unknown }).unlocked === undefined);
    ck('기록에도 없다', !A.hasAchievement('L6', 'la-right-7'));

    db.exec(`DELETE FROM ladder_bets; DELETE FROM ladder_rounds; DELETE FROM user_streaks;`);
  }

  /* ── 8-7. 신규 넷 — 진짜 응답으로 ──────────────────────────── */
  section('[8-7] 지뢰찾기 · 포커 플립 · 블랙잭 — 실제 핸들러가 판정하는가');
  {
    const MN = require('../src/web/games/mines') as typeof import('../src/web/games/mines');
    const PK = require('../src/web/games/poker') as typeof import('../src/web/games/poker');
    const BJW = require('../src/web/games/blackjack') as typeof import('../src/web/games/blackjack');
    const BJ = require('../src/services/blackjack') as typeof import('../src/services/blackjack');

    function grab(fn: (req: never, res: never, uid: string) => Promise<void>, uid: string):
      Promise<Record<string, unknown>> {
      let body = '';
      const res = {
        writeHead() { }, end(c?: unknown) { if (c != null) body += String(c); },
        getHeader() { return undefined; }, setHeader() { }, headersSent: false,
      };
      return fn({} as never, res as never, uid)
        .then(() => { try { return JSON.parse(body) as Record<string, unknown>; } catch { return {}; } });
    }
    const ids = (d: Record<string, unknown>): string[] =>
      ((d.unlocked ?? []) as { id: string }[]).map(u => u.id);

    function minesRound(mineCount: number, opened: number, bet: number, uid: string): void {
      db.exec(`DELETE FROM game_rounds WHERE user_id = '${uid}'`);
      /* 지뢰 위치를 열 칸과 겹치지 않게 놓는다 — 겹치면 그건 이미 터진 판이다.
         뒤쪽부터 놓으므로 앞 칸들이 안전한 칸이 된다. */
      const mines = Array.from({ length: mineCount }, (_, i) => 24 - i);
      const revealed = Array.from({ length: opened }, (_, i) => i).filter(t => !mines.includes(t));
      Q.placeBet(uid, 'mines', bet, { mineCount, minePositions: mines, revealed });
    }

    /* ── 1/25의 사나이 ─────────────────────────────────────────
       안전 칸이 하나뿐인 판(지뢰 24개). 그 한 칸을 열면 더 열 칸이 없어 곧바로 정산되므로,
       판정도 캐시아웃이 아니라 칸을 여는 요청에서 나와야 한다. 그래서 여기서는 본문이 있는
       요청을 흉내 내 진짜 handleReveal 을 태운다. */
    const { Readable } = require('node:stream') as typeof import('node:stream');
    const reveal = (uid: string, tile: number): Promise<Record<string, unknown>> => {
      let body = '';
      const res = {
        writeHead() { }, end(c?: unknown) { if (c != null) body += String(c); },
        getHeader() { return undefined; }, setHeader() { }, headersSent: false,
      };
      return MN.handleReveal(Readable.from([JSON.stringify({ tile })]) as never, res as never, uid)
        .then(() => { try { return JSON.parse(body) as Record<string, unknown>; } catch { return {}; } });
    };

    // minesRound 는 지뢰를 뒤쪽부터 놓는다 — 지뢰 24개면 안전한 칸은 0번 하나뿐이다.
    wipe(); seedForWiring(); mkUser('M5', 1_000_000);
    minesRound(24, 0, 1_000, 'M5');
    const only = await reveal('M5', 0);
    ck('안전 칸 하나를 열면 그 자리에서 정산된다', only.autoCashedOut === true,
      JSON.stringify(only.autoCashedOut ?? null));
    ck('1/25의 사나이가 열린다', ids(only).includes('mi-1-of-25'), ids(only).join(','));

    wipe(); seedForWiring(); mkUser('M6', 1_000_000);
    minesRound(24, 0, 1_000, 'M6');
    const boom = await reveal('M6', 1);
    ck('지뢰를 밟으면 안 열린다',
      boom.busted === true && !ids(boom).includes('mi-1-of-25'));

    wipe(); seedForWiring(); mkUser('M7', 1_000_000);
    minesRound(24, 0, 999, 'M7');
    ck('999P 로 맞혀도 안 열린다', !ids(await reveal('M7', 0)).includes('mi-1-of-25'));

    /* ── 안전불감증 ─────────────────────────────────────────────
       지뢰 하나 판에서 24칸을 끝까지 다 연다. 1/25 과 같은 자리(자동 정산)를 지나므로
       둘이 서로를 잘못 열지 않는지도 여기서 함께 본다 — 연 칸 수만 세면 섞인다. */
    wipe(); seedForWiring(); mkUser('M8', 1_000_000);
    minesRound(1, 23, 1_000, 'M8');
    const all24 = await reveal('M8', 23);
    ck('마지막 칸까지 열면 그 자리에서 정산된다', all24.autoCashedOut === true,
      JSON.stringify(all24.autoCashedOut ?? null));
    ck('안전불감증이 열린다', ids(all24).includes('mi-24-of-24'), ids(all24).join(','));
    ck('그 판은 1/25의 사나이가 아니다', !ids(all24).includes('mi-1-of-25'));
    ck('거꾸로 지뢰 24개 판도 안전불감증이 아니다', !ids(only).includes('mi-24-of-24'),
      ids(only).join(','));

    /* 한 칸 남기고 나오면 아니다 — 예전 조건이라 여기서 열리면 바뀐 게 아니다.
       (그 자리에는 이제 판정이 아예 없다: 다 열면 캐시아웃까지 오지 않는다.) */
    wipe(); seedForWiring(); mkUser('M9', 1_000_000);
    minesRound(1, 23, 1_000, 'M9');
    ck('23칸에서 캐시아웃하면 안 열린다',
      !ids(await grab(MN.handleCashout, 'M9')).includes('mi-24-of-24'));

    /* 지뢰가 셋이면 다 열어도 아니다 — "지뢰 하나짜리 판"이 조건 자체다 */
    wipe(); seedForWiring(); mkUser('M10', 1_000_000);
    minesRound(3, 21, 1_000, 'M10');
    const clear3 = await reveal('M10', 21);
    ck('검사 전제: 지뢰 3개 판도 다 열렸다', clear3.autoCashedOut === true,
      JSON.stringify(clear3.autoCashedOut ?? null));
    ck('지뢰 3개 판을 다 열어도 안 열린다', !ids(clear3).includes('mi-24-of-24'));

    wipe(); seedForWiring(); mkUser('M11', 1_000_000);
    minesRound(1, 23, 999, 'M11');
    ck('999P 로 클리어해도 안 열린다',
      !ids(await reveal('M11', 23)).includes('mi-24-of-24'));

    /* ── 한탕주의자 ─────────────────────────────────────────────
       마지막 등급 칸(포카드 이상)에 걸어 맞힌다. */
    function flipRound(market: string, won: number, amount: number, uid: string): number {
      db.exec(`DELETE FROM poker_bets; DELETE FROM poker_rounds;`);
      db.prepare(`INSERT INTO poker_rounds (phase, betting_ends_at, hole_json, board_json, odds_json, result_json, resolved_at)
                  VALUES ('done', 0, '[0,1,2,3]', '[4,5,6,7,8]', ?, ?, ?)`)
        .run(JSON.stringify({ master: 2, shark: 2, buckets: [2, 2, 2, 2, 50], prob: {} }),
          JSON.stringify({ winner: 'master', buckets: [4] }), Math.floor(Date.now() / 1000));
      const rid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
      db.prepare(`INSERT INTO poker_bets (round_id, user_id, username, market, amount, odds, won, payout)
                  VALUES (?, ?, ?, ?, ?, 50, ?, ?)`)
        .run(rid, uid, uid, market, amount, won, won ? amount * 50 : 0);
      return rid;
    }

    wipe(); seedForWiring(); mkUser('P1', 1_000_000);
    flipRound('b4', 1, 500, 'P1');
    ck('포카드 이상에 걸어 맞히면 열린다',
      ids(await grab(PK.handleState, 'P1')).includes('pk-quads-plus'));

    wipe(); seedForWiring(); mkUser('P2', 1_000_000);
    flipRound('b4', 0, 500, 'P2');
    ck('걸었지만 빗나가면 안 열린다', !ids(await grab(PK.handleState, 'P2')).includes('pk-quads-plus'));

    wipe(); seedForWiring(); mkUser('P3', 1_000_000);
    flipRound('b3', 1, 500, 'P3');
    ck('풀하우스 칸을 맞혀도 안 열린다', !ids(await grab(PK.handleState, 'P3')).includes('pk-quads-plus'));

    wipe(); seedForWiring(); mkUser('P4', 1_000_000);
    flipRound('b4', 1, 499, 'P4');
    ck('499P 면 안 열린다', !ids(await grab(PK.handleState, 'P4')).includes('pk-quads-plus'));

    /* ── 블랙잭 둘 ──────────────────────────────────────────────
       카드 번호는 rank*4 + suit (랭크 0='2' … 12='A'). */
    const card = (rank: number, suit = 0): number => rank * 4 + suit;
    function bjRound(mine: number[], dealer: number[], status: string, bet: number, uid: string): void {
      db.exec(`DELETE FROM blackjack_hands; DELETE FROM blackjack_rounds;`);
      const settled = BJ.settleHand(mine, dealer);
      db.prepare(`INSERT INTO blackjack_rounds (phase, betting_ends_at, shoe_json, shoe_pos, dealer_json, resolved_at)
                  VALUES ('done', 0, '[]', 0, ?, ?)`)
        .run(JSON.stringify(dealer), Math.floor(Date.now() / 1000));
      const rid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
      db.prepare(`INSERT INTO blackjack_hands (round_id, user_id, username, seat, bet, cards_json, status, outcome, payout)
                  VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`)
        .run(rid, uid, uid, bet, JSON.stringify(mine), status, settled.outcome,
          Math.floor(bet * settled.multiplier));
    }

    /* 2+4 = 6 에서 서고, 딜러는 22 로 터진다 */
    const SIX = [card(0), card(2, 1)];                        // 2 + 4
    const BUST = [card(8), card(8, 1), card(8, 2)];           // 10+10+10 = 30
    wipe(); seedForWiring(); mkUser('B1', 1_000_000);
    bjRound(SIX, BUST, 'stand', 1_000, 'B1');
    ck('검사 전제: 내 손이 6점', BJ.handTotal(SIX).total === 6, String(BJ.handTotal(SIX).total));
    ck('검사 전제: 딜러가 터졌다', BJ.handTotal(BUST).bust);
    ck('6점에서 서서 딜러가 터지면 열린다',
      ids(await grab(BJW.handleState, 'B1')).includes('bj-stand-6'));

    /* 7점에서 서면 아니다 — 기준이 실제로 6인가 */
    wipe(); seedForWiring(); mkUser('B2', 1_000_000);
    const SEVEN = [card(1), card(2, 1)];                      // 3 + 4
    bjRound(SEVEN, BUST, 'stand', 1_000, 'B2');
    ck('검사 전제: 내 손이 7점', BJ.handTotal(SEVEN).total === 7);
    ck('7점이면 안 열린다', !ids(await grab(BJW.handleState, 'B2')).includes('bj-stand-6'));

    /* 딜러가 안 터지고 그냥 점수로 이긴 경우는 아니다 */
    wipe(); seedForWiring(); mkUser('B3', 1_000_000);
    const LOW = [card(0), card(0, 1)];                        // 2 + 2 = 4
    const DEALER3 = [card(0, 2), card(0, 3)];                 // 4 — 내가 6이면 이긴다
    bjRound(SIX, DEALER3, 'stand', 1_000, 'B3');
    ck('딜러가 안 터졌으면 안 열린다',
      !ids(await grab(BJW.handleState, 'B3')).includes('bj-stand-6'));
    void LOW;

    /* 카드 야르 — 일곱 장으로 21 이하 승리 */
    wipe(); seedForWiring(); mkUser('B4', 1_000_000);
    const SEVEN_CARDS = [card(0), card(0, 1), card(0, 2), card(0, 3),
      card(1), card(1, 1), card(1, 2)];                       // 2×4 + 3×3 = 17
    bjRound(SEVEN_CARDS, BUST, 'stand', 1_000, 'B4');
    ck('검사 전제: 일곱 장에 17점',
      SEVEN_CARDS.length === 7 && BJ.handTotal(SEVEN_CARDS).total === 17,
      String(BJ.handTotal(SEVEN_CARDS).total));
    ck('일곱 장으로 이기면 열린다',
      ids(await grab(BJW.handleState, 'B4')).includes('bj-7-cards'));

    wipe(); seedForWiring(); mkUser('B5', 1_000_000);
    const SIX_CARDS = SEVEN_CARDS.slice(0, 6);                // 2×4 + 3×2 = 14
    bjRound(SIX_CARDS, BUST, 'stand', 1_000, 'B5');
    ck('여섯 장이면 안 열린다', !ids(await grab(BJW.handleState, 'B5')).includes('bj-7-cards'));

    /* 졌으면 장수와 무관하게 아니다 */
    wipe(); seedForWiring(); mkUser('B6', 1_000_000);
    const DEALER_20 = [card(8), card(8, 1)];                  // 20
    bjRound(SEVEN_CARDS, DEALER_20, 'stand', 1_000, 'B6');
    ck('일곱 장이어도 지면 안 열린다',
      !ids(await grab(BJW.handleState, 'B6')).includes('bj-7-cards'));

    /* ── 김재원이 되어 보자 — 진짜 handleAction 을 태운다 ─────────
       이 과제만 다른 자리에서 판정된다(상태가 아니라 동작). 더블은 카드를 한 장 받는데
       그 한 장이 무엇인지가 곧 판정이라, 슈를 손으로 놓고 실제로 눌러 봐야 확인된다.

       action 국면에 머무르게 하려면 시간을 맞춰야 한다: betting_ends_at 을 BJ_DEAL_SEC
       만큼 과거로 놓으면 배분이 방금 끝난 시점이 되고, 결정 창은 아직 열려 있다.
       (과거로 더 밀면 창이 닫혀 'closed' 가 돌아온다 — 홀덤에서 같은 함정을 밟은 적이 있다.) */
    const BQ = require('../src/db/queries/bj') as typeof import('../src/db/queries/bj');
    function bjAction(uid: string, mine: number[], next: number, bet: number, act: string):
      Promise<Record<string, unknown>> {
      db.exec(`DELETE FROM blackjack_hands; DELETE FROM blackjack_rounds;`);
      const now = Math.floor(Date.now() / 1000);
      db.prepare(`INSERT INTO blackjack_rounds (phase, betting_ends_at, shoe_json, shoe_pos, dealer_json)
                  VALUES ('action', ?, ?, 0, ?)`)
        .run(now - BQ.BJ_DEAL_SEC, JSON.stringify([next]), JSON.stringify([card(8, 2), card(6, 2)]));
      const rid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
      db.prepare(`INSERT INTO blackjack_hands (round_id, user_id, username, seat, bet, cards_json, status)
                  VALUES (?, ?, ?, 0, ?, ?, 'playing')`)
        .run(rid, uid, uid, bet, JSON.stringify(mine));
      let body = '';
      const res = {
        writeHead() { }, end(c?: unknown) { if (c != null) body += String(c); },
        getHeader() { return undefined; }, setHeader() { }, headersSent: false,
      };
      return BJW.handleAction(
        Readable.from([JSON.stringify({ action: act })]) as never, res as never, uid)
        .then(() => { try { return JSON.parse(body) as Record<string, unknown>; } catch { return {}; } });
    }
    const TWENTY = [card(8), card(8, 1)];                     // 10 + 10
    const NINETEEN = [card(8), card(7, 1)];                   // 10 + 9

    wipe(); seedForWiring(); mkUser('B7', 1_000_000);
    const dbl = await bjAction('B7', TWENTY, card(12), 1_000, 'double');
    ck('검사 전제: 더블이 받아들여졌다', dbl.ok === true, JSON.stringify(dbl.error ?? null));
    ck('검사 전제: 21이 됐다', dbl.status === 'stand' && (dbl.cards as string[]).length === 3,
      JSON.stringify(dbl.cards ?? null));
    ck('20에서 더블다운해 21이면 열린다',
      ((dbl.unlocked ?? []) as { id: string }[]).some(u => u.id === 'bj-double-21'),
      JSON.stringify(dbl.unlocked ?? null));

    /* 같은 20에서 히트로 21을 만든 판. 예전 조건이라 여기서 열리면 바뀐 게 아니다. */
    wipe(); seedForWiring(); mkUser('B8', 1_000_000);
    const hit = await bjAction('B8', TWENTY, card(12), 1_000, 'hit');
    ck('검사 전제: 히트도 21이 됐다', hit.ok === true && hit.status === 'stand');
    ck('히트로 21을 만들면 안 열린다',
      !((hit.unlocked ?? []) as { id: string }[]).some(u => u.id === 'bj-double-21'));

    /* 19에서 더블해 21이 된 판 — 20이 아니었으므로 아니다 */
    wipe(); seedForWiring(); mkUser('B9', 1_000_000);
    const from19 = await bjAction('B9', NINETEEN, card(0), 1_000, 'double');
    ck('검사 전제: 19 + 2 = 21', from19.ok === true);
    ck('19에서 더블하면 안 열린다',
      !((from19.unlocked ?? []) as { id: string }[]).some(u => u.id === 'bj-double-21'));

    /* 400P 로 시작해 더블하면 걸린 돈은 800P — 기준에 못 미친다.
       (500P 였다면 더블로 1,000P 가 되어 통과한다. 그 판에 실제로 걸린 돈이 기준이다.) */
    wipe(); seedForWiring(); mkUser('B10', 1_000_000);
    const small = await bjAction('B10', TWENTY, card(12), 400, 'double');
    ck('검사 전제: 작은 판도 더블은 됐다', small.ok === true);
    ck('더블해도 800P 면 안 열린다',
      !((small.unlocked ?? []) as { id: string }[]).some(u => u.id === 'bj-double-21'));

    wipe(); seedForWiring(); mkUser('B11', 1_000_000);
    const half = await bjAction('B11', TWENTY, card(12), 500, 'double');
    ck('500P 로 더블하면 1,000P 라 열린다',
      ((half.unlocked ?? []) as { id: string }[]).some(u => u.id === 'bj-double-21'),
      JSON.stringify(half.unlocked ?? null));

    db.exec(`DELETE FROM blackjack_hands; DELETE FROM blackjack_rounds;
             DELETE FROM poker_bets; DELETE FROM poker_rounds;`);
  }

  /* ── 8-7b. 죽음의 바운티 헌터 ────────────────────────────────── */
  section('[8-7b] 홀덤 — KO 를 세고 우승자에게만 준다');
  {
    const HD = require('../src/db/holdem') as typeof import('../src/db/holdem');
    const AD = require('../src/db/admin') as typeof import('../src/db/admin');
    const nowSec = (): number => Math.floor(Date.now() / 1000);
    const ko = (tid: number, uid: string): number =>
      (db.prepare(`SELECT ko_count AS n FROM holdem_entries WHERE tournament_id = ? AND user_id = ?`)
        .get(tid, uid) as { n: number } | undefined)?.n ?? 0;

    /** 대회를 열고 사람을 앉힌 뒤 첫 판을 시작한다. */
    function openTourney(players: string[]): { id: number; tableId: number } {
      db.exec(`DELETE FROM holdem_hand_seats; DELETE FROM holdem_hands;
               DELETE FROM holdem_seats; DELETE FROM holdem_tables;
               DELETE FROM holdem_entries; DELETE FROM holdem_tournaments;`);
      const made = AD.createTournament({
        title: 'ko 검사', regOpenAt: nowSec() - 60, startAt: nowSec() + 3600,
      });
      if (!made.ok) throw new Error('대회를 못 열었다: ' + made.error);
      for (const p of players) HD.registerHoldem(p, p);
      db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(nowSec() - 1);
      HD.advanceHoldem();
      const tb = HD.getTable(made.id);
      if (!tb) {
        /* 시작하지 않았다면 이유를 그대로 보여준다 — "undefined 의 id" 로 죽으면
           대회가 왜 안 열렸는지 알 수 없다(실제로 그 오류를 두 번 봤다). */
        const row = db.prepare(`SELECT * FROM holdem_tournaments WHERE id = ?`).get(made.id);
        throw new Error('대회가 시작되지 않았다: ' + JSON.stringify(row)
          + ' · 등록 ' + JSON.stringify(db.prepare(
            `SELECT user_id FROM holdem_entries WHERE tournament_id = ?`).all(made.id)));
      }
      return { id: made.id, tableId: tb.id };
    }
    /** 차례가 열려 있는 동안 계속 행동시킨다(제한 시간은 온전히 남겨 자동 폴드를 막는다). */
    function drive(tableId: number, act: (uid: string) => void): void {
      for (let i = 0; i < 60; i++) {
        const h = HD.getCurrentHand(tableId);
        if (!h || h.ended_at != null || h.to_act_seat == null) break;
        const seat = HD.getSeats(tableId).find(x => x.seat === h.to_act_seat);
        if (!seat) break;
        db.prepare(`UPDATE holdem_hands SET action_deadline = ? WHERE id = ?`)
          .run(nowSec() + HD.ACTION_SEC, h.id);
        act(seat.user_id);
      }
    }
    const c = (rank: number, suit = 0): number => rank * 4 + suit;

    /* ── 한 판에 둘 탈락 → 승자에게 KO 둘 ───────────────────────
       짧은 스택 둘을 서로 다른 금액으로 만들어 전원 올인시킨다. 그러면 사이드 팟이 생기고
       둘 다 그 판에서 나간다.

       승패를 카드로 못 박는다. 예전에는 카드를 심지 않고 "판이 끝난 뒤 실제 승자를 읽어"
       검사했는데, 짧은 쪽(ko_c)이 사이드 팟을 이기면 살아남아 탈락자가 하나뿐이 되어
       세 검사가 같이 무너졌다 — 세 번에 한 번쯤 나오는 실패였다. npm run audit 은 && 로
       엮여 있어 그 한 번이 뒤의 감사를 전부 건너뛰게 만든다.

       그래서 ko_a 에게 AA, 짧은 둘에게 22·33 을 주고 보드를 7·9·J·Q·K 로 깐다.
       보드에 페어·같은 무늬 셋·10 이 없어 트립스·플러시·스트레이트가 나올 수 없고,
       AA 가 확정으로 두 층을 다 가져간다 → 짧은 둘이 같은 판에 털린다. */
    wipe(); seedForWiring();
    for (const p of ['ko_a', 'ko_b', 'ko_c']) mkUser(p, 50_000);
    const t = openTourney(['ko_a', 'ko_b', 'ko_c']);
    const koHand = HD.getCurrentHand(t.tableId)!;
    const koHole: Record<string, number[]> = {
      ko_a: [c(12, 0), c(12, 1)],   // A♠A♥ — 다 가져간다
      ko_b: [c(0, 0), c(0, 1)],     // 2♠2♥
      ko_c: [c(1, 0), c(1, 1)],     // 3♠3♥
    };
    for (const s of HD.getSeats(t.tableId)) {
      db.prepare(`UPDATE holdem_hand_seats SET hole_json = ? WHERE hand_id = ? AND seat = ?`)
        .run(JSON.stringify(koHole[s.user_id]), koHand.id, s.seat);
    }
    // 7♣ 9♦ J♠ Q♥ K♦ — 페어 없음, 같은 무늬 둘까지, 10 없음
    db.prepare(`UPDATE holdem_hands SET board_json = ? WHERE id = ?`)
      .run(JSON.stringify([c(5, 2), c(7, 3), c(9, 0), c(10, 1), c(11, 3)]), koHand.id);
    /* 두 사람만 짧게 만든다. 스택은 핸드 스냅샷도 같이 바꿔야 팟 구조에 반영된다. */
    for (const [uid, v] of [['ko_b', 300], ['ko_c', 900]] as [string, number][]) {
      db.prepare(`UPDATE holdem_hand_seats SET stack = ? WHERE hand_id = ? AND user_id = ?`)
        .run(v, koHand.id, uid);
      db.prepare(`UPDATE holdem_seats SET stack = ? WHERE table_id = ? AND user_id = ?`)
        .run(v, t.tableId, uid);
    }
    drive(t.tableId, uid => {
      if (!HD.holdemAction(uid, 'allin', 0).ok) {
        if (!HD.holdemAction(uid, 'call', 0).ok) HD.holdemAction(uid, 'check', 0);
      }
    });
    const ended = db.prepare(
      `SELECT result_json FROM holdem_hands WHERE table_id = ? AND ended_at IS NOT NULL
        ORDER BY id DESC LIMIT 1`).get(t.tableId) as { result_json: string } | undefined;
    ck('검사 전제: 판이 끝났다', !!ended);
    const busted = db.prepare(
      `SELECT user_id FROM holdem_entries WHERE tournament_id = ? AND elim_seq IS NOT NULL`)
      .all(t.id) as { user_id: string }[];
    /* 스택이 0 이 된 사람만 KO 대상이다. 대회가 끝나면 마지막 생존자에게도 elim_seq 가
       붙으므로(등수를 매기는 방식이다) 그 사람은 빼고 센다. */
    const zeroed = new Set((db.prepare(
      `SELECT user_id FROM holdem_seats WHERE table_id = ? AND stack <= 0`)
      .all(t.tableId) as { user_id: string }[]).map(r => r.user_id));
    const koTotals = (db.prepare(
      `SELECT user_id, ko_count FROM holdem_entries WHERE tournament_id = ?`)
      .all(t.id) as { user_id: string; ko_count: number }[]);
    const sumKo = koTotals.reduce((n, r) => n + r.ko_count, 0);
    ck('검사 전제: 짧은 스택 둘이 털렸다', zeroed.size === 2, [...zeroed].join(','));
    ck('KO 합계가 탈락자 수와 같다', sumKo === zeroed.size, `${sumKo} vs ${zeroed.size}`);
    /* 그 KO 는 전부 한 사람(승자)에게 가 있어야 한다 — 팟을 한 사람이 다 가져간 판이다. */
    const holders = koTotals.filter(r => r.ko_count > 0);
    ck('KO 는 이긴 한 사람에게 몰린다',
      holders.length === 1 && holders[0].ko_count === 2, JSON.stringify(koTotals));
    ck('털린 사람에게는 KO 가 없다', !zeroed.has(holders[0]?.user_id ?? ''),
      `${holders[0]?.user_id} · 털림 ${[...zeroed].join(',')}`);
    void busted;

    /* ── 사이드 팟 — 누가 떨어뜨렸는지가 층으로 갈린다 ─────────
       스택 1 : 2 : 3 으로 셋이 올인하고 손 세기가 A > C > B 인 경우.
         · 층0 (A·B·C) → A 가 가져간다
         · 층1 (B·C)   → C 가 가져간다
       B 만 탈락하고, B 의 마지막 칩은 층1 에 있었으므로 KO 는 C 다.

       한때 "탈락자 순번 i → 층 i" 로 옮겼다가 이 경우에 A 를 세었다 — i 는 탈락자 중
       몇 번째인지일 뿐이고 층은 투입액으로 정해지므로 서로 다른 값이다. 제보로 찾았다.

       손 세기를 카드로 못 박는다: A=AA · C=KK · B=22 에 보드는 3·4·6·9·T 무지개라
       스트레이트·플러시·트립스가 없어 A > C > B 가 보드와 무관하게 확정된다. */
    wipe(); seedForWiring();
    for (const p of ['sp_a', 'sp_b', 'sp_c']) mkUser(p, 50_000);
    const sp = openTourney(['sp_a', 'sp_b', 'sp_c']);
    const spHand = HD.getCurrentHand(sp.tableId)!;
    const spHole: Record<string, number[]> = {
      sp_a: [c(12, 0), c(12, 1)],   // A♠A♥
      sp_c: [c(11, 0), c(11, 1)],   // K♠K♥
      sp_b: [c(0, 0), c(0, 1)],     // 2♠2♥
    };
    for (const s of HD.getSeats(sp.tableId)) {
      db.prepare(`UPDATE holdem_hand_seats SET hole_json = ? WHERE hand_id = ? AND seat = ?`)
        .run(JSON.stringify(spHole[s.user_id]), spHand.id, s.seat);
    }
    db.prepare(`UPDATE holdem_hands SET board_json = ? WHERE id = ?`)
      .run(JSON.stringify([c(1, 2), c(2, 3), c(4, 2), c(7, 3), c(8, 2)]), spHand.id);
    /* 스택은 핸드 스냅샷(holdem_hand_seats.stack)을 바꿔야 한다 — 좌석 표만 바꾸면
       팟 구조가 안 바뀌어 사이드 팟이 아예 생기지 않는다(그렇게 한 번 헛돌았다). */
    for (const [uid, v] of [['sp_a', 1_000], ['sp_b', 2_000], ['sp_c', 3_000]] as [string, number][]) {
      db.prepare(`UPDATE holdem_hand_seats SET stack = ? WHERE hand_id = ? AND user_id = ?`)
        .run(v, spHand.id, uid);
      db.prepare(`UPDATE holdem_seats SET stack = ? WHERE table_id = ? AND user_id = ?`)
        .run(v, sp.tableId, uid);
    }
    drive(sp.tableId, uid => {
      if (!HD.holdemAction(uid, 'allin', 0).ok) {
        if (!HD.holdemAction(uid, 'call', 0).ok) HD.holdemAction(uid, 'check', 0);
      }
    });
    const spRes = db.prepare(
      `SELECT result_json FROM holdem_hands WHERE table_id = ? AND ended_at IS NOT NULL
        ORDER BY id DESC LIMIT 1`).get(sp.tableId) as { result_json: string } | undefined;
    const spPots = spRes ? (JSON.parse(spRes.result_json) as { pots: { eligible: number[] }[] }).pots : [];
    ck('검사 전제: 사이드 팟이 생겼다', spPots.length === 2, JSON.stringify(spPots));
    const spStacks = new Map((db.prepare(
      `SELECT user_id, stack FROM holdem_seats WHERE table_id = ?`).all(sp.tableId) as
      { user_id: string; stack: number }[]).map(r => [r.user_id, r.stack]));
    ck('검사 전제: B 만 털렸다',
      spStacks.get('sp_b') === 0 && (spStacks.get('sp_a') ?? 0) > 0 && (spStacks.get('sp_c') ?? 0) > 0,
      JSON.stringify([...spStacks]));
    ck('사이드 팟 승자(C)가 KO 를 받는다', ko(sp.id, 'sp_c') === 1, String(ko(sp.id, 'sp_c')));
    ck('메인 팟 승자(A)는 KO 를 안 받는다', ko(sp.id, 'sp_a') === 0, String(ko(sp.id, 'sp_a')));

    /* ── 공동 우승(스플릿) — 둘이 같이 떨어뜨린 것으로 본다 ─────
       숏스택이 꼴찌로 터지고 위의 둘이 그 팟을 나눠 가지는 경우. 둘 다 그를 이겼고
       둘 다 그보다 칩이 많으니 둘 다 KO 다 — KO 를 반으로 쪼갤 방법도 없다.
       그래서 탈락자 한 명에 KO 가 둘 붙는다(합계가 탈락자 수보다 클 수 있다).

       동점을 만들려면 같은 랭크의 페어를 무늬만 달리 준다: K♠K♥ 와 K♦K♣ 는
       보드가 도와주지 않으면 정확히 같은 손이다. */
    wipe(); seedForWiring();
    for (const p of ['sq_a', 'sq_b', 'sq_c']) mkUser(p, 50_000);
    const sq = openTourney(['sq_a', 'sq_b', 'sq_c']);
    const sqHand = HD.getCurrentHand(sq.tableId)!;
    const sqHole: Record<string, number[]> = {
      sq_a: [c(0, 0), c(0, 1)],     // 2♠2♥ — 꼴찌
      sq_b: [c(11, 0), c(11, 1)],   // K♠K♥
      sq_c: [c(11, 2), c(11, 3)],   // K♦K♣ — sq_b 와 동점
    };
    for (const s of HD.getSeats(sq.tableId)) {
      db.prepare(`UPDATE holdem_hand_seats SET hole_json = ? WHERE hand_id = ? AND seat = ?`)
        .run(JSON.stringify(sqHole[s.user_id]), sqHand.id, s.seat);
    }
    db.prepare(`UPDATE holdem_hands SET board_json = ? WHERE id = ?`)
      .run(JSON.stringify([c(1, 2), c(2, 3), c(4, 2), c(7, 3), c(8, 2)]), sqHand.id);
    for (const [uid, v] of [['sq_a', 1_000], ['sq_b', 2_000], ['sq_c', 3_000]] as [string, number][]) {
      db.prepare(`UPDATE holdem_hand_seats SET stack = ? WHERE hand_id = ? AND user_id = ?`)
        .run(v, sqHand.id, uid);
      db.prepare(`UPDATE holdem_seats SET stack = ? WHERE table_id = ? AND user_id = ?`)
        .run(v, sq.tableId, uid);
    }
    drive(sq.tableId, uid => {
      if (!HD.holdemAction(uid, 'allin', 0).ok) {
        if (!HD.holdemAction(uid, 'call', 0).ok) HD.holdemAction(uid, 'check', 0);
      }
    });
    const sqStacks = new Map((db.prepare(
      `SELECT user_id, stack FROM holdem_seats WHERE table_id = ?`).all(sq.tableId) as
      { user_id: string; stack: number }[]).map(r => [r.user_id, r.stack]));
    ck('검사 전제: 숏스택만 털렸다',
      sqStacks.get('sq_a') === 0
      && (sqStacks.get('sq_b') ?? 0) > 0 && (sqStacks.get('sq_c') ?? 0) > 0,
      JSON.stringify([...sqStacks]));
    ck('공동 우승 둘 다 KO 를 받는다',
      ko(sq.id, 'sq_b') === 1 && ko(sq.id, 'sq_c') === 1,
      `b=${ko(sq.id, 'sq_b')} c=${ko(sq.id, 'sq_c')}`);
    ck('탈락한 숏스택은 0', ko(sq.id, 'sq_a') === 0);
    /* 이긴 사람이라도 자기가 털렸으면 세지 않는다 — 규칙이 "떨어진 사람보다 최종 칩이
       많은 승자"라서다. 소스에서 그 문이 있는지 본다(그 상황을 판으로 만들기는 어렵다). */
    const hd2 = require('node:fs').readFileSync('src/db/holdem.ts', 'utf8') as string;
    ck('자기도 털린 승자는 세지 않는다',
      /seatStack\.get\(w\.seat\) \?\? 0\) <= s\.stack\) continue/.test(hd2));

    /* ── 우승 + KO 4 이상이면 열린다 ────────────────────────────
       KO 를 넷까지 실제로 쌓으려면 다섯 명이 차례로 나가는 대회를 돌려야 한다. 여기서
       보려는 것은 "대회가 끝날 때 우승자의 KO 를 보고 주는가"이므로, 그 값을 넣고
       실제 finishTournament 를 태운다(위에서 세는 쪽은 이미 확인했다). */
    /* 대회는 최소 인원이 있어 둘로는 시작되지 않는다 — 셋으로 열고 둘을 떨어뜨려 끝낸다. */
    const THREE = ['bh1', 'bh2', 'bh3'];
    const finishWith = (uid: string, kos: number): number => {
      wipe(); seedForWiring();
      for (const p of THREE) mkUser(p, 50_000);
      const tt = openTourney(THREE);
      db.prepare(`UPDATE holdem_entries SET ko_count = ? WHERE tournament_id = ? AND user_id = ?`)
        .run(kos, tt.id, uid);
      /* 나머지를 떨어뜨려 대회를 끝낸다 — 마지막 생존자가 우승이다.
         탈락 순서(elim_seq)를 함께 넣어야 한다. 좌석만 OUT 으로 두면 finishTournament 가
         "순서를 못 받은 사람"으로 보고 생존자보다 뒤에 번호를 주는데, 등수는 늦게 나갈수록
         좋으므로 생존자가 꼴등이 된다(실제로 그렇게 3등이 나왔다). */
      let seq = 0;
      for (const other of THREE.filter(x => x !== uid)) {
        seq++;
        db.prepare(`UPDATE holdem_seats SET stack = 0, presence = 'OUT'
                     WHERE table_id = ? AND user_id = ?`).run(tt.tableId, other);
        db.prepare(`UPDATE holdem_entries SET elim_seq = ?, eliminated_at = ?
                     WHERE tournament_id = ? AND user_id = ?`)
          .run(seq, nowSec(), tt.id, other);
      }
      db.prepare(`UPDATE holdem_hands SET ended_at = ? WHERE table_id = ?`)
        .run(nowSec(), tt.tableId);
      HD.advanceHoldem();
      return tt.id;
    };

    const t4 = finishWith('bh1', 4);
    ck('검사 전제: 대회가 끝났다',
      (db.prepare(`SELECT finished_at AS f FROM holdem_tournaments WHERE id = ?`).get(t4) as
        { f: number | null }).f != null);
    ck('검사 전제: bh1 이 우승이다',
      (db.prepare(`SELECT finish_place AS p FROM holdem_entries
                    WHERE tournament_id = ? AND user_id = 'bh1'`).get(t4) as
        { p: number | null }).p === 1);
    ck('KO 4 + 우승이면 열린다', A.hasAchievement('bh1', 'ho-bounty-4'));

    const t3 = finishWith('bh1', 3);
    ck('KO 3 이면 안 열린다', !A.hasAchievement('bh1', 'ho-bounty-4'), String(ko(t3, 'bh1')));

    /* KO 는 넉넉해도 우승이 아니면 안 준다 — 조건의 절반이 우승이다.
       bh1 을 우승시키고 KO 는 bh2 에게 잔뜩 준다. */
    const tl = finishWith('bh1', 0);
    db.prepare(`UPDATE holdem_entries SET ko_count = 9 WHERE tournament_id = ? AND user_id = 'bh2'`)
      .run(tl);
    ck('검사 전제: bh2 는 우승이 아니다',
      (db.prepare(`SELECT finish_place AS p FROM holdem_entries
                    WHERE tournament_id = ? AND user_id = 'bh2'`).get(tl) as
        { p: number | null }).p !== 1);
    ck('우승이 아니면 KO 가 많아도 안 준다', !A.hasAchievement('bh2', 'ho-bounty-4'));

    /* 되감기(운영자)를 하면 KO 도 0 으로 돌아가야 한다 — 안 그러면 되감기 전의 KO 가
       남아 다시 돌린 대회에서 실제보다 많이 세어진다. */
    wipe(); seedForWiring();
    for (const p of ['rw1', 'rw2', 'rw3']) mkUser(p, 50_000);
    const tr = openTourney(['rw1', 'rw2', 'rw3']);
    db.prepare(`UPDATE holdem_entries SET ko_count = 5 WHERE tournament_id = ? AND user_id = 'rw1'`)
      .run(tr.id);
    HD.adminResetRunningTournament();
    ck('되감으면 KO 가 0 이 된다', ko(tr.id, 'rw1') === 0, String(ko(tr.id, 'rw1')));

    /* 기준이 설명과 같은가 — 4 라고 적어 놓고 5 에 주면 아무도 이상하다고 못 느낀다. */
    const hdSrc = require('node:fs').readFileSync('src/db/holdem.ts', 'utf8') as string;
    const byId4 = new Map(A.listAchievements().map(a => [a.id, a]));
    ck('KO 기준이 설명과 같다',
      /KO_GOAL = 4/.test(hdSrc) && !!byId4.get('ho-bounty-4')?.description.includes('4명 이상'),
      byId4.get('ho-bounty-4')?.description);
    ck('판정 오류가 대회 정산을 막지 않는다',
      /function awardBounty[\s\S]*?try \{[\s\S]*?catch/.test(hdSrc));
    /* KO 기록이 던져도 판은 계속 가야 한다 — 여기는 팟이 이미 나뉜 뒤라, 던지면 그 다음
       처리(다음 판 예약)가 통째로 안 돈다. 세는 자리에 try/catch 가 있는지 본다. */
    const elim = hdSrc.slice(hdSrc.indexOf('function eliminateBusted'),
      hdSrc.indexOf('function finishTournament'));
    ck('KO 기록 오류도 판을 멈추지 않는다',
      /try \{[\s\S]*ko_count = ko_count \+ 1[\s\S]*?catch/.test(elim), elim.slice(0, 60));

    db.exec(`DELETE FROM holdem_hand_seats; DELETE FROM holdem_hands;
             DELETE FROM holdem_seats; DELETE FROM holdem_tables;
             DELETE FROM holdem_entries; DELETE FROM holdem_tournaments;`);
  }

  /* ── 8-8. 바카라 «플레이어» 7연승 ──────────────────────────── */
  section('[8-8] 바카라 — 플레이어에만 걸어 7연승');
  {
    const BQ = require('../src/db/queries/bacc') as typeof import('../src/db/queries/bacc');
    const BW = require('../src/web/games/baccarat') as typeof import('../src/web/games/baccarat');
    const ST = require('../src/db/streaks') as typeof import('../src/db/streaks');

    /* 라운드를 만들고 결과를 못 박아 실제 정산을 태운다 — 연승이 정말 그 자리에서
       쌓이는지 확인하려면 settleBaccaratBets 를 지나야 한다. */
    function playRound(bets: { user: string; market: string; amount: number }[],
      winner: 'player' | 'banker' | 'tie'): void {
      db.exec(`DELETE FROM baccarat_bets; DELETE FROM baccarat_rounds;`);
      db.prepare(`INSERT INTO baccarat_rounds (phase, betting_ends_at, cards_json)
                  VALUES ('betting', ?, '[]')`).run(0);
      const rid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
      for (const b of bets) {
        db.prepare(`INSERT INTO baccarat_bets (round_id, user_id, username, market, amount, odds)
                    VALUES (?, ?, ?, ?, ?, 2)`).run(rid, b.user, b.user, b.market, b.amount);
      }
      const o = {
        winner, playerTotal: winner === 'player' ? 9 : 5, bankerTotal: winner === 'banker' ? 9 : 5,
        playerPair: false, bankerPair: false, natural: false, playerCards: [], bankerCards: [],
      };
      BQ.settleBaccaratBetsForAudit(rid, o);
      /* 정산한 라운드는 done 으로 닫아 둔다. 안 닫으면 아래 handleState 의 advance 가
         같은 라운드를 실제 카드로 다시 정산해 won 을 덮어쓴다 — 그러면 연승은 쌓였는데
         "마지막 승리 판의 베팅액"이 0 이 되어 문지기에 막힌다(실제로 그렇게 실패했다). */
      db.prepare(`UPDATE baccarat_rounds SET phase = 'done', result_json = ?, resolved_at = ?
                   WHERE id = ?`).run(JSON.stringify(o), Math.floor(Date.now() / 1000), rid);
    }

    wipe(); seedForWiring(); mkUser('P7', 1_000_000);
    const streak = (): number => ST.getStreak('P7', 'bacc_player_win');

    for (let i = 1; i <= 6; i++) {
      playRound([{ user: 'P7', market: 'player', amount: 1_000 }], 'player');
      ck(`플레이어 승리 ${i}연승`, streak() === i, String(streak()));
    }
    /* 쉬어가는 판 — 안 건 사람은 정산 루프에 오지 않으므로 값이 그대로다. */
    playRound([{ user: 'other', market: 'player', amount: 1_000 }], 'player');
    ck('쉬어간 판은 연승이 유지된다', streak() === 6, String(streak()));
    /* 타이는 원금이 돌아온다 — 이긴 것도 잃은 것도 아니라 쉬어간 판으로 본다. */
    playRound([{ user: 'P7', market: 'player', amount: 1_000 }], 'tie');
    ck('타이도 연승이 유지된다', streak() === 6, String(streak()));

    playRound([{ user: 'P7', market: 'player', amount: 1_000 }], 'player');
    ck('7연승이 됐다', streak() === 7, String(streak()));
    ck('아직은 응답을 안 받아 미달성', !A.hasAchievement('P7', 'bc-player-7'));

    let body = '';
    const res = {
      writeHead() { }, end(c?: unknown) { if (c != null) body += String(c); },
      getHeader() { return undefined; }, setHeader() { }, headersSent: false,
    };
    await BW.handleState({} as never, res as never, 'P7');
    ck('상태 응답에 달성이 실려 온다',
      ((JSON.parse(body) as { unlocked?: { id: string }[] }).unlocked ?? [])
        .some(u => u.id === 'bc-player-7'), body.slice(0, 200));
    ck('기록에도 남았다', A.hasAchievement('P7', 'bc-player-7'));

    /* ── 끊기는 조건들 ──────────────────────────────────────── */
    const fresh = (id: string): void => { wipe(); seedForWiring(); mkUser(id, 1_000_000); };
    const runUp = (id: string, n: number): void => {
      for (let i = 0; i < n; i++) playRound([{ user: id, market: 'player', amount: 1_000 }], 'player');
    };

    fresh('P1'); runUp('P1', 3);
    playRound([{ user: 'P1', market: 'player', amount: 1_000 }], 'banker');
    ck('지면 끊긴다', ST.getStreak('P1', 'bacc_player_win') === 0);

    /* "오직" 플레이어에만 — 뱅커를 함께 걸면 양다리라 끊는다. 이걸 안 막으면
       플레이어+뱅커를 동시에 걸어 사실상 확정 연승을 쌓을 수 있다. */
    fresh('P2'); runUp('P2', 3);
    playRound([
      { user: 'P2', market: 'player', amount: 1_000 },
      { user: 'P2', market: 'banker', amount: 1_000 },
    ], 'player');
    ck('뱅커를 함께 걸면 끊긴다', ST.getStreak('P2', 'bacc_player_win') === 0,
      String(ST.getStreak('P2', 'bacc_player_win')));

    fresh('P3'); runUp('P3', 3);
    playRound([
      { user: 'P3', market: 'player', amount: 1_000 },
      { user: 'P3', market: 'ppair', amount: 1_000 },
    ], 'player');
    ck('페어를 함께 걸어도 끊긴다', ST.getStreak('P3', 'bacc_player_win') === 0);

    fresh('P4'); runUp('P4', 3);
    playRound([{ user: 'P4', market: 'banker', amount: 1_000 }], 'banker');
    ck('뱅커로 이겨도 끊긴다', ST.getStreak('P4', 'bacc_player_win') === 0);

    /* 소액은 연승에 넣지 않는다 — 1P 로 쌓아 놓고 마지막만 크게 거는 길을 막는다. */
    fresh('P5'); runUp('P5', 3);
    playRound([{ user: 'P5', market: 'player', amount: 999 }], 'player');
    ck('999P 승리는 연승에 안 들어간다', ST.getStreak('P5', 'bacc_player_win') === 3,
      String(ST.getStreak('P5', 'bacc_player_win')));
    ck('그렇다고 끊지도 않는다 (쉬어간 판으로 본다)',
      ST.getStreak('P5', 'bacc_player_win') === 3);

    fresh('P6'); runUp('P6', 6);
    let b6 = '';
    const res6 = {
      writeHead() { }, end(c?: unknown) { if (c != null) b6 += String(c); },
      getHeader() { return undefined; }, setHeader() { }, headersSent: false,
    };
    await BW.handleState({} as never, res6 as never, 'P6');
    ck('6연승에서는 안 열린다', !A.hasAchievement('P6', 'bc-player-7'));

    db.exec(`DELETE FROM baccarat_bets; DELETE FROM baccarat_rounds;`);
  }

  /* ── 8-9. 나 혼자만 1등 ──────────────────────────────────────── */
  section('[8-9] 전 종목 1위로 시즌 종료');
  {
    const S2 = require('../src/db/queries/season') as typeof import('../src/db/queries/season');
    const { RANK_GAMES } = require('../src/services/ranking') as typeof import('../src/services/ranking');
    const GAMES = [...new Set(Object.values(RANK_GAMES))];

    /** 그 사람을 그 게임 1위로 만든다(순수익이 제일 크면 1위다). */
    const top = (uid: string, game: string, profit: number): void => {
      Q.bumpGameStats(uid, game, 1_000, 1_000 + profit);
    };
    function newSeason(): number {
      db.exec(`DELETE FROM seasons; DELETE FROM season_stats; DELETE FROM season_results;
               DELETE FROM holdem_entries; DELETE FROM holdem_tournaments;`);
      return S2.currentSeason().id;
    }
    /** 그 시즌에 끝난 대회 하나를 만들어 우승자를 정한다(홀덤 1위). */
    function holdemWin(uid: string): void {
      const now = Math.floor(Date.now() / 1000);
      db.prepare(`INSERT INTO holdem_tournaments
                    (id, date_str, title, reg_open_at, scheduled_start_at, grace_ends_at,
                     prize_multiplier, started_at, finished_at)
                  VALUES (901, '2026-08-10', '표본', ?, ?, ?, 1000, ?, ?)`)
        .run(now - 60, now - 50, now - 40, now - 50, now - 10);
      db.prepare(`INSERT INTO holdem_entries
                    (tournament_id, user_id, username, registered_at, finish_place, prize)
                  VALUES (901, ?, ?, ?, 1, 5000)`).run(uid, uid, now - 60);
    }

    /* 전 종목 1위 — 열린다. */
    wipe(); seedForWiring();
    newSeason();
    mkUser('king', 10_000); mkUser('sub', 10_000);
    for (const g of GAMES) { top('king', g, 10_000); top('sub', g, 1_000); }
    holdemWin('king');
    ck('검사 전제: 종목이 여섯 이상이다', GAMES.length >= 6, String(GAMES.length));
    S2.closeSeason({ seed: 0, nextName: '다음' });
    ck('전 종목 1위면 열린다', A.hasAchievement('king', 'all-first-1'));
    ck('2위에게는 안 준다', !A.hasAchievement('sub', 'all-first-1'));

    /* 한 종목만 남에게 내주면 안 열린다. */
    wipe(); seedForWiring();
    newSeason();
    mkUser('k2', 10_000); mkUser('s2', 10_000);
    for (const g of GAMES) { top('k2', g, 10_000); top('s2', g, 1_000); }
    top('s2', GAMES[0], 99_000);                     // 이 종목만 s2 가 1위
    holdemWin('k2');
    S2.closeSeason({ seed: 0, nextName: '다음' });
    ck('한 종목이라도 놓치면 안 열린다', !A.hasAchievement('k2', 'all-first-1'));

    /* 홀덤 1위가 다른 사람이면 안 열린다 — 홀덤도 카테고리다. */
    wipe(); seedForWiring();
    newSeason();
    mkUser('k3', 10_000); mkUser('s3', 10_000);
    for (const g of GAMES) top('k3', g, 10_000);
    holdemWin('s3');
    S2.closeSeason({ seed: 0, nextName: '다음' });
    ck('홀덤을 놓치면 안 열린다', !A.hasAchievement('k3', 'all-first-1'));

    /* 아무도 안 한 종목이 있으면 "전 종목"이 성립하지 않는다. */
    wipe(); seedForWiring();
    newSeason();
    mkUser('k4', 10_000);
    for (const g of GAMES.slice(1)) top('k4', g, 10_000);   // 한 종목 비어 있음
    holdemWin('k4');
    S2.closeSeason({ seed: 0, nextName: '다음' });
    ck('빈 종목이 있으면 안 열린다', !A.hasAchievement('k4', 'all-first-1'));

    /* 홀덤 기록이 없는 시즌도 마찬가지다. */
    wipe(); seedForWiring();
    newSeason();
    mkUser('k5', 10_000);
    for (const g of GAMES) top('k5', g, 10_000);
    S2.closeSeason({ seed: 0, nextName: '다음' });
    ck('홀덤 기록이 없으면 안 열린다', !A.hasAchievement('k5', 'all-first-1'));

    /* 판정이 던져도 시즌은 닫혀야 한다 — 여기서 롤백되면 성적표도 초기화도 안 된다. */
    const sn = require('node:fs').readFileSync('src/db/queries/season.ts', 'utf8') as string;
    ck('판정 오류가 시즌 마감을 막지 않는다',
      /function awardSeasonSweep[\s\S]*?try \{[\s\S]*?catch/.test(sn));
    /* 카테고리 목록을 여기 적지 않는다 — 게임이 늘면 RANK_GAMES 에 한 줄이 들어가고
       이 과제의 조건도 함께 넓어져야 한다(요청 사항이다). */
    ck('종목 목록을 RANK_GAMES 에서 읽는다', /RANK_GAMES/.test(sn));
    ck('종목 이름을 손으로 적지 않는다', !/'baccarat'[\s\S]{0,80}'blackjack'/.test(sn));

    db.exec(`DELETE FROM holdem_entries; DELETE FROM holdem_tournaments; DELETE FROM seasons;`);
  }

  /* ── 8-10. 롤러코스터 ────────────────────────────────────────── */
  section('[8-10] 롤러코스터 — 오늘 출석 뒤 바닥을 찍고 되살아난다');
  {
    const HK = require('../src/web/achieve-hook') as typeof import('../src/web/achieve-hook');
    const LOW = 1_000, HIGH = 100_000;
    /** 원장에 한 줄 남긴다 — 잔액의 궤적은 이 표에만 있다. */
    const ledger = (uid: string, delta: number, reason: string): void => {
      Q.adjustBalance(uid, delta, reason);
    };
    /** 지금 잔액을 정확히 그 값으로 맞춘다(원장에 그 궤적이 남는다). */
    const setTo = (uid: string, v: number, reason: string): void => {
      ledger(uid, v - (Q.getWebUser(uid)?.balance ?? 0), reason);
    };

    wipe(); seedForWiring(); mkUser('rc1', 0);
    setTo('rc1', 5_000, 'attendance');            // 오늘 출석
    setTo('rc1', 800, 'game:mines');              // 바닥
    setTo('rc1', 120_000, 'game:mines');          // 되살아남
    ck('출석 → 바닥 → 회복이면 열린다',
      HK.commonAwards('rc1').some(u => u.id === 'roller-coaster'),
      String(Q.getWebUser('rc1')!.balance));
    ck('기록에도 남았다', A.hasAchievement('rc1', 'roller-coaster'));

    /* 여기가 요청서가 특히 짚은 지점이다: 출석 "전"에 찍은 바닥은 세지 않는다.
       어제 밤에 0원으로 잠든 사람이 오늘 출석만으로 조건 절반을 채우면 안 된다. */
    wipe(); seedForWiring(); mkUser('rc2', 0);
    setTo('rc2', 500, 'game:mines');              // 출석 전 바닥
    setTo('rc2', 5_000, 'attendance');
    setTo('rc2', 150_000, 'game:mines');          // 그 뒤로는 떨어진 적이 없다
    ck('출석 전 바닥은 안 센다',
      !HK.commonAwards('rc2').some(u => u.id === 'roller-coaster'));
    ck('그래서 기록에도 없다', !A.hasAchievement('rc2', 'roller-coaster'));

    /* 순서도 조건이다 — 회복한 뒤에 떨어진 것은 "되살아났다"가 아니다. */
    wipe(); seedForWiring(); mkUser('rc3', 0);
    setTo('rc3', 5_000, 'attendance');
    setTo('rc3', 150_000, 'game:mines');
    setTo('rc3', 900, 'game:mines');
    ck('회복 뒤에 떨어진 것은 아니다',
      !HK.commonAwards('rc3').some(u => u.id === 'roller-coaster'));

    /* 파산 지원금으로 올라온 것도 인정한다(요청 사항). 지원금은 원장의 한 줄이므로
       따로 처리할 것이 없다 — 그게 원장만 보는 이유다. */
    wipe(); seedForWiring(); mkUser('rc4', 0);
    setTo('rc4', 5_000, 'attendance');
    setTo('rc4', 0, 'game:mines');
    ledger('rc4', 1_000, 'disaster_relief');      // 지원금으로 1,000P
    setTo('rc4', 100_000, 'game:mines');
    ck('지원금으로 올라온 뒤 회복도 인정한다',
      HK.commonAwards('rc4').some(u => u.id === 'roller-coaster'));

    /* 경계 — 정확히 1,000P 와 정확히 100,000P 는 들어간다("이하"·"이상"이다). */
    wipe(); seedForWiring(); mkUser('rc5', 0);
    setTo('rc5', 5_000, 'attendance');
    setTo('rc5', LOW, 'game:mines');
    setTo('rc5', HIGH, 'game:mines');
    ck('경계값도 인정한다', HK.commonAwards('rc5').some(u => u.id === 'roller-coaster'));

    wipe(); seedForWiring(); mkUser('rc6', 0);
    setTo('rc6', 5_000, 'attendance');
    setTo('rc6', LOW + 1, 'game:mines');
    setTo('rc6', HIGH, 'game:mines');
    ck('1,001P 는 바닥이 아니다', !HK.commonAwards('rc6').some(u => u.id === 'roller-coaster'));

    wipe(); seedForWiring(); mkUser('rc7', 0);
    setTo('rc7', 5_000, 'attendance');
    setTo('rc7', LOW, 'game:mines');
    setTo('rc7', HIGH - 1, 'game:mines');
    ck('99,999P 는 회복이 아니다', !HK.commonAwards('rc7').some(u => u.id === 'roller-coaster'));

    /* 출석을 안 한 날은 아예 성립하지 않는다. */
    wipe(); seedForWiring(); mkUser('rc8', 0);
    setTo('rc8', 500, 'game:mines');
    setTo('rc8', 200_000, 'game:mines');
    ck('출석이 없으면 안 열린다', !HK.commonAwards('rc8').some(u => u.id === 'roller-coaster'));

    /* 어제의 궤적은 오늘과 섞이지 않는다 — 하루의 경계는 KST 다. */
    wipe(); seedForWiring(); mkUser('rc9', 0);
    setTo('rc9', 5_000, 'attendance');
    setTo('rc9', 700, 'game:mines');
    // 위 세 줄을 어제로 밀어 둔다
    db.prepare(`UPDATE points_ledger SET created_at = created_at - 86400 WHERE user_id = 'rc9'`).run();
    setTo('rc9', 300_000, 'game:mines');          // 오늘 회복
    ck('어제 바닥 + 오늘 회복은 아니다',
      !HK.commonAwards('rc9').some(u => u.id === 'roller-coaster'));

    /* 값싸야 한다 — 잔액이 목표에 못 미치면 원장을 보지도 않는다. */
    const hookSrc = require('node:fs').readFileSync('src/web/achieve-hook.ts', 'utf8') as string;
    ck('잔액으로 먼저 거른다', /< ROLLER_HIGH\) return \[\];/.test(hookSrc));
    ck('기준이 설명과 같다',
      /ROLLER_LOW = 1_000/.test(hookSrc) && /ROLLER_HIGH = 100_000/.test(hookSrc));
    const byId3 = new Map(A.listAchievements().map(a => [a.id, a]));
    ck('설명이 같은 숫자를 말한다',
      !!byId3.get('roller-coaster')?.description.includes('1,000P')
      && !!byId3.get('roller-coaster')?.description.includes('100,000P'),
      byId3.get('roller-coaster')?.description);
  }

  /* ── 8-11. 문지기 전수 검사 ─────────────────────────────────── */
  section('[8-11] 모든 과제의 최소 베팅이 실제로 막는가');
  {
    /* 과제마다 min_bet 을 적어 두었지만, 그 값이 실제로 지키는지는 별개다 — 판정 함수가
       awardIfBet 을 지나지 않으면 표의 숫자는 글자로만 남는다. 표에 있는 과제 전부에 대해
       "기준 1P 아래에서는 안 주고, 기준에서는 준다"를 직접 확인한다.

       조건 함수는 항상 참으로 둔다. 여기서 보려는 것은 조건이 아니라 문지기다 —
       조건 자체는 위의 절들이 게임별로 이미 확인했다. */
    wipe();
    seedForWiring();
    const all = A.listAchievements();
    ck('검사할 과제가 있다', all.length >= 16, String(all.length));
    for (const a of all) {
      const uid = 'gate_' + a.id.replace(/-/g, '_');
      mkUser(uid);
      if (a.min_bet > 0) {
        ck(`${a.id} — ${a.min_bet - 1}P 로는 안 준다`,
          !A.awardIfBet(uid, a.id, a.min_bet - 1, () => true).unlocked);
        ck(`${a.id} — ${a.min_bet}P 면 준다`,
          A.awardIfBet(uid, a.id, a.min_bet, () => true).unlocked);
      } else {
        /* 기준이 0 인 과제는 금액과 무관해야 한다 — 0P 로도 열려야 그 말이 참이 된다.
           (베팅이 없는 과제들이다: 지원금·프리롤·시즌 마감·잔액 궤적·손 속도) */
        ck(`${a.id} — 0P 로도 준다`, A.awardIfBet(uid, a.id, 0, () => true).unlocked);
      }
      // 어느 쪽이든 두 번은 주지 않는다
      ck(`${a.id} — 두 번은 안 준다`,
        !A.awardIfBet(uid, a.id, a.min_bet, () => true).unlocked);
      // 조건이 거짓이면 금액이 충분해도 안 준다
      const other = uid + '_x';
      mkUser(other);
      ck(`${a.id} — 조건이 거짓이면 안 준다`,
        !A.awardIfBet(other, a.id, a.min_bet + 1_000, () => false).unlocked);
    }

    /* 달성하면 알림이 하나 생긴다 — 이게 없으면 화면에 아무 일도 안 일어난다.
       전부에 대해 확인한다: 알림을 만드는 곳이 한 군데라 하나만 봐도 될 것 같지만,
       그 "한 군데"가 맞는지를 보는 것이 이 검사다. */
    const noti = db.prepare(
      `SELECT COUNT(*) AS n FROM notifications WHERE type = 'ACHIEVEMENT'`).get() as { n: number };
    ck('달성마다 알림이 남는다', noti.n === all.length, `${noti.n} vs ${all.length}`);
  }

  /* ── 9. 입력 검증 ───────────────────────────────────────────── */
  section('[9] 과제 등록 — 잘못된 값 거절');
  {
    wipe();
    ck('빈 아이디 거절', !A.upsertAchievement({ id: '', gameType: 'ALL', title: 't' }).ok);
    ck('대문자 아이디 거절', !A.upsertAchievement({ id: 'AB', gameType: 'ALL', title: 't' }).ok);
    ck('공백 아이디 거절', !A.upsertAchievement({ id: 'a b', gameType: 'ALL', title: 't' }).ok);
    ck('빈 제목 거절', !A.upsertAchievement({ id: 'ok-1', gameType: 'ALL', title: '  ' }).ok);
    ck('없는 분류 거절', !A.upsertAchievement({ id: 'ok-1', gameType: 'CHESS', title: 't' }).ok);
    ck('음수 최소 베팅 거절', !A.upsertAchievement({ id: 'ok-1', gameType: 'ALL', title: 't', minBet: -1 }).ok);
    ck('거절된 것은 남지 않는다', A.achievementsFor(null).length === 0);
    ck('정상 등록은 통과', A.upsertAchievement({ id: 'ok-1', gameType: 'ALL', title: 't' }).ok);
    ck('기본 최소 베팅은 100P', A.achievementsFor(null)[0].minBet === A.DEFAULT_MIN_BET);
    ck('같은 아이디는 덮어쓴다',
      (A.upsertAchievement({ id: 'ok-1', gameType: 'ALL', title: '바뀐 제목' }),
        A.achievementsFor(null).length === 1 && A.achievementsFor(null)[0].title === '바뀐 제목'));
  }

  /* ── 10-1. 달성자 ───────────────────────────────────────────── */
  section('[10-1] 달성자 — 누가 해냈는지');
  {
    wipe();
    for (const u of ['w1', 'w2', 'w3']) mkUser(u);
    A.upsertAchievement({ id: 'open-1', gameType: 'HOLDEM', title: '공개 과제', description: '' });
    A.upsertAchievement({ id: 'hid-1', gameType: 'CRASH', title: '감춘 과제', description: '', isHidden: true });
    ck('아무도 안 했으면 0명', A.unlockCount('open-1') === 0);
    ck('명단도 비어 있다', A.unlockersOf('open-1').length === 0);

    A.unlockAchievement('w1', 'open-1');
    A.unlockAchievement('w2', 'open-1');
    ck('두 명이 했으면 2명', A.unlockCount('open-1') === 2, String(A.unlockCount('open-1')));
    const list = A.unlockersOf('open-1');
    ck('명단에 이름과 아바타가 함께 온다',
      list.length === 2 && list[0].username === 'w1' && 'avatar' in list[0], JSON.stringify(list[0]));
    /* 먼저 해낸 사람이 위다. 이 목록의 의미가 "누가 먼저 했나"라서 순서가 곧 내용이다. */
    ck('먼저 달성한 순서다', list[0].userId === 'w1' && list[1].userId === 'w2',
      list.map(x => x.userId).join(','));
    ck('상한이 지켜진다', A.unlockersOf('open-1', 1).length === 1);

    const counts = A.unlockCounts();
    ck('한 번에 세는 값도 같다', counts.get('open-1') === 2, String(counts.get('open-1')));

    /* 감춘 과제도 "누가 해냈나"는 보여준다. 감추는 것은 조건이지 사람이 아니다 —
       해낸 사람이 보이지 않으면 그 과제는 아무도 이야기하지 않는 칸으로 남는다.
       대신 이름과 설명은 여전히 지워져 있어야 한다. 그 둘이 감춤의 전부다. */
    A.unlockAchievement('w1', 'hid-1');
    const seenByOther = A.achievementsFor('w3').find(v => v.id === 'hid-1')!;
    ck('감춘 과제도 달성 인원은 보인다', seenByOther.unlockedBy === 1,
      String(seenByOther.unlockedBy));
    ck('로그인 안 한 화면에서도 보인다',
      A.achievementsFor(null).find(v => v.id === 'hid-1')!.unlockedBy === 1);
    ck('이름은 남에게도 보인다', seenByOther.title === '감춘 과제', seenByOther.title);
    ck('그래도 설명은 가려져 있다',
      seenByOther.description === A.HIDDEN_DESC, seenByOther.description);
    /* 명단도 내준다 — 화면의 버튼이 부르는 그 길이다. 예전에는 여기서 403 을 돌려줘서
       카드에 인원만 뜨고 눌러도 아무것도 안 나오는 상태가 됐을 것이다. */
    ck('감춘 과제의 달성자 명단도 내준다',
      A.unlockersOf('hid-1', 5).some(u => u.userId === 'w1'),
      A.unlockersOf('hid-1', 5).map(u => u.userId).join(','));
    /* 본인이 달성했으면 이미 내용을 아는 사람이다 — 그때는 이름까지 보여 준다. */
    const seenByOwner = A.achievementsFor('w1').find(v => v.id === 'hid-1')!;
    ck('달성한 본인에게는 인원이 보인다', seenByOwner.unlockedBy === 1, String(seenByOwner.unlockedBy));
    ck('달성한 본인에게는 이름도 보인다', seenByOwner.title !== '???', seenByOwner.title);
    ck('공개 과제는 누구에게나 인원이 보인다',
      A.achievementsFor('w3').find(v => v.id === 'open-1')!.unlockedBy === 2);

    // 같은 사람이 두 번 달성해도 인원은 하나
    A.unlockAchievement('w1', 'open-1');
    ck('중복 달성은 인원을 늘리지 않는다', A.unlockCount('open-1') === 2,
      String(A.unlockCount('open-1')));
  }

  /* ── 10. 탭 ─────────────────────────────────────────────────── */
  section('[10] 탭 — 모든 분류가 어딘가에 들어간다');
  {
    /* 탭에 안 들어가는 분류가 생기면 그 과제는 [전체] 에서만 보이고 어떤 탭을 눌러도
       안 나온다 — 만든 사람은 화면에서 사라진 것으로 본다. */
    const covered = new Set<string>();
    for (const t of A.ACH_TABS) for (const g of t.types) covered.add(g);
    const missing = A.GAME_TYPES.filter(g => !covered.has(g));
    ck('빠진 분류가 없다', missing.length === 0, missing.join(','));
    ck('[전체] 탭은 거르지 않는다', A.ACH_TABS[0].types.length === 0);
  }

  /* ── 11. 감춘 카드 아이콘 ─────────────────────────────────────── */
  section('[11] 감춘 카드 — 아이콘은 자물쇠가 아니라 그 게임의 것이다');
  {
    /* 자물쇠를 그리면 아이콘 칸이 "어느 게임인가"를 못 알려 준다. 아래 이름표는
       [그래프]인데 그림은 자물쇠라 둘이 어긋나 보이기도 했다. 가리는 것은 설명뿐이다. */
    const W = require('../src/web/achievements') as typeof import('../src/web/achievements');
    const I = require('../src/web/icons') as typeof import('../src/web/icons');
    db.exec(`DELETE FROM achievements; DELETE FROM user_achievements;`);
    Q.upsertUser('ic1', 'ic1', null);
    A.upsertAchievement({
      id: 'ic-crash', gameType: 'CRASH', title: '감춘 그래프 과제',
      description: '실제 조건', sortAt: 1, isHidden: true, minBet: 0,
    });
    A.upsertAchievement({
      id: 'ic-open', gameType: 'CRASH', title: '공개 그래프 과제',
      description: '실제 조건', sortAt: 2, isHidden: false, minBet: 0,
    });
    const html = W.achievementsPage({ id: 'ic1', username: 'ic1', avatar: null } as any);
    /* 카드 단위로 잘라 본다. 페이지 전체에서 찾으면 옆 카드의 아이콘에 속는다. */
    const cardOf = (title: string): string => {
      const at = html.indexOf(title);
      if (at < 0) return '';
      const from = html.lastIndexOf('<div class="ac-card', at);
      return html.slice(from, at);
    };
    const secret = cardOf('감춘 그래프 과제');
    const open = cardOf('공개 그래프 과제');
    ck('감춘 카드가 그려진다', secret.length > 0);
    ck('감춘 카드에 그래프 아이콘이 있다', secret.includes(I.chartIcon));
    ck('감춘 카드에 자물쇠가 없다', !/rect[^>]*y="10\.5"/.test(secret));
    ck('공개 카드와 같은 아이콘이다', open.includes(I.chartIcon));
    ck('이름표는 그래프다', secret.includes('>그래프<'));
    // 아이콘을 열어도 설명은 계속 가려 둔다
    ck('설명은 여전히 가려져 있다', html.includes(A.HIDDEN_DESC));
    ck('감춘 카드에 실제 조건이 없다', !secret.includes('실제 조건'));
    ck('감춘 카드 표시는 남는다', secret.includes('secret'));
    ck('감춘 제목은 보인다', html.includes('감춘 그래프 과제'));
    /* 소스에 자물쇠 그림이 남아 있으면 언젠가 되살아난다 */
    const src = require('node:fs').readFileSync('src/web/achievements.ts', 'utf8');
    ck('소스에 자물쇠 아이콘이 없다', !/LOCK_ICON/.test(src));
  }

  /* ── 12. 목록 순서 ───────────────────────────────────────────── */
  section('[12] 목록 순서 — 많이 해낸 것이 위, 동률은 게임별 묶음');
  {
    db.exec(`DELETE FROM achievements; DELETE FROM user_achievements;`);
    // sort_at 을 일부러 뒤섞어 넣는다 — 넣은 순서가 아니라 sort_at 을 보는지 확인한다
    const seed: [string, number, number][] = [   // [id, sort_at, 달성자 수]
      ['z-common', 90, 3],   // 가장 흔하다 → 맨 위
      ['b-mid', 20, 1],
      ['a-rare', 10, 0],     // 동률 0명 중 sort_at 이 가장 앞
      ['c-rare', 30, 0],
      ['d-rare', 25, 0],
    ];
    for (const [id, sortAt] of seed) {
      A.upsertAchievement({
        id, gameType: 'ALL', title: id, description: 'x', sortAt, minBet: 0,
      });
    }
    let u = 0;
    for (const [id, , n] of seed) {
      for (let i = 0; i < n; i++) { const who = `su${u++}`; Q.upsertUser(who, who, null); A.unlockAchievement(who, id); }
    }
    const order = A.achievementsFor(null).map(v => v.id);
    ck('많이 해낸 것이 위로 온다', order.join(',') === 'z-common,b-mid,a-rare,d-rare,c-rare', order.join(','));
    /* 동률은 sort_at 순이어야 한다. 안정 정렬에 기대고 있으므로, 그 성질이 깨지면
       여기서 잡힌다 — a(10) → d(25) → c(30) 이고 넣은 순서(a,c,d)와는 다르다.
       내림차순으로 뒤집어도 동률 안에서는 오름차순 그대로여야 한다(뒤집힌 순서가 아니다). */
    const ties = order.slice(2);
    ck('동률은 게임별 묶음(sort_at) 순', ties.join(',') === 'a-rare,d-rare,c-rare', ties.join(','));

    /* 내가 깼다고 자리가 움직이면 안 된다 — 달성자 수만 본다. */
    Q.upsertUser('me1', 'me1', null);
    A.unlockAchievement('me1', 'b-mid');   // 1명 → 2명 (여전히 z-common 3명 아래)
    const mineOrder = A.achievementsFor('me1').map(v => v.id);
    ck('달성 여부가 자리를 바꾸지 않는다',
      mineOrder.join(',') === 'z-common,b-mid,a-rare,d-rare,c-rare', mineOrder.join(','));
    ck('달성 표시는 남아 있다',
      A.achievementsFor('me1').find(v => v.id === 'b-mid')!.unlocked);
    /* 달성자 수가 뒤집히면 순서도 뒤집힌다 — 정렬이 실제로 그 값을 본다는 증거다. */
    for (let i = 0; i < 5; i++) { const who = `bm${i}`; Q.upsertUser(who, who, null); A.unlockAchievement(who, 'b-mid'); }
    const flipped = A.achievementsFor(null).map(v => v.id);
    ck('많아지면 위로 올라간다', flipped[0] === 'b-mid', flipped.join(','));
    ck('아무도 못 깬 것은 맨 아래에 모인다',
      flipped.slice(-3).join(',') === 'a-rare,d-rare,c-rare', flipped.join(','));

    /* 탭은 같은 목록을 거르기만 한다 — 거른 뒤에도 순서가 유지되어야 한다. */
    const all = A.achievementsFor(null);
    const tabbed = all.filter(v => v.gameType === 'ALL').map(v => v.id);
    ck('탭으로 걸러도 순서가 유지된다', tabbed.join(',') === all.map(v => v.id).join(','),
      tabbed.join(','));
  }

  console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
