/* 홀덤 프리롤 — DB 계층 실증 검사.
 *
 * 순수 엔진(audit-holdem.ts)과 달리 여기서는 실제 SQLite에 토너먼트를 만들어
 * 끝까지 돌린다. 서버 타이머가 없으므로 시각을 DB에서 당겨 단계를 넘긴다 —
 * 다른 게임 감사가 쓰는 expire() 방식과 같다.
 *
 * 핵심 불변식 셋:
 *   1. 칩 총량 = 시작 스택 × 등록자 수 (핸드가 끝난 어느 시점에서도)
 *   2. 팟 합계 = 분배 합계 (한 칩도 새지 않는다)
 *   3. 등수 1..N이 빈틈없이 · 지급 합계 = 상금 풀 · 잔액 = 원장 누적합
 *
 * 이 검사가 실제로 잡아낸 버그 셋:
 *   · 콜되지 않은 초과 베팅이 반환되지 않아 1,150칩이 증발했다
 *   · 상대가 전부 올인인데도 남은 한 명에게 계속 액션을 물어봤다(폴드까지 가능했다)
 *   · 늦은 등록이 들어오면 탈락 시점에 매긴 등수가 어긋났다
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = mkdtempSync(join(tmpdir(), 'ht-'));

const { getDb } = require('../src/db/schema') as typeof import('../src/db/schema');
const Q = require('../src/db/queries') as typeof import('../src/db/queries');
const HD = require('../src/db/holdem') as typeof import('../src/db/holdem');
const T = require('../src/services/tournament') as typeof import('../src/services/tournament');
const G = require('../src/services/holdem') as typeof import('../src/services/holdem');

const db = getDb();
const nowSec = () => Math.floor(Date.now() / 1000);
let pass = 0, fail = 0;
function ck(name: string, ok: boolean, extra = ''): void {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}

function mkUser(id: string): void {
  Q.upsertUser(id, id, null);
}

/** 현재 핸드의 액션 마감을 과거로 — 자동 액션을 유발한다 */
function expireAction(): void {
  db.prepare(`UPDATE holdem_hands SET action_deadline = ? WHERE ended_at IS NULL`).run(nowSec() - 1);
}
/** 다음 핸드 시작 예약을 지금으로 */
function expireNextHand(): void {
  db.prepare(`UPDATE holdem_tables SET next_hand_at = ? WHERE next_hand_at IS NOT NULL`).run(nowSec() - 1);
}

function totalChips(tableId: number): number {
  return HD.getSeats(tableId).reduce((a, s) => a + s.stack, 0);
}

console.log('[1] 등록 · 시작');
const N = 4;
for (let i = 0; i < N; i++) mkUser('p' + i);

let st = HD.advanceHoldem();
ck('오늘 토너먼트가 생성됨', st.tournament != null && st.tournament.date_str.length === 10,
  st.tournament?.date_str);

/* 상태 검사는 시각을 먼저 못 박고 한다.
   이 감사를 22:20(KST) 이후에 돌리면 갓 만든 토너먼트가 곧바로 "인원 미달 취소"로
   판정되는 게 맞다 — 제품이 옳고 단정이 틀린 경우였다. 그래서 검사할 상태마다
   그 상태가 되는 시각을 직접 만들어 준다. 하루 중 언제 돌려도 결과가 같아야 한다. */
function setWindow(regOpen: number, start: number, grace: number): void {
  db.prepare(`UPDATE holdem_tournaments SET cancelled_at = NULL, finished_at = NULL,
    started_at = NULL, reg_open_at = ?, scheduled_start_at = ?, grace_ends_at = ?`)
    .run(nowSec() + regOpen, nowSec() + start, nowSec() + grace);
}

setWindow(600, 1200, 2400);            // 등록이 아직 안 열렸다
ck('등록 전 → SCHEDULED', HD.advanceHoldem().status === 'SCHEDULED');
setWindow(-60, 600, 1800);             // 등록만 열렸다
ck('등록 창 안 → REGISTRATION_OPEN', HD.advanceHoldem().status === 'REGISTRATION_OPEN');
setWindow(-3600, -60, 1800);           // 시작 시각은 지났고 인원 0
ck('시작 시각 지났지만 인원 미달 → WAITING_MIN_PLAYERS',
  HD.advanceHoldem().status === 'WAITING_MIN_PLAYERS');
setWindow(-7200, -3600, -60);          // 대기 마감까지 지났고 인원 0
st = HD.advanceHoldem();
ck('대기 마감까지 미달 → CANCELLED', st.status === 'CANCELLED', st.status);
ck('취소 시각이 기록됨', st.tournament.cancelled_at != null);

// 같은 판을 되살려 이어서 쓴다 (취소를 지우고 시각을 다시 앞으로)
setWindow(-60, 600, 1800);
st = HD.advanceHoldem();
ck('등록 오픈됨', st.status === 'REGISTRATION_OPEN', st.status);

for (let i = 0; i < N; i++) {
  const r = HD.registerHoldem('p' + i, 'p' + i);
  if (!r.ok) console.log('    등록 실패 p' + i + ': ' + r.error);
}
st = HD.advanceHoldem();
ck(`${N}명 등록됨`, st.registered === N, String(st.registered));
ck('중복 등록 거절', HD.registerHoldem('p0', 'p0').ok === false);

// 시작 시각을 지금으로
db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?, grace_ends_at = ?`)
  .run(nowSec() - 1, nowSec() + 1200);
st = HD.advanceHoldem();
ck('3명 이상이면 RUNNING', st.status === 'RUNNING', st.status);
ck('시작 시각이 기록됨', st.tournament.started_at != null);

let table = HD.getTable(st.tournament.id)!;
ck('테이블이 생성됨', table != null);
ck(`${N}명이 앉음`, HD.getSeats(table.id).length === N, String(HD.getSeats(table.id).length));
ck('시작 칩 총량 = 10,000 × 인원', totalChips(table.id) === T.STARTING_STACK * N,
  String(totalChips(table.id)));

/* ── 참가 신청 취소 ────────────────────────────────────────────────
   시작 전에만 되어야 한다. 시작한 뒤에 취소되면 이미 칩을 들고 앉은 사람의 등록이
   사라져 상금 구조(ITM 인원·금액)까지 어긋난다. */
console.log('\n[1b] 참가 신청 취소는 시작 전에만 된다');
{
  // 지금은 이미 시작된 상태다([1]에서 시작시켰다) — 취소가 거부되어야 한다
  const started = HD.getEntries(st.tournament.id);
  const someone = started[0]!;
  const no = HD.unregisterHoldem(someone.user_id);
  ck('시작한 뒤에는 취소 거부', !no.ok && no.error === 'already_started', JSON.stringify(no));
  ck('거부됐으니 등록자 수 그대로',
    HD.getEntries(st.tournament.id).length === started.length,
    `${HD.getEntries(st.tournament.id).length} vs ${started.length}`);

  // 시작 전 상태를 따로 만들어 취소가 되는지 본다
  /* 여섯 테이블을 모두 비운다. holdem_hands를 남기면 사고가 난다 —
     holdem_tables는 AUTOINCREMENT가 아니라 행을 다 지우면 id가 1부터 다시 붙고,
     그러면 새 테이블이 옛 테이블의 핸드를 물려받아 카드가 어긋난다(실제로 그랬다). */
  for (const tb of ['holdem_hand_seats', 'holdem_hands', 'holdem_seats',
    'holdem_tables', 'holdem_entries', 'holdem_tournaments']) {
    db.prepare(`DELETE FROM ${tb}`).run();
  }
  HD.advanceHoldem();
  setWindow(-60, 600, 1800);                       // 등록 열림 · 시작은 아직
  mkUser('c1'); mkUser('c2');
  HD.registerHoldem('c1', 'c1'); HD.registerHoldem('c2', 'c2');
  const before = HD.advanceHoldem();
  ck('시작 전 상태다', before.tournament.started_at == null, String(before.status));
  ck('등록 2명', HD.getEntries(before.tournament.id).length === 2);

  const yes = HD.unregisterHoldem('c1');
  ck('시작 전에는 취소 성공', yes.ok, JSON.stringify(yes));
  ck('등록자가 1명으로 줄었다', HD.getEntries(before.tournament.id).length === 1,
    String(HD.getEntries(before.tournament.id).length));
  ck('취소한 사람의 등록만 사라졌다',
    HD.getEntries(before.tournament.id)[0]!.user_id === 'c2');
  const again = HD.unregisterHoldem('c1');
  ck('두 번 취소하면 거부 (신청 안 한 상태)',
    !again.ok && again.error === 'not_registered', JSON.stringify(again));
  ck('취소 후 다시 신청할 수 있다', HD.registerHoldem('c1', 'c1').ok);
  ck('다시 2명', HD.getEntries(before.tournament.id).length === 2);

  // 상태를 [2] 이후가 쓸 수 있게 되돌린다 (3명으로 시작시킨다)
  /* 여섯 테이블을 모두 비운다. holdem_hands를 남기면 사고가 난다 —
     holdem_tables는 AUTOINCREMENT가 아니라 행을 다 지우면 id가 1부터 다시 붙고,
     그러면 새 테이블이 옛 테이블의 핸드를 물려받아 카드가 어긋난다(실제로 그랬다). */
  for (const tb of ['holdem_hand_seats', 'holdem_hands', 'holdem_seats',
    'holdem_tables', 'holdem_entries', 'holdem_tournaments']) {
    db.prepare(`DELETE FROM ${tb}`).run();
  }
  HD.advanceHoldem();
  /* 시작 시각이 이미 지난 상태로 등록하면 안 된다. registerHoldem이 내부에서
     advanceHoldem을 부르므로, 세 번째 등록에서 대회가 시작돼 버리고 네 번째는
     늦은 등록이 되어 첫 핸드에 안 들어간다(그래서 "전원 홀 카드 2장"이 깨졌다).
     [1]과 같은 순서로 간다 — 시작을 미래로 두고 전원 등록한 뒤 시작 시각을 당긴다. */
  setWindow(-60, 600, 1800);
  // [1]에서 만든 유저를 그대로 쓴다 — 없는 유저로 등록하면 좌석은 생기지만 카드가 안 돌아간다
  for (let i = 0; i < N; i++) HD.registerHoldem('p' + i, 'p' + i);
  db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(nowSec() - 1);
  st = HD.advanceHoldem();
  table = HD.getTable(st.tournament.id)!;
  ck('[2]로 넘기기 전에 판을 다시 시작했다',
    st.status === 'RUNNING' && table != null && HD.getSeats(table.id).length === N,
    `${st.status} · 좌석 ${table ? HD.getSeats(table.id).length : 0}`);
}

console.log('\n[2] 첫 핸드');
let hand = HD.getCurrentHand(table.id)!;
ck('핸드 1이 시작됨', hand != null && hand.hand_no === 1, String(hand?.hand_no));
ck('레벨 1 (25/50)', hand.sb === 25 && hand.bb === 50, `${hand.sb}/${hand.bb}`);
{
  const hs = HD.getHandSeats(hand.id);
  ck('전원 홀 카드 2장', hs.length === N && hs.every(h => (JSON.parse(h.hole_json) as number[]).length === 2));
  const holes = hs.flatMap(h => JSON.parse(h.hole_json) as number[]);
  ck('홀 카드가 서로 겹치지 않음', new Set(holes).size === holes.length);
  const posted = hs.filter(h => h.committed > 0);
  ck('블라인드 두 명만 냈다', posted.length === 2, JSON.stringify(posted.map(p => [p.seat, p.committed])));
  ck('SB 25 · BB 50 이 걷혔다',
    posted.map(p => p.committed).sort((a, b) => a - b).join() === '25,50',
    posted.map(p => p.committed).join());
  ck('행동할 사람이 정해졌다', hand.to_act_seat != null, String(hand.to_act_seat));
  ck('마감 시각이 있다', hand.action_deadline != null);
  ck('아직 아무도 acted가 아니다 (블라인드는 행동이 아니다)', hs.every(h => h.acted === 0));
}

console.log('\n[3] 자동 액션 (마감 초과)');
{
  const before = hand.to_act_seat!;
  expireAction();
  HD.advanceHoldem();
  hand = HD.getCurrentHand(table.id)!;
  const hs = HD.getHandSeats(hand.id);
  const acted = hs.find(h => h.seat === before)!;
  ck('마감 지난 사람이 자동 처리됐다 (폴드 또는 체크)',
    acted.acted === 1 || acted.state === 'folded', JSON.stringify(acted));
  const seat = HD.getSeats(table.id).find(s => s.seat === before)!;
  ck('그 사람이 SIT_OUT으로 내려갔다', seat.presence === 'SIT_OUT', seat.presence);
  ck('다음 사람으로 차례가 넘어갔다 (또는 라운드 종료)',
    hand.to_act_seat !== before || hand.ended_at != null, String(hand.to_act_seat));
}

/* ── 카드 무결성 (실제 서버 딜링) ─────────────────────────────────
   홀덤은 52장 한 덱이라 같은 카드가 두 번 나오면 버그다. 감사가 인덱스 규칙을
   다시 쓰면 자기 코드를 검증하는 셈이니, 서버가 실제로 남긴 hole_json·board_json·
   deck_json·deck_pos를 그대로 대조한다. */
console.log('\n[2b] 카드 무결성 — 배분된 카드가 덱과 어긋나지 않는다');
{
  const hs = HD.getHandSeats(hand.id);
  const deck = JSON.parse(hand.deck_json) as number[];
  const holes = hs.flatMap(h => JSON.parse(h.hole_json) as number[]);
  const board = JSON.parse(hand.board_json) as number[];
  const dealt = [...holes, ...board];

  ck('덱이 0~51 서로 다른 52장이다',
    deck.length === 52 && new Set(deck).size === 52
    && Math.min(...deck) === 0 && Math.max(...deck) === 51);
  ck('배분된 카드에 중복이 없다 (같은 카드가 두 번 나오지 않는다)',
    new Set(dealt).size === dealt.length,
    G.cardsToStrings(dealt).join(' '));
  ck('배분된 카드가 전부 덱에 있는 카드다 (없는 카드를 만들지 않는다)',
    dealt.every(c => deck.includes(c)));
  /* 홀 카드는 덱 앞쪽에서 두 바퀴로 뽑는다 — 배분된 홀 카드가 덱의 앞 N장과
     정확히 같은 집합인지 본다. 인덱스를 두 번 쓰면 여기서 어긋난다. */
  ck('홀 카드가 덱 앞쪽 N장과 정확히 같은 집합이다',
    new Set(holes).size === holes.length
    && holes.every(c => deck.indexOf(c) < holes.length),
    `홀 ${holes.length}장`);
  ck('deck_pos가 배분한 만큼 밀려 있다 (되감기지 않는다)',
    hand.deck_pos >= holes.length, `${hand.deck_pos} vs 홀 ${holes.length}`);
}

/* ── 스트리트를 닫은 마지막 행동 ──────────────────────────────────
   nextStreet가 좌석의 last_action을 같은 트랜잭션에서 지우기 때문에, 폴링 주기 1초로는
   스트리트를 닫은 행동이 클라이언트에 한 번도 도달하지 않았다("딜러가 체크했는데
   안 보이고 플랍이 바로 깔린다"). 그 행동은 핸드 쪽(last_actor_*)에 남아야 한다. */
console.log('\n[3b] 스트리트를 닫은 행동이 핸드에 남는다');
{
  // 프리플랍이 닫힐 때까지 자동 진행
  let steps = 0;
  while (steps++ < 200) {
    hand = HD.getCurrentHand(table.id)!;
    if (hand.street !== 'preflop' || hand.ended_at != null) break;
    expireAction();
    HD.advanceHoldem();
  }
  hand = HD.getCurrentHand(table.id)!;
  ck('프리플랍을 벗어났다 (검증이 헛돌지 않았다)',
    hand.street !== 'preflop' || hand.ended_at != null, hand.street);
  ck('마지막 행동자가 기록됐다', hand.last_actor_seat != null, String(hand.last_actor_seat));
  ck('마지막 행동 종류가 기록됐다', !!hand.last_actor_action, String(hand.last_actor_action));
  const hs = HD.getHandSeats(hand.id);
  const closer = hs.find(h => h.seat === hand.last_actor_seat)!;
  ck('그 좌석의 표시는 초기화됐다 (핸드 쪽 기록이 없으면 화면에 못 띄운다)',
    closer.last_action === null || closer.last_action === 'fold',
    String(closer.last_action));
  ck('행동 종류가 실제 액션 이름이다',
    ['fold', 'check', 'call', 'bet', 'raise', 'allin'].includes(hand.last_actor_action!),
    String(hand.last_actor_action));
  ck('금액이 음수가 아니다', hand.last_actor_amount >= 0, String(hand.last_actor_amount));
}

console.log('\n[4] 한 판을 자동으로 끝까지');
{
  let steps = 0;
  while (steps++ < 200) {
    hand = HD.getCurrentHand(table.id)!;
    if (hand.ended_at != null) break;
    expireAction();
    HD.advanceHoldem();
  }
  hand = HD.getCurrentHand(table.id)!;
  ck('핸드가 끝났다', hand.ended_at != null, `steps=${steps}`);
  ck('결과가 기록됐다', hand.result_json != null);
  ck('칩 총량이 보존됐다', totalChips(table.id) === T.STARTING_STACK * N,
    `${totalChips(table.id)} vs ${T.STARTING_STACK * N}`);
  const res = JSON.parse(hand.result_json!);
  const potSum = (res.pots as { amount: number }[]).reduce((a, p) => a + p.amount, 0);
  const awSum = (res.awards as { amount: number }[]).reduce((a, x) => a + x.amount, 0);
  ck('팟 합계 = 분배 합계', potSum === awSum, `${potSum} vs ${awSum}`);
  ck('다음 핸드가 예약됐다', HD.getTable(st.tournament.id)!.next_hand_at != null);
}

/* ── 자발적 패 공개 ────────────────────────────────────────────────
   끝난 판에서만 열려야 한다. 진행 중에 자기 패를 흘리면 남은 사람에게
   정보를 주는 것이고 담합의 통로가 된다. [4]에서 판이 막 끝난 상태를 그대로 쓴다. */
console.log('\n[4b] 내 패 공개 (끝난 판에서만)');
{
  const mine = HD.getHandSeats(hand.id)[0];
  const other = HD.getHandSeats(hand.id)[1];
  ck('처음에는 아무도 공개 상태가 아니다',
    HD.getHandSeats(hand.id).every(h => h.shown === 0));

  ck('끝난 판에서는 공개가 받아들여진다', HD.showHoldemCards(mine.user_id).ok);
  let hs = HD.getHandSeats(hand.id);
  ck('공개한 사람만 shown이 켜졌다',
    hs.find(h => h.seat === mine.seat)!.shown === 1
    && hs.filter(h => h.shown === 1).length === 1,
    JSON.stringify(hs.map(h => [h.seat, h.shown])));
  ck('같은 요청을 다시 보내도 안전하다 (멱등)',
    HD.showHoldemCards(mine.user_id).ok
    && HD.getHandSeats(hand.id).filter(h => h.shown === 1).length === 1);

  // 새 판을 시작시킨 뒤에는 지난 판을 열 수 없다
  expireNextHand();
  HD.advanceHoldem();
  const next = HD.getCurrentHand(table.id)!;
  ck('새 판이 시작됐다 (검증이 헛돌지 않았다)', next.id !== hand.id && next.ended_at == null);
  ck('진행 중에는 공개가 거부된다', HD.showHoldemCards(other.user_id).ok === false);
  ck('진행 중인 판에 shown이 켜지지 않았다',
    HD.getHandSeats(next.id).every(h => h.shown === 0));
  ck('지난 판의 공개 기록은 그대로 남는다',
    HD.getHandSeats(hand.id).filter(h => h.shown === 1).length === 1);
  ck('참가하지 않은 사람은 공개할 수 없다', HD.showHoldemCards('nobody-xyz').ok === false);

  /* 열어놓은 판을 닫아 [5]에게 넘긴다. [5]는 "판이 끝난 상태"에서 시작해
     판마다 시간을 밀어 블라인드를 올리는데, 여기서 진행 중인 판을 남기면
     그 판만큼 활주로가 줄어 레벨이 오르기 전에 토너먼트가 끝난다. */
  let close = 0;
  while (close++ < 200 && HD.getCurrentHand(table.id)!.ended_at == null) {
    expireAction();
    HD.advanceHoldem();
  }
  hand = HD.getCurrentHand(table.id)!;
  ck('[5]로 넘기기 전에 판을 닫았다', hand.ended_at != null, `steps=${close}`);
}

console.log('\n[5] 토너먼트를 끝까지 (실제 액션 — 전원 올인)');
{
  /* 전원 폴드만 하면 칩이 순환만 하고 아무도 안 죽는다(블라인드가 오르지 않으면 영원히).
     실제 액션을 넣어야 탈락·사이드 팟·순위 확정이 돌아간다. 가장 거친 전략인
     "차례가 오면 올인"으로 몰아붙인다 — 사이드 팟이 매 판 생긴다. */
  let steps = 0, hands = 0, allins = 0, chipBreak = 0, levelUps = 0;
  let lastTotal = totalChips(table.id);
  let maxLevel = 1;
  while (steps++ < 6000) {
    const s = HD.advanceHoldem();
    if (s.status === 'FINISHED') break;
    const h = HD.getCurrentHand(table.id);
    if (!h) break;
    maxLevel = Math.max(maxLevel, h.level);

    if (h.ended_at != null) {
      hands++;
      const tot = totalChips(table.id);
      if (tot !== T.STARTING_STACK * N) chipBreak++;
      lastTotal = tot;
      // 판마다 8분씩 흐르게 해서 블라인드를 올린다 (올인 판은 금방 끝나므로)
      db.prepare(`UPDATE holdem_tournaments SET started_at = started_at - ?`)
        .run(T.LEVEL_DURATION_SEC);
      levelUps++;
      expireNextHand();
      continue;
    }

    if (h.to_act_seat == null) { expireAction(); continue; }
    const seat = HD.getSeats(table.id).find(x => x.seat === h.to_act_seat && x.presence !== 'OUT');
    if (!seat) { expireAction(); continue; }
    const r = HD.holdemAction(seat.user_id, 'allin', 0);
    if (r.ok) allins++; else expireAction();
  }
  const fin = HD.advanceHoldem();
  ck('토너먼트가 종료됐다', fin.status === 'FINISHED',
    `${fin.status} steps=${steps} hands=${hands} allin=${allins} maxLevel=${maxLevel}`);
  ck('실제 액션이 수락됐다', allins > 0, String(allins));
  ck('블라인드 레벨이 올라갔다', maxLevel > 1, `최대 레벨 ${maxLevel} (${levelUps}회 상승)`);
  ck('진행 중 칩 총량이 한 번도 깨지지 않았다', chipBreak === 0, `${chipBreak}회 · 마지막 ${lastTotal}`);

  const entries = HD.getEntries(fin.tournament.id);
  ck('전원 순위가 정해졌다', entries.every(e => e.finish_place != null),
    JSON.stringify(entries.map(e => [e.username, e.finish_place])));
  const places = entries.map(e => e.finish_place!).sort((a, b) => a - b);
  ck('순위가 1..N 로 빠짐없이 채워졌다',
    places.join() === Array.from({ length: N }, (_, i) => i + 1).join(), places.join());

  const pool = T.prizePool(entries.length, fin.tournament.prize_multiplier);
  const paid = entries.reduce((a, e) => a + e.prize, 0);
  ck('지급 합계 = 상금 풀', paid === pool, `${paid} vs ${pool}`);
  const expect = T.prizeAmounts(pool, entries.length);
  const actual = entries.filter(e => e.prize > 0)
    .sort((a, b) => a.finish_place! - b.finish_place!).map(e => e.prize);
  ck('순위별 금액이 정책과 일치', JSON.stringify(actual) === JSON.stringify(expect),
    `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

  // 잔액 = 원장 누적합
  let ledgerBad = 0;
  for (const e of entries) {
    const bal = Q.getWebUser(e.user_id)!.balance;
    const sum = db.prepare(`SELECT COALESCE(SUM(delta),0) AS s FROM points_ledger WHERE user_id = ?`)
      .get(e.user_id) as { s: number };
    if (bal !== sum.s) ledgerBad++;
  }
  ck('잔액 = 원장 누적합', ledgerBad === 0, `${ledgerBad}명 불일치`);
  ck('두 번 정산해도 추가 지급 없음', (() => {
    const before = entries.reduce((a, e) => a + Q.getWebUser(e.user_id)!.balance, 0);
    HD.advanceHoldem(); HD.advanceHoldem();
    const after = HD.getEntries(fin.tournament.id)
      .reduce((a, e) => a + Q.getWebUser(e.user_id)!.balance, 0);
    return before === after;
  })());
}

console.log('\n[6] 블라인드는 진행 중인 핸드 도중에 오르지 않는다 (스펙 5항)');
{
  // 새 판을 세운다
  db.prepare(`DELETE FROM holdem_hand_seats`).run();
  db.prepare(`DELETE FROM holdem_hands`).run();
  db.prepare(`DELETE FROM holdem_seats`).run();
  db.prepare(`DELETE FROM holdem_tables`).run();
  db.prepare(`DELETE FROM holdem_entries`).run();
  db.prepare(`DELETE FROM holdem_tournaments`).run();
  HD.advanceHoldem();
  setWindow(-60, 600, 1800);
  for (let i = 0; i < 3; i++) { mkUser('q' + i); HD.registerHoldem('q' + i, 'q' + i); }
  db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(nowSec() - 1);
  const s2 = HD.advanceHoldem();
  const tb2 = HD.getTable(s2.tournament.id)!;
  const h1 = HD.getCurrentHand(tb2.id)!;
  ck('첫 핸드는 레벨 1', h1.level === 1, String(h1.level));

  // 핸드 도중에 세 레벨만큼 시간이 흐르게 한다
  db.prepare(`UPDATE holdem_tournaments SET started_at = started_at - ?`)
    .run(T.LEVEL_DURATION_SEC * 3);
  HD.advanceHoldem();
  const h1b = HD.getCurrentHand(tb2.id)!;
  ck('시간이 흘러도 진행 중인 핸드의 레벨은 그대로', h1b.level === 1 && h1b.id === h1.id,
    `레벨 ${h1b.level}`);
  ck('블라인드 금액도 그대로', h1b.sb === 25 && h1b.bb === 50, `${h1b.sb}/${h1b.bb}`);

  // 그 핸드를 끝내면 다음 핸드에서 오른다
  let guard = 0;
  while (guard++ < 300) {
    const h = HD.getCurrentHand(tb2.id)!;
    if (h.ended_at != null) break;
    expireAction(); HD.advanceHoldem();
  }
  expireNextHand();
  HD.advanceHoldem();
  const h2 = HD.getCurrentHand(tb2.id)!;
  ck('다음 핸드에서 레벨이 오른다', h2.hand_no > h1.hand_no && h2.level === 4,
    `핸드 ${h2.hand_no} 레벨 ${h2.level} (기대 4)`);
  ck('오른 블라인드가 반영됨 (레벨 4 = 100/200)', h2.sb === 100 && h2.bb === 200, `${h2.sb}/${h2.bb}`);
}

/* ── 자정을 넘겨도 진행 중인 판을 계속 쓴다 ────────────────────────
   22:00에 시작한 판이 자정을 넘기면(레이트 레그가 붙거나 판이 길어지면 실제로 넘어간다)
   "오늘 판"이 새로 생기면서 진행 중이던 테이블이 화면에서 사라진다 — 플레이 중에
   로비로 튕긴다. 실제로 자정을 넘기며 이 일이 일어나는 것을 보고 넣은 검사다.

   "인원 미달 취소"와는 다른 상황이다. 3명이 안 차서 시작조차 못 한 판은 22:20에
   CANCELLED로 끝난다([11]에서 검증). 여기서 보는 건 이미 시작해 카드까지 돌린 판이며,
   그 판은 다음 판 등록이 열리는 순간에만 버려진다. */
console.log('\n[6b] 자정을 넘겨도 진행 중인 판이 유지된다');
{
  for (const tb of ['holdem_hand_seats', 'holdem_hands', 'holdem_seats',
    'holdem_tables', 'holdem_entries', 'holdem_tournaments']) db.prepare(`DELETE FROM ${tb}`).run();
  HD.advanceHoldem();
  setWindow(-60, 600, 1800);
  for (let i = 0; i < 3; i++) { mkUser('m' + i); HD.registerHoldem('m' + i, 'm' + i); }
  db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(nowSec() - 1);
  const live = HD.advanceHoldem();
  ck('판이 시작됐다', live.status === 'RUNNING', live.status);
  const runningId = live.tournament.id;

  // 날짜만 옛날로 돌린다 = 자정을 넘긴 상황
  db.prepare(`UPDATE holdem_tournaments SET date_str = '2000-01-01' WHERE id = ?`).run(runningId);
  /* 오늘 판 행이 생기되, 등록은 아직 열리지 않은 상태로 둔다.
     이 setup 호출 자체가 "오늘 등록이 열렸다"고 판단해 어제 판을 취소해 버릴 수 있다 —
     실제 시각이 이미 21시를 넘겼으면 오늘 판의 reg_open_at이 과거이기 때문이다.
     그래서 행을 만든 뒤 창을 미래로 밀고, setup이 남긴 취소도 되돌린다.
     이걸 안 하면 검사가 실행 시각에 따라 통과·실패가 갈린다(실제로 21시 이후 실패했다). */
  const after = HD.advanceHoldem();
  db.prepare(`UPDATE holdem_tournaments SET reg_open_at = ? WHERE id <> ?`)
    .run(nowSec() + 3600, runningId);
  db.prepare(`UPDATE holdem_tournaments SET cancelled_at = NULL WHERE id = ?`).run(runningId);
  const kept = HD.advanceHoldem();
  ck('날짜가 바뀌어도 같은 판을 계속 본다',
    kept.tournament.id === runningId && kept.status === 'RUNNING',
    `id ${kept.tournament.id} (기대 ${runningId}) · ${kept.status}`);
  void after;

  // 오늘 등록이 열리는 순간 어제 판은 버려진다
  db.prepare(`UPDATE holdem_tournaments SET reg_open_at = ? WHERE id <> ?`)
    .run(nowSec() - 60, runningId);
  const fresh = HD.advanceHoldem();
  ck('오늘 등록이 열리면 어제 판은 버려지고 오늘 판으로 넘어간다',
    fresh.tournament.id !== runningId, `id ${fresh.tournament.id}`);
  ck('버려진 판에 취소가 기록됐다',
    (db.prepare(`SELECT cancelled_at FROM holdem_tournaments WHERE id = ?`)
      .get(runningId) as { cancelled_at: number | null }).cancelled_at != null);
  ck('오늘 판은 등록을 받을 수 있는 상태',
    fresh.status === 'REGISTRATION_OPEN' || fresh.status === 'WAITING_MIN_PLAYERS'
    || fresh.status === 'CANCELLED', fresh.status);
}

console.log('\n[7] 부팅 시 진행 중 토너먼트 취소');
{
  db.prepare(`DELETE FROM holdem_tournaments`).run();
  db.prepare(`DELETE FROM holdem_tables`).run();
  db.prepare(`DELETE FROM holdem_seats`).run();
  HD.advanceHoldem();
  // 진행 중(started_at 있고 취소·종료 아님) 상태를 만들어야 부팅 취소가 걸린다
  setWindow(-3600, -60, 1800);
  db.prepare(`UPDATE holdem_tournaments SET started_at = ?`).run(nowSec());
  const n = HD.cancelRunningHoldemOnBoot();
  ck('진행 중 토너먼트가 취소됐다', n === 1, String(n));
  ck('취소 상태가 유지된다', HD.advanceHoldem().status === 'CANCELLED');
}

console.log('\n[8] 무작위 토너먼트 반복 (칩 보존 · 순위 · 상금)');
{
  function wipe(): void {
    for (const t of ['holdem_hand_seats', 'holdem_hands', 'holdem_seats',
      'holdem_tables', 'holdem_entries', 'holdem_tournaments']) {
      db.prepare(`DELETE FROM ${t}`).run();
    }
  }
  const rnd = (n: number) => Math.floor(Math.random() * n);
  let runs = 0, finished = 0;
  let chipBad = 0, placeBad = 0, prizeBad = 0, ledgerBad = 0, potBad = 0, stuck = 0;
  let sidePotHands = 0, lateRegs = 0;

  for (let iter = 0; iter < 150; iter++) {
    wipe();
    const n = 3 + rnd(7);           // 3~9명
    const users: string[] = [];
    for (let i = 0; i < n; i++) { const u = `f${iter}_${i}`; mkUser(u); users.push(u); }

    HD.advanceHoldem();
    setWindow(-60, 600, 1800);
    // 일부는 나중에 늦은 등록으로 들어온다
    const upfront = Math.max(T.MIN_PLAYERS, n - rnd(3));
    for (let i = 0; i < upfront; i++) HD.registerHoldem(users[i], users[i]);
    db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(nowSec() - 1);
    let s = HD.advanceHoldem();
    if (s.status !== 'RUNNING') continue;
    runs++;
    const tb = HD.getTable(s.tournament.id)!;
    let late = upfront;

    let steps = 0;
    while (steps++ < 4000) {
      s = HD.advanceHoldem();
      if (s.status === 'FINISHED') break;
      const h = HD.getCurrentHand(tb.id);
      if (!h) break;

      if (h.ended_at != null) {
        // 칩 총량 = 시작 스택 × (지금까지 등록한 사람 수)
        const entries = HD.getEntries(s.tournament.id).length;
        if (totalChips(tb.id) !== T.STARTING_STACK * entries) chipBad++;
        const res = JSON.parse(h.result_json!);
        const ps = (res.pots as { amount: number }[]).reduce((a, p) => a + p.amount, 0);
        const aw = (res.awards as { amount: number }[]).reduce((a, x) => a + x.amount, 0);
        if (ps !== aw) potBad++;
        if ((res.pots as unknown[]).length > 1) sidePotHands++;
        // 늦은 등록 시도
        if (late < n && rnd(3) === 0) {
          const r = HD.registerHoldem(users[late], users[late]);
          if (r.ok) { lateRegs++; late++; }
        }
        db.prepare(`UPDATE holdem_tournaments SET started_at = started_at - ?`)
          .run(T.LEVEL_DURATION_SEC);
        expireNextHand();
        continue;
      }

      if (h.to_act_seat == null) { expireAction(); continue; }
      const seat = HD.getSeats(tb.id).find(x => x.seat === h.to_act_seat && x.presence !== 'OUT');
      if (!seat) { expireAction(); continue; }
      // 무작위 액션 — 폴드/체크/콜/올인을 섞어 사이드 팟이 겹치게 만든다
      const pick = rnd(10);
      const kind: G.ActionKind = pick < 2 ? 'fold' : pick < 5 ? 'check' : pick < 8 ? 'call' : 'allin';
      const r = HD.holdemAction(seat.user_id, kind, 0);
      if (!r.ok) {
        const r2 = HD.holdemAction(seat.user_id, 'call', 0);
        if (!r2.ok) {
          const r3 = HD.holdemAction(seat.user_id, 'check', 0);
          if (!r3.ok) expireAction();
        }
      }
    }

    const fin = HD.advanceHoldem();
    if (fin.status !== 'FINISHED') { stuck++; continue; }
    finished++;

    const entries = HD.getEntries(fin.tournament.id);
    const places = entries.map(e => e.finish_place).sort((a, b) => (a ?? 0) - (b ?? 0));
    if (places.some(p => p == null)
      || places.join() !== Array.from({ length: entries.length }, (_, i) => i + 1).join()) placeBad++;
    const pool = T.prizePool(entries.length, fin.tournament.prize_multiplier);
    if (entries.reduce((a, e) => a + e.prize, 0) !== pool) prizeBad++;
    for (const e of entries) {
      const bal = Q.getWebUser(e.user_id)!.balance;
      const sum = (db.prepare(`SELECT COALESCE(SUM(delta),0) AS s FROM points_ledger WHERE user_id = ?`)
        .get(e.user_id) as { s: number }).s;
      if (bal !== sum) ledgerBad++;
    }
  }

  console.log(`    토너먼트 ${runs}회 시작 · ${finished}회 종료 · 사이드 팟 발생 ${sidePotHands}판 · 늦은 등록 ${lateRegs}건`);
  ck('전부 종료됐다 (멈춘 판 없음)', stuck === 0, `${stuck}회 멈춤`);
  ck('칩 총량 = 10,000 × 등록자 수 (매 판)', chipBad === 0, `${chipBad}회 어긋남`);
  ck('팟 합계 = 분배 합계 (매 판)', potBad === 0, `${potBad}회`);
  ck('순위가 1..N 로 빠짐없이 채워졌다', placeBad === 0, `${placeBad}회`);
  ck('지급 합계 = 상금 풀', prizeBad === 0, `${prizeBad}회`);
  ck('잔액 = 원장 누적합', ledgerBad === 0, `${ledgerBad}건`);
  ck('사이드 팟이 실제로 발생했다 (검증이 헛돌지 않았다)', sidePotHands > 0, String(sidePotHands));
  ck('늦은 등록이 실제로 수락됐다', lateRegs > 0, String(lateRegs));
}

console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
try { rmSync(process.env.DB_PATH!, { recursive: true, force: true }); } catch { /* OS가 정리 */ }
process.exit(fail ? 1 : 0);
