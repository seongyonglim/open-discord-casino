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
  resolve: (hole: number[], board: number[]) => { winner: 'master' | 'shark' | 'tie'; buckets: number[]; detail: unknown },
  /* 등급 칸 수. resolve 와 같은 이유로 인자로 받는다 — 이 파일은 services 를 모른다
     (의존은 게임별 모듈 → core 한 방향이다). 칸이 하나 늘면 부르는 쪽이 알려 준다. */
  bucketCount: number
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

      /* 정산 여부의 근거는 phase 가 아니라 result_json 이다.

         phase 는 "지금 시각 - 베팅 마감" 으로 매번 다시 계산되는 값이라, 그 계산에
         쓰이는 상수가 바뀌면 이미 끝난 판이 river 로 되돌아간다. 예전 코드는 그때
         phase 만 보고 판단해서, 되돌아간 판이 다시 done 에 닿는 순간 같은 베팅을 한 번
         더 지급했다. 아래 UPDATE 의 `phase != done` 가드로는 못 막는다 — 돈은 그보다
         윗줄에서 이미 나갔고, 그 시점 phase 는 river 라 UPDATE 도 그냥 성공한다.

         result_json 은 한 번 채워지면 다시 비지 않으므로 "이 판은 정산됐다" 를 말할 수
         있는 유일한 값이다. 되돌리는 쪽도 그것을 보게 해서, 끝난 판은 단계가 아예
         역행하지 못하게 한다. */
      const settled = round.result_json != null;
      if (phase !== round.phase && !(settled && phase !== 'done')) {
        if (phase === 'done' && !settled) {
          /* 표가 비어 있으면 남은 기록으로 먼저 채운다 — 반드시 이 판이 «done» 이 되기
             전에 해야 한다. 뒤에 두면 지금 정산 중인 판이 기록에 이미 들어가 있어서
             그 판이 두 번 세어진다(실측: 한 판을 돌렸는데 미출현이 2 로 올랐다). */
          seedPokerDrought(bucketCount);
          const outcome = resolve(JSON.parse(round.hole_json), JSON.parse(round.board_json));
          settlePokerBets(round.id, outcome);
          run(`UPDATE poker_rounds SET phase = 'done', result_json = ?, resolved_at = ? WHERE id = ? AND phase != 'done'`,
            JSON.stringify(outcome), now, round.id);
          /* 미출현 판수를 여기서 센다 — 라운드가 «done» 이 되는 자리는 여기 하나뿐이라
             한 판이 두 번 세어질 수 없다(위 UPDATE 의 phase != 'done' 이 그것을 지킨다). */
          notePokerDrought(outcome.buckets, bucketCount);
        } else if (phase !== 'done') {
          run(`UPDATE poker_rounds SET phase = ? WHERE id = ? AND result_json IS NULL`,
            phase, round.id);
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

/* ── 등급별 미출현 판수 ───────────────────────────────────────────────
   화면이 "몇 판째 안 나왔나"를 적는데, 그 값을 라운드 기록에서 세면 30판이 한계다 —
   그 너머는 prunePokerRounds 가 지운다. 그래서 «29판+ 미출현» 으로 잘렸다.
   판수 자체가 이 게임의 재미인데 상한에 걸려 뭉개지고 있었다.

   그래서 세어 둔다. 라운드가 정산될 때 한 줄씩 갱신하면 30판이 지워져도 값이 남는다. */
export interface PokerDroughtRow { bucket: number; since: number; best: number; exact: number }

export function getPokerDrought(): PokerDroughtRow[] {
  return all<PokerDroughtRow>(`SELECT bucket, since, best, exact FROM poker_drought ORDER BY bucket`);
}

/**
 * 정산된 라운드 하나를 카운터에 반영한다.
 *
 * 적중한 등급은 0 으로 되돌리고 그때까지의 값을 최장 기록과 견준다. 나머지는 1 씩 올린다.
 * 적중으로 리셋된 값은 이 순간부터 정확하므로 exact 를 세운다 — 표를 처음 만들 때 넣은
 * "적어도 N판"이 그 등급에서는 사라진다.
 */
export function notePokerDrought(buckets: number[], bucketCount: number): void {
  for (let b = 0; b < bucketCount; b++) {
    if (buckets.includes(b)) {
      run(`INSERT INTO poker_drought (bucket, since, best, exact) VALUES (?, 0, 0, 1)
             ON CONFLICT(bucket) DO UPDATE SET best = MAX(best, since), since = 0, exact = 1`, b);
    } else {
      run(`INSERT INTO poker_drought (bucket, since, best, exact) VALUES (?, 1, 0, 0)
             ON CONFLICT(bucket) DO UPDATE SET since = since + 1`, b);
    }
  }
}

/**
 * 표가 비어 있으면 남아 있는 라운드로 채운다 — 배포 직후 다섯 칸이 «0판» 으로 보이면
 * "방금 다 나왔다"는 거짓말이 된다.
 *
 * 남아 있는 것은 30판뿐이라 여기서 넣는 값은 «적어도 N판» 이다. 그래서 exact 를 세우지
 * 않는다: 화면이 그동안은 예전처럼 «N판+» 로 적고, 그 등급이 한 번 적중하면 정확한
 * 값으로 바뀐다.
 */
export function seedPokerDrought(bucketCount: number): void {
  const has = one<{ n: number }>(`SELECT COUNT(*) AS n FROM poker_drought`)!.n;
  if (has > 0) return;
  const hist = getRecentPokerResults(POKER_KEEP_ROUNDS);
  for (let b = 0; b < bucketCount; b++) {
    const k = hist.findIndex(h => h.buckets.includes(b));
    /* 못 찾았으면 가진 기록 전부가 미출현이다. 찾았으면 그 앞의 판 수가 미출현이고,
       그 값은 정확하다 — 그 등급은 기록 안에서 실제로 적중했기 때문이다. */
    const since = k < 0 ? hist.length : k;
    run(`INSERT INTO poker_drought (bucket, since, best, exact) VALUES (?, ?, ?, ?)`,
      b, since, since, k < 0 ? 0 : 1);
  }
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

