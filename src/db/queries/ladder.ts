/* 사다리게임 질의 — 사다리게임.

   db/queries.ts 가 1,792줄이라 읽을 수 없어 도메인별로 나눴다. 코드는 한 줄도 바꾸지
   않고 구간을 그대로 옮겼고, queries.ts 는 전부 다시 내보내는 배럴로 남겨 두었다 —
   그래서 부르는 쪽은 예전처럼 './queries' 에서 그대로 가져다 쓴다.

   의존은 한 방향이다: 게임별 모듈 → core. 반대 방향은 없고, 만들지도 말 것.
   core 가 특정 게임을 알게 되면 순환이 생기고, 그때부터는 어느 파일을 먼저 읽어야
   하는지가 사라진다. */
import { one, all, run, tx, bumpGameStats, pruneStaleData } from './core';

export const LADDER_BETTING_SEC = 10;
// 공이 다 내려온 "뒤에" 결과를 보는 시간 3초. 다른 게임의 다음 라운드 대기와 같은 값이다.
// 실제 공개 구간은 ladder.ts의 revealSecFor()가 ceil(하강시간) + 이 값으로 계산하므로,
// 연출을 늦춰도 하강 도중에 다음 라운드가 시작되지 않는다(창이 하강 길이에 맞춰 늘어난다).
export const LADDER_REVEAL_SEC = 3;
export const LADDER_MULTIPLIER = 1.95; // 출발 또는 도착 중 하나만 맞히는 단일 예측
export const LADDER_DOUBLE_MULTIPLIER = 3.95; // 출발+도착 둘 다 맞히는 더블 예측

export interface LadderRoundRow {
  id: number;
  phase: 'betting' | 'done';
  betting_ends_at: number;
  start_side: string | null;
  end_side: string | null;
  rungs_json: string | null;
  resolved_at: number | null;
  created_at: number;
}

export interface LadderBetRow {
  user_id: string;
  username: string;
  avatar: string | null;        // 우측 참가자 패널용 (디스코드 프로필 이미지 URL)
  balance: number;              // 실시간 보유 포인트
  start_guess: string | null;   // 'L' | 'R'
  parity_guess: string | null;  // 'ODD' | 'EVEN' (도착 지점의 홀짝)
  amount: number;
  won: number | null;
  payout: number | null;
}

// 도착 지점의 홀짝 표기 — 왼쪽 도착 = 홀(ODD), 오른쪽 도착 = 짝(EVEN).
// 출발은 좌/우로, 도착은 홀/짝으로 표기해 두 베팅 축을 시각적으로 구분한다.
export function ladderParity(endSide: string): 'ODD' | 'EVEN' {
  return endSide === 'L' ? 'ODD' : 'EVEN';
}

/* 감사도 이 함수를 직접 부른다 — 라운드를 실제로 굴리려면 시각을 조작해야 하는데,
   그러면 "내가 만든 흐름"을 검사하게 된다. 정산 자체를 태워야 연승이 진짜 그 자리에서
   쌓이는지 확인된다. */
export function settleLadderBets(roundId: number, startSide: string, endSide: string): void {
  const parity = ladderParity(endSide);
  const bets = all<{ id: number; user_id: string; start_guess: string | null; parity_guess: string | null; amount: number }>(
    `SELECT id, user_id, start_guess, parity_guess, amount FROM ladder_bets WHERE round_id = ?`, roundId
  );
  for (const b of bets) {
    const isDouble = b.start_guess !== null && b.parity_guess !== null;
    const won = isDouble
      ? b.start_guess === startSide && b.parity_guess === parity
      : (b.start_guess !== null ? b.start_guess === startSide : b.parity_guess === parity);
    const multiplier = isDouble ? LADDER_DOUBLE_MULTIPLIER : LADDER_MULTIPLIER;
    const payout = won ? Math.floor(b.amount * multiplier) : 0;
    run(`UPDATE ladder_bets SET won = ?, payout = ? WHERE id = ?`, won ? 1 : 0, payout, b.id);
    // 유저가 사라진 베팅은 건너뛴다 — 여기서 예외가 나면 트랜잭션이 롤백돼 라운드가
    // 영구히 정산되지 않고 모두의 게임이 멈춘다 (공용 라운드라 한 명이 전체를 막는다)
    if (!one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, b.user_id)) continue;
    if (payout > 0) run(`UPDATE users SET balance = balance + ? WHERE id = ?`, payout, b.user_id);
    const bal = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, b.user_id)!;
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`, b.user_id, payout, 'game:ladder', bal.balance);
    bumpGameStats(b.user_id, 'ladder', b.amount, payout);
    trackRightStreak(b.user_id, b.start_guess, won, b.amount);
  }
}

/* ── 연속 '우' 승리 ────────────────────────────────────────────────
   [사다리게임] 극우 이대남 — 오른쪽으로만 걸어 일곱 번 이긴다.

   판을 쉬는 것은 끊기는 것이 아니다. 안 건 판에서는 이 함수가 아예 안 불린다
   (정산은 그 라운드에 건 사람만 훑는다) — 그래서 값이 그대로 남는다. 그것이 곧
   "쉬어가기 허용"이고, 따로 처리할 것이 없다.

   1,000P 미만 베팅은 연승에 영향을 주지 않는다. 문지기를 여기 두는 이유는, 과제 쪽에
   두면 이미 쌓인 연승으로 열려 버려서 소액으로 쌓는 것을 막지 못하기 때문이다.
   그래서 1P 로 걸고 이겨도 연승이 오르지 않고, 1P 로 걸고 져도 끊기지 않는다.

   출발을 안 고르고 홀짝만 건 판(start_guess 가 null)은 끊는 쪽으로 본다 —
   "우로만 걸었다"가 성립하지 않는 판이다. */
const LADDER_STREAK_MIN_BET = 1_000;

/**
 * 연승을 이어 온 마지막 판의 베팅액. 연승이 없으면 0.
 *
 * 과제를 열 때 "그 판에 얼마를 걸었나"로 쓴다. 연승은 1,000P 이상으로만 쌓이므로
 * 이 값은 반드시 그 이상이고, 그래서 과제 쪽 문지기를 1,000P 로 두어도 막히지 않는다 —
 * 화면의 «베팅 1,000P 이상» 표시가 실제 규칙과 같은 말이 된다.
 */
export function lastRightWinBet(userId: string): number {
  return one<{ amount: number }>(
    `SELECT amount FROM ladder_bets
      WHERE user_id = ? AND start_guess = 'R' AND won = 1
      ORDER BY id DESC LIMIT 1`, userId)?.amount ?? 0;
}

function trackRightStreak(
  userId: string, startGuess: string | null, won: boolean, amount: number
): void {
  if (amount < LADDER_STREAK_MIN_BET) return;          // 이 판은 없던 것으로 본다
  const { bumpStreak, resetStreak } = require('../streaks') as typeof import('../streaks');
  if (startGuess !== 'R' || !won) { resetStreak(userId, 'ladder_right_win'); return; }
  bumpStreak(userId, 'ladder_right_win');
}

// 사다리 라운드는 표시용 히스토리(최근 20판) 외에는 보관할 이유가 없다. 무한히 적재되지 않도록
// 최근 KEEP개만 남기고 그보다 오래된 라운드와 그에 딸린 베팅 기록을 함께 삭제한다.
// 필요량 = 히스토리 20 + 진행 중 라운드 1 = 21개이므로 약간의 여유만 두고 30개로 유지한다.
// (포인트 증감 자체는 points_ledger에 영구 보존되므로 감사 이력은 잃지 않는다.)

const LADDER_KEEP_ROUNDS = 30;
function pruneLadderRounds(): void {
  const cutoff = one<{ id: number }>(
    `SELECT id FROM ladder_rounds ORDER BY id DESC LIMIT 1 OFFSET ?`, LADDER_KEEP_ROUNDS
  );
  if (!cutoff) return;
  run(`DELETE FROM ladder_bets WHERE round_id <= ?`, cutoff.id);
  run(`DELETE FROM ladder_rounds WHERE id <= ?`, cutoff.id);
}

// 매 요청마다 호출: 베팅 마감 시간이 지난 라운드가 있으면 그 자리에서 정산하고, 정산 후 공개 시간(REVEAL)이
// 지났으면 다음 라운드를 새로 연다. 별도 백그라운드 타이머 없이도(=서버가 잠들어 있어도) 다음 요청이 올 때
// 자연스럽게 라운드가 진행되므로 fly.io scale-to-zero와 완전히 호환된다.
// computeResult는 순수 함수(암호학적 동전던지기 + 사다리 모양 생성)라 트랜잭션 안에서 안전하게 호출 가능.
// revealSecFor: 정산 후 다음 라운드까지 몇 초를 둘지 라운드별로 정한다.
// 사다리는 공이 내려오는 연출이 끝난 뒤부터 "다음 라운드까지 3초"를 세야 하는데,
// 연출 길이가 가로줄 개수에 따라 달라지므로 상수 하나로는 표현할 수 없다.
// 그래서 계산은 연출 타이밍을 아는 쪽(ladder.ts)에 맡기고 여기서는 결과만 받는다.
export function advanceLadderRound(
  computeResult: () => { startSide: string; endSide: string; rungs: boolean[] },
  revealSecFor: (round: LadderRoundRow) => number,
): LadderRoundRow {
  return tx(() => {
    const now = Math.floor(Date.now() / 1000);
    let round = one<LadderRoundRow>(`SELECT * FROM ladder_rounds ORDER BY id DESC LIMIT 1`);

    if (round && round.phase === 'betting' && round.betting_ends_at <= now) {
      const { startSide, endSide, rungs } = computeResult();
      settleLadderBets(round.id, startSide, endSide);
      run(
        `UPDATE ladder_rounds SET phase = 'done', start_side = ?, end_side = ?, rungs_json = ?, resolved_at = ? WHERE id = ?`,
        startSide, endSide, JSON.stringify(rungs), now, round.id
      );
      round = one<LadderRoundRow>(`SELECT * FROM ladder_rounds WHERE id = ?`, round.id)!;
    }

    if (!round || (round.phase === 'done' && (round.resolved_at ?? 0) + revealSecFor(round) <= now)) {
      run(`INSERT INTO ladder_rounds (phase, betting_ends_at) VALUES ('betting', ?)`, now + LADDER_BETTING_SEC);
      const id = one<{ id: number }>(`SELECT last_insert_rowid() AS id`)!.id;
      round = one<LadderRoundRow>(`SELECT * FROM ladder_rounds WHERE id = ?`, id)!;
      pruneLadderRounds(); // 라운드는 시간이 지나면 계속 쌓이므로 최근 것만 남기고 정리
      pruneStaleData();
    }
    return round!;
  });
}

export function placeLadderBet(
  userId: string, username: string, roundId: number,
  startGuess: string | null, parityGuess: string | null, amount: number
): { ok: true; balance: number } | { ok: false; error: 'insufficient_balance' | 'already_bet' | 'closed' } {
  return tx(() => {
    // 베팅 창이 아직 열려 있는지 같은 트랜잭션 안에서 다시 확인한다 — 이미 정산된 라운드에 베팅이 꽂혀
    // 스테이크만 빠지고 결과를 못 받는 일을 막는다.
    const r = one<{ phase: string; betting_ends_at: number }>(
      `SELECT phase, betting_ends_at FROM ladder_rounds WHERE id = ?`, roundId
    );
    if (!r || r.phase !== 'betting' || r.betting_ends_at <= Math.floor(Date.now() / 1000)) {
      return { ok: false, error: 'closed' };
    }
    const existing = one<{ id: number }>(`SELECT id FROM ladder_bets WHERE round_id = ? AND user_id = ?`, roundId, userId);
    if (existing) return { ok: false, error: 'already_bet' };
    const before = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId);
    if (!before || before.balance < amount) return { ok: false, error: 'insufficient_balance' };
    run(`UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?`, amount, userId, amount);
    const changed = one<{ n: number }>(`SELECT changes() AS n`)!.n;
    if (changed === 0) return { ok: false, error: 'insufficient_balance' };
    const after = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)!;
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`, userId, -amount, 'game:ladder:bet', after.balance);
    run(
      `INSERT INTO ladder_bets (round_id, user_id, username, start_guess, parity_guess, amount) VALUES (?, ?, ?, ?, ?, ?)`,
      roundId, userId, username, startGuess, parityGuess, amount
    );
    return { ok: true, balance: after.balance };
  });
}

// 베팅 취소: 베팅 창이 열려 있는 동안만 가능. 스테이크를 그대로 환불하고 베팅을 삭제한다.
export function cancelLadderBet(userId: string, roundId: number):
  { ok: true; balance: number } | { ok: false; error: 'closed' | 'no_bet' } {
  return tx(() => {
    const r = one<{ phase: string; betting_ends_at: number }>(
      `SELECT phase, betting_ends_at FROM ladder_rounds WHERE id = ?`, roundId
    );
    if (!r || r.phase !== 'betting' || r.betting_ends_at <= Math.floor(Date.now() / 1000)) {
      return { ok: false, error: 'closed' };
    }
    const bet = one<{ id: number; amount: number }>(
      `SELECT id, amount FROM ladder_bets WHERE round_id = ? AND user_id = ?`, roundId, userId
    );
    if (!bet) return { ok: false, error: 'no_bet' };
    run(`DELETE FROM ladder_bets WHERE id = ?`, bet.id);
    run(`UPDATE users SET balance = balance + ? WHERE id = ?`, bet.amount, userId);
    const after = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)!;
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
      userId, bet.amount, 'game:ladder:cancel', after.balance);
    return { ok: true, balance: after.balance };
  });
}

export function getLadderBets(roundId: number): LadderBetRow[] {
  return all<LadderBetRow>(
    `SELECT b.user_id, b.username, u.avatar, u.balance, b.start_guess, b.parity_guess, b.amount, b.won, b.payout
     FROM ladder_bets b JOIN users u ON u.id = b.user_id WHERE b.round_id = ? ORDER BY b.id ASC`, roundId
  );
}

export function getMyLadderBet(roundId: number, userId: string): LadderBetRow | undefined {
  return one<LadderBetRow>(
    `SELECT username, start_guess, parity_guess, amount, won, payout FROM ladder_bets WHERE round_id = ? AND user_id = ?`, roundId, userId
  );
}

export interface LadderResult { startSide: string; endSide: string }

// 최근 결과 히스토리(최근 20판) — 갬블러의 오류 심리를 자극하는 "출목표" 용도.
// 크래시와 동일하게 최신이 앞(=화면 왼쪽)에 오도록 내림차순 그대로 반환한다.
export function getRecentLadderResults(limit = 20): LadderResult[] {
  return all<{ start_side: string; end_side: string }>(
    `SELECT start_side, end_side FROM ladder_rounds WHERE phase = 'done' ORDER BY id DESC LIMIT ?`, limit
  ).map(r => ({ startSide: r.start_side, endSide: r.end_side }));
}

// ----- 그래프게임(크래시): 실시간 공용 라운드 -----

