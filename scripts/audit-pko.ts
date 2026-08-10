/*
 * PKO(바운티) 감사.
 *
 * 여기서 지키려는 것은 하나다 — **걷은 바운티가 1P 도 남지 않고 1P 도 늘지 않고
 * 유저에게 돌아간다.** 요구서의 "1P 의 오차도 없이 분배"이고, 이 서비스의 유일한
 * 불변식(잔액 = 원장 누적합)과 같은 무게다.
 *
 * 그래서 검사를 계산 재현이 아니라 원장으로 한다: 실제 등록·실제 KO·실제 마감을 태우고
 * points_ledger 에 찍힌 바운티 관련 항목의 합이 걷은 펀드와 같은지 본다. 계산을 다시
 * 구현해 비교하면 같은 실수를 두 번 해도 통과한다.
 */
import fsx from 'node:fs';
import os from 'node:os';
import path from 'node:path';
if (!process.env.DB_PATH) {
  process.env.DB_PATH = fsx.mkdtempSync(path.join(os.tmpdir(), 'casino-pko-'));
}
import { getDb } from '../src/db/schema';
import * as Q from '../src/db/queries';
import * as T from '../src/services/tournament';
import * as HD from '../src/db/holdem';
import * as AD from '../src/db/admin';

let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}
function section(s: string): void { console.log('\n' + s); }

const db = getDb();
const now = (): number => Math.floor(Date.now() / 1000);
const c = (rank: number, suit = 0): number => rank * 4 + suit;

function wipe(): void {
  db.exec(`DELETE FROM holdem_hand_seats; DELETE FROM holdem_hands; DELETE FROM holdem_seats;
           DELETE FROM holdem_tables; DELETE FROM holdem_entries; DELETE FROM holdem_tournaments;`);
}
function mkUser(id: string, bal: number): void {
  Q.upsertUser(id, id, null);
  const cur = db.prepare(`SELECT balance FROM users WHERE id = ?`).get(id) as { balance: number };
  Q.adjustBalance(id, bal - cur.balance, 'test:seed');
}
/** 바운티 관련 원장 항목의 합 — 실제로 유저에게 나간 바운티다 */
function bountyPaid(tid: number): number {
  return (db.prepare(
    `SELECT COALESCE(SUM(delta), 0) AS s FROM points_ledger WHERE reason LIKE ?`,
    ).get('game:holdem:bounty%' + '') as { s: number }).s;
  void tid;
}
function entriesOf(tid: number) {
  return db.prepare(
    `SELECT user_id, bounty, bounty_won, ko_count, prize, finish_place, paid_in
       FROM holdem_entries WHERE tournament_id = ? ORDER BY user_id`).all(tid) as {
    user_id: string; bounty: number; bounty_won: number; ko_count: number;
    prize: number; finish_place: number | null; paid_in: number;
  }[];
}

async function main(): Promise<void> {
  /* ── 1. 순수 계산 ────────────────────────────────────────────── */
  section('[1] 나누기 — 쪼갠 값의 합이 언제나 원래 값이다');
  {
    /* 여기가 무너지면 총액이 무너진다. 홀수·1P·0 처럼 내림이 물리는 값을 특히 본다.
       "합이 원래 값"을 성질로 검사한다 — 기대값을 손으로 적으면 그 표가 곧 두 번째 구현이다. */
    for (const b of [0, 1, 2, 3, 7, 99, 100, 101, 999, 1_000, 12_345, 1_000_001]) {
      const s = T.bountySplit(b);
      ck(`${b}: 머리+현금 = 원래 값`, s.head + s.cash === Math.floor(b), `${s.head}+${s.cash}`);
      ck(`${b}: 음수가 없다`, s.head >= 0 && s.cash >= 0);
    }
    for (const b of [0, 1, 5, 7, 100, 999, 12_345]) {
      for (const w of [1, 2, 3, 4, 7]) {
        const parts = T.splitBounty(b, w);
        const sum = parts.reduce((n, x) => n + x, 0);
        ck(`${b} 을 ${w} 명이: 합이 원래 값`, sum === Math.floor(b), `${sum} vs ${b}`);
        ck(`${b} 을 ${w} 명이: 몫 수가 맞다`, parts.length === w);
        /* 몫 차이가 1P 를 넘으면 "나눠 가졌다"가 아니라 누군가 손해를 본 것이다 */
        ck(`${b} 을 ${w} 명이: 몫 차이가 1P 이내`,
          Math.max(...parts) - Math.min(...parts) <= 1, parts.join(','));
      }
    }
    ck('0 명에게 나누면 빈 배열', T.splitBounty(100, 0).length === 0);
    // 참가비 쪼개기도 같은 성질이어야 한다
    for (const f of [0, 1, 999, 1_000, 10_001]) {
      ck(`참가비 ${f}: 상금몫+바운티몫 = 참가비`,
        T.prizeShare(f) + T.bountyShare(f) === Math.floor(f),
        `${T.prizeShare(f)}+${T.bountyShare(f)}`);
    }
    /* 비율 상수를 어떤 값으로 바꿔도 보존이 유지되는가 — 요구서의 "현금 100% + 머리 50%"
       같은 합이 100% 가 아닌 설정이 들어올 수 없는 구조인지 본다. */
    ck('머리 비율이 0~1 사이다', T.PKO_HEAD_RATIO >= 0 && T.PKO_HEAD_RATIO <= 1,
      String(T.PKO_HEAD_RATIO));
    ck('바운티 비율이 0~1 사이다', T.PKO_BOUNTY_RATIO >= 0 && T.PKO_BOUNTY_RATIO <= 1,
      String(T.PKO_BOUNTY_RATIO));
    const src = fsx.readFileSync('src/services/tournament.ts', 'utf8');
    ck('현금은 "나머지 전부" 로 계산한다 (별도 비율 상수가 없다)',
      /cash:\s*b\s*-\s*head/.test(src));
  }

  /* ── 2. 참가비 쪼개기 ───────────────────────────────────────── */
  section('[2] 등록 — 참가비가 두 통으로 갈리고 펀드가 그 합이다');
  const BUY = 10_000;
  let tid = 0;
  {
    wipe();
    for (const p of ['p1', 'p2', 'p3']) mkUser(p, 100_000);
    const made = AD.createTournament({
      title: 'PKO 검사', regOpenAt: now() - 60, startAt: now() + 3_600,
      buyIn: BUY, mode: 'PKO_BOUNTY',
    });
    ck('PKO 대회가 열린다', made.ok, made.ok ? '' : made.error);
    if (!made.ok) { console.log('열지 못해 중단'); process.exit(1); }
    tid = made.id;
    const t0 = db.prepare(`SELECT mode, bounty_pool FROM holdem_tournaments WHERE id = ?`)
      .get(tid) as { mode: string; bounty_pool: number };
    ck('mode 가 PKO_BOUNTY 다', t0.mode === 'PKO_BOUNTY', t0.mode);
    ck('아직 걷은 펀드가 없다', t0.bounty_pool === 0, String(t0.bounty_pool));

    for (const p of ['p1', 'p2', 'p3']) HD.registerHoldem(p, p);
    const rows = entriesOf(tid);
    ck('세 명이 등록됐다', rows.length === 3, String(rows.length));
    const share = T.bountyShare(BUY);
    ck('머리 값이 바운티 몫이다', rows.every(r => r.bounty === share),
      rows.map(r => r.bounty).join(','));
    ck('걷은 금액은 참가비 전액이다', rows.every(r => r.paid_in === BUY));
    const t1 = db.prepare(`SELECT bounty_pool FROM holdem_tournaments WHERE id = ?`)
      .get(tid) as { bounty_pool: number };
    ck('펀드 = 머리 값의 합', t1.bounty_pool === share * 3, `${t1.bounty_pool} vs ${share * 3}`);
    /* 상금 팟은 나머지로만 세어야 한다 — 전액으로 세면 화면이 약속한 상금이 실제보다 크다 */
    const t = db.prepare(`SELECT * FROM holdem_tournaments WHERE id = ?`).get(tid) as never;
    ck('상금 팟은 나머지 몫으로만 센다',
      HD.prizePoolOf(t, 3) === T.prizeShare(BUY) * 3,
      `${HD.prizePoolOf(t, 3)} vs ${T.prizeShare(BUY) * 3}`);
    ck('상금 팟 + 펀드 = 걷은 총액',
      HD.prizePoolOf(t, 3) + t1.bounty_pool === BUY * 3);

    // 등록을 물리면 펀드에서도 빠져야 한다
    HD.unregisterHoldem('p3');
    const t2 = db.prepare(`SELECT bounty_pool FROM holdem_tournaments WHERE id = ?`)
      .get(tid) as { bounty_pool: number };
    ck('등록 취소가 펀드를 되돌린다', t2.bounty_pool === share * 2,
      `${t2.bounty_pool} vs ${share * 2}`);
    ck('취소한 사람은 전액 환급',
      (db.prepare(`SELECT balance FROM users WHERE id = 'p3'`).get() as { balance: number })
        .balance === 100_000);
  }

  /* ── 3. CLASSIC 은 아무것도 달라지지 않는다 ───────────────────── */
  section('[3] 일반 대회 — 바운티 칸이 전부 0 이다');
  {
    wipe();
    for (const p of ['c1', 'c2', 'c3']) mkUser(p, 100_000);
    const made = AD.createTournament({
      title: '일반', regOpenAt: now() - 60, startAt: now() + 3_600, buyIn: BUY,
    });
    if (!made.ok) { console.log('일반 대회 실패'); process.exit(1); }
    for (const p of ['c1', 'c2', 'c3']) HD.registerHoldem(p, p);
    const t = db.prepare(`SELECT * FROM holdem_tournaments WHERE id = ?`).get(made.id) as
      { mode: string; bounty_pool: number };
    ck('mode 는 CLASSIC 이다', t.mode === 'CLASSIC', t.mode);
    ck('isPko 가 false 다', !HD.isPko(t));
    ck('펀드가 0 이다', t.bounty_pool === 0, String(t.bounty_pool));
    ck('머리 값이 전부 0 이다', entriesOf(made.id).every(r => r.bounty === 0));
    /* 상금 팟은 예전 그대로 전액이어야 한다 — PKO 계산이 일반 판에 새면 상금이 반토막 난다 */
    ck('상금 팟은 참가비 전액으로 센다',
      HD.prizePoolOf(t as never, 3) === BUY * 3, String(HD.prizePoolOf(t as never, 3)));
  }

  /* ── 4. 실제 KO 정산 ────────────────────────────────────────── */
  section('[4] KO — 머리 값이 절반은 현금, 절반은 머리로 옮겨간다');
  {
    wipe();
    for (const p of ['k1', 'k2', 'k3', 'k4']) mkUser(p, 100_000);
    const made = AD.createTournament({
      title: 'KO 검사', regOpenAt: now() - 60, startAt: now() + 3_600,
      buyIn: BUY, mode: 'PKO_BOUNTY',
    });
    if (!made.ok) { console.log('KO 대회 실패'); process.exit(1); }
    const id = made.id;
    for (const p of ['k1', 'k2', 'k3', 'k4']) HD.registerHoldem(p, p);
    db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(now() - 1);
    HD.advanceHoldem();
    const table = HD.getTable(id)!;
    const hand = HD.getCurrentHand(table.id)!;

    /* 승패를 카드로 못 박는다 — 확률에 맡기면 감사가 이따금 실패한다.
       k1 에게 AA, 나머지에게 22·33, 보드는 7·9·J·Q·K (페어·플러시·스트레이트 없음). */
    const hole: Record<string, number[]> = {
      k1: [c(12, 0), c(12, 1)], k2: [c(0, 0), c(0, 1)],
      k3: [c(1, 0), c(1, 1)], k4: [c(2, 0), c(2, 1)],
    };
    for (const s of HD.getSeats(table.id)) {
      db.prepare(`UPDATE holdem_hand_seats SET hole_json = ? WHERE hand_id = ? AND seat = ?`)
        .run(JSON.stringify(hole[s.user_id]), hand.id, s.seat);
    }
    db.prepare(`UPDATE holdem_hands SET board_json = ? WHERE id = ?`)
      .run(JSON.stringify([c(5, 2), c(7, 3), c(9, 0), c(10, 1), c(11, 3)]), hand.id);
    // 짧은 둘이 같은 판에 털린다 → k1 이 KO 둘
    for (const [uid, v] of [['k2', 300], ['k3', 900]] as [string, number][]) {
      db.prepare(`UPDATE holdem_hand_seats SET stack = ? WHERE hand_id = ? AND user_id = ?`)
        .run(v, hand.id, uid);
      db.prepare(`UPDATE holdem_seats SET stack = ? WHERE table_id = ? AND user_id = ?`)
        .run(v, table.id, uid);
    }
    const before = new Map(entriesOf(id).map(r => [r.user_id, r.bounty]));
    const balBefore = (db.prepare(`SELECT balance FROM users WHERE id = 'k1'`)
      .get() as { balance: number }).balance;

    for (let i = 0; i < 60; i++) {
      const h = HD.getCurrentHand(table.id);
      if (!h || h.ended_at != null || h.to_act_seat == null) break;
      const seat = HD.getSeats(table.id).find(x => x.seat === h.to_act_seat)!;
      db.prepare(`UPDATE holdem_hands SET action_deadline = ? WHERE id = ?`).run(now() + HD.ACTION_SEC, h.id);
      /* k4 는 접는다. 넷 다 올인시키면 셋이 한 판에 털려 대회가 그 자리에서 끝나고,
         마감 정산까지 돌아 버려서 "진행 중"을 볼 수 없다(그래서 이 검사가 두 번 헛돌았다). */
      if (seat.user_id === 'k4') { HD.holdemAction('k4', 'fold', 0); continue; }
      if (!HD.holdemAction(seat.user_id, 'allin', 0).ok) HD.holdemAction(seat.user_id, 'call', 0);
    }

    const after = entriesOf(id);
    const k1 = after.find(r => r.user_id === 'k1')!;
    const share = T.bountyShare(BUY);
    /* 털린 둘만 0 이어야 한다. 접고 살아남은 k4 는 자기 머리 값을 그대로 들고 있다 —
       "k1 이 아닌 전부"로 적으면 그 정상 동작이 실패로 잡힌다. */
    ck('검사 전제: 짧은 둘이 털렸다',
      after.filter(r => r.user_id === 'k2' || r.user_id === 'k3').every(r => r.bounty === 0),
      after.map(r => `${r.user_id}=${r.bounty}`).join(','));
    ck('접고 살아남은 사람은 머리 값을 지킨다',
      after.find(r => r.user_id === 'k4')!.bounty === T.bountyShare(BUY),
      String(after.find(r => r.user_id === 'k4')!.bounty));
    ck('검사 전제: KO 가 둘이다', k1.ko_count === 2, String(k1.ko_count));

    /* 머리 값 두 개(각 share)를 가져갔으니 절반씩 머리로 오고 절반씩 현금이다 */
    const one = T.bountySplit(share);
    ck('머리가 자기 몫 + 얻은 몫 만큼 늘었다',
      k1.bounty === (before.get('k1') ?? 0) + one.head * 2,
      `${k1.bounty} vs ${(before.get('k1') ?? 0) + one.head * 2}`);
    ck('현금 누계가 맞다', k1.bounty_won === one.cash * 2,
      `${k1.bounty_won} vs ${one.cash * 2}`);
    /* 원장에 실제로 들어갔는지 본다 — 표만 고치고 잔액을 안 올리는 실수가 가장 흔하다 */
    const balAfter = (db.prepare(`SELECT balance FROM users WHERE id = 'k1'`)
      .get() as { balance: number }).balance;
    ck('현금이 잔액에 즉시 들어갔다', balAfter - balBefore === one.cash * 2,
      `${balAfter - balBefore} vs ${one.cash * 2}`);
    ck('원장에 바운티 항목이 남았다',
      (db.prepare(
        `SELECT COUNT(*) AS n FROM points_ledger WHERE user_id = 'k1' AND reason LIKE 'game:holdem:bounty%'`)
        .get() as { n: number }).n > 0);

    /* 이 순간의 보존: 아직 마감 전이라도 [현금으로 나간 것 + 머리에 남은 것] 이 펀드와 같아야 한다 */
    const pool = (db.prepare(`SELECT bounty_pool FROM holdem_tournaments WHERE id = ?`)
      .get(id) as { bounty_pool: number }).bounty_pool;
    const heads = after.reduce((n, r) => n + r.bounty, 0);
    const cash = after.reduce((n, r) => n + r.bounty_won, 0);
    ck('진행 중에도 펀드가 보존된다 (머리 + 나간 현금 = 걷은 펀드)',
      heads + cash === pool, `${heads}+${cash} vs ${pool}`);
  }

  /* ── 5. 마감 — 1P 도 남지 않는다 ─────────────────────────────── */
  section('[5] 마감 — 걷은 바운티가 전부 유저에게 돌아간다');
  {
    /* 여러 인원·여러 참가비로 대회를 끝까지 돌린다. 홀수 참가비를 섞는 것이 요점이다 —
       내림이 물리는 자리가 있으면 여기서 잔돈이 남는다. */
    for (const [n, buy] of [[3, 10_000], [4, 9_999], [5, 1_001], [6, 3]] as [number, number][]) {
      wipe();
      const who = Array.from({ length: n }, (_, i) => `f${i}`);
      for (const p of who) mkUser(p, 1_000_000);
      const balBefore = new Map(who.map(p =>
        [p, (db.prepare(`SELECT balance FROM users WHERE id = ?`).get(p) as { balance: number }).balance]));
      const made = AD.createTournament({
        title: `마감 ${n}/${buy}`, regOpenAt: now() - 60, startAt: now() + 3_600,
        buyIn: buy, mode: 'PKO_BOUNTY',
      });
      if (!made.ok) { ck(`${n}명/${buy}P: 대회가 열린다`, false, made.error); continue; }
      const id = made.id;
      for (const p of who) HD.registerHoldem(p, p);
      const pool = (db.prepare(`SELECT bounty_pool FROM holdem_tournaments WHERE id = ?`)
        .get(id) as { bounty_pool: number }).bounty_pool;
      db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(now() - 1);
      HD.advanceHoldem();
      const table = HD.getTable(id)!;

      /* 끝까지 돌린다. 카드는 손대지 않는다 — 누가 이기든 검사가 성립해야 하고,
         그게 이 검사의 요점이다(특정 승자에 기대면 보존을 증명한 것이 아니다). */
      for (let step = 0; step < 4_000; step++) {
        const tRow = db.prepare(`SELECT finished_at FROM holdem_tournaments WHERE id = ?`)
          .get(id) as { finished_at: number | null };
        if (tRow.finished_at != null) break;
        const h = HD.getCurrentHand(table.id);
        if (!h || h.ended_at != null || h.to_act_seat == null) {
          db.prepare(`UPDATE holdem_tables SET next_hand_at = ? WHERE id = ?`).run(now() - 1, table.id);
          HD.advanceHoldem();
          continue;
        }
        const seat = HD.getSeats(table.id).find(x => x.seat === h.to_act_seat);
        if (!seat) break;
        db.prepare(`UPDATE holdem_hands SET action_deadline = ? WHERE id = ?`).run(now() + HD.ACTION_SEC, h.id);
        if (!HD.holdemAction(seat.user_id, 'allin', 0).ok) {
          if (!HD.holdemAction(seat.user_id, 'call', 0).ok) {
            HD.holdemAction(seat.user_id, 'check', 0);
          }
        }
      }
      const done = db.prepare(`SELECT finished_at FROM holdem_tournaments WHERE id = ?`)
        .get(id) as { finished_at: number | null };
      ck(`${n}명/${buy}P: 검사 전제 — 대회가 끝났다`, done.finished_at != null);
      if (done.finished_at == null) continue;

      const rows = entriesOf(id);
      /* 이것이 이 감사의 핵심 단정문이다. 원장에 찍힌 바운티 지급의 합이 걷은 펀드와
         같은지 본다 — 계산을 다시 구현해 비교하는 것이 아니라, 실제로 유저 잔액을
         움직인 기록을 센다. */
      const paid = (db.prepare(
        `SELECT COALESCE(SUM(delta), 0) AS s FROM points_ledger
          WHERE reason LIKE ?`).get(`game:holdem:bounty%${id}`) as { s: number }).s;
      const paidAll = (db.prepare(
        `SELECT COALESCE(SUM(delta), 0) AS s FROM points_ledger
          WHERE reason = ? OR reason = ?`)
        .get(`game:holdem:bounty:${id}`, `game:holdem:bounty:final:${id}`) as { s: number }).s;
      ck(`${n}명/${buy}P: 나간 바운티 = 걷은 펀드 (1P 오차 없음)`,
        paidAll === pool, `${paidAll} vs ${pool}`);
      ck(`${n}명/${buy}P: 머리에 남은 값이 없다`,
        rows.every(r => r.bounty === 0), rows.map(r => `${r.user_id}=${r.bounty}`).join(','));
      ck(`${n}명/${buy}P: bounty_won 합 = 걷은 펀드`,
        rows.reduce((s, r) => s + r.bounty_won, 0) === pool,
        `${rows.reduce((s, r) => s + r.bounty_won, 0)} vs ${pool}`);
      void paid;

      /* 대회 전체로도 본다: 걷은 참가비 총액이 상금 + 바운티로 정확히 나갔는가.
         이쪽이 요구서의 "전체 바이인 총액 중 1P 의 오차도 없이" 그 자체다. */
      const collected = rows.reduce((s, r) => s + r.paid_in, 0);
      const prizes = rows.reduce((s, r) => s + r.prize, 0);
      ck(`${n}명/${buy}P: 상금 + 바운티 = 걷은 참가비`,
        prizes + paidAll === collected, `${prizes}+${paidAll} vs ${collected}`);
      /* 잔액 변화로도 확인한다. 표를 안 보고 유저 지갑만 보는 검사다 —
         표와 지갑이 어긋나는 실수를 이쪽이 잡는다. */
      const delta = who.reduce((s, p) =>
        s + ((db.prepare(`SELECT balance FROM users WHERE id = ?`).get(p) as { balance: number })
          .balance - (balBefore.get(p) ?? 0)), 0);
      ck(`${n}명/${buy}P: 참가자 잔액 총합이 그대로다 (서비스가 삼킨 돈 0)`,
        delta === 0, String(delta));
    }
  }

  /* ── 6. 이중 지급 ───────────────────────────────────────────── */
  section('[6] 이중 지급 — 두 번 불러도 한 번만 나간다');
  {
    /* 지연 진행(advanceHoldem)이 여러 요청에서 겹쳐 돈다. 마감 정산이 두 번 돌면
       없는 포인트가 발행되므로, 두 번째 호출이 아무것도 하지 않아야 한다. */
    wipe();
    for (const p of ['d1', 'd2', 'd3']) mkUser(p, 1_000_000);
    const made = AD.createTournament({
      title: '이중', regOpenAt: now() - 60, startAt: now() + 3_600,
      buyIn: BUY, mode: 'PKO_BOUNTY',
    });
    if (!made.ok) { console.log('이중 대회 실패'); process.exit(1); }
    const id = made.id;
    for (const p of ['d1', 'd2', 'd3']) HD.registerHoldem(p, p);
    db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(now() - 1);
    HD.advanceHoldem();
    const table = HD.getTable(id)!;
    for (let step = 0; step < 4_000; step++) {
      const tRow = db.prepare(`SELECT finished_at FROM holdem_tournaments WHERE id = ?`)
        .get(id) as { finished_at: number | null };
      if (tRow.finished_at != null) break;
      const h = HD.getCurrentHand(table.id);
      if (!h || h.ended_at != null || h.to_act_seat == null) {
        db.prepare(`UPDATE holdem_tables SET next_hand_at = ? WHERE id = ?`).run(now() - 1, table.id);
        HD.advanceHoldem();
        continue;
      }
      const seat = HD.getSeats(table.id).find(x => x.seat === h.to_act_seat);
      if (!seat) break;
      db.prepare(`UPDATE holdem_hands SET action_deadline = ? WHERE id = ?`).run(now() + HD.ACTION_SEC, h.id);
      if (!HD.holdemAction(seat.user_id, 'allin', 0).ok) {
        if (!HD.holdemAction(seat.user_id, 'call', 0).ok) HD.holdemAction(seat.user_id, 'check', 0);
      }
    }
    const paidOnce = (db.prepare(
      `SELECT COALESCE(SUM(delta), 0) AS s FROM points_ledger WHERE reason = ? OR reason = ?`)
      .get(`game:holdem:bounty:${id}`, `game:holdem:bounty:final:${id}`) as { s: number }).s;
    // 몇 번 더 전진시켜 본다 — 마감은 이미 지났으므로 아무 일도 없어야 한다
    for (let i = 0; i < 5; i++) HD.advanceHoldem();
    const paidTwice = (db.prepare(
      `SELECT COALESCE(SUM(delta), 0) AS s FROM points_ledger WHERE reason = ? OR reason = ?`)
      .get(`game:holdem:bounty:${id}`, `game:holdem:bounty:final:${id}`) as { s: number }).s;
    ck('다시 전진시켜도 지급이 늘지 않는다', paidOnce === paidTwice,
      `${paidOnce} → ${paidTwice}`);
    ck('한 번은 실제로 나갔다', paidOnce > 0, String(paidOnce));
  }

  /* ── 7. 경제 불변식 ─────────────────────────────────────────── */
  section('[7] 잔액 = 원장 누적합');
  {
    /* 이 서비스의 유일한 불변식이다. 바운티 지급이 adjustBalance 를 안 거치면 여기서 깨진다. */
    const bad = db.prepare(
      `SELECT u.id, u.balance, COALESCE(SUM(p.delta), 0) AS s
         FROM users u LEFT JOIN points_ledger p ON p.user_id = u.id
        GROUP BY u.id HAVING u.balance != COALESCE(SUM(p.delta), 0)`).all() as unknown[];
    ck('모든 유저의 잔액이 원장 누적합과 같다', bad.length === 0, JSON.stringify(bad).slice(0, 200));
    const srcH = fsx.readFileSync('src/db/holdem.ts', 'utf8');
    ck('바운티 지급이 잔액을 직접 고치지 않는다',
      !/bounty[\s\S]{0,400}?UPDATE users SET balance/.test(srcH));
  }

  /* ── 8. UI 차별화 ───────────────────────────────────────────── */
  section('[8] 화면 — 일반 대회에는 바운티가 그려질 수 없다');
  {
    /* 요구가 명확했다: "같은 베이스지만 서로 UI 는 철저히 차별화". 그래서 검사도
       "숨겨져 있나"가 아니라 "그릴 수단 자체가 없나"를 본다 — 숨기는 방식이면 조건이
       언젠가 빠지면서 일반 판에 바운티가 뜨고, 그때는 아무도 못 알아챈다. */
    const seatsSrc = fsx.readFileSync('src/web/games/holdem-client/seats.ts', 'utf8');
    const stateSrc = fsx.readFileSync('src/web/games/holdem.ts', 'utf8');

    // (1) 좌석 골격: 세 요소가 모두 pko 조건 뒤에 있어야 한다
    for (const cls of ['ht-bounty', 'ht-hole-shot', 'ht-ko-ov']) {
      const line = seatsSrc.split(/\r?\n/).find(l => l.includes(`"${cls}"`) && l.includes('span'));
      ck(`${cls} 는 pko 일 때만 만들어진다`, line != null && /\(pko \?/.test(line),
        line?.trim().slice(0, 70) ?? '(줄을 못 찾았다)');
    }
    // (2) 골격 서명에 pko 가 들어가야 한다 — 안 들어가면 모드가 바뀌어도 DOM 이 재사용된다
    ck('좌석 골격 서명이 모드를 포함한다', /sigParts\.push\([^)]*pko/.test(seatsSrc));
    // (3) KO 연출은 pko 조건 뒤에서만 터진다
    ck('KO 연출이 pko 조건 뒤에 있다', /if \(pko && s\.presence === 'OUT'/.test(seatsSrc));
    ck('koed 클래스도 pko 조건이 붙는다', /toggle\('koed', pko &&/.test(seatsSrc));

    // (4) payload: 일반 판에는 칸 자체가 없어야 한다
    ck('bountyPool 은 PKO 에서만 실린다', /bountyPool: isPko\(t\) \?/.test(stateSrc));
    ck('좌석 bounty 는 PKO 에서만 실린다', /bounty: pkoOn \?/.test(stateSrc));
    ck('mode 를 화면에 내려보낸다', /\bmode: t\.mode\b/.test(stateSrc));

    // (5) 소리와 CSS 가 실제로 있는지
    const appSrc = fsx.readFileSync('src/web/assets/app.js', 'utf8');
    ck('총성이 합성음으로 있다 (음원 다운로드가 없다)',
      /gunshot: function\(\)\{/.test(appSrc) && /noiseBurst\(c,/.test(appSrc));
    ck('바운티 상향 소리가 있다', /bountyUp: function\(\)\{/.test(appSrc));
    const cssSrc = fsx.readFileSync('src/web/assets/css/09-holdem.css', 'utf8');
    for (const need of ['.ht-bounty', 'htBountyUp', '.ht-hole-shot', 'htShot',
      '.ht-ko-ov', '.ht-seat.koed', 'htKoShake']) {
      ck(`CSS 에 ${need} 가 있다`, cssSrc.includes(need));
    }
    /* 흔들림을 펠트에 걸어야 한다. #htTable 에 걸면 그 안의 .chip-fly-layer 가
       position:fixed 라 조상 transform 에 끌려가 날아가는 칩이 통째로 어긋난다 —
       KO 와 팟 정산은 같은 순간이라 반드시 겹친다. */
    ck('흔들림은 펠트에 걸린다 (칩 비행이 어긋나지 않게)',
      cssSrc.includes('.ht-felt.koshake') && !cssSrc.includes('.ht-shell.koshake'));
    ck('흔들림 대상이 코드에서도 펠트다',
      /querySelector\('\.ht-felt'\)/.test(seatsSrc));
    // 움직임을 줄이는 설정을 존중한다 (소리와 총자국은 남는다 — 그게 사건 자체다)
    ck('prefers-reduced-motion 에서 애니메이션을 끈다',
      /prefers-reduced-motion[\s\S]{0,300}htKoShake|prefers-reduced-motion[\s\S]{0,300}koshake/
        .test(cssSrc));

    // (6) 어드민에서 PKO 를 열 수 있고, 프리롤에는 걸 수 없다
    const admSrc = fsx.readFileSync('src/web/admin.ts', 'utf8');
    ck('어드민에 대회 종류 선택이 있다', /id="ncMode"/.test(admSrc));
    ck('프리롤이면 종류를 잠근다', /ncMode\.disabled = !buyin/.test(admSrc));
    ck('프리롤이면 CLASSIC 으로 보낸다', /mode: buyin \? ncMode\.value : 'CLASSIC'/.test(admSrc));
    ck('서버가 모르는 값을 CLASSIC 으로 떨어뜨린다',
      /b\?\.mode === 'PKO_BOUNTY' \? 'PKO_BOUNTY' : 'CLASSIC'/.test(admSrc));
  }

  console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}

void bountyPaid;
main().catch(e => { console.error(e); process.exit(1); });
