/**
 * 게임별 성적(game_stats)을 원장에서 복원한다.
 *
 * 랭킹 도입 전의 판은 game_stats에 없어 목록이 비어 있었다. 원장(points_ledger)만으로
 * 어디까지 복원되는지가 이 도구의 핵심이고, 결론은 "판수·승패·수익액 전부"다.
 *
 * ── 복원 방법: 원장을 순서대로 걸어간다 ──────────────────────────────
 * 유저·게임별로 원장을 id 순서대로 읽으면 한 판이 이렇게 생긴다.
 *
 *   [베팅 행 하나 이상] → [정산 행 하나 이상(같은 초)]
 *
 * 정산 행을 만나면 그때까지 쌓인 베팅이 그 판의 스테이크이고, 정산 행 합이 지급액이다.
 * 둘의 차가 그 판의 순손익이므로 승(>0)·패(<0)·무(=0)를 정확히 가릴 수 있다.
 *
 * 이 방법이 옳은 이유
 *   · 한 유저는 한 라운드에 한 번만 참여한다(각 게임의 already_bet 가드). 그래서
 *     베팅과 정산이 서로 엇갈리지 않는다.
 *   · 바카라·포커는 정산 행이 시장(market)마다 생기지만 한 라운드 정산은 한
 *     트랜잭션이라 created_at(초)이 같다. 같은 초의 정산 행들을 한 판으로 묶는다.
 *   · 취소로 끝난 판(베팅했다가 환불)은 정산 행이 없어 다음 판의 스테이크에 섞이지만,
 *     베팅과 환불이 서로 상쇄돼 합이 0이라 결과에 영향이 없다. 바카라·블랙잭은
 *     환불도 ':bet'에 양수로 들어가므로 여기서 자동으로 처리된다.
 *
 * 처음에는 판수를 "서로 다른 created_at 개수"로 셌는데 그게 틀렸다. 지뢰찾기처럼
 * 빠르게 치는 게임은 한 초에 두 판이 끝나기도 해서 판수가 줄어 세어졌다
 * (실측: 임성용 지뢰 1,107판이 1,098판으로 집계됐다. 정산 행 1,107개 · 베팅 행 1,107개로
 * 1판 = 1정산행이 확인된다). 걸어가는 방식은 이 경우도 정확하다.
 *
 * ── 복원할 수 없는 것 ────────────────────────────────────────────────
 * 원장 보존 기간(LEDGER_KEEP_DAYS=180) 밖의 판. 지워진 뒤에는 근거가 없다.
 *
 * 사용법:
 *   DB_PATH=/data node --experimental-sqlite --require tsx/cjs scripts/backfill-stats.ts
 *   DRY_RUN=1 을 주면 무엇이 들어갈지만 출력한다. 여러 번 실행해도 결과가 같다.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const DB_DIR = process.env.DB_PATH ?? '/data';
const DB_FILE = path.join(DB_DIR, 'data.db');
const DRY = process.env.DRY_RUN === '1';

/** 원장 reason 접두어 = game_stats.game 키 (그래프게임은 reason도 graph다) */
const GAMES = ['mines', 'ladder', 'graph', 'poker', 'baccarat', 'blackjack'];

const db = new DatabaseSync(DB_FILE);
const one = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p as never[]) as T | undefined;
const all = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p as never[]) as T[];

interface Walked {
  rounds: number; wins: number; losses: number; pushes: number;
  staked: number; returned: number;
  /** 정산되지 않은 채 남은 스테이크 (아직 진행 중인 판). 판수에 넣지 않는다. */
  dangling: number;
}

/** 원장을 걸어가며 한 판씩 복원한다 (위 주석의 방법). */
function walk(userId: string, game: string): Walked {
  const rows = all<{ delta: number; reason: string; created_at: number }>(
    `SELECT delta, reason, created_at FROM points_ledger
      WHERE user_id = ? AND (reason = ? OR reason LIKE ?) ORDER BY id`,
    userId, `game:${game}`, `game:${game}:%`);
  const settleReason = `game:${game}`;

  const out: Walked = { rounds: 0, wins: 0, losses: 0, pushes: 0, staked: 0, returned: 0, dangling: 0 };
  let stake = 0, ret = 0, sec: number | null = null;

  const close = (): void => {
    if (sec === null) return;
    out.rounds++;
    out.staked += stake;
    out.returned += ret;
    const p = ret - stake;
    if (p > 0) out.wins++; else if (p < 0) out.losses++; else out.pushes++;
    stake = 0; ret = 0; sec = null;
  };

  for (const r of rows) {
    if (r.reason === settleReason) {
      // 같은 초의 정산 행들은 한 판이다 (바카라·포커의 시장별 행)
      if (sec !== null && r.created_at !== sec) close();
      sec = r.created_at;
      ret += r.delta;
    } else {
      // 정산 뒤에 다시 베팅이 나오면 그 판은 끝났고 새 판이 시작된 것이다
      if (sec !== null) close();
      stake += -r.delta;   // 베팅은 음수 → 양수로. 환불(양수)은 그대로 상쇄된다
    }
  }
  close();
  /* 정산 행 없이 남은 베팅 = 아직 끝나지 않은 판(지뢰찾기의 진행 중 라운드 등).
     완료된 판이 아니므로 판수·승패에 넣지 않는다. 다만 원장에는 차감이 남아 있으므로
     아래 대조식에서 이 금액을 따로 셈해야 한다. */
  if (sec === null && stake !== 0) out.dangling = stake;
  return out;
}

console.log(`DB ${DB_FILE}${DRY ? '  (DRY RUN — 쓰지 않는다)' : ''}`);
const span = one<{ a: number; b: number; n: number }>(
  `SELECT MIN(created_at) a, MAX(created_at) b, COUNT(*) n FROM points_ledger`)!;
const d = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
console.log(`원장 ${span.n}행 · ${d(span.a)} ~ ${d(span.b)}`);
console.log('※ 원장 보존 기간(180일) 밖의 판은 복원할 수 없다.');
console.log('');

let wrote = 0, mismatch = 0;
if (!DRY) db.exec('BEGIN');
try {
  for (const g of GAMES) {
    const users = all<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM points_ledger WHERE reason = ?`, `game:${g}`);

    for (const { user_id } of users) {
      const w = walk(user_id, g);
      if (w.rounds === 0) continue;
      const profit = w.returned - w.staked;

      /* 복원 결과가 원장 전체 합과 맞는지 그 자리에서 확인한다.
         걸어가는 방식이 어딘가에서 판을 놓치면 여기서 드러난다. */
      const total = one<{ s: number }>(
        `SELECT COALESCE(SUM(delta),0) s FROM points_ledger
          WHERE user_id = ? AND (reason = ? OR reason LIKE ?)`,
        user_id, `game:${g}`, `game:${g}:%`)!.s;
      /* 원장 합 = 완료된 판의 순손익 − 아직 정산되지 않은 베팅.
         진행 중인 판이 있으면 그만큼 원장이 더 마이너스다. */
      if (total !== profit - w.dangling) {
        throw new Error(`${g}/${user_id}: 복원 ${profit} − 미정산 ${w.dangling} ≠ 원장 ${total}`);
      }
      if (w.wins + w.losses + w.pushes !== w.rounds) {
        throw new Error(`${g}/${user_id}: 승패 합 ${w.wins + w.losses + w.pushes} ≠ 판수 ${w.rounds}`);
      }

      const name = one<{ username: string }>(`SELECT username FROM users WHERE id = ?`, user_id);
      const pct = Math.round(w.wins * 100 / w.rounds);
      console.log(`  ${g.padEnd(10)} ${(name?.username ?? user_id).padEnd(9)}`
        + `${String(w.rounds).padStart(5)}판  ${String(w.wins).padStart(4)}승 ${String(w.losses).padStart(4)}패 `
        + `${String(w.pushes).padStart(3)}무  승률 ${String(pct).padStart(3)}%  `
        + `${profit >= 0 ? '+' : ''}${profit}P`);
      if (DRY) { wrote++; continue; }

      /* 전부 원장에서 복원한 값으로 맞춰 넣는다(더하지 않는다).
         원장은 과거분과 도입 이후분을 모두 담은 완전한 기록이므로, 여러 번 실행해도
         결과가 같다. rated는 승패를 판정한 판수이고 여기서는 곧 전체 판수다. */
      db.prepare(
        `INSERT INTO game_stats (user_id, game, rounds, rated, wins, pushes, staked, returned, profit, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
         ON CONFLICT(user_id, game) DO UPDATE SET
           rounds   = excluded.rounds,
           rated    = excluded.rated,
           wins     = excluded.wins,
           pushes   = excluded.pushes,
           staked   = excluded.staked,
           returned = excluded.returned,
           profit   = excluded.profit,
           updated_at = excluded.updated_at`
      ).run(user_id, g, w.rounds, w.rounds, w.wins, w.pushes, w.staked, w.returned, profit);
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
console.log(`${DRY ? '들어갈 행' : '기록한 행'} ${wrote}개`);
void mismatch;

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
