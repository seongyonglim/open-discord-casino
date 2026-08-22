/* 리바이 대회 한 판을 클라이언트 없이 끝까지 돌린다.
 *
 * ── 왜 따로 두는가
 * audit-tourney 는 «프리즈아웃 한 판이 끝까지 도는가» 를 본다. 리바이는 그 상태
 * 기계에 «죽은 사람이 되살아난다» 를 끼워 넣는 일이라, 끊길 수 있는 자리가 새로 생긴다:
 *   · 탈락 표시(elim_seq)를 지우고 다시 앉혔는데 등수 계산이 그 사람을 두 번 세는가
 *   · 총 엔트리가 늘었는데 상금 풀이 안 따라오는가
 *   · 늦은 등록 창이 닫힌 뒤에도 리바이가 되는가
 *   · 횟수를 다 쓴 뒤에도 되는가
 *   · 그 와중에 «잔액 합 = 원장 누계» 가 깨지는가
 * 그 다섯은 화면을 봐서는 모른다 — 판이 끝나고 한참 뒤에 숫자로만 드러난다.
 *
 * ── 각본
 * 봇 여섯이 차례가 오면 무조건 올인한다. 그래야 탈락이 빨리 나고, 리바이 상황을
 * 기다리지 않고 만들 수 있다. 탈락한 봇은 곧바로 리바이를 시도한다 — 허용 횟수는
 * 셋이고, 넷째부터는 거절되어야 한다.
 *
 * 안전: DB_PATH 를 임시 디렉터리로 못 박는다. 운영 DB 는 열지 않는다.
 */
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';

/* 'casino-rb' 로 걸러서는 안 된다 — 같은 기능의 눈으로 보는 시뮬레이션이
   'casino-rbsim-…' 을 쓰기 때문에, 그게 돌고 있는 동안 이 감사를 돌리면 남의 DB 를
   지우려다 EPERM 으로 죽는다(실측). 뒤의 하이픈까지 붙여 내 것만 고른다.
   못 지우는 것이 있어도 넘어간다: 지난 실행의 찌꺼기일 뿐이고, 이번 실행은
   어차피 새 디렉터리에서 시작한다. */
for (const d of readdirSync(tmpdir())) {
  if (!d.startsWith('casino-rb-')) continue;
  try { rmSync(join(tmpdir(), d), { recursive: true, force: true }); } catch { /* 잠겨 있으면 둔다 */ }
}
process.env.DB_PATH = mkdtempSync(join(tmpdir(), 'casino-rb-'));
delete process.env.TICK;

const { getDb } = require('../src/db/schema') as typeof import('../src/db/schema');
const Q = require('../src/db/queries') as typeof import('../src/db/queries');
const HD = require('../src/db/holdem') as typeof import('../src/db/holdem');
const A = require('../src/db/admin') as typeof import('../src/db/admin');
const T = require('../src/tick') as typeof import('../src/tick');
const TS = require('../src/services/tournament') as typeof import('../src/services/tournament');
const db = getDb();
const now = () => Math.floor(Date.now() / 1000);

let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

/* 여섯이다. 아홉 자리 판이므로 셋이 리바이해도 자리가 남는다 — 자리 부족으로
   거절되는 것과 횟수 소진으로 거절되는 것을 갈라 보려면 자리가 넉넉해야 한다. */
/* 인원을 바꿀 수 있게 둔다. 여섯이 기본이지만, 상금이 새던 자리는 «사람 수보다 상금
   줄이 많아지는» 판이었고 그건 사람이 적을수록 잘 생긴다 — 셋이 세 번씩 사면 엔트리
   열둘에 지급 넷이 나와서, 예전 코드라면 12,495P 가 아무에게도 안 갔다.
     RB_BOTS=3 npx tsx scripts/audit-rebuy.ts */
const ALL_BOTS = ['rb1', 'rb2', 'rb3', 'rb4', 'rb5', 'rb6'];
const BOTS = ALL_BOTS.slice(0, Math.max(3, Math.min(6, Number(process.env.RB_BOTS ?? 6))));
const BUY_IN = 10_000;
const MAX_REBUYS = 3;
const SEED = 1_000_000;   // 리바이를 여러 번 할 수 있을 만큼
for (const p of BOTS) {
  Q.upsertUser(p, p, null);
  const b = Q.getWebUser(p)?.balance ?? 0;
  if (b !== SEED) Q.adjustBalance(p, SEED - b, 'rb:seed');
}

const made = A.createTournament({
  title: '리바이 검사', regOpenAt: now() - 60, startAt: now() + 3600,
  buyIn: BUY_IN, levelMin: 1, startingStack: 300, lateRegMin: 60,
  maxRebuys: MAX_REBUYS,
});
if (!made.ok) { console.error('대회를 못 열었다:', made.error); process.exit(1); }
for (const p of BOTS) HD.registerHoldem(p, p);

/* 대회 설정이 행에 박혔는지부터 본다. 여기가 어긋나면 아래 검사는 전부 무의미하다 */
{
  const row = db.prepare(`SELECT max_rebuys AS n, buy_in AS b FROM holdem_tournaments WHERE id = ?`)
    .get(made.id) as { n: number; b: number };
  ck('대회 행에 리바이 횟수가 박혔다', row.n === MAX_REBUYS, String(row.n));
  ck('대회 행에 참가비가 박혔다', row.b === BUY_IN, String(row.b));
}

/* 블라인드 시계를 당긴다(audit-tourney 와 같은 이유) */
db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?, level_sec = 8`).run(now() - 1);

const ledgerSum = () => (db.prepare(
  `SELECT COALESCE(SUM(delta),0) AS n FROM points_ledger`).get() as { n: number }).n;
const balSum = () => (db.prepare(
  `SELECT COALESCE(SUM(balance),0) AS n FROM users`).get() as { n: number }).n;

console.log('\n봇 6명 · 차례마다 올인 · 리바이 최대 3회 · 참가비 10,000P\n');
const startedAt = Date.now();
T.startTicks();

/* 봇은 계속 올인한다 — 다만 «동시에» 는 아니다.
   전원이 매번 올인하게 두면 첫 판에 다섯이 한꺼번에 죽고 그 자리에서 대회가 끝난다.
   advanceTable 은 탈락을 쓴 바로 다음 반복에서 생존자가 하나임을 보고 같은 호출
   안에서 finishTournament 로 넘어가므로, 탈락과 종료 사이에 1밀리초도 없다.
   실측했다: 1판 8초에 끝났고 리바이 시도 726번이 전부 «아직 안 죽었다» 로 거절됐다.
   이건 고칠 버그가 아니라 옳은 동작이다 — 실제로도 전원이 지르면 그 판에 끝난다.

   그래서 각자 판마다 지를지 접을지를 따로 정한다. 한 판에 둘셋이 지르면 하나가 죽고
   나머지는 살아 판이 이어진다 — 죽은 사람이 리바이해서 돌아오는, 실제 대회에서
   리바이가 일어나는 바로 그 모습이다. 접을 수 없는 자리(체크로 넘길 수 있는 자리)
   에서는 체크한다. */
const act = setInterval(() => {
  const t = db.prepare(`SELECT id FROM holdem_tournaments ORDER BY id DESC LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!t) return;
  for (const p of BOTS) {
    if (randomInt(100) < 40 && HD.holdemAction(p, 'allin', 0).ok) continue;
    if (HD.holdemAction(p, 'check', 0).ok) continue;
    HD.holdemAction(p, 'fold', 0);
  }
}, 90);

/* 탈락한 봇은 곧바로 리바이한다. 시도 결과를 전부 세어 둔다 —
   성공 횟수와 거절 사유가 이 검사의 본체다. */
const tried: Record<string, number> = {};
const okCount: Record<string, number> = {};
const refused: Record<string, number> = {};
/* 자주 돈다. 탈락에서 대회 종료까지의 창이 좁아서(같은 틱에 끝날 수도 있다)
   느리게 돌면 그 창을 통째로 놓친다. */
const rebuy = setInterval(() => {
  for (const p of BOTS) {
    const r = HD.rebuyHoldem(p, p);
    tried[p] = (tried[p] ?? 0) + 1;
    if (r.ok) okCount[p] = (okCount[p] ?? 0) + 1;
    else refused[r.error] = (refused[r.error] ?? 0) + 1;
  }
}, 60);

/* ── 취소하면 리바이로 낸 돈도 돌아오는가 ──────────────────────────
   정상 종료에서는 리바이 값이 상금 풀로 다시 나간다. 안 돌아오는 자리는 취소뿐이고,
   그 경로가 셋이다(부팅 자동 취소 · 운영자 중단 · 끝난 판 삭제). 그중 부팅 취소는
   배포할 때마다 도는 길이라 가장 자주 지나간다.
   새 대회를 하나 더 열어 리바이를 시킨 뒤 부팅 취소를 불러 본다.
   기준은 하나다: 모두의 잔액이 시작값으로 정확히 돌아오는가. */
function refundCheck(): void {
  const before = new Map(BOTS.map(p => [p, Q.getWebUser(p)?.balance ?? 0]));
  const made2 = A.createTournament({
    title: '취소 환불 검사', regOpenAt: now() - 60, startAt: now() + 3600,
    buyIn: BUY_IN, levelMin: 1, startingStack: 300, lateRegMin: 60, maxRebuys: MAX_REBUYS,
  });
  if (!made2.ok) { console.log('  FAIL 두 번째 대회를 못 열었다: ' + made2.error); process.exit(1); }
  for (const p of BOTS) HD.registerHoldem(p, p);
  db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ? WHERE id = ?`)
    .run(now() - 1, made2.id);
  HD.advanceHoldem();
  /* 한 명을 손으로 탈락시켜 리바이를 시킨다 — 판을 끝까지 돌릴 필요가 없다 */
  db.prepare(`UPDATE holdem_entries SET elim_seq = 1, eliminated_at = ?
               WHERE tournament_id = ? AND user_id = ?`).run(now(), made2.id, BOTS[0]);
  db.prepare(`UPDATE holdem_seats SET presence = 'OUT', stack = 0
               WHERE user_id = ? AND table_id IN
                 (SELECT id FROM holdem_tables WHERE tournament_id = ?)`).run(BOTS[0], made2.id);
  const rb = HD.rebuyHoldem(BOTS[0], BOTS[0]);
  ck('두 번째 대회에서 리바이가 됐다', rb.ok, JSON.stringify(rb));
  const paidNow = (db.prepare(`SELECT rebuy_paid AS n FROM holdem_entries
                                WHERE tournament_id = ? AND user_id = ?`)
    .get(made2.id, BOTS[0]) as { n: number }).n;
  ck('리바이로 낸 돈이 기록됐다 (환불 검사용)', paidNow === BUY_IN, String(paidNow));

  HD.cancelRunningHoldemOnBoot();
  for (const p of BOTS) {
    const after = Q.getWebUser(p)?.balance ?? 0;
    ck('취소 후 ' + p + ' 의 잔액이 시작값으로 돌아왔다', after === before.get(p),
      after + ' vs ' + before.get(p));
  }
  /* 두 번 불러도 두 번 나가지 않는다 — 취소 뒤에 삭제가 잇달아 지나가는 경로가 있다 */
  const mid = new Map(BOTS.map(p => [p, Q.getWebUser(p)?.balance ?? 0]));
  HD.refundEntries(made2.id, 'holdem:cancel:');
  let twice = 0;
  for (const p of BOTS) if ((Q.getWebUser(p)?.balance ?? 0) !== mid.get(p)) twice++;
  ck('환불은 두 번 불러도 한 번만 나간다', twice === 0, twice + '명이 두 번 받았다');
  ck('잔액 합 = 원장 누계 (환불 뒤에도)', balSum() === ledgerSum(),
    balSum() + ' vs ' + ledgerSum());

  report();
}

function report(): void {
  console.log('');
  console.log('통과 ' + pass + ' · 실패 ' + fail);
  process.exit(fail ? 1 : 0);
}
const LIMIT_MS = 5 * 60 * 1000;
let lastLine = '';
const watch = setInterval(() => {
  const t = db.prepare(`SELECT id, started_at, finished_at, cancelled_at
      FROM holdem_tournaments ORDER BY id DESC LIMIT 1`).get() as
    { id: number; started_at: number | null; finished_at: number | null; cancelled_at: number | null };
  const table = HD.getTable(t.id);
  const alive = table ? HD.getSeats(table.id).filter(s => s.presence !== 'OUT').length : 0;
  const entries = HD.getEntries(t.id);
  const rb = entries.reduce((s, e) => s + e.rebuy_count, 0);
  const line = (t.finished_at ? '끝남' : t.cancelled_at ? '취소됨' : t.started_at ? '진행 중' : '대기')
    + (table ? ` · ${table.hand_no}판 · 생존 ${alive}명 · 리바이 ${rb}회` : '');
  if (line !== lastLine) {
    console.log(`  ${((Date.now() - startedAt) / 1000).toFixed(0).padStart(3)}초  ${line}`);
    lastLine = line;
  }

  if (t.finished_at || t.cancelled_at) {
    clearInterval(watch); clearInterval(act); clearInterval(rebuy); T.stopTicks();
    const entries2 = HD.getEntries(t.id);
    const totalEntries = HD.totalEntriesOf(entries2);
    const rbTotal = entries2.reduce((s, e) => s + e.rebuy_count, 0);
    const rbPaid = entries2.reduce((s, e) => s + e.rebuy_paid, 0);

    console.log('\n결과');
    for (const e of [...entries2].sort((a, b) => (a.finish_place ?? 99) - (b.finish_place ?? 99))) {
      console.log(`  ${String(e.finish_place ?? '-').padStart(2)}위  ${e.username}` +
        `  리바이 ${e.rebuy_count}회  낸 돈 ${(e.paid_in + e.rebuy_paid).toLocaleString()}P` +
        `  상금 ${e.prize.toLocaleString()}P`);
    }
    console.log(`\n  사람 ${entries2.length}명 · 총 엔트리 ${totalEntries} · 리바이 ${rbTotal}회`);
    console.log(`  거절 사유: ${Object.entries(refused).map(([k, v]) => k + ' ' + v).join(' · ') || '없음'}`);

    ck('취소가 아니라 정상 종료다', !t.cancelled_at);
    ck('리바이가 실제로 일어났다', rbTotal > 0, `${rbTotal}회`);
    /* 한 사람이 허용 횟수를 넘겨 리바이하면 안 된다 — 그것이 이 기능의 유일한 상한이다 */
    ck('아무도 허용 횟수를 넘지 않았다',
      entries2.every(e => e.rebuy_count <= MAX_REBUYS),
      entries2.map(e => e.username + ':' + e.rebuy_count).join(' '));
    /* 행이 늘어나면 안 된다 — 사람 하나에 줄 하나가 등수 계산의 전제다 */
    ck('사람 수만큼만 행이 있다', entries2.length === BOTS.length,
      `${entries2.length} vs ${BOTS.length}`);
    /* 총 엔트리는 «행 수 + 리바이 합» 이다 */
    ck('총 엔트리 = 사람 수 + 리바이 횟수',
      totalEntries === entries2.length + rbTotal, `${totalEntries}`);
    /* 등수는 1..N 하나씩. 되살아난 사람이 두 번 세어지면 여기서 깨진다 */
    const places = entries2.map(e => e.finish_place).sort((a, b) => (a ?? 0) - (b ?? 0));
    ck('등수가 1..N 하나씩이다',
      places.join(',') === BOTS.map((_, i) => i + 1).join(','), places.join(','));
    /* 리바이로 낸 돈이 기록됐다 */
    ck('리바이로 낸 돈이 기록됐다', rbPaid === rbTotal * BUY_IN,
      `${rbPaid} vs ${rbTotal} × ${BUY_IN}`);
    /* 상금 풀이 총 엔트리를 근거로 만들어졌다 — 여기가 이 기능의 핵심이다.
       사람 수로 계산하면 걷은 돈보다 적게 나가고, 그 차액은 아무에게도 안 간다. */
    const t2 = db.prepare(`SELECT * FROM holdem_tournaments WHERE id = ?`).get(t.id) as any;
    const pool = HD.prizePoolOf(t2, totalEntries);
    const paid = entries2.reduce((s, e) => s + e.prize, 0);
    ck('나간 상금 = 총 엔트리 기준 상금 풀', paid === pool, `${paid} vs ${pool}`);
    ck('상금 풀 = 총 엔트리 × 참가비', pool === totalEntries * BUY_IN,
      `${pool} vs ${totalEntries} × ${BUY_IN}`);
    /* 걷은 돈과 나간 돈이 맞는가 */
    const collected = entries2.reduce((s, e) => s + e.paid_in + e.rebuy_paid, 0);
    ck('걷은 돈 = 나간 상금', collected === paid, `${collected} vs ${paid}`);
    /* 지급 인원이 하한 규칙을 지켰는가 */
    const winners = entries2.filter(e => e.prize > 0).length;
    ck('지급 인원 = 실지급 인원 계산값', winners === TS.paidCount(pool, totalEntries),
      `${winners} vs ${TS.paidCount(pool, totalEntries)}`);
    /* 이 프로젝트의 유일한 불변식 */
    ck('잔액 합 = 원장 누계 (돈이 새지 않았다)', balSum() === ledgerSum(),
      `${balSum()} vs ${ledgerSum()}`);
    /* 늦은 등록이 닫힌 뒤에는 거절돼야 한다 — 대회가 끝났으니 지금 시도하면 막힌다 */
    const late = HD.rebuyHoldem(BOTS[0], BOTS[0]);
    ck('끝난 대회에서는 리바이가 거절된다', !late.ok, JSON.stringify(late));

    console.log(`\n통과 ${pass} · 실패 ${fail}`);
    /* ── 상금표가 «받을 사람 수» 를 넘지 않는가 ────────────────────
       리바이는 행을 안 늘리므로(사람당 한 줄) 엔트리 수로 지급 인원을 정하면
       받을 사람보다 줄이 많아질 수 있다. 그때 남는 줄의 금액은 아무에게도 안 간다 —
       잔액=원장 불변식은 멀쩡해서 여기서 따로 세지 않으면 못 잡는다.
       실제 대회 하나로는 그 경계에 안 닿을 수 있으므로(봇 여섯이면 여섯 줄까지는
       늘 받을 사람이 있다) 함수를 직접 눌러 본다. */
    let capBad = 0;
    for (let people = 3; people <= 9; people++) {
      for (let rb = 0; rb <= 10; rb++) {
        const tot = people * (1 + rb);
        const pl = tot * BUY_IN;
        const amt = TS.prizeAmounts(pl, tot, people);
        const sum2 = amt.reduce((a, b) => a + b, 0);
        if (amt.length > people || sum2 !== pl) capBad++;
      }
    }
    ck('상금표가 받을 사람 수를 넘지 않고 합도 정확하다 (3~9명 × 0~10리바이)', capBad === 0,
      capBad + '가지 조합이 어긋난다');
    if (fail) process.exit(1);
    refundCheck();
  }

  if (Date.now() - startedAt > LIMIT_MS) {
    clearInterval(watch); clearInterval(act); clearInterval(rebuy); T.stopTicks();
    console.log(`\n${LIMIT_MS / 1000}초가 지나도 안 끝났다 — 어딘가 멈춰 있다`);
    console.log(`  마지막 상태: ${lastLine}`);
    process.exit(1);
  }
}, 250);
