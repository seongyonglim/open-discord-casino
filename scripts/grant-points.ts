/**
 * 포인트 수동 지급 도구 (운영용).
 *
 * 버그 제보 보상처럼 게임 밖에서 포인트를 줄 때 쓴다. 운영 DB를 직접 건드리므로
 * 다음 세 가지를 지킨다.
 *
 *  1. 원장을 함께 남긴다. 잔액만 올리면 balance == SUM(points_ledger.delta) 불변식이
 *     깨지고, 그때부터 감사가 모든 유저에 대해 실패한다.
 *  2. 같은 이유(reason)로 이미 받은 사람은 건너뛴다. 실행이 중간에 끊겨 다시 돌려도
 *     두 번 지급되지 않는다.
 *  3. 끝나고 불변식을 전수 검사한다. 어긋나면 그 자리에서 알린다.
 *
 * 사용법 (fly 머신에서):
 *   GRANT_IDS=<쉼표구분 유저ID> GRANT_AMOUNT=10000 GRANT_REASON=bug_report_bounty \
 *     node --experimental-sqlite --require tsx/cjs scripts/grant-points.ts
 *
 * DRY_RUN=1 을 주면 무엇이 바뀔지만 출력하고 쓰지 않는다.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const DB_DIR = process.env.DB_PATH ?? '/data';
const DB_FILE = path.join(DB_DIR, 'data.db');
const IDS = (process.env.GRANT_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const AMOUNT = Math.floor(Number(process.env.GRANT_AMOUNT ?? 0));
const REASON = (process.env.GRANT_REASON ?? '').trim();
const DRY = process.env.DRY_RUN === '1';

if (!IDS.length || !Number.isFinite(AMOUNT) || AMOUNT === 0 || !REASON) {
  console.error('GRANT_IDS · GRANT_AMOUNT · GRANT_REASON 을 모두 지정해야 한다');
  process.exit(2);
}

const db = new DatabaseSync(DB_FILE);
const one = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p as never[]) as T | undefined;
const all = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p as never[]) as T[];

console.log(`DB ${DB_FILE}`);
console.log(`지급 ${AMOUNT >= 0 ? '+' : ''}${AMOUNT}P · 사유 "${REASON}" · 대상 ${IDS.length}명`
  + (DRY ? '  (DRY RUN — 쓰지 않는다)' : ''));
console.log('');

if (!DRY) db.exec('BEGIN');
try {
  for (const id of IDS) {
    const u = one<{ username: string; balance: number }>(
      `SELECT username, balance FROM users WHERE id = ?`, id);
    if (!u) { console.log(`  건너뜀 — 없는 유저 ${id}`); continue; }

    const dup = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM points_ledger WHERE user_id = ? AND reason = ?`, id, REASON)!.n;
    if (dup > 0) { console.log(`  건너뜀 — ${u.username}: 이미 "${REASON}"으로 받았다`); continue; }

    if (DRY) {
      console.log(`  ${u.username}: ${u.balance} → ${u.balance + AMOUNT}  (예정)`);
      continue;
    }
    db.prepare(`UPDATE users SET balance = balance + ? WHERE id = ?`).run(AMOUNT, id);
    const after = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, id)!;
    db.prepare(`INSERT INTO points_ledger (user_id, delta, reason, balance_after)
                VALUES (?, ?, ?, ?)`).run(id, AMOUNT, REASON, after.balance);
    console.log(`  ${u.username}: ${u.balance} → ${after.balance}`);
  }
  if (!DRY) db.exec('COMMIT');
} catch (e) {
  if (!DRY) db.exec('ROLLBACK');
  console.error('실패 — 전부 되돌렸다:', e);
  process.exit(1);
}

// 불변식 전수 검사
let bad = 0;
for (const u of all<{ id: string; username: string; balance: number }>(
  `SELECT id, username, balance FROM users`)) {
  const s = one<{ s: number }>(
    `SELECT COALESCE(SUM(delta),0) AS s FROM points_ledger WHERE user_id = ?`, u.id)!.s;
  if (s !== u.balance) {
    bad++;
    console.log(`  불변식 위반 — ${u.username}: 잔액 ${u.balance} ≠ 원장 누적합 ${s}`);
  }
}
console.log('');
console.log(bad === 0
  ? '불변식 확인 — 전원 잔액 = 원장 누적합'
  : `불변식 위반 ${bad}건 — 확인이 필요하다`);
process.exit(bad === 0 ? 0 : 1);
