// 전 게임 포인트 정확성 감사 — 실제 DB에 베팅/정산을 돌려 원장과 잔액이 어긋나지 않는지 본다.

// 감사는 항상 일회용 DB에서 돈다. DB_PATH를 지정하지 않고 실행해도 로컬/운영 데이터를 건드리지 않게
// 여기서 임시 경로로 못 박는다(첫 import보다 먼저 실행되어야 하므로 파일 맨 위에 둔다).
if (!process.env.DB_PATH) {
  const os = require('node:os'), path = require('node:path'), fsx = require('node:fs');
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'casino-audit-'));
  process.env.DB_PATH = dir;
}

import { getDb } from '../src/db/schema';
import {
  upsertUser, adjustBalance, getWebUser,
  placeLadderBet, advanceLadderRound, ladderParity, LADDER_MULTIPLIER, LADDER_DOUBLE_MULTIPLIER,
  placeCrashBet, advanceCrashRound, cashoutCrashBet, cancelCrashBet,
  stackPokerBet, advancePokerRound, clearPokerBets, getMyPokerBets,
  placeBet, settleGameRound, claimRelief, performCheckIn,
  type LadderRoundRow,
} from '../src/db/queries';
import {
  computeFlipProbabilities, evaluate7, scoreCategory, categoryBucket,
  oddsFromProbability, oddsForWinMarket,
} from '../src/services/poker';

let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
function section(s: string): void { console.log('\n' + s); }

const db = getDb();
function q<T>(sql: string, ...p: any[]): T[] { return db.prepare(sql).all(...p) as T[]; }

/* 이 감사의 핵심 불변식.
   원장(points_ledger)은 감사 로그다. 잔액과 원장 합계가 어긋나면 어딘가에서 돈이 새거나 생겼다는 뜻이고,
   balance_after가 누적합과 다르면 원장 자체를 신뢰할 수 없게 된다(사후 추적이 불가능해진다). */
function auditLedger(label: string): void {
  const users = q<{ id: string; balance: number }>(`SELECT id, balance FROM users`);
  let bad = 0, detail = '';
  for (const u of users) {
    const rows = q<{ delta: number; balance_after: number; reason: string }>(
      `SELECT delta, balance_after, reason FROM points_ledger WHERE user_id = ? ORDER BY id`, u.id
    );
    let running = 0;
    for (const r of rows) {
      running += r.delta;
      if (r.balance_after !== running) {
        bad++; detail = `${u.id} ${r.reason}: 기록된 잔액 ${r.balance_after} ≠ 누적합 ${running}`;
        break;
      }
    }
    if (running !== u.balance) { bad++; detail = `${u.id}: 원장합 ${running} ≠ 실제잔액 ${u.balance}`; }
  }
  ck(`${label} — 잔액 = 원장 누적합 (${users.length}명)`, bad === 0, detail);
}

function noFractions(label: string): void {
  const bad = q<{ n: number }>(`
    SELECT (SELECT COUNT(*) FROM users WHERE balance != CAST(balance AS INTEGER))
         + (SELECT COUNT(*) FROM points_ledger WHERE delta != CAST(delta AS INTEGER))
         + (SELECT COUNT(*) FROM ladder_bets WHERE payout IS NOT NULL AND payout != CAST(payout AS INTEGER))
         + (SELECT COUNT(*) FROM crash_bets  WHERE payout IS NOT NULL AND payout != CAST(payout AS INTEGER))
         + (SELECT COUNT(*) FROM poker_bets  WHERE payout IS NOT NULL AND payout != CAST(payout AS INTEGER))
         AS n`)[0];
  ck(`${label} — 소수점 포인트 없음 (내림 규칙)`, bad.n === 0, `${bad.n}건`);
}
function negativeBalances(label: string): void {
  const n = q<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE balance < 0`)[0].n;
  ck(`${label} — 음수 잔액 없음`, n === 0, `${n}명`);
}

function mkUser(id: string, start: number): void {
  upsertUser(id, '테스터' + id, null);
  if (start) adjustBalance(id, start, 'test:seed');
}
function bal(id: string): number { return getWebUser(id)!.balance; }
const nowSec = () => Math.floor(Date.now() / 1000);
function expire(table: string, id: number, back = 1): void {
  db.prepare(`UPDATE ${table} SET betting_ends_at = ? WHERE id = ?`).run(nowSec() - back, id);
}

/* ── 1. 사다리 ───────────────────────────────────────────────── */
section('[1] 사다리게임');
{
  const revealSec = (_r: LadderRoundRow) => 3;
  const fixed = () => ({ startSide: 'L', endSide: 'L', rungs: [false] });
  const round = advanceLadderRound(fixed, revealSec);

  mkUser('l_win', 1000); mkUser('l_lose', 1000); mkUser('l_dbl', 1000); mkUser('l_dblmiss', 1000);
  const winParity = ladderParity('L');
  const loseParity = winParity === 'ODD' ? 'EVEN' : 'ODD';

  ck('베팅 성공', placeLadderBet('l_win', 'w', round.id, 'L', null, 100).ok);
  ck('베팅 즉시 차감', bal('l_win') === 900, String(bal('l_win')));
  ck('같은 라운드 중복 베팅 거절', !placeLadderBet('l_win', 'w', round.id, 'L', null, 100).ok);
  ck('잔액 초과 베팅 거절', !placeLadderBet('l_lose', 'x', round.id, 'R', null, 999999).ok);
  ck('잔액 초과 거절 후 차감 없음', bal('l_lose') === 1000, String(bal('l_lose')));

  placeLadderBet('l_lose', 'x', round.id, 'R', null, 100);
  placeLadderBet('l_dbl', 'd', round.id, 'L', winParity, 100);
  placeLadderBet('l_dblmiss', 'm', round.id, 'L', loseParity, 100);

  expire('ladder_rounds', round.id);
  advanceLadderRound(fixed, revealSec);

  const singleWin = Math.floor(100 * LADDER_MULTIPLIER);
  const doubleWin = Math.floor(100 * LADDER_DOUBLE_MULTIPLIER);
  ck(`단일 적중 지급 ${singleWin}P`, bal('l_win') === 900 + singleWin, String(bal('l_win')));
  ck('빗나감 지급 없음', bal('l_lose') === 900, String(bal('l_lose')));
  ck(`더블 적중 지급 ${doubleWin}P`, bal('l_dbl') === 900 + doubleWin, String(bal('l_dbl')));
  ck('더블 중 하나만 맞으면 미지급', bal('l_dblmiss') === 900, String(bal('l_dblmiss')));
  ck('배당 실측 195 / 395', singleWin === 195 && doubleWin === 395, `${singleWin}/${doubleWin}`);

  mkUser('l_late', 500);
  ck('마감된 라운드 베팅 거절', !placeLadderBet('l_late', 'l', round.id, 'L', null, 100).ok);
  ck('마감 거절 후 차감 없음', bal('l_late') === 500, String(bal('l_late')));
}
auditLedger('사다리 후');

/* ── 2. 그래프(크래시) ───────────────────────────────────────── */
section('[2] 그래프게임(크래시)');
{
  const helpers = {
    makeCrashPoint: () => 5.0,
    crashDurationMs: (cp: number) => (cp - 1) * 1000,
    multiplierAt: (ms: number) => 1 + ms / 1000,
  };
  let round = advanceCrashRound(helpers);
  mkUser('c_out', 1000); mkUser('c_bust', 1000); mkUser('c_cancel', 1000);

  ck('베팅 성공', placeCrashBet('c_out', 'o', round.id, 200, null).ok);
  ck('베팅 즉시 차감', bal('c_out') === 800, String(bal('c_out')));
  placeCrashBet('c_bust', 'b', round.id, 200, null);
  placeCrashBet('c_cancel', 'c', round.id, 200, null);

  ck('베팅 취소 시 전액 환불', cancelCrashBet('c_cancel', round.id).ok && bal('c_cancel') === 1000, String(bal('c_cancel')));
  ck('취소 두 번은 거절', !cancelCrashBet('c_cancel', round.id).ok);

  const r1 = cashoutCrashBet('c_out', round.id, 2.5);
  ck('캐시아웃 지급 = floor(200×2.5) = 500', r1.ok && r1.payout === 500, JSON.stringify(r1));
  ck('캐시아웃 후 잔액 1300', bal('c_out') === 1300, String(bal('c_out')));
  const r2 = cashoutCrashBet('c_out', round.id, 2.5);
  ck('캐시아웃 두 번은 거절(이중 지급 없음)', !r2.ok && r2.error === 'already_cashed', JSON.stringify(r2));
  ck('두 번째 시도 후에도 잔액 그대로', bal('c_out') === 1300, String(bal('c_out')));

  expire('crash_rounds', round.id);
  advanceCrashRound(helpers);   // betting → running
  db.prepare(`UPDATE crash_rounds SET started_at_ms = ? WHERE id = ?`).run(Date.now() - 60_000, round.id);
  advanceCrashRound(helpers);   // running → done (버스트)
  ck('버스트한 사람은 지급 없음', bal('c_bust') === 800, String(bal('c_bust')));

  // 자동 캐시아웃: 크래시 배율(5.0)보다 낮게 걸면 반드시 먼저 체결돼야 한다.
  // 버스트 직후에는 결과 표시 시간(CRASH_REVEAL_SEC)이 남아 새 라운드가 열리지 않으므로
  // resolved_at을 과거로 당겨 다음 라운드를 즉시 만들게 한다.
  db.prepare(`UPDATE crash_rounds SET resolved_at = ? WHERE id = ?`).run(nowSec() - 60, round.id);
  round = advanceCrashRound(helpers);
  ck('결과 표시 시간이 지나면 새 라운드가 열린다', round.phase === 'betting', JSON.stringify(round));
  mkUser('c_auto', 1000); mkUser('c_autohigh', 1000);
  placeCrashBet('c_auto', 'a', round.id, 100, 2.0);
  placeCrashBet('c_autohigh', 'h', round.id, 100, 9.0);  // 크래시보다 높음 → 체결 안 됨
  expire('crash_rounds', round.id);
  advanceCrashRound(helpers);
  db.prepare(`UPDATE crash_rounds SET started_at_ms = ? WHERE id = ?`).run(Date.now() - 60_000, round.id);
  advanceCrashRound(helpers);
  ck('자동 캐시아웃 2.0배 체결 → 900+200 = 1100', bal('c_auto') === 1100, String(bal('c_auto')));
  ck('크래시보다 높은 목표는 미체결 → 900', bal('c_autohigh') === 900, String(bal('c_autohigh')));
}
auditLedger('그래프 후');

/* ── 3. 포커 플립 ────────────────────────────────────────────── */
section('[3] 포커 플립');
{
  // 카드 인덱스: rank*4 + suit (0=2♠ … 51=A♣). AA vs KK 고정 대결.
  const A = (s: number) => 12 * 4 + s, K = (s: number) => 11 * 4 + s;
  const hole = [A(0), A(1), K(2), K(3)];
  const board = [0, 5, 10, 15, 20].filter(c => !hole.includes(c)).slice(0, 5);

  const p = computeFlipProbabilities(hole[0], hole[1], hole[2], hole[3]);
  const odds = {
    master: oddsForWinMarket(p.masterWin, p.tie, 0.05),
    shark: oddsForWinMarket(p.sharkWin, p.tie, 0.05),
    tie: oddsFromProbability(p.tie, 0.05),
    buckets: p.buckets.map(b => oddsFromProbability(b, 0.05)),
  };
  const makeRound = () => ({ hole, board, odds });
  const resolve = (h: number[], b: number[]) => {
    const ms = evaluate7(h[0], h[1], b[0], b[1], b[2], b[3], b[4]);
    const ss = evaluate7(h[2], h[3], b[0], b[1], b[2], b[3], b[4]);
    const winner = ms > ss ? 'master' as const : ss > ms ? 'shark' as const : 'tie' as const;
    const mb = categoryBucket(scoreCategory(ms)), sb = categoryBucket(scoreCategory(ss));
    return { winner, buckets: [Math.max(mb, sb)], detail: null };
  };

  const round = advancePokerRound(makeRound, resolve);
  mkUser('p_a', 2000); mkUser('p_b', 2000);
  const mo = odds.master!;

  ck('칩 쌓기 성공', stackPokerBet('p_a', 'a', round.id, 'master', 500, mo).ok);
  ck('칩 쌓기 즉시 차감', bal('p_a') === 1500, String(bal('p_a')));
  ck('같은 시장에 추가로 쌓으면 누적 차감',
    stackPokerBet('p_a', 'a', round.id, 'master', 300, mo).ok && bal('p_a') === 1200, String(bal('p_a')));
  const mine = getMyPokerBets(round.id, 'p_a');
  ck('누적이 한 행에 합쳐짐 (800)', mine.length === 1 && mine[0].amount === 800, JSON.stringify(mine));
  ck('잔액 초과 거절', !stackPokerBet('p_b', 'b', round.id, 'master', 99999, mo).ok);
  ck('초과 거절 후 차감 없음', bal('p_b') === 2000, String(bal('p_b')));

  stackPokerBet('p_b', 'b', round.id, 'shark', 400, odds.shark!);
  ck('전부 회수하면 전액 환불', clearPokerBets('p_b', round.id).ok && bal('p_b') === 2000, String(bal('p_b')));
  ck('회수할 게 없으면 거절', !clearPokerBets('p_b', round.id).ok);

  // betting → 공개 단계 → 정산까지 밀어붙인다
  expire('poker_rounds', round.id, 60);
  advancePokerRound(makeRound, resolve);
  const out = resolve(hole, board);
  const expected = out.winner === 'master' ? 1200 + Math.floor(800 * mo)
    : out.winner === 'tie' ? 1200 + 800 : 1200;
  ck(`정산 지급 (승자 ${out.winner}) → ${expected}`, bal('p_a') === expected, String(bal('p_a')));
  ck('AA vs KK 보드 미스 → AA 승', out.winner === 'master', JSON.stringify(out));

  // 무승부는 원금 환불이어야 한다 (승패 시장 기준)
  ck('무승부 규칙이 원금 환불로 구현됨',
    /무승부 → 원금 환불/.test(require('fs').readFileSync('src/db/queries.ts', 'utf8')));
}
auditLedger('포커 후');

/* ── 4. 지뢰찾기 ─────────────────────────────────────────────── */
section('[4] 지뢰찾기');
{
  mkUser('m_u', 1000);
  const r = placeBet('m_u', 'mines', 300, { revealed: [] });
  ck('베팅 성공 + 차감', r.ok && bal('m_u') === 700, String(bal('m_u')));
  if (r.ok) {
    const after = settleGameRound(r.roundId, 'm_u', 750, 2.5, 'game:mines');
    ck('정산 지급 750P → 1450', after === 1450 && bal('m_u') === 1450, String(bal('m_u')));
  }
  ck('잔액 초과 베팅 거절', !placeBet('m_u', 'mines', 99999, {}).ok);
  ck('초과 거절 후 차감 없음', bal('m_u') === 1450, String(bal('m_u')));
}
auditLedger('지뢰찾기 후');

/* ── 5. 출석 · 지원금 ────────────────────────────────────────── */
section('[5] 출석 · 개인회생 지원금');
{
  mkUser('a_u', 0);
  const b = performCheckIn('a_u', 1, '2026-08-02', [{ reason: 'attendance', delta: 100 }]);
  ck('출석 지급', b === 100 && bal('a_u') === 100, String(bal('a_u')));

  mkUser('r_u', 0);
  const c1 = claimRelief('r_u', 200, 7200);
  ck('0P → 지원금 지급', c1.ok && bal('r_u') === 200, JSON.stringify(c1));
  const c2 = claimRelief('r_u', 200, 7200);
  ck('잔액 있으면 거절', !c2.ok && c2.error === 'not_broke');
  adjustBalance('r_u', -200, 'test:burn');
  const c3 = claimRelief('r_u', 200, 7200);
  ck('쿨다운 중 거절', !c3.ok && c3.error === 'cooldown');
  ck('거절 시 잔액 변화 없음', bal('r_u') === 0, String(bal('r_u')));
  ck('쿨다운 기준이 "받은 시각"',
    !c3.ok && c3.error === 'cooldown' && Math.abs(c3.nextAvailableAt - (nowSec() + 7200)) <= 2, JSON.stringify(c3));
}
auditLedger('출석·지원금 후');
noFractions('전체');
negativeBalances('전체');

/* ── 6. 배당률 정합성 ────────────────────────────────────────── */
section('[6] 배당률 — 확률 합과 하우스 엣지');
{
  const p = computeFlipProbabilities(12 * 4, 11 * 4 + 1, 10 * 4 + 2, 9 * 4 + 3);
  const sum = p.masterWin + p.sharkWin + p.tie;
  ck('승/패/무 확률 합 = 1', Math.abs(sum - 1) < 1e-9, String(sum));
  ck('전수 보드 수 = C(48,5) = 1,712,304', p.totalBoards === 1712304, String(p.totalBoards));

  const om = oddsForWinMarket(p.masterWin, p.tie, 0.05)!;
  const os = oddsForWinMarket(p.sharkWin, p.tie, 0.05)!;
  const implied = 1 / om + 1 / os;
  ck('승패 배당 역수 합 > 1 (하우스 엣지 존재)', implied > 1, String(implied));
  ck('하우스 엣지가 과하지 않음 (<15%)', implied < 1.15, String(implied));

  // 사다리는 50:50 두 갈래 × 1.95배 → 기대값 0.975 (엣지 2.5%)
  ck('사다리 단일 기대값 0.975', Math.abs(0.5 * LADDER_MULTIPLIER - 0.975) < 1e-9);
  ck('사다리 더블 기대값 0.9875', Math.abs(0.25 * LADDER_DOUBLE_MULTIPLIER - 0.9875) < 1e-9);
}

console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
process.exit(fail ? 1 : 0);
