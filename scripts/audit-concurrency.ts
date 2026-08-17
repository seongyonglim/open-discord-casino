// 동시성 감사 — 실제 HTTP 요청을 병렬로 날려 이중 차감/이중 지급이 나는지 본다.
// SQLite는 단일 프로세스 안에서 직렬화되지만, 우리 코드는 "await readJson 이후 동기 처리"라는
// 규칙에 의존한다. 그 규칙이 깨진 곳이 있으면 여기서 잔액이 어긋나며 드러난다.

// 감사는 항상 일회용 DB에서 돈다. DB_PATH를 지정하지 않고 실행해도 로컬/운영 데이터를 건드리지 않게
// 여기서 임시 경로로 못 박는다(첫 import보다 먼저 실행되어야 하므로 파일 맨 위에 둔다).
if (!process.env.DB_PATH) {
  const os = require('node:os'), path = require('node:path'), fsx = require('node:fs');
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'casino-audit-'));
  process.env.DB_PATH = dir;
}

import http from 'node:http';
import { getDb } from '../src/db/schema';
import { upsertUser, adjustBalance, getWebUser, createSession } from '../src/db/queries';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.AUDIT_PORT ?? 8210);
let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
function section(s: string): void { console.log('\n' + s); }

interface Res { status: number; body: any }
function req(method: string, path: string, cookie: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: PORT, path, method,
      headers: {
        cookie,
        ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: any = text;
        try { parsed = JSON.parse(text); } catch { /* HTML 응답 */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function mkSession(id: string, start: number): string {
  upsertUser(id, '동시성' + id, null);
  const cur = getWebUser(id)!.balance;
  if (cur !== start) adjustBalance(id, start - cur, 'test:seed');
  const token = randomBytes(16).toString('hex');
  createSession(token, id, Math.floor(Date.now() / 1000) + 3600);
  return `sid=${token}`;
}
const bal = (id: string) => getWebUser(id)!.balance;
const db = getDb();

function ledgerOk(): boolean {
  const users = db.prepare(`SELECT id, balance FROM users`).all() as any[];
  for (const u of users) {
    const sum = (db.prepare(`SELECT COALESCE(SUM(delta),0) AS s FROM points_ledger WHERE user_id = ?`)
      .get(u.id) as any).s;
    if (sum !== u.balance) { console.log(`    (${u.id}: 원장합 ${sum} ≠ 잔액 ${u.balance})`); return false; }
  }
  return true;
}

async function main(): Promise<void> {
  const { startWebServer } = require('../src/web/server') as typeof import('../src/web/server');
  process.env.PORT = String(PORT);
  startWebServer();
  await new Promise(r => setTimeout(r, 600));

  /* ── 1. 사다리: 같은 유저가 동시에 20번 베팅 ───────────────────── */
  section('[1] 사다리 — 동시 베팅 연타 (같은 유저 × 20)');
  {
    const c = mkSession('x_lad', 1000);
    const st = await req('GET', '/api/games/ladder/state', c);
    const roundId = st.body?.round?.id;
    ck('라운드 조회', typeof roundId === 'number', JSON.stringify(st.body?.round));

    const results = await Promise.all(Array.from({ length: 20 }, () =>
      req('POST', '/api/games/ladder/bet', c, { startGuess: 'L', betAmount: 100 })));
    const okCount = results.filter(r => r.body?.ok).length;
    ck('20번 중 정확히 1번만 성공 (1인 1베팅)', okCount === 1, `성공 ${okCount}회`);
    ck('차감은 100P 한 번만', bal('x_lad') === 900, String(bal('x_lad')));
  }

  /* ── 2. 그래프: 잔액을 초과하도록 동시에 베팅 ──────────────────── */
  section('[2] 그래프 — 잔액 초과 동시 베팅');
  {
    const c = mkSession('x_crash', 500);
    const st = await req('GET', '/api/games/crash/state', c);
    const roundId = st.body?.round?.id;
    // 500P밖에 없는데 400P 베팅을 10번 동시에 → 많아야 1번 성공해야 한다
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      req('POST', '/api/games/crash/bet', c, { betAmount: 400 })));
    const okCount = results.filter(r => r.body?.ok).length;
    ck('동시 베팅 중 최대 1번만 성공', okCount <= 1, `성공 ${okCount}회`);
    ck('잔액이 음수로 내려가지 않음', bal('x_crash') >= 0, String(bal('x_crash')));
    ck('차감액이 정확 (500 또는 100)', bal('x_crash') === 500 || bal('x_crash') === 100, String(bal('x_crash')));
  }

  /* ── 3. 그래프: 캐시아웃 동시 연타 ─────────────────────────────── */
  section('[3] 그래프 — 캐시아웃 동시 연타 (이중 지급 검사)');
  {
    const c = mkSession('x_cash', 1000);
    let st = await req('GET', '/api/games/crash/state', c);
    let roundId = st.body?.round?.id;
    let phase = st.body?.round?.phase;
    // 베팅 창이 아니면 다음 창이 열릴 때까지 기다린다 (최대 20초)
    for (let i = 0; i < 40 && phase !== 'betting'; i++) {
      await new Promise(r => setTimeout(r, 500));
      st = await req('GET', '/api/games/crash/state', c);
      roundId = st.body?.round?.id; phase = st.body?.round?.phase;
    }
    ck('베팅 창 확보', phase === 'betting', String(phase));
    const placed = await req('POST', '/api/games/crash/bet', c, { betAmount: 300 });
    ck('베팅 성공', placed.body?.ok === true, JSON.stringify(placed.body));
    ck('베팅 차감 700', bal('x_cash') === 700, String(bal('x_cash')));

    // 상승 단계로 들어갈 때까지 대기
    for (let i = 0; i < 60; i++) {
      st = await req('GET', '/api/games/crash/state', c);
      if (st.body?.round?.phase === 'running') break;
      await new Promise(r => setTimeout(r, 250));
    }
    ck('상승 단계 진입', st.body?.round?.phase === 'running', String(st.body?.round?.phase));

    const outs = await Promise.all(Array.from({ length: 15 }, () =>
      req('POST', '/api/games/crash/cashout', c, {})));
    const okOuts = outs.filter(r => r.body?.ok);
    ck('15번 중 최대 1번만 지급', okOuts.length <= 1, `성공 ${okOuts.length}회`);
    if (okOuts.length === 1) {
      const payout = okOuts[0].body.payout;
      ck('지급액이 잔액에 정확히 한 번만 반영', bal('x_cash') === 700 + payout, `${bal('x_cash')} vs ${700 + payout}`);
    }
  }

  /* ── 4. 포커: 칩 쌓기 동시 연타 ────────────────────────────────── */
  section('[4] 포커 — 칩 쌓기 동시 연타 (누적 차감 정확성)');
  {
    const c = mkSession('x_poker', 10000);
    let st = await req('GET', '/api/games/poker/state', c);
    for (let i = 0; i < 60 && st.body?.round?.phase !== 'betting'; i++) {
      await new Promise(r => setTimeout(r, 500));
      st = await req('GET', '/api/games/poker/state', c);
    }
    const roundId = st.body?.round?.id;
    ck('베팅 창 확보', st.body?.round?.phase === 'betting', String(st.body?.round?.phase));

    const N = 20, CHIP = 100;
    const results = await Promise.all(Array.from({ length: N }, () =>
      req('POST', '/api/games/poker/bet', c, { market: 'master', amount: CHIP })));
    const okCount = results.filter(r => r.body?.ok).length;
    ck(`${N}번 모두 성공 (칩 쌓기는 누적이 정상)`, okCount === N, `성공 ${okCount}회`);
    ck(`차감이 정확히 ${okCount * CHIP}P`, bal('x_poker') === 10000 - okCount * CHIP, String(bal('x_poker')));

    // 회수와 추가 베팅을 동시에 — 환불이 두 번 되면 여기서 잔액이 튄다
    const mixed = await Promise.all([
      req('POST', '/api/games/poker/clear', c, {}),
      req('POST', '/api/games/poker/clear', c, {}),
      req('POST', '/api/games/poker/clear', c, {}),
    ]);
    const clears = mixed.filter(r => r.body?.ok).length;
    ck('동시 회수 중 1번만 성공', clears === 1, `성공 ${clears}회`);
    ck('회수 후 잔액 정확히 복원 (10000)', bal('x_poker') === 10000, String(bal('x_poker')));
  }

  /* ── 5. 지뢰찾기: 동시 시작 / 동시 캐시아웃 ───────────────────── */
  section('[5] 지뢰찾기 — 동시 시작 · 동시 캐시아웃');
  {
    const c = mkSession('x_mines', 1000);
    const starts = await Promise.all(Array.from({ length: 10 }, () =>
      req('POST', '/api/games/mines/start', c, { betAmount: 200, mineCount: 3 })));
    const okStarts = starts.filter(r => r.body?.ok).length;
    ck('동시 시작 중 1번만 성공 (1인 1라운드)', okStarts === 1, `성공 ${okStarts}회`);
    ck('차감은 200P 한 번만', bal('x_mines') === 800, String(bal('x_mines')));

    await req('POST', '/api/games/mines/reveal', c, { tile: 0 });
    const outs = await Promise.all(Array.from({ length: 10 }, () =>
      req('POST', '/api/games/mines/cashout', c, {})));
    const okOuts = outs.filter(r => r.body?.ok).length;
    ck('동시 캐시아웃 중 최대 1번만 지급', okOuts <= 1, `성공 ${okOuts}회`);
  }

  /* ── 6. 라운드 진행 경합 ──────────────────────────────────────── */
  section('[6] 라운드 진행 — 동시 폴링으로 라운드가 중복 생성되지 않는지');
  {
    const c = mkSession('x_poll', 100);
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM ladder_rounds`).get() as any).n;
    await Promise.all(Array.from({ length: 30 }, () => req('GET', '/api/games/ladder/state', c)));
    const after = (db.prepare(`SELECT COUNT(*) AS n FROM ladder_rounds`).get() as any).n;
    ck('동시 폴링 30회가 라운드를 중복 생성하지 않음', after - before <= 1, `${before} → ${after}`);
  }

  /* ── 7. 서버 전진이 도는 중에 사람이 조작한다 ──────────────────── */
  /* 여기까지의 검사는 전부 "요청끼리" 겹칠 때를 봤다. 서버 전진(src/tick.ts)이 생기면서
     겹치는 상대가 하나 늘었다 — 아무도 안 불렀는데 라운드를 닫는 타이머다.
     node:sqlite 는 동기이고 Node 는 단일 스레드라 트랜잭션이 서로의 사이에 끼어들 수는
     없다. 그러니 여기서 묻는 것은 "동시에 쓰는가"가 아니라 순서다:
       베팅이 마감되는 그 순간에 들어온 베팅이 어떻게 되는가.
     예전에는 그 베팅을 보낸 사람의 요청이 직접 라운드를 닫았다. 지금은 타이머가 먼저
     닫아 놓았을 수 있다. 결과는 같아야 하지만 — 확인은 안 했으므로 여기서 한다.

     그래서 마감 시각을 DB 에서 직접 읽어(HTTP 를 안 거쳐야 시각이 안 흐트러진다)
     그 경계에 베팅을 몰아넣는다. */
  section('[7] 서버 전진 × 사람 — 마감 경계에 요청을 밀어 넣는다');
  {
    const T = require('../src/tick') as typeof import('../src/tick');
    const cs = ['r1', 'r2', 'r3', 'r4'].map(n => mkSession('x_' + n, 200_000));

    const crashDone0 = (db.prepare(
      `SELECT COUNT(*) AS n FROM crash_rounds WHERE phase='done'`).get() as any).n;
    const ladderDone0 = (db.prepare(
      `SELECT COUNT(*) AS n FROM ladder_rounds WHERE phase='done'`).get() as any).n;

    T.startTicks();
    const t0 = Date.now();
    let shots = 0;
    const burst = { crash_rounds: 0, ladder_rounds: 0 };
    const fired = new Set<string>();   // 라운드마다 한 번만 몰아넣는다

    /* 경계 사격 — 마감 시각 직전 80ms 안에 들어오면 네 명이 동시에 베팅한다. */
    const sniper = setInterval(() => {
      /* 그래프 한 판의 상승 시간은 크래시 지점에 달려 있어 10초가 될 수도, 40초가 될
         수도 있다. 그대로 두면 "정해진 시간 안에 두 판이 끝나는가"가 운에 좌우되어
         같은 코드가 통과했다 실패했다 한다(대회 검사에서 블라인드를 당긴 것과 같은
         이유다). 규칙은 그대로 두고 시계만 당긴다 — 새로 열린 판의 크래시 지점을
         낮춰 상승을 짧게 만든다. 이 검사가 보려는 것은 상승이 아니라 베팅 마감
         경계이고, 마감은 크래시 지점과 무관하게 열린 지 10초 뒤다.
         상승 중인 판까지 당긴다 — 앞 구간에서 넘어온 판은 지점이 높을 수 있고, 그것
         하나가 40초를 끌면 이 검사 전체의 소요가 운에 좌우된다(실제로 한 번은 40초에,
         한 번은 75초를 다 쓰고 끝났다). */
      db.prepare(`UPDATE crash_rounds SET crash_point = 1.35
                   WHERE phase != 'done' AND crash_point > 1.35`).run();

      for (const [table, path, body] of [
        ['crash_rounds', '/api/games/crash/bet', { betAmount: 500 }],
        ['ladder_rounds', '/api/games/ladder/bet', { startGuess: 'L', betAmount: 500 }],
      ] as const) {
        const r = db.prepare(
          `SELECT id, phase, betting_ends_at FROM ${table} ORDER BY id DESC LIMIT 1`).get() as
          { id: number; phase: string; betting_ends_at: number } | undefined;
        if (!r || r.phase !== 'betting') continue;
        const leftMs = r.betting_ends_at * 1000 - Date.now();
        const key = table + r.id;
        if (leftMs > 80 || leftMs < -400 || fired.has(key)) continue;
        fired.add(key); burst[table]++;
        for (const c of cs) { shots++; void req('POST', path, c, body).catch(() => {}); }
        for (const c of cs) { shots++; void req('POST', '/api/games/crash/cashout', c, {}).catch(() => {}); }
      }
    }, 20);

    /* 그 사이 꾸준한 잡음도 깔아 둔다 — 경계가 아닌 시각에 들어오는 평범한 요청이
       타이머와 겹칠 때도 봐야 한다. */
    /* 지각생 — 경계 사격에는 안 끼는 사람들이다.
       위의 넷은 베팅 창에서 이미 한 번씩 걸어 두었으므로, 판이 닫힌 뒤에 또 걸어도
       "이미 베팅함"에 먼저 막힌다. 그 막힘 때문에 정작 보려던 것 — 닫힌 판에 새 베팅이
       꽂히는가 — 을 못 본다(실제로 방어를 두 겹 다 빼고 돌려도 안 잡혔다).
       그래서 그 판에 발을 안 담근 사람을 따로 둔다. */
    const late = ['l1', 'l2', 'l3', 'l4'].map(n => mkSession('x_' + n, 200_000));
    const lateFired = new Set<number>();

    const noise = setInterval(() => {
      const c = cs[shots % cs.length];
      shots += 2;
      void req('POST', '/api/games/crash/cashout', c, {}).catch(() => {});
      void req('GET', '/api/games/crash/state', c).catch(() => {});

      /* 이미 끝난 판에 베팅을 밀어 넣는다. 막히는 것이 정상이고, 뚫리면 그 돈은
         정산이 끝난 판에 얹혀 영영 정산되지 않는다 — 아래 (a)가 그것을 본다. */
      const r = db.prepare(`SELECT id, phase FROM crash_rounds ORDER BY id DESC LIMIT 1`)
        .get() as { id: number; phase: string } | undefined;
      if (r && r.phase === 'done' && !lateFired.has(r.id)) {
        lateFired.add(r.id);
        for (const lc of late) {
          shots++;
          void req('POST', '/api/games/crash/bet', lc, { betAmount: 300 }).catch(() => {});
        }
      }
    }, 120);

    /* 크래시 지점을 당겼으므로 한 판은 베팅 10초 + 상승 약 1초 + 공개 3초다.
       두 판이 마감되고 두 번의 경계를 통과할 때까지 기다린다. */
    while (Date.now() - t0 < 75_000) {
      await new Promise(r => setTimeout(r, 500));
      const cd = (db.prepare(`SELECT COUNT(*) AS n FROM crash_rounds WHERE phase='done'`)
        .get() as any).n - crashDone0;
      const ld = (db.prepare(`SELECT COUNT(*) AS n FROM ladder_rounds WHERE phase='done'`)
        .get() as any).n - ladderDone0;
      if (process.env.TICK_TRACE) console.log(`    …${((Date.now() - t0) / 1000).toFixed(0)}초`
        + ` 마감 그래프${cd}/사다리${ld} · 경계 그래프${burst.crash_rounds}/사다리${burst.ladder_rounds}`);
      if (cd >= 2 && ld >= 2 && burst.crash_rounds >= 2 && burst.ladder_rounds >= 2) break;
    }
    clearInterval(sniper); clearInterval(noise);
    T.stopTicks();
    await new Promise(r => setTimeout(r, 800));   // 날아가던 요청이 끝나기를 기다린다

    const crashDone = (db.prepare(`SELECT COUNT(*) AS n FROM crash_rounds WHERE phase='done'`)
      .get() as any).n - crashDone0;
    const ladderDone = (db.prepare(`SELECT COUNT(*) AS n FROM ladder_rounds WHERE phase='done'`)
      .get() as any).n - ladderDone0;

    /* 이 검사가 실제로 무언가를 통과했는지부터 본다. 라운드가 안 돌았는데 통과하면
       아래 불변식들은 "아무 일도 없었다"를 확인한 것에 지나지 않는다. */
    ck('타이머가 라운드를 마감했다 (그래프 ≥2)', crashDone >= 2, `${crashDone}판`);
    ck('타이머가 라운드를 마감했다 (사다리 ≥2)', ladderDone >= 2, `${ladderDone}판`);
    ck('그래프 마감 경계에 요청을 밀어 넣었다', burst.crash_rounds >= 2,
      `${burst.crash_rounds}번`);
    ck('사다리 마감 경계에 요청을 밀어 넣었다', burst.ladder_rounds >= 2,
      `${burst.ladder_rounds}번`);
    console.log(`    (${((Date.now() - t0) / 1000).toFixed(0)}초 동안 요청 ${shots}건)`);

    /* (a) 삼켜진 베팅이 없는가 — 가장 걱정한 경우다.
       타이머가 라운드를 닫은 직후에 베팅이 들어와 통과해 버리면, 돈은 빠져나갔는데
       그 라운드는 이미 정산이 끝나 영영 정산되지 않는다. 끝난 라운드에 payout 이
       비어 있는 베팅이 하나라도 있으면 그것이다. */
    const stuckC = (db.prepare(
      `SELECT COUNT(*) AS n FROM crash_bets b JOIN crash_rounds r ON r.id = b.round_id
        WHERE r.phase = 'done' AND b.payout IS NULL`).get() as any).n;
    ck('끝난 그래프 라운드에 정산 안 된 베팅이 없다', stuckC === 0, `${stuckC}건`);
    const stuckL = (db.prepare(
      `SELECT COUNT(*) AS n FROM ladder_bets b JOIN ladder_rounds r ON r.id = b.round_id
        WHERE r.phase = 'done' AND b.won IS NULL`).get() as any).n;
    ck('끝난 사다리 라운드에 정산 안 된 베팅이 없다', stuckL === 0, `${stuckL}건`);

    /* (b) 원장과 베팅표가 서로 맞는가.
       차감만 되고 베팅이 안 꽂히거나(돈만 사라짐), 베팅은 꽂혔는데 차감이 없으면(공짜 베팅)
       여기서 어긋난다. 취소는 환불로 되돌아가고 행이 지워지므로 빼 준다. */
    const sum = (q: string, ...a: any[]) =>
      (db.prepare(q).get(...a) as any).n as number;
    for (const [game, betTable, betReason, cancelReason, payReason] of [
      ['그래프', 'crash_bets', 'game:graph:bet', 'game:graph:cancel', 'game:graph'],
      ['사다리', 'ladder_bets', 'game:ladder:bet', 'game:ladder:cancel', 'game:ladder'],
    ] as const) {
      const debit = -sum(`SELECT COALESCE(SUM(delta),0) AS n FROM points_ledger WHERE reason=?`, betReason);
      const refund = sum(`SELECT COALESCE(SUM(delta),0) AS n FROM points_ledger WHERE reason=?`, cancelReason);
      const staked = sum(`SELECT COALESCE(SUM(amount),0) AS n FROM ${betTable}`);
      ck(`${game}: 차감 − 환불 = 베팅표 합`, debit - refund === staked,
        `${debit} − ${refund} ≠ ${staked}`);
      const paidLedger = sum(`SELECT COALESCE(SUM(delta),0) AS n FROM points_ledger WHERE reason=?`, payReason);
      const paidTable = sum(`SELECT COALESCE(SUM(payout),0) AS n FROM ${betTable} WHERE payout IS NOT NULL`);
      ck(`${game}: 지급 원장 = 베팅표 지급 합 (이중 지급 없음)`, paidLedger === paidTable,
        `${paidLedger} ≠ ${paidTable}`);
    }

    /* (c) 한 라운드에 같은 사람이 두 번 들어가지 않았는가 — 경계에서 4명이 동시에
       쏘았으므로 "이미 베팅함" 검사가 타이머와 겹쳐도 버텨야 한다. */
    const dupC = (db.prepare(
      `SELECT COUNT(*) AS n FROM (SELECT round_id, user_id FROM crash_bets
         GROUP BY round_id, user_id HAVING COUNT(*) > 1)`).get() as any).n;
    ck('그래프: 한 라운드에 같은 사람이 두 번 안 들어갔다', dupC === 0, `${dupC}건`);
    const dupL = (db.prepare(
      `SELECT COUNT(*) AS n FROM (SELECT round_id, user_id FROM ladder_bets
         GROUP BY round_id, user_id HAVING COUNT(*) > 1)`).get() as any).n;
    ck('사다리: 한 라운드에 같은 사람이 두 번 안 들어갔다', dupL === 0, `${dupL}건`);
  }

  section('[8] 최종 원장 정합성');
  ck('모든 유저: 잔액 = 원장 누적합', ledgerOk());
  const neg = (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE balance < 0`).get() as any).n;
  ck('음수 잔액 없음', neg === 0, `${neg}명`);

  console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
