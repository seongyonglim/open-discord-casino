/* 프리롤 이월 감사.
 *
 * 이월은 서비스가 새로 발행하는 포인트다(프리롤은 참가비가 없다). 그래서 두 가지를
 * 반드시 지켜야 한다 — 쌓이는 규칙이 정확할 것, 그리고 나간 만큼이 원장에 남을 것.
 * 잔액 = points_ledger 누적합이 이 프로젝트의 유일한 불변식이고, 이월은 그 불변식을
 * 건드리는 몇 안 되는 길이다.
 *
 * 시간을 앞당길 수 없으므로 대회 행의 시각을 직접 과거로 당겨 자동 취소를 유도한다 —
 * tick 이 "시작 시각 + 유예가 지났는데 인원 미달" 을 보는 것이 조건이다.
 */
if (!process.env.DB_PATH) {
  const os = require('node:os'), path = require('node:path'), fsx = require('node:fs');
  process.env.DB_PATH = fsx.mkdtempSync(path.join(os.tmpdir(), 'casino-roll-'));
}
process.env.NO_SAMPLE = '1';

import { getDb } from '../src/db/schema';
import { one, all, run, upsertUser, adjustBalance, getWebUser } from '../src/db/queries';
import * as A from '../src/db/admin';
import * as HD from '../src/db/holdem';
import * as R from '../src/db/rollover';
import * as T from '../src/services/tournament';

let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
function section(s: string): void { console.log('\n' + s); }

const db = getDb();
const now = () => Math.floor(Date.now() / 1000);

function ledgerOk(): boolean {
  const users = all<{ id: string; balance: number }>(`SELECT id, balance FROM users`);
  for (const u of users) {
    const sum = one<{ s: number }>(
      `SELECT COALESCE(SUM(delta),0) AS s FROM points_ledger WHERE user_id = ?`, u.id)!.s;
    if (sum !== u.balance) { console.log(`    (${u.id}: 원장합 ${sum} ≠ 잔액 ${u.balance})`); return false; }
  }
  return true;
}

/** 인원 미달 상태의 프리롤을 하나 열고, 시각을 과거로 당겨 자동 취소를 부른다. */
function clearLive(): void {
  /* 앞 절이 남긴 대기 판이 있으면 새 판을 못 연다(too_close). 시험마다 정리하고 시작한다. */
  run(`UPDATE holdem_tournaments SET cancelled_at = unixepoch()
        WHERE finished_at IS NULL AND cancelled_at IS NULL`);
}

function cancelOneFreeroll(mult: number, entrants: string[] = []): void {
  clearLive();
  const made = A.createTournament({
    title: '이월 시험', prizeMultiplier: mult, buyIn: 0,
    regOpenAt: now() - 120, startAt: now() - 60,
  });
  if (!made.ok) throw new Error('대회를 못 열었다: ' + made.error);
  for (const u of entrants) HD.registerHoldem(u, u);
  /* 유예까지 지난 것으로 만든다 — tick 의 취소 조건이 그것이다 */
  run(`UPDATE holdem_tournaments SET grace_ends_at = ? WHERE id = ?`, now() - 1, made.id);
  HD.advanceHoldem();
}

function main(): void {
  section('[1] 쌓이는 규칙 — 못 열린 횟수만큼 배수가 오른다');
  {
    ck('처음에는 이월이 없다 (배수 1배)', R.rolloverFactor() === 1, String(R.rolloverFactor()));

    cancelOneFreeroll(5000);
    ck('1회 취소 → 2배', R.rolloverFactor() === 2, String(R.rolloverFactor()));
    cancelOneFreeroll(5000);
    cancelOneFreeroll(5000);
    ck('3회 취소 → 4배', R.rolloverFactor() === 4, String(R.rolloverFactor()));
  }

  section('[2] 상한 — 끝없이 커지지 않는다');
  {
    for (let i = 0; i < 6; i++) cancelOneFreeroll(5000);
    ck(`${R.ROLLOVER_MAX}배에서 멈춘다`, R.rolloverFactor() === R.ROLLOVER_MAX,
      `${R.rolloverFactor()}배`);
  }

  section('[3] 배수가 대회 행에 굳어 들어간다');
  {
    /* 이월이 걸린 상태에서 새 판을 열면 그 판의 prize_multiplier 가 이미 곱해져 있어야
       한다. 실행 시점에 곱하면 대회가 끝나고 이월이 0 이 된 뒤 결과 화면이 원래 값으로
       다시 계산해 "받은 돈보다 적은 상금표"를 그린다. */
    const f = R.rolloverFactor();
    clearLive();
    const made = A.createTournament({
      title: '굳힘 시험', prizeMultiplier: 5000, buyIn: 0,
      regOpenAt: now() + 600, startAt: now() + 1200,
    });
    if (!made.ok) throw new Error('대회를 못 열었다: ' + made.error);
    const row = one<{ prize_multiplier: number }>(
      `SELECT prize_multiplier FROM holdem_tournaments WHERE id = ?`, made.id)!;
    ck(`배수 5,000 × ${f}배 = ${5000 * f} 로 저장된다`,
      row.prize_multiplier === 5000 * f, String(row.prize_multiplier));

    /* 그 값으로 계산한 상금 팟이 인원에 비례하는지 */
    const t = one<any>(`SELECT * FROM holdem_tournaments WHERE id = ?`, made.id)!;
    ck('상금 팟 = 인당 금액 × 인원', HD.prizePoolOf(t, 3, 0) === 5000 * f * 3,
      String(HD.prizePoolOf(t, 3, 0)));

    run(`UPDATE holdem_tournaments SET cancelled_at = unixepoch() WHERE id = ?`, made.id);
  }

  section('[4] 참가비 대회에는 이월이 안 걸린다');
  {
    clearLive();
    const made = A.createTournament({
      title: '참가비 시험', prizeMultiplier: 5000, buyIn: 2000,
      regOpenAt: now() + 600, startAt: now() + 1200,
    });
    if (!made.ok) throw new Error('대회를 못 열었다: ' + made.error);
    const row = one<{ prize_multiplier: number }>(
      `SELECT prize_multiplier FROM holdem_tournaments WHERE id = ?`, made.id)!;
    ck('참가비 대회 배수는 그대로 5,000', row.prize_multiplier === 5000, String(row.prize_multiplier));
    run(`UPDATE holdem_tournaments SET cancelled_at = unixepoch() WHERE id = ?`, made.id);

    /* 참가비 대회가 인원 미달로 취소돼도 이월은 안 오른다 — 걷은 돈이 상금이라
       서비스가 얹는 배수가 없다. */
    const before = R.rolloverFactor();
    clearLive();
    const m2 = A.createTournament({
      title: '참가비 취소', prizeMultiplier: 5000, buyIn: 2000,
      regOpenAt: now() - 120, startAt: now() - 60,
    });
    if (!m2.ok) throw new Error('대회를 못 열었다: ' + m2.error);
    run(`UPDATE holdem_tournaments SET grace_ends_at = ? WHERE id = ?`, now() - 1, m2.id);
    HD.advanceHoldem();
    ck('참가비 대회 취소는 이월을 올리지 않는다', R.rolloverFactor() === before,
      `${before} → ${R.rolloverFactor()}`);
  }

  section('[5] 운영자가 손으로 접은 판은 세지 않는다');
  {
    const before = R.rolloverFactor();
    clearLive();
    const made = A.createTournament({
      title: '수동 취소 시험', prizeMultiplier: 5000, buyIn: 0,
      regOpenAt: now() - 120, startAt: now() + 1200,
    });
    if (!made.ok) throw new Error('대회를 못 열었다: ' + made.error);
    run(`UPDATE holdem_tournaments SET cancelled_at = unixepoch() WHERE id = ?`, made.id);
    ck('수동 취소는 이월을 올리지 않는다', R.rolloverFactor() === before,
      `${before} → ${R.rolloverFactor()}`);
  }

  section('[6] 정상 종료 — 지급하고 이월을 0 으로 되돌린다');
  {
    R.clearRollover();
    cancelOneFreeroll(1000);
    cancelOneFreeroll(1000);
    const factor = R.rolloverFactor();
    ck('시작 전 이월 3배', factor === 3, `${factor}배`);

    const users = ['roll-a', 'roll-b', 'roll-c'];
    for (const u of users) { upsertUser(u, u, null); }
    const before = users.map(u => getWebUser(u)!.balance);

    clearLive();
    const made = A.createTournament({
      title: '정상 종료 시험', prizeMultiplier: 1000, buyIn: 0,
      regOpenAt: now() - 60, startAt: now() - 30,
    });
    if (!made.ok) throw new Error('대회를 못 열었다: ' + made.error);
    for (const u of users) HD.registerHoldem(u, u);
    HD.advanceHoldem();                              // 최소 인원이 찼으니 시작한다

    const t0 = one<any>(`SELECT * FROM holdem_tournaments WHERE id = ?`, made.id)!;
    ck('대회가 시작됐다', t0.started_at != null, JSON.stringify({ s: t0.started_at }));
    const pool = HD.prizePoolOf(t0, users.length, 0);
    ck(`상금 팟 = 1,000 × ${factor}배 × 3명 = ${1000 * factor * 3}`,
      pool === 1000 * factor * 3, String(pool));

    /* 여기서 판을 끝까지 돌리지는 않는다 — 카드를 돌려 우승자를 내는 것은 시간이
       걸리고, 그 경로는 audit-tourney 가 이미 무인으로 완주시킨다. 그쪽에 "끝나면
       이월이 0 이 된다" 를 한 줄 얹어 두었다. 여기서는 되돌리는 동작 자체만 본다. */
    R.clearRollover();
    ck('정산 뒤 이월이 0 으로 돌아간다', R.rolloverFactor() === 1, `${R.rolloverFactor()}배`);
  }

  section('[7] 원장 정합성');
  {
    ck('모든 유저: 잔액 = 원장 누적합', ledgerOk());
    /* 이월 자체는 포인트를 만들지 않는다. 배수를 바꿀 뿐이고 실제 발행은 대회가 끝나
       상금이 나갈 때 한 번만 일어난다 — 그 경로는 audit-tourney 가 완주로 확인한다.
       여기서는 반대를 본다: 취소만 아홉 번 반복하는 동안 원장에 단 한 줄도 늘지
       않아야 한다. 늘었다면 열리지도 않은 판이 포인트를 발행한 것이다. */
    const led = one<{ n: number }>(`SELECT COUNT(*) AS n FROM points_ledger`)!.n;
    ck('취소만 반복한 동안 원장이 늘지 않았다', led === 0, `${led}줄`);
    const bal = one<{ n: number }>(`SELECT COALESCE(SUM(balance),0) AS n FROM users`)!.n;
    ck('발행된 포인트가 없다', bal === 0, `${bal}P`);
  }

  console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main();
