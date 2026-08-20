/* 채팅 감사 — 실제로 보내고 받아 본다.
 *
 * 이 기능은 돈을 만지지 않는다. 그래서 여기서 가장 먼저 못 박는 것이 그것이다:
 * 아무리 떠들어도 잔액과 원장이 1P 도 움직이지 않아야 한다.
 *
 * 그다음이 문지기다. 도배·길이·보이지 않는 글자·재갈은 화면에도 검사가 있지만 그건
 * 편의고, 마지막 문은 서버다 — 개발자 도구로 곧장 POST 하는 경로가 언제나 열려 있다.
 *
 * 안전: DB_PATH 를 임시 디렉터리로 못 박는다. 운영(/data)이나 로컬 개발 DB 는 열지 않고
 * 웹 서버도 띄우지 않는다 — 규칙은 db 계층에 있고 그 함수를 직접 부른다.
 */
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
void readdirSync; void join;

for (const d of readdirSync(tmpdir())) {
  if (d.startsWith('casino-chat')) rmSync(join(tmpdir(), d), { recursive: true, force: true });
}
process.env.DB_PATH = mkdtempSync(join(tmpdir(), 'casino-chat-'));

const { getDb } = require('../src/db/schema') as typeof import('../src/db/schema');
const Q = require('../src/db/queries') as typeof import('../src/db/queries');
const C = require('../src/db/queries/chat') as typeof import('../src/db/queries/chat');
const db = getDb();

let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/* 도배 문지기를 피해 보낸다 — 이 감사가 보려는 것이 그 문지기 자체일 때만 연타한다. */
const say = async (u: string, b: string, w: string | null = null) => {
  await sleep(C.CHAT_MIN_GAP_MS + 60);
  return C.postChat(u, b, w);
};

for (const u of ['c1', 'c2', 'c3']) {
  Q.upsertUser(u, u, null);
  const bal = Q.getWebUser(u)?.balance ?? 0;
  if (bal < 10_000) Q.adjustBalance(u, 10_000 - bal, 'audit:seed');
}
function ledgerSnap(): string {
  return ['c1', 'c2', 'c3'].map(u => {
    const bal = Q.getWebUser(u)?.balance ?? 0;
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM points_ledger WHERE user_id = ?`)
      .get(u) as { n: number }).n;
    return `${u}:${bal}/${n}`;
  }).join('|');
}

async function main(): Promise<void> {
  console.log('[1] 기본 — 보내고 받는다');
  {
    const r = C.postChat('c1', '안녕하세요', 'holdem');
    ck('보내진다', r.ok === true, JSON.stringify(r));
    const rows = C.chatSince(0);
    ck('받아진다', rows.length === 1 && rows[0].body === '안녕하세요', JSON.stringify(rows));
    ck('이름과 자리가 함께 남는다',
      rows[0].username === 'c1' && rows[0].where_at === 'holdem');
    ck('chatMax 가 마지막 id 다', C.chatMax() === rows[0].id);
    /* since 를 주면 그 뒤만 온다 — 같은 대화를 매번 다시 내려보내면 상태 응답에 얹은
       숫자 하나로 아낀 것이 무의미해진다. */
    ck('since 뒤로는 새 줄만 온다', C.chatSince(rows[0].id).length === 0);
    const r2 = await say('c2', '반가워요');
    ck('그 뒤에 온 줄만 받는다',
      r2.ok && C.chatSince(rows[0].id).map(x => x.body).join() === '반가워요');
  }

  console.log('\n[2] 문지기 — 길이 · 빈 줄 · 보이지 않는 글자');
  {
    ck('빈 줄은 거절한다', (await say('c1', '   ')).ok === false);
    const long = 'ㄱ'.repeat(C.CHAT_MAX_LEN + 1);
    const r = await say('c1', long);
    ck(`${C.CHAT_MAX_LEN}자를 넘기면 거절한다`, !r.ok && r.error === 'too_long', JSON.stringify(r));
    ck('딱 맞는 길이는 통과한다', (await say('c1', 'ㄱ'.repeat(C.CHAT_MAX_LEN))).ok === true);
    /* 길이는 코드 포인트로 센다. UTF-16 으로 세면 이모지 하나가 둘로 잡혀
       사람이 보는 100자와 달라진다. */
    ck('이모지 100개는 통과한다 (코드 포인트로 센다)',
      (await say('c1', '\u{1F3B0}'.repeat(C.CHAT_MAX_LEN))).ok === true);
    ck('이모지 101개는 거절한다',
      (await say('c1', '\u{1F3B0}'.repeat(C.CHAT_MAX_LEN + 1))).ok === false);

    /* 눈에 안 보이는 글자로만 이루어진 줄은 빈 줄이다 — 폭 없는 공백을 늘어놓아
       빈 줄을 도배하는 것이 가장 먼저 오는 장난이다. */
    const invisible = '\u0000\u200b\u200e \ufeff \t';
    const inv = await say('c1', invisible);
    ck('보이지 않는 글자만 있으면 빈 줄로 본다', inv.ok === false, JSON.stringify(inv));
    /* 섞여 들어온 것은 걷어내고 남은 말을 살린다 — 통째로 거절하면 붙여넣기한 사람이
       왜 안 되는지 알 수 없다. */
    await say('c1', 'a\u200bb\nc');
    const last = C.chatSince(0).slice(-1)[0];
    ck('섞여 있으면 걷어내고 남긴다', last.body === 'a b c', JSON.stringify(last.body));
  }

  console.log('\n[3] 도배 — 연타와 몰아치기를 각각 막는다');
  {
    db.prepare(`DELETE FROM chat_messages`).run();
    await sleep(C.CHAT_MIN_GAP_MS + 60);
    ck('첫 줄은 통과한다', C.postChat('c3', '하나', null).ok === true);
    const fast = C.postChat('c3', '둘', null);
    ck('곧바로 또 보내면 막힌다', !fast.ok && fast.error === 'too_fast', JSON.stringify(fast));
    ck('남은 시간을 알려 준다 (화면이 버튼을 잠그는 데 쓴다)',
      !fast.ok && typeof fast.leftMs === 'number' && fast.leftMs! > 0);

    /* 창을 넓혀 놓고 간격을 그대로 두면 창이 다 차기 전에 시간이 먼저 간다.
       두 값이 함께 성립하는지 — 허용한 만큼이 실제로 들어가는지 — 를 본다. */
    ck('허용한 줄 수가 창 안에 실제로 들어간다',
      (C.CHAT_BURST - 1) * C.CHAT_MIN_GAP_MS < C.CHAT_BURST_MS,
      `${C.CHAT_BURST}줄 × ${C.CHAT_MIN_GAP_MS}ms 간격 > ${C.CHAT_BURST_MS}ms 창`);

    /* 간격만 지키면서 몰아치는 경우 — 두 번째 문(창)이 잡는다.
       숫자를 박아 두지 않고 상수에서 끌어온다. 값을 조정할 때 감사가 같이 안 따라오면
       "통과했다"가 아무 뜻도 없어진다. */
    let ok = 1;
    for (let i = 2; i <= C.CHAT_BURST; i++) {
      await sleep(C.CHAT_MIN_GAP_MS + 40);
      if (C.postChat('c3', '줄 ' + i, null).ok) ok++;
    }
    ck(`${C.CHAT_BURST_MS / 1000}초 안에 ${C.CHAT_BURST}줄까지는 통과한다`,
      ok === C.CHAT_BURST, `${ok}/${C.CHAT_BURST}`);
    await sleep(C.CHAT_MIN_GAP_MS + 40);
    const burst = C.postChat('c3', '한 줄 더', null);
    ck(`${C.CHAT_BURST}줄을 넘기면 막힌다`,
      !burst.ok && burst.error === 'too_fast', JSON.stringify(burst));
    /* 남의 도배가 내 입을 막으면 안 된다 — 문지기는 사람별이다. */
    ck('문지기는 사람별이다', C.postChat('c1', '나는 말할 수 있다', null).ok === true);
    /* 창이 지나면 다시 열린다 — 한 번 걸렸다고 오래 잠기면 그게 진짜 재갈이다. */
    await sleep(C.CHAT_BURST_MS + 120);
    ck('창이 지나면 다시 말할 수 있다', C.postChat('c3', '다시', null).ok === true);
  }

  console.log('\n[4] 재갈 — 운영자가 물리고 푼다');
  {
    C.setChatMute('c2', 600);
    ck('재갈이 물린다', C.chatMuteLeft('c2') > 590);
    const r = await say('c2', '말해도 되나');
    ck('물린 동안에는 못 보낸다', !r.ok && r.error === 'muted', JSON.stringify(r));
    ck('남은 시간을 알려 준다', !r.ok && (r.leftMs ?? 0) > 500_000);
    ck('남은 사람은 영향이 없다', (await say('c1', '나는 괜찮다')).ok === true);
    C.setChatMute('c2', 0);
    ck('풀린다', C.chatMuteLeft('c2') === 0);
    ck('풀리면 다시 말할 수 있다', (await say('c2', '이제 된다')).ok === true);
  }

  console.log('\n[4-b] 재갈을 물리고 푼 것을 방이 함께 본다');
  {
    db.prepare(`DELETE FROM chat_messages`).run();
    C.setChatMute('c2', 600);
    const afterMute = C.chatSince(0);
    const muteLine = afterMute.find(r => r.kind === 'mute');
    /* 당사자만 겪으면 고장으로 읽힌다("왜 안 써지지?"). 방 전체가 봐야 조치가 된다. */
    ck('물리면 방에 줄이 남는다', !!muteLine, JSON.stringify(afterMute.map(r => r.body)));
    ck('누구인지와 얼마인지를 적는다',
      muteLine?.body === 'c2 입에 재갈을 물렸습니다. 10분 동안 채팅을 못합니다.', muteLine?.body);
    ck('사람이 한 말과 구분된다', muteLine?.user_id === '@system' && muteLine?.kind === 'mute');
    /* 시간 표기는 사람이 읽는 단위로. 초·분·시간이 섞이면 "600초 동안"이 나온다. */
    ck('45초', C.muteDurText(45) === '45초', C.muteDurText(45));
    ck('10분', C.muteDurText(600) === '10분', C.muteDurText(600));
    ck('1시간', C.muteDurText(3600) === '1시간', C.muteDurText(3600));
    ck('1시간 30분', C.muteDurText(5400) === '1시간 30분', C.muteDurText(5400));

    // 손으로 풀면 그것도 알린다
    C.setChatMute('c2', 0);
    const un = C.chatSince(0).find(r => r.kind === 'unmute');
    ck('풀면 방에 줄이 남는다', !!un);
    ck('풀림 문구', un?.body === 'c2 입에 물린 재갈이 풀렸습니다.', un?.body);
    /* 안 물린 사람을 푸는 것은 아무 일도 아니다 — 운영자가 버튼을 눌러 볼 때마다
       방에 줄이 쌓이면 그게 도배다. */
    const n0 = C.chatSince(0).length;
    C.setChatMute('c2', 0);
    ck('안 물린 사람을 풀면 아무 줄도 안 남는다', C.chatSince(0).length === n0);

    /* 시간이 지나 저절로 풀리는 경우. 서버에 타이머가 없으므로 다음 요청에서 처리한다 —
       그 자리가 chatTick 이다(상태 응답이 매초 부른다). */
    db.prepare(`DELETE FROM chat_messages`).run();
    db.prepare(`UPDATE users SET chat_muted_until = ? WHERE id = 'c3'`)
      .run(Math.floor(Date.now() / 1000) - 5);          // 5초 전에 이미 끝났다
    ck('아직 아무도 안 알렸다', C.chatSince(0).length === 0);
    const tick = C.chatTick();
    const auto = C.chatSince(0).find(r => r.kind === 'unmute');
    ck('다음 요청에서 저절로 풀린 것을 알린다', !!auto, auto?.body);
    ck('그 사람 이름으로 적는다', auto?.body === 'c3 입에 물린 재갈이 풀렸습니다.', auto?.body);
    ck('틱이 숫자 둘을 함께 준다',
      typeof tick.chatMax === 'number' && typeof tick.chatMod === 'number');
    /* 두 번 적으면 방이 같은 말로 도배된다 — 알린 뒤 값을 비워서 한 번만 적는다. */
    const n1 = C.chatSince(0).length;
    C.chatTick(); C.chatTick();
    ck('두 번 알리지 않는다', C.chatSince(0).length === n1, `${n1} → ${C.chatSince(0).length}`);

    /* 시스템 줄은 문지기를 지나지 않는다 — 서버가 스스로 적는 줄이라 막을 대상이 없다.
       다만 사람의 도배 판정에 섞여서도 안 된다(남의 재갈 때문에 내가 막히면 안 된다). */
    db.prepare(`DELETE FROM chat_messages`).run();
    for (let i = 0; i < C.CHAT_BURST + 3; i++) C.setChatMute('c2', i % 2 === 0 ? 60 : 0);
    ck('시스템 줄은 도배 문지기를 안 탄다', C.chatSince(0).length > C.CHAT_BURST,
      String(C.chatSince(0).length));
    await sleep(C.CHAT_MIN_GAP_MS + 60);
    ck('그 뒤에도 사람은 말할 수 있다', C.postChat('c1', '나는 말할 수 있다', null).ok === true);
    /* 보관 상한은 함께 지킨다 — 시스템 줄만 예외면 표가 상한 없이 자란다. */
    for (let i = 0; i < 60; i++) C.setChatMute('c2', i % 2 === 0 ? 60 : 0);
    const cnt = (db.prepare(`SELECT COUNT(*) AS n FROM chat_messages`).get() as { n: number }).n;
    ck('시스템 줄도 보관 상한을 지킨다', cnt <= C.CHAT_KEEP, String(cnt));
    C.setChatMute('c2', 0);
  }

  console.log('\n[5] 숨김 — 지우지 않고 가린다');
  {
    const rows = C.chatSince(0);
    const target = rows[rows.length - 1];
    C.setChatHidden(target.id, true);
    ck('감춘 줄은 안 내려간다', !C.chatSince(0).some(r => r.id === target.id));
    /* 실제로 지우면 id 가 끊긴다. 화면은 "내가 가진 것보다 큰 id"만 받아 가므로
       그 자리를 영영 다시 요청하지 않는다 — 그래서 행은 남겨 둔다. */
    const still = db.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE id = ?`)
      .get(target.id) as { n: number };
    ck('행은 남아 있다 (id 가 끊기면 안 된다)', still.n === 1);
    ck('운영자 목록에는 보인다',
      C.chatRecentAll(60).some(r => r.id === target.id && r.hidden === 1));
    C.setChatHidden(target.id, false);
    ck('되돌릴 수 있다', C.chatSince(0).some(r => r.id === target.id));

    /* ── 남의 화면에서도 사라져야 한다 ──────────────────────────────
       이게 없어서 실제로 새어 나갔다. 가려도 chatMax(마지막 id)는 그대로라 남의 화면은
       재요청조차 하지 않았고, 설령 받아도 오는 것은 "since 뒤의 새 줄"뿐이라 이미
       그려 둔 줄을 걷어낼 신호가 없었다 — 가린 사람에게만 사라지고 남들에겐 남았다.
       그래서 "가려진 줄 수"를 따로 실어 보내고, 값이 달라지면 화면이 목록을 다시 받는다. */
    const beforeMax = C.chatMax(), beforeMod = C.chatMod();
    C.setChatHidden(target.id, true);
    ck('가려도 마지막 id 는 안 바뀐다 (그래서 이 신호만으로는 못 알아챈다)',
      C.chatMax() === beforeMax, `${beforeMax} → ${C.chatMax()}`);
    ck('가리면 조치 수가 바뀐다', C.chatMod() !== beforeMod, `${beforeMod} → ${C.chatMod()}`);
    /* 되돌릴 때도 값이 움직여야 한다 — 되돌린 줄은 since 로는 영영 못 받으므로
       화면이 목록을 다시 받아야만 되살아난다. */
    const hidMod = C.chatMod();
    C.setChatHidden(target.id, false);
    ck('되돌려도 조치 수가 바뀐다', C.chatMod() !== hidMod, `${hidMod} → ${C.chatMod()}`);
  }

  console.log('\n[6] 보관 — 표가 무한히 자라지 않는다');
  {
    db.prepare(`DELETE FROM chat_messages`).run();
    /* 문지기를 피하려고 직접 넣는다 — 여기서 보려는 것은 보관 규칙이지 도배가 아니다. */
    const ins = db.prepare(`INSERT INTO chat_messages
      (user_id, username, body, where_at, created_ms) VALUES (?, ?, ?, NULL, ?)`);
    for (let i = 0; i < C.CHAT_KEEP + 50; i++) ins.run('c1', 'c1', 'line ' + i, Date.now());
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM chat_messages`).get() as { n: number }).n;
    await sleep(C.CHAT_MIN_GAP_MS + 60);
    C.postChat('c2', '마지막 한 줄', null);        // 넣을 때 지운다
    const after = (db.prepare(`SELECT COUNT(*) AS n FROM chat_messages`).get() as { n: number }).n;
    ck('넣을 때 오래된 줄을 치운다', before > C.CHAT_KEEP && after <= C.CHAT_KEEP + 1,
      `${before} → ${after}`);
    ck('한 번에 내려주는 줄에도 상한이 있다', C.chatSince(0).length <= C.CHAT_PAGE,
      String(C.chatSince(0).length));
    /* 최근 것을 준다 — 오래된 앞머리를 주면 화면이 방금 오간 대화를 못 본다. */
    const page = C.chatSince(0);
    ck('처음 열면 최근 줄을 준다', page[page.length - 1].body === '마지막 한 줄',
      page[page.length - 1].body);
    ck('오름차순으로 준다', page[0].id < page[page.length - 1].id);
  }

  console.log('\n[7] 돈이 움직이지 않는다 — 이 기능의 전제');
  {
    const before = ledgerSnap();
    for (let i = 0; i < 8; i++) await say('c1', '떠든다 ' + i);
    ck('여덟 줄을 떠들었다', C.chatMax() > 0);
    ck('잔액과 원장 줄 수가 그대로다', ledgerSnap() === before, `${before} → ${ledgerSnap()}`);
    const bad = db.prepare(
      `SELECT COUNT(*) AS n FROM points_ledger WHERE reason LIKE '%chat%'`).get() as { n: number };
    ck('원장에 채팅 줄이 없다', bad.n === 0, String(bad.n));
  }

  console.log('\n[8] 배선 — 폴링을 늘리지 않는다');
  {
    const r = (p: string) => readFileSync(p, 'utf8');
    /* 이 설계의 핵심이다. 채팅용 폴을 따로 달면 요청 수가 정확히 두 배가 된다 —
       상태 응답에 실린 숫자 하나만 보고, 값이 늘었을 때만 부른다. */
    const app = r('src/web/assets/app.js');
    ck('값이 늘었을 때만 받아 간다', /if \(typeof max !== 'number' \|\| max <= lastId\) return;/.test(app));
    ck('게임 화면용 폴이 따로 없다',
      !/setInterval\([^)]*pull/.test(app.slice(app.indexOf('── 채팅'))));
    /* 폴링이 없는 화면(로비·랭킹)에서는 열려 있을 때만 스스로 돈다. */
    /* 창 크기를 넉넉히 두지 않으면 toggle() 안이 조금만 길어져도 이 검사가 깨진다.
       보려는 것은 "열림 분기에서 켜고 닫힘 분기에서 끈다"이지 그 사이 줄 수가 아니다. */
    ck('열려 있을 때만 느린 폴을 돈다',
      /function startIdle\(\)/.test(app) && /stopIdle\(\)/.test(app)
      && /if \(open\) \{[\s\S]*?startIdle\(\);[\s\S]{0,80}?\} else \{/.test(app));
    ck('닫으면 멈춘다', /\} else \{\s*\r?\n\s*stopIdle\(\);/.test(app));

    // 여섯 게임이 모두 상태 응답에 숫자를 얹고, 폴링에서 넘겨준다
    const payloads: [string, string][] = [
      ['홀덤', 'src/web/games/holdem.ts'], ['바카라', 'src/web/games/baccarat.ts'],
      ['블랙잭', 'src/web/games/blackjack.ts'], ['그래프', 'src/web/games/crash.ts'],
      ['사다리', 'src/web/games/ladder.ts'], ['포커', 'src/web/games/poker.ts'],
    ];
    for (const [label, p] of payloads) {
      /* 두 숫자를 손으로 적지 않고 틱 하나를 펼친다 — 여섯 군데에 같은 두 필드를
         적어 두면 언젠가 갈라지고, 저절로 풀린 재갈을 정리하는 자리도 여기다. */
      ck(`${label} 응답이 채팅 틱을 부른다`, /\.\.\.chatTick\(\),/.test(r(p)));
    }
    const loops: [string, string][] = [
      ['홀덤', 'src/web/games/holdem-client/loop.ts'],
      ['바카라', 'src/web/games/baccarat-client/loop.ts'],
      ['블랙잭', 'src/web/games/blackjack-client/chips.ts'],
      ['그래프', 'src/web/games/crash.ts'],
      ['사다리', 'src/web/games/ladder.ts'],
      ['포커', 'src/web/games/poker-client/loop.ts'],
    ];
    for (const [label, p] of loops) {
      ck(`${label} 폴링이 채팅에 넘겨준다`, /casinoChat\.note\(d\.chatMax, d\.chatMod\)/.test(r(p)));
    }
    /* 지뢰찾기에는 폴링이 없다(혼자 하는 게임이다). 도크가 열려 있을 때만 스스로 돈다. */
    ck('지뢰찾기는 폴링이 없다', !/setInterval\(poll/.test(r('src/web/games/mines.ts')));
    ck('그래도 말한 자리는 남는다', /__CHAT_WHERE__ = 'mines'/.test(r('src/web/games/mines.ts')));

    // 로그인한 사람에게만 붙는다 — id 는 공용 레이아웃이 심는다
    ck('id 를 공용 레이아웃이 심는다', /window\.__MEID__ = \$\{jsonForScript\(u\.id\)\}/.test(r('src/web/views.ts')));
    ck('로그인 안 하면 도크를 안 붙인다', /if \(!window\.__MEID__\) return;/.test(app));
    // 남의 글은 이스케이프해서 그린다 — 여기가 새면 남의 화면에서 스크립트가 돈다
    ck('본문을 이스케이프해서 그린다', /chat-b">' \+ esc\(m\.body\)/.test(app));
    ck('이름도 이스케이프한다', /esc\(m\.name\)/.test(app));
    // 서버가 자리 이름을 믿지 않는다
    ck('모르는 자리 이름은 버린다', /KNOWN\.includes\(whereRaw\) \? whereRaw : null/
      .test(r('src/web/chat.ts')));
  }

  console.log('\n[8-b] 순위 뱃지 — 상위 세 사람만 색을 갖는다');
  {
    const app = readFileSync('src/web/assets/app.js', 'utf8');
    const css = readFileSync('src/web/assets/css/14-chat.css', 'utf8');
    const srv = readFileSync('src/web/chat.ts', 'utf8');

    /* 순위는 랭킹 페이지의 통합 탭과 같은 것을 쓴다. 게임별 순위를 쓰면 그 게임을 한
       사람에게만 있어서 대부분의 줄에 붙일 것이 없다. */
    ck('통합 랭킹의 순위를 쓴다', /seasonOverall\(currentSeason\(\)\.id, 1000\)/.test(srv));
    ck('순위를 줄마다 실어 보낸다', /rank: rank\.get\(r\.user_id\)/.test(srv));
    /* 상한을 기본값(100)으로 두면 사람이 늘었을 때 101위부터 조용히 사라진다. */
    ck('상한 때문에 순위가 사라지지 않는다', !/seasonOverall\(currentSeason\(\)\.id\)/.test(srv));
    /* 순위를 못 구해도 대화는 흘러야 한다 — 시즌은 채팅의 전제가 아니다. */
    ck('시즌을 못 읽어도 대화는 흐른다', /catch \{ \/\* 시즌을 못 읽어도/.test(srv));
    ck('잔액은 내려보내지 않는다', !/balance/.test(srv));

    // 실제로 순위가 실려 나가는가 (서버를 세우지 않고 매핑만 확인한다)
    const ranks = require('../src/db/queries') as typeof import('../src/db/queries');
    const overall = ranks.seasonOverall(ranks.currentSeason().id, 1000);
    ck('통합 랭킹이 1위부터 매겨진다', overall.length === 0 || overall[0].rank === 1,
      JSON.stringify(overall.slice(0, 2)));

    ck('1~3위에만 메달이 붙는다',
      /var TOP = \{ 1: \['t1', '🥇'\], 2: \['t2', '🥈'\], 3: \['t3', '🥉'\] \}/.test(app));
    ck('4위 이하는 메달이 없다', /\(t \? '<i class="chat-md"[\s\S]{0,90}?: ''\)/.test(app));
    ck('줄 형식이 [메달][이름][게임] : 말 이다',
      /chat-md[\s\S]{0,140}?'<span class="chat-nm"[\s\S]{0,120}?\+ w \+ '<span class="chat-c">:<\\?\/span>/.test(app));
    /* 등수를 글자로 적었더니 좁은 창에서 한 말이 네 번째 조각으로 밀렸다. 메달만 남긴다. */
    ck('순위 뱃지를 달지 않는다', !/chat-rk/.test(app) && !/chat-rk/.test(css));
    /* 채팅 구획만 본다 — 👑 는 대회 우승 알림에도 쓰이고, 그건 여기와 상관이 없다.
       파일 전체를 훑으면 남의 코드 때문에 이 검사가 거짓으로 실패한다(실제로 그랬다). */
    const chatJs = app.slice(app.indexOf('/* ── 채팅 ─'));
    /* 주석은 걷어내고 본다 — 왜 뱃지를 뗐는지 적어 둔 설명에 👑 가 들어 있어서,
       설명을 남기면 검사가 실패하고 검사를 통과시키려면 설명을 지워야 하는 꼴이 된다. */
    const chatCode = chatJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    ck('등수를 글자로 찍지 않는다',
      !/rankHtml/.test(chatCode) && !/'#' \+ /.test(chatCode) && !/👑/.test(chatCode));
    /* 메달도 <i> 다 — font-style 을 안 정하면 이모지까지 기울어 그려진다. */
    ck('메달이 기울지 않는다', /\.chat-md\{font-style:normal/.test(css));
    /* 색을 한 단씩 눅였다(#fbbf24 → #fcd34d 등). 어두운 바탕에서 채도가 높은 원색은
       글자가 배경에서 떠 보이고, 세 색이 나란히 놓이면 서로 다툰다. 뜻은 그대로다 —
       금 · 하늘 · 코랄. */
    ck('1위 이름은 골드', /\.chat-row\.t1 \.chat-nm\{color:#fcd34d;font-weight:800\}/.test(css));
    ck('2위 이름은 스카이블루', /\.chat-row\.t2 \.chat-nm\{color:#7dd3fc;font-weight:800\}/.test(css));
    ck('3위 이름은 코랄 오렌지', /\.chat-row\.t3 \.chat-nm\{color:#fdba74;font-weight:800\}/.test(css));
    /* 예전에는 이름이 전부 금색이었다. 그러면 금색이 "이름"이라는 뜻밖에 못 갖는다. */
    ck('4위 이하 이름은 슬레이트 회색', /\.chat-nm\{font-weight:600;color:#94a3b8/.test(css));
    ck('이름이 더는 전부 금색이 아니다', !/\.chat-nm\{[^}]*var\(--gold-hi\)/.test(css));
    ck('본문은 눈이 편한 오프화이트', /\.chat-b\{color:#e2e8f0\}/.test(css));
    /* 특이도가 같아서 순서가 곧 결과다 — 순위 규칙이 .me 뒤에 와야 이긴다. */
    ck('순위 색이 "내 줄" 색을 이긴다',
      css.indexOf('.chat-row.t1 .chat-nm') > css.indexOf('.chat-row.me .chat-nm'));

    /* ── 줄 사이 구분 ────────────────────────────────────────────
       여러 줄로 접히는 말이 섞이면 어디서 한 사람의 말이 끝나는지 눈으로 안 끊긴다. */
    /* 좌우 padding 은 음수 마진이 되돌린다 — 손이 얹힌 바탕만 줄 끝까지 번지고
       글자는 제자리에 남는다. 그래서 마진의 좌우가 padding 의 좌우와 부호만 달라야 한다. */
    ck('줄마다 간격과 위아래 여백이 있다',
      /\.chat-row\{margin:0 -6px 8px;padding:4px 6px;/.test(css));
    ck('손이 얹히면 줄이 밝아진다',
      /\.chat-row:hover\{background:rgba\(255,255,255,\.025\)\}/.test(css));
    ck('아주 옅은 구분선이 있다',
      /border-bottom:1px solid rgba\(255,255,255,\.05\)/.test(css));
    ck('마지막 줄 아래에는 선이 없다',
      /\.chat-row:last-child\{border-bottom:none;margin-bottom:0\}/.test(css));
    ck('긴 말도 가로로 넘치지 않는다', /\.chat-row\{[^}]*word-break:break-word/.test(css));
    /* gap 과 margin 이 함께 있으면 실제 간격이 13px 이 되고, 고칠 곳이 두 군데가 된다. */
    ck('간격을 한 곳에서만 정한다', !/\.chat-list\{[^}]*gap:/.test(css));
  }

  console.log('\n[8-c] 말풍선 톤 — 채팅창과 한 벌로 읽힌다');
  {
    const css9 = readFileSync('src/web/assets/css/09-holdem.css', 'utf8');
    const src = readFileSync('src/web/games/holdem-client/seats.ts', 'utf8');
    const bub = /\.ht-bub\{[^}]*\}/.exec(css9)?.[0] ?? '';
    ck('배경은 채팅창과 같은 딥 차콜', /background:rgba\(22,25,32,\.95\)/.test(bub), bub.slice(0, 80));
    ck('테두리 #2e3440', /border:1px solid #2e3440/.test(bub));
    ck('그림자 규격', /box-shadow:0 4px 16px rgba\(0,0,0,\.7\)/.test(bub));
    ck('글자 규격', /font-size:12px;line-height:1\.34;font-weight:500;color:#f8fafc/.test(bub));
    ck('금색 상자가 아니다', !/#f3cd63|#ffeeb4/.test(css9.slice(css9.indexOf('.ht-bub{'))));
    /* 기울이거나 돌리지 않는다 — 펠트 위에서 기운 글자는 읽는 속도만 늦춘다. */
    ck('기울임·회전이 없다', !/\.ht-bub[^{]*\{[^}]*(skew|rotate)/.test(css9));
    // 꼬리도 같은 색이라야 한 덩어리로 보인다
    ck('꼬리 채우기가 몸통과 같은 색', /\.ht-bub::after\{bottom:-6px;border-top:7px solid #161920\}/.test(css9));
    ck('꼬리 테두리도 같은 색', /\.ht-bub::before\{bottom:-8px;border-top:8px solid #2e3440\}/.test(css9));
    // 1위만 금테
    ck('1위는 금색 테두리', /\.ht-bub\.k1\{border-color:#f59e0b\}/.test(css9));
    ck('1위는 꼬리도 금색', /\.ht-bub\.k1::before\{border-top-color:#f59e0b\}/.test(css9)
      && /\.ht-bub\.d\.k1::before\{border-bottom-color:#f59e0b\}/.test(css9));
    ck('순위가 말풍선까지 전해진다', /bubbleSay\(m\.userId, m\.body, m\.rank\)/.test(src));
    ck('1위 표시를 매 프레임 맞춘다', /bub\.classList\.toggle\('k1', !!b\.top\)/.test(src));
    ck('감출 때 금테도 걷는다', /classList\.remove\('in', 'out', 'k1'\)/.test(src));

    /* ── 폴드·탈락한 자리의 말은 그대로 읽혀야 한다 ────────────────
       좌석에 opacity 를 걸면 그 안의 말풍선까지 옅어지고, 자식은 부모의 불투명을
       이길 수 없다. 흐릴 것들만 한 겹 안에 넣고 말풍선은 그 밖에 둔다. */
    ck('흐림 겹이 있다', /\.ht-seat-in\{position:absolute;inset:0\}/.test(css9));
    ck('폴드 흐림이 좌석이 아니라 그 겹에 걸린다',
      /\.ht-seat\.folded \.ht-seat-in\{opacity:\.62/.test(css9)
      && !/\.ht-seat\.folded\{opacity/.test(css9));
    ck('탈락 흐림도 그 겹에 걸린다',
      /\.ht-seat\.koed \.ht-seat-in\{opacity:\.72\}/.test(css9)
      && !/\.ht-seat\.koed\{opacity/.test(css9));
    /* 골격에서 말풍선이 그 겹 밖에 있어야 의미가 있다 — 안에 있으면 위 규칙이 무의미하다. */
    const seatHtml = /'<div class="ht-seat" data-seat[\s\S]*?'<\/div>';/.exec(src)?.[0] ?? '';
    ck('말풍선이 흐림 겹 밖에 있다',
      seatHtml.indexOf("'</div>' +") > 0
      && seatHtml.indexOf("'</div>' +") < seatHtml.indexOf('ht-bub ')
      && seatHtml.indexOf('ht-seat-in') < seatHtml.indexOf('ht-eq '), seatHtml.slice(0, 60));
  }

  console.log('\n[9] 접기 · 우측 패널 폭 맞춤 (도크 UI)');
  {
    const app = readFileSync('src/web/assets/app.js', 'utf8');
    const css = readFileSync('src/web/assets/css/14-chat.css', 'utf8');
    /* × 가 아니라 − 다. 누른다고 사라지는 것이 없으므로 "닫기"로 그리면 안 된다. */
    ck('머리에 최소화 버튼이 있다', /class="chat-min" title="최소화"/.test(app));
    ck('최소화하면 알약만 남는다', /\.chat-min'\)\.addEventListener\('click', function\(\)\{ toggle\(false\); \}\)/.test(app));
    ck('알약을 다시 누르면 펼쳐진다', /\.chat-tab'\)\.addEventListener\('click', function\(\)\{ toggle\(\); \}\)/.test(app));
    ck('입력 중 Esc 로도 접힌다', /e\.key === 'Escape'[\s\S]{0,60}?toggle\(false\)/.test(app));
    ck('바에 말풍선 그림이 붙는다', /class="chat-ico"/.test(app) && /\.chat-ico\{/.test(css));
    /* ── 접힌 상태가 대화를 실어 나른다 ────────────────────────────
       "채팅"이라고만 적힌 알약은 열어 보기 전까지 방이 살아 있는지 못 알려 준다. */
    ck('접힌 바에 마지막 줄을 그린다', /function paintLast\(m, fresh\)\{/.test(app));
    ck('언제나 최신 줄을 띄운다',
      /if \(d\.messages\.length\) paintLast\(d\.messages\[d\.messages\.length - 1\], primed\);/.test(app));
    /* 처음 받아 온 지난 대화까지 움직이면 "방금 누가 말했다"는 신호가 값싸진다. */
    ck('새 줄일 때만 움직인다', /if \(!fresh\) return;\s*\r?\n\s*lastEl\.classList\.remove\('up'\);/.test(app));
    ck('넘치는 말은 자른다', /\.chat-last \.chat-b\{min-width:0;overflow:hidden;text-overflow:ellipsis\}/.test(css));
    ck('바가 사이드바 폭을 따라간다', /\.chat-dock\.sync \.chat-tab\{width:var\(--chat-w\)\}/.test(css));
    /* 같은 사람이 바와 목록에서 다른 색이면 안 된다.
       예전에는 여기서 색 값을 직접 못 박았다. 그러면 검사 이름은 "둘이 같다"고 말하면서
       실제로는 "옛날 그 색이다"를 재게 되어, 두 곳을 «같이» 옮겨도 실패한다(그렇게
       실패했다). 이름이 말하는 것을 재려면 둘을 꺼내서 견줘야 한다. */
    const hueOf = (scope: string) => [1, 2, 3].map(n => {
      const m = new RegExp(`\\.${scope}\\.t${n} \\.chat-nm\\{color:(#[0-9a-f]{3,8})`, 'i').exec(css);
      return m ? m[1].toLowerCase() : `없음(t${n})`;
    });
    const barHue = hueOf('chat-last'), listHue = hueOf('chat-row');
    ck('바의 이름 색이 목록과 같다',
      barHue.join() === listHue.join() && !barHue.some(h => h.startsWith('없음')),
      `${barHue.join(' ')} vs ${listHue.join(' ')}`);
    ck('바가 본체와 같은 딥 차콜이다', /\.chat-tab\{[^}]*background:rgba\(22,25,32,\.95\)/.test(css));
    ck('"채팅"이라고만 적던 알약이 아니다', !/chat-tab-t/.test(app) && !/chat-tab-t/.test(css));
    /* 접혀 있을 때만 깜빡인다 — 펼쳐 놓고 보는 중에 깜빡이면 그냥 시끄러운 것이다. */
    ck('안 읽은 배지가 깜빡인다', /badgeEl\.classList\.toggle\('blink', !open && unread > 0\)/.test(app)
      && /\.chat-badge\.blink\{animation:chatBlink/.test(css));
    ck('깜빡임은 움직임 줄이기를 따른다',
      /prefers-reduced-motion:reduce\)\{\.chat-badge\.blink\{animation:none\}\}/.test(css));
    ck('펼쳐지면 알약을 치운다', /\.chat-dock\.on \.chat-tab\{display:none\}/.test(css));
    /* display 를 직접 정해 둔 요소라 hidden 속성만으로는 안 사라진다. 이게 빠져 있어서
       최소화가 아무 일도 안 했고 "0" 배지가 늘 붙어 있었다(실측). */
    ck('본체와 배지가 정말 감춰진다',
      /\.chat-panel\[hidden\]\{display:none\}/.test(css)
      && /\.chat-badge\[hidden\]\{display:none\}/.test(css));
    /* 화면을 옮기면 lastId 가 0 부터 다시 시작한다 — 본 지점을 따로 기억하지 않으면
       최근 40줄이 매번 안 읽음으로 잡혀 배지 숫자가 아무 뜻도 없어진다. */
    ck('본 지점을 기억한다', /store\('od_chat_seen', String\(lastSeen\)\)/.test(app));
    ck('본 줄은 안 읽음으로 세지 않는다',
      /if \(!open && m\.id > lastSeen && m\.userId !== window\.__MEID__\) unread\+\+;/.test(app));
    ck('펼쳐 놓은 동안 들어온 줄도 본 것으로 친다', /if \(open\) markSeen\(\);/.test(app));
    /* 펼치면 지나간 기록이 아니라 지금 오가는 대화가 먼저 보여야 한다. 접혀 있는 동안
       목록은 display:none 이라 높이가 0 이고, "아래에 붙어 있었나" 판정도 무의미하다. */
    ck('펼치면 무조건 맨 아래로 간다',
      /jumpBottom = true;\s*\r?\n\s*toBottom\(\);/.test(app)
      && /if \(jumpBottom \|\| \(added && atBottom\)\) toBottom\(\);/.test(app));
    ck('그 밖에는 읽던 자리를 지킨다', /jumpBottom = false;/.test(app));

    /* 화면 쪽 제한값이 서버와 어긋나면, 눌리는데 거절당하거나 보낼 수 있는데 안 눌린다. */
    const gapC = /var MIN_GAP_MS = (\d+);/.exec(app);
    const lenC = /var MAX_LEN = (\d+);/.exec(app);
    ck('화면의 연타 간격이 서버와 같다',
      !!gapC && Number(gapC[1]) === C.CHAT_MIN_GAP_MS,
      `${gapC?.[1]} vs ${C.CHAT_MIN_GAP_MS}`);
    ck('화면의 길이 제한이 서버와 같다',
      !!lenC && Number(lenC[1]) === C.CHAT_MAX_LEN, `${lenC?.[1]} vs ${C.CHAT_MAX_LEN}`);
    ck('보내기 잠금이 그 값을 쓴다', /sendLockUntil = Date\.now\(\) \+ MIN_GAP_MS;/.test(app));

    /* 폭 맞춤 — 이 기능의 목적은 "왼쪽 베팅 화면을 침범하지 않는다" 하나다. */
    ck('우측 패널을 실측한다', /document\.querySelector\('\.game-side'\)/.test(app)
      && /getBoundingClientRect\(\)/.test(app));
    ck('스크롤바를 뺀 폭을 쓴다', /document\.documentElement\.clientWidth \|\| window\.innerWidth/.test(app));
    ck('패널이 아래로 내려가면 맞추지 않는다', /r\.width >= 200 && r\.width <= vw \* 0\.6/.test(app));
    /* 인라인 값은 미디어 쿼리를 이긴다. 맞출 수 없을 때 지우지 않으면 좁은 화면
       규칙이 영영 죽는다. */
    ck('못 맞추면 인라인 값을 지운다',
      /if \(!ok\) \{ dock\.style\.right = ''; dock\.style\.removeProperty\('--chat-w'\); \}/.test(app));
    ck('폭은 CSS 변수로 넘어간다', /\.chat-dock\.sync \.chat-panel\{width:var\(--chat-w\)\}/.test(css));
    ck('창 크기가 바뀌면 다시 맞춘다', /addEventListener\('resize', syncWidth\)/.test(app));
    /* 홀덤은 로비를 보다가 테이블이 열릴 때 비로소 패널에 크기가 생긴다.
       resize 만으로는 그 순간을 못 듣는다. */
    ck('패널에 크기가 생기는 순간도 듣는다', /new ResizeObserver\(syncWidth\)\.observe\(side\)/.test(app));
  }

  console.log('\n[9-2] 떠 있는 한 줄 채팅 — 켜고 끄기 · 끌어 옮기기');
  {
    const app = readFileSync('src/web/assets/app.js', 'utf8');
    const ig = readFileSync('src/web/assets/ingame.js', 'utf8');
    const c14 = readFileSync('src/web/assets/css/14-chat.css', 'utf8');
    const c15 = readFileSync('src/web/assets/css/15-mobile.css', 'utf8');
    const c18 = readFileSync('src/web/assets/css/18-ig-portrait.css', 'utf8');

    /* ── 스위치는 하나이고, 끄는 자리와 켜는 자리가 같아야 한다 ────────
       손잡이가 둘이면 "어느 쪽으로 껐는지"를 사람이 기억해야 한다. 그리고 되돌리는
       길이 화면에 없으면 그건 끄는 것이 아니라 잃는 것이다. */
    ck('줄에 붙어 있던 ×가 없다',
      !/chat-hide/.test(app) && !/chat-hide/.test(c14) && !/chat-hide/.test(c15));
    ck('끈 상태는 기기에 남는다', /var BAR_KEY = 'od_chat_bar';/.test(app)
      && /store\(BAR_KEY, on \? '1' : '0'\)/.test(app));
    ck('기본은 켜짐이다', /stored\(BAR_KEY, '1'\) !== '0'/.test(app));
    ck('상단바가 쓸 창구가 열려 있다',
      /barOn: barOn, toggleBar: function\(\)\{ return setBar\(!barOn\(\)\); \}/.test(app));
    /* 한때 이 단추는 화면에 따라 다른 일을 했다 — 가로에서는 줄이 통째로 감춰져
       있어서 켤 대상이 없었기 때문이다. 이제 가로에도 줄이 떠 있으므로 갈릴 이유가
       없어졌다. 같은 단추가 화면마다 다르게 동작하지 않는 것이 낫다. */
    ck('💬는 어느 방향에서나 줄을 켜고 끈다',
      /if \(C && C\.toggleBar\) C\.toggleBar\(\);/.test(ig)
      && !/IG\.port\(\)[\s\S]{0,60}?C\.open\(\)/.test(ig));
    const c16 = readFileSync('src/web/assets/css/16-ingame.css', 'utf8');
    ck('가로에도 줄이 떠 있다',
      /html\.ingame \.chat-dock:not\(\.on\) \.chat-bar\{display:flex/.test(c16));
    ck('가로에서도 끄기가 듣는다',
      /html\.ingame \.chat-dock\.bar-off:not\(\.on\)\{display:none\}/.test(c16));
    ck('가로에서도 끌 수 있다', /html\.ingame \.chat-dock:not\(\.on\) \.chat-bar\{[^}]*touch-action:none/.test(c16));

    /* ── 끄기가 듣는 화면은 켜는 자리가 함께 있는 화면뿐이다 ──────────
       줄을 걷어 놓고 되돌릴 단추가 그 화면에 없으면, 끈 것이 아니라 잃은 것이다.
       그래서 «켜는 단추가 있는 곳» 과 «.bar-off 를 읽는 곳» 이 정확히 같아야 한다.

       한때 이 검사를 "규칙이 딱 하나" 로 셌다. 그때는 실제로 하나였지만(세로 인게임),
       로비 머리에 단추가 생기면서 규칙도 둘이 되어 이름과 다른 것을 재게 됐다.
       개수가 아니라 «어느 범위에 있는가» 를 본다.

       단추가 있는 곳:  판 위 상단바(💬, 일곱 게임 세로·가로) · 폰 로비 머리(.chatbtn)
       단추가 없는 곳:  넓은 화면(01-base 가 .chatbtn 을 display:none 으로 둔다) */
    /* 주석에 이름이 남아 있는 것은 괜찮다 — 왜 여기서 안 읽는지가 거기 적혀 있다.
       금지하는 것은 그것이 «규칙» 으로 살아나는 것이다. */
    const c14Rule = c14.match(/^[^\r\n/*]*\.bar-off[^\r\n]*\{/gm) || [];
    ck('끄기 규칙이 넓은 화면에는 없다', c14Rule.length === 0,
      c14Rule.join(' | ') + ' — 14-chat.css 는 미디어 쿼리 밖이라 데스크톱까지 걸린다');
    ck('판 위에서 듣는다',
      /html\.ig-port\.ingame \.chat-dock\.bar-off:not\(\.on\)\{display:none\}/.test(c18));
    ck('폰 로비에서 듣는다', /\.chat-dock\.bar-off:not\(\.on\)\{display:none\}/.test(c15));
    /* 그리고 그 화면에 정말 단추가 있는가 — 규칙만 있고 단추가 없으면 갇힌다. */
    const views = readFileSync('src/web/views.ts', 'utf8');
    const c01 = readFileSync('src/web/assets/css/01-base.css', 'utf8');
    ck('폰 로비에 켜는 단추가 있다', /id="chatBtn"/.test(views)
      && /\.chatbtn\{display:none/.test(c01) && /\.chatbtn\{display:inline-flex\}/.test(c15));
    ck('그 단추가 스위치를 만진다',
      /closest\('#chatBtn'\)[\s\S]{0,160}?casinoChat\.toggleBar\(\)/.test(app));
    /* 판 안에서는 상단바가 제 것을 만든다 — 둘이 같이 나오면 같은 일을 하는 단추가
       한 화면에 두 개다. .profwrap 이 통째로 상단바로 옮겨 가므로 이것도 딸려 간다. */
    ck('판 안에서는 머리 단추를 접는다', /html\.ingame \.chatbtn\{display:none\}/.test(c15));
    /* 꺼짐을 아이콘에 표시한다 — 흐리게만 하면 "못 누른다"로 읽혀서, 하필 그것이
       다시 켜는 유일한 자리인데 눌러 볼 생각을 안 하게 된다. */
    /* 사선은 방향을 안 가리는 자리(01-base)에 있다. 한때 세로 전용 파일에 뒀는데,
       그때는 가로에서 이 단추가 스위치가 아니었기 때문이다 — 이제 두 방향 다
       스위치라 거기 두면 가로에서 눌러도 그림이 안 바뀐다(제보). */
    ck('꺼지면 💬에 사선이 그어진다',
      /html\.chat-off \.ig-chat::after\{content:''/.test(c01));
    ck('그 표시가 방향을 안 가린다', !/chat-off[^\r\n]*ig-chat/.test(c18));
    /* 색도 상태다. 그냥 .ig-chat 으로 쓰면 두 방향 다 다른 규칙에 진다 —
       세로는 html.ig-port .ig-bar .ig-help 묶음의 color:inherit (0,3,1) 에,
       가로는 .ig-btn{color:var(--muted)} 에. 실측으로 «세로 켜짐 밝은 흰색 ·
       가로 켜짐 회색 · 양쪽 다 꺼도 안 바뀜» 이 나왔다. 이길 만큼 명시한다. */
    ck('켜짐은 밝은 흰색, 꺼짐은 회색 (두 방향 같다)',
      /html \.ig-bar \.ig-chat\.ig-btn\{color:var\(--txt\)\}/.test(c01)
      && /html\.chat-off \.ig-bar \.ig-chat\.ig-btn\{color:var\(--muted\)\}/.test(c01));

    /* ── 자리를 떼어 주던 46px 은 짝이었다 ───────────────────────────
       15-mobile 의 body padding +46 과 18 의 main height -46 이 합쳐 정확히 100vh 다.
       한쪽만 지우면 세로 인게임 문서가 화면보다 46px 커진다. */
    /* 이름이 주석에 남아 있는 것은 괜찮다 — 왜 뺐는지가 거기 적혀 있다.
       금지하는 것은 그것이 다시 «규칙»과 «토글»로 살아나는 것이다. */
    const barOnRule = (c15 + c18).match(/^[^\r\n/*]*chat-bar-on[^\r\n]*\{/gm) || [];
    ck('46px 예약이 양쪽 다 없다',
      barOnRule.length === 0 && !/classList\.toggle\('chat-bar-on'/.test(app),
      barOnRule.join(' | '));

    /* ── 끌어 옮기기 ─────────────────────────────────────────────── */
    ck('옮기는 것은 도크가 아니라 바의 transform 이다',
      /transform:translate\(var\(--chat-dx,0px\), var\(--chat-dy,0px\)\)/.test(c18)
      && /barEl\.style\.setProperty\('--chat-dx'/.test(app));
    /* 도크는 left:0;right:0 라 left 를 주면 이동이 아니라 폭이 줄고, syncWidth() 가
       resize 마다 dock.style.right 를 다시 쓴다. 그 둘과 다투지 않으려는 것이다. */
    ck('도크의 앵커는 안 건드린다',
      !/dock\.style\.(left|top|bottom)\s*=/.test(app));
    ck('4px 안쪽은 끌기로 안 센다', /if \(moved <= 4\) return;/.test(app));
    /* 한 축만 재면 옆으로 휙 밀고 놓았을 때 moved 가 0 이라 클릭이 그대로 터진다. */
    ck('두 축을 다 센다', /moved = Math\.max\(moved, Math\.abs\(dx\), Math\.abs\(dy\)\);/.test(app));
    /* 누르는 순간에 잡으면 뒤이은 click 이 «잡은 요소»로 날아가 탭이 통째로 죽는다. */
    ck('끌기가 시작된 뒤에야 포인터를 잡는다',
      /if \(!captured\) \{[\s\S]{0,400}?setPointerCapture/.test(app));
    ck('잡는 대상이 바 자신이다 (채팅이 갈아엎는 노드가 아니다)',
      /barEl\.setPointerCapture\(e\.pointerId\)/.test(app));
    /* audit 이 .chat-tab 의 핸들러를 한 글자까지 못 박고 있으므로, 드래그 판정은
       그 안에 못 들어간다. 캡처 단계에서 삼켜야 한다. */
    /* 리스너를 통째로 본다. `}, true);` 만 찾으면 파일 안 다른 캡처 리스너가
       대신 걸려 통과해 버린다(실제로 그렇게 새어 나갔다). */
    ck('끌고 놓은 것은 클릭으로 안 센다',
      /barEl\.addEventListener\('click', function\(e\)\{\s*\r?\n\s*if \(moved > 4\) \{ e\.stopPropagation\(\); e\.preventDefault\(\); \}[\s\S]{0,80}?\}, true\);/.test(app));
    ck('펼친 창은 안 끈다', /if \(dock\.classList\.contains\('on'\)\) return;/.test(app));
    /* 브라우저가 먼저 스크롤로 판정하면 pointercancel 이 날아와 끌기가 끊긴다 —
       pointermove 안의 preventDefault() 로는 이미 늦다. 그래서 «끌 수 있는 화면» 에서는
       손가락을 스크롤에서 가져와야 하고, 그 두 곳은 폰 로비(15)와 판 위(18)다.
       한때 이 검사는 "18 에만 있고 15 에는 없어야 한다" 였다. 로비 줄이 못 박혀 있던
       시절의 이야기고, 지금은 로비에서도 끌 수 있으므로 둘 다 있어야 한다.
       넓은 화면(14-chat, 미디어 쿼리 밖)에는 없어야 한다 — 거기서는 끌지 않는다. */
    ck('끌 수 있는 화면에서 손가락을 스크롤에서 뺏는다',
      /touch-action:none/.test(c18) && /touch-action:none/.test(c15));
    ck('넓은 화면에서는 스크롤을 안 뺏는다', !/touch-action/.test(c14));
    /* 로비와 판이 같은 줄로 보여야 한다 — 폭도, 붙는 쪽도. */
    ck('로비 줄도 70% · 오른쪽', /\.chat-dock \.chat-bar\{width:70%/.test(c15)
      && /\.chat-dock\{[^}]*align-items:flex-end/.test(c15));
    /* 옮긴 자리는 화면을 옮겨도 그대로여야 한다 — 한 화면에서만 기억하면 기억한 것이 아니다. */
    ck('끌 수 있는 화면을 미디어 쿼리로 가른다',
      /max-width:768px\), \(max-width:1024px\) and \(max-height:560px\)'\)\.matches;\s*\r?\n\s*\} catch \(e\) \{ return false; \}/.test(app));
    /* 처음 한 번은 늦추지 않는다 — 늦추면 기본 자리가 한 번 보였다 사라진다(잔상). */
    ck('첫 자리는 곧바로 잡는다', /if \(!applyPos\(\)\) repos\(\);/.test(app));

    /* ── 옮긴 자리 ──────────────────────────────────────────────── */
    ck('자리는 비율로 저장한다', /store\(POS_KEY, fx\.toFixed\(4\) \+ ',' \+ fy\.toFixed\(4\)\)/.test(app));
    /* 저장값이 숫자가 아니면 var() 폴백이 안 먹고 선언이 통째로 죽어 도크가 사라진다. */
    ck('저장값을 숫자로 검사한다',
      /if \(!isFinite\(fx\) \|\| !isFinite\(fy\)\) return null;/.test(app));
    ck('복원값도 0~1 로 조인다', /clamp\(fx, 0, 1\), fy: clamp\(fy, 0, 1\)/.test(app));
    /* 네 방향 모두 조인다. 한때 위·왼쪽만 쟀는데, 그건 제자리가 화면 오른쪽 «아래» 일
       때만 맞는 이야기였다 — 가로는 제자리가 오른쪽 «위» 라 위가 이미 끝이어서 세로로
       한 픽셀도 안 움직였다(제보). */
    ck('화면 밖으로 못 나간다',
      /setXY\(clamp\(bx \+ dx, g\.dxMin, g\.dxMax\), clamp\(by \+ dy, g\.dyMin, g\.dyMax\)\)/.test(app));
    ck('네 방향을 다 잰다', /dxMax: Math\.max\(0, \(vw - PAD\) - r\.right\)/.test(app)
      && /dyMax: Math\.max\(0, \(vh - PAD\) - r\.bottom\)/.test(app));
    /* 안 보이는 동안 재면 사각형이 전부 0 이라 여유 높이가 0 이 되고, 그 값을 저장하면
       다음에도 이상한 자리에서 시작한다. */
    ck('안 보이는 동안 잰 값은 안 쓴다', /if \(r\.width < 20 \|\| r\.height < 10\) return null;/.test(app));
    /* transform 은 사각형에 반영된다 — 제자리를 재려면 먼저 0 으로 되돌려야 한다. */
    ck('제자리를 재기 전에 transform 을 0 으로 돌린다',
      /barEl\.style\.setProperty\('--chat-dx', '0px'\);[\s\S]{0,120}?getBoundingClientRect\(\)/.test(app));
    /* 검사 스크립트는 resize 만 던진다 — orientationchange 에만 걸면 검사를 통과하면서
       실기기에서 깨진다. */
    ck('회전은 resize 로 듣는다', /addEventListener\('resize', repos\)/.test(app)
      && !/orientationchange[^\r\n]*repos/.test(app));
    ck('늦춰서 다시 잰다', /setTimeout\(function\(\)\{ posTimer = null; applyPos\(\); \}, 180\)/.test(app));
    /* 판에 들어왔는지는 <html> 클래스가 말하는데, 그것을 ingame.js 가 언제 붙이는지
       app.js 는 모른다. 타이머를 여러 개 놓고 찍는 대신 바뀌는 것을 본다. */
    ck('인게임 클래스가 붙는 순간을 본다',
      /new MutationObserver\(repos\)\.observe\(document\.documentElement/.test(app));
    ck('판 밖에서는 옮긴 자리를 안 쓴다',
      /if \(!onBoard\(\)\) \{[\s\S]{0,200}?removeProperty\('--chat-dx'\)/.test(app));

    /* ── 폭 ─────────────────────────────────────────────────────── */
    ck('세로 인게임에서 폭이 70% 다',
      /html\.ig-port\.ingame \.chat-dock:not\(\.on\) \.chat-bar\{display:flex;width:70%/.test(c18));
    /* 도크는 flex-direction:column 이라 가로 정렬은 align-items 쪽이다.
       justify-content 를 건드리면 아무 일도 안 일어난다(가운데 그대로 남는다). */
    ck('오른쪽으로 붙는다 (align-items 로)', /align-items:flex-end;justify-content:center/.test(c18));
    ck('펼치면 끌 손잡이를 치운다', /\.chat-dock\.on \.chat-bar\{display:none\}/.test(c14));
  }

  console.log('\n[10] 홀덤 테이블 말풍선 — 실제로 실행해 본다');
  {
    /* 대상은 브라우저로 나가는 인라인 조각이다. "그 줄이 있는가"만 보면 수명·갱신처럼
       시간이 얽힌 규칙을 잡을 수 없으므로, 가짜 DOM 위에서 그대로 돌린다.
       조각 전체는 밖에서 빌려 쓰는 것이 너무 많아, 자기 완결적인 말풍선 구획만 잘라 쓴다
       — 이 구획이 밖에서 쓰는 것은 st · seatsEl · window 셋뿐이다. */
    const { SEATS } = require('../src/web/games/holdem-client/seats') as
      typeof import('../src/web/games/holdem-client/seats');
    const from = SEATS.indexOf('/* ── 테이블 채팅 말풍선 ─');
    const to = SEATS.indexOf('/* ── 쇼다운 승률 · 역전 카드 ─');
    ck('말풍선 구획을 찾았다', from > 0 && to > from, `${from} → ${to}`);

    type Cl = { has: Set<string> };
    const made: Record<string, unknown> = {};
    function bubEl() {
      const t = { textContent: '' };
      const cls = new Set<string>();
      return {
        hidden: true, offsetWidth: 1,
        attrs: {} as Record<string, string>,
        classList: {
          add(...n: string[]) { n.forEach(x => cls.add(x)); },
          remove(...n: string[]) { n.forEach(x => cls.delete(x)); },
          toggle(x: string, on: boolean) { if (on) cls.add(x); else cls.delete(x); },
          contains: (x: string) => cls.has(x),
        },
        cls,
        setAttribute(k: string, v: string) { this.attrs[k] = v; },
        getAttribute(k: string) { return this.attrs[k] ?? null; },
        removeAttribute(k: string) { delete this.attrs[k]; },
        querySelector: () => t,
        text: t,
      };
    }
    const seatEls: Record<number, { bub: ReturnType<typeof bubEl>; cls: Set<string> }> = {};
    function seatEl(n: number) {
      if (!seatEls[n]) {
        const c = new Set<string>();
        seatEls[n] = {
          bub: bubEl(),
          cls: c,
        };
      }
      const s = seatEls[n];
      return {
        classList: { add: (x: string) => s.cls.add(x), remove: (x: string) => s.cls.delete(x),
          contains: (x: string) => s.cls.has(x) },
        querySelector: () => s.bub,
      };
    }
    const subs: Array<(m: unknown) => void> = [];
    const FAKE = {
      seatsEl: {
        querySelector(sel: string) {
          const m = /data-seat="(\d+)"/.exec(sel);
          return m ? seatEl(Number(m[1])) : null;
        },
      },
      window: { casinoChat: { onMessage: (f: (m: unknown) => void) => subs.push(f) } },
      st: { table: { seats: [{ seat: 0, userId: 'u1' }, { seat: 1, userId: 'u2' }] } },
    };
    const api = new Function('FAKE', `
      var seatsEl = FAKE.seatsEl, window = FAKE.window, st = FAKE.st;
      /* 브라우저에서는 window.casinoChat 이 진짜 전역이라 이름만으로도 닿는다
         (loop.ts 도 같은 식으로 쓴다). 여기서는 window 가 지역 변수라 직접 세워 준다. */
      var casinoChat = FAKE.window.casinoChat;
      ${SEATS.slice(from, to)}
      return { say: bubbleSay, paint: paintBubbles, mem: function(){ return bubbles; },
        life: BUB_MS, fade: BUB_FADE };
    `)(FAKE);

    ck('채팅 구독을 건다', subs.length === 1);
    ck('4초 떠 있는다', api.life === 4000, String(api.life));

    // 홀덤 화면에서 한 말만 본다
    subs[0]({ where: 'baccarat', userId: 'u1', body: '다른 화면' });
    ck('다른 화면의 말은 안 띄운다', seatEls[0] === undefined || seatEls[0].bub.hidden);
    subs[0]({ where: 'holdem', userId: 'u1', body: '안녕하세요', rank: 1 });
    ck('홀덤에서 한 말은 띄운다', seatEls[0].bub.hidden === false);
    ck('1위 말풍선에 금테가 붙는다', seatEls[0].bub.cls.has('k1'));
    ck('내용이 들어간다', seatEls[0].bub.text.textContent === '안녕하세요');
    ck('등장 애니메이션이 붙는다', seatEls[0].bub.cls.has('in'));
    ck('좌석을 형제들 위로 올린다', seatEls[0].cls.has('bubon'));
    ck('아직 사라지는 중이 아니다', !seatEls[0].bub.cls.has('out'));

    /* 같은 사람이 연달아 말하면 새 말풍선을 하나 더 띄우지 않는다 — 내용을 갈고
       시계를 처음으로 되돌린다. 쌓아 올리면 두 줄이 겹쳐 둘 다 못 읽는다. */
    await sleep(2200);
    const t0 = api.mem()['u1'].until;
    subs[0]({ where: 'holdem', userId: 'u1', body: '아니 콜입니다' });
    ck('내용이 갈린다', seatEls[0].bub.text.textContent === '아니 콜입니다');
    ck('시계가 처음으로 돌아간다', api.mem()['u1'].until > t0 + 2000,
      `${t0} → ${api.mem()['u1'].until}`);
    ck('그 사람 몫은 여전히 하나다 (쌓이지 않는다)',
      Object.keys(api.mem()).length === 1, JSON.stringify(Object.keys(api.mem())));
    ck('등장 애니메이션이 다시 돈다', seatEls[0].bub.cls.has('in'));

    // 다른 사람은 자기 자리에 따로 뜬다
    subs[0]({ where: 'holdem', userId: 'u2', body: 'gg', rank: 5 });
    ck('다른 사람은 다른 자리에 뜬다',
      seatEls[1].bub.hidden === false && seatEls[1].bub.text.textContent === 'gg');
    ck('먼저 뜬 것이 밀려나지 않는다', seatEls[0].bub.hidden === false);
    ck('1위가 아니면 금테가 없다', !seatEls[1].bub.cls.has('k1'));
    /* 순위는 판마다 바뀐다. 1위였던 사람이 내려오면 금테도 같이 내려와야 한다. */
    subs[0]({ where: 'holdem', userId: 'u1', body: '내려왔다', rank: 4 });
    ck('순위가 내려가면 금테도 걷힌다', !seatEls[0].bub.cls.has('k1'));

    /* 앉지 않은 사람(관전자·다른 화면에 있는 사람)의 말은 붙을 자리가 없다.
       "앉은 사람만"이라는 규칙을 따로 쓰지 않아도 이렇게 걸러진다. */
    subs[0]({ where: 'holdem', userId: 'nobody', body: '관전자' });
    const shown = Object.keys(seatEls)
      .map(k => seatEls[Number(k)].bub)
      .filter(b => !b.hidden)
      .map(b => b.text.textContent);
    ck('앉지 않은 사람의 말은 어느 자리에도 안 뜬다',
      shown.indexOf('관전자') < 0 && shown.length === 2, JSON.stringify(shown));

    // 수명 — 4초에 사라지기 시작하고, 페이드가 끝나면 DOM 에서 걷힌다
    await sleep(api.life - 1800);
    api.paint();
    ck('4초 안에는 그대로 있다', !seatEls[0].bub.cls.has('out') && !seatEls[0].bub.hidden);
    await sleep(1900);
    api.paint();
    ck('4초가 지나면 사라지기 시작한다', seatEls[0].bub.cls.has('out'));
    ck('사라지는 중에도 아직 보인다', seatEls[0].bub.hidden === false);
    await sleep(api.fade + 120);
    api.paint();
    ck('페이드가 끝나면 감춘다', seatEls[0].bub.hidden === true);
    ck('올림 클래스도 걷는다', !seatEls[0].cls.has('bubon'));
    ck('애니메이션 클래스가 남지 않는다',
      !seatEls[0].bub.cls.has('in') && !seatEls[0].bub.cls.has('out'));
    ck('기억도 비운다 (영영 쌓이지 않는다)', Object.keys(api.mem()).length === 0,
      JSON.stringify(Object.keys(api.mem())));

    // 자리에 없는 사람의 기억이 남지 않는지 — 앉지 않은 사람 것도 시간이 지나면 지워진다
    subs[0]({ where: 'holdem', userId: 'ghost', body: '유령' });
    ck('앉지 않은 사람도 기억에는 들어간다', Object.keys(api.mem()).length === 1);
    await sleep(api.life + api.fade + 150);
    api.paint();
    ck('시간이 지나면 그 기억도 지운다', Object.keys(api.mem()).length === 0);

    /* 배치 규칙은 실행이 아니라 소스로 본다 — 좌표 계산은 CSS 와 좌석 골격에 흩어져 있다. */
    const src = readFileSync('src/web/games/holdem-client/seats.ts', 'utf8');
    const css9 = readFileSync('src/web/assets/css/09-holdem.css', 'utf8');
    ck('좌우는 승률 말풍선과 같은 규칙을 쓴다', /return eqSide\(p\) \+ \(p\.ny < -0\.2 \? ' d' : ''\)/.test(src));
    ck('좌석 골격이 bubSide 를 쓴다', /'<span class="ht-bub ' \+ bubSide\(p\)/.test(src));
    /* 위쪽 자리를 위로 달면 테이블 밖 게임 탭 줄을 덮는다 — 실측으로 확인하고 뒤집었다. */
    ck('위쪽 자리는 아래로 단다', /\.ht-bub\.d\{bottom:auto;top:74%\}/.test(css9));
    /* 좌석 상자는 72px 다. 폭을 정해 주지 않으면 남은 자리에 맞춰 34px 로 찌부러진다. */
    ck('폭이 내용에 맞춰 좌석 밖으로 뻗는다', /\.ht-bub\{[^}]*width:max-content/.test(css9));
    ck('세 줄에서 자르고 말줄임을 붙인다',
      /-webkit-line-clamp:3/.test(css9) && /text-overflow:ellipsis/.test(css9));
    /* 40vw 는 375px 화면에서 150px 인데, 가장 좁은 자리의 여유가 113px 이라 27px 이
       화면 왼쪽으로 삐져나갔다(실측). 28vw = 105px 이면 그 자리에도 들어간다. */
    ck('길어도 테이블을 덮지 않게 폭을 묶는다', /max-width:min\(154px,28vw\)/.test(css9));
    ck('클릭을 먹지 않는다', /\.ht-bub\{[^}]*pointer-events:none/.test(css9));
    ck('꼬리가 말한 사람을 가리킨다',
      /\.ht-bub\.l::before,\.ht-bub\.l::after\{right:13px\}/.test(css9)
      && /\.ht-bub\.d::after\{bottom:auto;top:-6px/.test(css9));
    /* 골격이 다시 만들어지면 말풍선도 지워진다 — 기억에서 되살려야 한다. */
    ck('좌석을 다시 그린 뒤 되살린다', /syncEquity\(tb\);[\s\S]{0,220}?paintBubbles\(\);/.test(src));
    /* 처음 받아 오는 40줄이 한꺼번에 터지면 안 된다. */
    ck('지난 대화는 말풍선으로 터지지 않는다',
      /if \(primed\) live\.push\(m\);/.test(readFileSync('src/web/assets/app.js', 'utf8'))
      && /Date\.now\(\) - \(m\.at \|\| 0\) > LIVE_MS/.test(readFileSync('src/web/assets/app.js', 'utf8')));
  }

  console.log('\n[11] 서버 부담 — 늘어난 것이 없어야 한다');
  {
    const r = (p: string) => readFileSync(p, 'utf8');
    const app = r('src/web/assets/app.js');

    /* ── 서버에 도는 타이머가 없다 ────────────────────────────────
       이 게임들은 지연 진행(lazy advancement)이다 — 판을 넘기는 것은 타이머가 아니라
       누군가의 요청이다. 그래서 "백그라운드 루프가 중복 실행되나"라는 질문 자체가
       성립하지 않는다. 다만 그 전제가 조용히 깨지면(누가 setInterval 을 하나 심으면)
       채팅이 아니라 게임 전체의 비용 구조가 달라지므로 여기서 지킨다. */
    const serverFiles: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, f.name);
        if (f.isDirectory()) { walk(p); continue; }
        if (!f.name.endsWith('.ts')) continue;
        serverFiles.push(p);
      }
    };
    walk(join('src', 'db'));
    walk(join('src', 'services'));
    serverFiles.push(join('src', 'web', 'chat.ts'), join('src', 'web', 'server.ts'));
    const timerHits: string[] = [];
    for (const f of serverFiles) {
      /* 주석은 걷어낸다 — 왜 타이머를 안 쓰는지 적어 둔 설명에 이름이 나온다. */
      const code = r(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      if (/\bsetInterval\s*\(/.test(code)) timerHits.push(f + ':setInterval');
    }
    ck('서버에 도는 타이머가 없다', timerHits.length === 0, timerHits.join(', '));
    ck('검사한 서버 파일이 있다', serverFiles.length > 10, `${serverFiles.length}개`);

    /* ── 채팅을 메모리에 들고 있지 않다 ───────────────────────────
       기록은 SQLite 에 있고, 넣을 때마다 200줄로 잘린다. 프로세스가 들고 있는 것은
       숫자 상수뿐이라 애초에 자랄 것이 없다 — 새는지 재기 전에 새는 곳이 없다. */
    const chatDb = r('src/db/queries/chat.ts');
    const topLevel = chatDb.split('\n').filter(l => /^(const|let|var)\s/.test(l));
    ck('채팅 모듈이 메모리에 쌓아 두는 것이 없다', topLevel.length === 0,
      topLevel.join(' / '));
    ck('넣을 때마다 오래된 줄을 지운다', /DELETE FROM chat_messages[\s\S]{0,200}?CHAT_KEEP/.test(chatDb));

    /* ── 화면 쪽 누수 ─────────────────────────────────────────────
       페이지 이동은 전부 문서를 새로 여는 SSR 이라 리스너는 문서와 함께 사라진다.
       한 페이지 안에서 자라는 것만 막으면 된다. */
    ck('도크를 두 번 만들지 않는다', /function build\(\)\{\s*\r?\n\s*if \(dock\) return;/.test(app));
    ck('느린 폴이 겹쳐 돌지 않는다', /function startIdle\(\)\{\s*\r?\n\s*if \(idleTimer\) return;/.test(app));
    ck('접으면 그 타이머를 끈다',
      /function stopIdle\(\)\{ if \(idleTimer\) \{ clearInterval\(idleTimer\); idleTimer = null; \} \}/.test(app));
    ck('요청이 겹쳐 나가지 않는다', /function pull\(\)\{\s*\r?\n\s*if \(pulling\) return;/.test(app));
    ck('그려 둔 줄에 상한이 있다', /while \(listEl\.childElementCount > MAX_ROWS\)/.test(app));
    /* 예전에는 DOM 만 잘라서 본 적 있는 id 가 끝없이 쌓였다. */
    ck('본 id 도 같이 걷는다', /delete seen\[gone\.dataset\.id\];/.test(app));
    /* 말풍선 타이머는 하나뿐이고, 다음 할 일이 있을 때만 다시 걸린다. */
    const seats = r('src/web/games/holdem-client/seats.ts');
    ck('말풍선 타이머가 겹치지 않는다',
      /function bubTick\(\)\{\s*\r?\n\s*clearTimeout\(bubTimer\);/.test(seats));
    ck('할 일이 없으면 타이머를 안 건다', /if \(next\) bubTimer = setTimeout\(bubTick,/.test(seats));

    /* ── 요청 수 ──────────────────────────────────────────────────
       채팅은 폴을 새로 만들지 않는다. 이 두 줄이 그 약속이다. */
    ck('값이 늘었을 때만 받아 간다',
      /if \(typeof max !== 'number' \|\| max <= lastId\) return;/.test(app));
    ck('상태 응답에 실리는 것은 숫자 둘이다',
      /\.\.\.chatTick\(\),/.test(r('src/web/games/holdem.ts'))
      && /chatMax: number; chatMod: number/.test(r('src/db/queries/chat.ts')));
    /* 저절로 풀린 재갈을 정리하는 자리. 서버에 타이머가 없으므로 상태 응답이 그 자리다 —
       이게 빠지면 시간이 지나도 아무도 안 알리고, 아무도 안 알리니 아무도 안 받아 간다. */
    ck('틱이 지난 재갈을 정리한다',
      /export function chatTick[\s\S]{0,200}?sweepExpiredMutes\(\);/.test(r('src/db/queries/chat.ts')));

    /* ── 운영자 조치가 남의 화면까지 닿는가 ────────────────────────
       숨김은 마지막 id 를 바꾸지 않는다. 조치 수를 따로 보지 않으면 남의 화면은
       재요청조차 하지 않고, 가려진 줄이 그대로 남는다. */
    for (const [label, p] of [
      ['홀덤', 'src/web/games/holdem-client/loop.ts'],
      ['바카라', 'src/web/games/baccarat-client/loop.ts'],
      ['블랙잭', 'src/web/games/blackjack-client/chips.ts'],
      ['그래프', 'src/web/games/crash.ts'],
      ['사다리', 'src/web/games/ladder.ts'],
      ['포커', 'src/web/games/poker-client/loop.ts'],
    ] as const) {
      ck(`${label} 폴링이 조치 수도 넘겨준다`, /casinoChat\.note\(d\.chatMax, d\.chatMod\)/.test(r(p)));
    }
    ck('조치 수가 달라지면 목록을 다시 받는다',
      /if \(typeof mod === 'number' && lastMod !== null && mod !== lastMod\) \{[\s\S]{0,120}?rebuild\(\);/.test(app));
    ck('다시 받을 때 화면을 비우고 시작한다',
      /function rebuild\(\)\{[\s\S]{0,200}?lastId = 0;[\s\S]{0,120}?seen = \{\};/.test(app));
    /* 되받은 지난 줄이 새 말인 양 말풍선으로 터지면 안 된다. */
    ck('다시 받는 동안은 처음 여는 것으로 친다', /primed = false;\s*\r?\n\s*pull\(\);/.test(app));
    /* 느린 폴로 도는 화면(로비·랭킹)은 게임 상태를 안 받는다 — 응답으로도 알아채야 한다. */
    ck('읽기 응답에도 조치 수가 실린다', /mod: chatMod\(\),/.test(r('src/web/chat.ts')));
    ck('응답을 보고도 다시 받는다',
      /if \(needRebuild\) \{ needRebuild = false; rebuild\(\); \}/.test(app));
    /* 첫 수신에서는 다시 받지 않는다 — 값을 처음 아는 순간이라 "달라졌다"가 아니다. */
    ck('처음 알게 된 값으로는 다시 받지 않는다', /var lastMod = null, needRebuild = false;/.test(app));
  }

  console.log('\n[12] 말풍선이 다른 연출을 가리지 않는다');
  {
    const css9 = readFileSync('src/web/assets/css/09-holdem.css', 'utf8');
    const layer = (sel: string) => {
      const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}').exec(css9);
      const z = m && /z-index:(-?\d+)/.exec(m[1]);
      return z ? Number(z[1]) : null;
    };
    /* 좌석 층 전체가 z2 다. bubon(13)은 좌석끼리의 순서일 뿐이라, 펠트 위에 z2 보다
       높이 얹힌 연출은 무엇이든 말풍선보다 위다 — 돈이 움직이는 장면과 결과 발표는
       4초짜리 말풍선에 가려지면 안 된다. */
    ck('좌석 층은 z2 다', layer('.ht-seats') === 2);
    ck('미스터리 전광판이 말풍선보다 위다', (layer('.ht-mysbox') ?? 0) > 2, String(layer('.ht-mysbox')));
    ck('날아가는 칩이 말풍선보다 위다', (layer('.ht-fly-stack') ?? 0) > 2, String(layer('.ht-fly-stack')));
    ck('우승 팝업이 말풍선보다 위다', (layer('.ht-win') ?? 0) > 2, String(layer('.ht-win')));
    /* 4초 뒤 사라질 것이 그동안 클릭을 먹으면 하필 그 자리의 좌석·카드를 못 누른다. */
    ck('말풍선이 클릭을 먹지 않는다', /\.ht-bub\{[^}]*pointer-events:none/.test(css9));
    /* 도크는 화면 오른쪽 아래에 고정이다 — 테이블 위 무엇과도 겹치지 않는 층에 둔다. */
    ck('채팅 도크가 우승 팝업 아래다',
      70 < (layer('.ht-win') ?? 0), '도크 z70 · 팝업 z' + layer('.ht-win'));
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
