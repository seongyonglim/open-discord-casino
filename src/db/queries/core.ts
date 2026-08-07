/* 공용 질의 — 공용 헬퍼 · 사용자 · 세션 · 잔액 · 출석 · 지원금 · 랭킹 · 라운드 · 오래된 기록 정리.

   db/queries.ts 가 1,792줄이라 읽을 수 없어 도메인별로 나눴다. 코드는 한 줄도 바꾸지
   않고 구간을 그대로 옮겼고, queries.ts 는 전부 다시 내보내는 배럴로 남겨 두었다 —
   그래서 부르는 쪽은 예전처럼 './queries' 에서 그대로 가져다 쓴다.

   의존은 한 방향이다: 게임별 모듈 → core. 반대 방향은 없고, 만들지도 말 것.
   core 가 특정 게임을 알게 되면 순환이 생기고, 그때부터는 어느 파일을 먼저 읽어야
   하는지가 사라진다. */
import type { SQLInputValue } from 'node:sqlite';
import { getDb } from '../schema';


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

/* ── 로비 상단에 쓰는 내 오늘 요약 ────────────────────────────────────
   "최근 큰 승리"는 원장에서 순이익을 낼 수 없어서 뺐다. 여기서는 낼 수 있다 —
   한 사람의 하루치를 전부 더하면 베팅 차감(-)과 정산 지급(+)이 같은 합에 들어가므로
   짝을 맞출 필요가 없다. 개별 판의 손익은 알 수 없지만 하루 합계는 정확하다.

   'game:'으로 시작하는 행만 본다. 출석·재난지원금·관리자 조정은 게임 손익이 아니다.
   취소 환불(':cancel')도 같은 합에 들어가야 맞다 — 걸었다가 돌려받았으면 0이다.

   순위는 잔액 기준이다(랭킹 페이지와 같은 기준). 동점자는 같은 등수로 보이는 게
   맞으므로 "나보다 많은 사람 수 + 1"로 센다 — 랭킹 페이지의 줄 번호와 한 칸
   어긋날 수 있지만, 그건 줄 번호가 동점을 갈라 놓기 때문이고 이쪽이 맞다. */
export interface MyTodayRow {
  net: number;      // 오늘 게임 순손익
  rounds: number;   // 오늘 정산된 판수 (베팅 행 제외)
}
export function getMyToday(userId: string, sinceUnix: number): MyTodayRow {
  const r = one<{ net: number | null; rounds: number }>(
    `SELECT COALESCE(SUM(delta), 0) AS net,
            SUM(CASE WHEN instr(substr(reason, 6), ':') = 0 THEN 1 ELSE 0 END) AS rounds
       FROM points_ledger
      WHERE user_id = ? AND reason LIKE 'game:%' AND created_at >= ?`, userId, sinceUnix);
  return { net: r?.net ?? 0, rounds: r?.rounds ?? 0 };
}

export function getBalanceRank(balance: number): { rank: number; total: number } {
  const above = one<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE balance > ?`, balance)!.n;
  const total = one<{ n: number }>(`SELECT COUNT(*) AS n FROM users`)!.n;
  return { rank: above + 1, total };
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
export function pruneStaleData(): void {
  const now = Date.now();
  if (now - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = now;
  const nowSec = Math.floor(now / 1000);
  run(`DELETE FROM points_ledger WHERE created_at < ?`, nowSec - LEDGER_KEEP_DAYS * 86400);
  run(`DELETE FROM game_rounds WHERE status != 'active' AND settled_at < ?`, nowSec - MINES_KEEP_DAYS * 86400);
  run(`DELETE FROM web_sessions WHERE expires_at < ?`, nowSec);
}
