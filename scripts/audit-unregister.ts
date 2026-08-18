/* 신청 취소 감사.
 *
 * 취소는 돈이 되돌아 나가는 몇 안 되는 자리다(대회 인원 미달 환불과 같은 길을 쓴다).
 * 그래서 "취소가 되는가" 만으로는 모자라고, 세 가지를 같이 지켜야 한다.
 *   1. 되돌린 액수가 걷은 액수와 정확히 같을 것 — 잔액 = points_ledger 누적합
 *   2. 취소가 닿지 않는 상태가 없을 것 — 닿지 않으면 참가비가 묶인다
 *   3. 화면에 뜨는 말이 실제로 일어난 일과 같을 것 — 돈은 돌아갔는데 "실패"라고
 *      말하면 묶인 줄 알고 문의가 온다
 *
 * 2와 3은 실제로 어긋나 있었다. 살아 있는 대회가 둘일 때 나중에 만든 판만 다뤄져서
 * 먼저 열릴 판의 참가자는 취소를 못 했고(참가비가 묶였다), 유예가 지난 뒤 누른 취소는
 * 환불이 나갔는데도 "지금은 취소할 수 없습니다"가 떴다. 여기서 그 둘을 못 박는다.
 */
if (!process.env.DB_PATH) {
  const os = require('node:os'), path = require('node:path'), fsx = require('node:fs');
  process.env.DB_PATH = fsx.mkdtempSync(path.join(os.tmpdir(), 'casino-unreg-'));
}
process.env.NO_SAMPLE = '1';

import { getDb } from '../src/db/schema';
import { one, all, run, upsertUser, adjustBalance, getWebUser } from '../src/db/queries';
import * as A from '../src/db/admin';
import * as HD from '../src/db/holdem';
import * as T from '../src/services/tournament';

let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
function section(s: string): void { console.log('\n' + s); }

getDb();
const now = () => Math.floor(Date.now() / 1000);

/** 이 프로젝트의 유일한 불변식. 돈을 건드린 검사는 끝에 반드시 이걸 본다. */
function ledgerOk(): boolean {
  for (const u of all<{ id: string; balance: number }>(`SELECT id, balance FROM users`)) {
    const s = one<{ s: number }>(
      `SELECT COALESCE(SUM(delta),0) AS s FROM points_ledger WHERE user_id = ?`, u.id)!.s;
    if (s !== u.balance) { console.log(`    (${u.id}: 원장합 ${s} != 잔액 ${u.balance})`); return false; }
  }
  return true;
}
/** 앞 절이 남긴 대기 판이 있으면 새 판을 못 연다(too_close). 절마다 치우고 시작한다. */
function clearLive(): void {
  run(`UPDATE holdem_tournaments SET cancelled_at = unixepoch()
        WHERE finished_at IS NULL AND cancelled_at IS NULL`);
}
function mk(id: string, bal: number): void {
  upsertUser(id, id, id);
  const have = getWebUser(id)?.balance ?? 0;
  if (have !== bal) adjustBalance(id, bal - have, 'audit:seed');
}
const open = (o: { buyIn?: number; mult?: number; inMin?: number }) =>
  A.createTournament({
    startAt: now() + (o.inMin ?? 10) * 60, regOpenMin: 1,
    buyIn: o.buyIn ?? 0, prizeMultiplier: o.mult ?? 5000,
  } as never) as { ok: true; id: number };

console.log('신청 취소 감사');

/* ── [1] 참가비 환불 ─────────────────────────────────────────────── */
section('[1] 참가비 환불 — 걷은 액수와 되돌린 액수가 같은가');
{
  clearLive();
  open({ buyIn: 2000, mult: 0 });
  mk('u-a', 10000);
  const before = getWebUser('u-a')!.balance;
  HD.registerHoldem('u-a', 'u-a');
  const paid = before - getWebUser('u-a')!.balance;
  ck('신청하면 참가비만큼 줄어든다', paid === 2000, `줄어든 액수 ${paid}`);
  const r = HD.unregisterHoldem('u-a');
  ck('취소가 성공한다', r.ok === true, JSON.stringify(r));
  ck('낸 만큼 정확히 돌아온다', getWebUser('u-a')!.balance === before,
    `${getWebUser('u-a')!.balance} != ${before}`);
  ck('원장이 어긋나지 않는다', ledgerOk());
}

/* ── [2] 연타 ───────────────────────────────────────────────────── */
section('[2] 취소를 두 번 눌러도 두 번 돌려주지 않는다');
{
  const before = getWebUser('u-a')!.balance;
  const r2 = HD.unregisterHoldem('u-a');
  ck('두 번째는 거절된다', r2.ok === false, JSON.stringify(r2));
  ck('두 번째 취소로 잔액이 늘지 않는다', getWebUser('u-a')!.balance === before);
  ck('원장이 어긋나지 않는다', ledgerOk());
}

/* ── [3] 등록과 취소 되풀이 ──────────────────────────────────────── */
section('[3] 등록과 취소를 스무 번 되풀이해도 잔액이 제자리다');
{
  const before = getWebUser('u-a')!.balance;
  for (let i = 0; i < 20; i++) { HD.registerHoldem('u-a', 'u-a'); HD.unregisterHoldem('u-a'); }
  ck('잔액이 그대로다', getWebUser('u-a')!.balance === before,
    `${getWebUser('u-a')!.balance} != ${before}`);
  ck('원장이 어긋나지 않는다', ledgerOk());
}

/* ── [4] 인원 대기 중 취소 ───────────────────────────────────────── */
section('[4] 인원 대기 중(WAITING_MIN_PLAYERS)에도 취소된다');
{
  clearLive();
  const t = open({ buyIn: 0, mult: 5000, inMin: 1 });
  mk('u-b', 10000);
  HD.registerHoldem('u-b', 'u-b');
  /* 시각을 앞당길 수 없으니 예정 시각을 지난 것으로 만든다. 유예는 남겨 둔다 —
     그것까지 지나면 자동 취소로 넘어가 [5]가 볼 상태가 된다. */
  run(`UPDATE holdem_tournaments SET scheduled_start_at = ? WHERE id = ?`, now() - 5, t.id);
  const st = HD.advanceHoldem();
  ck('상태가 인원 대기다', st.status === 'WAITING_MIN_PLAYERS', String(st.status));
  const r = HD.unregisterHoldem('u-b');
  ck('그래도 취소된다', r.ok === true, JSON.stringify(r));
  ck('원장이 어긋나지 않는다', ledgerOk());
}

/* ── [5] 유예가 지난 뒤 누른 취소 ─────────────────────────────────── */
section('[5] 유예가 지난 뒤 누르면 — 돈은 돌아가고, 말도 그렇게 한다');
{
  clearLive();
  const t = open({ buyIn: 3000, mult: 0 });
  mk('u-c', 10000);
  const before = getWebUser('u-c')!.balance;
  HD.registerHoldem('u-c', 'u-c');
  run(`UPDATE holdem_tournaments SET grace_ends_at = ? WHERE id = ?`, now() - 1, t.id);

  const r = HD.unregisterHoldem('u-c');
  /* 여기서 closed 가 오면 화면에 "지금은 취소할 수 없습니다"가 뜬다 — 환불은 이미
     나간 뒤인데도 그렇다. 그 말이 사실과 어긋나는 것을 막는 검사다. */
  ck('실패 사유가 auto_cancelled 다 (closed 가 아니다)',
    r.ok === false && (r as { error: string }).error === 'auto_cancelled', JSON.stringify(r));
  ck('참가비는 실제로 돌아왔다', getWebUser('u-c')!.balance === before,
    `${getWebUser('u-c')!.balance} != ${before}`);
  ck('대회가 취소 상태다',
    one<{ c: number | null }>(
      `SELECT cancelled_at AS c FROM holdem_tournaments WHERE id = ?`, t.id)!.c != null);
  ck('원장이 어긋나지 않는다', ledgerOk());
}

/* ── [6] 살아 있는 대회가 둘일 때 ─────────────────────────────────── */
section('[6] 대기 중인 대회가 둘이어도 먼저 열릴 판을 다룬다');
{
  clearLive();
  /* 운영자가 정상 조작으로 만들 수 있는 상태다: createTournament 의 간격 검사는
     기존 판의 시작 시각을 "지금"과 견줄 뿐, 새로 만드는 판과는 비교하지 않는다. */
  const early = open({ buyIn: 2000, mult: 0, inMin: 3 * 60 });
  const late = open({ buyIn: 2000, mult: 0, inMin: 6 * 60 });
  const live = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM holdem_tournaments
      WHERE finished_at IS NULL AND cancelled_at IS NULL`)!.n;
  ck('두 판 모두 열린다', early.ok === true && late.ok === true);
  ck('대기 중인 판이 실제로 둘이 된다', live === 2, `살아 있는 판 ${live}`);

  const cur = HD.advanceHoldem().tournament;
  ck('지금 다루는 판은 먼저 열릴 쪽이다', cur?.id === early.id,
    `고른 판 ${cur?.id}, 먼저 열릴 판 ${early.id}`);

  mk('u-d', 10000);
  const before = getWebUser('u-d')!.balance;
  const reg = HD.registerHoldem('u-d', 'u-d');
  ck('그 판에 신청된다', reg.ok === true, JSON.stringify(reg));
  const unreg = HD.unregisterHoldem('u-d');
  /* 예전에는 여기서 not_registered 가 났다 — 나중에 만든 판만 보고 있었기 때문이다.
     그러면 참가비가 그 판에 묶이고, 그 판은 아무도 전진시키지 않아 자동 취소도 안 된다. */
  ck('그 판에서 취소된다 (참가비가 묶이지 않는다)', unreg.ok === true, JSON.stringify(unreg));
  ck('참가비가 전액 돌아온다', getWebUser('u-d')!.balance === before,
    `${getWebUser('u-d')!.balance} != ${before}`);
  ck('원장이 어긋나지 않는다', ledgerOk());
}

/* ── [7] 신청한 뒤에 다음 판이 열린 경우 ─────────────────────────── */
section('[7] 신청한 뒤 운영자가 다음 판을 열어도, 내 신청은 내가 물릴 수 있다');
{
  /* 실제로 사고가 나는 순서다. 판 하나만 있을 때 신청해 두었는데, 그 사이 운영자가
     다음 판을 하나 더 연다. 지금 다룰 판을 "나중에 만든 것"으로 고르면 그 순간부터
     내 신청은 아무도 안 보는 판에 남고, 취소도 자동 환불도 닿지 않는다. */
  clearLive();
  const mine = open({ buyIn: 2500, mult: 0, inMin: 3 * 60 });
  mk('u-f', 10000);
  const before = getWebUser('u-f')!.balance;
  ck('먼저 신청해 둔다', HD.registerHoldem('u-f', 'u-f').ok === true);
  ck('참가비가 빠졌다', getWebUser('u-f')!.balance === before - 2500);

  const next = open({ buyIn: 2500, mult: 0, inMin: 6 * 60 });
  ck('그 뒤 다음 판이 열린다', next.ok === true && next.id > mine.id);

  const r = HD.unregisterHoldem('u-f');
  ck('내 신청을 물릴 수 있다', r.ok === true, JSON.stringify(r));
  ck('참가비가 전액 돌아온다', getWebUser('u-f')!.balance === before,
    `${getWebUser('u-f')!.balance} != ${before}`);
  ck('원장이 어긋나지 않는다', ledgerOk());
}

/* ── [8] 시작한 뒤 ──────────────────────────────────────────────── */
section('[8] 시작한 뒤에는 취소되지 않는다 — 칩을 들고 앉아 있다');
{
  clearLive();
  const t = open({ buyIn: 0, mult: 5000, inMin: 1 });
  for (let i = 0; i < T.MIN_PLAYERS; i++) {
    mk('u-e' + i, 10000);
    HD.registerHoldem('u-e' + i, 'u-e' + i);
  }
  run(`UPDATE holdem_tournaments SET scheduled_start_at = ? WHERE id = ?`, now() - 5, t.id);
  const st = HD.advanceHoldem();
  ck('대회가 시작됐다', st.tournament?.started_at != null, String(st.status));
  const r = HD.unregisterHoldem('u-e0');
  ck('취소가 거절된다', r.ok === false, JSON.stringify(r));
  ck('원장이 어긋나지 않는다', ledgerOk());
}

console.log('\n──────────────────────────────────────────────────');
console.log(`통과 ${pass} · 실패 ${fail}`);
if (fail > 0) process.exit(1);
