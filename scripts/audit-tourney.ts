/* 대회 한 판을 클라이언트 없이 끝까지 돌린다.
 *
 * HTTP 요청을 한 건도 보내지 않는다. 웹 서버조차 안 띄운다.
 * 오직 src/tick.ts 의 타이머만으로 대회가 열리고, 시작하고, 판이 돌고, 끝나야 한다.
 *
 * ── 왜 따로 두는가
 * audit-tick 은 "라운드가 전진하는가"까지만 본다. 그건 몇 초짜리 확인이고, 대회는
 * 그보다 훨씬 긴 상태 기계다 — 등록, 시작, 판 진행, 블라인드 인상, 자동 폴드,
 * 탈락, 상금 지급이 전부 이어져야 끝난다. 그 사슬 어디가 끊겨도 대회는 멈춘 채로
 * 남고, 아무도 화면을 안 보고 있으면 멈춘 줄도 모른다. 그래서 끝까지 돌려 본다.
 *
 * 아무도 액션하지 않으므로 전원이 시간 초과로 자동 폴드된다 — 그 경로까지 타이머가
 * 굴리는지 보는 것이 이 검사의 요점이다.
 *
 * ── 시계를 당긴다
 * 블라인드 레벨과 액션 마감을 앞으로 민다. 규칙은 한 줄도 안 바꾼다 — 자동 폴드는
 * 여전히 "마감이 지났으니 접는다"는 같은 경로로 일어나고, 다만 그 마감이 20초 뒤가
 * 아니라 지금일 뿐이다. 안 당기면 한 판에 20초씩 걸려 대회 하나에 8분이 든다.
 *
 * 안전: DB_PATH 를 임시 디렉터리로 못 박는다. 운영 DB 는 열지 않는다.
 */
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const d of readdirSync(tmpdir())) {
  if (d.startsWith('casino-tt')) rmSync(join(tmpdir(), d), { recursive: true, force: true });
}
process.env.DB_PATH = mkdtempSync(join(tmpdir(), 'casino-tt-'));
delete process.env.TICK;

const { getDb } = require('../src/db/schema') as typeof import('../src/db/schema');
const Q = require('../src/db/queries') as typeof import('../src/db/queries');
const HD = require('../src/db/holdem') as typeof import('../src/db/holdem');
const A = require('../src/db/admin') as typeof import('../src/db/admin');
const T = require('../src/tick') as typeof import('../src/tick');
const db = getDb();
const now = () => Math.floor(Date.now() / 1000);

let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

const PEOPLE = ['p1', 'p2', 'p3', 'p4', 'p5'];
const SEED = 100_000;
for (const p of PEOPLE) {
  Q.upsertUser(p, p, null);
  const b = Q.getWebUser(p)?.balance ?? 0;
  if (b !== SEED) Q.adjustBalance(p, SEED - b, 'tt:seed');
}

const made = A.createTournament({
  title: '무인 진행 검사', regOpenAt: now() - 60, startAt: now() + 3600,
  levelMin: 1, startingStack: 300,
});
if (!made.ok) { console.error('대회를 못 열었다:', made.error); process.exit(1); }
for (const p of PEOPLE) HD.registerHoldem(p, p);
/* 블라인드 시계를 당긴다. 탈락은 판 수가 아니라 블라인드 레벨이 만든다 — 레벨은
   started_at 으로부터 흐른 실제 시간으로 정해지므로(levelAt), 판만 빨리 돌려도
   스택은 안 줄고 대회가 끝나지 않는다(그렇게 짰다가 20판을 돌고도 생존 5명이었다).
   레벨 간격만 줄이고 레벨표 자체는 그대로 쓴다. */
db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?, level_sec = 8`).run(now() - 1);

const ledgerSum = () => (db.prepare(
  `SELECT COALESCE(SUM(delta),0) AS n FROM points_ledger`).get() as { n: number }).n;
const balSum = () => (db.prepare(
  `SELECT COALESCE(SUM(balance),0) AS n FROM users`).get() as { n: number }).n;

console.log('\n클라이언트 0개 · HTTP 요청 0건 · 타이머만으로 대회를 돌린다\n');
const startedAt = Date.now();
T.startTicks();

/* 액션 마감을 계속 지금으로 당긴다 — 아무도 액션하지 않을 것이므로 20초를 기다릴
   이유가 없다. 자동 폴드가 일어나는 경로는 그대로다. */
const clock = setInterval(() => {
  db.prepare(`UPDATE holdem_hands SET action_deadline = ?
               WHERE ended_at IS NULL AND action_deadline > ?`).run(now(), now());
}, 200);

const LIMIT_MS = 4 * 60 * 1000;
let lastLine = '';
const watch = setInterval(() => {
  const t = db.prepare(`SELECT id, started_at, finished_at, cancelled_at
      FROM holdem_tournaments ORDER BY id DESC LIMIT 1`).get() as
    { id: number; started_at: number | null; finished_at: number | null; cancelled_at: number | null };
  const table = HD.getTable(t.id);
  const alive = table ? HD.getSeats(table.id).filter(s => s.presence !== 'OUT').length : 0;
  const line = (t.finished_at ? '끝남' : t.cancelled_at ? '취소됨' : t.started_at ? '진행 중' : '대기')
    + (table ? ` · ${table.hand_no}판 · 생존 ${alive}명` : '');
  if (line !== lastLine) {
    console.log(`  ${((Date.now() - startedAt) / 1000).toFixed(0).padStart(3)}초  ${line}`);
    lastLine = line;
  }

  if (t.finished_at || t.cancelled_at) {
    clearInterval(watch); clearInterval(clock); T.stopTicks();
    const entries = db.prepare(
      `SELECT username, finish_place, prize FROM holdem_entries WHERE tournament_id = ?
        ORDER BY finish_place ASC`).all(t.id) as
      { username: string; finish_place: number | null; prize: number }[];

    console.log('\n결과');
    for (const e of entries) console.log(`  ${e.finish_place}위  ${e.username}  ${e.prize}P`);
    console.log('');

    ck('취소가 아니라 정상 종료다', !t.cancelled_at);
    ck('참가자 전원이 순위를 받았다',
      entries.length === PEOPLE.length && entries.every(e => e.finish_place != null),
      `${entries.filter(e => e.finish_place != null).length}/${PEOPLE.length}`);
    ck('우승자가 나왔다', entries[0]?.finish_place === 1);
    /* 순위는 1..N 이 하나씩이어야 한다 — 공동 1위나 빠진 등수가 있으면 탈락 처리가
       어긋난 것이다. */
    const places = entries.map(e => e.finish_place).sort((a, b) => (a ?? 0) - (b ?? 0));
    ck('등수가 1..N 하나씩이다', places.join(',') === PEOPLE.map((_, i) => i + 1).join(','),
      places.join(','));
    ck('상금이 우승자에게 몰려 있다', (entries[0]?.prize ?? 0) > 0, `${entries[0]?.prize}P`);
    /* 이 프로젝트의 유일한 불변식이다 — 잔액 합과 원장 누계가 같아야 한다.
       판이 도는 내내 참가비·상금이 오갔는데도 1P 도 새지 않아야 한다. */
    ck('잔액 합 = 원장 누계 (돈이 새지 않았다)', balSum() === ledgerSum(),
      `${balSum()} vs ${ledgerSum()}`);
    /* 상금 풀만큼만 나갔는가. 이 대회는 프리롤이라 참가비를 걷지 않고 상금을 집이
       댄다 — 근거는 "참가자 수 × prize_multiplier" 하나뿐이다. 정산이 어긋나면
       사람 수와 무관한 액수가 빠져나가므로 여기서 드러난다. */
    const prize = entries.reduce((s, e) => s + e.prize, 0);
    const mult = (db.prepare(`SELECT prize_multiplier AS n FROM holdem_tournaments WHERE id = ?`)
      .get(t.id) as any).n;
    ck('나간 상금 = 참가자 수 × 상금 배수', prize === PEOPLE.length * mult,
      `${prize} vs ${PEOPLE.length} × ${mult}`);

    /* 대회가 정상적으로 끝났으면 이월은 갚아진 것이다 — 다음 판은 제 값으로
       돌아가야 한다. 이 검사가 여기 있는 이유는 완주하는 경로가 여기뿐이기 때문이다
       (audit-rollover 는 쌓이는 규칙만 본다). */
    const R = require('../src/db/rollover') as typeof import('../src/db/rollover');
    ck('끝난 뒤 이월이 0 으로 돌아간다', R.rolloverFactor() === 1, `${R.rolloverFactor()}배`);

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`통과 ${pass} · 실패 ${fail} · ${((Date.now() - startedAt) / 1000).toFixed(0)}초`);
    process.exit(fail ? 1 : 0);
  }

  if (Date.now() - startedAt > LIMIT_MS) {
    clearInterval(watch); clearInterval(clock); T.stopTicks();
    console.error(`\n${LIMIT_MS / 60000}분이 지나도 안 끝났다 — 어딘가 멈춰 있다`);
    console.error(`  마지막 상태: ${lastLine}`);
    process.exit(1);
  }
}, 500);
