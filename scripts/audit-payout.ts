/* 지급액 감사 — 내림 규칙과 이중 지급.
 *
 * 이 파일이 있는 이유는 두 종류의 사고가 감사 그물을 통째로 빠져나갔기 때문이다.
 *
 * 1) 내림이 한 칸 더 내려가던 것.
 *    배당은 소수 둘째 자리까지 쓰는데(16.83, 1.13 …) 그 값을 double 에 담으면 참값보다
 *    아주 조금 작아지는 것이 있다. amount * odds 를 그대로 내림하면 그 미세한 손실이
 *    한 칸이 되어 나간다 — 바카라 페어 100P 가 1,683P 가 아니라 1,682P 였고, 지뢰찾기는
 *    30개 조합에서 1P 씩 덜 나갔다. 방향은 언제나 유저 손해 쪽이었다.
 *    기존 감사가 못 잡은 까닭이 뼈아프다: 기대값을 똑같은 식(Math.floor(x * odds))으로
 *    계산했기 때문이다. 틀린 식으로 틀린 값을 검사하면 영원히 통과한다.
 *    그래서 여기서는 기대값을 **다른 방법으로** 만든다 — 정수 산술과 조합수로.
 *
 * 2) 끝난 베팅에 다시 지급하던 것.
 *    크래시는 터져서 진 베팅이 payout=0 · cashout_multiplier=NULL 로 남는데, 캐시아웃
 *    가드가 뒤엣것만 봐서 그 베팅에 다시 돈을 줬다. 포커 플립은 정산 상수를 늘려
 *    배포하면 이미 끝난 판이 앞 단계로 되돌아가 같은 베팅을 두 번 지급했다.
 *    둘 다 "걸지 않은 포인트가 생기는" 자리다.
 */
if (!process.env.DB_PATH) {
  const os = require('node:os'), path = require('node:path'), fsx = require('node:fs');
  process.env.DB_PATH = fsx.mkdtempSync(path.join(os.tmpdir(), 'casino-payout-'));
}
process.env.NO_SAMPLE = '1';

import { getDb } from '../src/db/schema';
import { one, all, run, upsertUser, adjustBalance, getWebUser, payoutAt } from '../src/db/queries';
import { minesPayout, calcMultiplier, TILE_COUNT, ALLOWED_MINE_COUNTS } from '../src/web/games/mines';

let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
function section(s: string): void { console.log('\n' + s); }

getDb();

function ledgerOk(): boolean {
  for (const u of all<{ id: string; balance: number }>(`SELECT id, balance FROM users`)) {
    const s = one<{ s: number }>(
      `SELECT COALESCE(SUM(delta),0) AS s FROM points_ledger WHERE user_id = ?`, u.id)!.s;
    if (s !== u.balance) { console.log(`    (${u.id}: 원장합 ${s} != 잔액 ${u.balance})`); return false; }
  }
  return true;
}

console.log('지급액 감사');

/* ── [1] payoutAt — 정수로 센 기대값과 맞는가 ────────────────────────── */
section('[1] 배당 곱셈이 참값의 내림과 같은가');
{
  /* 기대값을 부동소수로 만들면 검사가 무의미하다(같은 실수를 두 번 하는 셈이다).
     배당을 1/100 단위 정수로 되돌려 정수끼리만 곱한다. */
  const exact = (amount: number, oddsCents: number) => Math.floor((amount * oddsCents) / 100);

  const ODDS_CENTS = [195, 200, 206, 1057, 1683, 113, 101, 1000, 333, 999];
  let mismatch = 0, naiveWrong = 0;
  for (const c of ODDS_CENTS) {
    const odds = c / 100;
    for (let amount = 1; amount <= 3000; amount++) {
      const want = exact(amount, c);
      if (payoutAt(amount, odds) !== want) mismatch++;
      if (Math.floor(amount * odds) !== want) naiveWrong++;
    }
  }
  ck('payoutAt 이 참값의 내림과 언제나 같다', mismatch === 0, `어긋남 ${mismatch}건`);
  /* 옛 방식이 실제로 틀렸다는 것도 같이 확인한다. 이게 0 이 되면 이 감사가 지키는
     대상이 사라졌다는 뜻이므로, 그때는 검사를 지우는 것이 아니라 왜 그런지 봐야 한다. */
  ck('옛 방식(그냥 곱해서 내림)은 실제로 어긋난다', naiveWrong > 0, `어긋남 ${naiveWrong}건`);

  ck('페어 100P × 16.83 = 1,683P', payoutAt(100, 16.83) === 1683, String(payoutAt(100, 16.83)));
  ck('크래시 100P × 1.13 = 113P', payoutAt(100, 1.13) === 113, String(payoutAt(100, 1.13)));
  ck('0P 는 0P', payoutAt(0, 2.06) === 0);
  ck('1배는 원금 그대로', payoutAt(12345, 1) === 12345);
}

/* ── [2] 지뢰찾기 — 조합수로 센 정확값 ─────────────────────────────── */
section('[2] 지뢰찾기 지급이 정확값의 내림과 같은가');
{
  /* 정확값: bet × 99 × C(25,k) / (100 × C(25-M,k)).
     여기서는 minesPayout 과 다른 길로 센다 — 곱셈 누적을 BigInt 로 해서 나눗셈을
     맨 마지막에 한 번만 한다. 두 길이 만나면 값이 맞는 것이다. */
  const exact = (bet: number, mines: number, k: number): number => {
    if (k <= 0) return bet;
    let num = 99n * BigInt(bet), den = 100n;
    for (let i = 0; i < k; i++) {
      num *= BigInt(TILE_COUNT - i);
      den *= BigInt(TILE_COUNT - mines - i);
    }
    return Number(num / den);
  };

  let bad = 0, oldShort = 0, over = 0;
  const BETS = [1, 4, 7, 33, 100, 999, 1000, 12345, 1_000_000];
  for (const m of ALLOWED_MINE_COUNTS) {
    for (let k = 1; k <= TILE_COUNT - m; k++) {
      for (const bet of BETS) {
        const want = exact(bet, m, k);
        const got = minesPayout(bet, m, k);
        if (got !== want) bad++;
        const old = Math.floor(bet * calcMultiplier(m, k));
        if (old < want) oldShort++;
        if (old > want) over++;
      }
    }
  }
  ck('지급이 정확값과 언제나 같다', bad === 0, `어긋남 ${bad}건`);
  ck('옛 방식은 실제로 덜 줬다', oldShort > 0, `덜 준 조합 ${oldShort}건`);
  ck('옛 방식이 더 준 적은 없다(고쳐도 발행이 늘지 않는다)', over === 0, `${over}건`);

  ck('지뢰 1개 · 10칸 · 1,000P = 1,650P', minesPayout(1000, 1, 10) === 1650, String(minesPayout(1000, 1, 10)));
  ck('지뢰 1개 · 24칸 · 1,000P = 24,750P', minesPayout(1000, 1, 24) === 24750, String(minesPayout(1000, 1, 24)));
  ck('지뢰 1개 · 24칸 · 4P = 99P', minesPayout(4, 1, 24) === 99, String(minesPayout(4, 1, 24)));
  ck('한 칸도 안 열면 원금 그대로', minesPayout(777, 5, 0) === 777);
}

/* ── [3] 크래시 — 끝난 베팅에 다시 주지 않는가 ─────────────────────── */
section('[3] 이미 진 베팅에 캐시아웃이 먹히지 않는가');
{
  const CR = require('../src/db/queries') as typeof import('../src/db/queries');
  upsertUser('c1', 'c1', null);
  adjustBalance('c1', 10000, 'audit:seed');

  run(`INSERT INTO crash_rounds (phase, crash_point, betting_ends_at, started_at_ms)
       VALUES ('done', 2.0, ?, ?)`,
    Math.floor(Date.now() / 1000) - 60, Date.now() - 50000);
  const rid = one<{ id: number }>(`SELECT id FROM crash_rounds ORDER BY id DESC LIMIT 1`)!.id;

  /* 터져서 진 베팅의 모양을 그대로 만든다 — 라운드 마감이 payout 에 0 을 적고
     cashout_multiplier 는 NULL 로 둔다. 예전 가드는 뒤엣것만 봐서 그냥 통과했다. */
  run(`INSERT INTO crash_bets (round_id, user_id, username, amount, payout)
       VALUES (?, 'c1', 'c1', 1000, 0)`, rid);
  adjustBalance('c1', -1000, 'game:graph:bet');

  const before = getWebUser('c1')!.balance;
  const r = CR.cashoutCrashBet('c1', rid, 1.99);
  ck('거절된다', r.ok === false, JSON.stringify(r));
  ck('잔액이 늘지 않는다', getWebUser('c1')!.balance === before,
    `${getWebUser('c1')!.balance} != ${before}`);
  ck('원장이 어긋나지 않는다', ledgerOk());

  // 정상 캐시아웃은 여전히 된다 (가드가 산 사람까지 막으면 안 된다)
  run(`INSERT INTO crash_rounds (phase, crash_point, betting_ends_at, started_at_ms)
       VALUES ('running', 5.0, ?, ?)`,
    Math.floor(Date.now() / 1000) - 5, Date.now() - 4000);
  const rid2 = one<{ id: number }>(`SELECT id FROM crash_rounds ORDER BY id DESC LIMIT 1`)!.id;
  run(`INSERT INTO crash_bets (round_id, user_id, username, amount) VALUES (?, 'c1', 'c1', 1000)`, rid2);
  adjustBalance('c1', -1000, 'game:graph:bet');
  const b2 = getWebUser('c1')!.balance;
  const ok = CR.cashoutCrashBet('c1', rid2, 1.13);
  ck('아직 살아 있는 베팅은 정상 지급된다', ok.ok === true, JSON.stringify(ok));
  ck('지급이 참값의 내림이다 (1,000 × 1.13 = 1,130)',
    getWebUser('c1')!.balance === b2 + 1130, String(getWebUser('c1')!.balance - b2));
  ck('그 뒤 다시 부르면 거절된다', CR.cashoutCrashBet('c1', rid2, 3).ok === false);
  ck('원장이 어긋나지 않는다', ledgerOk());
}

/* ── [4] 포커 플립 — 정산된 판이 되돌아가지 않는가 ─────────────────── */
section('[4] 정산이 끝난 판은 단계가 되돌아가지 않는가');
{
  const src = require('node:fs').readFileSync('src/db/queries/poker.ts', 'utf8') as string;
  /* 이 둘은 코드로 확인한다. 되돌림을 재현하려면 정산 상수를 늘려 "배포"해야 하는데,
     그건 감사가 흉내 낼 수 있는 일이 아니다. 대신 근거가 phase 가 아니라 result_json
     이라는 것을 못 박는다 — 그것이 이 결함의 원인이었다. */
  ck('정산 여부를 result_json 으로 가린다',
    /const settled = round\.result_json != null;/.test(src));
  ck('되돌리는 UPDATE 가 정산된 판을 건드리지 않는다',
    /UPDATE poker_rounds SET phase = \? WHERE id = \? AND result_json IS NULL/.test(src));
  ck('지급 갈래가 phase 가 아니라 정산 여부로 들어간다',
    /if \(phase === 'done' && !settled\)/.test(src));
}

console.log('\n──────────────────────────────────────────────────');
console.log(`통과 ${pass} · 실패 ${fail}`);
if (fail > 0) process.exit(1);
