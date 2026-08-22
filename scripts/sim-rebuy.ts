/* 리바이 대회를 «사람이 직접 앉아서» 보는 시뮬레이션.
 *
 * audit-rebuy 는 숫자가 맞는지를 본다 — 상금 풀이 엔트리를 따라오는가, 등수가 겹치지
 * 않는가, 돈이 새지 않는가. 그건 화면을 안 켜도 알 수 있고, 화면을 켜서는 알 수 없다.
 * 반대로 이 파일이 보는 것은 화면에서만 알 수 있는 것들이다:
 *   · 죽은 순간에 창이 «뜨는가» (조건 여섯 중 하나라도 어긋나면 안 뜬다)
 *   · 남은 횟수·비용·마감 시계가 맞게 적히는가
 *   · 단추를 눌렀을 때 실제로 자리로 돌아가는가
 *   · 세 번을 다 쓰고 나면 창이 어떻게 되는가
 * 그 넷은 단정으로 못 쓴다. 눈으로 봐야 한다.
 *
 * 실행:
 *   npx tsx scripts/sim-rebuy.ts
 *   브라우저에서  http://localhost:8301/dev/login  →  /games/holdem
 *
 * 봇 여섯은 계속 지른다. 다만 «동시에» 는 아니다 — 전원이 매번 올인하면 첫 판에
 * 다섯이 한꺼번에 죽고 그 자리에서 대회가 끝나서(advanceTable 이 탈락을 쓴 다음
 * 반복에서 곧장 finishTournament 로 간다) 리바이할 판 자체가 없어진다.
 * 봇은 죽으면 알아서 리바이한다. 사람이 죽었을 때 판이 살아 있어야 창을 눌러 볼 수
 * 있기 때문이다.
 *
 * 안전: DB_PATH 를 임시 디렉터리로 못 박고 시작할 때 지운다. 포트도 미리보기(8300)와
 * 다른 8301 을 쓴다 — 운영은 물론 로컬 개발 DB 도 건드릴 수 없다.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';

for (const d of readdirSync(tmpdir())) {
  if (d.startsWith('casino-rbsim')) rmSync(join(tmpdir(), d), { recursive: true, force: true });
}
process.env.DB_PATH = mkdtempSync(join(tmpdir(), 'casino-rbsim-'));
process.env.PREVIEW_LOGIN = '1';
process.env.PORT = process.env.PORT ?? '8301';

const { getDb } = require('../src/db/schema') as typeof import('../src/db/schema');
const Q = require('../src/db/queries') as typeof import('../src/db/queries');
const HD = require('../src/db/holdem') as typeof import('../src/db/holdem');
const A = require('../src/db/admin') as typeof import('../src/db/admin');
const T = require('../src/services/tournament') as typeof import('../src/services/tournament');
const { startWebServer } = require('../src/web/server') as typeof import('../src/web/server');

const db = getDb();
const nowSec = () => Math.floor(Date.now() / 1000);

const ME = { id: 'preview-user', name: '미리보기' };
const BOTS = [
  { id: 'rbsim-1', name: '김올인' }, { id: 'rbsim-2', name: '박몰빵' },
  { id: 'rbsim-3', name: '최지름' }, { id: 'rbsim-4', name: '이풀베팅' },
  { id: 'rbsim-5', name: '정한방' }, { id: 'rbsim-6', name: '한올인' },
];
const ALL = [ME, ...BOTS];

/* 리바이를 여러 번 할 수 있을 만큼 준다. 참가비 10,000P 짜리 판이므로 사람은
   40,000P 만 있으면 되지만(본 판 + 리바이 3회), 잔고가 빠듯하면 «포인트 부족» 화면이
   먼저 뜨고 정작 보려던 것을 못 본다. */
const SEED = 1_000_000;
for (const p of ALL) {
  Q.upsertUser(p.id, p.name, null);
  const b = Q.getWebUser(p.id)?.balance ?? 0;
  if (b !== SEED) Q.adjustBalance(p.id, SEED - b, 'rbsim:seed');
}

startWebServer();

const BUY_IN = Number(process.env.RB_BUYIN ?? 10_000);
const MAX_REBUYS = Number(process.env.RB_MAX ?? 3);
/* 스택은 작게, 레벨은 짧게. 리바이 창을 보려면 먼저 죽어야 하는데, 정상 스택(20,000)
   으로는 20분을 앉아 있어야 한다. 늦은 등록(=리바이 가능) 창은 반대로 길게 잡는다 —
   그게 닫히면 죽어도 창이 안 뜨고, 그때는 «기능이 고장난 것» 과 구별되지 않는다. */
const made = A.createTournament({
  title: '리바이 시뮬레이션', regOpenAt: nowSec() - 60, startAt: nowSec() + 3600,
  buyIn: BUY_IN, maxRebuys: MAX_REBUYS,
  startingStack: Number(process.env.RB_STACK ?? 600),
  levelMin: 3, lateRegMin: 120, graceMin: 10,
});
if (!made.ok) { console.error('대회를 못 열었다:', made.error); process.exit(1); }
for (const p of ALL) HD.registerHoldem(p.id, p.name);
db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(nowSec() - 1);

const st0 = HD.advanceHoldem();
const TID = st0.tournament!.id;

console.log('\n' + '━'.repeat(66));
console.log(`  리바이 시뮬레이션 — 참가 ${ALL.length}명 · 참가비 ${BUY_IN.toLocaleString('ko-KR')}P`);
console.log(`  리바이 최대 ${MAX_REBUYS}회 · 리바이 비용 ${HD.rebuyCostOf(st0.tournament!).toLocaleString('ko-KR')}P`);
console.log(`  봇 여섯은 계속 지르고, 죽으면 스스로 리바이합니다.`);
console.log(`  당신이 죽으면 화면에 리바이 창이 뜹니다 — 그걸 눌러 보세요.`);
console.log('━'.repeat(66));
console.log(`\n  브라우저에서 열어 주세요:`);
console.log(`     http://localhost:${process.env.PORT}/dev/login   (한 번만)`);
console.log(`     http://localhost:${process.env.PORT}/games/holdem\n`);

/* ── 봇 ────────────────────────────────────────────────────────────
   차례가 오면 열에 넷은 올인, 아니면 체크, 체크가 안 되면 폴드.
   전원이 매번 올인하면 한 판에 끝난다(위 머리말 참고). */
setInterval(() => {
  for (const b of BOTS) {
    if (randomInt(100) < 40 && HD.holdemAction(b.id, 'allin', 0).ok) continue;
    if (HD.holdemAction(b.id, 'check', 0).ok) continue;
    HD.holdemAction(b.id, 'fold', 0);
  }
}, 900);

/* 봇은 죽으면 곧바로 되산다. 사람이 죽었을 때 판이 살아 있어야 창을 눌러 볼 수 있고,
   판이 살아 있으려면 둘 이상이 남아야 한다.
   사람(preview-user)은 여기서 건드리지 않는다 — 사람 몫의 단추가 이 파일의 주제다. */
setInterval(() => {
  for (const b of BOTS) HD.rebuyHoldem(b.id, b.name);
}, 1200);

/* ── 상황판 ────────────────────────────────────────────────────────
   화면과 터미널을 나란히 놓고 본다. 바뀔 때만 한 줄 적는다 — 매초 찍으면
   «무엇이 달라졌나» 가 안 보인다. */
let last = '';
setInterval(() => {
  const t = db.prepare(`SELECT started_at, finished_at FROM holdem_tournaments WHERE id = ?`)
    .get(TID) as { started_at: number | null; finished_at: number | null };
  const entries = HD.getEntries(TID);
  const total = HD.totalEntriesOf(entries);
  const me = entries.find(e => e.user_id === ME.id);
  const table = HD.getTable(TID);
  const alive = table ? HD.getSeats(table.id).filter(s => s.presence !== 'OUT').length : 0;
  const pool = total * BUY_IN;
  const line = t.finished_at
    ? `대회 종료 — 총 엔트리 ${total} · 상금 풀 ${pool.toLocaleString('ko-KR')}P`
    : `${table?.hand_no ?? 0}판 · 생존 ${alive} · 총 엔트리 ${total}(리바이 ${total - entries.length})`
      + ` · 풀 ${pool.toLocaleString('ko-KR')}P · 지급 ${T.paidCount(pool, total)}명`
      + ` · 나: ${me?.elim_seq != null ? '탈락' : '생존'} 리바이 ${me?.rebuy_count ?? 0}/${MAX_REBUYS}`;
  if (line !== last) { console.log('  ' + line); last = line; }
  if (t.finished_at) process.exit(0);
}, 700);
