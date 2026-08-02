// 엔드투엔드 감사 — 실제 세션으로 네 게임을 라운드 끝까지 플레이한다.
// 특히 "아직 공개되면 안 되는 정보가 응답에 새지 않는가"를 본다. 이게 새면 게임이 성립하지 않는다.

// 감사는 항상 일회용 DB에서 돈다. DB_PATH를 지정하지 않고 실행해도 로컬/운영 데이터를 건드리지 않게
// 여기서 임시 경로로 못 박는다(첫 import보다 먼저 실행되어야 하므로 파일 맨 위에 둔다).
if (!process.env.DB_PATH) {
  const os = require('node:os'), path = require('node:path'), fsx = require('node:fs');
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'casino-audit-'));
  process.env.DB_PATH = dir;
}

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { getDb } from '../src/db/schema';
import { upsertUser, adjustBalance, getWebUser, createSession } from '../src/db/queries';

const PORT = Number(process.env.AUDIT_PORT ?? 8213);
let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
function section(s: string): void { console.log('\n' + s); }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Res { status: number; body: any; text: string }
function req(method: string, path: string, cookie: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: PORT, path, method,
      headers: { cookie, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
    }, res => {
      const c: Buffer[] = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        const text = Buffer.concat(c).toString('utf8');
        let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* html */ }
        resolve({ status: res.statusCode ?? 0, body: parsed, text });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
function mkSession(id: string, start: number): string {
  upsertUser(id, 'E2E' + id, null);
  const cur = getWebUser(id)?.balance ?? 0;
  if (cur !== start) adjustBalance(id, start - cur, 'test:seed');
  const t = randomBytes(16).toString('hex');
  createSession(t, id, Math.floor(Date.now() / 1000) + 3600);
  return 'sid=' + t;
}
const bal = (id: string) => getWebUser(id)!.balance;
const db = getDb();

// 특정 phase가 될 때까지 폴링 (최대 maxMs)
async function waitPhase(path: string, cookie: string, want: string | ((p: string) => boolean), maxMs = 45000) {
  const test = typeof want === 'string' ? (p: string) => p === want : want;
  const t0 = Date.now();
  let last: any = null;
  while (Date.now() - t0 < maxMs) {
    const r = await req('GET', path, cookie);
    last = r.body;
    if (last?.round?.phase && test(last.round.phase)) return last;
    await sleep(200);
  }
  return last;
}

async function main(): Promise<void> {
  const { startWebServer } = require('../src/web/server') as typeof import('../src/web/server');
  process.env.PORT = String(PORT);
  startWebServer();
  await sleep(600);

  /* ── 사다리 한 라운드 완주 ─────────────────────────────────── */
  section('[1] 사다리 — 베팅부터 정산까지 한 라운드 완주');
  {
    const c = mkSession('e_lad', 5000);
    const st = await waitPhase('/api/games/ladder/state', c, 'betting');
    ck('베팅 단계 진입', st?.round?.phase === 'betting', String(st?.round?.phase));
    ck('베팅 중에는 결과가 응답에 없음',
      st.round.startSide == null && st.round.endSide == null,
      JSON.stringify({ s: st.round.startSide, e: st.round.endSide }));
    ck('베팅 중에는 가로줄(rungs)도 없음', st.round.rungs == null, JSON.stringify(st.round.rungs));

    const before = bal('e_lad');
    const bet = await req('POST', '/api/games/ladder/bet', c, { betAmount: 500, startGuess: 'L' });
    ck('베팅 수락', bet.body?.ok === true, JSON.stringify(bet.body));
    ck('응답 잔액 = DB 잔액', bet.body?.balance === bal('e_lad'), `${bet.body?.balance} vs ${bal('e_lad')}`);
    ck('정확히 500P 차감', before - bal('e_lad') === 500, String(before - bal('e_lad')));

    const done = await waitPhase('/api/games/ladder/state', c, 'done');
    ck('정산 단계 도달', done?.round?.phase === 'done', String(done?.round?.phase));
    ck('정산 후에는 결과가 공개됨', done.round.startSide != null && done.round.endSide != null);
    const myBet = done.myBet;
    ck('내 베팅 결과가 내려옴', myBet != null && (myBet.won === 0 || myBet.won === 1), JSON.stringify(myBet));
    const expected = before - 500 + (myBet?.payout ?? 0);
    ck(`지급 반영 정확 (적중=${myBet?.won}, 지급=${myBet?.payout})`, bal('e_lad') === expected,
      `${bal('e_lad')} vs ${expected}`);
    ck('적중 시 배당이 1.95배 내림', myBet?.won !== 1 || myBet.payout === Math.floor(500 * 1.95),
      String(myBet?.payout));
  }

  /* ── 그래프 한 라운드 완주 ─────────────────────────────────── */
  section('[2] 그래프 — 베팅→상승→캐시아웃');
  {
    const c = mkSession('e_crash', 5000);
    const st = await waitPhase('/api/games/crash/state', c, 'betting');
    ck('베팅 단계 진입', st?.round?.phase === 'betting', String(st?.round?.phase));
    ck('베팅 중 크래시 지점 비공개', st.round.crashPoint == null && st.round.crash_point == null,
      JSON.stringify(st.round));

    const before = bal('e_crash');
    const bet = await req('POST', '/api/games/crash/bet', c, { betAmount: 400 });
    ck('베팅 수락 + 차감', bet.body?.ok === true && before - bal('e_crash') === 400, String(before - bal('e_crash')));

    const running = await waitPhase('/api/games/crash/state', c, 'running');
    ck('상승 단계 진입', running?.round?.phase === 'running', String(running?.round?.phase));
    ck('상승 중에도 크래시 지점 비공개',
      running.round.crashPoint == null && running.round.crash_point == null, JSON.stringify(running.round));

    const out = await req('POST', '/api/games/crash/cashout', c, {});
    if (out.body?.ok) {
      ck('캐시아웃 지급 = floor(400 × 배율)', out.body.payout === Math.floor(400 * out.body.multiplier),
        `${out.body.payout} vs ${Math.floor(400 * out.body.multiplier)}`);
      ck('캐시아웃 후 잔액 정확', bal('e_crash') === before - 400 + out.body.payout, String(bal('e_crash')));
    } else {
      ck('캐시아웃 실패 시 이유가 명확 (이미 터짐)', typeof out.body?.error === 'string', JSON.stringify(out.body));
      ck('실패 시 잔액 변화 없음', bal('e_crash') === before - 400, String(bal('e_crash')));
    }

    const done = await waitPhase('/api/games/crash/state', c, 'done');
    ck('종료 후 크래시 지점 공개', (done.round.crashPoint ?? done.round.crash_point) != null, JSON.stringify(done.round));
  }

  /* ── 포커 한 라운드 완주 (카드 은닉이 핵심) ────────────────── */
  section('[3] 포커 — 보드 카드가 공개 전에 새지 않는가');
  {
    const c = mkSession('e_poker', 20000);
    const st = await waitPhase('/api/games/poker/state', c, 'betting');
    ck('베팅 단계 진입', st?.round?.phase === 'betting', String(st?.round?.phase));
    ck('베팅 중 보드 0장', Array.isArray(st.round.board) && st.round.board.length === 0,
      JSON.stringify(st.round.board));
    ck('홀카드 4장은 공개됨', Array.isArray(st.round.hole) && st.round.hole.length === 4,
      JSON.stringify(st.round.hole));
    ck('응답 어디에도 미공개 보드가 없음',
      !JSON.stringify(st).includes('board_json') && !JSON.stringify(st).includes('result_json'));

    const before = bal('e_poker');
    const b1 = await req('POST', '/api/games/poker/bet', c, { market: 'master', amount: 1000 });
    ck('칩 베팅 수락 + 차감', b1.body?.ok === true && before - bal('e_poker') === 1000, String(before - bal('e_poker')));

    const flop = await waitPhase('/api/games/poker/state', c, p => p === 'flop' || p === 'turn' || p === 'river' || p === 'done');
    if (flop?.round?.phase === 'flop') {
      ck('플롭에서 정확히 3장만 공개', flop.round.board.length === 3, String(flop.round.board.length));
    } else {
      ck('플롭 단계를 지나침(빠른 진행) — 공개 장수는 단계와 일치', [3, 4, 5].includes(flop.round.board.length),
        `${flop.round.phase}/${flop.round.board.length}`);
    }
    const turn = await waitPhase('/api/games/poker/state', c, p => p === 'turn' || p === 'river' || p === 'done');
    ck('턴 이후 4장 이상', turn.round.board.length >= 4, String(turn.round.board.length));

    const done = await waitPhase('/api/games/poker/state', c, 'done');
    ck('정산 단계 도달', done?.round?.phase === 'done', String(done?.round?.phase));
    ck('정산 시 보드 5장 전부 공개', done.round.board.length === 5, String(done.round.board.length));
    ck('결과에 승자가 있음', ['master', 'shark', 'tie'].includes(done.round.result?.winner), JSON.stringify(done.round.result));

    const myBets = db.prepare(`SELECT market, amount, odds, won, payout FROM poker_bets
      WHERE round_id = ? AND user_id = 'e_poker'`).all(done.round.id) as any[];
    if (myBets.length) {
      const m = myBets[0];
      const w = done.round.result.winner;
      const want = w === 'tie' ? m.amount : w === 'master' ? Math.floor(m.amount * m.odds) : 0;
      ck(`정산 지급 규칙 일치 (승자 ${w} → ${want})`, m.payout === want, `${m.payout} vs ${want}`);
      ck('잔액 반영 정확', bal('e_poker') === before - 1000 + m.payout, String(bal('e_poker')));
    } else {
      ck('내 베팅이 라운드에 남아 있음', false, '베팅 행 없음');
    }
  }

  /* ── 지뢰찾기: 지뢰 위치 은닉 ──────────────────────────────── */
  section('[4] 지뢰찾기 — 지뢰 위치가 새지 않는가');
  {
    const c = mkSession('e_mines', 5000);
    const before = bal('e_mines');
    const start = await req('POST', '/api/games/mines/start', c, { betAmount: 500, mineCount: 1 });
    ck('시작 + 차감', start.body?.ok === true && before - bal('e_mines') === 500, JSON.stringify(start.body?.error));
    const s = JSON.stringify(start.body);
    ck('시작 응답에 지뢰 위치 없음', !s.includes('mines"') || !/\"mines\":\[/.test(s), s.slice(0, 200));
    ck('시작 응답에 지뢰 배열이 통째로 없음', !/\[(\d+,){2,}\d+\]/.test(s.replace(/"revealed":\[[^\]]*\]/, '')), s.slice(0, 200));

    // 지뢰 1개짜리로 여러 칸을 열어 본다. 살아 있는 동안에는 절대 minePositions가 오면 안 되고,
    // 터진 뒤에 오는 건 정상이다(그 시점엔 이미 결과가 확정됐다).
    let busted = false, safeReveals = 0, leaked = false;
    for (let tile = 0; tile < 8 && !busted; tile++) {
      const rev = await req('POST', '/api/games/mines/reveal', c, { tile });
      if (rev.status !== 200) break;
      busted = rev.body?.busted === true || rev.body?.round?.status === 'settled';
      const hasPositions = rev.body?.round?.minePositions != null;
      if (!busted) { safeReveals++; if (hasPositions) leaked = true; }
      else ck('터진 뒤에는 지뢰 위치를 공개 (결과 확정 후이므로 정상)', hasPositions, JSON.stringify(rev.body?.round));
    }
    ck(`진행 중에는 지뢰 위치 비공개 (안전하게 연 칸 ${safeReveals}개)`, !leaked, '진행 중 유출');

    if (!busted) {
      const out = await req('POST', '/api/games/mines/cashout', c, {});
      ck('캐시아웃 성공', out.body?.ok === true, JSON.stringify(out.body));
      if (out.body?.ok) {
        // 지뢰찾기는 지급액을 round 안에 담아 보낸다 (다른 게임처럼 최상위가 아니다)
        const payout = out.body.round?.payout;
        ck('응답에 지급액이 들어 있음', typeof payout === 'number', JSON.stringify(out.body.round));
        ck('지급 후 잔액 = 시작잔액 - 500 + 지급',
          bal('e_mines') === before - 500 + (payout ?? -1), `${bal('e_mines')} vs ${before - 500 + (payout ?? -1)}`);
        ck('응답 잔액 = DB 잔액', out.body.balance === bal('e_mines'), `${out.body.balance} vs ${bal('e_mines')}`);
      }
    } else {
      ck('폭발 시 잔액은 베팅 차감분만 (추가 손실 없음)', bal('e_mines') === before - 500, String(bal('e_mines')));
      const out = await req('POST', '/api/games/mines/cashout', c, {});
      ck('폭발한 라운드는 캐시아웃 불가', out.body?.ok !== true, JSON.stringify(out.body));
      ck('캐시아웃 시도 후에도 잔액 그대로', bal('e_mines') === before - 500, String(bal('e_mines')));
    }
  }

  /* ── 원장 최종 확인 ────────────────────────────────────────── */

  /* ── 바카라: 카드 은닉과 정산 ──────────────────────────────── */
  section('[5] 바카라 — 카드가 공개 전에 새지 않는가');
  {
    const c = mkSession('e_bacc', 20000);
    const st = await waitPhase('/api/games/baccarat/state', c, 'betting');
    ck('베팅 단계 진입', st?.round?.phase === 'betting', String(st?.round?.phase));
    ck('베팅 중 양쪽 카드 0장',
      st.round.player.length === 0 && st.round.banker.length === 0,
      JSON.stringify([st.round.player, st.round.banker]));
    ck('베팅 중 끗수 비공개', st.round.playerTotal == null && st.round.bankerTotal == null,
      JSON.stringify([st.round.playerTotal, st.round.bankerTotal]));
    ck('응답에 원본 카드 배열이 없음',
      !JSON.stringify(st).includes('cards_json') && !JSON.stringify(st).includes('result_json'));

    const before = bal('e_bacc');
    const b1 = await req('POST', '/api/games/baccarat/bet', c, { market: 'banker', amount: 1000 });
    ck('칩 베팅 수락 + 차감', b1.body?.ok === true && before - bal('e_bacc') === 1000, JSON.stringify(b1.body));
    ck('응답 잔액 = DB 잔액', b1.body?.balance === bal('e_bacc'), `${b1.body?.balance} vs ${bal('e_bacc')}`);

    const deal = await waitPhase('/api/games/baccarat/state', c, p => p !== 'betting');
    if (deal?.round?.phase === 'deal') {
      ck('첫 공개는 양쪽 두 장씩', deal.round.player.length === 2 && deal.round.banker.length === 2,
        JSON.stringify([deal.round.player.length, deal.round.banker.length]));
      ck('첫 두 장 끗수는 바로 공개', deal.round.playerTotal != null && deal.round.bankerTotal != null);
      ck('첫 두 장 끗수는 0~9', deal.round.playerTotal >= 0 && deal.round.playerTotal <= 9);
    } else {
      ck('공개 단계 진입 (deal을 지나침)', ['third', 'done'].includes(deal.round.phase), String(deal.round.phase));
    }

    const done = await waitPhase('/api/games/baccarat/state', c, 'done');
    ck('정산 단계 도달', done?.round?.phase === 'done', String(done?.round?.phase));
    const r = done.round.result;
    ck('결과에 승자가 있음', ['player', 'banker', 'tie'].includes(r?.winner), JSON.stringify(r));
    ck('양쪽 카드는 2장 또는 3장',
      [2, 3].includes(done.round.player.length) && [2, 3].includes(done.round.banker.length),
      JSON.stringify([done.round.player.length, done.round.banker.length]));
    ck('내추럴이면 세 장이 될 수 없다',
      !r.natural || (done.round.player.length === 2 && done.round.banker.length === 2),
      `natural=${r.natural} ${done.round.player.length}/${done.round.banker.length}`);
    ck('승자와 끗수가 일치',
      (r.playerTotal > r.bankerTotal && r.winner === 'player') ||
      (r.bankerTotal > r.playerTotal && r.winner === 'banker') ||
      (r.playerTotal === r.bankerTotal && r.winner === 'tie'),
      `${r.playerTotal}:${r.bankerTotal} → ${r.winner}`);

    const myBets = db.prepare(`SELECT market, amount, odds, won, payout FROM baccarat_bets
      WHERE round_id = ? AND user_id = 'e_bacc'`).all(done.round.id) as any[];
    ck('내 베팅이 라운드에 남아 있음', myBets.length === 1, JSON.stringify(myBets));
    if (myBets.length) {
      const m = myBets[0];
      const want = r.winner === 'tie' ? m.amount
        : r.winner === 'banker' ? Math.floor(m.amount * m.odds) : 0;
      ck(`정산 지급 규칙 일치 (승자 ${r.winner} → ${want})`, m.payout === want, `${m.payout} vs ${want}`);
      ck('잔액 반영 정확', bal('e_bacc') === before - 1000 + m.payout, String(bal('e_bacc')));
    }
  }

  section('[6] 최종 원장 정합성');
  {
    const users = db.prepare(`SELECT id, balance FROM users`).all() as any[];
    let bad = '';
    for (const u of users) {
      const s = (db.prepare(`SELECT COALESCE(SUM(delta),0) AS s FROM points_ledger WHERE user_id = ?`).get(u.id) as any).s;
      if (s !== u.balance) bad += `${u.id}(${s}≠${u.balance}) `;
    }
    ck(`잔액 = 원장 누적합 (${users.length}명)`, bad === '', bad);
    const neg = (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE balance < 0`).get() as any).n;
    ck('음수 잔액 없음', neg === 0, String(neg));
  }

  console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
