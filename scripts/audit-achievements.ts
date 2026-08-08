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

function wipe(): void {
  db.exec(`DELETE FROM achievements; DELETE FROM user_achievements;
           DELETE FROM notifications; DELETE FROM notification_reads;`);
}
function mkUser(id: string, bal = 10_000): void {
  Q.upsertUser(id, id, null);
  const cur = Q.getWebUser(id)?.balance ?? 0;
  if (cur !== bal) Q.adjustBalance(id, bal - cur, 'audit:seed');
}

function main(): void {
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
    /* 화면에서 가리는 것으로는 안 된다 — 응답에 들어 있으면 개발자 도구로 그대로 읽힌다.
       그러면 감춰진 것이 아니다. 그래서 db 계층에서 지운다. */
    ck('달성 전에는 제목이 ???', before.title === '???', before.title);
    ck('달성 전에는 원래 제목이 응답에 없다', !JSON.stringify(before).includes('김재원'));
    ck('달성 전에는 원래 설명도 없다', !JSON.stringify(before).includes('1.01'));
    ck('감춤 안내 문구가 나온다', before.description.includes('해금됩니다'), before.description);

    A.unlockAchievement('a2', 'sec-1');
    const after = A.achievementsFor('a2')[0];
    ck('달성하면 원래 제목으로 바뀐다', after.title === '김재원의 행보', after.title);
    ck('달성하면 원래 설명으로 바뀐다', after.description.includes('1.01'), after.description);

    // 남의 화면에서는 여전히 감춰져 있어야 한다
    mkUser('a2b');
    ck('남에게는 여전히 ???', A.achievementsFor('a2b')[0].title === '???');
    ck('로그인 안 한 화면에서도 ???', A.achievementsFor(null)[0].title === '???');
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

    /* 감춘 과제는 인원도 숨긴다. "3명 달성"이 붙어 있으면 그것만으로 가능한 조건이라는
       사실이 새어 나가고, 0명이면 아무도 못 했다는 것까지 알려 준다. */
    A.unlockAchievement('w1', 'hid-1');
    const seenByOther = A.achievementsFor('w3').find(v => v.id === 'hid-1')!;
    ck('감춘 과제는 남에게 인원을 안 알려준다', seenByOther.unlockedBy === -1,
      String(seenByOther.unlockedBy));
    ck('로그인 안 한 화면에서도 안 알려준다',
      A.achievementsFor(null).find(v => v.id === 'hid-1')!.unlockedBy === -1);
    /* 본인이 달성했으면 이미 내용을 아는 사람이다 — 그때는 보여 준다. */
    const seenByOwner = A.achievementsFor('w1').find(v => v.id === 'hid-1')!;
    ck('달성한 본인에게는 인원이 보인다', seenByOwner.unlockedBy === 1, String(seenByOwner.unlockedBy));
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

  console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main();
