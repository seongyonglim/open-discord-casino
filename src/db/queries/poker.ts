/* 포커 플립 질의 — 포커 플립.

   db/queries.ts 가 1,792줄이라 읽을 수 없어 도메인별로 나눴다. 코드는 한 줄도 바꾸지
   않고 구간을 그대로 옮겼고, queries.ts 는 전부 다시 내보내는 배럴로 남겨 두었다 —
   그래서 부르는 쪽은 예전처럼 './queries' 에서 그대로 가져다 쓴다.

   의존은 한 방향이다: 게임별 모듈 → core. 반대 방향은 없고, 만들지도 말 것.
   core 가 특정 게임을 알게 되면 순환이 생기고, 그때부터는 어느 파일을 먼저 읽어야
   하는지가 사라진다. */
import { one, all, run, tx, bumpGameStats, pruneStaleData } from './core';

export const POKER_BETTING_SEC = 15;
// 모두 베팅 마감(betting_ends_at) 기준 경과 초. 서버 페이즈 판정과 클라이언트 카운트다운이
// 이 값만 보고 움직이므로 여기만 바꾸면 공개 간격이 함께 조정된다.
//
// 플롭 3장은 베팅 마감과 동시에(경과 0초) 열린다. 예전에는 POKER_FLOP_SEC=3이 따로 있었지만
// 아래 판정의 마지막 분기가 e>=0을 이미 'flop'으로 잡고 있어서 실제로는 쓰이지 않는 상수였고,
// 그 탓에 "플롭 → 4번째 카드" 간격이 POKER_TURN_SEC 전체가 되어 유독 길게 느껌졌다.
export const POKER_TURN_SEC = 2;   // 턴(4번째) — 플롭에서 2초 후
export const POKER_RIVER_SEC = 4;  // 리버(5번째) — 턴에서 2초 후
export const POKER_SETTLE_SEC = 7; // 정산 — 완성된 보드를 보는 시간 3초
export const POKER_REVEAL_SEC = 3; // 결과 확정 후 다음 라운드까지
export const POKER_KEEP_ROUNDS = 30;

export type PokerPhase = 'betting' | 'flop' | 'turn' | 'river' | 'done';

export interface PokerRoundRow {
  id: number;
  phase: PokerPhase;
  betting_ends_at: number;
  hole_json: string;
  board_json: string;
  odds_json: string;
  result_json: string | null;
  resolved_at: number | null;
  created_at: number;
}

export interface PokerBetRow {
  user_id: string;
  username: string;
  market: string;
  amount: number;
  odds: number;
  won: number | null;
  payout: number | null;
}

// 라운드에 참가한 플레이어 목록 — 우측 패널(아바타·닉네임·보유 포인트)과
// "누구 아이콘에서 칩이 날아오는지" 연출에 쓴다.
export interface PokerPlayerRow {
  user_id: string;
  username: string;
  avatar: string | null;
  balance: number;
  staked: number;
  payout: number | null;
}

function prunePokerRounds(): void {
  const cutoff = one<{ id: number }>(
    `SELECT id FROM poker_rounds ORDER BY id DESC LIMIT 1 OFFSET ?`, POKER_KEEP_ROUNDS
  );
  if (!cutoff) return;
  run(`DELETE FROM poker_bets WHERE round_id <= ?`, cutoff.id);
  run(`DELETE FROM poker_rounds WHERE id <= ?`, cutoff.id);
}

// 정산: 승자 시장은 무승부 시 원금 환불, 등급 시장은 두 핸드 중 하나라도 그 등급이면 적중
function settlePokerBets(roundId: number, outcome: { winner: 'master' | 'shark' | 'tie'; buckets: number[] }): void {
  const bets = all<{ id: number; user_id: string; market: string; amount: number; odds: number }>(
    `SELECT id, user_id, market, amount, odds FROM poker_bets WHERE round_id = ?`, roundId
  );
  /* 성적 집계는 루프 안에서 하지 않는다. 이 루프는 시장(market)마다 도니까,
     한 사람이 세 시장에 걸면 3판으로 세어진다. 유저별로 모아 루프 밖에서 한 번만 센다. */
  const perUser = new Map<string, { staked: number; returned: number }>();
  for (const b of bets) {
    let payout = 0, won = 0;
    if (b.market === 'master' || b.market === 'shark') {
      if (outcome.winner === 'tie') { payout = b.amount; won = 0; }       // 무승부 → 원금 환불
      else if (outcome.winner === b.market) { payout = Math.floor(b.amount * b.odds); won = 1; }
    } else if (b.market === 'tie') {
      if (outcome.winner === 'tie') { payout = Math.floor(b.amount * b.odds); won = 1; }
    } else if (b.market.startsWith('b')) {
      const idx = Number(b.market.slice(1));
      if (outcome.buckets.includes(idx)) { payout = Math.floor(b.amount * b.odds); won = 1; }
    }
    run(`UPDATE poker_bets SET won = ?, payout = ? WHERE id = ?`, won, payout, b.id);
    // 유저가 사라진 베팅(계정 삭제 등)은 지급을 건너뛴다.
    // 여기서 예외가 나면 트랜잭션이 롤백돼 라운드가 영구히 정산되지 않고 게임 전체가 멈춘다.
    const bal = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, b.user_id);
    if (!bal) continue;
    if (payout > 0) {
      run(`UPDATE users SET balance = balance + ? WHERE id = ?`, payout, b.user_id);
    }
    const after = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, b.user_id)!;
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
      b.user_id, payout, 'game:poker', after.balance);
    const acc = perUser.get(b.user_id) ?? { staked: 0, returned: 0 };
    acc.staked += b.amount; acc.returned += payout;
    perUser.set(b.user_id, acc);
  }
  for (const [uid, a] of perUser) bumpGameStats(uid, 'poker', a.staked, a.returned);
}

// 요청 시점에 라운드를 진행시킨다 (백그라운드 타이머 없음 → scale-to-zero 호환).
// 공개 시각은 모두 betting_ends_at 기준으로 고정 계산하므로 누가 먼저 폴링했는지와 무관하게 동일하다.
export function advancePokerRound(
  makeRound: () => { hole: number[]; board: number[]; odds: unknown },
  resolve: (hole: number[], board: number[]) => { winner: 'master' | 'shark' | 'tie'; buckets: number[]; detail: unknown }
): PokerRoundRow {
  return tx(() => {
    const now = Math.floor(Date.now() / 1000);
    let round = one<PokerRoundRow>(`SELECT * FROM poker_rounds ORDER BY id DESC LIMIT 1`);

    if (round) {
      const e = now - round.betting_ends_at; // 베팅 마감 후 경과 초
      let phase: PokerPhase = 'betting';
      if (e >= POKER_SETTLE_SEC) phase = 'done';
      else if (e >= POKER_RIVER_SEC) phase = 'river';
      else if (e >= POKER_TURN_SEC) phase = 'turn';
      else if (e >= 0) phase = 'flop'; // 베팅이 닫히는 순간 플롭 3장 공개

      if (phase !== round.phase) {
        if (phase === 'done' && round.phase !== 'done') {
          const outcome = resolve(JSON.parse(round.hole_json), JSON.parse(round.board_json));
          settlePokerBets(round.id, outcome);
          run(`UPDATE poker_rounds SET phase = 'done', result_json = ?, resolved_at = ? WHERE id = ? AND phase != 'done'`,
            JSON.stringify(outcome), now, round.id);
        } else if (phase !== 'done') {
          run(`UPDATE poker_rounds SET phase = ? WHERE id = ?`, phase, round.id);
        }
        round = one<PokerRoundRow>(`SELECT * FROM poker_rounds WHERE id = ?`, round.id)!;
      }
    }

    if (!round || (round.phase === 'done' && (round.resolved_at ?? 0) + POKER_REVEAL_SEC <= now)) {
      const { hole, board, odds } = makeRound();
      run(
        `INSERT INTO poker_rounds (phase, betting_ends_at, hole_json, board_json, odds_json)
         VALUES ('betting', ?, ?, ?, ?)`,
        now + POKER_BETTING_SEC, JSON.stringify(hole), JSON.stringify(board), JSON.stringify(odds)
      );
      const id = one<{ id: number }>(`SELECT last_insert_rowid() AS id`)!.id;
      round = one<PokerRoundRow>(`SELECT * FROM poker_rounds WHERE id = ?`, id)!;
      prunePokerRounds();
      pruneStaleData();
    }
    return round!;
  });
}

// 칩 쌓기: 같은 시장에 여러 번 베팅하면 한 행의 amount가 누적된다
export function stackPokerBet(
  userId: string, username: string, roundId: number, market: string, amount: number, odds: number
): { ok: true; balance: number; staked: number } | { ok: false; error: 'insufficient_balance' | 'closed' } {
  return tx(() => {
    const r = one<{ phase: string; betting_ends_at: number }>(
      `SELECT phase, betting_ends_at FROM poker_rounds WHERE id = ?`, roundId
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
      userId, -amount, 'game:poker:bet', after.balance);
    run(
      `INSERT INTO poker_bets (round_id, user_id, username, market, amount, odds) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(round_id, user_id, market) DO UPDATE SET amount = amount + excluded.amount`,
      roundId, userId, username, market, amount, odds
    );
    const staked = one<{ amount: number }>(
      `SELECT amount FROM poker_bets WHERE round_id = ? AND user_id = ? AND market = ?`, roundId, userId, market
    )!.amount;
    return { ok: true, balance: after.balance, staked };
  });
}

// Clear Screen — 이번 라운드에 올린 내 칩 전부 회수 (베팅 구간에만 가능)
export function clearPokerBets(userId: string, roundId: number):
  { ok: true; balance: number; refunded: number } | { ok: false; error: 'closed' | 'no_bet' } {
  return tx(() => {
    const r = one<{ phase: string; betting_ends_at: number }>(
      `SELECT phase, betting_ends_at FROM poker_rounds WHERE id = ?`, roundId
    );
    if (!r || r.phase !== 'betting' || r.betting_ends_at <= Math.floor(Date.now() / 1000)) {
      return { ok: false, error: 'closed' };
    }
    const total = one<{ t: number | null }>(
      `SELECT SUM(amount) AS t FROM poker_bets WHERE round_id = ? AND user_id = ?`, roundId, userId
    )!.t ?? 0;
    if (total <= 0) return { ok: false, error: 'no_bet' };
    run(`DELETE FROM poker_bets WHERE round_id = ? AND user_id = ?`, roundId, userId);
    run(`UPDATE users SET balance = balance + ? WHERE id = ?`, total, userId);
    const after = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)!;
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
      userId, total, 'game:poker:clear', after.balance);
    return { ok: true, balance: after.balance, refunded: total };
  });
}

export function getPokerBets(roundId: number): PokerBetRow[] {
  return all<PokerBetRow>(
    `SELECT user_id, username, market, amount, odds, won, payout FROM poker_bets
     WHERE round_id = ? ORDER BY amount DESC, id ASC`, roundId
  );
}

// 참가자별 합계 + 현재 보유 포인트. 보유 포인트는 랭킹 화면에서 이미 공개되는 값이다.
export function getPokerPlayers(roundId: number): PokerPlayerRow[] {
  return all<PokerPlayerRow>(
    `SELECT b.user_id, u.username, u.avatar, u.balance,
            SUM(b.amount) AS staked, SUM(COALESCE(b.payout, 0)) AS payout
     FROM poker_bets b JOIN users u ON u.id = b.user_id
     WHERE b.round_id = ?
     GROUP BY b.user_id
     ORDER BY staked DESC, u.username ASC`, roundId
  );
}

export function getMyPokerBets(roundId: number, userId: string): PokerBetRow[] {
  return all<PokerBetRow>(
    `SELECT username, market, amount, odds, won, payout FROM poker_bets
     WHERE round_id = ? AND user_id = ? ORDER BY id ASC`, roundId, userId
  );
}

export interface PokerHistoryRow { winner: string; buckets: number[] }

export function getRecentPokerResults(limit = 12): PokerHistoryRow[] {
  return all<{ result_json: string }>(
    `SELECT result_json FROM poker_rounds WHERE phase = 'done' AND result_json IS NOT NULL
     ORDER BY id DESC LIMIT ?`, limit
  ).map(r => {
    const o = JSON.parse(r.result_json) as { winner: string; buckets: number[] };
    return { winner: o.winner, buckets: o.buckets };
  });
}

