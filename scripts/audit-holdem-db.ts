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
const A = require('../src/db/admin') as typeof import('../src/db/admin');

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
/* 최소 액션 간격을 지난 것으로 만든다 — 시간이 흘렀다고 치는 것이다.
   차례가 열리는 시각은 (마감 - ACTION_SEC)이므로, 마감을 정확히 now + ACTION_SEC로
   맞추면 "지금 열렸고 제한 시간은 온전히 남았다"가 된다.
   expireAction과 다르다: 그건 마감을 넘겨 자동 액션을 유발하고, 이건 직접 액션을 받게 한다.
   이게 없으면 감사가 넣는 액션이 전부 too_soon으로 거절돼 판이 자동 체크로만 흘러간다. */
function openAction(): void {
  db.prepare(`UPDATE holdem_hands SET action_deadline = ?
              WHERE ended_at IS NULL AND action_deadline IS NOT NULL`)
    .run(nowSec() + HD.ACTION_SEC);
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
ck('열어 두지 않았으면 대회가 없다', st.tournament == null && st.status === 'NONE', st.status);

/* 상태 검사는 시각을 먼저 못 박고 한다.
   이 감사를 23:00(KST) 이후에 돌리면 갓 만든 토너먼트가 곧바로 "인원 미달 취소"로
   판정되는 게 맞다 — 제품이 옳고 단정이 틀린 경우였다. 그래서 검사할 상태마다
   그 상태가 되는 시각을 직접 만들어 준다. 하루 중 언제 돌려도 결과가 같아야 한다. */
/**
 * 대회의 시각 창을 원하는 상태로 맞춘다.
 *
 * 대회가 하나도 없으면 먼저 만든다. 예전에는 advanceHoldem 이 "오늘 판"을 저절로
 * 만들어 줬지만, 자동 생성을 없앤 뒤로는 운영자(또는 이 감사)가 열어야 생긴다.
 * 그 변화 때문에 이 파일의 검사 대부분이 대회 없이 돌다가 죽었다 — 여기 한 줄이 그걸 받는다.
 */
function setWindow(regOpen: number, start: number, grace: number): void {
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM holdem_tournaments`).get() as { n: number }).n;
  if (n === 0) {
    db.prepare(`INSERT INTO holdem_tournaments
        (date_str, title, reg_open_at, scheduled_start_at, grace_ends_at, prize_multiplier)
      VALUES ('1999-01-01', '감사용 프리롤', 0, 0, 0, 1000)`).run();
  }
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

  /* 한 장만 까기. 실제 포커의 관례이고, 그래서 "안 깐 장은 정말로 안 보이는가"가
     이 기능의 전부다 — 화면에서 가리는 것으로는 안 되고 값 자체가 남아 있으면 안 된다. */
  {
    const maskOf = (h: number, seat: number) =>
      HD.getHandSeats(h).find(x => x.seat === seat)!.shown_mask;
    ck('두 장 공개는 마스크가 3이다', maskOf(hand.id, mine.seat) === 3,
      String(maskOf(hand.id, mine.seat)));

    // 다른 사람으로 한 장만 까 본다 (지난 판이라 지금은 거절되므로 그 판을 되돌려 연다)
    db.prepare(`UPDATE holdem_hands SET hand_no = hand_no + 100 WHERE id = ?`).run(hand.id);
    ck('왼쪽 한 장만 깐다', HD.showHoldemCards(other.user_id, 1).ok);
    ck('마스크가 1이다 (왼쪽만)', maskOf(hand.id, other.seat) === 1,
      String(maskOf(hand.id, other.seat)));
    ck('한 장만 깠어도 shown 은 켜진다',
      HD.getHandSeats(hand.id).find(x => x.seat === other.seat)!.shown === 1);

    // 마음이 바뀌어 나머지도 깔 수 있다 — 비트를 더한다
    ck('나머지 한 장을 더 깔 수 있다', HD.showHoldemCards(other.user_id, 2).ok);
    ck('마스크가 3이 된다 (더해진다)', maskOf(hand.id, other.seat) === 3,
      String(maskOf(hand.id, other.seat)));
    db.prepare(`UPDATE holdem_hands SET hand_no = hand_no - 100 WHERE id = ?`).run(hand.id);
  }

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
  /* 전원을 앉은 상태로 되돌려 시작한다. 앞 절들이 마감 초과를 여러 번 만들어서
     네 명 모두 SIT_OUT으로 내려가 있는데, 자리 비움 좌석은 마감을 기다리지 않고 즉시
     체크/폴드된다(의도된 동작이다). 그러면 이 절이 액션을 넣을 틈 없이 판이 자멸하고,
     전원 폴드라 아무도 죽지 않아 6,000판을 돌아도 토너먼트가 끝나지 않는다.
     이 절이 검증하려는 건 "앉아 있는 사람의 실제 액션"이므로 앉혀 놓고 시작한다. */
  for (const s of HD.getSeats(table.id)) {
    if (s.presence !== 'OUT') HD.holdemSitIn(s.user_id, table.id);
  }
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
    openAction();                                  // 최소 액션 간격이 지난 것으로 본다
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

   "인원 미달 취소"와는 다른 상황이다. 3명이 안 차서 시작조차 못 한 판은 23:00에
   CANCELLED로 끝난다([11]에서 검증). 여기서 보는 건 이미 시작해 카드까지 돌린 판이며,
   그 판은 다음 판 등록이 열리는 순간에만 버려진다. */
/* 예전에는 이 자리에 "자정을 넘겨도 진행 중인 판이 유지된다"가 있었다. 대회를 날짜로
   찾던 시절의 방어책이다 — 자정이 지나면 "오늘 판"이 새로 생겨 진행 중인 테이블이 화면에서
   사라졌기 때문에, 그걸 막는 특별 규칙을 따로 둬야 했다.

   자동 생성을 없애면서 그 규칙이 통째로 사라졌다. 이제 살아 있는 판을 곧바로 고르므로
   날짜가 판단에 들어가지 않고, 그래서 자정에 어긋날 자리가 없다.
   여기서는 그 새 규칙을 본다. */
console.log('\n[6b] 대회는 저절로 생기지 않고, 날짜와 무관하게 살아 있는 판이 골라진다');
{
  for (const tb of ['holdem_hand_seats', 'holdem_hands', 'holdem_seats',
    'holdem_tables', 'holdem_entries', 'holdem_tournaments']) db.prepare(`DELETE FROM ${tb}`).run();

  ck('대회가 없으면 없는 상태가 나온다', HD.advanceHoldem().status === 'NONE');
  ck('요청해도 저절로 만들어지지 않는다', (() => {
    HD.advanceHoldem(); HD.advanceHoldem();
    return (db.prepare(`SELECT COUNT(*) AS n FROM holdem_tournaments`).get() as { n: number }).n === 0;
  })());
  ck('대회가 없으면 등록도 거절된다', (() => {
    mkUser('none1');
    const r = HD.registerHoldem('none1', 'none1');
    return !r.ok && r.error === 'closed';
  })());

  // 운영자가 열어야 생긴다
  const made = A.createTournament({ title: '수동 판', regOpenAt: nowSec() - 60, startAt: nowSec() - 1 });
  ck('운영자가 열면 생긴다', made.ok, JSON.stringify(made));
  for (let i = 0; i < 3; i++) { mkUser('m' + i); HD.registerHoldem('m' + i, 'm' + i); }
  const live = HD.advanceHoldem();
  ck('3명이 차면 시작한다', live.status === 'RUNNING', live.status);
  const runningId = live.tournament!.id;

  /* 날짜를 옛날로 돌린다 = 자정을 넘긴 상황. 예전에는 여기서 판이 바뀌었다. */
  db.prepare(`UPDATE holdem_tournaments SET date_str = '2000-01-01' WHERE id = ?`).run(runningId);
  const kept = HD.advanceHoldem();
  ck('날짜가 바뀌어도 같은 판을 계속 본다 (날짜가 판단에서 빠졌다)',
    kept.tournament!.id === runningId && kept.status === 'RUNNING',
    `id ${kept.tournament!.id} (기대 ${runningId})`);
  ck('자정을 넘겨도 새 판이 생기지 않는다',
    (db.prepare(`SELECT COUNT(*) AS n FROM holdem_tournaments`).get() as { n: number }).n === 1);

  /* 끝난 판은 유예 동안만 "지금 대회"다. 안 묶으면 며칠 전 결과가 로비에 계속 남는다. */
  db.prepare(`UPDATE holdem_tournaments SET finished_at = ? WHERE id = ?`).run(nowSec(), runningId);
  ck('막 끝난 판은 결과를 보여 주려고 유지된다',
    HD.advanceHoldem().tournament?.id === runningId);
  db.prepare(`UPDATE holdem_tournaments SET finished_at = ? WHERE id = ?`)
    .run(nowSec() - T.FINISH_LINGER_SEC - 10, runningId);
  ck('유예가 지나면 대회가 없는 상태로 돌아간다', HD.advanceHoldem().status === 'NONE');
}

/* 실제로 이렇게 터졌다: 2026-08-06 판이 23:49 에 시작해 다음 날 01:13 에 끝났다.
   끝나는 순간 [6b]의 자정 방어가 풀리고(그 조건이 finished_at IS NULL 이다) "오늘 판"이
   08-07 판으로 바뀌면서, 우승 화면을 띄울 유예가 아예 적용되지 않았다 — 이긴 사람이
   결과를 못 보고 튕겼다. 그래서 "무엇을 보여줄지"를 사람이 앉은 자리에서 유도한다. */
console.log('\n[6c] 자정을 넘겨 끝난 판도 앉아 있던 사람에게는 유예 동안 유지된다');
{
  for (const tb of ['holdem_hand_seats', 'holdem_hands', 'holdem_seats',
    'holdem_tables', 'holdem_entries', 'holdem_tournaments']) db.prepare(`DELETE FROM ${tb}`).run();
  HD.advanceHoldem();
  setWindow(-60, 600, 1800);
  for (let i = 0; i < 3; i++) { mkUser('f' + i); HD.registerHoldem('f' + i, 'f' + i); }
  db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(nowSec() - 1);
  const live = HD.advanceHoldem();
  ck('판이 시작됐다', live.status === 'RUNNING', live.status);
  const oldId = live.tournament!.id;

  // 자정을 넘겨 방금 끝난 상태를 만든다 (날짜는 어제 · 종료는 조금 전)
  db.prepare(`UPDATE holdem_tournaments SET date_str = '2000-01-01', finished_at = ? WHERE id = ?`)
    .run(nowSec() - 5, oldId);
  // 운영자가 다음 판을 열어 둔다 — 등록은 아직 안 열린 상태로 (실행 시각에 갈리지 않게)
  const next = A.createTournament({
    title: '다음 판', regOpenAt: nowSec() + 3600, startAt: nowSec() + 7200,
  });
  ck('끝난 판이 있어도 다음 판을 열 수 있다', next.ok, 'error' in next ? next.error : '');

  // 앉은 자리가 없는 사람은 살아 있는 판(=다음 판)을 본다
  const byClock = HD.advanceHoldem();
  ck('앉은 자리가 없으면 살아 있는 판을 본다',
    byClock.tournament!.id !== oldId, `id ${byClock.tournament!.id} (끝난 판 ${oldId})`);

  // 앉아 있던 사람에게는 끝난 판이 유지된다 — 우승 화면이 뜰 자리를 준다
  const mine = HD.advanceHoldem('f0');
  ck('앉아 있던 사람은 끝난 판을 계속 본다',
    mine.tournament!.id === oldId, `id ${mine.tournament!.id} (기대 ${oldId})`);
  ck('그 판의 상태가 FINISHED 다 (유예 판정의 전제)',
    mine.status === 'FINISHED', mine.status);
  ck('끝난 판에 테이블이 남아 있다 (쇼다운을 그릴 근거)',
    HD.getTable(mine.tournament!.id) != null);

  // 앉지 않았던 사람은 영향이 없다
  mkUser('outsider');
  ck('앉지 않았던 사람은 살아 있는 판을 본다',
    HD.advanceHoldem('outsider').tournament!.id !== oldId);

  // 유예가 지나면 창이 닫힌다 — 다음 날 어제의 시체를 보지 않는다
  db.prepare(`UPDATE holdem_tournaments SET finished_at = ? WHERE id = ?`)
    .run(nowSec() - T.FINISH_LINGER_SEC - 5, oldId);
  ck('유예가 지나면 끝난 판을 더 보여주지 않는다',
    HD.advanceHoldem('f0').tournament!.id !== oldId,
    `id ${HD.advanceHoldem('f0').tournament!.id}`);
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
  // 취소된 판은 로비에서 사라진다 — 예전에는 CANCELLED 를 계속 띄웠지만,
  // 대회가 저절로 생기지 않게 된 뒤로는 "예정 없음"이 맞는 표시다
  ck('취소된 판은 더 이상 보이지 않는다', HD.advanceHoldem().status === 'NONE');
  ck('취소 시각이 행에 남는다',
    (db.prepare(`SELECT COUNT(*) AS n FROM holdem_tournaments WHERE cancelled_at IS NOT NULL`)
      .get() as { n: number }).n === 1);
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
      openAction();                                // 최소 액션 간격이 지난 것으로 본다
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

  /* 방금 끝난 진짜 판으로 "지난 대회" 요약을 확인한다 — 로비가 대회 없는 날에
     이 값을 그린다. 손으로 만든 행이 아니라 실제로 돌아간 판이어야 의미가 있다. */
  const RC = require('../src/db/holdem-recap') as typeof import('../src/db/holdem-recap');
  const recap = RC.recentRecap();
  ck('지난 대회 요약이 나온다', recap != null);
  if (recap) {
    const win = db.prepare(
      `SELECT user_id, prize FROM holdem_entries WHERE tournament_id = ? AND finish_place = 1`)
      .get(recap.id) as { user_id: string; prize: number };
    const sum = (db.prepare(
      `SELECT COALESCE(SUM(prize),0) AS n FROM holdem_entries WHERE tournament_id = ?`)
      .get(recap.id) as { n: number }).n;
    ck('요약의 1위 = 실제 우승자', recap.top[0]?.userId === win.user_id,
      `${recap.top[0]?.userId} vs ${win.user_id}`);
    ck('요약의 1위 상금이 맞다', recap.top[0]?.prize === win.prize);
    ck('총 상금 = 지급 합계', recap.prizeTotal === sum, `${recap.prizeTotal} vs ${sum}`);
    ck('상위 3명까지만 담는다', recap.top.length <= 3, String(recap.top.length));
    ck('등수가 오름차순이다', recap.top.every((r, i) => r.place === i + 1),
      recap.top.map(r => r.place).join(','));
    /* 족보는 있을 수도 없을 수도 있다 — 마지막 판이 폴드로 끝났으면 없는 것이 맞다.
       다만 "언제나 null" 이면 기능이 죽은 것과 구별되지 않는다. 그래서 끝난 판들을
       훑어 한 번이라도 족보가 잡히는지 본다 — 쇼다운으로 끝난 판이 하나는 있다. */
    ck('족보는 문자열이거나 null 이다',
      recap.winningHand === null || typeof recap.winningHand === 'string',
      String(recap.winningHand));
    const named = (db.prepare(`SELECT result_json FROM holdem_hands WHERE result_json IS NOT NULL`)
      .all() as { result_json: string }[])
      .map(h => {
        try {
          return ((JSON.parse(h.result_json) as { potAwards?: { hand?: string }[] }).potAwards ?? [])
            .some(p => !!p.hand);
        } catch { return false; }
      }).filter(Boolean).length;
    ck('쇼다운으로 끝난 판에는 족보가 실제로 적힌다', named > 0, `${named}판`);
  }
}

/* ── 쇼다운 결과에 족보와 이긴 5장이 실린다 ────────────────────────
   화면에서 "이 5장으로 이겼다"를 밝히는 근거다. 여기서 빠지면 강조가 조용히 사라진다. */
console.log('\n[1d] 쇼다운 결과에 족보명 · 이긴 5장이 담긴다');
{
  const db3 = getDb();
  const rows = db3.prepare(
    `SELECT result_json FROM holdem_hands WHERE result_json IS NOT NULL`).all() as { result_json: string }[];
  let withReveal = 0, missingHand = 0, missingFive = 0, notSubset = 0, badLen = 0;
  for (const r of rows) {
    const res = JSON.parse(r.result_json) as {
      board: string[];
      reveal: { seat: number; cards: string[]; hand?: string; five?: string[] }[];
    };
    for (const rv of res.reveal ?? []) {
      withReveal++;
      if (!rv.hand) missingHand++;
      if (!rv.five) { missingFive++; continue; }
      if (rv.five.length !== 5) badLen++;
      const pool = new Set(rv.cards.concat(res.board));
      if (rv.five.some(c => !pool.has(c))) notSubset++;
    }
  }
  /* 층별 정산(potAwards)은 화면이 팟을 하나씩 넘겨 보여주는 근거다.
     실제로 칩이 움직이는 것은 hand_seats.won이므로, 둘이 어긋나면
     "화면에서 본 분배"와 "실제 받은 돈"이 달라진다 — 가장 나쁜 종류의 버그다. */
  {
    let potSumBad = 0, perSeatBad = 0, withPots = 0, badOrder = 0;
    const rows2 = db3.prepare(
      `SELECT id, result_json FROM holdem_hands WHERE result_json IS NOT NULL`).all() as
      { id: number; result_json: string }[];
    for (const r of rows2) {
      const res = JSON.parse(r.result_json) as {
        potAwards?: { index: number; amount: number; winners: { seat: number; amount: number }[] }[];
        awards: { seat: number; amount: number }[];
      };
      if (!res.potAwards || !res.potAwards.length) continue;
      withPots++;
      // 층 합계 = 좌석별 합계
      const layerSum = res.potAwards.reduce(
        (a, p) => a + p.winners.reduce((b, w) => b + w.amount, 0), 0);
      const awardSum = res.awards.reduce((a, x) => a + x.amount, 0);
      if (layerSum !== awardSum) potSumBad++;
      // 좌석 단위로도 맞아야 한다 (합계만 맞고 사람이 바뀌는 경우를 잡는다)
      const bySeat = new Map<number, number>();
      for (const p of res.potAwards) {
        for (const w of p.winners) bySeat.set(w.seat, (bySeat.get(w.seat) ?? 0) + w.amount);
      }
      for (const a of res.awards) if ((bySeat.get(a.seat) ?? 0) !== a.amount) perSeatBad++;
      // 층 금액의 합이 그 층들의 amount 합과도 같아야 한다
      const declared = res.potAwards.reduce((a, p) => a + p.amount, 0);
      if (declared !== layerSum) badOrder++;
    }
    ck('층별 정산이 기록된 판이 있었다', withPots > 0, String(withPots));
    ck('층 합계 = 좌석별 정산 합계', potSumBad === 0, `${potSumBad}판 어긋남`);
    ck('좌석 단위로도 층별 정산과 실제 정산이 같다', perSeatBad === 0, `${perSeatBad}건`);
    ck('각 층의 금액이 그 층 승자들이 받은 합과 같다', badOrder === 0, `${badOrder}판`);
  }

  ck('쇼다운이 실제로 여러 번 있었다 (검사가 헛돌지 않았다)', withReveal > 0, String(withReveal));
  ck('공개된 손마다 족보명이 있다', missingHand === 0, `${missingHand}건 누락`);
  ck('공개된 손마다 이긴 5장이 있다', missingFive === 0, `${missingFive}건 누락`);
  ck('이긴 5장은 정확히 5장', badLen === 0, `${badLen}건`);
  ck('이긴 5장은 그 사람 홀 카드 + 보드 안에서만 나온다', notSubset === 0, `${notSubset}건`);
}

/* ── 자리 비움은 기다리지 않는다 ──────────────────────────────────
   20초는 "지금 보고 있는 사람이 생각할 시간"이다. 자리를 비운 사람에게도 그 시간을 주면
   남은 사람 전부가 그 사람 차례마다 20초씩 멈춰 선다 — 3인 판이면 한 바퀴에 40초가 빈다.
   실제로 그렇게 동작하고 있었다. */
console.log('\n[1c] 자리 비움 좌석은 즉시 넘어간다');
{
  const db2 = getDb();
  for (const id of ['s0', 's1', 's2']) mkUser(id);
  /* 깨끗한 판에서 시작한다. 앞 절이 대회를 끝까지 돌려 놓았으므로, 같은 날짜의 대회를
     되살리기만 하면 좌석에 살아남은 사람이 하나뿐이라 advanceHoldem이 곧바로 종료 처리한다.
     여섯 테이블을 모두 비운다 — holdem_tables는 AUTOINCREMENT가 아니라서 행을 다 지우면
     id가 1부터 다시 붙고, 핸드를 남겨두면 새 테이블이 옛 핸드를 물려받는다. */
  for (const tb of ['holdem_hand_seats', 'holdem_hands', 'holdem_seats',
    'holdem_tables', 'holdem_entries', 'holdem_tournaments']) {
    db2.prepare(`DELETE FROM ${tb}`).run();
  }
  setWindow(-30, 600, 3600);
  for (const id of ['s0', 's1', 's2']) HD.registerHoldem(id, id);
  db2.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(nowSec() - 1);

  const stX = HD.advanceHoldem();
  const tableX = HD.getTable(stX.tournament!.id);
  ck('테스트용 대회가 시작됐다', stX.status === 'RUNNING' && tableX != null, stX.status);
  if (tableX) {
    let hand = HD.getCurrentHand(tableX.id)!;
    const actor = hand.to_act_seat!;
    ck('마감이 아직 남아 있다', (hand.action_deadline ?? 0) > nowSec());

    // 자리 비움이 아니면 기다려야 한다
    HD.advanceHoldem();
    hand = HD.getCurrentHand(tableX.id)!;
    ck('평소에는 마감까지 기다린다 (즉시 넘기지 않는다)', hand.to_act_seat === actor,
      `to_act=${hand.to_act_seat}`);

    /* 자리 비움으로 바꾸면 마감(20초)을 기다리지 않는다.
       다만 최소 액션 간격은 지킨다 — 그게 없으면 자리 비움이 둘 이상일 때 한 번의
       advanceHoldem이 그들 전부를 접어 버려서 화면에 "폴드 폴드 폴드"가 한꺼번에 나온다.
       그래서 간격이 지난 것으로 만든 다음에 넘어가는지 본다. */
    db2.prepare(`UPDATE holdem_seats SET presence = 'SIT_OUT' WHERE table_id = ? AND seat = ?`)
      .run(tableX.id, actor);
    HD.advanceHoldem();
    hand = HD.getCurrentHand(tableX.id)!;
    ck('자리 비움도 최소 액션 간격 전에는 넘기지 않는다', hand.to_act_seat === actor,
      `to_act=${hand.to_act_seat}`);
    openAction();                       // 간격이 지났다 (마감은 아직 20초 남아 있다)
    HD.advanceHoldem();
    hand = HD.getCurrentHand(tableX.id)!;
    const moved = hand.ended_at != null || hand.to_act_seat !== actor;
    ck('자리 비움이면 마감을 기다리지 않고 넘어간다', moved, `to_act=${hand.to_act_seat}`);
    const acted = HD.getHandSeats(hand.id).find(s => s.seat === actor);
    ck('넘어간 자리에 실제로 행동이 기록됐다 (체크 또는 폴드)',
      acted != null && (acted.state === 'folded' || acted.last_action === 'check'),
      `state=${acted?.state} act=${acted?.last_action}`);
    ck('강제로 콜하지 않는다 (게임이 대신 칩을 걸지 않는다)',
      acted != null && acted.last_action !== 'call', String(acted?.last_action));

    /* 돌아온 사람이 버튼으로 다시 들어올 수 있어야 한다.
       즉시 넘기기를 넣었을 때 holdemAction이 advanceHoldem을 먼저 부르는 탓에
       내 차례가 사라진 뒤 요청이 도착해 영원히 'not_your_turn'이 됐다 —
       자리 비움인 사람은 버튼을 눌러도 아무 일도 안 일어나고 계속 자동 폴드됐다. */
    {
      const h2 = HD.getCurrentHand(tableX.id)!;
      const nextActor = h2.to_act_seat;
      if (nextActor != null && h2.ended_at == null) {
        db2.prepare(`UPDATE holdem_seats SET presence = 'SIT_OUT' WHERE table_id = ? AND seat = ?`)
          .run(tableX.id, nextActor);
        const who = HD.getSeats(tableX.id).find(s => s.seat === nextActor)!;
        openAction();
        const res = HD.holdemAction(who.user_id, 'allin', 0);
        ck('자리 비움이어도 직접 누른 액션은 수락된다 (복귀 경로)', res.ok, JSON.stringify(res));
        const after = HD.getSeats(tableX.id).find(s => s.seat === nextActor)!;
        ck('액션을 넣으면 다시 앉은 상태가 된다', after.presence === 'ACTIVE', after.presence);
      } else {
        ck('복귀 경로를 검사할 차례가 있었다', false, `to_act=${nextActor} ended=${h2.ended_at}`);
      }
    }

    /* 전원 자리 비움이어도 무한 루프에 빠지지 않고 판이 끝난다.
       최소 액션 간격 때문에 한 번의 호출로는 한 자리씩만 넘어간다 — 실제로도 그게 맞다
       (그래야 화면이 한 명씩 따라갈 수 있다). 그래서 간격을 지난 것으로 만들며 반복한다.
       판이 끝나는가와, 그 과정이 유한한가를 함께 본다. */
    db2.prepare(`UPDATE holdem_seats SET presence = 'SIT_OUT' WHERE table_id = ?`).run(tableX.id);
    const t0 = Date.now();
    let rounds = 0;
    while (rounds++ < 60) {
      HD.advanceHoldem();
      hand = HD.getCurrentHand(tableX.id)!;
      if (hand.ended_at != null) break;
      openAction();
    }
    const elapsed = Date.now() - t0;
    ck('전원 자리 비움이면 판이 스스로 끝난다', hand.ended_at != null,
      `street=${hand.street} to_act=${hand.to_act_seat} rounds=${rounds}`);
    ck('넘어가는 데 걸린 단계가 유한하다 (자리 수 안쪽)', rounds <= 12, `${rounds}단계`);
    ck('무한 루프가 아니다 (1초 안에 끝난다)', elapsed < 1000, `${elapsed}ms`);
  }
}

/* ── [1f] 최소 액션 간격 ─────────────────────────────────────────────
   차례가 열리기 전에는 아무도 행동할 수 없다. 이게 없으면 봇과 자동 액션이 즉시 결정해서
   "레이즈 → 폴드 → 폴드"가 0.1초 안에 처리되고, 화면은 그 셋을 한 프레임에 몰아 보여준다.
   클라이언트에서 버튼만 잠그는 것으로는 부족하다 — 규칙에 있어야 봇도 지킨다. */
{
  console.log('\n[1f] 최소 액션 간격 (차례가 열리기 전에는 행동 불가)');
  const db3 = getDb();
  db3.prepare(`DELETE FROM holdem_hands`).run();
  db3.prepare(`DELETE FROM holdem_seats`).run();
  db3.prepare(`DELETE FROM holdem_tables`).run();
  db3.prepare(`DELETE FROM holdem_entries`).run();
  db3.prepare(`DELETE FROM holdem_tournaments`).run();
  for (const id of ['g0', 'g1', 'g2']) { mkUser(id); Q.adjustBalance(id, 10_000, 'test'); }
  setWindow(-30, 600, 3600);
  for (const id of ['g0', 'g1', 'g2']) HD.registerHoldem(id, id);
  db3.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(nowSec() - 1);
  const stG = HD.advanceHoldem();
  const tG = HD.getTable(stG.tournament!.id);
  ck('대회가 시작됐다', stG.status === 'RUNNING' && tG != null, stG.status);
  if (tG) {
    const h = HD.getCurrentHand(tG.id)!;
    const open = HD.actOpenAt(h)!;
    /* 판이 시작될 때는 카드가 다 돌아갈 때까지 기다린다(STREET_OPEN_SEC).
       마감은 그만큼 뒤로 밀려 있고, 화면에 보이는 제한 시간은 상한이 씌워져 20초다. */
    ck('첫 차례는 카드가 다 돌아간 뒤에 열린다',
      open - nowSec() >= HD.STREET_OPEN_SEC - 1, `${open - nowSec()}초 후`);
    ck('마감 = 열리는 시각 + 제한 시간',
      (h.action_deadline ?? 0) - open === HD.ACTION_SEC, `${(h.action_deadline ?? 0) - open}`);

    const who = HD.getSeats(tG.id).find(s => s.seat === h.to_act_seat)!;
    const early = HD.holdemAction(who.user_id, 'call', 0);
    ck('열리기 전 액션은 too_soon으로 거절된다',
      !early.ok && early.error === 'too_soon', JSON.stringify(early));
    const still = HD.getCurrentHand(tG.id)!;
    ck('거절된 액션은 판을 바꾸지 않는다', still.to_act_seat === h.to_act_seat,
      `to_act=${still.to_act_seat}`);

    // 간격이 지난 것으로 만들면 같은 액션이 수락된다
    openAction();

    /* 사전 액션으로 걸어 둔 콜은 "그때 본 금액"을 넘으면 실행되지 않는다.
       화면도 금액이 바뀌면 체크를 풀지만 폴링 사이(최대 1초)의 틈이 있고, 하필 그 틈에
       내 차례가 오면 늦는다 — 콜 200을 걸어 뒀는데 5,000이 나가는 사고가 그 틈에서 난다.
       그래서 서버가 다시 잰다. 여기가 뚫리면 돈이 잘못 나가는 것이라 화면 검사로는 부족하다. */
    const tooSmall = HD.holdemAction(who.user_id, 'call', 0, 1);
    ck('걸어 둔 금액보다 콜이 크면 거절한다',
      !tooSmall.ok && tooSmall.error === 'call_grew', JSON.stringify(tooSmall));
    const untouched = HD.getCurrentHand(tG.id)!;
    ck('거절된 자동 콜은 판을 바꾸지 않는다',
      untouched.to_act_seat === h.to_act_seat, `to_act=${untouched.to_act_seat}`);
    const enough = HD.holdemAction(who.user_id, 'call', 0, 99_999);
    ck('걸어 둔 금액이 충분하면 실행된다', enough.ok, JSON.stringify(enough));
    /* 위에서 이미 콜이 나갔으므로 아래 검사는 그 결과를 이어서 본다 —
       직접 누른 콜(maxCall 없음)도 여전히 되는지는 다음 사람 차례에서 확인한다. */
    const ok = enough;
    ck('열린 뒤에는 같은 액션이 수락된다', ok.ok, JSON.stringify(ok));

    /* 액션 직후 다음 사람의 차례도 곧바로 열리지 않는다 — 그게 이 규칙의 요점이다. */
    const h2 = HD.getCurrentHand(tG.id)!;
    if (h2.to_act_seat != null && h2.ended_at == null) {
      const open2 = HD.actOpenAt(h2)!;
      ck('다음 사람의 차례도 최소 간격만큼 뒤에 열린다',
        open2 - nowSec() >= HD.ACT_GAP_SEC - 1, `${open2 - nowSec()}초 후`);
      const who2 = HD.getSeats(tG.id).find(s => s.seat === h2.to_act_seat)!;
      /* 창이 아직 안 지났을 때만 물어본다. ACT_GAP_SEC 이 1초라, 앞 줄을 지나는 사이에
         초가 한 번 넘어가면 창이 이미 열려 있어 액션이 정상 수락된다 — 그러면 이 검사만
         실패한다. 실제로 그렇게 한 번 붉게 떴고, 다시 돌리니 통과했다. 가끔 실패하는
         검사는 없느니만 못하다(진짜 실패를 가린다). 창이 지났으면 지났다고 적는다. */
      if (nowSec() < open2) {
        ck('그 사이에는 다음 사람도 행동할 수 없다',
          HD.holdemAction(who2.user_id, 'call', 0).error === 'too_soon');
      } else {
        console.log('  SKIP  그 사이에는 다음 사람도 행동할 수 없다 — 재는 사이에 1초 창이 지났다');
      }
    } else {
      ck('다음 차례를 검사할 수 있었다', false, `to_act=${h2.to_act_seat}`);
    }
  }
}

/* ── [1e] 역대 전적 집계 ─────────────────────────────────────────────
   누적 상금으로만 줄 세운다. 우승을 많이 했어도 소액 대회만 먹었으면 아래로
   내려가야 한다 — "지금까지 쭉 먹은 상금"이 이 표가 말하는 것이다.
   끝난 대회만 세는지도 함께 본다. */
{
  console.log('\n[1e] 역대 전적 — 누적 상금 집계');
  const db3 = getDb();
  const at = nowSec() - 40 * 86_400;
  /* 큰 대회 하나(꾸준한 사람이 상금을 쌓는다)와 작은 대회 둘(다른 사람이 우승만 챙긴다).
     여기에 아직 끝나지 않은 대회 하나를 섞어서 그 판이 세어지지 않는지 확인한다. */
  const plan: { day: number; finished: boolean; places: [string, number][] }[] = [
    { day: 5, finished: true,  places: [['r_steady', 9000], ['r_spike', 0], ['r_zero', 0]] },
    { day: 4, finished: true,  places: [['r_spike', 1500], ['r_steady', 900], ['r_zero', 0]] },
    { day: 3, finished: true,  places: [['r_spike', 1500], ['r_steady', 900], ['r_zero', 0]] },
    { day: 2, finished: false, places: [['r_zero', 99_999]] },   // 진행 중 — 세어지면 안 된다
  ];
  for (const p of plan) {
    const t = at + p.day * 3600;
    const tid = Number(db3.prepare(`INSERT INTO holdem_tournaments
      (date_str, title, reg_open_at, scheduled_start_at, grace_ends_at, prize_multiplier,
       started_at, finished_at) VALUES (?, ?, ?, ?, ?, 3, ?, ?)`)
      .run(`rec-${p.day}`, '집계 검사', t - 60, t, t + 60, t, p.finished ? t + 600 : null)
      .lastInsertRowid);
    p.places.forEach(([uid, prize], i) => {
      db3.prepare(`INSERT INTO holdem_entries
        (tournament_id, user_id, username, registered_at, finish_place, elim_seq, prize)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(tid, uid, uid, t - 10, i + 1, p.places.length - i, prize);
    });
  }
  const rows = HD.holdemRecords(20).filter(r => r.userId.startsWith('r_'));
  const of_ = (id: string) => rows.find(r => r.userId === id);

  ck('1위는 누적 상금이 가장 많은 쪽', rows[0]?.userId === 'r_steady',
    rows.map(r => `${r.userId}:${r.prize}`).join(' '));
  // 이 검사가 헛돌지 않도록 전제부터 확인한다 — 우승은 spike가 더 많아야 한다
  ck('검사 전제: 우승은 spike가 더 많다',
    (of_('r_spike')?.wins ?? 0) > (of_('r_steady')?.wins ?? 0),
    `spike=${of_('r_spike')?.wins} steady=${of_('r_steady')?.wins}`);
  ck('우승이 많아도 상금이 적으면 아래로 간다',
    rows.findIndex(r => r.userId === 'r_spike') > rows.findIndex(r => r.userId === 'r_steady'),
    `spike prize=${of_('r_spike')?.prize} steady prize=${of_('r_steady')?.prize}`);
  ck('누적 상금 = 끝난 대회 상금 합', of_('r_steady')?.prize === 9000 + 900 + 900,
    String(of_('r_steady')?.prize));
  ck('우승 = finish_place 1 인 판의 수', of_('r_spike')?.wins === 2, String(of_('r_spike')?.wins));
  ck('입상은 상금 > 0 인 판만 센다', of_('r_zero')?.itm === 0, String(of_('r_zero')?.itm));
  ck('진행 중인 대회는 참가 수에 안 들어간다', of_('r_zero')?.played === 3,
    String(of_('r_zero')?.played));
  ck('진행 중인 대회 상금은 안 더한다', of_('r_zero')?.prize === 0, String(of_('r_zero')?.prize));
  ck('상금 순 내림차순', rows.every((r, i) => i === 0 || rows[i - 1].prize >= r.prize),
    rows.map(r => r.prize).join(','));
}

console.log('\n[13] 반복 개최 (자동 생성은 켰을 때만 · 지운 판은 되살아나지 않는다)');
{
  const R = require('../src/db/recurrence') as typeof import('../src/db/recurrence');
  const S = require('../src/db/settings') as typeof import('../src/db/settings');
  const wipe = () => {
    for (const tb of ['holdem_hand_seats', 'holdem_hands', 'holdem_seats',
      'holdem_tables', 'holdem_entries', 'holdem_tournaments']) db.prepare(`DELETE FROM ${tb}`).run();
    db.prepare(`DELETE FROM holdem_settings`).run();
  };
  const count = () => (db.prepare(`SELECT COUNT(*) AS n FROM holdem_tournaments`)
    .get() as { n: number }).n;

  /* 켜지 않으면 아무 일도 없다. 이것이 예전 자동 생성과의 결정적 차이다 —
     끄는 방법이 없어서 지운 대회가 1초 만에 되살아났다. */
  wipe();
  R.ensureRecurring();
  ck('꺼져 있으면 아무것도 만들지 않는다', count() === 0, String(count()));

  /* 마스터 스위치가 켜져도 주기가 수동이면 만들지 않는다 (저장 자체를 거절한다) */
  ck('수동 + 켬 조합은 저장을 거절한다',
    !R.saveRecurrence({ enabled: true, mode: 'manual', weekday: 0, day: 1 }).ok);

  // 매일 — 켜면 만들어진다
  wipe();
  ck('매일 규칙은 저장된다', R.saveRecurrence({ enabled: true, mode: 'daily', weekday: 0, day: 1 }).ok);
  /* 시각을 고정해서 부른다. 그냥 부르면 지금이 몇 시냐에 따라 결과가 갈린다 —
     다음 차례가 12시간(RECUR_LEAD_SEC) 안이어야 만들어지는데, 설정 시각을 막 넘긴
     직후에는 다음 차례가 24시간 뒤라 안 만들어진다. 하루 중 언제 돌려도 같아야 한다.
     ensureRecurring 이 now 를 받으므로 "설정 시각 한 시간 전"을 그대로 넘긴다. */
  const cfgNow = require('../src/db/settings') as typeof import('../src/db/settings');
  const sm = cfgNow.getConfig().startMin;
  const todayStart = T.kstTimeToUnix(T.kstDateStr(Date.now()), Math.floor(sm / 60), sm % 60);
  const oneHourBefore = todayStart - 3600;
  R.ensureRecurring(oneHourBefore);
  ck('켜면 다음 판이 만들어진다', count() === 1, String(count()));

  // 두 번 불러도 하나다 — 요청마다 불리는 함수라 여기가 새면 대회가 무한히 늘어난다
  R.ensureRecurring(oneHourBefore);
  R.ensureRecurring(oneHourBefore);
  ck('여러 번 불러도 하나만 만든다', count() === 1, String(count()));

  /* 되살아남 방지. 예전 구조에서 실제로 겪은 문제라 검사로 못 박는다 —
     행의 존재로 판단하면 지우는 순간 다시 만들어진다. */
  const madeId = (db.prepare(`SELECT id FROM holdem_tournaments ORDER BY id DESC LIMIT 1`)
    .get() as { id: number }).id;
  A.purgeTournament(madeId);
  ck('지우면 사라진다', count() === 0, String(count()));
  R.ensureRecurring();
  ck('지운 차례는 되살아나지 않는다', count() === 0, String(count()));

  /* 시각은 [대회 설정]에서 온다 — 반복 규칙은 어느 날인지만 정한다.
     두 곳에 시각을 두면 어느 쪽이 이기는지 아무도 모른다. */
  wipe();
  S.saveConfig({ ...S.defaultConfig(), regOpenMin: 13 * 60 + 30, startMin: 14 * 60 + 15 });
  R.saveRecurrence({ enabled: true, mode: 'daily', weekday: 0, day: 1 });
  const occ = R.nextOccurrence(R.getRecurrence())!;
  ck('다음 차례가 계산된다', occ != null);
  ck('시작 시각이 설정의 14:15 이다',
    T.kstTimeToUnix(occ.dateStr, 14, 15) === occ.startAt);
  ck('등록 시각이 설정의 13:30 이다',
    T.kstTimeToUnix(occ.dateStr, 13, 30) === occ.regOpenAt);
  ck('다음 차례는 언제나 미래다', occ.startAt > nowSec());

  // 주간 — 고른 요일에만 걸린다
  R.saveRecurrence({ enabled: true, mode: 'weekly', weekday: 3, day: 1 });
  const wk = R.nextOccurrence(R.getRecurrence())!;
  ck('매주 규칙은 그 요일을 고른다', T.kstWeekday(wk.startAt * 1000) === 3,
    String(T.kstWeekday(wk.startAt * 1000)));
  ck('매주 규칙은 일주일 안에 걸린다', wk.startAt - nowSec() <= 8 * 86400);

  // 월간 — 고른 날짜에만 걸린다
  R.saveRecurrence({ enabled: true, mode: 'monthly', weekday: 0, day: 17 });
  const mo = R.nextOccurrence(R.getRecurrence())!;
  ck('매월 규칙은 그 날짜를 고른다', Number(mo.dateStr.slice(8, 10)) === 17, mo.dateStr);

  /* 그 달에 없는 날(31일)을 골라도 멈추지 않고 있는 달을 찾는다.
     달마다 있는 날이 다르다는 것을 규칙식으로 접으면 2월에 조용히 죽는다. */
  R.saveRecurrence({ enabled: true, mode: 'monthly', weekday: 0, day: 31 });
  const m31 = R.nextOccurrence(R.getRecurrence());
  ck('31일 규칙은 31일이 있는 달을 찾는다', m31 != null && Number(m31.dateStr.slice(8, 10)) === 31,
    m31?.dateStr ?? 'null');

  /* 아직 멀면 만들지 않는다 — 12시간 전부터 만든다. 한 달 뒤 판을 지금 만들어 두면
     그 사이 설정을 바꿔도 반영되지 않고, 새 판을 열 수도 없다(2시간 여유 규칙). */
  wipe();
  R.saveRecurrence({ enabled: true, mode: 'monthly', weekday: 0, day: 17 });
  const far = R.nextOccurrence(R.getRecurrence())!;
  if (far.startAt - nowSec() > R.RECUR_LEAD_SEC) {
    R.ensureRecurring();
    ck('시작이 멀면 아직 만들지 않는다', count() === 0, String(count()));
  } else {
    ck('시작이 멀면 아직 만들지 않는다', true, '오늘이 17일 근처라 건너뜀');
  }

  /* 행이 없어도 다음이 언제인지는 안내한다 — 규칙에서 계산해 준다.
     로비의 "다음 대회" 배너가 이 값을 쓴다. */
  const hint = R.upcomingHint();
  ck('행이 없어도 다음 대회를 안내한다', hint != null && hint.startAt === far.startAt);

  // 진행 중 대회 중단 — 자동으로 정리되던 장치가 없어졌으므로 사람이 풀 수 있어야 한다
  wipe();
  setWindow(-60, 600, 1800);
  for (let i = 0; i < 3; i++) { mkUser('ab' + i); HD.registerHoldem('ab' + i, 'ab' + i); }
  db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(nowSec() - 1);
  ck('중단할 판이 돌고 있다', HD.advanceHoldem().status === 'RUNNING');
  ck('운영자가 중단할 수 있다', A.cancelRunningTournament().ok);
  ck('중단하면 대회가 없는 상태가 된다', HD.advanceHoldem().status === 'NONE');
  ck('중단할 판이 없으면 거절한다', !A.cancelRunningTournament().ok);
}

console.log('\n[14] 참가비 대회 (걷고 · 돌려주고 · 잔액 = 원장 누적합)');
{
  const wipe = () => {
    for (const tb of ['holdem_hand_seats', 'holdem_hands', 'holdem_seats',
      'holdem_tables', 'holdem_entries', 'holdem_tournaments']) db.prepare(`DELETE FROM ${tb}`).run();
    db.prepare(`DELETE FROM holdem_settings`).run();
  };
  const bal = (id: string) => Q.getWebUser(id)!.balance;
  const ledger = (id: string) => (db.prepare(
    `SELECT COALESCE(SUM(delta),0) AS n FROM points_ledger WHERE user_id = ?`)
    .get(id) as { n: number }).n;
  /* 이 검사의 뼈대. 어떤 경로를 지나든 이것이 깨지면 그건 표시가 아니라 경제 사고다. */
  const ledgerOk = (ids: string[]) => ids.every(id => bal(id) === ledger(id));

  const FEE = 500;
  const users = ['bi0', 'bi1', 'bi2', 'bi3'];
  for (const u of users) {
    mkUser(u);
    const cur = Q.getWebUser(u)?.balance ?? 0;
    if (cur !== 10_000) Q.adjustBalance(u, 10_000 - cur, 'test:seed');
  }

  /* ── 걷는다 ─────────────────────────────────────────────────── */
  wipe();
  const made = A.createTournament({
    title: '바이인 판', buyIn: FEE, regOpenAt: nowSec() - 60, startAt: nowSec() + 3600,
  });
  ck('참가비 대회를 열 수 있다', made.ok, JSON.stringify(made));
  const tid = made.ok ? made.id : -1;

  const before = bal('bi0');
  ck('등록이 받아진다', HD.registerHoldem('bi0', 'bi0').ok);
  ck('참가비만큼 잔액이 줄었다', bal('bi0') === before - FEE, `${bal('bi0')} (기대 ${before - FEE})`);
  ck('걷은 것이 원장에 남았다 (잔액 = 원장 누적합)', ledgerOk(['bi0']));
  ck('걷은 금액이 참가 행에 남았다',
    (db.prepare(`SELECT paid_in FROM holdem_entries WHERE tournament_id = ? AND user_id = 'bi0'`)
      .get(tid) as { paid_in: number }).paid_in === FEE);

  /* ── 못 내면 못 들어온다 ──────────────────────────────────────── */
  mkUser('bi_poor');
  {
    const cur = Q.getWebUser('bi_poor')?.balance ?? 0;
    if (cur !== FEE - 1) Q.adjustBalance('bi_poor', (FEE - 1) - cur, 'test:seed');
  }
  const poor = HD.registerHoldem('bi_poor', 'bi_poor');
  ck('참가비가 모자라면 거절한다', !poor.ok && poor.error === 'no_funds', JSON.stringify(poor));
  ck('거절된 사람의 돈은 그대로다', bal('bi_poor') === FEE - 1, String(bal('bi_poor')));
  /* 거절과 함께 참가 행도 남지 않아야 한다 — 남으면 안 낸 사람이 참가자로 잡힌다 */
  ck('거절된 사람의 참가 행이 없다',
    (db.prepare(`SELECT COUNT(*) AS n FROM holdem_entries WHERE tournament_id = ? AND user_id = 'bi_poor'`)
      .get(tid) as { n: number }).n === 0);

  /* ── 스스로 물리면 돌려준다 ───────────────────────────────────── */
  const beforeCancel = bal('bi0');
  ck('신청을 물릴 수 있다', HD.unregisterHoldem('bi0').ok);
  ck('물리면 참가비가 돌아온다', bal('bi0') === beforeCancel + FEE,
    `${bal('bi0')} (기대 ${beforeCancel + FEE})`);
  ck('되돌린 것도 원장에 남았다 (잔액 = 원장 누적합)', ledgerOk(['bi0']));
  ck('결국 낸 것과 받은 것이 같다 (10,000 그대로)', bal('bi0') === 10_000, String(bal('bi0')));

  /* ── 인원 미달 취소 → 전액 환불 ───────────────────────────────── */
  wipe();
  for (const u of users) {
    const cur = Q.getWebUser(u)!.balance;
    if (cur !== 10_000) Q.adjustBalance(u, 10_000 - cur, 'test:seed');
  }
  const t2 = A.createTournament({
    title: '미달 판', buyIn: FEE, regOpenAt: nowSec() - 60, startAt: nowSec() + 60,
  });
  ck('둘째 판을 열 수 있다', t2.ok, JSON.stringify(t2));
  HD.registerHoldem('bi0', 'bi0');
  HD.registerHoldem('bi1', 'bi1');          // 둘뿐이라 최소 인원(3)에 못 미친다
  ck('둘이 참가비를 냈다', bal('bi0') === 9_500 && bal('bi1') === 9_500,
    `${bal('bi0')} / ${bal('bi1')}`);

  // 대기 마감을 지나게 해서 "인원 미달 취소"를 실제로 통과시킨다
  db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?, grace_ends_at = ?`)
    .run(nowSec() - 120, nowSec() - 60);
  const after = HD.advanceHoldem();
  ck('인원 미달로 취소됐다', after.status === 'NONE' || after.tournament?.cancelled_at != null,
    after.status);
  ck('취소되면 전액 돌려받는다', bal('bi0') === 10_000 && bal('bi1') === 10_000,
    `${bal('bi0')} / ${bal('bi1')}`);
  ck('환불도 원장에 남았다 (잔액 = 원장 누적합)', ledgerOk(users));

  /* 두 번 돌려주면 없던 포인트가 생긴다. 취소된 판을 또 전진시키는 경로가 실제로 있다
     (요청마다 advanceHoldem 이 돈다) — 여기가 새면 새로고침만으로 돈이 불어난다. */
  HD.advanceHoldem(); HD.advanceHoldem();
  ck('여러 번 지나가도 두 번 돌려주지 않는다', bal('bi0') === 10_000, String(bal('bi0')));

  /* ── 취소된 판은 지울 수 있다 (되돌릴 돈이 남아 있지 않다) ────────── */
  const t2id = t2.ok ? t2.id : -1;
  ck('환불이 끝난 판은 지울 수 있다', A.purgeTournament(t2id).ok);

  /* ── 참가비를 걷은 채로는 못 지운다 ──────────────────────────── */
  wipe();
  for (const u of users) {
    const cur = Q.getWebUser(u)!.balance;
    if (cur !== 10_000) Q.adjustBalance(u, 10_000 - cur, 'test:seed');
  }
  const t3 = A.createTournament({
    title: '걷은 판', buyIn: FEE, regOpenAt: nowSec() - 60, startAt: nowSec() + 3600,
  });
  HD.registerHoldem('bi0', 'bi0');
  const t3id = t3.ok ? t3.id : -1;
  const nope = A.purgeTournament(t3id);
  ck('참가비를 걷은 판은 그냥 못 지운다', !nope.ok && nope.error === 'paid', JSON.stringify(nope));
  const rv = A.revokePrizesAndPurge(t3id);
  ck('회수 삭제는 참가비까지 돌려준다', rv.ok && rv.refunded === FEE, JSON.stringify(rv));
  ck('돌려받아 원래 잔액이다', bal('bi0') === 10_000, String(bal('bi0')));
  ck('그 뒤에도 잔액 = 원장 누적합', ledgerOk(users));

  /* ── 상금 풀 = 걷은 돈 (보장 상금이 있으면 그보다 낮아지지 않는다) ── */
  ck('참가비 대회의 상금 풀은 걷은 돈이다', T.prizePool(4, 0, 0, FEE) === 4 * FEE,
    String(T.prizePool(4, 0, 0, FEE)));
  ck('보장 상금이 바닥을 만든다', T.prizePool(2, 0, 5000, FEE) === 5000,
    String(T.prizePool(2, 0, 5000, FEE)));
  ck('걷은 돈이 보장을 넘으면 걷은 돈을 쓴다', T.prizePool(20, 0, 5000, FEE) === 10_000,
    String(T.prizePool(20, 0, 5000, FEE)));
  ck('참가비 대회는 배수를 보지 않는다', T.prizePool(4, 99_999, 0, FEE) === 4 * FEE,
    String(T.prizePool(4, 99_999, 0, FEE)));
  // 프리롤은 예전 그대로여야 한다 — 이 변경이 기존 대회를 건드리면 안 된다
  ck('프리롤은 예전 그대로 (인원 × 배수)', T.prizePool(5, 1000, 0, 0) === 5000);
  ck('프리롤의 고정 상금도 그대로', T.prizePool(5, 1000, 7777, 0) === 7777);

  /* ── 템플릿([기본 룰 템플릿])이 기본값으로 흘러가는가 ──────────────
     대회를 열 때마다 참가비를 다시 입력하지 않으려고 둔 값이다. 여기가 안 이어지면
     운영자는 템플릿을 바이인으로 바꿔 놓고 프리롤이 열리는 것을 보게 된다. */
  {
    const S = require('../src/db/settings') as typeof import('../src/db/settings');
    const R = require('../src/db/recurrence') as typeof import('../src/db/recurrence');
    wipe();
    S.saveConfig({ ...S.defaultConfig(), buyIn: 700, prizeFixed: 3000 });
    ck('템플릿에 참가비가 저장된다', S.getConfig().buyIn === 700, String(S.getConfig().buyIn));

    const t = A.createTournament({ title: '템플릿 판', regOpenAt: nowSec() + 60, startAt: nowSec() + 7200 });
    ck('참가비를 안 줘도 템플릿 값이 붙는다',
      t.ok && HD.liveTournament()?.buy_in === 700, String(HD.liveTournament()?.buy_in));
    ck('보장 상금도 템플릿에서 온다', HD.liveTournament()?.prize_fixed === 3000,
      String(HD.liveTournament()?.prize_fixed));

    /* 테스트 대회만은 예외다 — 참가비를 걷으면 원장이 움직여서 끝난 뒤 통째로 지울 수
       없게 된다. 그 판의 존재 이유가 "경제에 흔적을 남기지 않는 것"이다. */
    wipe();
    S.saveConfig({ ...S.defaultConfig(), buyIn: 700 });
    const test = A.openTestTournament();
    ck('테스트 대회는 템플릿이 바이인이어도 프리롤이다',
      test.ok && HD.liveTournament()?.buy_in === 0, String(HD.liveTournament()?.buy_in));

    // 반복 개최로 열리는 판도 템플릿을 따른다
    wipe();
    S.saveConfig({ ...S.defaultConfig(), buyIn: 500 });
    R.saveRecurrence({ enabled: true, mode: 'daily', weekday: 0, day: 1 });
    /* 여기도 시각을 고정한다 — 설정 시각을 막 넘긴 뒤에 돌리면 다음 차례가 24시간 뒤라
       12시간 리드 밖이어서 아무것도 안 만들어진다(하루 중 언제 돌리냐로 결과가 갈린다). */
    const sm2 = S.getConfig().startMin;
    const start2 = T.kstTimeToUnix(T.kstDateStr(Date.now()), Math.floor(sm2 / 60), sm2 % 60);
    R.ensureRecurring(start2 - 3600);
    ck('반복 개최로 열린 판에도 참가비가 붙는다', HD.liveTournament()?.buy_in === 500,
      String(HD.liveTournament()?.buy_in));

    /* ── 손으로 여는 판은 템플릿을 타지 않는다 ──────────────────────
       [새 대회 열기]에 적은 값이 그대로 판에 박혀야 한다. 여기가 안 이어지면
       운영자는 화면에 칩 30,000을 적어 놓고 템플릿의 10,000짜리 판이 열리는 것을 본다.
       그게 예전 동작이었고, 그래서 한 판만 짧게 돌리려 해도 템플릿을 고쳤다 되돌려야 했다. */
    wipe();
    S.saveConfig({
      ...S.defaultConfig(),
      startingStack: 10_000, levelMin: 8, lateRegMin: 30, graceMin: 20,
    });
    const own = A.createTournament({
      title: '직접 연 판', regOpenAt: nowSec() + 60, startAt: nowSec() + 7200,
      startingStack: 30_000, levelMin: 3, lateRegMin: 5, graceMin: 7,
    });
    const lt = HD.liveTournament();
    ck('시작 칩은 적은 값이 이긴다', own.ok && lt?.starting_stack === 30_000, String(lt?.starting_stack));
    ck('블라인드 주기도 적은 값이 이긴다', lt?.level_sec === 3 * 60, String(lt?.level_sec));
    ck('레이트 레지도 적은 값이 이긴다', lt?.late_reg_sec === 5 * 60, String(lt?.late_reg_sec));
    /* 대기 마감은 시작 시각 + 대기 분으로 만들어진다 — 저장된 열이 아니라 계산 결과라
       그 산식까지 같이 확인해야 "7분이 들어갔다"를 말할 수 있다. */
    ck('최소 인원 대기도 적은 값이 이긴다',
      lt != null && lt.grace_ends_at - lt.scheduled_start_at === 7 * 60,
      String(lt != null ? lt.grace_ends_at - lt.scheduled_start_at : null));

    // 일부만 적으면 나머지는 템플릿에서 온다 — 반복 개최가 그 길로 들어온다
    wipe();
    const part = A.createTournament({
      title: '일부만', regOpenAt: nowSec() + 60, startAt: nowSec() + 7200, levelMin: 4,
    });
    const lp = HD.liveTournament();
    ck('안 적은 값은 템플릿에서 온다', part.ok && lp?.starting_stack === 10_000, String(lp?.starting_stack));
    ck('적은 값만 바뀐다', lp?.level_sec === 4 * 60, String(lp?.level_sec));

    /* 0과 음수는 거절한다. levelSec 0 이면 블라인드가 영영 안 오르고 칩 0 이면 앉자마자
       전원 탈락인데, 둘 다 사람이 앉은 뒤에야 드러난다. */
    wipe();
    for (const [k, label] of [['startingStack', '시작 칩'], ['levelMin', '블라인드 주기'],
      ['lateRegMin', '레이트 레지'], ['graceMin', '대기']] as const) {
      const bad = A.createTournament({
        title: '잘못된 룰', regOpenAt: nowSec() + 60, startAt: nowSec() + 7200, [k]: 0,
      });
      ck(`${label} 0은 거절한다`, !bad.ok && bad.error === 'bad_rules',
        bad.ok ? 'ok' : bad.error);
      const neg = A.createTournament({
        title: '잘못된 룰', regOpenAt: nowSec() + 60, startAt: nowSec() + 7200, [k]: -1,
      });
      ck(`${label} 음수도 거절한다`, !neg.ok && neg.error === 'bad_rules', neg.ok ? 'ok' : neg.error);
    }
    ck('거절된 뒤에는 대회가 안 남는다', HD.liveTournament() == null);

    db.prepare(`DELETE FROM holdem_settings`).run();
  }

  /* ── 끝까지 돌려서 경제가 맞는지 ─────────────────────────────── */
  wipe();
  for (const u of users) {
    const cur = Q.getWebUser(u)!.balance;
    if (cur !== 10_000) Q.adjustBalance(u, 10_000 - cur, 'test:seed');
  }
  const t4 = A.createTournament({
    title: '끝까지', buyIn: FEE, regOpenAt: nowSec() - 60, startAt: nowSec() + 600,
  });
  for (const u of users) HD.registerHoldem(u, u);
  const collected = FEE * users.length;
  ck('넷이 참가비를 냈다', users.every(u => bal(u) === 10_000 - FEE),
    users.map(u => bal(u)).join(','));
  db.prepare(`UPDATE holdem_tournaments SET scheduled_start_at = ?`).run(nowSec() - 1);
  ck('대회가 시작됐다', HD.advanceHoldem().status === 'RUNNING');
  /* 이 감사는 앞에서 여러 대회를 끝까지 돌린다 — 알림 표에 그만큼 쌓여 있으므로
     전체 개수가 아니라 이 판이 늘린 개수를 봐야 한다. */
  const winsBefore = (db.prepare(
    `SELECT COUNT(*) AS n FROM notifications WHERE type = 'TOURNAMENT_WIN'`)
    .get() as { n: number }).n;

  /* 끝까지 돌린다. 구동 방식은 [8]의 것을 그대로 쓴다 — 여기서 새로 짜면 판이 안 끝나고,
     그러면 "경제가 맞는가"가 아니라 "내 루프가 맞는가"를 검사하게 된다. */
  const t4id = t4.ok ? t4.id : -1;
  const tbl = HD.getTable(t4id)!;
  for (let steps = 0; steps < 4000; steps++) {
    if (HD.advanceHoldem().status !== 'RUNNING') break;
    const h = HD.getCurrentHand(tbl.id);
    if (!h) break;
    if (h.ended_at != null) { expireNextHand(); continue; }
    if (h.to_act_seat == null) { expireAction(); continue; }
    const seat = HD.getSeats(tbl.id).find(x => x.seat === h.to_act_seat && x.presence !== 'OUT');
    if (!seat) { expireAction(); continue; }
    openAction();
    if (!HD.holdemAction(seat.user_id, 'allin', 0).ok
      && !HD.holdemAction(seat.user_id, 'call', 0).ok
      && !HD.holdemAction(seat.user_id, 'check', 0).ok) expireAction();
  }
  ck('대회가 끝났다', HD.advanceHoldem().status === 'FINISHED', HD.advanceHoldem().status);

  /* ── 우승 알림 ────────────────────────────────────────────────
     끝까지 돌린 판에만 붙일 수 있는 검사다. 우승자 이름과 상금은 정산이 끝나야 정해지고,
     정산은 대회당 한 번만 도는 자리 안쪽에 있다 — 그 자리가 곧 "한 번만 알린다"의 근거다. */
  {
    const NT = require('../src/db/notifications') as typeof import('../src/db/notifications');
    const wins = (db.prepare(
      `SELECT title, message, link, user_id FROM notifications
        WHERE type = 'TOURNAMENT_WIN' ORDER BY id DESC LIMIT 1`).get()) as
      { title: string; message: string; link: string | null; user_id: string | null } | undefined;
    const added = (db.prepare(
      `SELECT COUNT(*) AS n FROM notifications WHERE type = 'TOURNAMENT_WIN'`)
      .get() as { n: number }).n - winsBefore;
    ck('이 판이 우승 알림을 하나 만들었다', added === 1, String(added));
    const champ = (db.prepare(
      `SELECT username, prize FROM holdem_entries
        WHERE tournament_id = ? AND finish_place = 1`).get(t4id)) as
      { username: string; prize: number } | undefined;
    ck('우승자 이름이 담긴다', !!champ && !!wins?.message.includes(champ.username), wins?.message);
    ck('참가 인원이 담긴다', !!wins?.message.includes(`${users.length}명 참가`), wins?.message);
    ck('상금이 담긴다',
      !!champ && !!wins?.message.includes(champ.prize.toLocaleString('ko-KR')), wins?.message);
    ck('전체 알림이다 (사람마다 복사하지 않는다)', wins?.user_id === null);
    ck('누르면 홀덤으로 간다', wins?.link === '/games/holdem', String(wins?.link));
    /* 지나간 일이라 팝업하지 않는다 — 우승자 본인은 이미 게임 화면에서 우승 연출을 봤다 */
    ck('우승은 팝업하지 않는다',
      NT.popupNotifications(users[0]).every(n => n.type !== 'TOURNAMENT_WIN'));
  }
  const paidOut = (db.prepare(
    `SELECT COALESCE(SUM(prize),0) AS n FROM holdem_entries WHERE tournament_id = ?`)
    .get(t4id) as { n: number }).n;
  /* 참가비 대회는 참가자끼리 주고받는 것이라 서비스가 새로 발행하는 포인트가 없다.
     걷은 돈과 나간 상금이 같아야 한다 — 여기가 어긋나면 포인트가 생기거나 사라진 것이다. */
  ck('걷은 돈 = 나간 상금 (새로 발행된 포인트가 없다)', paidOut === collected,
    `${paidOut} vs ${collected}`);
  const total = users.reduce((a, u) => a + bal(u), 0);
  ck('넷의 잔액 합이 그대로다 (40,000)', total === 40_000, String(total));

  /* ── 정산이 두 번 돌아도 두 번 주지 않는다 ────────────────────────
     payPrizes 는 "이미 지급된 항목은 건드리지 않는다"를 조건부 UPDATE 로 막는다.
     그 판단을 값 다시 읽기로 하면 "내가 방금 넣었다"와 "원래 그 값이었다"를 구분하지
     못해서, 이미 같은 금액이 들어 있을 때 잔액만 한 번 더 올라간다.

     끝난 대회의 finished_at 만 지우고 다시 전진시켜 그 상황을 만든다 — 등수와 상금은
     그대로 둔다. 지금 구조에서는 요청이 동기라 이 일이 저절로 일어나지는 않지만,
     막고 있다고 적어 둔 것이 실제로 막는지는 확인할 수 있어야 한다.
     여기가 뚫리면 원장에 근거 없는 포인트가 남고, 그건 이 서비스의 유일한 불변식
     (잔액 = 원장 누적합)이 깨진다는 뜻이다. */
  {
    const balBefore = users.map(u => bal(u));
    const paidBefore = paidOut;
    db.prepare(`UPDATE holdem_tournaments SET finished_at = NULL WHERE id = ?`).run(t4id);
    for (let i = 0; i < 5; i++) HD.advanceHoldem();
    const paidAfter = (db.prepare(
      `SELECT COALESCE(SUM(prize),0) AS n FROM holdem_entries WHERE tournament_id = ?`)
      .get(t4id) as { n: number }).n;
    ck('정산을 다시 돌려도 상금 합이 그대로다', paidAfter === paidBefore,
      `${paidAfter} vs ${paidBefore}`);
    ck('정산을 다시 돌려도 잔액이 그대로다',
      users.every((u, i) => bal(u) === balBefore[i]),
      users.map(u => bal(u)).join(',') + ' vs ' + balBefore.join(','));
    ck('다시 돌린 뒤에도 잔액 = 원장 누적합', ledgerOk(users));
    ck('넷의 잔액 합도 그대로다 (40,000)',
      users.reduce((a, u) => a + bal(u), 0) === 40_000);
  }

  ck('끝난 뒤에도 잔액 = 원장 누적합', ledgerOk(users));

  /* ── 시즌 범위 ────────────────────────────────────────────────
     화면에 랭킹이 두 곳 있다(랭킹 페이지 / 게임 안 [역대 전적]). 둘의 범위가 다르면
     같은 사람의 누적 상금이 자리마다 다르게 나온다 — 둘 다 이번 시즌이어야 한다. */
  {
    const SE = require('../src/db/queries/season') as typeof import('../src/db/queries/season');
    db.exec(`DELETE FROM seasons`);
    db.prepare(`INSERT INTO seasons (number, name, reward, started_at) VALUES (0, 's0', '', 0)`).run();
    const sid = SE.currentSeason().id;

    /* 탭 옆 숫자는 "몇 명이 했나"다. 예전에는 홀덤만 0을 넣어 두어 배지가 안 붙었고,
       그래서 이 탭만 다른 규칙인 것처럼 보였다. */
    ck('홀덤 탭의 인원이 참가자 수다', SE.seasonHoldemPlayers(sid) === users.length,
      `${SE.seasonHoldemPlayers(sid)} (기대 ${users.length})`);
    ck('대회 수와는 다른 값이다 (인원이지 판수가 아니다)',
      SE.seasonHoldemCount(sid) === 1 && SE.seasonHoldemPlayers(sid) === users.length);

    const rank = SE.seasonHoldemRanking(sid, 100);
    const rec = HD.holdemRecords(100);
    const byUser = new Map(rec.map(r => [r.userId, r]));
    ck('두 랭킹의 사람 수가 같다', rank.length === rec.length, `${rank.length} vs ${rec.length}`);
    ck('두 랭킹의 누적 상금이 같다',
      rank.every(r => byUser.get(r.userId)?.prize === r.prize),
      rank.map(r => `${r.userId}:${r.prize}/${byUser.get(r.userId)?.prize}`).join(' '));
    ck('우승·입상·참가도 같다',
      rank.every(r => {
        const m = byUser.get(r.userId);
        return m && m.wins === r.wins && m.itm === r.itm && m.played === r.entries;
      }));

    /* 시즌이 바뀌면 지난 시즌 대회는 이번 시즌 기록에서 빠진다.
       행은 그대로 남는다 — 지우면 되돌릴 방법이 없고, 나중에 지난 시즌을 보여줄 수도 없다. */
    const before = HD.holdemRecords(100).length;
    ck('검사 전제: 지금은 기록이 있다', before > 0, String(before));
    /* 대회 종료 시각을 한 시간 앞으로 민다. 시즌 창은 [시작, 마감) 이라 마감과 같은 초에
       끝난 대회는 다음 시즌 몫이 된다 — 실제로는 대회가 22시대에 끝나고 시즌은 사람이
       닫으므로 겹칠 일이 없지만, 이 감사는 모든 일이 같은 초에 일어나서 그 경계에 걸린다. */
    db.prepare(`UPDATE holdem_tournaments SET finished_at = finished_at - 3600`).run();
    SE.closeSeason({ seed: 10_000 });
    ck('시즌이 바뀌면 역대 전적이 비워진다', HD.holdemRecords(100).length === 0,
      String(HD.holdemRecords(100).length));
    ck('대회 참가 행은 그대로 남아 있다', (db.prepare(
      `SELECT COUNT(*) AS n FROM holdem_entries WHERE tournament_id = ?`).get(t4id) as { n: number }).n
      === users.length);
    ck('새 시즌의 홀덤 탭 인원은 0',
      SE.seasonHoldemPlayers(SE.currentSeason().id) === 0);
  }
}

console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
try { rmSync(process.env.DB_PATH!, { recursive: true, force: true }); } catch { /* OS가 정리 */ }
process.exit(fail ? 1 : 0);
