/**
 * 게임별 성적(game_stats)을 원장에서 백필한다.
 *
 * 랭킹을 도입한 시점 이전의 판은 game_stats에 없어서 랭킹이 비어 있다.
 * 원장(points_ledger)에서 무엇을 정확히 복원할 수 있고 무엇을 못 하는지가 이 도구의 핵심이다.
 *
 * 복원 가능 (정확)
 *   · 수익액 — 그 게임의 모든 원장 행 합(SUM(delta)). 베팅은 음수, 지급은 양수,
 *     환불도 원장에 남으므로 합이 곧 순손익이다.
 *   · 스테이크 — ':bet' 행의 합에 음수를 취한 값. 바카라·블랙잭은 칩 회수도 ':bet'에
 *     양수로 들어가므로, 합을 취하면 환불이 자동으로 상쇄된 "실제로 건 금액"이 된다.
 *   · 지급액 — 정산 행('game:X')의 합.
 *   · 판수 — 정산 행의 개수. 단 바카라·포커는 정산 행이 시장(market)마다 하나씩
 *     생기므로 개수를 그대로 세면 부풀려진다. 한 라운드의 정산은 한 트랜잭션에서
 *     일어나 created_at(초)이 같고, 한 유저가 한 라운드에 두 번 참여할 수 없으므로
 *     (유저, created_at) 조합의 개수가 곧 판수다. 실측으로 포커 정산행 124개가
 *     61판으로 접혔고, 다른 게임은 행 수와 조합 수가 정확히 같았다.
 *
 * 복원 불가
 *   · 승·패·푸시 — 그 판의 스테이크와 지급을 짝지어야 알 수 있는데 원장 행에
 *     round_id가 없다. 무승부(푸시)는 지급액이 스테이크와 같은 경우인데 둘을
 *     연결할 수 없다. 그래서 백필한 판은 rated 에 넣지 않고, 승률은 rated 기준으로만
 *     계산한다 — 억지로 0승으로 채우면 승률이 거짓이 된다.
 *
 * 원장 보존 기간(LEDGER_KEEP_DAYS=180) 밖의 판은 복원할 수 없다. 그 사실을 출력한다.
 *
 * 사용법:
 *   node --experimental-sqlite --require tsx/cjs scripts/backfill-stats.ts
 *   DRY_RUN=1 을 주면 무엇이 들어갈지만 출력한다.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const DB_DIR = process.env.DB_PATH ?? '/data';
const DB_FILE = path.join(DB_DIR, 'data.db');
const DRY = process.env.DRY_RUN === '1';

/** 원장 reason 접두어 → game_stats.game 키 (그래프게임은 reason도 graph다) */
const GAMES = ['mines', 'ladder', 'graph', 'poker', 'baccarat', 'blackjack'];

const db = new DatabaseSync(DB_FILE);
const one = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p as never[]) as T | undefined;
const all = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p as never[]) as T[];

console.log(`DB ${DB_FILE}${DRY ? '  (DRY RUN — 쓰지 않는다)' : ''}`);
const span = one<{ a: number; b: number; n: number }>(
  `SELECT MIN(created_at) a, MAX(created_at) b, COUNT(*) n FROM points_ledger`)!;
const d = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
console.log(`원장 ${span.n}행 · ${d(span.a)} ~ ${d(span.b)}`);
console.log('※ 원장 보존 기간(180일) 밖의 판은 복원할 수 없다.');
console.log('※ 승·패·푸시는 원장으로 판정할 수 없어 백필분은 승률 계산에서 제외된다(rated=0).');
console.log('');

let wrote = 0, skipped = 0;
if (!DRY) db.exec('BEGIN');
try {
  for (const g of GAMES) {
    const settleReason = `game:${g}`;
    const betLike = `game:${g}:%`;

    // 이 게임을 한 번이라도 정산받은 유저
    const users = all<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM points_ledger WHERE reason = ?`, settleReason);

    for (const { user_id } of users) {
      /* 이미 집계가 있으면 건드리지 않는다. 백필은 "비어 있는 것을 채우는" 일이고,
         이미 새 판이 쌓인 행에 과거분을 더하면 두 번 세어질 위험이 있다. */
      const existing = one<{ rounds: number }>(
        `SELECT rounds FROM game_stats WHERE user_id = ? AND game = ?`, user_id, g);
      if (existing) { skipped++; continue; }

      // 판수 — 정산 행의 (유저, created_at) 조합 개수 (바카라·포커의 시장별 행을 접는다)
      const rounds = one<{ n: number }>(
        `SELECT COUNT(DISTINCT created_at) n FROM points_ledger
          WHERE user_id = ? AND reason = ?`, user_id, settleReason)!.n;
      if (rounds === 0) continue;

      // 지급액 — 정산 행 합
      const returned = one<{ s: number }>(
        `SELECT COALESCE(SUM(delta),0) s FROM points_ledger
          WHERE user_id = ? AND reason = ?`, user_id, settleReason)!.s;
      // 스테이크 — ':bet' 등 부수 행의 합에 음수를 취한 값 (환불이 자동 상쇄된다)
      const staked = -one<{ s: number }>(
        `SELECT COALESCE(SUM(delta),0) s FROM points_ledger
          WHERE user_id = ? AND reason LIKE ?`, user_id, betLike)!.s;
      const profit = returned - staked;

      // 원장 전체 합과 일치하는지 그 자리에서 확인 (불변식)
      const total = one<{ s: number }>(
        `SELECT COALESCE(SUM(delta),0) s FROM points_ledger
          WHERE user_id = ? AND (reason = ? OR reason LIKE ?)`,
        user_id, settleReason, betLike)!.s;
      if (total !== profit) {
        throw new Error(`${g}/${user_id}: 수익액 ${profit} ≠ 원장 합 ${total}`);
      }

      const name = one<{ username: string }>(`SELECT username FROM users WHERE id = ?`, user_id);
      console.log(`  ${g.padEnd(10)} ${(name?.username ?? user_id).padEnd(10)} `
        + `${String(rounds).padStart(5)}판  ${profit >= 0 ? '+' : ''}${profit}P`);
      if (DRY) { wrote++; continue; }

      db.prepare(
        `INSERT INTO game_stats (user_id, game, rounds, rated, wins, pushes, staked, returned, profit, updated_at)
         VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?, unixepoch())`
      ).run(user_id, g, rounds, staked, returned, profit);
      wrote++;
    }
  }
  if (!DRY) db.exec('COMMIT');
} catch (e) {
  if (!DRY) db.exec('ROLLBACK');
  console.error('실패 — 전부 되돌렸다:', e);
  process.exit(1);
}

console.log('');
console.log(`${DRY ? '들어갈 행' : '기록한 행'} ${wrote}개 · 이미 있어서 건너뜀 ${skipped}개`);

// 불변식 확인
let bad = 0;
for (const r of all<{ user_id: string; game: string; rounds: number; rated: number;
  wins: number; pushes: number; staked: number; returned: number; profit: number }>(
  `SELECT * FROM game_stats`)) {
  if (r.profit !== r.returned - r.staked) { bad++; console.log(`  profit 불일치: ${r.game}/${r.user_id}`); }
  if (r.rated > r.rounds) { bad++; console.log(`  rated > rounds: ${r.game}/${r.user_id}`); }
  if (r.wins + r.pushes > r.rated) { bad++; console.log(`  wins+pushes > rated: ${r.game}/${r.user_id}`); }
}
console.log(bad === 0 ? '불변식 확인 — game_stats 정상' : `불변식 위반 ${bad}건`);
process.exit(bad === 0 ? 0 : 1);
