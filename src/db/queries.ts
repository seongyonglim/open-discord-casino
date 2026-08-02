import type { SQLInputValue } from 'node:sqlite';
import { getDb } from './schema';

function one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

function all<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

function run(sql: string, ...params: SQLInputValue[]): void {
  getDb().prepare(sql).run(...params);
}

// 여러 UPDATE/INSERT를 하나의 트랜잭션으로 묶어 원자화 (중간 실패 시 전체 롤백)
let txDepth = 0;
function tx<T>(fn: () => T): T {
  if (txDepth > 0) return fn();
  const d = getDb();
  d.exec('BEGIN');
  txDepth++;
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth--;
  }
}

// ----- users / 세션 (웹 로그인 + 디스코드 인터랙션 공용) -----

export interface WebUser {
  id: string;
  username: string;
  avatar: string | null;
  role: string; // 'admin' | 'member'
  balance: number;
  current_streak: number;
  last_checkin_date: string | null;
}

// 로그인 또는 디스코드 인터랙션 시 유저 생성/표시이름·아바타 갱신 (balance/streak/role은 보존)
export function upsertUser(id: string, username: string, avatar: string | null): void {
  run(
    `INSERT INTO users (id, username, avatar) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET username = excluded.username, avatar = excluded.avatar`,
    id, username, avatar
  );
}

export function getWebUser(id: string): WebUser | undefined {
  return one<WebUser>(
    `SELECT id, username, avatar, COALESCE(role,'member') AS role, balance, current_streak, last_checkin_date
     FROM users WHERE id = ?`,
    id
  );
}

export function ensureSeedAdmin(id: string): void {
  run(`UPDATE users SET role = 'admin' WHERE id = ?`, id);
}

export function touchActive(id: string, ts: number): void {
  run('UPDATE users SET last_active = ? WHERE id = ? AND (last_active IS NULL OR last_active < ?)', ts, id, ts - 300000);
}

export function createSession(token: string, userId: string, expiresAt: number): void {
  run(`INSERT INTO web_sessions (token, user_id, expires_at) VALUES (?, ?, ?)`, token, userId, expiresAt);
}

export function getSessionUserId(token: string): string | undefined {
  const r = one<{ user_id: string; expires_at: number }>(`SELECT user_id, expires_at FROM web_sessions WHERE token = ?`, token);
  if (!r) return undefined;
  if (r.expires_at < Math.floor(Date.now() / 1000)) { deleteSession(token); return undefined; }
  return r.user_id;
}

// 세션 만료를 뒤로 미룬다 (슬라이딩 만료). 접속을 계속하는 동안은 다시 로그인하지 않게 하는 용도.
export function renewSession(token: string, expiresAt: number): void {
  run(`UPDATE web_sessions SET expires_at = ? WHERE token = ?`, expiresAt, token);
}

export function getSessionExpiry(token: string): number | undefined {
  return one<{ expires_at: number }>(`SELECT expires_at FROM web_sessions WHERE token = ?`, token)?.expires_at;
}

export function deleteSession(token: string): void {
  run(`DELETE FROM web_sessions WHERE token = ?`, token);
}

// ----- 포인트 이코노미 -----

export interface PointsGrant { reason: string; delta: number }

// 베팅/게임 정산 등 단발성 포인트 증감 (게임 라운드에서 사용)
// 포인트는 항상 정수 — 소수점이 생기면 내림(버림)한다. 반올림 금지.
export function adjustBalance(userId: string, delta: number, reason: string): number {
  delta = Math.floor(delta);
  return tx(() => {
    run(`UPDATE users SET balance = balance + ? WHERE id = ?`, delta, userId);
    const row = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)!;
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`, userId, delta, reason, row.balance);
    return row.balance;
  });
}

// 출석 체크인: 지급 목록(출석 포인트 + 있으면 주간/월간 보너스)을 한 트랜잭션으로 처리하고 연속일수/날짜를 갱신
export function performCheckIn(userId: string, newStreak: number, dateStr: string, grants: PointsGrant[]): number {
  return tx(() => {
    let balance = 0;
    for (const g of grants) {
      run(`UPDATE users SET balance = balance + ? WHERE id = ?`, g.delta, userId);
      const row = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)!;
      balance = row.balance;
      run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`, userId, g.delta, g.reason, balance);
    }
    run(`UPDATE users SET current_streak = ?, last_checkin_date = ? WHERE id = ?`, newStreak, dateStr, userId);
    return balance;
  });
}

export interface LeaderboardRow {
  id: string;
  username: string;
  avatar: string | null;
  balance: number;
  current_streak: number;
}

export function getLeaderboard(limit = 10): LeaderboardRow[] {
  return all<LeaderboardRow>(
    `SELECT id, username, avatar, balance, current_streak FROM users ORDER BY balance DESC, id ASC LIMIT ?`,
    limit
  );
}

// 베팅: 잔액이 충분할 때만 원자적으로 차감 후 라운드 생성 (동시 요청에도 잔액이 음수로 내려가지 않도록 조건부 UPDATE로 검증)
export function placeBet(userId: string, gameType: string, betAmount: number, initialState: unknown): { ok: true; roundId: number; balance: number } | { ok: false; error: 'insufficient_balance' } {
  betAmount = Math.floor(betAmount);
  return tx(() => {
    const before = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId);
    if (!before || before.balance < betAmount) return { ok: false, error: 'insufficient_balance' };
    run(`UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?`, betAmount, userId, betAmount);
    const changed = one<{ n: number }>(`SELECT changes() AS n`)!.n;
    if (changed === 0) return { ok: false, error: 'insufficient_balance' };
    const after = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)!;
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`, userId, -betAmount, `game:${gameType}:bet`, after.balance);
    const roundId = createGameRound(userId, gameType, betAmount, initialState);
    return { ok: true, roundId, balance: after.balance };
  });
}

// ----- 게임 라운드 (지뢰찾기/사다리/그래프/바카라/블랙잭 공용) -----

export interface GameRound {
  id: number;
  user_id: string;
  game_type: string;
  bet_amount: number;
  status: 'active' | 'settled';
  state_json: string;
  payout: number | null;
  multiplier: number | null;
  created_at: number;
  settled_at: number | null;
}

export function createGameRound(userId: string, gameType: string, betAmount: number, state: unknown): number {
  run(
    `INSERT INTO game_rounds (user_id, game_type, bet_amount, status, state_json) VALUES (?, ?, ?, 'active', ?)`,
    userId, gameType, betAmount, JSON.stringify(state)
  );
  return one<{ id: number }>(`SELECT last_insert_rowid() AS id`)!.id;
}

export function getActiveRound(userId: string, gameType: string): GameRound | undefined {
  return one<GameRound>(
    `SELECT * FROM game_rounds WHERE user_id = ? AND game_type = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
    userId, gameType
  );
}

export function updateRoundState(id: number, state: unknown): void {
  run(`UPDATE game_rounds SET state_json = ? WHERE id = ?`, JSON.stringify(state), id);
}


// 라운드 정산(캐시아웃/버스트)과 포인트 지급을 한 트랜잭션으로 묶어 정산 중 크래시로 인한 이중지급/미지급을 방지.
// status='active'인 라운드만 정산되도록 조건부 UPDATE로 잠근다 → 같은 라운드가 두 번 정산돼 이중 지급되는 것을 원천 차단(멱등).
export function settleGameRound(id: number, userId: string, payout: number, multiplier: number, reason: string): number {
  payout = Math.floor(payout);
  return tx(() => {
    run(
      `UPDATE game_rounds SET status = 'settled', payout = ?, multiplier = ?, settled_at = unixepoch()
       WHERE id = ? AND status = 'active'`,
      payout, multiplier, id
    );
    const settledNow = one<{ n: number }>(`SELECT changes() AS n`)!.n === 1;
    if (!settledNow) {
      // 이미 정산된 라운드 — 재지급하지 않고 현재 잔액만 반환
      return one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)!.balance;
    }
    if (payout > 0) {
      run(`UPDATE users SET balance = balance + ? WHERE id = ?`, payout, userId);
    }
    const row = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)!;
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`, userId, payout, reason, row.balance);
    return row.balance;
  });
}

// ----- 사다리게임: 실시간 공용 라운드 (여러 유저가 같은 라운드에 함께 베팅) -----

export const LADDER_BETTING_SEC = 10;
// 다른 게임과 맞춰 3초. 이 값은 "공 하강 연출 + 결과 감상"을 함께 덮으므로,
// 하강이 이 안에 끝나야 한다 — 그래서 연출 속도를 최대 1.54초로 잡아두었다(ladder.ts FALL/GROW/CROSS).
// 연출을 늦추려면 이 값도 함께 올려야 한다. 안 그러면 하강 중에 다음 라운드가 시작된다.
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

function settleLadderBets(roundId: number, startSide: string, endSide: string): void {
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
  }
}

// 사다리 라운드는 표시용 히스토리(최근 20판) 외에는 보관할 이유가 없다. 무한히 적재되지 않도록
// 최근 KEEP개만 남기고 그보다 오래된 라운드와 그에 딸린 베팅 기록을 함께 삭제한다.
// 필요량 = 히스토리 20 + 진행 중 라운드 1 = 21개이므로 약간의 여유만 두고 30개로 유지한다.
// (포인트 증감 자체는 points_ledger에 영구 보존되므로 감사 이력은 잃지 않는다.)
// ----- 장기 보존 데이터 정리 -----
//
// 라운드 테이블은 아래에서 개수로 묶어두지만, 다음 셋은 아무도 지우지 않아 볼륨을 계속 먹는다.
//   · points_ledger — 최대 증가원. 실측상 인덱스까지 합쳐 행당 약 81B이고 현재 DB의 74%를 차지한다.
//   · game_rounds   — 지뢰찾기 기록. 진행 중인 판만 읽으므로 정산된 건은 보관 이유가 없다.
//   · web_sessions  — 만료 세션은 그 토큰으로 접속이 올 때만 지워져서, 버려진 세션은 영구히 남는다.
// 원장은 분쟁 대응용 감사 이력이라 개수가 아니라 기간으로 자른다.
const LEDGER_KEEP_DAYS = 180;
const MINES_KEEP_DAYS = 30;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPrune = 0;

// 서버에 타이머를 두지 않는 설계이므로(scale-to-zero) 라운드 진행 트랜잭션에 얹어서 실행한다.
// 매 요청마다 DELETE를 날리면 낭비이므로 프로세스당 1시간에 한 번으로 제한한다.
function pruneStaleData(): void {
  const now = Date.now();
  if (now - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = now;
  const nowSec = Math.floor(now / 1000);
  run(`DELETE FROM points_ledger WHERE created_at < ?`, nowSec - LEDGER_KEEP_DAYS * 86400);
  run(`DELETE FROM game_rounds WHERE status != 'active' AND settled_at < ?`, nowSec - MINES_KEEP_DAYS * 86400);
  run(`DELETE FROM web_sessions WHERE expires_at < ?`, nowSec);
}

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
export function advanceLadderRound(computeResult: () => { startSide: string; endSide: string; rungs: boolean[] }): LadderRoundRow {
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

    if (!round || (round.phase === 'done' && (round.resolved_at ?? 0) + LADDER_REVEAL_SEC <= now)) {
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
  }
}

// 크래시 시점에 아직 캐시아웃하지 않은 베팅은 전부 손실 처리(payout 0)
function settleCrashLosers(roundId: number): void {
  const losers = all<{ id: number; user_id: string }>(
    `SELECT id, user_id FROM crash_bets WHERE round_id = ? AND cashout_multiplier IS NULL`, roundId
  );
  for (const b of losers) {
    run(`UPDATE crash_bets SET payout = 0 WHERE id = ?`, b.id);
    const bal = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, b.user_id);
    if (!bal) continue;   // 유저가 사라진 베팅 — 원장만 못 남기고 넘어간다 (라운드는 정상 마감)
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
      b.user_id, 0, 'game:graph', bal.balance);
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
    const bet = one<{ id: number; amount: number; cashout_multiplier: number | null }>(
      `SELECT id, amount, cashout_multiplier FROM crash_bets WHERE round_id = ? AND user_id = ?`, roundId, userId
    );
    if (!bet) return { ok: false, error: 'no_bet' };
    if (bet.cashout_multiplier !== null) return { ok: false, error: 'already_cashed' };
    const payout = Math.floor(bet.amount * multiplier);
    run(`UPDATE crash_bets SET cashout_multiplier = ?, payout = ? WHERE id = ? AND cashout_multiplier IS NULL`,
      multiplier, payout, bet.id);
    if (one<{ n: number }>(`SELECT changes() AS n`)!.n !== 1) return { ok: false, error: 'already_cashed' };
    run(`UPDATE users SET balance = balance + ? WHERE id = ?`, payout, userId);
    const after = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)!;
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
      userId, payout, 'game:graph', after.balance);
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
  }
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
