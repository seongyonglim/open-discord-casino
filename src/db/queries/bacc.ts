/* 바카라 질의 — 바카라.

   db/queries.ts 가 1,792줄이라 읽을 수 없어 도메인별로 나눴다. 코드는 한 줄도 바꾸지
   않고 구간을 그대로 옮겼고, queries.ts 는 전부 다시 내보내는 배럴로 남겨 두었다 —
   그래서 부르는 쪽은 예전처럼 './queries' 에서 그대로 가져다 쓴다.

   의존은 한 방향이다: 게임별 모듈 → core. 반대 방향은 없고, 만들지도 말 것.
   core 가 특정 게임을 알게 되면 순환이 생기고, 그때부터는 어느 파일을 먼저 읽어야
   하는지가 사라진다. */
import { one, all, run, tx, bumpGameStats, pruneStaleData } from './core';

/* ── 바카라 ──────────────────────────────────────────────────────────────
   포커 플립과 같은 공용 라운드 구조. 다만 배당이 매 라운드 같아서(선택이 없는 게임이라
   확률이 고정된다) 라운드마다 배당표를 저장하지 않고, 베팅 시점 값만 각 베팅 행에 박아 둔다. */

export const BACC_BETTING_SEC = 10;
// 베팅 마감 후 경과 초 기준 단계. 실제 바카라의 공개 순서를 그대로 따른다:
//   0~3초  첫 네 장과 양쪽 끗수 (여기서 세 번째 카드가 올지 안 올지가 정해진다)
//   3~6초  세 번째 카드 — 필요 없는 판이면 그대로 결과를 보는 시간이 된다
//   6초~   정산
export const BACC_DEAL_SEC = 0;    // 마감 즉시 첫 네 장
export const BACC_THIRD_SEC = 3;   // 세 번째 카드(있으면) 공개
export const BACC_SETTLE_SEC = 6;  // 정산
export const BACC_REVEAL_SEC = 3;  // 결과 확정 후 다음 라운드까지
export const BACC_KEEP_ROUNDS = 40;

export type BaccPhase = 'betting' | 'deal' | 'third' | 'done';

export interface BaccRoundRow {
  id: number;
  phase: BaccPhase;
  betting_ends_at: number;
  cards_json: string;
  result_json: string | null;
  resolved_at: number | null;
  created_at: number;
}

export interface BaccBetRow {
  user_id: string;
  username: string;
  market: string;
  amount: number;
  odds: number;
  won: number | null;
  payout: number | null;
}

export interface BaccOutcome {
  winner: 'player' | 'banker' | 'tie';
  playerTotal: number;
  bankerTotal: number;
  playerPair: boolean;
  bankerPair: boolean;
  natural: boolean;
  playerCards: number[];
  bankerCards: number[];
}

function settleBaccaratBets(roundId: number, o: BaccOutcome): void {
  const bets = all<{ id: number; user_id: string; market: string; amount: number; odds: number }>(
    `SELECT id, user_id, market, amount, odds FROM baccarat_bets WHERE round_id = ?`, roundId
  );
  /* 성적 집계는 루프 밖에서. 이 루프는 시장마다 도니까 한 사람이 플레이어·뱅커·타이·
     페어에 동시에 걸면 최대 5판으로 세어진다. 유저별로 모아 한 번만 센다.
     한 시장은 맞고 다른 시장은 틀려 순손익이 정확히 0이 되는 경우도 이렇게 하면
     자연히 푸시로 접힌다. */
  const perUser = new Map<string, { staked: number; returned: number }>();
  for (const b of bets) {
    let payout = 0, won = 0;
    if (b.market === 'player' || b.market === 'banker') {
      // 무승부는 승패 베팅에 원금 환불이다 (배당 계산이 이 환불분을 이미 반영하고 있다)
      if (o.winner === 'tie') { payout = b.amount; won = 0; }
      else if (o.winner === b.market) { payout = Math.floor(b.amount * b.odds); won = 1; }
    } else if (b.market === 'tie') {
      if (o.winner === 'tie') { payout = Math.floor(b.amount * b.odds); won = 1; }
    } else if (b.market === 'ppair') {
      if (o.playerPair) { payout = Math.floor(b.amount * b.odds); won = 1; }
    } else if (b.market === 'bpair') {
      if (o.bankerPair) { payout = Math.floor(b.amount * b.odds); won = 1; }
    }
    run(`UPDATE baccarat_bets SET won = ?, payout = ? WHERE id = ?`, won, payout, b.id);
    // 유저가 사라진 베팅은 건너뛴다 — 여기서 예외가 나면 트랜잭션이 롤백돼
    // 라운드가 영구히 정산되지 않고 모두의 게임이 멈춘다 (공용 라운드라 한 명이 전체를 막는다)
    if (!one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, b.user_id)) continue;
    if (payout > 0) run(`UPDATE users SET balance = balance + ? WHERE id = ?`, payout, b.user_id);
    const after = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, b.user_id)!;
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
      b.user_id, payout, 'game:baccarat', after.balance);
    const acc = perUser.get(b.user_id) ?? { staked: 0, returned: 0 };
    acc.staked += b.amount; acc.returned += payout;
    perUser.set(b.user_id, acc);
  }
  for (const [uid, a] of perUser) bumpGameStats(uid, 'baccarat', a.staked, a.returned);
}

function pruneBaccaratRounds(): void {
  const cutoff = one<{ id: number }>(
    `SELECT id FROM baccarat_rounds ORDER BY id DESC LIMIT 1 OFFSET ?`, BACC_KEEP_ROUNDS
  );
  if (!cutoff) return;
  run(`DELETE FROM baccarat_bets WHERE round_id <= ?`, cutoff.id);
  run(`DELETE FROM baccarat_rounds WHERE id <= ?`, cutoff.id);
}

export function advanceBaccaratRound(
  drawCards: () => number[],
  resolve: (cards: number[]) => BaccOutcome,
): BaccRoundRow {
  return tx(() => {
    const now = Math.floor(Date.now() / 1000);
    let round = one<BaccRoundRow>(`SELECT * FROM baccarat_rounds ORDER BY id DESC LIMIT 1`);

    if (round) {
      const e = now - round.betting_ends_at; // 베팅 마감 후 경과 초
      let phase: BaccPhase = 'betting';
      if (e >= BACC_SETTLE_SEC) phase = 'done';
      else if (e >= BACC_THIRD_SEC) phase = 'third';
      else if (e >= BACC_DEAL_SEC) phase = 'deal';

      if (phase !== round.phase) {
        if (phase === 'done' && round.phase !== 'done') {
          const outcome = resolve(JSON.parse(round.cards_json));
          settleBaccaratBets(round.id, outcome);
          run(`UPDATE baccarat_rounds SET phase = 'done', result_json = ?, resolved_at = ?
               WHERE id = ? AND phase != 'done'`, JSON.stringify(outcome), now, round.id);
        } else if (phase !== 'done') {
          run(`UPDATE baccarat_rounds SET phase = ? WHERE id = ?`, phase, round.id);
        }
        round = one<BaccRoundRow>(`SELECT * FROM baccarat_rounds WHERE id = ?`, round.id)!;
      }
    }

    if (!round || (round.phase === 'done' && (round.resolved_at ?? 0) + BACC_REVEAL_SEC <= now)) {
      run(`INSERT INTO baccarat_rounds (phase, betting_ends_at, cards_json) VALUES ('betting', ?, ?)`,
        now + BACC_BETTING_SEC, JSON.stringify(drawCards()));
      const id = one<{ id: number }>(`SELECT last_insert_rowid() AS id`)!.id;
      round = one<BaccRoundRow>(`SELECT * FROM baccarat_rounds WHERE id = ?`, id)!;
      pruneBaccaratRounds();
      pruneStaleData();
    }
    return round!;
  });
}

export function stackBaccaratBet(
  userId: string, username: string, roundId: number, market: string, amount: number, odds: number
): { ok: true; balance: number; staked: number } | { ok: false; error: 'insufficient_balance' | 'closed' } {
  return tx(() => {
    const r = one<{ phase: string; betting_ends_at: number }>(
      `SELECT phase, betting_ends_at FROM baccarat_rounds WHERE id = ?`, roundId
    );
    if (!r || r.phase !== 'betting' || r.betting_ends_at <= Math.floor(Date.now() / 1000)) {
      return { ok: false, error: 'closed' };
    }
    const before = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId);
    if (!before || before.balance < amount) return { ok: false, error: 'insufficient_balance' };
    run(`UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?`, amount, userId, amount);
    if (one<{ n: number }>(`SELECT changes() AS n`)!.n === 0) return { ok: false, error: 'insufficient_balance' };
    const after = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)!;
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
      userId, -amount, 'game:baccarat:bet', after.balance);
    run(
      `INSERT INTO baccarat_bets (round_id, user_id, username, market, amount, odds) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(round_id, user_id, market) DO UPDATE SET amount = amount + excluded.amount`,
      roundId, userId, username, market, amount, odds
    );
    const staked = one<{ amount: number }>(
      `SELECT amount FROM baccarat_bets WHERE round_id = ? AND user_id = ? AND market = ?`,
      roundId, userId, market
    )!.amount;
    return { ok: true, balance: after.balance, staked };
  });
}

export function clearBaccaratBets(userId: string, roundId: number):
  { ok: true; balance: number; refunded: number } | { ok: false; error: 'nothing' | 'closed' } {
  return tx(() => {
    const r = one<{ phase: string; betting_ends_at: number }>(
      `SELECT phase, betting_ends_at FROM baccarat_rounds WHERE id = ?`, roundId
    );
    if (!r || r.phase !== 'betting' || r.betting_ends_at <= Math.floor(Date.now() / 1000)) {
      return { ok: false, error: 'closed' };
    }
    const total = one<{ s: number }>(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM baccarat_bets WHERE round_id = ? AND user_id = ?`,
      roundId, userId
    )!.s;
    if (total <= 0) return { ok: false, error: 'nothing' };
    run(`DELETE FROM baccarat_bets WHERE round_id = ? AND user_id = ?`, roundId, userId);
    run(`UPDATE users SET balance = balance + ? WHERE id = ?`, total, userId);
    const after = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)!;
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
      userId, total, 'game:baccarat:bet', after.balance);
    return { ok: true, balance: after.balance, refunded: total };
  });
}

export function getBaccaratBets(roundId: number): BaccBetRow[] {
  return all<BaccBetRow>(
    `SELECT user_id, username, market, amount, odds, won, payout FROM baccarat_bets
     WHERE round_id = ? ORDER BY amount DESC, id ASC`, roundId
  );
}

export interface BaccPlayerRow {
  user_id: string; username: string; avatar: string | null; balance: number;
  staked: number; payout: number;
}

export function getBaccaratPlayers(roundId: number): BaccPlayerRow[] {
  return all<BaccPlayerRow>(
    `SELECT b.user_id, u.username, u.avatar, u.balance,
            SUM(b.amount) AS staked, COALESCE(SUM(b.payout), 0) AS payout
     FROM baccarat_bets b JOIN users u ON u.id = b.user_id
     WHERE b.round_id = ?
     GROUP BY b.user_id
     ORDER BY staked DESC, u.username ASC`, roundId
  );
}

export function getMyBaccaratBets(roundId: number, userId: string): BaccBetRow[] {
  return all<BaccBetRow>(
    `SELECT user_id, username, market, amount, odds, won, payout FROM baccarat_bets
     WHERE round_id = ? AND user_id = ? ORDER BY id ASC`, roundId, userId
  );
}

export interface BaccHistoryRow { winner: string; playerTotal: number; bankerTotal: number }

export function getRecentBaccaratResults(limit = 20): BaccHistoryRow[] {
  return all<{ result_json: string }>(
    `SELECT result_json FROM baccarat_rounds WHERE phase = 'done' AND result_json IS NOT NULL
     ORDER BY id DESC LIMIT ?`, limit
  ).map(r => {
    const o = JSON.parse(r.result_json) as BaccOutcome;
    return { winner: o.winner, playerTotal: o.playerTotal, bankerTotal: o.bankerTotal };
  });
}

