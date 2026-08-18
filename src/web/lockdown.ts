/* 시즌 마감 직전 락다운.
 *
 * ── 무엇을 막는가
 * 시즌이 넘어가면 전원의 잔액이 시드로 초기화된다. 그런데 판은 초기화되지 않는다 —
 * 마감 순간에 열려 있던 지뢰찾기 판이 다음 시즌에 캐시아웃되면, 지난 시즌 돈으로 산
 * 배당이 새 시즌 잔액에 얹힌다. 없던 포인트가 생기는 것이고, "잔액 = 원장 누적합"은
 * 유지되지만 시즌 사이의 벽에 구멍이 난다.
 *
 * 그래서 마감 5분 전부터 판을 새로 벌이지 못하게 하고, 그 순간 열려 있던 판은 전부
 * 정산한다. 지뢰찾기는 지금까지 연 칸 기준으로 캐시아웃하고(누른 것과 같은 금액),
 * 나머지는 원금을 돌려준다.
 *
 * ── 왜 요청마다 훑는가
 * 타이머가 없다(fly 가 유휴 시 프로세스를 재운다). 그래서 "5분 전에 한 번 실행"이
 * 아니라 "락다운 구간의 모든 요청에서 열린 판을 정리"한다. 한 번만 도는 표식을 두지
 * 않는 이유가 그것이다 — 표식을 두면 그 뒤에 끼어든 판(경합)이 그대로 남는다.
 * 평소에는 열린 판이 없으므로 조회 몇 번으로 끝난다.
 *
 * ── 정산되는 자리 목록의 출처
 * "아직 정산되지 않은 베팅"이 어디에 있는지는 이미 한 곳에 적혀 있다 —
 * queries/core 의 stakedIn·claimRelief 가 보는 여섯 자리다(지원금이 그 판돈을 내 돈으로
 * 세면 안 되기 때문에). 여기도 그 여섯 자리를 본다. 새 게임이 늘면 세 곳을 함께 고쳐야
 * 하고, 감사가 그 셋이 같은 목록인지 확인한다.
 */
import { one, all, run, tx, settleGameRound, type GameRound } from '../db/queries';
import { seasonLockdown, type SeasonLockdown } from '../db/season-schedule';
import { calcMultiplier, minesPayout } from './games/mines';

export { seasonLockdown, type SeasonLockdown };

/** 거절 문구. 화면과 감사가 같은 문장을 봐야 하므로 여기 한 곳에만 둔다. */
export const LOCKDOWN_MSG = '시즌 마감 정산 준비 중으로 베팅이 제한됩니다.';

/* 막을 주소.
   "돈을 새로 거는" 요청만 막는다. state 를 막으면 화면이 죽어서 안내 배너도 못 보고,
   cashout · cancel · clear · unregister 를 막으면 이미 건 돈을 뺄 수 없게 된다 —
   그건 지키려던 것과 반대다.

   홀덤은 register · sitin 만 막는다. 진행 중인 대회의 action 을 막으면 모두가 시간 초과로
   자동 폴드되어 대회가 망가진다 — 대회는 강제 정산 대상이 아니고(상금 구조가 있어
   중간에 되돌릴 수 없다), 그래서 운영자가 대회 중에 마감을 예약하지 않아야 한다. */
export const LOCKED_PATHS: readonly string[] = [
  '/api/games/mines/start',
  '/api/games/mines/reveal',
  '/api/games/ladder/bet',
  '/api/games/crash/bet',
  '/api/games/poker/bet',
  '/api/games/baccarat/bet',
  '/api/games/blackjack/bet',
  '/api/games/blackjack/action',
  '/api/games/holdem/register',
  '/api/games/holdem/sitin',
];
const LOCKED = new Set(LOCKED_PATHS);

export function lockedPath(path: string): boolean {
  return LOCKED.has(path);
}

/* 원장에 남길 사유. 하나로 둔다 — 화면의 이름표도 하나면 되고, 나중에 "그때 무슨 일이
   있었나"를 원장에서 찾을 때 사유 하나로 전부 걸린다. */
const REASON = 'season:lockdown';

interface MinesState { mineCount: number; revealed: number[] }

/** 지뢰찾기 한 판을 지금 배당으로 캐시아웃한다 — 유저가 그 순간 눌렀을 때와 같은 금액이다. */
function cashOutMines(round: GameRound): number {
  let state: MinesState;
  try {
    state = JSON.parse(round.state_json) as MinesState;
  } catch {
    /* 상태가 깨졌으면 배당을 계산할 수 없다. 그때는 원금을 돌려준다 —
       읽을 수 없는 판 때문에 돈을 삼키는 것이 가장 나쁜 결과다. */
    settleGameRound(round.id, round.user_id, round.bet_amount, 1, REASON, false);
    return round.bet_amount;
  }
  const opened = state.revealed?.length ?? 0;
  const mult = calcMultiplier(state.mineCount, opened);
  /* 강제 정산도 "지금 캐시아웃을 눌렀다면 받았을 금액" 그대로여야 한다 — 그래서
     캐시아웃과 같은 함수를 쓴다. mult 는 기록·화면용으로만 남긴다. */
  const payout = minesPayout(round.bet_amount, state.mineCount, opened);
  /* 칸을 하나도 안 열었으면 배당이 정확히 1.00 이라 원금 전액 환불과 같다. 그 판은
     판수에 넣지 않는다 — 캐시아웃 자리와 같은 규칙이다(아무 일도 일어나지 않은 판이다). */
  settleGameRound(round.id, round.user_id, payout, mult, REASON, opened > 0);
  return payout;
}

/** 공용 라운드의 미정산 베팅을 원금 그대로 돌려준다. */
function refundBets(table: string, amountCol: string, extraSet: string): number {
  const rows = all<{ id: number; user_id: string; amount: number }>(
    `SELECT id, user_id, ${amountCol} AS amount FROM ${table} WHERE payout IS NULL`);
  for (const b of rows) {
    tx(() => {
      /* 조건부 UPDATE 로 잡는다 — 같은 순간에 그 라운드가 제 힘으로 정산되면 payout 이
         이미 채워져 있고, 그때는 아무 일도 하지 않아야 한다(이중 지급 방지).
         정산 함수들과 같은 방식이다. */
      run(`UPDATE ${table} SET payout = ?${extraSet} WHERE id = ? AND payout IS NULL`, b.amount, b.id);
      if (one<{ n: number }>(`SELECT changes() AS n`)!.n !== 1) return;
      run(`UPDATE users SET balance = balance + ? WHERE id = ?`, b.amount, b.user_id);
      const bal = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, b.user_id)!.balance;
      run(`INSERT INTO points_ledger (user_id, delta, reason, balance_after) VALUES (?, ?, ?, ?)`,
        b.user_id, b.amount, REASON, bal);
    });
  }
  return rows.length;
}

export interface LockdownSweep { mines: number; refunded: number }

/**
 * 열려 있는 판을 전부 정산한다. 여러 번 불러도 안전하다(둘째 번에는 볼 것이 없다).
 */
export function settleOpenStakes(): LockdownSweep {
  let mines = 0;
  for (const r of all<GameRound>(`SELECT * FROM game_rounds WHERE status = 'active'`)) {
    cashOutMines(r);
    mines++;
  }
  /* 나머지 다섯 자리. won · cashout_multiplier 같은 열도 함께 채워, 이 줄이 "정산된 줄"로
     보이게 한다 — 안 채우면 화면이 아직 진행 중인 베팅으로 그린다. */
  const refunded =
    refundBets('ladder_bets', 'amount', ', won = 0')
    + refundBets('crash_bets', 'amount', ', cashout_multiplier = 1')
    + refundBets('poker_bets', 'amount', ', won = 0')
    + refundBets('baccarat_bets', 'amount', ', won = 0')
    + refundBets('blackjack_hands', 'bet', `, status = 'stand', outcome = 'push'`);
  return { mines, refunded };
}

/**
 * 요청마다 부른다. 락다운 구간이면 열린 판을 정리하고, 그 상태를 돌려준다.
 *
 * 실패해도 요청을 막지 않는다 — 정산 하나가 던진다고 화면 전체가 500 이 되면
 * 사람들은 마감 직전에 사이트가 죽은 것으로 본다. 그건 지키려던 것보다 나쁘다.
 */
export function ensureLockdown(now = Math.floor(Date.now() / 1000)): SeasonLockdown {
  const st = seasonLockdown(now);
  if (!st.active) return st;
  try {
    const swept = settleOpenStakes();
    if (swept.mines || swept.refunded) {
      console.log(`[시즌 락다운] 강제 정산 — 지뢰찾기 ${swept.mines}판 · 환불 ${swept.refunded}건`);
    }
  } catch (e: unknown) {
    console.error('[시즌 락다운] 강제 정산 실패:', e);
  }
  return st;
}
