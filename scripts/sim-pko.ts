/* 9인 프리롤 PKO(현상금) 시뮬레이션 — 봇 아홉이 알아서 베팅해 끝까지 간다.
 *
 * 왜 따로 있나: sim-holdem.ts 는 4인 각본이고 자리 비움 장면을 일부러 만든다. 여기서
 * 보려는 것은 반대다 — 아무도 빠지지 않고 아홉이 계속 치면서 현상금이 어떻게 옮겨
 * 다니는지, 탈락 연출과 마지막 정산이 어떻게 흐르는지다. 그래서 각본을 두지 않고
 * 봇이 스스로 판단하게 한다(같은 판이 두 번 나오지 않는다).
 *
 * 실행:
 *   npx tsx scripts/sim-pko.ts
 * 그 다음 브라우저에서  http://localhost:8301/dev/login  →  /games/holdem
 *
 * 감사가 아니다. 단정하지 않고 사람이 눈으로 보게 하는 것이 목적이다 —
 * 총액 검산은 audit-pko 가 한다. 다만 진행 상황은 콘솔에 적어 둔다: 화면에서 놓친
 * 장면(누가 누구를 잡았고 현상금이 얼마 옮겨갔나)을 나중에 되짚을 수 있어야 한다.
 *
 * 안전: DB_PATH 를 임시 디렉터리로 못 박고 시작할 때 지운다. 로컬 개발 DB 나 운영을
 * 건드릴 수 없다. 포트도 미리보기(8300)와 다르게 8301 을 쓴다.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';

for (const d of readdirSync(tmpdir())) {
  if (d.startsWith('casino-simpko')) rmSync(join(tmpdir(), d), { recursive: true, force: true });
}
process.env.DB_PATH = mkdtempSync(join(tmpdir(), 'casino-simpko-'));
process.env.PORT = process.env.PORT ?? '8301';
/* /dev/login 을 열어 두는 플래그 이름이 이것이다(DEV_LOGIN 이 아니다).
   auth 가 설정돼 있으면 무시되고, 운영(FLY_APP_NAME)에서는 아예 닫힌다. */
process.env.PREVIEW_LOGIN = '1';
process.env.SEED_ADMIN_DISCORD_ID = process.env.SEED_ADMIN_DISCORD_ID ?? 'preview-user';

const { getDb } = require('../src/db/schema') as typeof import('../src/db/schema');
const Q = require('../src/db/queries') as typeof import('../src/db/queries');
const HD = require('../src/db/holdem') as typeof import('../src/db/holdem');
const AD = require('../src/db/admin') as typeof import('../src/db/admin');
const G = require('../src/services/holdem') as typeof import('../src/services/holdem');
const db = getDb();
const nowSec = (): number => Math.floor(Date.now() / 1000);
const P = (n: number): string => n.toLocaleString('ko-KR') + 'P';

/* 배수 10,000P — 절반(5,000P)이 머리에 걸린다. 프리롤이라 참가비는 걷지 않는다:
   상금과 현상금 모두 서비스가 발행하는 돈이고, 발행 총액은 인원 × 배수로 예전과 같다. */
const MULT = 10_000;
/* 나(preview-user)도 한 자리를 차지하고 봇이 대신 친다 — 그래야 6시 자리에서 내 카드가
   보이는 평소 화면으로 관전할 수 있다. 관전만 하면 hero 자리가 없어 화면이 달라진다. */
const ME = 'preview-user';
const BOTS = ['도라', '루피', '나미', '조로', '상디', '쵸파', '로빈', '프랑키'];
const ALL = [ME, ...BOTS];

for (const u of ALL) {
  Q.upsertUser(u, u, null);
  const bal = Q.getWebUser(u)?.balance ?? 0;
  if (bal < 100_000) Q.adjustBalance(u, 100_000 - bal, 'sim:seed');
}

const made = AD.createTournament({
  title: '9인 현상금전 (시뮬레이션)',
  regOpenAt: nowSec() - 60, startAt: nowSec() + 3,
  buyIn: 0, prizeMultiplier: MULT, prizeFixed: 0, mode: 'PKO_BOUNTY',
  /* 스택을 넉넉히, 레벨을 짧게 둔다 — 아홉이 다 떨어지려면 블라인드가 올라야 한다.
     스택이 크고 레벨이 길면 한 시간을 봐도 안 끝난다. */
  startingStack: 6_000, levelMin: 2, lateRegMin: 1, graceMin: 30,
});
if (!made.ok) { console.log('대회를 못 열었다:', made.error); process.exit(1); }
for (const u of ALL) {
  const r = HD.registerHoldem(u, u);
  if (!r.ok) console.log('등록 실패', u, r.error);
}
db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ? WHERE id = ?`)
  .run(nowSec() - 1, made.id);
HD.advanceHoldem();
const table = HD.getTable(made.id);
if (!table) { console.log('대회가 시작되지 않았다'); process.exit(1); }

const pool = (db.prepare(`SELECT bounty_pool FROM holdem_tournaments WHERE id = ?`)
  .get(made.id) as { bounty_pool: number }).bounty_pool;
console.log('═'.repeat(64));
console.log('  9인 프리롤 현상금전 · 배수 ' + P(MULT));
console.log('═'.repeat(64));
console.log('  등수 상금 ' + P(HD.prizePoolOf(
  db.prepare(`SELECT * FROM holdem_tournaments WHERE id=?`).get(made.id) as never, ALL.length))
  + '  +  현상금 펀드 ' + P(pool) + '  =  ' + P(MULT * ALL.length));
console.log('  한 사람 머리에 ' + P(Math.floor(MULT / 2)) + ' · 시작 스택 6,000 · 레벨 2분');
console.log('  브라우저: http://localhost:8301/dev/login  →  /games/holdem\n');

/* ── 봇 ────────────────────────────────────────────────────────────
   각본이 없다. 자기 차례가 오면 그 자리에서 legalActions 를 읽고 고른다.
   성향을 조금씩 달리 준다 — 전부 같은 확률로 두면 아홉이 한 사람처럼 움직여서
   판이 늘 비슷하게 끝난다. */
const STYLE: Record<string, { fold: number; raise: number; shove: number }> = {};
ALL.forEach((u, i) => {
  STYLE[u] = {
    fold: 8 + (i % 3) * 7,      // 8~22% 접는다
    raise: 12 + (i % 4) * 6,    // 12~30% 올린다
    shove: 3 + (i % 2) * 4,     // 3~7% 밀어 넣는다
  };
});

function act(userId: string, seat: number, handId: number): void {
  const hand = HD.getCurrentHand(table!.id);
  if (!hand || hand.id !== handId) return;
  /* 차례가 아직 열리지 않았으면 이번 주기는 건너뛴다 — 서버가 too_soon 으로 거절한다.
     여기서 멈추지 않으면 아래 대체 시도가 헛돈다. */
  const openAt = HD.actOpenAt(hand);
  if (openAt != null && nowSec() < openAt) return;
  const views = HD.getHandSeats(hand.id).map(h => ({
    seat: h.seat, bet: h.bet, stack: h.stack, committed: h.committed,
    state: h.state as G.SeatState, acted: h.acted === 1,
  }));
  const me = views.find(v => v.seat === seat);
  if (!me) return;
  const la = G.legalActions(me, views, hand.last_raise_size, hand.bb);
  const s = STYLE[userId] ?? { fold: 15, raise: 18, shove: 5 };
  const roll = randomInt(100);

  /* 짧은 스택은 접지 않는다 — 블라인드에 갉아먹히다 사라지면 KO 연출을 볼 기회가 줄고,
     실제로도 그 상황에서는 밀어 넣는 것이 정석이다. */
  const short = me.stack <= hand.bb * 6;
  if (short && (la.canCall || la.canCheck) && roll < 45) {
    if (HD.holdemAction(userId, 'allin', 0).ok) return;
  }
  if (roll < s.shove && HD.holdemAction(userId, 'allin', 0).ok) return;
  if (roll < s.shove + s.raise && la.minRaiseTo != null) {
    /* 최소 레이즈와 그 두 배 사이에서 고른다 — 늘 최소면 판이 커지지 않는다. */
    const lo = la.minRaiseTo;
    const hi = Math.min(me.stack + me.committed, lo * 2);
    const to = hi > lo ? lo + randomInt(hi - lo + 1) : lo;
    if (HD.holdemAction(userId, la.raiseIsBet ? 'bet' : 'raise', to).ok) return;
  }
  // 체크로 넘길 수 있으면 굳이 접지 않는다 — 공짜로 카드를 보는 자리다
  if (la.canCheck) { if (HD.holdemAction(userId, 'check', 0).ok) return; }
  else if (roll < s.shove + s.raise + s.fold) {
    if (HD.holdemAction(userId, 'fold', 0).ok) return;
  }
  if (la.canCall && HD.holdemAction(userId, 'call', 0).ok) return;
  if (HD.holdemAction(userId, 'check', 0).ok) return;
  HD.holdemAction(userId, 'fold', 0);
}

/* ── 진행 ──────────────────────────────────────────────────────────
   자리 비움을 만들지 않는다. 봇은 브라우저처럼 폴링하지 않으므로 그냥 두면 서버가
   유휴로 보고 SIT_OUT 으로 돌리는데, 그러면 자동 체크·폴드로 판이 흘러가 버린다.
   매 주기 last_seen_at 을 올려 아홉이 계속 앉아 있게 한다. */
let lastKoSeen = 0;
let finished = false;
const tick = setInterval(() => {
  try {
    if (finished) return;
    db.prepare(`UPDATE holdem_seats SET last_seen_at = ? WHERE table_id = ? AND presence != 'OUT'`)
      .run(nowSec(), table!.id);
    db.prepare(`UPDATE holdem_seats SET presence = 'ACTIVE'
                 WHERE table_id = ? AND presence = 'SIT_OUT'`).run(table!.id);

    const st = HD.advanceHoldem();
    /* 탈락과 현상금 이동을 콘솔에 남긴다 — 화면에서 놓친 장면을 되짚을 수 있어야 한다. */
    const rows = db.prepare(
      `SELECT user_id, bounty, bounty_won, ko_count, finish_place
         FROM holdem_entries WHERE tournament_id = ?`).all(made.id) as {
      user_id: string; bounty: number; bounty_won: number; ko_count: number;
      finish_place: number | null;
    }[];
    const kos = rows.reduce((n, r) => n + r.ko_count, 0);
    if (kos > lastKoSeen) {
      lastKoSeen = kos;
      const alive = HD.getSeats(table!.id).filter(x => x.presence !== 'OUT').length;
      const heads = rows.reduce((n, r) => n + r.bounty, 0);
      const cash = rows.reduce((n, r) => n + r.bounty_won, 0);
      console.log('KO ' + kos + '  남은 인원 ' + alive
        + '  |  머리 합 ' + P(heads) + ' + 나간 현상금 ' + P(cash) + ' = ' + P(heads + cash)
        + (heads + cash === pool ? '  ✔' : '  ✘ 펀드 ' + P(pool)));
      const top = rows.slice().sort((a, b) => b.bounty - a.bounty)[0];
      if (top) console.log('   머리 값 1위: ' + top.user_id + ' ' + P(top.bounty)
        + ' (KO ' + top.ko_count + ' · 받은 현상금 ' + P(top.bounty_won) + ')');
    }

    if (st.status === 'FINISHED') {
      finished = true;
      console.log('\n' + '─'.repeat(64));
      console.log('[최종]');
      for (const r of rows.slice().sort((a, b) => (a.finish_place ?? 99) - (b.finish_place ?? 99))) {
        const prize = (db.prepare(`SELECT prize FROM holdem_entries WHERE tournament_id=? AND user_id=?`)
          .get(made.id, r.user_id) as { prize: number }).prize;
        console.log('  ' + String(r.finish_place ?? '-') + '위  ' + r.user_id
          + '  KO ' + r.ko_count + '  상금 ' + P(prize) + '  현상금 ' + P(r.bounty_won)
          + '  합계 ' + P(prize + r.bounty_won));
      }
      const paid = (db.prepare(
        `SELECT COALESCE(SUM(delta),0) AS s FROM points_ledger WHERE reason = ? OR reason = ?`)
        .get('game:holdem:bounty:' + made.id, 'game:holdem:bounty:final:' + made.id) as { s: number }).s;
      console.log('\n  나간 현상금 ' + P(paid) + ' / 걷은 펀드 ' + P(pool)
        + (paid === pool ? '  ✔ 1P 도 남지 않았다' : '  ✘ 어긋난다'));
      console.log('  (테이블은 그대로 남겨 둔다 — 결과 화면을 보고 나서 Ctrl+C)');
      clearInterval(tick);
      return;
    }

    const hand = HD.getCurrentHand(table!.id);
    if (!hand || hand.ended_at != null || hand.to_act_seat == null) return;
    const seat = HD.getSeats(table!.id).find(
      x => x.seat === hand.to_act_seat && x.presence !== 'OUT');
    if (!seat) return;
    act(seat.user_id, seat.seat, hand.id);
  } catch (e) {
    console.error('진행 중 오류:', e);
  }
}, 900);

/* 서버는 함수를 불러야 뜬다 — require 만으로는 모듈만 읽히고 listen 하지 않는다. */
const { startWebServer } = require('../src/web/server') as typeof import('../src/web/server');
startWebServer();
