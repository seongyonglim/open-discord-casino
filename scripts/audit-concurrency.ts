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

  section('[7] 최종 원장 정합성');
  ck('모든 유저: 잔액 = 원장 누적합', ledgerOk());
  const neg = (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE balance < 0`).get() as any).n;
  ck('음수 잔액 없음', neg === 0, `${neg}명`);

  console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
