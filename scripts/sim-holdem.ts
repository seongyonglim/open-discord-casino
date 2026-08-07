/* 홀덤 프리롤 4인 시뮬레이션 — 화면에서 볼 수 있는 모든 연출을 순서대로 지나간다.
 *
 * 왜 있나: 실제 대회는 하루 한 번(22:00 KST)이고, 래빗 헌트·자발적 패 공개·사이드 팟처럼
 * 특정 조건에서만 나오는 연출은 우연에 맡기면 몇 판을 봐도 안 나온다. 그래서 각본을 짜서
 * 각 상황을 일부러 만든다.
 *
 * 실행:
 *   npx tsx scripts/sim-holdem.ts
 * 그 다음 브라우저에서  http://localhost:8301/dev/login  →  /games/holdem
 *
 * 이 파일은 감사가 아니다. 단정(assert)하지 않고, 사람이 눈으로 보게 하는 것이 목적이다.
 * 검증은 audit-holdem / audit-holdem-db가 한다.
 *
 * 안전: DB_PATH를 임시 디렉터리로 못 박고 시작할 때 지운다. 로컬 개발 DB나 운영을
 * 건드릴 수 없다. 포트도 미리보기(8300)와 다르게 8301을 쓴다.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';

/* 지난 실행이 남긴 DB를 전부 지운다.
   mkdtempSync는 실행마다 새 디렉터리(casino-sim-XXXXXX)를 만든다. 예전에는 'casino-sim'
   하나만 지웠기 때문에 옛 실행의 DB가 계속 쌓였고, 나중에 그걸 열어 보고 "칩이 샌다"고
   잘못 판단했다(그때 본 건 시뮬레이션이 스택을 낮춰 칩을 없앴던 옛 실행이었다). */
const SIM_DIR = join(tmpdir(), 'casino-sim');
try {
  for (const d of readdirSync(tmpdir())) {
    if (d.startsWith('casino-sim')) rmSync(join(tmpdir(), d), { recursive: true, force: true });
  }
} catch { /* 지울 수 없으면 그냥 새로 만든다 */ }
process.env.DB_PATH = mkdtempSync(SIM_DIR + '-');
process.env.PREVIEW_LOGIN = '1';
process.env.PORT = process.env.PORT ?? '8301';

const { getDb } = require('../src/db/schema') as typeof import('../src/db/schema');
const Q = require('../src/db/queries') as typeof import('../src/db/queries');
const HD = require('../src/db/holdem') as typeof import('../src/db/holdem');
const G = require('../src/services/holdem') as typeof import('../src/services/holdem');
const T = require('../src/services/tournament') as typeof import('../src/services/tournament');
const { startWebServer } = require('../src/web/server') as typeof import('../src/web/server');

const db = getDb();
const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/* ── 등장 인물 ────────────────────────────────────────────────────────
   미리보기(사람)와 봇 셋. 이름이 성향을 말해 준다 — 화면에서 누가 무엇을 할지 짐작된다. */
const ME = { id: 'preview-user', name: '미리보기' };
const BOT_NAMES = ['최레이즈', '박콜', '정폴드', '김올인', '이체크', '한타이트', '조루즈', '윤블러프'];
/* 봇 수를 바꿀 수 있게 둔다. 기본 3명(=4인 테이블)이면 각본을 눈으로 따라가기 쉽고,
   좌석 배치는 인원이 꽉 찼을 때만 드러나는 문제가 있다(9인에서 좌우 끝 태그가 넘치는지).
     SIM_BOTS=8 npx tsx scripts/sim-holdem.ts   (9인 만석 확인용) */
const BOT_COUNT = Math.max(1, Math.min(BOT_NAMES.length, Number(process.env.SIM_BOTS ?? 3)));
const BOTS = BOT_NAMES.slice(0, BOT_COUNT)
  .map((name, i) => ({ id: `sim-bot-${i + 1}`, name }));
const ALL = [ME, ...BOTS];

for (const p of ALL) {
  Q.upsertUser(p.id, p.name, null);
  if ((Q.getWebUser(p.id)?.balance ?? 0) <= 0) Q.adjustBalance(p.id, 200_000, 'sim:seed');
}

startWebServer();

/* ── 진행 상황 알림 ───────────────────────────────────────────────────
   터미널에 각본의 어느 대목인지 적는다. 브라우저만 보면 "지금 무엇을 보여주는 중"인지
   알 수 없어서, 이 로그와 화면을 나란히 놓고 보게 만든다. */
let actNo = 0;
function act(title: string, what: string[]): void {
  actNo++;
  console.log('\n' + '━'.repeat(66));
  console.log(`  ACT ${actNo}. ${title}`);
  for (const w of what) console.log(`    · ${w}`);
  console.log('━'.repeat(66));
}
function note(s: string): void { console.log('      ' + s); }

/* ── 대회 열기 ────────────────────────────────────────────────────────
   실제 일정(21:00 등록 · 22:00 시작)을 기다릴 수 없으므로 시각 창을 직접 만든다.
   등록은 시작 시각이 미래인 동안에 끝내야 한다 — registerHoldem이 내부에서
   advanceHoldem을 부르므로, 시작 시각이 이미 지났으면 세 번째 등록에서 대회가 시작돼
   네 번째 사람이 늦은 등록이 되어 첫 핸드에 못 들어간다. */
/* 대회를 직접 연다. 예전에는 advanceHoldem 이 오늘 판을 만들어 줘서 그 행의 시각만
   고쳐 썼는데, 자동 생성을 없앤 뒤로는 그럴 행이 없다 — 그대로 두면 여기서 죽는다. */
const A = require('../src/db/admin') as typeof import('../src/db/admin');
const made = A.createTournament({
  title: '시뮬레이션 프리롤', regOpenAt: nowSec() - 60, startAt: nowSec() + 3600,
});
if (!made.ok) { console.error('대회를 못 열었다:', made.error); process.exit(1); }
for (const p of ALL) HD.registerHoldem(p.id, p.name);
db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(nowSec() - 1);

const st0 = HD.advanceHoldem();
const TID = st0.tournament!.id;
const TABLE = HD.getTable(TID)!;

/* 시작 블라인드 레벨. 기본은 1이다.
   앤티는 레벨 6부터 붙는데(50/75/100/125/175/250), 정상 진행으로는 40분을 기다려야
   그 화면을 볼 수 있다. 레벨은 "시작 시각으로부터 흐른 시간"에서만 나오므로
   시작 시각을 뒤로 밀면 그 레벨에서 시작한다:
     SIM_LEVEL=6 npx tsx scripts/sim-holdem.ts   (앤티 연출 확인용) */
const START_LEVEL = Math.max(1, Math.min(T.BLIND_LEVELS.length, Number(process.env.SIM_LEVEL ?? 1)));
if (START_LEVEL > 1) {
  db.prepare(`UPDATE holdem_tournaments SET started_at = started_at - ? WHERE id = ?`)
    .run((START_LEVEL - 1) * T.LEVEL_DURATION_SEC, TID);
  const lv = T.BLIND_LEVELS[START_LEVEL - 1];
  console.log(`\n  시작 레벨 ${lv.level} — 블라인드 ${lv.sb}/${lv.bb}`
    + (lv.ante > 0 ? ` · 앤티 ${lv.ante}` : ' · 앤티 없음'));
}

const pool = T.prizePool(ALL.length, st0.tournament.prize_multiplier);
console.log(`\n  대회: ${st0.tournament.title}`);
console.log(`  참가 ${ALL.length}명 · 시작 스택 ${T.STARTING_STACK.toLocaleString('ko-KR')} · 블라인드 25/50`);
console.log(`  상금 풀 ${pool.toLocaleString('ko-KR')}P → 지급 ${T.itmCount(ALL.length)}명 `
  + `${JSON.stringify(T.prizeAmounts(pool, ALL.length))}`);
console.log(`\n  브라우저에서 열어 주세요:`);
console.log(`     http://localhost:${process.env.PORT}/dev/login   (한 번만)`);
console.log(`     http://localhost:${process.env.PORT}/games/holdem`);

/* ── 봇 두뇌 ──────────────────────────────────────────────────────────
   각본(PLAN)에 따라 성향이 바뀐다. 각 상황을 우연에 맡기지 않고 만들어 내는 게 목적이다. */
type Plan =
  | 'showdown'    // 전원 콜 — 리버까지 가서 쇼다운을 보여준다
  | 'foldEarly'   // 플랍에서 한 명만 베팅하고 나머지 폴드 → 래빗 헌트 조건
  | 'allin'       // 차례가 오면 올인 → 사이드 팟 · 탈락
  | 'quiet';      // 체크만 — 화면을 붙잡아 두고 관찰할 때

let PLAN: Plan = 'showdown';
/** 이 판에서 이미 베팅을 연 사람이 있는지 (foldEarly에서 한 명만 베팅하게 만든다) */
let openedBy: string | null = null;

function botMove(userId: string, handId: number, seat: number): void {
  const hand = HD.getCurrentHand(TABLE.id);
  if (!hand || hand.id !== handId) return;
  /* 차례가 아직 열리지 않았으면 이번 주기는 건너뛴다.
     서버가 too_soon으로 거절하므로 시도해도 아무 일도 일어나지 않지만, 여기서 멈추면
     아래의 대체 시도(올인 실패 → 콜 → 체크)가 헛돌지 않는다. 다음 주기에 다시 온다. */
  const openAt = HD.actOpenAt(hand);
  if (openAt != null && nowSec() < openAt) return;
  const hs = HD.getHandSeats(hand.id).find(h => h.seat === seat);
  if (!hs) return;
  const views = HD.getHandSeats(hand.id).map(h => ({
    seat: h.seat, bet: h.bet, stack: h.stack, committed: h.committed,
    state: h.state as G.SeatState, acted: h.acted === 1,
  }));
  const me = views.find(v => v.seat === seat)!;
  const la = G.legalActions(me, views, hand.last_raise_size, hand.bb);

  if (PLAN === 'allin') {
    if (!HD.holdemAction(userId, 'allin', 0).ok) {
      if (!HD.holdemAction(userId, 'call', 0).ok) HD.holdemAction(userId, 'check', 0);
    }
    return;
  }

  if (PLAN === 'foldEarly') {
    /* 프리플랍은 전원 콜로 넘겨 플랍을 깔고, 플랍에서 한 명이 베팅하면 나머지는 접는다.
       그러면 보드가 3장인 채로 판이 끝나 "그대로 갔으면 뭐가 나왔을까"(래빗)를 볼 수 있다. */
    if (hand.street === 'preflop') {
      if (la.canCall) HD.holdemAction(userId, 'call', 0);
      else HD.holdemAction(userId, 'check', 0);
      return;
    }
    if (openedBy == null && la.minRaiseTo != null) {
      openedBy = userId;
      HD.holdemAction(userId, la.raiseIsBet ? 'bet' : 'raise', la.minRaiseTo);
      return;
    }
    if (openedBy === userId) {
      if (la.canCheck) HD.holdemAction(userId, 'check', 0);
      else HD.holdemAction(userId, 'call', 0);
      return;
    }
    HD.holdemAction(userId, 'fold', 0);
    return;
  }

  if (PLAN === 'quiet') {
    if (la.canCheck) HD.holdemAction(userId, 'check', 0);
    else if (la.canCall) HD.holdemAction(userId, 'call', 0);
    else HD.holdemAction(userId, 'check', 0);
    return;
  }

  // showdown — 콜 위주. 첫 봇(최레이즈)만 가끔 올려서 팟이 커지는 걸 보여준다.
  if (userId === 'sim-bot-1' && la.minRaiseTo != null && randomInt(3) === 0) {
    HD.holdemAction(userId, la.raiseIsBet ? 'bet' : 'raise', la.minRaiseTo);
    return;
  }
  if (la.canCall) HD.holdemAction(userId, 'call', 0);
  else if (la.canCheck) HD.holdemAction(userId, 'check', 0);
  else HD.holdemAction(userId, 'fold', 0);
}

/* 사람 대신 두는 안전장치 — 기본은 꺼져 있다(0).
   켜면 "남은 시간이 이 값보다 적어지면" 시뮬레이션이 대신 누른다.

   예전 기본값은 6이었다. 내 차례를 그냥 두면 20초 뒤 자동 폴드되고 자리 비움으로
   내려가 판이 휙휙 지나가는 것을 막으려던 것이다. 그런데 그 대가가 컸다:
   화면에는 "7초에 강제로 체크됐다"로 보이고(폴링이 1초 간격이라 6초를 보는 순간 누른다),
   무엇보다 마지막 5초 연출 — 시계 고리가 붉어지고 똑딱 소리가 나는 구간 — 을
   한 번도 볼 수 없었다. 실제 게임에는 없는 동작이 실제 게임을 가리고 있었다.

   그래서 기본을 끈다. 20초가 그대로 흐르고 0초에 서버가 자동 체크한다(실제와 같다).
   내 자리는 그 뒤 자리 비움으로 내려가므로, 계속 플레이하려면 [게임 복귀]를 누른다.
   옛 동작이 필요하면 SIM_ME_GRACE=6 으로 켠다. */
const ME_GRACE_SEC = Number(process.env.SIM_ME_GRACE ?? 0);
let mePlayedFor = 0;

/* 래빗·패공개를 눌러볼 수 있게 다음 판을 미뤄 두는 시간.
   처음 3600초로 뒀더니 화면에 "다음 판 3594초"가 그대로 찍혔다 — 실제로 멈추는 시간과
   같은 값을 써야 카운트다운이 말이 된다. 아래 sleep과 반드시 같이 움직인다. */
const PAUSE_SEC = 30;

function maybePlayForMe(): void {
  const hand = HD.getCurrentHand(TABLE.id);
  if (!hand || hand.ended_at != null || hand.to_act_seat == null) return;
  const seat = HD.getSeats(TABLE.id).find(s => s.user_id === ME.id && s.presence !== 'OUT');
  if (!seat || seat.seat !== hand.to_act_seat) return;
  const left = (hand.action_deadline ?? nowSec()) - nowSec();
  if (left > ME_GRACE_SEC) return;                    // 아직 사람이 누를 시간이다
  mePlayedFor++;
  botMove(ME.id, hand.id, seat.seat);
}

/* ── 시뮬레이션 심장 ──────────────────────────────────────────────────
   서버에는 타이머가 없다(모든 상태는 시각에서 계산된다). 그래서 이 루프가
   "사람이 화면을 보고 있는 것"과 같은 역할을 한다 — 폴링하며 봇을 움직인다. */
let lastHandNo = 0;
let handEndedAt: number | null = null;
let onHandEnd: ((handId: number) => void) | null = null;

setInterval(() => {
  try {
    const s = HD.advanceHoldem();
    if (s.status !== 'RUNNING') return;
    const hand = HD.getCurrentHand(TABLE.id);
    if (!hand) return;

    if (hand.hand_no !== lastHandNo) { lastHandNo = hand.hand_no; openedBy = null; handEndedAt = null; }

    if (hand.ended_at != null) {
      if (handEndedAt == null) {
        handEndedAt = hand.ended_at;
        const cb = onHandEnd; onHandEnd = null;
        if (cb) cb(hand.id);
      }
      return;
    }

    maybePlayForMe();

    if (hand.to_act_seat == null) return;
    const seat = HD.getSeats(TABLE.id).find(x => x.seat === hand.to_act_seat && x.presence !== 'OUT');
    if (!seat || seat.user_id === ME.id) return;      // 사람 차례는 위에서 처리한다
    botMove(seat.user_id, hand.id, seat.seat);
  } catch { /* 경합은 다음 주기에 다시 본다 */ }
  /* 주기가 최소 액션 간격(ACT_GAP_SEC 1초)보다 촘촘해야 그 간격이 실제 템포가 된다.
     900ms였을 때는 "간격 1초 + 다음 주기까지 최대 0.9초"라 액션 사이가 최대 1.9초까지
     벌어졌다 — 규칙이 정한 1초가 아니라 폴링 주기가 템포를 정하고 있었다. */
}, 300);

/* ── 각본 진행 도우미 ─────────────────────────────────────────────── */

/** 지금 판이 끝날 때까지 기다린다 (최대 maxMs) */
async function waitHandEnd(maxMs = 60_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const h = HD.getCurrentHand(TABLE.id);
    if (h && h.ended_at != null) return;
    if (HD.advanceHoldem().status !== 'RUNNING') return;
    await sleep(400);
  }
}
/** 새 판이 시작될 때까지 기다린다 */
async function waitNextHand(maxMs = 60_000): Promise<void> {
  const from = HD.getCurrentHand(TABLE.id)?.hand_no ?? 0;
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const h = HD.getCurrentHand(TABLE.id);
    if (h && h.hand_no > from && h.ended_at == null) return;
    if (HD.advanceHoldem().status !== 'RUNNING') return;
    await sleep(400);
  }
}
function liveCount(): number {
  return HD.getSeats(TABLE.id).filter(s => s.presence !== 'OUT' && s.stack > 0).length;
}
function stacks(): string {
  return HD.getSeats(TABLE.id)
    .filter(s => s.presence !== 'OUT')
    .map(s => `${s.username} ${s.stack.toLocaleString('ko-KR')}`).join(' · ');
}

/* 테이블의 칩 총량은 언제나 시작 스택 × 인원이어야 한다.
   이 시뮬레이션은 상황을 만들려고 스택을 직접 건드리므로, 그 조작이 칩을 만들거나
   없애지 않았는지 스스로 확인한다 — 시뮬레이션이 불변식을 깨면 화면에서 "팟이 안 맞는다"로
   보여서 게임 버그로 오해된다. 게임 코드 쪽 보존은 audit-holdem-db가 검증한다. */
const EXPECTED_CHIPS = T.STARTING_STACK * ALL.length;
/* 판 사이에서만 잰다. 핸드가 도는 중에는 좌석 스택(holdem_seats)이 지난 판 끝의 값이고
   실제 스택은 핸드 안(holdem_hand_seats)에 있어서, 두 곳을 섞어 더하면 틀린 답이 나온다.
   판이 끝난 시점에는 좌석 스택에 딴 금액까지 반영되어 있어 그 합만 보면 된다. */
function checkChips(when: string): void {
  const h = HD.getCurrentHand(TABLE.id);
  if (h && h.ended_at == null) { note(`칩 확인 건너뜀 — 판 진행 중 (${when})`); return; }
  const total = HD.getSeats(TABLE.id).reduce((a, s) => a + s.stack, 0);
  if (total !== EXPECTED_CHIPS) {
    console.log(`      ⚠ 칩 총량 ${total.toLocaleString('ko-KR')} ≠ ${EXPECTED_CHIPS.toLocaleString('ko-KR')}`
      + `  (${when}) — 시뮬레이션의 스택 조작이 칩을 흘렸습니다`);
  } else {
    note(`칩 총량 ${total.toLocaleString('ko-KR')} 보존 (${when})`);
  }
}

async function main(): Promise<void> {
  await sleep(1500);

  /* ── ACT 1 ── 기본 화면 전부 */
  act('평범한 한 판 — 딜링부터 쇼다운까지', [
    '스몰블라인드부터 시계방향으로 두 바퀴 딜링',
    'D(딜러 버튼) · SB · BB 배지 위치',
    '현재 차례 맥박 + 아바타 둘레 시간 고리 (마지막 5초 붉게)',
    '내 족보 실시간 표시 — 등급을 만든 카드만 보라색으로 (펠트와 대비되게)',
    '마지막 액션이 뜨고 나서 다음 카드가 열립니다 (1.4초 간격)',
    '쇼다운 — 승자 족보명 + 이긴 5장 금색, 안 쓰인 카드는 물러난다',
    ME_GRACE_SEC > 0
      ? `내 차례는 ${ME_GRACE_SEC}초 남을 때까지 직접 누를 수 있습니다`
      : '내 차례는 20초가 그대로 흐릅니다 (실제와 같음) — 넘기면 자리 비움, [게임 복귀]로 돌아옵니다',
  ]);
  PLAN = 'showdown';
  await waitHandEnd();
  note(`판 1 종료 · 스택 → ${stacks()}`);
  checkChips('판 1 종료');
  await sleep(4000);

  /* ── ACT 2 ── 래빗 헌트 */
  act('래빗 헌트 — 그대로 갔으면 뭐가 깔렸을까', [
    '플랍에서 한 명만 베팅하고 나머지가 접어 보드 3장에서 판이 끝납니다',
    '판이 끝나면 [래빗] 버튼이 액션 줄에 나타납니다 — 눌러 보세요',
    '남은 두 장이 파란 점선으로 열립니다 (서버는 판이 끝난 뒤에만 이 카드를 보냅니다)',
  ]);
  PLAN = 'foldEarly';
  await waitNextHand();
  await waitHandEnd();
  {
    const h = HD.getCurrentHand(TABLE.id)!;
    const board = JSON.parse(h.board_json) as number[];
    note(`보드 ${board.length}장에서 종료 → 래빗으로 볼 카드 ${HD.rabbitBoard(h).length}장`);
    if (board.length >= 5) note('※ 리버까지 갔으므로 이번 판에는 래빗이 없습니다 (다음 판에 다시 시도)');
    /* 다음 판 시작을 미뤄 화면을 붙잡아 둔다.
       래빗 버튼은 "판이 끝났고 보드가 5장 미만"인 동안만 뜨는데, 그 창이 FOLD_END_SEC뿐이고
       1초 폴링과 보드 오픈 연출이 그 안에서 시간을 먹는다. 실제로 눌러볼 시간이 거의 없다.
       advanceTable은 now < next_hand_at 이면 그냥 빠져나오므로(지연 진행 구조) 이 한 줄로 멈춘다. */
    db.prepare(`UPDATE holdem_tables SET next_hand_at = ? WHERE id = ?`).run(nowSec() + PAUSE_SEC, TABLE.id);
    note('다음 판을 멈춰 뒀습니다 — [래빗] 버튼을 눌러 보세요 (25초 뒤 자동으로 진행합니다)');
  }
  await sleep(PAUSE_SEC * 1000 - 4000);   // 래빗 버튼을 눌러볼 시간 (고정 시간과 맞춘다)
  db.prepare(`UPDATE holdem_tables SET next_hand_at = ? WHERE id = ?`).run(nowSec() - 1, TABLE.id);

  /* ── ACT 3 ── 자발적 패 공개 */
  act('상대가 자기 패를 깝니다', [
    '폴드로 끝난 판이라 아무도 카드를 안 보여준 상태에서',
    '봇이 [패 공개]를 눌러 자기 홀 카드를 깝니다 (금색 테두리 = 자발적 공개)',
    '쇼다운으로 공개된 카드와 구분됩니다',
    '같은 조건이면 내 화면에도 [패 공개] 버튼이 나옵니다',
  ]);
  PLAN = 'foldEarly';
  await waitNextHand();
  await waitHandEnd();
  await sleep(2500);
  // 여기도 창이 짧아서 멈춰 둔다 — 남이 깐 카드와 내 [패 공개] 버튼을 볼 시간이 필요하다
  db.prepare(`UPDATE holdem_tables SET next_hand_at = ? WHERE id = ?`).run(nowSec() + PAUSE_SEC, TABLE.id);
  {
    /* 이 판에 참여했고 아직 안 까인 봇 하나가 자발적으로 공개한다 */
    const h = HD.getCurrentHand(TABLE.id)!;
    const seats = HD.getHandSeats(h.id);
    let shown = false;
    for (const b of BOTS) {
      const row = seats.find(x => x.user_id === b.id);
      if (!row || row.shown === 1) continue;
      /* 한 장만 깐다 — 보여 주려는 것이 바로 이 모양이다. 남에게는 깐 장만 앞면이고
         나머지는 뒷면으로 남는다(안 깐 장은 서버가 아예 안 내려보낸다). */
      if (HD.showHoldemCards(b.id, 1).ok) {
        note(`${b.name} 가 왼쪽 한 장만 공개했습니다 — 오른쪽은 뒷면으로 남습니다`);
        shown = true; break;
      }
    }
    if (!shown) note('※ 공개할 봇이 없었습니다 (전원 쇼다운으로 이미 공개된 판)');
  }
  await sleep(20_000);
  db.prepare(`UPDATE holdem_tables SET next_hand_at = ? WHERE id = ?`).run(nowSec() - 1, TABLE.id);

  /* ── ACT 4 ── 블라인드 상승 */
  act('블라인드 상승 — LEVEL UP', [
    '경과 시간을 8분 앞으로 당겨 레벨을 올립니다',
    '테이블 위에 LEVEL UP 팝업이 3초 뜹니다 (이전 값 → 새 값)',
    '오른쪽 패널의 블라인드·레벨·다음 상승 시각도 함께 바뀝니다',
    '핸드 도중에는 안 바뀝니다 — 다음 판부터 적용됩니다(실제 규칙)',
  ]);
  PLAN = 'quiet';
  db.prepare(`UPDATE holdem_tournaments SET started_at = started_at - ? WHERE id = ?`)
    .run(T.LEVEL_DURATION_SEC, TID);
  await waitNextHand();
  {
    const h = HD.getCurrentHand(TABLE.id)!;
    note(`레벨 ${h.level} · 블라인드 ${h.sb}/${h.bb}`);
  }
  await sleep(8000);

  /* ── ACT 5 ── 사이드 팟 */
  act('사이드 팟 — 숏스택이 올인한 위로 돈이 쌓일 때', [
    '한 명을 숏스택(1,200)으로 만들고 전원 올인으로 몰아붙입니다',
    'MAIN / SIDE 로 갈라져 보입니다 — 내가 자격 있는 층은 금색',
    '블라인드만 냈을 때는 층이 갈리지 않습니다 (올인이 뚜껑을 덮어야 사이드 팟입니다)',
  ]);
  /* 스택은 판 사이에만 고칠 수 있다. 핸드 진행 중에는 holdem_hand_seats 쪽 스택이 쓰이고,
     핸드가 끝날 때 좌석 스택이 그 값으로 다시 계산되어 덮어써진다.

     반드시 "옮기기"로 만든다. 한쪽 스택만 낮추면 그 차액이 사라져서 테이블 총 칩이
     10,000×인원보다 적어진다 — 화면에서 팟 합계가 안 맞는 것처럼 보여 게임이 칩을
     흘리고 있다는 오해를 만든다(실제로 그 오해가 나왔다).
     게임 코드의 칩 보존은 audit-holdem-db가 매 판 검증한다. 시뮬레이션이 그 불변식을
     깨뜨리면 시뮬레이션이 거짓말을 하는 것이다. */
  await waitHandEnd();
  {
    const SHORT = 1_200;
    const donor = BOTS[BOTS.length - 1].id;
    const seats = HD.getSeats(TABLE.id).filter(s => s.presence !== 'OUT');
    const from = seats.find(s => s.user_id === donor);
    const to = seats.find(s => s.user_id !== donor && s.stack > 0);
    if (from && to && from.stack > SHORT) {
      const moved = from.stack - SHORT;
      db.prepare(`UPDATE holdem_seats SET stack = ? WHERE table_id = ? AND seat = ?`)
        .run(SHORT, TABLE.id, from.seat);
      db.prepare(`UPDATE holdem_seats SET stack = stack + ? WHERE table_id = ? AND seat = ?`)
        .run(moved, TABLE.id, to.seat);
      note(`${from.username} → ${to.username} 로 ${moved.toLocaleString('ko-KR')} 옮겨 숏스택을 만들었습니다 (총 칩 보존)`);
    }
  }
  note(`숏스택 만들기 → ${stacks()}`);
  checkChips('ACT 5 숏스택 조작 후');
  PLAN = 'allin';
  await waitNextHand();
  await sleep(3000);
  {
    const h = HD.getCurrentHand(TABLE.id)!;
    const views = HD.getHandSeats(h.id).map(x => ({
      seat: x.seat, bet: x.bet, stack: x.stack, committed: x.committed,
      state: x.state as G.SeatState, acted: x.acted === 1,
    }));
    const layers = G.potLayers(views);
    note(`팟 층 ${layers.length}개: ${layers.map((p, i) => (i === 0 ? 'MAIN ' : `SIDE ${i} `) + p.amount).join(' · ')}`);
  }
  await waitHandEnd();
  await sleep(6000);

  /* ── ACT 6 ── 자리 비움 */
  act('자리 비움 — 기다리지 않고 넘어갑니다', [
    '봇 한 명을 자리 비움으로 내립니다 (아바타가 흑백 + II 배지)',
    '그 사람 차례는 20초를 기다리지 않고 즉시 체크/폴드됩니다',
    '내가 자리 비움이면 테이블 위에 안내 배너와 [게임 복귀] 버튼이 뜹니다',
  ]);
  PLAN = 'showdown';
  const away = HD.getSeats(TABLE.id).find(s => s.presence !== 'OUT' && s.user_id !== ME.id);
  if (away) {
    db.prepare(`UPDATE holdem_seats SET presence = 'SIT_OUT' WHERE table_id = ? AND seat = ?`)
      .run(TABLE.id, away.seat);
    note(`${away.username} 자리 비움 — 그 차례는 즉시 넘어갑니다`);
  }
  await waitNextHand();
  await sleep(9000);
  if (away) {
    HD.holdemSitIn(away.user_id, TABLE.id);
    note(`${away.username} 게임 복귀`);
  }
  await sleep(3000);

  /* ── ACT 7 ── 종료 */
  act('대회 종료 — 마지막 판을 보여주고 나서 우승 연출', [
    '한 명만 남을 때까지 올인으로 몰아붙입니다',
    '종료된 뒤에도 12초는 테이블에 머물러 마지막 판의 쇼다운을 보여줍니다',
    '중앙 메시지가 "대회 종료 · 결과 N초"로 바뀝니다',
    '그 다음 👑 WINNER 오버레이 — 우승자·상금·2~4위',
    `4명이면 지급은 ${T.itmCount(ALL.length)}명 (${T.prizeAmounts(pool, ALL.length).join(' / ')}P)`,
  ]);
  PLAN = 'allin';
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 240_000) {
      const s = HD.advanceHoldem();
      if (s.status === 'FINISHED') break;
      if (liveCount() <= 1) { HD.advanceHoldem(); break; }
      // 블라인드를 계속 올려 탈락을 재촉한다
      db.prepare(`UPDATE holdem_tournaments SET started_at = started_at - 60 WHERE id = ?`).run(TID);
      await sleep(1500);
    }
  }
  const fin = HD.advanceHoldem();
  const entries = HD.getEntries(TID);
  console.log('\n' + '─'.repeat(66));
  console.log(`  상태 = ${fin.status}`);
  for (const e of entries.slice().sort((a, b) => (a.finish_place ?? 9) - (b.finish_place ?? 9))) {
    console.log(`   ${e.finish_place}위  ${e.username.padEnd(8)} ${e.prize ? e.prize.toLocaleString('ko-KR') + 'P' : '-'}`);
  }
  console.log(`  내 차례를 대신 눌러준 횟수: ${mePlayedFor}`);
  console.log('─'.repeat(66));
  console.log('\n  화면에서 우승 연출이 끝나면 [확인]을 눌러 로비로 돌아갑니다.');
  console.log('  다시 처음부터 보려면 이 스크립트를 다시 실행하세요 (DB는 매번 새로 만듭니다).\n');
}

main().catch(e => { console.error(e); process.exit(1); });
