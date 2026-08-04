import type { SQLInputValue } from 'node:sqlite';
import { randomInt } from 'node:crypto';
import { getDb } from './schema';

/* 이 네 헬퍼는 홀덤 모듈(db/holdem.ts)도 쓴다.
   특히 tx는 반드시 하나만 있어야 한다 — 모듈마다 txDepth를 따로 두면
   중첩 호출에서 BEGIN이 두 번 나가 "cannot start a transaction within a transaction"으로 터진다. */
export function one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

export function all<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function run(sql: string, ...params: SQLInputValue[]): void {
  getDb().prepare(sql).run(...params);
}

// 여러 UPDATE/INSERT를 하나의 트랜잭션으로 묶어 원자화 (중간 실패 시 전체 롤백)
let txDepth = 0;
export function tx<T>(fn: () => T): T {
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

// 출석 체크인: 지급 목록(출석 포인트 + 있으면 주간/월간 보너스)을 한 트랜잭션으로 처리하고 연속일수/날짜를 갱신.
// 이미 오늘 출석한 상태면 null을 돌려주고 아무것도 지급하지 않는다.
//
// 날짜를 "선점"하는 조건부 UPDATE를 맨 앞에 두는 게 핵심이다. 지급을 먼저 하고 날짜를 나중에 쓰면,
// 호출자(economy.checkIn)의 날짜 비교와 이 트랜잭션 사이에 같은 유저의 요청이 한 번 더 끼어들 경우
// 둘 다 통과해 보상이 두 번 나간다. 지금은 checkIn이 await 없이 한 틱에 끝나서 그럴 일이 없지만,
// 그 사실에만 기대면 나중에 await 한 줄이 끼는 순간 조용히 이중 지급이 된다.
// (지원금·베팅 차감이 쓰는 것과 같은 방식: WHERE로 조건을 걸고 changes()로 실제 반영 여부를 본다)
export function performCheckIn(userId: string, newStreak: number, dateStr: string, grants: PointsGrant[]): number | null {
  return tx(() => {
    run(
      `UPDATE users SET current_streak = ?, last_checkin_date = ?
       WHERE id = ? AND (last_checkin_date IS NULL OR last_checkin_date != ?)`,
      newStreak, dateStr, userId, dateStr
    );
    if (one<{ n: number }>(`SELECT changes() AS n`)!.n === 0) return null;

    let balance = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)!.balance;
    for (const g of grants) {
      run(`UPDATE users SET balance = balance + ? WHERE id = ?`, g.delta, userId);
      const row = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)!;
      balance = row.balance;
      run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`, userId, g.delta, g.reason, balance);
    }
    return balance;
  });
}

/* ── 디스코드 고정 버튼 메시지 위치 ─────────────────────────────────────
   신청 로그가 쌓이면 버튼이 위로 밀리므로, 로그를 남길 때마다 이전 버튼 메시지를 지우고
   맨 아래에 다시 올린다. 어떤 메시지를 지울지 알아야 하므로 위치를 기억해 둔다. */
export type BoardKind = 'attendance' | 'relief';
export interface BoardRef { channel_id: string; message_id: string }

export function getBoard(kind: BoardKind): BoardRef | undefined {
  return one<BoardRef>(`SELECT channel_id, message_id FROM discord_boards WHERE kind = ?`, kind);
}

export function setBoard(kind: BoardKind, channelId: string, messageId: string): void {
  run(
    `INSERT INTO discord_boards (kind, channel_id, message_id, updated_at)
     VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(kind) DO UPDATE SET channel_id = excluded.channel_id,
       message_id = excluded.message_id, updated_at = excluded.updated_at`,
    kind, channelId, messageId
  );
}

export function clearBoard(kind: BoardKind): void {
  run(`DELETE FROM discord_boards WHERE kind = ?`, kind);
}

/* ── 개인회생 지원금 (파산 구제) ──────────────────────────────────────────────
   잔액이 정확히 0인 사람만, 4시간에 한 번 받을 수 있다.
   조건 검사와 지급을 한 트랜잭션 안의 조건부 UPDATE로 묶어야 한다 — 버튼을 연타하거나
   탭을 여러 개 열어두면 같은 조건을 통과한 요청이 동시에 들어와 두 번 지급될 수 있다.
   (베팅 차감에서 쓴 것과 같은 방식: WHERE로 조건을 걸고 changes()로 실제 반영 여부를 본다) */
/* 아직 정산되지 않은 베팅에 묶여 있는 포인트.
 *
 * 이게 0이 아니면 파산이 아니다. 잔액만 보고 지원금을 주면 이렇게 악용된다:
 * 전 재산을 지뢰찾기에 걸어 잔액을 0으로 만들고 → 지원금 200P를 받고 →
 * 칸을 하나도 열지 않은 채 캐시아웃해 배당 1.00x로 전액 환불받는다.
 * 결과는 "원금 그대로 + 200P"이고, 쿨다운마다 무한히 반복할 수 있다.
 *
 * 지뢰찾기만의 문제가 아니다. 사다리·그래프는 베팅 취소, 포커·바카라·블랙잭은
 * 칩 회수로 전액 돌려받을 수 있으므로 여섯 게임 모두 같은 수법이 통한다.
 * 그래서 특정 게임을 막는 게 아니라 "묶인 돈이 한 푼도 없을 때만"으로 조건을 세운다.
 * 취소하지 않고 결과를 기다리는 경우도 아직 딸 가능성이 있어 파산이 아니다.
 */
export function lockedStake(userId: string): number {
  return one<{ s: number }>(`
    SELECT (SELECT COALESCE(SUM(bet_amount),0) FROM game_rounds     WHERE user_id = ? AND status = 'active')
         + (SELECT COALESCE(SUM(amount),0)     FROM ladder_bets     WHERE user_id = ? AND payout IS NULL)
         + (SELECT COALESCE(SUM(amount),0)     FROM crash_bets      WHERE user_id = ? AND payout IS NULL)
         + (SELECT COALESCE(SUM(amount),0)     FROM poker_bets      WHERE user_id = ? AND payout IS NULL)
         + (SELECT COALESCE(SUM(amount),0)     FROM baccarat_bets   WHERE user_id = ? AND payout IS NULL)
         + (SELECT COALESCE(SUM(bet),0)        FROM blackjack_hands WHERE user_id = ? AND payout IS NULL)
         AS s`,
    userId, userId, userId, userId, userId, userId)!.s;
}

export function claimRelief(
  userId: string, amount: number, cooldownSec: number
): { ok: true; balance: number; nextAvailableAt: number }
  | { ok: false; error: 'cooldown'; nextAvailableAt: number }
  | { ok: false; error: 'has_stake'; staked: number }
  | { ok: false; error: 'not_broke' | 'no_user' } {
  return tx(() => {
    const before = one<{ balance: number; last_relief_at: number | null }>(
      `SELECT balance, last_relief_at FROM users WHERE id = ?`, userId
    );
    if (!before) return { ok: false, error: 'no_user' } as const;

    const now = Math.floor(Date.now() / 1000);
    /* 조건을 SQL에 그대로 넣어, 위에서 읽은 뒤 여기까지 오는 사이에 값이 바뀌어도
       이중 지급되지 않는다. "묶인 돈 없음"도 반드시 여기 함께 들어가야 한다 —
       밖에서 미리 확인만 하면 확인과 지급 사이에 베팅을 걸어 빠져나갈 수 있다. */
    run(
      `UPDATE users SET balance = balance + ?, last_relief_at = ?
       WHERE id = ? AND balance = 0 AND (last_relief_at IS NULL OR last_relief_at <= ?)
         AND NOT EXISTS (SELECT 1 FROM game_rounds     WHERE user_id = ? AND status = 'active')
         AND NOT EXISTS (SELECT 1 FROM ladder_bets     WHERE user_id = ? AND payout IS NULL)
         AND NOT EXISTS (SELECT 1 FROM crash_bets      WHERE user_id = ? AND payout IS NULL)
         AND NOT EXISTS (SELECT 1 FROM poker_bets      WHERE user_id = ? AND payout IS NULL)
         AND NOT EXISTS (SELECT 1 FROM baccarat_bets   WHERE user_id = ? AND payout IS NULL)
         AND NOT EXISTS (SELECT 1 FROM blackjack_hands WHERE user_id = ? AND payout IS NULL)`,
      amount, now, userId, now - cooldownSec,
      userId, userId, userId, userId, userId, userId
    );
    if (one<{ n: number }>(`SELECT changes() AS n`)!.n === 0) {
      // 어떤 조건에서 막혔는지 구분해 안내 문구를 정확히 낸다
      if (before.balance !== 0) return { ok: false, error: 'not_broke' } as const;
      const staked = lockedStake(userId);
      if (staked > 0) return { ok: false, error: 'has_stake', staked } as const;
      // 쿨다운이면 언제 다시 받을 수 있는지까지 알려 준다 (안내 문구에 그대로 쓴다)
      return {
        ok: false, error: 'cooldown',
        nextAvailableAt: (before.last_relief_at ?? now) + cooldownSec,
      } as const;
    }

    const after = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId)!;
    run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
      userId, amount, 'disaster_relief', after.balance);
    return { ok: true, balance: after.balance, nextAvailableAt: now + cooldownSec } as const;
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

/* ----- 게임별 누적 성적 (랭킹 탭) -----------------------------------
 *
 * 한 판이 끝날 때 정확히 한 번 부른다. 단위는 "라운드 × 유저"다.
 *
 * 바카라·포커는 정산 루프가 시장(market)마다 도니, 루프 안에서 부르면 판수가
 * 시장 수만큼 부풀어 오른다(5개 시장에 걸면 5판). 반드시 유저별로 합산한 뒤
 * 루프 밖에서 불러야 한다.
 *
 * 승패는 게임별 규칙이 아니라 그 판의 유저 단위 순손익 하나로 판정한다.
 * 이 한 줄이 여섯 게임의 서로 다른 승패 개념을 전부 옳게 접는다 —
 * 바카라 타이 환불, 블랙잭 푸시, 그래프 1.00x 캐시아웃이 모두
 * returned == staked 로 모인다.
 *
 * 반드시 "유저가 존재하는지 확인하는 continue" 뒤, 원장 INSERT와 같은 블록에
 * 두어야 한다. 앞에 두면 탈퇴한 유저의 고아 행이 생긴다(외래키가 없다).
 */
export function bumpGameStats(
  userId: string, game: string, staked: number, returned: number
): void {
  /* 승은 "돈을 번 판"이다 — 순손익이 양수인 판. 얼마를 벌었는지는 보지 않는다.
     본전만 돌아온 판(푸시)은 승이 아니고, 분모에서 빼지도 않는다. */
  const win = returned > staked ? 1 : 0;
  const push = returned === staked ? 1 : 0;
  run(
    `INSERT INTO game_stats (user_id, game, rounds, rated, wins, pushes, staked, returned, profit, updated_at)
     VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(user_id, game) DO UPDATE SET
       rounds   = rounds + 1,
       rated    = rated + 1,
       wins     = wins + excluded.wins,
       pushes   = pushes + excluded.pushes,
       staked   = staked + excluded.staked,
       returned = returned + excluded.returned,
       profit   = profit + excluded.profit,
       updated_at = excluded.updated_at`,
    userId, game, win, push, staked, returned, returned - staked
  );
}

export interface GameRankRow {
  user_id: string; username: string;
  /* rounds 는 전체 판수(백필한 과거 판 포함), rated 는 승패를 아는 판수다.
     승률은 반드시 rated 로 계산한다 — rounds 로 나누면 백필한 판이 전부 패배로
     잡혀 승률이 실제보다 낮게 나온다. */
  rounds: number; rated: number; wins: number; pushes: number; profit: number;
}

/* 랭킹은 수익액 내림차순.
   동점 정렬을 결정론적으로 고정한다 — 신규 유저가 다 0P라 tiebreak가 없으면
   재조회마다 줄이 뒤바뀐다(getLeaderboard의 balance DESC, id ASC와 같은 이유).
   닉네임은 users에서 조인해 현재 이름을 쓴다. 베팅 테이블의 username 스냅샷을
   쓰면 이름을 바꾼 사람이 옛 이름으로 남는다. */
export function getGameRanking(game: string, limit = 100): GameRankRow[] {
  return all<GameRankRow>(
    `SELECT s.user_id, u.username, s.rounds, s.rated, s.wins, s.pushes, s.profit
       FROM game_stats s JOIN users u ON u.id = s.user_id
      WHERE s.game = ? AND s.rounds > 0
      ORDER BY s.profit DESC, s.rounds DESC, s.user_id ASC
      LIMIT ?`, game, limit
  );
}

/* 상위 목록에 내가 없을 때 내 줄만 따로 가져온다.
   순위는 "나보다 수익이 많은 사람 수 + 1"로 센다 — 위 ORDER BY와 같은 기준이다. */
export function getMyGameRank(
  game: string, userId: string
): (GameRankRow & { rank: number }) | undefined {
  const mine = one<GameRankRow>(
    `SELECT s.user_id, u.username, s.rounds, s.rated, s.wins, s.pushes, s.profit
       FROM game_stats s JOIN users u ON u.id = s.user_id
      WHERE s.game = ? AND s.user_id = ? AND s.rounds > 0`, game, userId);
  if (!mine) return undefined;
  const ahead = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM game_stats s JOIN users u ON u.id = s.user_id
      WHERE s.game = ? AND s.rounds > 0
        AND (s.profit > ?
          OR (s.profit = ? AND s.rounds > ?)
          OR (s.profit = ? AND s.rounds = ? AND s.user_id < ?))`,
    game, mine.profit, mine.profit, mine.rounds, mine.profit, mine.rounds, userId)!.n;
  return { ...mine, rank: ahead + 1 };
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

// placeBet 전용 내부 함수. 밖으로 열어두면 잔액 확인·차감을 건너뛰고 라운드만 만들 수 있다.
function createGameRound(userId: string, gameType: string, betAmount: number, state: unknown): number {
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
export function settleGameRound(
  id: number, userId: string, payout: number, multiplier: number, reason: string,
  /* 판수에 넣을지. 지뢰찾기에서 칸을 하나도 열지 않고 캐시아웃하면 배율이 정확히 1이라
     베팅액 전액 환불과 같다(사실상 취소이고, 무료로 무한히 반복할 수 있다).
     그걸 판으로 세면 "8,602판" 같은 표시를 마음대로 부풀릴 수 있다. */
  countAsRound = true
): number {
  payout = Math.floor(payout);
  return tx(() => {
    const before = one<{ game_type: string; bet_amount: number }>(
      `SELECT game_type, bet_amount FROM game_rounds WHERE id = ?`, id);
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
    // 조건부 UPDATE가 통과한 경로에서만 집계한다 — 이중 정산은 위에서 이미 걸러진다
    if (countAsRound && before) bumpGameStats(userId, before.game_type, before.bet_amount, payout);
    return row.balance;
  });
}

// ----- 사다리게임: 실시간 공용 라운드 (여러 유저가 같은 라운드에 함께 베팅) -----

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
    bumpGameStats(b.user_id, 'ladder', b.amount, payout);
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
export type BjHandStatus = 'playing' | 'stand' | 'bust' | 'blackjack';

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
    const { outcome, multiplier } = h.settle(cards, dealer);
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
  userId: string, roundId: number, action: 'hit' | 'stand' | 'double', h: BjHelpers
): { ok: true; cards: number[]; status: BjHandStatus; bet: number; balance: number }
  | { ok: false; error: 'closed' | 'no_hand' | 'done' | 'cannot_double' | 'insufficient_balance' } {
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
