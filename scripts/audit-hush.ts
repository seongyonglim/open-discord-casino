/* 결과가 화면에 다 나오기 전에는 «누가 죽었는지» 를 말하지 않는다 — 그 감춤이
 * «이 판에서 죽은 사람» 에게만 걸리는지 본다.
 *
 * ── 왜 따로 두는가
 * 이 검사는 응답을 직접 받아 봐야 한다. 페이로드를 만드는 함수(statePayload)는
 * 내보내지 않으므로 웹 서버를 띄우고 HTTP 로 묻는 길뿐이다. 그리고 대회가 여럿 있으면
 * advanceHoldem 이 «지금 대회» 로 무엇을 고르는지에 따라 엉뚱한 판을 보게 된다 —
 * 실제로 audit-rebuy 안에 넣었더니 앞서 끝난 대회의 응답을 읽고 세 항목이 깨졌다.
 * 그래서 이 파일은 대회 하나만 있는 깨끗한 DB 에서 혼자 돈다.
 *
 * ── 무엇이 틀렸었나
 * 감춤을 테이블 전체에 걸었다. 그러면 세 판 전에 죽은 사람도 남의 쇼다운이 돌 때마다
 * «살아 있음» 으로 되살아나고(칩은 없으니 초록 카드에 숫자가 빈 유령이 된다) 리바이
 * 단추가 [테이블로 복귀하기] 로 덮였다. 그 사람에게는 가릴 결과가 없는데도.
 * 감춰야 하는 것은 «방금 이 판에서 죽었다» 하나뿐이다.
 *
 * 안전: DB_PATH 를 임시 디렉터리로 못 박는다. 포트도 8399 로 따로 쓴다.
 */
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const d of readdirSync(tmpdir())) {
  if (!d.startsWith('casino-hush-')) continue;
  try { rmSync(join(tmpdir(), d), { recursive: true, force: true }); } catch { /* 잠겨 있으면 둔다 */ }
}
process.env.DB_PATH = mkdtempSync(join(tmpdir(), 'casino-hush-'));
process.env.PORT = '8399';
process.env.PREVIEW_LOGIN = '1';
delete process.env.TICK;

const { getDb } = require('../src/db/schema') as typeof import('../src/db/schema');
const Q = require('../src/db/queries') as typeof import('../src/db/queries');
const HD = require('../src/db/holdem') as typeof import('../src/db/holdem');
const A = require('../src/db/admin') as typeof import('../src/db/admin');
const { startWebServer } = require('../src/web/server') as typeof import('../src/web/server');
const db = getDb();
const now = () => Math.floor(Date.now() / 1000);

let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

const BOTS = ['hu1', 'hu2', 'hu3', 'hu4', 'hu5', 'hu6'];
const BUY_IN = 10_000;
for (const p of BOTS) {
  Q.upsertUser(p, p, null);
  const b = Q.getWebUser(p)?.balance ?? 0;
  if (b !== 1_000_000) Q.adjustBalance(p, 1_000_000 - b, 'hush:seed');
}

const made = A.createTournament({
  title: '감춤 검사', regOpenAt: now() - 60, startAt: now() + 3600,
  buyIn: BUY_IN, levelMin: 1, startingStack: 400, lateRegMin: 60, maxRebuys: 3,
});
if (!made.ok) { console.error('대회를 못 열었다:', made.error); process.exit(1); }
for (const p of BOTS) HD.registerHoldem(p, p);
db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ? WHERE id = ?`)
  .run(now() - 1, made.id);
HD.advanceHoldem();
const table = HD.getTable(made.id)!;

/* 장면을 손으로 만든다. 봇을 돌려 우연히 이 상태가 나오기를 기다리면 검사가 느리고
   무엇보다 «그 상태가 안 나온 것» 과 «검사가 통과한 것» 이 구별되지 않는다.
     예전 판에 죽은 사람 — 탈락 시각을 한참 과거로
     이 판에 죽은 사람   — 탈락 시각을 지금 핸드의 종료 시각과 같게 */
const OLD = BOTS[0], FRESH = BOTS[1];
db.prepare(`UPDATE holdem_entries SET elim_seq = 1, eliminated_at = ?
             WHERE tournament_id = ? AND user_id = ?`).run(now() - 600, made.id, OLD);
db.prepare(`UPDATE holdem_seats SET presence = 'OUT', stack = 0
             WHERE table_id = ? AND user_id = ?`).run(table.id, OLD);

const hand = db.prepare(`SELECT id FROM holdem_hands WHERE table_id = ?
                          ORDER BY id DESC LIMIT 1`).get(table.id) as { id: number };
db.prepare(`UPDATE holdem_hands SET ended_at = ?, ended_ms = ? WHERE id = ?`)
  .run(now(), Date.now(), hand.id);
/* 연출 창을 넉넉히 열어 둔다 — 검사가 도는 동안 닫히면 안 된다 */
db.prepare(`UPDATE holdem_tables SET next_hand_at = ? WHERE id = ?`).run(now() + 120, table.id);
db.prepare(`UPDATE holdem_entries SET elim_seq = 2, eliminated_at = ?
             WHERE tournament_id = ? AND user_id = ?`).run(now(), made.id, FRESH);
db.prepare(`UPDATE holdem_seats SET presence = 'OUT', stack = 0
             WHERE table_id = ? AND user_id = ?`).run(table.id, FRESH);

startWebServer();

async function ask(userId: string): Promise<any> {
  const tok = 'hush-' + userId;
  Q.createSession(tok, userId, now() + 3600);
  const r = await fetch('http://127.0.0.1:8399/api/games/holdem/state',
    { headers: { cookie: 'sid=' + tok } });
  return r.json();
}

(async () => {
  console.log('\n예전 판에 죽은 사람의 눈으로 본다\n');
  const body = await ask(OLD);
  const t = body.tournament;
  const ps: any[] = t?.players ?? [];
  const oldRow = ps.find(p => p.userId === OLD);
  const freshRow = ps.find(p => p.userId === FRESH);

  ck('이 대회를 보고 있다', t?.id === made.id, `${t?.id} vs ${made.id}`);
  ck('예전 판에 죽은 사람은 계속 탈락이다', oldRow?.out === true, JSON.stringify(oldRow));
  /* 이것이 이 파일의 핵심이다 — 남의 쇼다운이 내 리바이를 막으면 안 된다 */
  ck('예전 판에 죽은 사람은 남의 쇼다운 중에도 리바이가 열려 있다',
    t?.rebuy?.can === true, JSON.stringify(t?.rebuy));
  ck('이 판에 죽은 사람은 잠깐 살아 있는 것으로 보인다',
    freshRow?.out === false, JSON.stringify(freshRow));
  /* 감추면서 칩까지 0 으로 두면 «초록 카드인데 숫자가 없는» 유령이 된다.
     판이 시작될 때 들고 있던 칩을 준다 — 인게임 칩 순위가 쓰는 것과 같은 값이다. */
  ck('그때도 칩이 0 이 아니다 (유령 카드 방지)', (freshRow?.stack ?? 0) > 0,
    String(freshRow?.stack));
  ck('이 판에 죽은 사람의 탈락 시각은 안 보낸다', freshRow?.outAt == null,
    String(freshRow?.outAt));
  const ghosts = ps.filter(p => !p.out && (p.stack ?? 0) <= 0);
  ck('살아 있는데 칩이 없는 사람은 없다', ghosts.length === 0,
    ghosts.map(p => p.username).join(','));

  console.log('\n방금 죽은 사람의 눈으로 본다\n');
  const mine = await ask(FRESH);
  ck('자기 자신의 리바이는 결과가 나온 뒤로 미룬다',
    mine.tournament?.rebuy?.can === false
    && mine.tournament?.rebuy?.reason === 'revealing',
    JSON.stringify(mine.tournament?.rebuy));

  console.log('\n쇼다운 시각이 실려 나간다\n');
  ck('showdownAt 이 밀리초로 온다', typeof mine.table?.showdownAt === 'number',
    String(mine.table?.showdownAt));
  ck('serverNowMs 가 함께 온다', typeof mine.serverNowMs === 'number',
    String(mine.serverNowMs));

  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  /* 서버를 띄운 채로 process.exit 하면 윈도우에서 libuv 가 종료 중인 핸들을 두고
     assert 로 죽는다 — 결과는 다 찍힌 뒤인데 종료 코드가 127 이 되어 «실패» 로 읽힌다.
     코드만 정해 두고 조금 뒤에 나간다. */
  process.exitCode = fail ? 1 : 0;
  setTimeout(function(){ process.exit(fail ? 1 : 0); }, 80);
})();
