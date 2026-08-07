/* 블랙잭 질의 — 블랙잭.

   db/queries.ts 가 1,792줄이라 읽을 수 없어 도메인별로 나눴다. 코드는 한 줄도 바꾸지
   않고 구간을 그대로 옮겼고, queries.ts 는 전부 다시 내보내는 배럴로 남겨 두었다 —
   그래서 부르는 쪽은 예전처럼 './queries' 에서 그대로 가져다 쓴다.

   의존은 한 방향이다: 게임별 모듈 → core. 반대 방향은 없고, 만들지도 말 것.
   core 가 특정 게임을 알게 되면 순환이 생기고, 그때부터는 어느 파일을 먼저 읽어야
   하는지가 사라진다. */
import { randomInt } from 'node:crypto';
import { one, all, run, tx, bumpGameStats, pruneStaleData } from './core';

/* ── 블랙잭 ──────────────────────────────────────────────────────────────
   7석 공용 테이블. 다른 게임과 다른 점이 둘 있다.

   1) 카드를 몇 장 쓸지 미리 알 수 없다(각자 원하는 만큼 힛한다). 그래서 바카라처럼
      필요한 만큼만 뽑아둘 수 없고, 라운드 시작에 슈를 통째로 섞어 저장하고 커서를 민다.
      슈에는 앞으로 나올 카드가 전부 들어 있으므로 절대 클라이언트로 내려보내면 안 된다.

   2) 결정을 전원이 동시에 한다. 순차로 한 명씩 돌리면 라운드 길이가 인원수에 비례해 늘어나
      다섯 명이면 1분을 넘고, 그중 내 차례는 10초뿐이라 나머지는 남을 기다리는 시간이 된다.
      같은 15초 창을 모두가 나눠 쓰면 인원과 무관하게 라운드가 37초로 일정하다.        */

// 실제 블랙잭 테이블은 7석이지만 5석으로 줄였다 — 웹에서는 자리가 많을수록 카드가 작아지고,
// 다 같이 하는 재미는 5명이면 충분하다.
export const BJ_SEATS = 5;
export const BJ_BETTING_SEC = 10;  // 첫 사람이 앉은 순간부터 센다
// 아래는 전부 "구간 길이"다. 절대 시각은 betting_ends_at을 기준으로 더해 구한다.
export const BJ_DEAL_SEC = 3;     // 카드 배분을 보는 시간
export const BJ_ACTION_SEC = 15;  // 힛/스탠드/더블 결정 창 (모두 끝나면 일찍 닫힌다)
/* 딜러가 카드를 받는 시간. 클라이언트 공개 속도(홀 카드 0.7초 + 한 장당 0.95초)에
   맞춰 잡는다. 폴링이 최대 1초 늦게 도착하는 것까지 더해도 마지막 장이 놓인 뒤
   약 1.3초 뒤에 정산으로 넘어간다 — 결과를 읽을 딱 한 박자다.
   예전엔 4초 + 장당 2초여서, 두 장 더 받는 판은 8초 창에 공개가 2.6초에 끝나고
   4~5초를 멍하니 기다렸다(딜러가 버스트한 판이 특히 그랬다). */
export const BJ_DEALER_SEC = 3;   // 기본 창
export const BJ_REVEAL_SEC = 3;   // 정산 후 다음 라운드까지
export const BJ_KEEP_ROUNDS = 30;

export type BjPhase = 'waiting' | 'betting' | 'deal' | 'action' | 'dealer' | 'done';
export type BjHandStatus = 'playing' | 'stand' | 'bust' | 'blackjack' | 'surrender';

export interface BjRoundRow {
  id: number;
  phase: BjPhase;
  betting_ends_at: number | null;   // 아무도 안 앉았으면 null
  action_ended_at: number | null;   // 전원이 일찍 끝냈으면 그 시각
  shoe_json: string;      // 앞으로 나올 카드 전부 — 절대 외부로 내보내지 않는다
  shoe_pos: number;
  dealer_json: string;
  result_json: string | null;
  resolved_at: number | null;
  created_at: number;
}

export interface BjHandRow {
  id: number;
  round_id: number;
  seat: number;
  user_id: string;
  username: string;
  bet: number;
  cards_json: string;
  status: BjHandStatus;
  outcome: string | null;
  payout: number | null;
}

export interface BjHelpers {
  shuffle: () => number[];
  isBlackjack: (cards: number[]) => boolean;
  dealerShouldHit: (cards: number[]) => boolean;
  handTotal: (cards: number[]) => { total: number; bust: boolean };
  settle: (player: number[], dealer: number[]) => { outcome: string; multiplier: number };
  /* 서렌더 — 첫 두 장에서만 가능하고, 딜러가 블랙잭이면 무효(전액 손실)다.
     정산을 settle과 분리한 이유: 서렌더는 플레이어 카드를 비교하지 않고
     딜러의 블랙잭 여부만으로 결과가 정해진다. */
  canSurrender: (cards: number[]) => boolean;
  settleSurrender: (dealer: number[]) => { outcome: string; multiplier: number };
}

/* 라운드의 각 구간이 언제 끝나는지. betting_ends_at 하나에서 전부 파생되므로
   서버 타이머 없이 "지금 몇 시인가"만으로 단계를 정할 수 있다.
   결정 창만 예외로, 전원이 일찍 끝내면 action_ended_at이 그 시각을 당겨 준다. */
export function bjSchedule(r: BjRoundRow): { deal: number; action: number; dealer: number } | null {
  if (r.betting_ends_at == null) return null;
  const deal = r.betting_ends_at + BJ_DEAL_SEC;
  const action = r.action_ended_at ?? (deal + BJ_ACTION_SEC);
  // 딜러가 더 받은 장수만큼 차례를 늘린다. 고정 길이로 두면 카드를 여러 장 받는 판에서
  // 뒷장들이 한꺼번에 튀어나오고 결과까지 겹쳐서 김이 샌다.
  // 장당 1초 = 클라이언트 공개 간격(0.95초)과 거의 같다. 2초씩 주면 공개가 끝난 뒤
  // 장수만큼 빈 시간이 쌓여서 결과를 기다리는 게 지루해진다.
  let extra = 0;
  try { extra = Math.max(0, (JSON.parse(r.dealer_json) as number[]).length - 2); } catch { /* 아직 안 뽑음 */ }
  return { deal, action, dealer: action + BJ_DEALER_SEC + extra };
}

function bjHands(roundId: number): BjHandRow[] {
  return all<BjHandRow>(`SELECT * FROM blackjack_hands WHERE round_id = ? ORDER BY seat ASC`, roundId);
}

/* 슈에서 한 장 꺼내고 커서를 민다.
 *
 * 1덱(52장)이라 한 판에 소진될 수 있다 — 5석 + 딜러가 저가 카드를 계속 받으면
 * 52장을 넘긴다. 예전에는 커서를 되감았는데(shoe_pos % length), 그러면 그 순간부터
 * 같은 카드가 다시 나온다. 1덱으로 둔 이유가 "한 판에 같은 카드가 두 번 나오지 않는 것"
 * 이므로 되감으면 안 된다.
 *
 * 그래서 소진되면 새로 섞어 이어 붙인다. 이때 "지금 테이블에 나와 있는 카드"는 빼야
 * 한다 — 그러지 않으면 이미 보이는 카드가 또 나온다. 딜러 카드와 모든 손패를 읽어
 * 제외하고, 남은 것만 섞어 슈 뒤에 잇는다.
 */
function drawCard(round: BjRoundRow): number {
  let shoe = JSON.parse(round.shoe_json) as number[];
  if (round.shoe_pos >= shoe.length) {
    /* 제외 기준은 "이미 슈에서 꺼낸 카드"다. 손패·딜러 카드를 읽어 판단하면 안 된다 —
       딜러가 연달아 뽑는 도중에는 방금 뽑은 카드가 아직 dealer_json에 기록되지 않아
       제외 목록에서 빠지고, 그 카드가 다시 나온다(실측으로 Ad가 두 번 나왔다).
       슈 배열과 커서는 항상 최신이므로 이쪽이 유일하게 믿을 수 있는 근거다. */
    const used = new Set<number>(shoe.slice(0, round.shoe_pos));
    const fresh: number[] = [];
    for (let c = 0; c < 52; c++) if (!used.has(c)) fresh.push(c);
    // 피셔-예이츠 (Math.random 금지 — 암호학적 randomInt만 쓴다)
    for (let i = fresh.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      const t = fresh[i]; fresh[i] = fresh[j]; fresh[j] = t;
    }
    shoe = shoe.concat(fresh);
    run(`UPDATE blackjack_rounds SET shoe_json = ? WHERE id = ?`, JSON.stringify(shoe), round.id);
    round.shoe_json = JSON.stringify(shoe);
  }
  const pos = round.shoe_pos;
  run(`UPDATE blackjack_rounds SET shoe_pos = ? WHERE id = ?`, pos + 1, round.id);
  round.shoe_pos = pos + 1;
  return shoe[pos];
}

function pruneBlackjackRounds(): void {
  const cutoff = one<{ id: number }>(
    `SELECT id FROM blackjack_rounds ORDER BY id DESC LIMIT 1 OFFSET ?`, BJ_KEEP_ROUNDS
  );
  if (!cutoff) return;
  run(`DELETE FROM blackjack_hands WHERE round_id <= ?`, cutoff.id);
  run(`DELETE FROM blackjack_rounds WHERE id <= ?`, cutoff.id);
}

function settleBlackjack(round: BjRoundRow, h: BjHelpers): void {
  const dealer = JSON.parse(round.dealer_json) as number[];
  for (const hand of bjHands(round.id)) {
    const cards = JSON.parse(hand.cards_json) as number[];
    /* 서렌더한 손패는 플레이어 카드를 비교하지 않는다 — 딜러의 블랙잭 여부만 본다.
       무효면 전액 손실, 아니면 절반 반환이다(내림 규칙을 그대로 따른다). */
    const { outcome, multiplier } = hand.status === 'surrender'
      ? h.settleSurrender(dealer)
      : h.settle(cards, dealer);
    const payout = Math.floor(hand.bet * multiplier);
    run(`UPDATE blackjack_hands SET outcome = ?, payout = ? WHERE id = ?`, outcome, payout, hand.id);
    // 유저가 사라진 손패는 건너뛴다 — 여기서 예외가 나면 트랜잭션이 롤백돼
    // 라운드가 영구히 정산되지 않고 공용 테이블이라 모두의 게임이 멈춘다
    if (!one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, hand.user_id)) continue;
    if (payout > 0) run(`UPDATE users SET balance = balance + ? WHERE id = ?`, payout, hand.user_id);
    const after = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, hand.user_id)!;
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
      hand.user_id, payout, 'game:blackjack', after.balance);
    /* 스테이크는 정산 시점의 hand.bet이다. 더블다운이 이 값을 두 배로 갱신하므로
       착석 시점 베팅액을 쓰면 틀린다. 푸시(양쪽 블랙잭·동점)는 배율이 1이라
       payout == bet 이 되고 bumpGameStats가 이를 푸시로 판정한다. */
    bumpGameStats(hand.user_id, 'blackjack', hand.bet, payout);
  }
}

// 아직 결정을 안 한 사람이 남아 있는가
function anyPlaying(roundId: number): boolean {
  return one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM blackjack_hands WHERE round_id = ? AND status = 'playing'`, roundId
  )!.n > 0;
}

export function advanceBlackjackRound(h: BjHelpers): BjRoundRow {
  return tx(() => {
    const now = Math.floor(Date.now() / 1000);
    let round = one<BjRoundRow>(`SELECT * FROM blackjack_rounds ORDER BY id DESC LIMIT 1`);

    if (round) {
      const s = bjSchedule(round);
      // 아직 아무도 앉지 않았으면 시간이 흐르지 않는다 — 그대로 기다린다
      let phase: BjPhase = s == null ? 'waiting' : 'betting';
      if (s) {
        if (now >= s.dealer) phase = 'done';
        else if (now >= s.action) phase = 'dealer';
        else if (now >= s.deal) phase = 'action';
        else if (now >= round.betting_ends_at!) phase = 'deal';
      }

      if (phase !== round.phase) {
        // 베팅 → 배분: 자리마다 두 장, 딜러도 두 장(둘째 장은 공개 전까지 감춘다)
        if ((round.phase === 'betting' || round.phase === 'waiting') && phase !== 'betting' && phase !== 'waiting') {
          const hands = bjHands(round.id);
          const dealt: Record<number, number[]> = {};
          for (const hand of hands) dealt[hand.id] = [];
          // 실제 테이블처럼 한 바퀴씩 두 번 돈다 (한 사람에게 두 장을 몰아주지 않는다)
          for (let pass = 0; pass < 2; pass++) {
            for (const hand of hands) dealt[hand.id].push(drawCard(round));
          }
          const dealer = [drawCard(round), drawCard(round)];
          run(`UPDATE blackjack_rounds SET dealer_json = ? WHERE id = ?`, JSON.stringify(dealer), round.id);
          for (const hand of hands) {
            const cards = dealt[hand.id];
            // 처음 두 장이 블랙잭이면 더 받을 게 없다 — 바로 확정한다
            const status: BjHandStatus = h.isBlackjack(cards) ? 'blackjack' : 'playing';
            run(`UPDATE blackjack_hands SET cards_json = ?, status = ? WHERE id = ?`,
              JSON.stringify(cards), status, hand.id);
          }
          // 전원이 블랙잭이면 결정할 게 없다 — 결정 창을 열지 않고 바로 넘긴다
          if (!anyPlaying(round.id)) {
            run(`UPDATE blackjack_rounds SET action_ended_at = ? WHERE id = ? AND action_ended_at IS NULL`,
              round.betting_ends_at! + BJ_DEAL_SEC, round.id);
          }
        }

        // 결정 시간 종료 → 아직 안 정한 사람은 강제 스탠드.
        // 강제로 힛하지 않는 게 중요하다 — 게임이 플레이어 대신 버스트 위험을 지면 안 된다
        // (실제 라이브 딜러 블랙잭도 시간 초과는 스탠드로 처리한다).
        if (phase === 'dealer' || phase === 'done') {
          run(`UPDATE blackjack_hands SET status = 'stand' WHERE round_id = ? AND status = 'playing'`, round.id);
        }

        /* 딜러가 받을 카드는 '딜러 차례'에 들어가는 순간 전부 뽑아 저장한다.
           정산할 때 뽑으면 세 번째·네 번째 장이 결과와 함께 한꺼번에 나타나서,
           딜러가 카드를 받아가는 이 게임의 하이라이트가 통째로 사라진다.
           공개는 클라이언트가 한 장씩 하고, 차례 길이도 뽑은 장수만큼 늘어난다(bjSchedule). */
        if ((phase === 'dealer' || phase === 'done') && round.phase !== 'dealer' && round.phase !== 'done') {
          const fresh = one<BjRoundRow>(`SELECT * FROM blackjack_rounds WHERE id = ?`, round.id)!;
          const dealer = JSON.parse(fresh.dealer_json) as number[];
          // 살아남은 손패가 하나도 없으면 딜러는 카드를 더 받지 않는다(실제 규칙 그대로)
          const alive = one<{ n: number }>(
            `SELECT COUNT(*) AS n FROM blackjack_hands WHERE round_id = ? AND status IN ('stand','blackjack')`,
            round.id
          )!.n;
          if (alive > 0 && h.dealerShouldHit(dealer)) {
            while (h.dealerShouldHit(dealer)) dealer.push(drawCard(fresh));
            run(`UPDATE blackjack_rounds SET dealer_json = ? WHERE id = ?`, JSON.stringify(dealer), round.id);
            round = one<BjRoundRow>(`SELECT * FROM blackjack_rounds WHERE id = ?`, round.id)!;
            // 차례가 길어졌으니 지금이 아직 그 안이면 정산을 미룬다
            if (now < bjSchedule(round)!.dealer) phase = 'dealer';
          }
        }

        if (phase === 'done' && round.phase !== 'done') {
          const done = one<BjRoundRow>(`SELECT * FROM blackjack_rounds WHERE id = ?`, round.id)!;
          const dealer = JSON.parse(done.dealer_json) as number[];
          settleBlackjack(done, h);
          run(`UPDATE blackjack_rounds SET phase = 'done', result_json = ?, resolved_at = ? WHERE id = ? AND phase != 'done'`,
            JSON.stringify({ dealerTotal: h.handTotal(dealer).total, dealerBust: h.handTotal(dealer).bust }),
            now, round.id);
        } else if (phase !== 'done') {
          run(`UPDATE blackjack_rounds SET phase = ? WHERE id = ?`, phase, round.id);
        }
        round = one<BjRoundRow>(`SELECT * FROM blackjack_rounds WHERE id = ?`, round.id)!;
      }
    }

    if (!round || (round.phase === 'done' && (round.resolved_at ?? 0) + BJ_REVEAL_SEC <= now)) {
      // 새 라운드는 마감 시각 없이 열린다 — 첫 사람이 앉을 때 seatBlackjackBet이 채운다
      run(`INSERT INTO blackjack_rounds (phase, betting_ends_at, shoe_json, shoe_pos, dealer_json)
           VALUES ('waiting', NULL, ?, 0, '[]')`, JSON.stringify(h.shuffle()));
      const id = one<{ id: number }>(`SELECT last_insert_rowid() AS id`)!.id;
      round = one<BjRoundRow>(`SELECT * FROM blackjack_rounds WHERE id = ?`, id)!;
      pruneBlackjackRounds();
      pruneStaleData();
    }
    return round!;
  });
}

/* 자리에 앉으면서 베팅한다. 실제 테이블처럼 "칩을 올린 자리가 내 자리"다 —
   앉기와 베팅을 따로 두면 앉아놓고 베팅 안 한 자리가 남아 다른 사람이 못 앉는다. */
export function seatBlackjackBet(
  userId: string, username: string, roundId: number, seat: number, amount: number
): { ok: true; balance: number; bet: number }
  | { ok: false; error: 'closed' | 'seat_taken' | 'already_seated' | 'insufficient_balance' | 'bad_seat' } {
  return tx(() => {
    if (!Number.isInteger(seat) || seat < 0 || seat >= BJ_SEATS) return { ok: false, error: 'bad_seat' };
    const now = Math.floor(Date.now() / 1000);
    const r = one<{ phase: string; betting_ends_at: number | null }>(
      `SELECT phase, betting_ends_at FROM blackjack_rounds WHERE id = ?`, roundId
    );
    // 아직 아무도 안 앉은 라운드(waiting)에도 앉을 수 있어야 한다 — 그게 시작 신호다
    if (!r || (r.phase !== 'betting' && r.phase !== 'waiting')) return { ok: false, error: 'closed' };
    if (r.betting_ends_at != null && r.betting_ends_at <= now) return { ok: false, error: 'closed' };
    const mine = one<{ seat: number }>(
      `SELECT seat FROM blackjack_hands WHERE round_id = ? AND user_id = ?`, roundId, userId
    );
    // 이미 앉아 있으면 같은 자리에만 칩을 더 올릴 수 있다 (자리 옮기기는 다음 라운드에)
    if (mine && mine.seat !== seat) return { ok: false, error: 'already_seated' };
    if (!mine) {
      const taken = one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM blackjack_hands WHERE round_id = ? AND seat = ?`, roundId, seat
      )!.n;
      if (taken > 0) return { ok: false, error: 'seat_taken' };
    }

    const before = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId);
    if (!before || before.balance < amount) return { ok: false, error: 'insufficient_balance' };
    run(`UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?`, amount, userId, amount);
    if (one<{ n: number }>(`SELECT changes() AS n`)!.n === 0) return { ok: false, error: 'insufficient_balance' };
    const after = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)!;
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
      userId, -amount, 'game:blackjack:bet', after.balance);
    run(
      `INSERT INTO blackjack_hands (round_id, seat, user_id, username, bet, cards_json, status)
       VALUES (?, ?, ?, ?, ?, '[]', 'playing')
       ON CONFLICT(round_id, user_id) DO UPDATE SET bet = bet + excluded.bet`,
      roundId, seat, userId, username, amount
    );
    // 첫 사람이 앉는 순간부터 카운트다운을 시작한다.
    // 빈 테이블에서 미리 돌려두면 늦게 들어온 사람이 남의 라운드가 끝나기를 기다려야 하고,
    // 볼 사람도 없이 슈만 축난다.
    if (r.betting_ends_at == null) {
      run(`UPDATE blackjack_rounds SET phase = 'betting', betting_ends_at = ?
           WHERE id = ? AND betting_ends_at IS NULL`, now + BJ_BETTING_SEC, roundId);
    }
    const bet = one<{ bet: number }>(
      `SELECT bet FROM blackjack_hands WHERE round_id = ? AND user_id = ?`, roundId, userId
    )!.bet;
    return { ok: true, balance: after.balance, bet };
  });
}

export function clearBlackjackBet(userId: string, roundId: number):
  { ok: true; balance: number; refunded: number } | { ok: false; error: 'nothing' | 'closed' } {
  return tx(() => {
    const r = one<{ phase: string; betting_ends_at: number | null }>(
      `SELECT phase, betting_ends_at FROM blackjack_rounds WHERE id = ?`, roundId
    );
    if (!r || (r.phase !== 'betting' && r.phase !== 'waiting')) return { ok: false, error: 'closed' };
    if (r.betting_ends_at != null && r.betting_ends_at <= Math.floor(Date.now() / 1000)) {
      return { ok: false, error: 'closed' };
    }
    const hand = one<{ bet: number }>(
      `SELECT bet FROM blackjack_hands WHERE round_id = ? AND user_id = ?`, roundId, userId
    );
    if (!hand || hand.bet <= 0) return { ok: false, error: 'nothing' };
    run(`DELETE FROM blackjack_hands WHERE round_id = ? AND user_id = ?`, roundId, userId);
    run(`UPDATE users SET balance = balance + ? WHERE id = ?`, hand.bet, userId);
    const after = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)!;
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
      userId, hand.bet, 'game:blackjack:bet', after.balance);
    /* 마지막 사람이 칩을 회수해 테이블이 다시 비었으면 카운트다운을 되돌린다.
       안 되돌리면 아무도 없는 테이블에 카드가 돌고, 그 판이 끝날 때까지
       새로 온 사람이 남의 빈 판을 기다려야 한다. 첫 사람이 다시 앉는 순간부터 다시 센다. */
    const left = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM blackjack_hands WHERE round_id = ?`, roundId
    )!.n;
    if (left === 0) {
      run(`UPDATE blackjack_rounds SET phase = 'waiting', betting_ends_at = NULL WHERE id = ?`, roundId);
    }
    return { ok: true, balance: after.balance, refunded: hand.bet };
  });
}

/* 힛 / 스탠드 / 더블다운. 결정 창(action) 안에서, 아직 진행 중인 손패만 움직일 수 있다.
   결과(버스트 여부)는 여기서 확정한다 — 클라이언트가 정할 여지를 두지 않는다.

   더블다운은 처음 두 장을 본 시점에만 쓸 수 있고, 베팅을 두 배로 올린 뒤 딱 한 장만 받고 선다.
   추가로 걸리는 돈은 원래 베팅액과 같으므로 그만큼 잔액에서 다시 차감한다.               */
export function blackjackAction(
  userId: string, roundId: number, action: 'hit' | 'stand' | 'double' | 'surrender', h: BjHelpers
): { ok: true; cards: number[]; status: BjHandStatus; bet: number; balance: number }
  | { ok: false; error: 'closed' | 'no_hand' | 'done' | 'cannot_double' | 'cannot_surrender'
      | 'insufficient_balance' } {
  return tx(() => {
    const round = one<BjRoundRow>(`SELECT * FROM blackjack_rounds WHERE id = ?`, roundId);
    if (!round || round.phase !== 'action') return { ok: false, error: 'closed' };
    const hand = one<BjHandRow>(
      `SELECT * FROM blackjack_hands WHERE round_id = ? AND user_id = ?`, roundId, userId
    );
    if (!hand) return { ok: false, error: 'no_hand' };
    if (hand.status !== 'playing') return { ok: false, error: 'done' };

    const cards = JSON.parse(hand.cards_json) as number[];
    let bet = hand.bet;
    let status: BjHandStatus;

    if (action === 'stand') {
      status = 'stand';
    } else if (action === 'surrender') {
      /* 첫 두 장에서만, 블랙잭이 아닐 때만. 카드를 더 받지 않고 그 자리에서 끝낸다.
         반환액(절반)은 정산 때 계산한다 — 딜러가 블랙잭인지는 그때 알 수 있고,
         블랙잭이면 서렌더가 무효가 되어 전액을 잃는다. */
      if (!h.canSurrender(cards)) return { ok: false, error: 'cannot_surrender' };
      status = 'surrender';
    } else if (action === 'double') {
      // 카드를 이미 받았으면 더블은 못 한다 (처음 두 장에서만)
      if (cards.length !== 2) return { ok: false, error: 'cannot_double' };
      run(`UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?`, hand.bet, userId, hand.bet);
      if (one<{ n: number }>(`SELECT changes() AS n`)!.n === 0) return { ok: false, error: 'insufficient_balance' };
      const after = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)!;
      run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
        userId, -hand.bet, 'game:blackjack:bet', after.balance);
      bet = hand.bet * 2;
      cards.push(drawCard(round));
      // 더블은 한 장만 받고 무조건 선다 — 버스트했으면 그대로 끝이다
      status = h.handTotal(cards).bust ? 'bust' : 'stand';
      run(`UPDATE blackjack_hands SET bet = ? WHERE id = ?`, bet, hand.id);
    } else {
      cards.push(drawCard(round));
      const t = h.handTotal(cards);
      // 21에 닿으면 더 받을 이유가 없으므로 자동으로 선다 (실수로 버스트하는 걸 막는다)
      status = t.bust ? 'bust' : t.total === 21 ? 'stand' : 'playing';
    }
    run(`UPDATE blackjack_hands SET cards_json = ?, status = ? WHERE id = ?`,
      JSON.stringify(cards), status, hand.id);
    // 마지막 사람이 결정을 마쳤으면 남은 시간을 기다리지 않고 바로 딜러 차례로 넘긴다.
    // 손패가 'playing'에서 빠져나오는 경로가 이 함수뿐이라 여기서만 확인하면 충분하다.
    if (!anyPlaying(roundId)) {
      run(`UPDATE blackjack_rounds SET action_ended_at = ? WHERE id = ? AND action_ended_at IS NULL`,
        Math.floor(Date.now() / 1000), roundId);
    }
    const balance = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)?.balance ?? 0;
    return { ok: true, cards, status, bet, balance };
  });
}

export function getBlackjackHands(roundId: number): BjHandRow[] {
  return bjHands(roundId);
}

export function getMyBlackjackHand(roundId: number, userId: string): BjHandRow | undefined {
  return one<BjHandRow>(`SELECT * FROM blackjack_hands WHERE round_id = ? AND user_id = ?`, roundId, userId);
}

export interface BjPlayerRow {
  user_id: string; username: string; avatar: string | null; balance: number;
  seat: number; bet: number; payout: number | null;
}

export function getBlackjackPlayers(roundId: number): BjPlayerRow[] {
  return all<BjPlayerRow>(
    `SELECT b.user_id, u.username, u.avatar, u.balance, b.seat, b.bet, b.payout
     FROM blackjack_hands b JOIN users u ON u.id = b.user_id
     WHERE b.round_id = ? ORDER BY b.seat ASC`, roundId
  );
}

export interface BjHistoryRow { dealerTotal: number; dealerBust: boolean }

export function getRecentBlackjackResults(limit = 15): BjHistoryRow[] {
  return all<{ result_json: string }>(
    `SELECT result_json FROM blackjack_rounds WHERE phase = 'done' AND result_json IS NOT NULL
     ORDER BY id DESC LIMIT ?`, limit
  ).map(r => JSON.parse(r.result_json) as BjHistoryRow);
}

