/* 그래프게임 질의 — 그래프게임.

   db/queries.ts 가 1,792줄이라 읽을 수 없어 도메인별로 나눴다. 코드는 한 줄도 바꾸지
   않고 구간을 그대로 옮겼고, queries.ts 는 전부 다시 내보내는 배럴로 남겨 두었다 —
   그래서 부르는 쪽은 예전처럼 './queries' 에서 그대로 가져다 쓴다.

   의존은 한 방향이다: 게임별 모듈 → core. 반대 방향은 없고, 만들지도 말 것.
   core 가 특정 게임을 알게 되면 순환이 생기고, 그때부터는 어느 파일을 먼저 읽어야
   하는지가 사라진다. */
import { one, all, run, tx, bumpGameStats, pruneStaleData, payoutAt } from './core';

export const CRASH_BETTING_SEC = 10;
export const CRASH_REVEAL_SEC = 3; // 버스트 표시 후 다음 라운드까지
const CRASH_KEEP_ROUNDS = 30;

export interface CrashRoundRow {
  id: number;
  phase: 'betting' | 'running' | 'done';
  betting_ends_at: number;
  started_at_ms: number | null;
  crash_point: number;
  resolved_at: number | null;
  created_at: number;
}

export interface CrashBetRow {
  user_id: string;
  username: string;
  avatar: string | null;        // 우측 참가자 패널용
  balance: number;              // 실시간 보유 포인트
  amount: number;
  auto_cashout: number | null;
  cashout_multiplier: number | null;
  payout: number | null;
}

function pruneCrashRounds(): void {
  const cutoff = one<{ id: number }>(
    `SELECT id FROM crash_rounds ORDER BY id DESC LIMIT 1 OFFSET ?`, CRASH_KEEP_ROUNDS
  );
  if (!cutoff) return;
  run(`DELETE FROM crash_bets WHERE round_id <= ?`, cutoff.id);
  run(`DELETE FROM crash_rounds WHERE id <= ?`, cutoff.id);
}

// 자동 캐시아웃 처리: 목표 배율이 uptoMultiplier 이하인 베팅을 "목표 배율 그대로" 정산한다.
// 요청 시각이 아니라 목표 배율로 정산하므로, 누가 언제 폴링했는지와 무관하게 결과가 결정적이다.
// (크래시 지점보다 목표가 낮으면 반드시 성공, 높으면 도달 전에 터지므로 손실 — 폴링 여부가 결과를 바꾸지 않는다)
function settleCrashAutoCashouts(roundId: number, uptoMultiplier: number): void {
  const bets = all<{ id: number; user_id: string; amount: number; auto_cashout: number }>(
    `SELECT id, user_id, amount, auto_cashout FROM crash_bets
     WHERE round_id = ? AND cashout_multiplier IS NULL AND auto_cashout IS NOT NULL AND auto_cashout <= ?`,
    roundId, uptoMultiplier
  );
  for (const b of bets) {
    const payout = Math.floor(b.amount * b.auto_cashout);
    run(`UPDATE crash_bets SET cashout_multiplier = ?, payout = ? WHERE id = ? AND cashout_multiplier IS NULL`,
      b.auto_cashout, payout, b.id);
    if (one<{ n: number }>(`SELECT changes() AS n`)!.n !== 1) continue;
    // 유저가 사라진 베팅은 건너뛴다 (아래 settleCrashLosers와 같은 이유 — 라운드 전체 정산이 막힌다)
    if (!one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, b.user_id)) continue;
    run(`UPDATE users SET balance = balance + ? WHERE id = ?`, payout, b.user_id);
    const bal = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, b.user_id)!;
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
      b.user_id, payout, 'game:graph', bal.balance);
    bumpGameStats(b.user_id, 'graph', b.amount, payout);
  }
}

// 크래시 시점에 아직 캐시아웃하지 않은 베팅은 전부 손실 처리(payout 0)
function settleCrashLosers(roundId: number): void {
  const losers = all<{ id: number; user_id: string; amount: number }>(
    `SELECT id, user_id, amount FROM crash_bets WHERE round_id = ? AND cashout_multiplier IS NULL`, roundId
  );
  for (const b of losers) {
    /* 조건부 UPDATE로 한 번만 처리되게 못 박는다. 예전에는 라운드 phase 가드에만
       의존했는데, 그러면 같은 라운드 정산이 겹칠 때 원장과 성적 집계가 두 번 더해질
       여지가 있다 (settleCrashAutoCashouts는 처음부터 이 방식이다). */
    run(`UPDATE crash_bets SET payout = 0 WHERE id = ? AND payout IS NULL`, b.id);
    if (one<{ n: number }>(`SELECT changes() AS n`)!.n !== 1) continue;
    const bal = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, b.user_id);
    if (!bal) continue;   // 유저가 사라진 베팅 — 원장만 못 남기고 넘어간다 (라운드는 정상 마감)
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
      b.user_id, 0, 'game:graph', bal.balance);
    bumpGameStats(b.user_id, 'graph', b.amount, 0);
  }
}

// 매 요청마다 호출되는 지연 진행 방식 (사다리와 동일하게 백그라운드 타이머 없음 → scale-to-zero 호환).
// 상승 시작 시각을 "베팅 마감 시각"으로 고정하는 게 핵심 — 누가 먼저 폴링했는지에 따라 배율이 달라지면 안 된다.
export function advanceCrashRound(helpers: {
  makeCrashPoint: () => number;
  crashDurationMs: (crashPoint: number) => number;
  multiplierAt: (elapsedMs: number) => number;
}): CrashRoundRow {
  const { makeCrashPoint, crashDurationMs, multiplierAt } = helpers;
  return tx(() => {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    let round = one<CrashRoundRow>(`SELECT * FROM crash_rounds ORDER BY id DESC LIMIT 1`);

    if (round && round.phase === 'betting' && round.betting_ends_at <= nowSec) {
      run(`UPDATE crash_rounds SET phase = 'running', started_at_ms = ? WHERE id = ? AND phase = 'betting'`,
        round.betting_ends_at * 1000, round.id);
      round = one<CrashRoundRow>(`SELECT * FROM crash_rounds WHERE id = ?`, round.id)!;
    }

    if (round && round.phase === 'running') {
      const crashAtMs = (round.started_at_ms ?? nowMs) + crashDurationMs(round.crash_point);
      if (nowMs >= crashAtMs) {
        // 먼저 크래시 지점 이하를 목표로 한 자동 캐시아웃을 성공 처리한 뒤, 남은 베팅을 손실 처리한다.
        // (아무도 중간에 폴링하지 않았어도 자동 캐시아웃이 누락되지 않도록 크래시 시점에 한 번 더 훑는다)
        settleCrashAutoCashouts(round.id, round.crash_point);
        settleCrashLosers(round.id);
        run(`UPDATE crash_rounds SET phase = 'done', resolved_at = ? WHERE id = ? AND phase = 'running'`, nowSec, round.id);
        round = one<CrashRoundRow>(`SELECT * FROM crash_rounds WHERE id = ?`, round.id)!;
      } else {
        // 진행 중: 현재 배율까지 도달한 자동 캐시아웃을 즉시 확정해 실시간으로 보이게 한다
        settleCrashAutoCashouts(round.id, multiplierAt(nowMs - (round.started_at_ms ?? nowMs)));
      }
    }

    if (!round || (round.phase === 'done' && (round.resolved_at ?? 0) + CRASH_REVEAL_SEC <= nowSec)) {
      run(`INSERT INTO crash_rounds (phase, betting_ends_at, crash_point) VALUES ('betting', ?, ?)`,
        nowSec + CRASH_BETTING_SEC, makeCrashPoint());
      const id = one<{ id: number }>(`SELECT last_insert_rowid() AS id`)!.id;
      round = one<CrashRoundRow>(`SELECT * FROM crash_rounds WHERE id = ?`, id)!;
      pruneCrashRounds();
      pruneStaleData();
    }
    return round!;
  });
}

export function placeCrashBet(
  userId: string, username: string, roundId: number, amount: number, autoCashout: number | null
): { ok: true; balance: number } | { ok: false; error: 'insufficient_balance' | 'already_bet' | 'closed' } {
  return tx(() => {
    const r = one<{ phase: string; betting_ends_at: number }>(
      `SELECT phase, betting_ends_at FROM crash_rounds WHERE id = ?`, roundId
    );
    if (!r || r.phase !== 'betting' || r.betting_ends_at <= Math.floor(Date.now() / 1000)) {
      return { ok: false, error: 'closed' };
    }
    if (one<{ id: number }>(`SELECT id FROM crash_bets WHERE round_id = ? AND user_id = ?`, roundId, userId)) {
      return { ok: false, error: 'already_bet' };
    }
    const before = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId);
    if (!before || before.balance < amount) return { ok: false, error: 'insufficient_balance' };
    run(`UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?`, amount, userId, amount);
    if (one<{ n: number }>(`SELECT changes() AS n`)!.n === 0) return { ok: false, error: 'insufficient_balance' };
    const after = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)!;
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
      userId, -amount, 'game:graph:bet', after.balance);
    run(`INSERT INTO crash_bets (round_id, user_id, username, amount, auto_cashout) VALUES (?, ?, ?, ?, ?)`,
      roundId, userId, username, amount, autoCashout);
    return { ok: true, balance: after.balance };
  });
}

// 베팅 취소 — 상승이 시작되기 전(베팅 구간)에만 가능
export function cancelCrashBet(userId: string, roundId: number):
  { ok: true; balance: number } | { ok: false; error: 'closed' | 'no_bet' } {
  return tx(() => {
    const r = one<{ phase: string; betting_ends_at: number }>(
      `SELECT phase, betting_ends_at FROM crash_rounds WHERE id = ?`, roundId
    );
    if (!r || r.phase !== 'betting' || r.betting_ends_at <= Math.floor(Date.now() / 1000)) {
      return { ok: false, error: 'closed' };
    }
    const bet = one<{ id: number; amount: number }>(
      `SELECT id, amount FROM crash_bets WHERE round_id = ? AND user_id = ?`, roundId, userId
    );
    if (!bet) return { ok: false, error: 'no_bet' };
    run(`DELETE FROM crash_bets WHERE id = ?`, bet.id);
    run(`UPDATE users SET balance = balance + ? WHERE id = ?`, bet.amount, userId);
    const after = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)!;
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
      userId, bet.amount, 'game:graph:cancel', after.balance);
    return { ok: true, balance: after.balance };
  });
}

// 캐시아웃: 배율은 서버 시간으로만 계산하고, 아직 캐시아웃하지 않은 베팅만 조건부로 확정한다(이중 지급 차단).
export function cashoutCrashBet(userId: string, roundId: number, multiplier: number):
  { ok: true; balance: number; payout: number } | { ok: false; error: 'no_bet' | 'already_cashed' } {
  return tx(() => {
    const bet = one<{ id: number; amount: number; cashout_multiplier: number | null;
                      payout: number | null }>(
      `SELECT id, amount, cashout_multiplier, payout FROM crash_bets
        WHERE round_id = ? AND user_id = ?`, roundId, userId
    );
    if (!bet) return { ok: false, error: 'no_bet' };
    /* 끝난 베팅인가를 cashout_multiplier 하나로 가리면 안 된다. 터져서 진 베팅은 그
       칸이 NULL 인 채로 payout 에 0 이 적히기 때문이다(라운드 마감이 그렇게 적는다).
       그래서 이미 잃은 베팅에 대고 캐시아웃을 부르면 그대로 통과해 돈이 나갔다 —
       걸지 않은 포인트가 생기는 자리다. payout 이 채워졌으면 그 베팅은 끝난 것이다. */
    if (bet.cashout_multiplier !== null || bet.payout !== null) {
      return { ok: false, error: 'already_cashed' };
    }
    const payout = payoutAt(bet.amount, multiplier);
    run(`UPDATE crash_bets SET cashout_multiplier = ?, payout = ?
          WHERE id = ? AND cashout_multiplier IS NULL AND payout IS NULL`,
      multiplier, payout, bet.id);
    if (one<{ n: number }>(`SELECT changes() AS n`)!.n !== 1) return { ok: false, error: 'already_cashed' };
    run(`UPDATE users SET balance = balance + ? WHERE id = ?`, payout, userId);
    const after = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)!;
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
      userId, payout, 'game:graph', after.balance);
    bumpGameStats(userId, 'graph', bet.amount, payout);
    return { ok: true, balance: after.balance, payout };
  });
}

export function getCrashBets(roundId: number): CrashBetRow[] {
  return all<CrashBetRow>(
    `SELECT b.user_id, b.username, u.avatar, u.balance, b.amount, b.auto_cashout, b.cashout_multiplier, b.payout
     FROM crash_bets b JOIN users u ON u.id = b.user_id
     WHERE b.round_id = ? ORDER BY b.amount DESC, b.id ASC`, roundId
  );
}

export function getMyCrashBet(roundId: number, userId: string): CrashBetRow | undefined {
  return one<CrashBetRow>(
    `SELECT username, amount, auto_cashout, cashout_multiplier, payout FROM crash_bets
     WHERE round_id = ? AND user_id = ?`, roundId, userId
  );
}

// 최근 크래시 배율 기록 (한 줄 출목표용). 최신이 앞(=화면 왼쪽)에 오도록 내림차순 그대로 반환한다.
// → 화면이 좁아 잘릴 때 오래된 결과가 있는 오른쪽부터 잘리므로 중요한 최신 결과는 항상 보인다.
export function getRecentCrashResults(limit = 15): number[] {
  return all<{ crash_point: number }>(
    `SELECT crash_point FROM crash_rounds WHERE phase = 'done' ORDER BY id DESC LIMIT ?`, limit
  ).map(r => r.crash_point);
}

// ----- 포커 플립: 실시간 공용 라운드 (홀카드 공개 → 베팅 → 플롭·턴·리버 순차 공개) -----

