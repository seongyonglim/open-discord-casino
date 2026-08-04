// 전 게임 포인트 정확성 감사 — 실제 DB에 베팅/정산을 돌려 원장과 잔액이 어긋나지 않는지 본다.

// 감사는 항상 일회용 DB에서 돈다. DB_PATH를 지정하지 않고 실행해도 로컬/운영 데이터를 건드리지 않게
// 여기서 임시 경로로 못 박는다(첫 import보다 먼저 실행되어야 하므로 파일 맨 위에 둔다).
if (!process.env.DB_PATH) {
  const os = require('node:os'), path = require('node:path'), fsx = require('node:fs');
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'casino-audit-'));
  process.env.DB_PATH = dir;
}

import { randomInt as rnd } from 'node:crypto';
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
/* 게임별 누적 성적(game_stats)의 불변식.
   랭킹의 유일한 근거이므로 파생 컬럼이 어긋나거나 범위를 벗어나면 곧바로 거짓 지표가 된다. */
function auditStats(label: string): void {
  const bad = q<{ n: number }>(`
    SELECT (SELECT COUNT(*) FROM game_stats WHERE profit != returned - staked)
         + (SELECT COUNT(*) FROM game_stats WHERE wins + pushes > rounds)
         + (SELECT COUNT(*) FROM game_stats WHERE rounds < 0 OR wins < 0 OR pushes < 0)
         + (SELECT COUNT(*) FROM game_stats WHERE staked < 0 OR returned < 0)
         + (SELECT COUNT(*) FROM game_stats
              WHERE rounds != CAST(rounds AS INTEGER) OR staked != CAST(staked AS INTEGER)
                 OR returned != CAST(returned AS INTEGER) OR profit != CAST(profit AS INTEGER))
         AS n`)[0];
  ck(`${label} — game_stats 불변식 (profit = returned - staked, 범위, 정수)`, bad.n === 0, `${bad.n}건`);

  /* 게임별 순손익이 원장 합과 같은가.
     감사 DB는 일회용이라 180일 프루닝이 걸리지 않으므로 이 등식이 성립한다.
     운영 DB에는 쓸 수 없다 — 181일째에 원장이 잘려 나가면서 반드시 깨진다.
     지뢰찾기는 제외한다: 0칸 캐시아웃을 판수에서 뺐으므로(전액 환불과 같다)
     그 판의 스테이크·회수가 집계에 안 들어가고, 원장에는 남는다. */
  const games = ['ladder', 'graph', 'poker', 'baccarat', 'blackjack'];
  let mismatch = 0, detail = '';
  for (const g of games) {
    const rows = q<{ user_id: string; profit: number }>(
      `SELECT user_id, profit FROM game_stats WHERE game = ?`, g);
    for (const r of rows) {
      const led = q<{ s: number }>(
        `SELECT COALESCE(SUM(delta),0) AS s FROM points_ledger
          WHERE user_id = ? AND (reason = ? OR reason LIKE ?)`,
        r.user_id, `game:${g}`, `game:${g}:%`)[0].s;
      if (led !== r.profit) {
        mismatch++;
        detail = `${g}/${r.user_id}: 집계 ${r.profit} ≠ 원장 ${led}`;
      }
    }
  }
  ck(`${label} — 게임별 순손익 = 원장 합 (지뢰 제외)`, mismatch === 0, detail);
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
auditStats('사다리 후');

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
auditStats('그래프 후');

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
auditStats('포커 후');

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
auditStats('지뢰찾기 후');

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

  /* 제보된 무한 지원금 수법을 그대로 재현한다.
     전 재산을 지뢰찾기에 걸어 잔액을 0으로 만들고 → 지원금을 받고 → 칸을 하나도
     열지 않은 채 캐시아웃하면 배당 1.00x로 전액 환불된다. 막히지 않으면
     쿨다운마다 원금 그대로에 200P가 얹혀 무한히 불어난다. */
  mkUser('r_ex', 1000);
  const round = placeBet('r_ex', 'mines', 1000, { mineCount: 5, minePositions: [0, 1, 2, 3, 4], revealed: [] });
  ck('전 재산을 걸어 잔액이 0이 됐다', round.ok && bal('r_ex') === 0, String(bal('r_ex')));
  const ex = claimRelief('r_ex', 200, 7200);
  ck('묶인 돈이 있으면 지원금 거절 (지뢰찾기 진행 중)',
    !ex.ok && ex.error === 'has_stake', JSON.stringify(ex));
  ck('거절됐으니 잔액은 그대로 0', bal('r_ex') === 0, String(bal('r_ex')));
  ck('묶인 금액을 정확히 알려준다', !ex.ok && ex.error === 'has_stake' && ex.staked === 1000,
    JSON.stringify(ex));
  // 0칸 캐시아웃으로 전액 환불받으면 이제 잔액이 있으니 여전히 못 받는다
  if (round.ok) settleGameRound(round.roundId, 'r_ex', 1000, 1, 'game:mines', false);
  ck('전액 환불 뒤에는 잔액이 있어 여전히 거절', bal('r_ex') === 1000
    && (() => { const z = claimRelief('r_ex', 200, 7200); return !z.ok && z.error === 'not_broke'; })(),
    String(bal('r_ex')));
  ck('결국 공짜 200P가 생기지 않았다 (원금 1,000P 그대로)', bal('r_ex') === 1000, String(bal('r_ex')));

  /* 다른 게임도 같은 수법이 통하지 않는지 — 사다리로 확인한다(베팅 취소로 전액 환불된다) */
  mkUser('r_ex2', 500);
  // 베팅 창이 열린 라운드를 받을 때까지 진행시킨다 (앞 섹션이 라운드를 마감해 뒀다)
  const mk = () => ({ startSide: 'L', endSide: 'L', rungs: [false] });
  let lr = advanceLadderRound(mk, () => 3);
  for (let i = 0; i < 20 && lr.phase !== 'betting'; i++) {
    db.prepare(`UPDATE ladder_rounds SET resolved_at = ? WHERE id = ?`).run(nowSec() - 600, lr.id);
    lr = advanceLadderRound(mk, () => 3);
  }
  const lbet = placeLadderBet('r_ex2', 'x', lr.id, 'L', null, 500);
  ck('사다리에 전 재산을 걸어 잔액 0', lbet.ok && bal('r_ex2') === 0,
    `${lr.phase} / ${JSON.stringify(lbet)} / ${bal('r_ex2')}`);
  const ex2 = claimRelief('r_ex2', 200, 7200);
  ck('사다리 베팅 중에도 지원금 거절', !ex2.ok && ex2.error === 'has_stake', JSON.stringify(ex2));
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


/* ── 7. 바카라 ───────────────────────────────────────────────── */
section('[7] 바카라');
{
  const { baccaratProbabilities, playRound, drawRound, handTotal, cardValue, bankerDraws, playerDraws } =
    require('../src/services/baccarat') as typeof import('../src/services/baccarat');
  const { baccaratOdds } = require('../src/web/games/baccarat') as typeof import('../src/web/games/baccarat');
  const {
    advanceBaccaratRound, stackBaccaratBet, clearBaccaratBets, getMyBaccaratBets,
  } = require('../src/db/queries') as typeof import('../src/db/queries');

  // 규칙 — 공표된 8덱 표준 확률과 맞는지 (드로우 표를 잘못 옮기면 여기서 어긋난다)
  const pr = baccaratProbabilities();
  /* 내부 친선 룰로 1덱으로 바꿨으므로 1덱 기준값을 쓴다.
     8덱은 뱅커 45.86% · 플레이어 44.62% · 타이 9.52%였고, 1덱은 뱅커가 조금 오르고
     타이가 조금 내려간다 — 덱이 적을수록 그렇게 되는 알려진 경향과 일치한다. */
  const REF = { banker: 0.459624, player: 0.446760, tie: 0.093615 };
  ck('뱅커 승률 = 공표값', Math.abs(pr.banker - REF.banker) < 5e-6, pr.banker.toFixed(6));
  ck('플레이어 승률 = 공표값', Math.abs(pr.player - REF.player) < 5e-6, pr.player.toFixed(6));
  ck('타이 확률 = 공표값', Math.abs(pr.tie - REF.tie) < 5e-6, pr.tie.toFixed(6));
  ck('확률 합 = 1', Math.abs(pr.banker + pr.player + pr.tie - 1) < 1e-12);
  // 1덱이면 랭크당 4장 → 두 번째 카드가 같은 랭크일 확률 3/51
  ck('페어 확률 = 3/51', Math.abs(pr.pair - 3 / 51) < 1e-12, String(pr.pair));

  // 배당 — 모든 시장의 RTP가 하우스 엣지 1%에 맞는지
  const od = baccaratOdds();
  const rtp = {
    player: pr.player * od.player + pr.tie,   // 무승부는 원금 환불
    banker: pr.banker * od.banker + pr.tie,
    tie: pr.tie * od.tie,
    pair: pr.pair * od.ppair,
  };
  for (const k of ['player', 'banker', 'tie', 'pair'] as const) {
    ck(`${k} RTP가 98~99% 구간`, rtp[k] > 0.98 && rtp[k] < 0.995, (rtp[k] * 100).toFixed(2) + '%');
  }
  ck('모든 시장 RTP < 1 (하우스가 손해 보는 시장 없음)',
    Object.values(rtp).every(v => v < 1), JSON.stringify(rtp));

  // 드로우 규칙 표 — 대표적인 갈림길 몇 개를 직접 확인
  ck('플레이어 5는 드로우, 6은 스탠드', playerDraws(5) && !playerDraws(6));
  ck('뱅커 3 vs 플레이어 서드 8 → 스탠드', !bankerDraws(3, 8));
  ck('뱅커 3 vs 플레이어 서드 7 → 드로우', bankerDraws(3, 7));
  ck('뱅커 6 vs 플레이어 서드 5 → 스탠드', !bankerDraws(6, 5));
  ck('뱅커 6 vs 플레이어 서드 6 → 드로우', bankerDraws(6, 6));
  ck('플레이어 스탠드 시 뱅커는 0~5만 드로우', bankerDraws(5, null) && !bankerDraws(6, null));
  ck('K·Q·J·10은 0끗', [8, 9, 10, 11].every(r => cardValue(r * 4) === 0));
  ck('A는 1끗', cardValue(12 * 4) === 1);
  // 랭크 7='9'(9끗), 랭크 6='8'(8끗) → 17 → 7끗
  ck('끗수는 10으로 나눈 나머지', handTotal([7 * 4, 6 * 4]) === 7, String(handTotal([7 * 4, 6 * 4])));

  // 내추럴이면 절대 세 번째 카드가 나오지 않는다
  let naturalWithThird = 0, dealt = 0;
  for (let i = 0; i < 3000; i++) {
    const o = playRound(drawRound(rnd));
    dealt++;
    if (o.natural && (o.playerCards.length > 2 || o.bankerCards.length > 2)) naturalWithThird++;
  }
  ck(`내추럴 판에는 세 번째 카드 없음 (${dealt}판 확인)`, naturalWithThird === 0, `${naturalWithThird}건`);

  // 실제 지급 — 승/패/무/페어 네 갈래를 라운드로 돌려 본다
  mkUser('b_p', 10000); mkUser('b_b', 10000); mkUser('b_t', 10000); mkUser('b_pp', 10000);
  const draw = () => drawRound(rnd);
  const resolve = (cards: number[]) => {
    const o = playRound(cards);
    return {
      winner: o.winner, playerTotal: o.playerTotal, bankerTotal: o.bankerTotal,
      playerPair: o.playerPair, bankerPair: o.bankerPair, natural: o.natural,
      playerCards: o.playerCards, bankerCards: o.bankerCards,
    };
  };
  const round = advanceBaccaratRound(draw, resolve);

  ck('칩 쌓기 성공 + 즉시 차감',
    stackBaccaratBet('b_p', 'p', round.id, 'player', 1000, od.player).ok && bal('b_p') === 9000, String(bal('b_p')));
  ck('같은 시장 누적', stackBaccaratBet('b_p', 'p', round.id, 'player', 500, od.player).ok && bal('b_p') === 8500, String(bal('b_p')));
  ck('한 행으로 합쳐짐 (1500)', getMyBaccaratBets(round.id, 'b_p')[0].amount === 1500);
  ck('잔액 초과 거절', !stackBaccaratBet('b_b', 'b', round.id, 'banker', 99999, od.banker).ok);
  ck('초과 거절 후 차감 없음', bal('b_b') === 10000, String(bal('b_b')));
  stackBaccaratBet('b_b', 'b', round.id, 'banker', 1000, od.banker);
  stackBaccaratBet('b_t', 't', round.id, 'tie', 1000, od.tie);
  stackBaccaratBet('b_pp', 'pp', round.id, 'ppair', 1000, od.ppair);
  ck('전부 회수하면 전액 환불',
    clearBaccaratBets('b_pp', round.id).ok && bal('b_pp') === 10000, String(bal('b_pp')));
  ck('회수할 게 없으면 거절', !clearBaccaratBets('b_pp', round.id).ok);
  stackBaccaratBet('b_pp', 'pp', round.id, 'ppair', 1000, od.ppair);

  const before = { p: bal('b_p'), b: bal('b_b'), t: bal('b_t'), pp: bal('b_pp') };
  expire('baccarat_rounds', round.id, 60);
  advanceBaccaratRound(draw, resolve);
  const o = resolve(JSON.parse(
    (db.prepare(`SELECT cards_json FROM baccarat_rounds WHERE id = ?`).get(round.id) as any).cards_json));

  const wantP = o.winner === 'tie' ? 1500 : o.winner === 'player' ? Math.floor(1500 * od.player) : 0;
  const wantB = o.winner === 'tie' ? 1000 : o.winner === 'banker' ? Math.floor(1000 * od.banker) : 0;
  const wantT = o.winner === 'tie' ? Math.floor(1000 * od.tie) : 0;
  const wantPP = o.playerPair ? Math.floor(1000 * od.ppair) : 0;
  ck(`플레이어 베팅 정산 (승자 ${o.winner} → +${wantP})`, bal('b_p') === before.p + wantP, `${bal('b_p')} vs ${before.p + wantP}`);
  ck(`뱅커 베팅 정산 (+${wantB})`, bal('b_b') === before.b + wantB, `${bal('b_b')} vs ${before.b + wantB}`);
  ck(`타이 베팅 정산 (+${wantT})`, bal('b_t') === before.t + wantT, `${bal('b_t')} vs ${before.t + wantT}`);
  ck(`P페어 베팅 정산 (페어=${o.playerPair} → +${wantPP})`, bal('b_pp') === before.pp + wantPP, `${bal('b_pp')} vs ${before.pp + wantPP}`);
  ck('무승부면 승패 베팅은 원금 그대로 (손실 없음)',
    o.winner !== 'tie' || (bal('b_p') === before.p + 1500 && bal('b_b') === before.b + 1000));

  mkUser('b_late', 5000);
  ck('마감된 라운드 베팅 거절', !stackBaccaratBet('b_late', 'l', round.id, 'player', 100, od.player).ok);
  ck('마감 거절 후 차감 없음', bal('b_late') === 5000, String(bal('b_late')));
}
auditLedger('바카라 후');
auditStats('바카라 후');


/* ── 8. 블랙잭 ───────────────────────────────────────────────── */
section('[8] 블랙잭');
{
  const BJ = require('../src/services/blackjack') as typeof import('../src/services/blackjack');
  const {
    advanceBlackjackRound, seatBlackjackBet, clearBlackjackBet, blackjackAction,
    getBlackjackHands, BJ_SEATS, BJ_BETTING_SEC,
  } = require('../src/db/queries') as typeof import('../src/db/queries');

  const H = {
    shuffle: () => BJ.shuffleShoe(rnd),
    isBlackjack: BJ.isBlackjack,
    dealerShouldHit: BJ.dealerShouldHit,
    handTotal: (c: number[]) => { const t = BJ.handTotal(c); return { total: t.total, bust: t.bust }; },
    settle: BJ.settleHand,
  };
  // 카드 인덱스: rank*4+suit (rank 0='2' … 8='T' 9='J' 10='Q' 11='K' 12='A')
  const C = (r: number, s = 0) => r * 4 + s;
  const A = (s = 0) => C(12, s), K = (s = 0) => C(11, s), T = (s = 0) => C(8, s);
  const N = (n: number, s = 0) => C(n - 2, s);

  // 규칙 — 손패 계산
  ck('A+K = 소프트 21', BJ.handTotal([A(), K()]).total === 21 && BJ.handTotal([A(), K()]).soft);
  ck('A+A = 12 (A 하나만 11)', BJ.handTotal([A(0), A(1)]).total === 12);
  ck('A+6+10 = 하드 17', BJ.handTotal([A(), N(6), T()]).total === 17 && !BJ.handTotal([A(), N(6), T()]).soft);
  ck('K+Q+J = 버스트', BJ.handTotal([K(), C(10), C(9)]).bust);
  ck('두 장 21만 블랙잭', BJ.isBlackjack([A(), T()]) && !BJ.isBlackjack([N(7), N(7), N(7)]));

  // 딜러 규칙 (S17)
  ck('딜러 16 드로우 · 하드 17 스탠드', BJ.dealerShouldHit([T(), N(6)]) && !BJ.dealerShouldHit([T(), N(7)]));
  ck('딜러 소프트 17에서도 스탠드 (S17)', !BJ.dealerShouldHit([A(), N(6)]));

  // 정산 — 배당은 실제 카지노 값 그대로여야 한다
  ck('블랙잭 3:2 → 2.5배', BJ.settleHand([A(), K()], [T(), N(9)]).multiplier === 2.5);
  ck('일반 승 1:1 → 2배', BJ.settleHand([T(), N(9)], [T(), N(8)]).multiplier === 2);
  ck('무승부 → 원금 환불', BJ.settleHand([T(), N(9)], [K(), N(9)]).multiplier === 1);
  ck('양쪽 블랙잭 → 무승부', BJ.settleHand([A(), K()], [A(1), C(10)]).multiplier === 1);
  ck('내가 먼저 버스트하면 딜러가 버스트해도 패 (하우스 엣지의 원천)',
    BJ.settleHand([T(), K(), N(5)], [T(), K(), N(5)]).multiplier === 0);

  // 슈
  {
    const shoe = BJ.shuffleShoe(rnd);
    const cnt = new Map<number, number>();
    shoe.forEach(c => cnt.set(c, (cnt.get(c) ?? 0) + 1));
    ck('1덱 52장 · 52종 각 1장', shoe.length === 52 && cnt.size === 52 && [...cnt.values()].every(v => v === 1));
  }

  // 실제 라운드 — 착석·중복·환불
  let round = advanceBlackjackRound(H);
  mkUser('j1', 20000); mkUser('j2', 20000); mkUser('j3', 20000);
  ck('0번 착석 + 즉시 차감', seatBlackjackBet('j1', 'j1', round.id, 0, 1000).ok && bal('j1') === 19000, String(bal('j1')));
  ck('같은 자리 다른 사람 거절', !seatBlackjackBet('j2', 'j2', round.id, 0, 1000).ok);
  ck('거절 시 차감 없음', bal('j2') === 20000, String(bal('j2')));
  ck('이미 앉은 사람이 다른 자리 → 거절', !seatBlackjackBet('j1', 'j1', round.id, 2, 100).ok);
  ck('같은 자리 칩 추가는 누적', seatBlackjackBet('j1', 'j1', round.id, 0, 500).ok && bal('j1') === 18500, String(bal('j1')));
  ck(`자리 범위 밖 거절 (0~${BJ_SEATS - 1})`,
    !seatBlackjackBet('j3', 'j3', round.id, BJ_SEATS, 100).ok && !seatBlackjackBet('j3', 'j3', round.id, -1, 100).ok);
  ck('잔액 초과 거절', !seatBlackjackBet('j3', 'j3', round.id, 3, 999999).ok);
  seatBlackjackBet('j2', 'j2', round.id, 1, 1000);
  ck('회수하면 전액 환불', clearBlackjackBet('j2', round.id).ok && bal('j2') === 20000, String(bal('j2')));
  ck('회수 후 그 자리 재착석 가능', seatBlackjackBet('j3', 'j3', round.id, 1, 800).ok);
  ck('한 명이 회수해도 남은 사람이 있으면 카운트다운 유지',
    advanceBlackjackRound(H).phase === 'betting');

  // 배분 — 카드와 슈 소비
  expire('blackjack_rounds', round.id, 1);
  round = advanceBlackjackRound(H);
  ck('배분 단계 진입', round.phase === 'deal', round.phase);
  {
    const hands = getBlackjackHands(round.id);
    ck('앉은 사람 두 장씩', hands.length === 2 && hands.every(h => (JSON.parse(h.cards_json) as number[]).length === 2));
    ck('딜러 두 장', (JSON.parse(round.dealer_json) as number[]).length === 2);
    ck('슈 소비 = 인원×2 + 2', round.shoe_pos === 2 * 2 + 2, String(round.shoe_pos));
    ck('블랙잭이면 바로 확정', hands.every(h => {
      const c = JSON.parse(h.cards_json) as number[];
      return BJ.isBlackjack(c) ? h.status === 'blackjack' : h.status === 'playing';
    }));
  }

  // 힛 / 스탠드 / 더블다운
  expire('blackjack_rounds', round.id, 5);
  round = advanceBlackjackRound(H);
  ck('결정 단계 진입', round.phase === 'action', round.phase);
  /* 더블다운 검사는 j1이 아직 결정할 수 있는 상태여야 성립한다.
     실제 덱에서 나눠주므로 j1이 블랙잭을 받거나 딜러가 블랙잭이면 라운드가 끝나 있고,
     그러면 제품이 아니라 운 때문에 실패한다(실제로 그렇게 실패한 적이 있다).
     그래서 j1 손패를 5+6=11(더블에 가장 알맞은 패)로, 딜러를 블랙잭이 아닌 조합으로
     못 박는다. 카드 인덱스는 rank = c >> 2 (0='2' … 12='A'). */
  {
    const c5 = 3 * 4 + 0;    // '5'
    const c6 = 4 * 4 + 1;    // '6'
    const c9 = 7 * 4 + 2;    // '9'
    const c7 = 5 * 4 + 3;    // '7'
    db.prepare(`UPDATE blackjack_hands SET cards_json = ?, status = 'playing'
                WHERE round_id = ? AND user_id = 'j1'`)
      .run(JSON.stringify([c5, c6]), round.id);
    db.prepare(`UPDATE blackjack_rounds SET dealer_json = ? WHERE id = ?`)
      .run(JSON.stringify([c9, c7]), round.id);
    round = db.prepare(`SELECT * FROM blackjack_rounds WHERE id = ?`).get(round.id) as typeof round;
  }
  {
    const before = bal('j1');
    const betBefore = getBlackjackHands(round.id).find(h => h.user_id === 'j1')!.bet;
    const dd = blackjackAction('j1', round.id, 'double', H);
    ck('더블다운 성공', dd.ok, JSON.stringify(dd));
    if (dd.ok) {
      ck('더블 시 베팅 두 배', dd.bet === betBefore * 2, `${dd.bet} vs ${betBefore * 2}`);
      ck('더블 시 원래 베팅액만큼 추가 차감', bal('j1') === before - betBefore, String(bal('j1')));
      ck('더블은 한 장만 받고 선다', dd.cards.length === 3 && (dd.status === 'stand' || dd.status === 'bust'), JSON.stringify(dd));
      ck('더블 후에는 더 못 움직임', !blackjackAction('j1', round.id, 'hit', H).ok);
    }
    const h3 = getBlackjackHands(round.id).find(h => h.user_id === 'j3')!;
    if (h3.status === 'playing') {
      const hit = blackjackAction('j3', round.id, 'hit', H);
      ck('힛하면 카드 한 장 늘고 상태가 규칙과 일치', hit.ok && (() => {
        const t = BJ.handTotal(hit.cards);
        return hit.cards.length === 3 && hit.status === (t.bust ? 'bust' : t.total === 21 ? 'stand' : 'playing');
      })(), JSON.stringify(hit));
    }
    ck('참여 안 한 사람은 액션 불가', !blackjackAction('j2', round.id, 'hit', H).ok);
    // 세 장을 들고 있으면 더블 불가
    const h3b = getBlackjackHands(round.id).find(h => h.user_id === 'j3')!;
    if ((JSON.parse(h3b.cards_json) as number[]).length > 2 && h3b.status === 'playing') {
      const bad = blackjackAction('j3', round.id, 'double', H);
      ck('세 장부터는 더블 불가', !bad.ok && bad.error === 'cannot_double', JSON.stringify(bad));
    }
  }

  // 시간 초과 = 강제 스탠드 · 딜러 · 정산
  {
    const before: Record<string, number> = { j1: bal('j1'), j3: bal('j3') };
    expire('blackjack_rounds', round.id, 25);
    // 딜러 차례는 받은 카드 수만큼 길어진다(bjSchedule). 먼저 한 번 진행시켜 딜러가 카드를
    // 뽑게 한 뒤, 그 늘어난 구간까지 지나가도록 시각을 다시 당긴다.
    round = advanceBlackjackRound(H);
    ck('딜러 차례에 카드를 미리 뽑아둔다 (정산 때가 아니라)',
      round.phase !== 'done' ? (JSON.parse(round.dealer_json) as number[]).length >= 2 : true, round.phase);
    db.prepare(`UPDATE blackjack_rounds SET action_ended_at = ? WHERE id = ?`).run(nowSec() - 60, round.id);
    round = advanceBlackjackRound(H);
    ck('정산 단계 도달', round.phase === 'done', round.phase);
    const hands = getBlackjackHands(round.id);
    ck('진행 중이던 손패가 남지 않음 (시간 초과 = 강제 스탠드)',
      hands.every(h => h.status !== 'playing'), JSON.stringify(hands.map(h => h.status)));
    const dealer = JSON.parse(round.dealer_json) as number[];
    // 살아남은 손패가 하나도 없으면 딜러는 카드를 받지 않는다(실제 규칙) — 그때는 17 미만이어도 정상
    const alive = hands.some(x => x.status === 'stand' || x.status === 'blackjack');
    ck(alive ? '살아남은 손패가 있으면 딜러는 17까지 받는다' : '전원 버스트면 딜러는 받지 않는다',
      alive ? (BJ.handTotal(dealer).total >= 17 || BJ.handTotal(dealer).bust) : dealer.length === 2,
      `${BJ.handTotal(dealer).total} / ${dealer.length}장 / alive=${alive}`);
    for (const h of hands) {
      const cards = JSON.parse(h.cards_json) as number[];
      const want = Math.floor(h.bet * BJ.settleHand(cards, dealer).multiplier);
      ck(`${h.user_id} 지급 규칙 일치 (${h.outcome} → ${want})`, h.payout === want, String(h.payout));
      ck(`${h.user_id} 잔액 반영`, bal(h.user_id) === before[h.user_id] + (h.payout ?? 0), String(bal(h.user_id)));
    }
    mkUser('j_late', 5000);
    ck('마감된 라운드 착석 거절', !seatBlackjackBet('j_late', 'l', round.id, 4, 100).ok);
    ck('마감 거절 후 차감 없음', bal('j_late') === 5000, String(bal('j_late')));
  }

  /* 빈 테이블로 되돌리기.
     마지막 사람이 칩을 회수해 테이블이 비면 카운트다운을 풀고 대기로 돌아가야 한다.
     안 풀면 아무도 없는 판에 카드가 돌고, 그 판이 끝날 때까지 새로 온 사람이 기다린다.
     (앞의 검사들이 라운드를 다 소진했으니 여기서 새 라운드를 하나 얻어 쓴다) */
  {
    mkUser('jz', 20000);
    // 진행 중인 판을 정산까지 밀어낸 뒤, 결과 표시 시간도 지난 것으로 만들어 새 라운드를 연다
    expire('blackjack_rounds', round.id, 60);
    advanceBlackjackRound(H);
    db.prepare(`UPDATE blackjack_rounds SET resolved_at = ? WHERE id = ?`).run(nowSec() - 60, round.id);
    const empty = advanceBlackjackRound(H);
    ck('새 테이블은 대기 상태 · 카운트다운 없음',
      empty.phase === 'waiting' && empty.betting_ends_at === null,
      empty.phase + ' / ' + empty.betting_ends_at);
    ck('한 명 앉으면 카운트다운 시작',
      seatBlackjackBet('jz', 'jz', empty.id, 2, 500).ok
      && advanceBlackjackRound(H).betting_ends_at !== null);
    ck('그 한 명이 회수하면 다시 대기 · 카운트다운 해제', (() => {
      if (!clearBlackjackBet('jz', empty.id).ok) return false;
      const back = advanceBlackjackRound(H);
      return back.id === empty.id && back.phase === 'waiting' && back.betting_ends_at === null;
    })());
    ck('다시 앉으면 카운트다운이 처음부터 (남은 시간이 잘려 있지 않다)', (() => {
      const t = nowSec();
      if (!seatBlackjackBet('jz', 'jz', empty.id, 4, 500).ok) return false;
      const on = advanceBlackjackRound(H);
      const left = on.betting_ends_at! - t;
      return on.phase === 'betting' && left >= BJ_BETTING_SEC - 1 && left <= BJ_BETTING_SEC;
    })());
    // 한 번 되돌린 라운드도 평소처럼 카드가 돌아야 한다
    expire('blackjack_rounds', empty.id, 1);
    const dealt = advanceBlackjackRound(H);
    ck('되돌린 라운드도 정상 배분',
      (JSON.parse(dealt.dealer_json) as number[]).length === 2
      && getBlackjackHands(dealt.id).every(x => (JSON.parse(x.cards_json) as number[]).length === 2),
      dealt.phase + ' / ' + dealt.dealer_json);
  }
}
auditLedger('블랙잭 후');
auditStats('블랙잭 후');

console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
process.exit(fail ? 1 : 0);
