/* 홀덤 사전 액션(미리 액션) 감사 — 실제로 실행해서 확인한다.

   대상 코드는 브라우저로 나가는 인라인 스크립트 조각(src/web/games/holdem-client/controls.ts)
   이다. 정규식으로 "그 줄이 있는가"만 보면 순서가 바뀌었을 때를 잡지 못하므로, 여기서는
   가짜 DOM 을 만들어 조각을 그대로 실행하고 체크박스의 상태를 눈으로 읽는다.

   조각은 하나의 클로저를 공유하도록 쓰여 있어서(import 가 없다), 앞 조각들이 만들어 두는
   것들을 여기서 최소한으로 대신 세워 준다 — st·unit·stackText·turnStamp·post·poll 등.
   그 목록이 곧 "CONTROLS 가 밖에서 빌려 쓰는 것 전부"다.

   운영 DB 는 건드리지 않는다 — DB 를 아예 열지 않는다. */
import { readFileSync } from 'node:fs';
import { CONTROLS } from '../src/web/games/holdem-client/controls';
import { FORMAT } from '../src/web/games/holdem-client/format';

let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

/* ── 가짜 DOM ────────────────────────────────────────────────────────
   필요한 것만 있다: hidden·checked·textContent·value·addEventListener·querySelector.
   요소는 id 로 요청될 때 자동으로 생겨난다 — 골격에 무엇이 있는지 여기서 다시 적으면
   골격이 바뀔 때 두 곳이 어긋난다. */
type El = {
  id: string; hidden: boolean; checked: boolean; textContent: string; value: string;
  min: string; max: string; childElementCount: number;
  addEventListener(t: string, f: () => void): void;
  fire(t: string): void;
  querySelector(): null;
  closest(): null;
  getAttribute(): null;
  classList: { add(): void; remove(): void; toggle(): void; contains(): boolean };
  style: Record<string, string>;
  offsetWidth: number;
};
const els = new Map<string, El>();
function el(id: string): El {
  let e = els.get(id);
  if (e) return e;
  const handlers: Record<string, Array<() => void>> = {};
  e = {
    id, hidden: false, checked: false, textContent: '', value: '0',
    min: '0', max: '0', childElementCount: 0,
    addEventListener(t, f) { (handlers[t] ||= []).push(f); },
    fire(t) { (handlers[t] || []).forEach(f => f()); },
    querySelector: () => null,
    closest: () => null,
    getAttribute: () => null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {},
    offsetWidth: 1,
  };
  els.set(id, e);
  return e;
}

/* 서버가 보낸 액션을 순서대로 적어 둔다 — 예약이 "무엇을 실행했나"의 유일한 근거다. */
const sent: Array<{ action: string; amount: number; maxCall: number | null }> = [];

const SANDBOX = `
  var document = FAKE.document, window = FAKE.window;
  var st = null, unit = 'chip', firstTablePaint = false;
  function num(n){ return Number(n||0).toLocaleString('ko-KR'); }
  function stackText(c){ return num(c); }
  function turnStamp(tb){ return tb && tb.deadline != null ? tb.deadline : null; }
  function post(url, body){ FAKE.sent.push(body); return { then: function(f){ f({ ok: true, d: {} }); return { then: function(g){ g(); return null; } }; } }; }
  function poll(){ return null; }
  var ctrlEl = document.getElementById('htControls');
  var ctopEl = document.getElementById('htCtop');
  var preEl = document.getElementById('htPre');
  var msgEl = document.getElementById('htMsg');
  var rangeEl = document.getElementById('htRange');
  var amountEl = document.getElementById('htAmount');
  var unitTag = document.getElementById('htUnitTag');
  var backBtn = document.getElementById('htBack');
  var backAct = document.getElementById('htBack3');
  var rabbitBtn = document.getElementById('htRabbit');
  var showBtn = document.getElementById('htShow');
  var showLBtn = document.getElementById('htShowL');
  var showRBtn = document.getElementById('htShowR');
  var rnoteEl = document.getElementById('htRNote');
  var ACT_BTNS = ['htFold','htCheck','htCall','htRaise'].map(function(id){
    return document.getElementById(id);
  });
${CONTROLS}
  return {
    setState: function(s){ st = s; },
    render: function(){ renderControls(); },
    run: function(){ runPreAction(); },
    clickAct: function(kind){ act(kind); },
    boxes: { cf: preCF, c: preC, f: preF, call: preCall },
    callAmount: function(){ return preCallAmount; },
    hand: function(){ return preHand; },
  };
`;

const api = new Function('FAKE', SANDBOX)({
  document: { getElementById: el, activeElement: null },
  window: { casinoSfx: null },
  sent,
});

/* ── 상태 만들기 ────────────────────────────────────────────────────
   서버 응답에서 사전 액션이 보는 것만 담는다: 판 번호 · legal · pre · 자리 비움 · 마감 시각. */
type Tbl = {
  handNo: number; street?: string; actOpenIn?: number; myPresence?: string;
  deadline?: number | null;
  legal?: { canFold: boolean; canCheck: boolean; canCall: boolean; callAmount: number;
    minRaiseTo: number | null; maxRaiseTo: number; raiseIsBet: boolean; myBet: number } | null;
  pre?: { canCheck: boolean; canCall: boolean; callAmount: number } | null;
};
let stamp = 1000;
function state(t: Tbl): unknown {
  return {
    table: {
      handNo: t.handNo, street: t.street ?? 'preflop', pot: 0, actOpenIn: t.actOpenIn ?? 0,
      myPresence: t.myPresence ?? 'ACTIVE', level: { bb: 100 }, seats: [],
      legal: t.legal ?? null, pre: t.pre ?? null,
      deadline: t.deadline === undefined ? (t.legal ? ++stamp : null) : t.deadline,
    },
  };
}
/** 폴링 한 번 = 상태 갈아 끼우고 그리고, 내 차례면 예약을 본다 (loop.ts 의 apply 와 같은 순서) */
function feed(t: Tbl): void {
  api.setState(state(t));
  api.render();
  if (t.legal) api.run();
}
/** 화면을 그리지 않고 예약만 본다 — 테이블이 감춰졌거나 정산 잠금으로 render 가 안 도는 구간 */
function feedNoRender(t: Tbl): void {
  api.setState(state(t));
  if (t.legal) api.run();
}
const LEGAL_CHECK = { canFold: true, canCheck: true, canCall: false, callAmount: 0,
  minRaiseTo: 100, maxRaiseTo: 5000, raiseIsBet: true, myBet: 0 };
const legalCall = (amt: number) => ({ canFold: true, canCheck: false, canCall: true,
  callAmount: amt, minRaiseTo: amt * 2, maxRaiseTo: 5000, raiseIsBet: false, myBet: 0 });
const B = api.boxes;
function check(box: 'cf' | 'c' | 'f' | 'call'): void { B[box].checked = true; B[box].fire('change'); }
function anyChecked(): boolean {
  return B.cf.checked || B.c.checked || B.f.checked || B.call.checked;
}

console.log('[1] 실행된 예약은 그 자리에서 해제된다');
{
  /* 제보된 버그: [체크]만 실행 뒤에 체크가 남았다. 나머지 셋은 원래 지워졌다. */
  const cases: Array<[string, 'cf' | 'c' | 'f' | 'call', string]> = [
    ['체크/폴드', 'cf', 'check'], ['체크', 'c', 'check'],
    ['폴드', 'f', 'fold'], ['콜', 'call', 'call'],
  ];
  for (const [label, box, act] of cases) {
    sent.length = 0;
    const canCheck = box === 'cf' || box === 'c';
    feed({ handNo: 1, pre: { canCheck, canCall: !canCheck, callAmount: canCheck ? 0 : 200 } });
    check(box);
    ck(`${label} — 걸린다`, B[box].checked);
    feed({ handNo: 1, legal: canCheck ? LEGAL_CHECK : legalCall(200) });
    ck(`${label} — ${act} 이 나갔다`, sent.length === 1 && sent[0].action === act,
      JSON.stringify(sent));
    ck(`${label} — 실행 직후 체크가 풀렸다`, !B[box].checked);
    ck(`${label} — 걸어 둔 금액도 비었다`, api.callAmount() === null);
  }
}

console.log('\n[2] 같은 예약이 두 번 실행되지 않는다');
{
  /* 체크가 남아 있으면 다음 차례에도 그대로 나간다 — 그것이 "이월"의 실체다.
     같은 판 안에서 스트리트가 넘어가는 경로로 재현한다. */
  sent.length = 0;
  feed({ handNo: 2, pre: { canCheck: true, canCall: false, callAmount: 0 } });
  check('c');
  feed({ handNo: 2, street: 'preflop', legal: LEGAL_CHECK });
  ck('첫 차례에 체크가 나갔다', sent.length === 1 && sent[0].action === 'check');
  feed({ handNo: 2, street: 'flop', pre: { canCheck: true, canCall: false, callAmount: 0 } });
  feed({ handNo: 2, street: 'flop', legal: LEGAL_CHECK });
  ck('다음 차례에는 아무것도 안 나갔다', sent.length === 1, JSON.stringify(sent));
}

console.log('\n[3] 다음 판으로 이월되지 않는다');
{
  // (a) 실행되지 않은 예약 — 판이 끝나고 새 판이 왔다
  sent.length = 0;
  feed({ handNo: 3, pre: { canCheck: true, canCall: false, callAmount: 0 } });
  check('cf');
  feed({ handNo: 3 });                      // 판 종료 — legal 도 pre 도 없다
  ck('판이 끝나면 예약이 비워진다', !anyChecked());
  feed({ handNo: 4, legal: LEGAL_CHECK });  // 새 판, 곧바로 내 차례
  ck('새 판 첫 차례에 아무것도 안 나갔다', sent.length === 0, JSON.stringify(sent));

  // (b) 폴드했다 — 서버가 pre 를 끊는다(state !== active)
  sent.length = 0;
  feed({ handNo: 5, pre: { canCheck: false, canCall: true, callAmount: 200 } });
  check('call');
  ck('폴드 전에는 걸려 있다', B.call.checked && api.callAmount() === 200);
  feed({ handNo: 5 });                      // 폴드 직후 — 같은 판인데 행동할 수 없다
  ck('폴드하면 그 자리에서 비워진다', !anyChecked() && api.callAmount() === null);
  feed({ handNo: 6, legal: legalCall(5000) });
  ck('다음 판에 콜이 되살아나지 않았다', sent.length === 0, JSON.stringify(sent));

  // (c) 자리 비움 — 서버가 대신 행동하는 중이라 예약이 닿을 데가 없다
  feed({ handNo: 7, pre: { canCheck: true, canCall: false, callAmount: 0 } });
  check('c');
  feed({ handNo: 7, myPresence: 'SIT_OUT', pre: { canCheck: true, canCall: false, callAmount: 0 } });
  ck('자리를 비우면 비워진다', !anyChecked());

  // (d) 판 번호가 바뀌는 것만으로도 비워진다(끝난 판을 못 보고 넘어간 경우)
  feed({ handNo: 8, pre: { canCheck: true, canCall: false, callAmount: 0 } });
  check('cf');
  feed({ handNo: 9, pre: { canCheck: true, canCall: false, callAmount: 0 } });
  ck('판 번호가 바뀌면 비워진다', !anyChecked());
}

console.log('\n[4] 같은 판 안에서는 살아 있어야 한다');
{
  /* 위의 정리가 과하면 이게 깨진다 — 프리플랍에 걸어 둔 것이 플랍에서 사라지면
     사전 액션 자체가 쓸모없어진다. */
  sent.length = 0;
  feed({ handNo: 10, street: 'preflop', pre: { canCheck: true, canCall: false, callAmount: 0 } });
  check('cf');
  feed({ handNo: 10, street: 'flop', pre: { canCheck: true, canCall: false, callAmount: 0 } });
  ck('스트리트가 넘어가도 남아 있다', B.cf.checked);
  feed({ handNo: 10, street: 'flop', legal: LEGAL_CHECK });
  ck('그때 실행된다', sent.length === 1 && sent[0].action === 'check');

  /* 차례가 아직 열리지 않았으면(actOpenIn>0) 예약을 쓰지도, 버리지도 않는다.
     여기서 버리면 서버가 거절한 뒤 제한 시간까지 흘러 자동 폴드된다. */
  sent.length = 0;
  feed({ handNo: 11, pre: { canCheck: true, canCall: false, callAmount: 0 } });
  check('c');
  feed({ handNo: 11, legal: LEGAL_CHECK, actOpenIn: 2 });
  ck('차례가 열리기 전에는 보내지 않는다', sent.length === 0);
  ck('그렇다고 버리지도 않는다', B.c.checked);
  feed({ handNo: 11, legal: LEGAL_CHECK, actOpenIn: 0 });
  ck('열리면 그때 나간다', sent.length === 1 && sent[0].action === 'check');
}

console.log('\n[5] 조건이 깨지면 내 차례를 기다리지 않고 풀린다');
{
  // (a) 체크를 걸어 뒀는데 앞에서 벳이 나왔다 — 두 상자를 따로 확인한다
  sent.length = 0;
  feed({ handNo: 12, pre: { canCheck: true, canCall: false, callAmount: 0 } });
  check('c');
  feed({ handNo: 12, pre: { canCheck: false, canCall: true, callAmount: 300 } });
  ck('체크 예약이 즉시 풀린다', !B.c.checked);
  feed({ handNo: 12, legal: legalCall(300) });
  ck('그래서 300 을 콜하지도, 폴드하지도 않는다', sent.length === 0, JSON.stringify(sent));

  feed({ handNo: 18, pre: { canCheck: true, canCall: false, callAmount: 0 } });
  check('cf');
  feed({ handNo: 18, pre: { canCheck: false, canCall: true, callAmount: 300 } });
  ck('체크/폴드 예약도 같이 풀린다', !B.cf.checked);

  // (b) 콜 200 을 걸어 뒀는데 뒤에서 5,000 으로 올렸다
  sent.length = 0;
  feed({ handNo: 13, pre: { canCheck: false, canCall: true, callAmount: 200 } });
  check('call');
  ck('콜 200 이 걸렸다', B.call.checked && api.callAmount() === 200);
  feed({ handNo: 13, pre: { canCheck: false, canCall: true, callAmount: 5000 } });
  ck('콜 예약이 즉시 풀린다', !B.call.checked, `callAmount=${api.callAmount()}`);
  ck('걸어 둔 금액도 지워진다', api.callAmount() === null);
  feed({ handNo: 13, legal: legalCall(5000) });
  ck('그래서 5,000 이 콜되지 않는다', sent.length === 0, JSON.stringify(sent));

  // (c) 화면이 못 따라간 경우에도 서버로 보내지 않는다 (마지막 문)
  sent.length = 0;
  feed({ handNo: 14, pre: { canCheck: false, canCall: true, callAmount: 200 } });
  check('call');
  feed({ handNo: 14, legal: legalCall(5000) });   // pre 를 못 본 채 내 차례가 왔다
  ck('폴링을 건너뛰어도 콜이 나가지 않는다', sent.length === 0, JSON.stringify(sent));
  ck('그 예약은 소모된다', !B.call.checked);

  // (d) 같은 금액이면 정상적으로 콜한다 — maxCall 을 함께 보낸다
  sent.length = 0;
  feed({ handNo: 15, pre: { canCheck: false, canCall: true, callAmount: 200 } });
  check('call');
  feed({ handNo: 15, legal: legalCall(200) });
  ck('금액이 그대로면 콜한다', sent.length === 1 && sent[0].action === 'call');
  ck('걸어 둘 때 본 금액을 함께 보낸다', sent.length === 1 && sent[0].maxCall === 200,
    JSON.stringify(sent));

  // (e) 폴드는 앞에서 벳이 나와도 유효하다 — 오히려 그때 쓰는 것이다
  sent.length = 0;
  feed({ handNo: 16, pre: { canCheck: false, canCall: true, callAmount: 200 } });
  check('f');
  feed({ handNo: 16, pre: { canCheck: false, canCall: true, callAmount: 9000 } });
  ck('폴드 예약은 금액이 올라도 남는다', B.f.checked);
  feed({ handNo: 16, legal: legalCall(9000) });
  ck('그대로 폴드된다', sent.length === 1 && sent[0].action === 'fold');
}

console.log('\n[6] 한 번에 하나만 걸린다');
{
  feed({ handNo: 17, pre: { canCheck: true, canCall: false, callAmount: 0 } });
  check('cf'); check('c');
  ck('나중에 고른 것만 남는다', B.c.checked && !B.cf.checked);
}

console.log('\n[7] 직접 버튼을 누르면 예약이 사라진다');
{
  /* 제보 "체크가 안 풀린다"의 경로. 예약을 걸어 둔 채 내 차례가 왔는데 차례가 아직
     열리지 않아(actOpenIn) 예약이 보류된다. 기다리다 버튼을 직접 누르면 액션은 나가지만
     상자는 켜진 채로 남고, 같은 판에서 차례가 한 번 더 오면 낡은 예약이 그대로 실행된다. */
  sent.length = 0;
  feed({ handNo: 20, pre: { canCheck: true, canCall: false, callAmount: 0 } });
  check('c');
  feed({ handNo: 20, legal: LEGAL_CHECK, actOpenIn: 3 });
  ck('차례가 열리기 전이라 예약은 보류된다', B.c.checked && sent.length === 0);
  api.clickAct('check');                        // 사용자가 직접 [체크] 를 눌렀다
  ck('직접 누른 액션이 나갔다', sent.length === 1 && sent[0].action === 'check');
  ck('그 순간 예약이 비워진다', !anyChecked() && api.hand() === null);
  // 같은 판에서 차례가 또 와도 낡은 예약이 실행되지 않는다
  feed({ handNo: 20, street: 'flop', pre: { canCheck: true, canCall: false, callAmount: 0 } });
  feed({ handNo: 20, street: 'flop', legal: LEGAL_CHECK });
  ck('같은 판 다음 차례에 되살아나지 않는다', sent.length === 1, JSON.stringify(sent));

  // 레이즈를 직접 눌러도 같다
  sent.length = 0;
  feed({ handNo: 21, pre: { canCheck: false, canCall: true, callAmount: 200 } });
  check('call');
  feed({ handNo: 21, legal: legalCall(200), actOpenIn: 3 });
  api.clickAct('raise');
  ck('레이즈를 직접 눌러도 예약이 비워진다', !anyChecked() && api.callAmount() === null);
}

console.log('\n[8] 다른 판의 예약은 실행되는 문 앞에서 막힌다');
{
  /* renderControls 는 화면을 그리는 길에 얹혀 있다 — 테이블이 감춰져 있거나 정산 연출
     잠금(settleBusy)으로 폴링이 큐에 쌓이는 동안에는 그 길이 돌지 않는다. 그래서 액션이
     실제로 나가는 문(runPreAction)에도 같은 판정이 서 있어야 한다.
     여기서는 render 를 일부러 건너뛰고 예약만 보게 해서 그 문을 시험한다. */
  sent.length = 0;
  feed({ handNo: 30, pre: { canCheck: true, canCall: false, callAmount: 0 } });
  check('cf');
  ck('30번 판에 예약이 걸렸다', B.cf.checked && api.hand() === 30);
  feedNoRender({ handNo: 31, legal: LEGAL_CHECK });   // 화면 정리를 건너뛴 새 판
  ck('새 판에서 아무것도 나가지 않았다', sent.length === 0, JSON.stringify(sent));
  ck('그 자리에서 예약이 버려졌다', !anyChecked() && api.hand() === null);

  // 콜 예약도 같다 — 금액이 같아도 판이 다르면 안 나간다
  sent.length = 0;
  feed({ handNo: 32, pre: { canCheck: false, canCall: true, callAmount: 200 } });
  check('call');
  feedNoRender({ handNo: 33, legal: legalCall(200) });
  ck('금액이 같아도 판이 다르면 콜하지 않는다', sent.length === 0, JSON.stringify(sent));
}

console.log('\n[9] 예약이 없을 때는 상자를 건드리지 않는다');
{
  /* 수명 관리가 매 폴링 무조건 돌면, 사용자가 방금 누른 체크를 같은 틱의 폴링이
     지워 버릴 수 있다. preHand 가 없을 때는 아무것도 하지 않아야 한다. */
  feed({ handNo: 40, pre: { canCheck: true, canCall: false, callAmount: 0 } });
  ck('예약이 없으면 판 번호도 비어 있다', api.hand() === null);
  check('cf');
  ck('누른 직후 값이 잡힌다', B.cf.checked && api.hand() === 40);
  feed({ handNo: 40, pre: { canCheck: true, canCall: false, callAmount: 0 } });
  ck('폴링이 지우지 않는다', B.cf.checked && api.hand() === 40);
  // 손으로 체크를 풀면 판 번호도 같이 비워진다
  B.cf.checked = false; B.cf.fire('change');
  ck('손으로 풀면 판 번호도 비워진다', api.hand() === null);
}

console.log('\n[10] 바운티 금액은 BB 표기를 켜도 포인트로 나온다');
{
  /* 제보된 버그: 칩 표기를 BB 로 두면 미스터리 바운티 금액이 "12.5BBP" 로 찍혔다.
     붙이는 쪽이 'P' 를 덧붙이는데 stackText 가 이미 'BB' 를 붙였기 때문이다.
     바운티는 대회가 끝나면 그대로 계좌에 들어오는 진짜 포인트라, 애초에 환산 대상이 아니다. */
  const fmt = new Function('FAKE', `
    var document = FAKE.document, window = FAKE.window;
    var st = null, unit = 'chip';
${FORMAT}
    return {
      setUnit: function(u){ unit = u; },
      setBb: function(bb){ st = { table: { level: { bb: bb } } }; },
      point: function(v){ return pointText(v); },
      stack: function(v){ return stackText(v); },
    };
  `)({ document: { getElementById: el, activeElement: null }, window: {} });

  fmt.setBb(800);
  for (const u of ['chip', 'bb']) {
    fmt.setUnit(u);
    ck(`${u} — 10,000P 이 그대로 나온다`, fmt.point(10_000) === '10,000P', fmt.point(10_000));
    ck(`${u} — 자릿수 구분이 붙는다`, fmt.point(1_234_567) === '1,234,567P', fmt.point(1_234_567));
    ck(`${u} — BB 가 섞이지 않는다`, fmt.point(10_000).indexOf('BB') < 0, fmt.point(10_000));
  }
  // stackText 는 그대로 두어야 한다 — 스택·팟은 BB 로 읽는 것이 맞다
  fmt.setUnit('bb');
  ck('스택 표기는 여전히 BB 로 환산된다', fmt.stack(10_000) === '12BB', fmt.stack(10_000));
  fmt.setUnit('chip');
  ck('칩 표기에서는 숫자만 나온다', fmt.stack(10_000) === '10,000', fmt.stack(10_000));

  /* 그리는 자리가 실제로 이 함수를 쓰는지 확인한다. 셋 다 바운티다:
     전광판(개봉) · 아바타 위로 떠오르는 +N P · 머리 위 명찰(바운티 헌터). */
  const se = readFileSync('src/web/games/holdem-client/seats.ts', 'utf8');
  ck('전광판이 pointText 를 쓴다', /amtEl\.textContent = pointText\(job\.amount\);/.test(se));
  ck('굴러가는 숫자도 pointText 를 쓴다', /amtEl\.textContent = pointText\(Number\(s\)\);/.test(se));
  ck('떠오르는 +N P 가 pointText 를 쓴다',
    /gEl\.textContent = '\+' \+ pointText\(amount\);/.test(se));
  ck('머리 위 명찰이 pointText 를 쓴다', /bEl\.textContent = pointText\(bv\);/.test(se));
  ck("stackText(...) + 'P' 가 한 곳도 남아 있지 않다", !/stackText\([^)]*\) \+ 'P'/.test(se),
    (se.match(/stackText\([^)]*\) \+ 'P'/g) || []).join(' · '));
  /* 상금 탭은 원래 num() 을 쓴다 — 단위 토글의 영향을 받지 않는 자리다. 같이 못 박아 둔다. */
  const sd = readFileSync('src/web/games/holdem-client/side.ts', 'utf8');
  ck('상금 탭 바운티도 포인트다', /num\(btyPool\) \+ 'P/.test(sd));
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`통과 ${pass} · 실패 ${fail}`);
process.exit(fail ? 1 : 0);
