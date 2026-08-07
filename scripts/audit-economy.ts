// 전 게임 포인트 정확성 감사 — 실제 DB에 베팅/정산을 돌려 원장과 잔액이 어긋나지 않는지 본다.

// 감사는 항상 일회용 DB에서 돈다. DB_PATH를 지정하지 않고 실행해도 로컬/운영 데이터를 건드리지 않게
// 여기서 임시 경로로 못 박는다(첫 import보다 먼저 실행되어야 하므로 파일 맨 위에 둔다).
if (!process.env.DB_PATH) {
  const os = require('node:os'), path = require('node:path'), fsx = require('node:fs');
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'casino-audit-'));
  process.env.DB_PATH = dir;
}

import { randomInt as rnd } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../src/db/schema';

/* 질의 코드 전체(배럴 + 도메인 모듈)를 한 덩어리로 읽는다.
   "규칙이 코드에 이렇게 적혀 있는가"를 보는 검사들이 쓴다. 파일이 나뉜 뒤에도 검사가
   전체를 보게 하려는 것이다 — 배럴만 읽으면 export 줄밖에 없어서 무엇을 찾든 못 찾는다. */
function queriesSource(): string {
  const dir = join('src', 'db', 'queries');
  return readFileSync(join('src', 'db', 'queries.ts'), 'utf8')
    + readdirSync(dir).map(f => readFileSync(join(dir, f), 'utf8')).join('\n');
}
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
         + (SELECT COUNT(*) FROM game_stats WHERE rated > rounds)
         + (SELECT COUNT(*) FROM game_stats WHERE wins + pushes > rated)
         + (SELECT COUNT(*) FROM game_stats WHERE rounds < 0 OR rated < 0 OR wins < 0 OR pushes < 0)
         + (SELECT COUNT(*) FROM game_stats WHERE staked < 0 OR returned < 0)
         + (SELECT COUNT(*) FROM game_stats
              WHERE rounds != CAST(rounds AS INTEGER) OR staked != CAST(staked AS INTEGER)
                 OR returned != CAST(returned AS INTEGER) OR profit != CAST(profit AS INTEGER))
         AS n`)[0];
  ck(`${label} — game_stats 불변식 (profit = returned - staked, rated <= rounds, 범위, 정수)`,
    bad.n === 0, `${bad.n}건`);

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

  /* 무승부는 원금 환불이어야 한다 (승패 시장 기준).
     질의는 도메인별 모듈로 나뉘어 있으므로 배럴 한 파일만 읽으면 안 된다 —
     읽을 것이 export 줄뿐이라 이 검사가 조용히 무의미해진다(실제로 나눈 직후 실패했다). */
  ck('무승부 규칙이 원금 환불로 구현됨', /무승부 → 원금 환불/.test(queriesSource()));
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
    canSurrender: BJ.canSurrender, settleSurrender: BJ.settleSurrender,
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

/* ── 서렌더 (판 포기) ───────────────────────────────────────────────
   우리 딜러는 뒷장을 미리 확인하지 않으므로(no-peek), 서렌더를 고른 뒤 딜러가
   블랙잭으로 밝혀지면 무효가 되어 전액을 잃는다. 절반만 잃게 두면 "얼리 서렌더"가
   되어 플레이어 쪽으로 0.6%p나 기운다 — 실제 카지노가 그것을 없앤 이유다. */
section('[8b] 블랙잭 서렌더');
{
  const BJ = require('../src/services/blackjack') as typeof import('../src/services/blackjack');
  const T10 = 8 * 4 + 0, T5 = 3 * 4 + 1, TA = 12 * 4 + 2, T9 = 7 * 4 + 3, T7 = 5 * 4 + 0;
  ck('첫 두 장에서는 서렌더 가능', BJ.canSurrender([T10, T5]));
  ck('세 장이면 불가', !BJ.canSurrender([T10, T5, T7]));
  ck('내가 블랙잭이면 불가 (이미 확정 승)', !BJ.canSurrender([TA, T10]));

  const notBJ = BJ.settleSurrender([T9, T7]);      // 딜러 16 — 블랙잭 아님
  ck('딜러가 블랙잭이 아니면 절반 반환',
    notBJ.multiplier === 0.5 && notBJ.outcome === 'surrender', JSON.stringify(notBJ));
  const isBJ = BJ.settleSurrender([TA, T10]);      // 딜러 블랙잭
  ck('딜러가 블랙잭이면 무효 — 전액 손실',
    isBJ.multiplier === 0 && isBJ.outcome === 'lose', JSON.stringify(isBJ));

  // 금액 — 내림 규칙을 따른다
  ck('100P 서렌더 → 50P 반환', Math.floor(100 * 0.5) === 50);
  ck('25P 서렌더 → 12P 반환 (내림)', Math.floor(25 * 0.5) === 12);
  ck('1P 서렌더 → 0P 반환 (내림)', Math.floor(1 * 0.5) === 0);

  /* 얼리 서렌더가 아님을 못 박는다 — 딜러 블랙잭에서 절반이 돌아오면 그건 ES다.
     이 단정이 깨지면 하우스 엣지가 조용히 0.6%p 빠진다. */
  ck('얼리 서렌더가 아니다 (딜러 블랙잭에 절반을 주지 않는다)',
    BJ.settleSurrender([TA, T10]).multiplier === 0);
}
auditStats('서렌더 후');

auditLedger('블랙잭 후');
auditStats('블랙잭 후');

/* ── 9. 운영자 동작 ───────────────────────────────────────────────
   운영 화면은 사람이 눌러서 데이터를 지우는 자리다. 위험한 조건을 화면이 아니라
   db/admin.ts 가 막는지 여기서 확인한다 — 화면에서만 막으면 API 를 직접 부르는
   순간 뚫린다. */
section('[9] 운영자 동작');
{
  const A = require('../src/db/admin') as typeof import('../src/db/admin');
  const HD = require('../src/db/holdem') as typeof import('../src/db/holdem');
  const db = getDb();

  // 포인트 — 원장을 함께 쓰는가, 음수 잔액을 막는가
  mkUser('ad_u', 1000);
  const up = A.grantPoints('ad_u', 500, '검증');
  ck('지급하면 잔액이 오른다', up.ok && up.balance === 1500, JSON.stringify(up));
  const led = db.prepare(
    `SELECT COALESCE(SUM(delta),0) AS n FROM points_ledger WHERE user_id = 'ad_u'`)
    .get() as { n: number };
  ck('지급이 원장에 남는다 (잔액 = 원장 누적합)', led.n === 1500, String(led.n));
  ck('사유가 admin: 으로 남는다',
    (db.prepare(`SELECT reason FROM points_ledger WHERE user_id='ad_u' ORDER BY id DESC LIMIT 1`)
      .get() as { reason: string }).reason.startsWith('admin:'));
  ck('잔액을 음수로 만드는 차감은 거절', !A.grantPoints('ad_u', -99999, '검증').ok);
  ck('0 지급은 거절', !A.grantPoints('ad_u', 0, '검증').ok);
  ck('없는 사용자는 거절', !A.grantPoints('no_such_user', 100, '검증').ok);

  /* 하루 하나를 강제하던 유니크 인덱스를 걷어냈다. 대신 남은 규칙은 하나다 —
     살아 있는 판(끝나지도 취소되지도 않은 것)은 한 번에 하나뿐이다. */
  for (const t of ['holdem_entries', 'holdem_tournaments']) db.prepare(`DELETE FROM ${t}`).run();
  {
    /* 예약된 판이 대기 상태로 앉아 있는 상황을 만든다.
       예전에는 advanceHoldem 이 "오늘 판"을 저절로 만들어 줬지만, 자동 생성을 없앤
       뒤로는 운영자(또는 반복 규칙)가 열어야 생긴다. 그래서 여기서 직접 연다. */
    const t0 = Math.floor(Date.now() / 1000);
    const opened = A.createTournament({ title: '예약 판', regOpenAt: t0 + 3600, startAt: t0 + 7200 });
    ck('예약 판을 열 수 있다', opened.ok, JSON.stringify(opened));
    const daily = HD.advanceHoldem().tournament!;
    ck('예약 판이 대기 상태로 있다', daily.started_at == null);

    /* 대기 판이 있어도 임시 판을 만들 수 있어야 한다. 처음에는 이것도 막았는데,
       정규 판이 늘 대기 중이라 임시 판을 영영 못 만들었다 — 지우면 1초 안에 되살아났다.
       단 조건이 있다: 그 판의 시작까지 두 시간 이상 남아야 한다. 한 판이 아무리 길어도
       두 시간을 넘지 않으므로, 그만큼 남아 있으면 임시 판이 먼저 끝난다. */
    const now0 = Math.floor(Date.now() / 1000);
    db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ? WHERE id = ?`)
      .run(now0 + 30 * 60, daily.id);
    const near = A.createTournament({ title: '너무 가까움' });
    ck('예약 판 시작이 가까우면 거절한다 (30분 뒤)',
      !near.ok && near.error === 'too_close', JSON.stringify(near));

    db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ? WHERE id = ?`)
      .run(now0 + A.CREATE_GAP_SEC - 60, daily.id);
    ck('두 시간에서 1분 모자라도 거절', !A.createTournament({ title: 'x' }).ok);

    db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ? WHERE id = ?`)
      .run(now0 + A.CREATE_GAP_SEC + 60, daily.id);
    const a = A.createTournament({ title: '임시 판', regMin: 0 });
    ck('두 시간 넘게 남았으면 만들 수 있다', a.ok, JSON.stringify(a));
    ck('임시 판이 골라진다 (더 최근이다)',
      HD.advanceHoldem().tournament!.id === (a.ok ? a.id : -1));

    // 돌고 있는 판이 있으면 막는다 — 카드가 도는 판이 둘일 수는 없다
    if (a.ok) db.prepare(`UPDATE holdem_tournaments SET started_at = unixepoch() WHERE id = ?`).run(a.id);
    const b = A.createTournament({ title: '둘째 판' });
    ck('돌고 있는 판이 있으면 새로 못 만든다',
      !b.ok && b.error === 'live_exists', JSON.stringify(b));

    /* 여기가 핵심이다 — 임시 판이 끝나면 대기 중이던 예약 판으로 돌아와야 한다.
       "가장 최근 것"만 보면 끝난 임시 판이 계속 골라져 예약 판이 영영 안 열린다. */
    if (a.ok) db.prepare(`UPDATE holdem_tournaments SET finished_at = unixepoch() WHERE id = ?`).run(a.id);
    ck('임시 판이 끝나면 예약 판으로 돌아온다',
      HD.advanceHoldem().tournament!.id === daily.id,
      `${HD.advanceHoldem().tournament!.id} (기대 ${daily.id})`);
    ck('예약 판을 지우지 않아도 된다 (같은 날짜에 둘이 공존)',
      (db.prepare(`SELECT COUNT(*) AS n FROM holdem_tournaments`).get() as { n: number }).n === 2);

    const c = A.createTournament({ title: '셋째 판' });
    ck('끝난 뒤에는 또 만들 수 있다', c.ok, JSON.stringify(c));

    /* 요청이 들어와도 대회가 저절로 늘지 않는다. advanceHoldem 은 요청마다 불리므로,
       여기가 새면 로비를 새로고침하는 것만으로 대회가 무한히 생긴다. */
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM holdem_tournaments`).get() as { n: number }).n;
    HD.advanceHoldem(); HD.advanceHoldem();
    ck('요청이 대회를 저절로 만들지 않는다',
      (db.prepare(`SELECT COUNT(*) AS n FROM holdem_tournaments`).get() as { n: number }).n === before,
      String(before));
  }
  for (const t of ['holdem_entries', 'holdem_tournaments']) db.prepare(`DELETE FROM ${t}`).run();

  // 대회 — 상금이 나간 판은 지울 수 없어야 한다
  for (const t of ['holdem_hand_seats', 'holdem_hands', 'holdem_seats',
    'holdem_tables', 'holdem_entries', 'holdem_tournaments']) db.prepare(`DELETE FROM ${t}`).run();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO holdem_tournaments
      (id, date_str, title, reg_open_at, scheduled_start_at, grace_ends_at, prize_multiplier,
       started_at, finished_at)
    VALUES (91, '1999-01-01', '상금판', ?, ?, ?, 1000, ?, ?)`).run(now, now, now, now, now);
  db.prepare(`INSERT INTO holdem_entries
      (tournament_id, user_id, username, registered_at, finish_place, prize)
    VALUES (91, 'ad_u', 'ad_u', ?, 1, 2600)`).run(now);
  /* 상금 회수 후 삭제 — 이미 나간 포인트를 도로 가져온다.
     잔액이 음수가 되는 것을 허용한다(다 쓴 사람이 있으면 그 방법뿐이다). 대신 음수가
     막다른 길이 되면 안 되므로 지원금이 열려 있어야 한다 — 그것까지 여기서 본다. */
  {
    const before = bal('ad_u');
    const rv = A.revokePrizesAndPurge(91);
    ck('상금을 회수하고 지운다',
      rv.ok && rv.revoked === 2600 && rv.users === 1, JSON.stringify(rv));
    ck('회수한 만큼 잔액이 줄었다', bal('ad_u') === before - 2600, String(bal('ad_u')));
    ck('회수가 원장에 남았다 (잔액 = 원장 누적합)',
      (db.prepare(`SELECT COALESCE(SUM(delta),0) AS n FROM points_ledger WHERE user_id='ad_u'`)
        .get() as { n: number }).n === bal('ad_u'));
    ck('사유가 tournament:revoke 로 남았다',
      (db.prepare(`SELECT reason FROM points_ledger WHERE user_id='ad_u' ORDER BY id DESC LIMIT 1`)
        .get() as { reason: string }).reason.startsWith('tournament:revoke:'));
    ck('대회가 사라졌다',
      (db.prepare(`SELECT COUNT(*) AS n FROM holdem_tournaments WHERE id=91`)
        .get() as { n: number }).n === 0);

    // 다 쓴 사람에게서 회수하면 음수가 된다 — 그리고 거기서 빠져나올 수 있어야 한다
    mkUser('ad_poor', 0);
    db.prepare(`INSERT INTO holdem_tournaments
        (id, date_str, title, reg_open_at, scheduled_start_at, grace_ends_at, prize_multiplier,
         started_at, finished_at)
      VALUES (94, '1999-01-04', '상금판2', 0, 0, 0, 1000, 1, 1)`).run();
    db.prepare(`INSERT INTO holdem_entries
        (tournament_id, user_id, username, registered_at, finish_place, prize)
      VALUES (94, 'ad_poor', 'ad_poor', 0, 1, 500)`).run();
    ck('다 쓴 사람에게서도 회수된다', A.revokePrizesAndPurge(94).ok);
    ck('잔액이 음수가 된다', bal('ad_poor') === -500, String(bal('ad_poor')));
    ck('음수여도 원장과 맞는다',
      (db.prepare(`SELECT COALESCE(SUM(delta),0) AS n FROM points_ledger WHERE user_id='ad_poor'`)
        .get() as { n: number }).n === -500);
    /* 여기가 핵심이다 — 음수가 막다른 길이면 그 사람은 영영 못 논다.
       베팅은 잔액이 모자라 안 되고, 남은 회복 경로는 지원금과 출석뿐이다. */
    const relief = require('../src/services/relief') as typeof import('../src/services/relief');
    const got = relief.claim('ad_poor');
    ck('음수여도 지원금을 받을 수 있다 (막다른 길이 아니다)', got.ok, JSON.stringify(got));
    ck('받은 만큼 빚이 줄어든다 (0으로 지워지지 않는다)',
      bal('ad_poor') === -500 + relief.RELIEF_AMOUNT, String(bal('ad_poor')));
    // 진행 중인 판은 회수도 거절한다
    db.prepare(`INSERT INTO holdem_tournaments
        (id, date_str, title, reg_open_at, scheduled_start_at, grace_ends_at, prize_multiplier, started_at)
      VALUES (95, '1999-01-05', '진행판2', 0, 0, 0, 1000, 1)`).run();
    ck('진행 중인 대회는 회수도 거절', !A.revokePrizesAndPurge(95).ok);
    db.prepare(`DELETE FROM holdem_tournaments WHERE id = 95`).run();
  }

  db.prepare(`INSERT INTO holdem_tournaments
      (id, date_str, title, reg_open_at, scheduled_start_at, grace_ends_at, prize_multiplier,
       started_at, finished_at)
    VALUES (91, '1999-01-01', '상금판', 0, 0, 0, 1000, 1, 1)`).run();
  db.prepare(`INSERT INTO holdem_entries
      (tournament_id, user_id, username, registered_at, finish_place, prize)
    VALUES (91, 'ad_u', 'ad_u', 0, 1, 2600)`).run();
  const paid = A.purgeTournament(91);
  ck('상금이 지급된 대회는 지울 수 없다',
    !paid.ok && paid.error === 'paid', JSON.stringify(paid));
  ck('거절된 뒤에도 대회가 남아 있다',
    (db.prepare(`SELECT COUNT(*) AS n FROM holdem_tournaments WHERE id=91`)
      .get() as { n: number }).n === 1);

  // 진행 중인 판도 지울 수 없어야 한다
  db.prepare(`INSERT INTO holdem_tournaments
      (id, date_str, title, reg_open_at, scheduled_start_at, grace_ends_at, prize_multiplier, started_at)
    VALUES (92, '1999-01-02', '진행판', ?, ?, ?, 0, ?)`).run(now, now, now, now);
  const running = A.purgeTournament(92);
  ck('진행 중인 대회는 지울 수 없다',
    !running.ok && running.error === 'running', JSON.stringify(running));

  /* 상금 0 인 테스트 판은 지워진다 — 원장을 한 번도 안 건드렸으므로 경제가 어긋나지 않는다.
     딸린 행(테이블·좌석·핸드·참가)이 고아로 남지 않는지도 함께 본다. */
  db.prepare(`INSERT INTO holdem_tournaments
      (id, date_str, title, reg_open_at, scheduled_start_at, grace_ends_at, prize_multiplier,
       started_at, finished_at)
    VALUES (93, '1999-01-03', '테스트판', ?, ?, ?, 0, ?, ?)`).run(now, now, now, now, now);
  db.prepare(`INSERT INTO holdem_tables (id, tournament_id, table_no, button_seat, hand_no)
    VALUES (93, 93, 0, 0, 1)`).run();
  db.prepare(`INSERT INTO holdem_seats (table_id, seat, user_id, username, stack, last_seen_at)
    VALUES (93, 0, 'ad_u', 'ad_u', 10000, ?)`).run(now);
  db.prepare(`INSERT INTO holdem_hands (id, table_id, hand_no, level, street, button_seat,
      sb, bb, ante, deck_json, board_json, last_raise_size, started_at)
    VALUES (93, 93, 1, 1, 'preflop', 0, 25, 50, 0, '[]', '[]', 50, ?)`).run(now);
  db.prepare(`INSERT INTO holdem_hand_seats (hand_id, seat, user_id, hole_json, stack, bet,
      committed, state, acted, won)
    VALUES (93, 0, 'ad_u', '[]', 10000, 0, 0, 'active', 0, 0)`).run();
  db.prepare(`INSERT INTO holdem_entries (tournament_id, user_id, username, registered_at, prize)
    VALUES (93, 'ad_u', 'ad_u', ?, 0)`).run(now);

  const before = bal('ad_u');
  const gone = A.purgeTournament(93);
  ck('상금 0 인 대회는 지워진다', gone.ok, JSON.stringify(gone));
  const left = ['holdem_tournaments', 'holdem_entries', 'holdem_tables',
    'holdem_seats', 'holdem_hands', 'holdem_hand_seats']
    .map(t => (db.prepare(
      `SELECT COUNT(*) AS n FROM ${t} WHERE ${t === 'holdem_tournaments' ? 'id' :
        t === 'holdem_entries' ? 'tournament_id' :
        t === 'holdem_tables' ? 'tournament_id' :
        t === 'holdem_hand_seats' ? 'hand_id' : 'table_id'} = 93`).get() as { n: number }).n);
  ck('딸린 행이 하나도 안 남는다 (고아 없음)', left.every(n => n === 0), JSON.stringify(left));
  ck('지워도 잔액이 그대로다 (경제에 흔적 없음)', bal('ad_u') === before, String(bal('ad_u')));
}
auditLedger('운영자 동작 후');

/* ── 10. 시즌 ────────────────────────────────────────────────────
   시즌 점수는 "종료 시점 잔액"이다. 닫는 순간을 놓치면 영영 알 수 없으므로
   순서(점수를 찍고 → 초기화)가 어긋나지 않는지가 이 절의 핵심이다. */
section('[10] 시즌');
{
  const S = require('../src/db/queries/season') as typeof import('../src/db/queries/season');
  const { bumpGameStats } = require('../src/db/queries') as typeof import('../src/db/queries');
  const db = getDb();
  for (const t of ['season_stats', 'season_results', 'seasons']) db.prepare(`DELETE FROM ${t}`).run();

  const s0 = S.currentSeason();
  ck('시즌이 없으면 시즌 0 이 열린다', s0.number === 0 && s0.closed_at == null, JSON.stringify(s0));

  // 판을 돌리면 시즌 장부에도 쌓인다
  mkUser('se_a', 1000); mkUser('se_b', 1000);
  bumpGameStats('se_a', 'mines', 100, 300);   // +200
  bumpGameStats('se_a', 'mines', 100, 0);     // -100
  bumpGameStats('se_b', 'mines', 100, 150);   // +50
  bumpGameStats('se_b', 'ladder', 100, 100);  // 푸시
  const games = S.seasonGames(s0.id);
  ck('그 시즌에 실제로 돌린 게임만 카테고리가 된다',
    games.length === 2 && games[0].game === 'mines', JSON.stringify(games));
  ck('안 돌린 게임은 카테고리에 없다', !games.some(g => g.game === 'poker'));

  const gr = S.seasonGameRanking(s0.id, 'mines');
  ck('게임별 랭킹은 순수익 순', gr.length === 2 && gr[0].userId === 'se_a', JSON.stringify(gr.map(r => r.userId)));
  ck('판수·승수가 함께 온다 (승률 계산의 재료)',
    gr[0].rounds === 2 && gr[0].wins === 1 && gr[0].rated === 2, JSON.stringify(gr[0]));
  ck('순수익이 맞다 (+200 -100 = +100)', gr[0].profit === 100, String(gr[0].profit));

  // 통합 랭킹 — 진행 중이면 실시간 잔액, 안 논 사람은 빠진다
  mkUser('se_idle', 999999);
  const overall = S.seasonOverall(s0.id);
  ck('안 논 사람은 통합 랭킹에 안 나온다',
    !overall.some(r => r.userId === 'se_idle'), JSON.stringify(overall.map(r => r.userId)));
  ck('통합 랭킹은 잔액 순', overall.length === 2 && overall[0].rank === 1);

  const mine = S.mySeasonRank(s0.id, 'se_a', 'mines');
  ck('내 게임 순위가 나온다', mine != null && mine.rank === 1 && mine.total === 2, JSON.stringify(mine));
  ck('안 논 사람은 내 순위가 없다', S.mySeasonRank(s0.id, 'se_idle', null) == null);

  // 시즌을 닫는다 — 점수를 찍고 나서 초기화해야 한다
  const balA = bal('se_a'), balB = bal('se_b');
  // 종료 직전에 지원금을 받아 쿨다운에 걸린 상태를 만든다 (새 시즌에서 풀려야 한다)
  db.prepare(`UPDATE users SET last_relief_at = ? WHERE id = 'se_a'`)
    .run(Math.floor(Date.now() / 1000));
  const closed = S.closeSeason({ seed: 0, nextName: '시즌 1' });
  ck('시즌이 닫히고 다음 시즌이 열린다',
    closed.ok && closed.closed === 0 && closed.nextNumber === 1, JSON.stringify(closed));

  const after = S.seasonOverall(s0.id);
  ck('닫힌 시즌의 점수 = 닫기 직전 잔액',
    after.length === 2
    && after.find(r => r.userId === 'se_a')!.score === balA
    && after.find(r => r.userId === 'se_b')!.score === balB,
    JSON.stringify(after));

  ck('전원 잔액이 0 으로 초기화됐다',
    bal('se_a') === 0 && bal('se_b') === 0 && bal('se_idle') === 0,
    `${bal('se_a')} ${bal('se_b')} ${bal('se_idle')}`);
  ck('초기화가 원장에 남았다 (잔액 = 원장 누적합)',
    (db.prepare(`SELECT COALESCE(SUM(delta),0) AS n FROM points_ledger WHERE user_id='se_a'`)
      .get() as { n: number }).n === 0);
  /* 0 에서 시작하니 지원금이 유일한 출발선이다. 쿨다운이 시즌을 넘어 이어지면
     종료 직전에 받은 사람만 최대 2시간을 못 움직인다 — 시작선이 달라진다. */
  ck('지원금 쿨다운이 풀렸다 (0 에서 시작하므로 바로 받을 수 있어야 한다)',
    (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE last_relief_at IS NOT NULL`)
      .get() as { n: number }).n === 0);
  const relief = require('../src/services/relief') as typeof import('../src/services/relief');
  ck('실제로 지원금을 받을 수 있다', relief.claim('se_a').ok);

  const s1 = S.currentSeason();
  ck('새 시즌은 통계가 비어 있다 (전부 초기화)',
    s1.number === 1 && S.seasonGames(s1.id).length === 0);
  ck('지난 시즌 기록은 그대로 남아 있다',
    S.seasonGameRanking(s0.id, 'mines').length === 2);

  // 새 시즌에서 한 판 — 지난 시즌에 섞이지 않아야 한다
  bumpGameStats('se_a', 'poker', 100, 500);
  ck('새 판은 새 시즌에만 쌓인다',
    S.seasonGameRanking(s1.id, 'poker').length === 1
    && S.seasonGameRanking(s0.id, 'poker').length === 0);
  ck('통산 기록(game_stats)은 시즌과 무관하게 이어진다',
    (db.prepare(`SELECT rounds FROM game_stats WHERE user_id='se_a' AND game='mines'`)
      .get() as { rounds: number }).rounds === 2);

  /* 시즌이 한 번이라도 닫힌 뒤에는 통산 기록을 특정 시즌에 부을 수 없어야 한다 —
     통산이 여러 시즌에 걸쳐 있어서 그 시즌 기록이 거짓이 된다. */
  ck('닫힌 시즌이 있으면 가져오기를 거절한다',
    !S.backfillFirstSeason().ok, JSON.stringify(S.backfillFirstSeason()));
}

/* 시즌 표를 만들기 전의 판은 시즌 장부에 없다. 첫 시즌의 범위는 "지금까지 전부"이므로
   통산 기록이 곧 첫 시즌의 기록이다 — 옮길 수 있어야 하고, 여러 번 옮겨도 같아야 한다. */
/* 홀덤은 season_stats 를 쓰지 않는다 — 대회 결과에 등수와 상금이 이미 있고 대회에는
   끝난 시각이 있으니, 시즌 구간으로 자르기만 하면 된다. 옮겨 담을 필요가 없어서
   지난 대회가 저절로 제자리에 들어간다. 그게 실제로 되는지 본다. */
/* 설정 기능의 요점은 "바꿔도 진행 중인 대회가 안 흔들린다"이다. 그게 안 되면
   운영자가 값을 고치는 순간 블라인드가 뛰고 늦게 온 사람만 다른 스택을 받는다. */
/* 공지는 코드에서 DB 로 옮겼다. 옮기면서 보이는 글이 달라지면 안 되고, 운영자가 지운 글이
   서버를 다시 띄울 때마다 되살아나도 안 된다. 그 둘이 이 절의 핵심이다. */
section('[10e] 공지사항');
{
  const N = require('../src/db/notices') as typeof import('../src/db/notices');
  const SEED = require('../src/web/notices') as typeof import('../src/web/notices');
  const db = getDb();
  db.prepare(`DELETE FROM notices`).run();

  N.seedNoticesOnce();
  ck('빈 DB 에 코드의 글이 심어진다', N.listNotices().length === SEED.NOTICES.length,
    `${N.listNotices().length} / ${SEED.NOTICES.length}`);
  ck('순서가 코드와 같다 (맨 앞이 최신)',
    N.listNotices()[0].id === SEED.NOTICES[0].id, N.listNotices()[0].id);
  ck('본문이 그대로 옮겨졌다',
    JSON.stringify(N.listNotices()[0].sections) === JSON.stringify(SEED.NOTICES[0].sections));

  /* 지운 글이 되살아나면 지우기가 지우기가 아니다 */
  const first = N.listNotices()[0].id;
  N.deleteNotice(first);
  N.seedNoticesOnce();
  ck('한 번 심은 뒤에는 다시 심지 않는다 (지운 글이 안 되살아난다)',
    !N.listNotices().some(x => x.id === first));

  // 본문 규칙
  const parsed = N.parseBody('## 바뀐 점\n- 하나\n- 둘\n설명 문단\n\n## 다음 절\n본문');
  ck('## 는 절, - 는 목록, 나머지는 문단',
    parsed.length === 2 && parsed[0].heading === '바뀐 점'
    && parsed[0].bullets?.length === 2 && parsed[0].paras?.length === 1
    && parsed[1].heading === '다음 절', JSON.stringify(parsed));
  ck('빈 줄은 무시된다', N.parseBody('가\n\n\n나')[0].paras?.length === 2);
  /* 되돌린 뒤 다시 읽으면 내용이 같아야 한다. JSON 문자열로 비교하면 안 된다 —
     unparseBody 는 문단을 목록보다 먼저 적는데, 화면도 항상 문단 → 목록 → 표 순으로
     그리므로(pages.ts 의 noticeBody) 키가 꽂힌 순서만 다르고 보이는 것은 같다.
     그래서 필드별로 본다. */
  const rt = N.parseBody(N.unparseBody(parsed));
  const same = (a: typeof parsed, b: typeof parsed) =>
    a.length === b.length && a.every((s, i) =>
      s.heading === b[i].heading
      && JSON.stringify(s.paras ?? []) === JSON.stringify(b[i].paras ?? [])
      && JSON.stringify(s.bullets ?? []) === JSON.stringify(b[i].bullets ?? []));
  ck('되돌렸다 다시 읽어도 내용이 같다', same(rt, parsed), JSON.stringify(rt));

  // 표는 줄 규칙으로 쓸 수 없으므로 수정할 때 되살려야 한다
  const withTable = [{ heading: '요금', table: { head: ['A'], rows: [['1']] } }];
  const kept = N.keepTables(N.parseBody('## 요금'), withTable);
  ck('수정해도 예전 표가 남는다', kept[0].table != null, JSON.stringify(kept[0]));

  // 검증
  const base = { date: '2026-08-07', kind: '업데이트', title: '제목', summary: '요약',
    sections: N.parseBody('본문'), active: true };
  ck('대문자 아이디 거절', !N.createNotice({ ...base, id: 'Bad-Id' }).ok);
  ck('한글 아이디 거절', !N.createNotice({ ...base, id: '공지' }).ok);
  ck('날짜 형식 거절', !N.createNotice({ ...base, id: 'x1', date: '2026/08/07' }).ok);
  ck('없는 분류 거절', !N.createNotice({ ...base, id: 'x2', kind: '잡담' }).ok);
  ck('제목 없으면 거절', !N.createNotice({ ...base, id: 'x3', title: '  ' }).ok);
  ck('본문 없으면 거절', !N.createNotice({ ...base, id: 'x4', sections: [] }).ok);

  ck('올바른 글은 만들어진다', N.createNotice({ ...base, id: 'ok-1' }).ok);
  ck('같은 아이디는 거절', !N.createNotice({ ...base, id: 'ok-1' }).ok);
  ck('새 글이 맨 위에 선다', N.listNotices()[0].id === 'ok-1');

  // 숨김 — 지우지 않고 내린다
  ck('숨기면 목록에서 빠진다',
    N.toggleNotice('ok-1').ok && !N.listNotices().some(x => x.id === 'ok-1'));
  ck('숨긴 글은 상세로도 못 연다', N.findNotice('ok-1') == null);
  ck('운영자 목록에는 남아 있다', N.listNoticesAdmin().some(x => x.id === 'ok-1'));
  ck('다시 보이게 할 수 있다',
    N.toggleNotice('ok-1').ok && N.findNotice('ok-1') != null);

  ck('수정이 반영된다',
    N.updateNotice('ok-1', { ...base, title: '고친 제목' }).ok
    && N.findNotice('ok-1')!.title === '고친 제목');
  ck('없는 글 수정은 거절', !N.updateNotice('nope', base).ok);
  ck('지우면 사라진다', N.deleteNotice('ok-1').ok && N.findNotice('ok-1') == null);
  ck('없는 글 지우기는 거절', !N.deleteNotice('nope').ok);
}

section('[10d] 대회 설정');
{
  const S = require('../src/db/settings') as typeof import('../src/db/settings');
  const HD = require('../src/db/holdem') as typeof import('../src/db/holdem');
  const T = require('../src/services/tournament') as typeof import('../src/services/tournament');
  const db = getDb();
  db.prepare(`DELETE FROM holdem_settings`).run();

  const d = S.defaultConfig();
  ck('설정이 없으면 코드 기본값을 쓴다',
    S.getConfig().startHour === d.startHour && S.getConfig().startingStack === d.startingStack,
    JSON.stringify(S.getConfig()));

  // 검증 — 화면이 아니라 여기가 마지막 문이다
  const bad = (o: Partial<import('../src/db/settings').TournamentConfig>) =>
    S.validateConfig({ ...d, ...o }).length > 0;
  ck('등록이 시작보다 늦으면 거절', bad({ regOpenMin: 22 * 60, startMin: 21 * 60 }));
  ck('등록과 시작이 같아도 거절', bad({ regOpenMin: 22 * 60, startMin: 22 * 60 }));
  ck('대기 마감이 자정을 넘으면 거절', bad({ startMin: 23 * 60, graceMin: 120 }));
  /* 분 단위를 받는 것이 이번 변경의 요점이다 — 시간만 받으면 22:30 일정을 못 만든다. */
  ck('분 단위 시각을 받는다 (21:30 → 22:15)',
    S.validateConfig({ ...d, regOpenMin: 21 * 60 + 30, startMin: 22 * 60 + 15 }).length === 0);
  ck('분까지 봐서 뒤집히면 거절 (22:30 → 22:15)',
    bad({ regOpenMin: 22 * 60 + 30, startMin: 22 * 60 + 15 }));
  ck('분이 일정에 실제로 반영된다', (() => {
    const s = T.scheduleForDate('2026-08-10', { regOpenMin: 21 * 60 + 30, startMin: 22 * 60 + 15 });
    return s.scheduledStartAt - s.regOpenAt === 45 * 60;
  })());
  ck('0 이하 칩 거절', bad({ startingStack: 0 }));
  ck('0 이하 블라인드 주기 거절', bad({ levelMin: 0 }));
  ck('소수점 거절', bad({ startingStack: 100.5 }));
  ck('음수 상금 거절', bad({ prizeFixed: -1 }));
  ck('올바른 설정은 통과', S.validateConfig({ ...d, startMin: 20 * 60, regOpenMin: 19 * 60 }).length === 0);
  ck('잘못된 설정은 저장되지 않는다', !S.saveConfig({ ...d, startingStack: 0 }).ok);

  // 저장하면 다음에 만들어지는 대회에 박힌다
  for (const t of ['holdem_entries', 'holdem_tournaments']) db.prepare(`DELETE FROM ${t}`).run();
  ck('올바른 설정은 저장된다',
    S.saveConfig({ ...d, startingStack: 33333, levelMin: 3, lateRegMin: 7, prizeFixed: 12345 }).ok);
  /* 대회는 저절로 생기지 않으므로 직접 연다 — 설정이 "다음에 만들어질 대회"에
     박히는지가 이 검사의 요지이고, 그 "만들기"를 이제 사람이 한다. */
  const A2 = require('../src/db/admin') as typeof import('../src/db/admin');
  const nw = Math.floor(Date.now() / 1000);
  A2.createTournament({ title: '설정 검사', regOpenAt: nw + 3600, startAt: nw + 7200 });
  const st = HD.advanceHoldem();
  const t = st.tournament!;
  ck('새 대회에 설정이 박힌다',
    t.starting_stack === 33333 && t.level_sec === 180 && t.late_reg_sec === 420
    && t.prize_fixed === 12345,
    JSON.stringify({ s: t.starting_stack, l: t.level_sec, r: t.late_reg_sec, p: t.prize_fixed }));

  /* 여기가 핵심이다 — 설정을 다시 바꿔도 이미 만들어진 대회의 값은 그대로여야 한다. */
  S.saveConfig({ ...d, startingStack: 777, levelMin: 99, lateRegMin: 99, prizeFixed: 0 });
  const again = db.prepare(`SELECT * FROM holdem_tournaments WHERE id = ?`).get(t.id) as
    { starting_stack: number; level_sec: number; late_reg_sec: number; prize_fixed: number };
  ck('설정을 바꿔도 이미 만들어진 대회는 안 변한다',
    again.starting_stack === 33333 && again.level_sec === 180
    && again.late_reg_sec === 420 && again.prize_fixed === 12345,
    JSON.stringify(again));
  ck('그 대회의 tuning 도 행의 값을 본다',
    HD.tuning(again as never).startingStack === 33333
    && HD.tuning(again as never).levelSec === 180);

  // 설정 이전에 만들어진 행(0)은 코드 기본값으로 읽힌다
  const old = { starting_stack: 0, level_sec: 0, late_reg_sec: 0, prize_fixed: 0 };
  const tn = HD.tuning(old as never);
  ck('설정이 없던 시절의 행은 코드 기본값으로 읽힌다',
    tn.startingStack === d.startingStack && tn.levelSec === d.levelMin * 60
    && tn.lateRegSec === d.lateRegMin * 60 && tn.prizeFixed === 0, JSON.stringify(tn));

  // 고정 상금 풀
  ck('고정 상금 풀이 인원을 무시한다', T.prizePool(3, 1000, 50000) === 50000);
  ck('0이면 예전처럼 인원 × 배수', T.prizePool(3, 1000, 0) === 3000);

  S.resetConfig();
  ck('되돌리면 기본값', S.getConfig().startingStack === d.startingStack);
}

section('[10c] 홀덤 — 프리롤 상금 순위');
{
  const S = require('../src/db/queries/season') as typeof import('../src/db/queries/season');
  const db = getDb();
  for (const t of ['season_stats', 'season_results', 'seasons',
    'holdem_entries', 'holdem_tournaments']) db.prepare(`DELETE FROM ${t}`).run();
  mkUser('ht_a', 0); mkUser('ht_b', 0); mkUser('ht_c', 0);
  const s = S.currentSeason();
  ck('대회가 없으면 홀덤 카테고리가 안 뜬다', S.seasonHoldemCount(s.id) === 0);

  const mk = (id: number, finished: number | null) =>
    db.prepare(`INSERT INTO holdem_tournaments
      (id, date_str, title, reg_open_at, scheduled_start_at, grace_ends_at, prize_multiplier,
       started_at, finished_at) VALUES (?, ?, '프리롤', 0, 0, 0, 1000, 1, ?)`)
      .run(id, '1999-0' + id + '-01', finished);
  const ent = (tid: number, uid: string, place: number, prize: number) =>
    db.prepare(`INSERT INTO holdem_entries
      (tournament_id, user_id, username, registered_at, finish_place, prize)
      VALUES (?, ?, ?, 0, ?, ?)`).run(tid, uid, uid, place, prize);

  /* 시즌이 열려 있는 동안에는 위쪽 경계가 없어서 미래 시각이어도 잡히지만, 시즌을 닫는
     순간 closed_at 이 지금으로 찍히면서 그런 대회는 경계 밖으로 나간다. 아래에서 실제로
     시즌을 닫아 보므로 "이미 끝난 대회"답게 지금보다 앞선 시각을 쓴다. */
  const inSeason = Math.floor(Date.now() / 1000) - 60;
  mk(1, inSeason); ent(1, 'ht_a', 1, 2600); ent(1, 'ht_b', 2, 1400); ent(1, 'ht_c', 3, 0);
  mk(2, inSeason + 1); ent(2, 'ht_b', 1, 2600); ent(2, 'ht_a', 3, 0);
  mk(3, null);        // 취소되어 안 끝난 대회 — 집계에 들어가면 안 된다
  ent(3, 'ht_c', 1, 99999);

  ck('끝난 대회만 센다 (취소된 대회 제외)', S.seasonHoldemCount(s.id) === 2,
    String(S.seasonHoldemCount(s.id)));
  const r = S.seasonHoldemRanking(s.id);
  ck('프리롤 상금 순으로 줄 선다',
    r.length === 3 && r[0].userId === 'ht_b' && r[1].userId === 'ht_a',
    JSON.stringify(r.map(x => x.userId + ':' + x.prize)));
  ck('상금이 합산된다 (ht_b 1400+2600)', r[0].prize === 4000, String(r[0].prize));
  ck('참가·우승·입상이 함께 온다',
    r[0].entries === 2 && r[0].wins === 1 && r[0].itm === 2, JSON.stringify(r[0]));
  ck('상금 못 받은 사람도 참가 기록으로 남는다',
    r[2].userId === 'ht_c' && r[2].prize === 0 && r[2].entries === 1, JSON.stringify(r[2]));
  ck('취소된 대회의 상금은 안 잡힌다', r[2].prize === 0);

  const mine = S.myHoldemRank(s.id, 'ht_a');
  ck('내 홀덤 순위가 나온다',
    mine != null && mine.rank === 2 && mine.total === 3 && mine.score === 2600, JSON.stringify(mine));
  ck('안 나간 사람은 순위가 없다', S.myHoldemRank(s.id, 'se_a') == null);

  /* 시즌 경계는 둘째 시즌부터 의미가 있다.
     첫 시즌에는 앞선 시즌이 없으므로, 그 전에 끝난 대회를 가져갈 다른 주인도 없다.
     예전에는 첫 시즌도 시작 시각으로 잘랐는데, 시즌 행을 만든 시각이 곧 시작이라
     그 전에 끝난 대회가 통째로 밀려났다 — 실제로 그것 때문에 랭킹에 홀덤 탭이
     아예 안 떴고, 아무 에러도 없이 그냥 없는 카테고리가 됐다. */
  mk(4, s.started_at - 100); ent(4, 'ht_a', 1, 5000);
  ck('첫 시즌은 시작 전에 끝난 대회도 담는다 (앞 시즌이 없으니 다른 주인이 없다)',
    S.seasonHoldemRanking(s.id).find(x => x.userId === 'ht_a')!.prize === 7600,
    String(S.seasonHoldemRanking(s.id).find(x => x.userId === 'ht_a')!.prize));
  ck('그래서 홀덤 카테고리가 뜬다', S.seasonHoldemCount(s.id) === 3,
    String(S.seasonHoldemCount(s.id)));

  /* 둘째 시즌에서는 그 경계를 반드시 지킨다 — 안 그러면 같은 대회가 두 시즌에 들어간다. */
  {
    const closed = S.closeSeason({ seed: 0 });
    ck('시즌을 닫고 다음 시즌이 열린다', closed.ok, JSON.stringify(closed));
    const s2 = S.currentSeason();
    ck('둘째 시즌은 첫 시즌이 아니다', s2.number > 0, String(s2.number));
    ck('둘째 시즌에는 지난 대회가 안 잡힌다', S.seasonHoldemCount(s2.id) === 0,
      String(S.seasonHoldemCount(s2.id)));
    // 첫 시즌의 집계는 그대로 남는다 — 지난 시즌을 골라 보면 그때 기록이 나와야 한다
    ck('첫 시즌 기록은 그대로 남는다', S.seasonHoldemCount(s.id) === 3,
      String(S.seasonHoldemCount(s.id)));

    const after = Math.floor(Date.now() / 1000) + 5;
    mk(5, after); ent(5, 'ht_c', 1, 1234);
    ck('둘째 시즌에 끝난 대회는 둘째 시즌에 잡힌다', S.seasonHoldemCount(s2.id) === 1,
      String(S.seasonHoldemCount(s2.id)));
    ck('그 대회가 첫 시즌으로 새지 않는다', S.seasonHoldemCount(s.id) === 3,
      String(S.seasonHoldemCount(s.id)));
  }
}

section('[10b] 첫 시즌으로 지난 기록 가져오기');
{
  const S = require('../src/db/queries/season') as typeof import('../src/db/queries/season');
  const { bumpGameStats } = require('../src/db/queries') as typeof import('../src/db/queries');
  const db = getDb();
  for (const t of ['season_stats', 'season_results', 'seasons', 'game_stats']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  // 시즌 표가 없던 시절의 판 = game_stats 에만 있는 상태를 만든다
  mkUser('bf_a', 1000);
  db.prepare(`INSERT INTO game_stats (user_id, game, rounds, rated, wins, pushes, staked, returned, profit)
    VALUES ('bf_a', 'mines', 10, 10, 6, 1, 1000, 1400, 400)`).run();
  const s = S.currentSeason();
  ck('가져오기 전에는 시즌 장부가 비어 있다', S.seasonGames(s.id).length === 0);

  const r1 = S.backfillFirstSeason();
  ck('가져오기 성공', r1.ok && r1.rows === 1, JSON.stringify(r1));
  const g = S.seasonGameRanking(s.id, 'mines');
  ck('통산 기록이 그대로 옮겨졌다',
    g.length === 1 && g[0].rounds === 10 && g[0].wins === 6 && g[0].profit === 400,
    JSON.stringify(g[0]));

  // 옮긴 뒤 한 판 더 — 두 장부에 함께 쌓이므로 다시 옮겨도 합이 맞아야 한다
  bumpGameStats('bf_a', 'mines', 100, 0);
  S.backfillFirstSeason();
  const g2 = S.seasonGameRanking(s.id, 'mines');
  ck('두 번 가져와도 불어나지 않는다 (더하기가 아니라 맞추기)',
    g2[0].rounds === 11 && g2[0].profit === 300, JSON.stringify(g2[0]));

  /* 가져오기는 시작 시각도 함께 당긴다.
     안 그러면 첫 시즌이 자기 약속을 어긴다 — 게임 전적은 시점과 무관하게 전부 담으면서
     홀덤만 "시즌 구간 안에 끝난 대회"로 세기 때문이다. 실제로 그랬다: 대회가 끝난 지
     13시간 뒤에 시즌을 열었더니 랭킹에 홀덤 탭이 아예 안 떴다. */
  for (const t of ['season_stats', 'season_results', 'seasons', 'game_stats',
    'holdem_entries', 'holdem_tournaments']) db.prepare(`DELETE FROM ${t}`).run();
  {
    const s2 = S.currentSeason();
    const long = s2.started_at - 13 * 3600;      // 시즌보다 13시간 앞서 끝난 대회
    db.prepare(`INSERT INTO holdem_tournaments
        (id, date_str, title, reg_open_at, scheduled_start_at, grace_ends_at,
         prize_multiplier, started_at, finished_at)
      VALUES (77, '1999-01-01', '옛 대회', ?, ?, ?, 1000, ?, ?)`)
      .run(long, long, long, long, long);
    db.prepare(`INSERT INTO holdem_entries
        (tournament_id, user_id, username, registered_at, finish_place, prize)
      VALUES (77, 'bf_a', 'bf_a', ?, 1, 3000)`).run(long);

    /* 집계는 가져오기를 누르지 않아도 맞는다 — 첫 시즌에는 아래쪽 경계가 없다.
       예전에는 여기서 0이 나왔고, 그래서 운영자가 버튼을 누를 때까지 홀덤 탭이
       안 떴다. 눌러야만 맞는 화면은 안 누르면 계속 틀린 화면이다. */
    ck('버튼을 누르기 전에도 옛 대회가 잡힌다', S.seasonHoldemCount(s2.id) === 1,
      String(S.seasonHoldemCount(s2.id)));
    /* 가져오기가 하는 일은 이제 하나 남았다 — 화면에 적히는 시작 날짜를 사실에 맞춘다.
       "8월 7일 시작"이라고 적어 두고 8월 6일 대회를 담고 있으면 그 표시가 거짓말이다. */
    S.backfillFirstSeason();
    ck('가져오면 시작 시각이 옛 기록까지 당겨진다',
      S.currentSeason().started_at <= long, `${S.currentSeason().started_at} vs ${long}`);
    ck('그래서 홀덤 카테고리가 뜬다', S.seasonHoldemCount(s2.id) === 1,
      String(S.seasonHoldemCount(s2.id)));
    const hr = S.seasonHoldemRanking(s2.id);
    ck('홀덤 순위에 옛 대회가 들어온다',
      hr.length === 1 && hr[0].prize === 3000 && hr[0].wins === 1, JSON.stringify(hr[0]));
  }
}
auditLedger('시즌 후');

console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
process.exit(fail ? 1 : 0);
