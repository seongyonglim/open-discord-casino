/* 홀덤 핸드 엔진 검증.
 *
 * 포커 규칙에서 틀리기 쉬운 곳만 집중적으로 본다:
 *  · 베팅 라운드 종료 판정 (특히 프리플랍 빅블라인드 옵션)
 *  · 최소 레이즈와 "올인은 최소 레이즈 미달도 허용" 예외
 *  · 사이드 팟 — 손으로 짜면 거의 항상 틀린다. 표 검증 + 무작위 칩 보존 검사를 함께 한다
 *  · 헤즈업 블라인드 역전
 *
 * 칩 보존이 이 스위트의 핵심 불변식이다: 나간 돈의 합 == 받은 돈의 합.
 * 이게 깨지면 토너먼트 총 칩이 변해서 게임이 성립하지 않는다.
 */
import { randomInt } from 'node:crypto';
import * as H from '../src/services/holdem';
import * as T from '../src/services/tournament';

let pass = 0, fail = 0;
function ck(name: string, ok: boolean, extra = ''): void {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
function section(t: string): void { console.log('\n' + t); }

const seat = (
  s: number, bet: number, stack: number, committed = bet,
  state: H.SeatState = 'active', acted = false,
): H.SeatView => ({ seat: s, bet, stack, committed, state, acted });

/* ── 1. 베팅 라운드 종료 판정 ───────────────────────────────────── */
section('[1] 베팅 라운드 종료 판정');
{
  // 프리플랍: SB 50, BB 100, UTG가 콜 100. BB는 금액이 같지만 아직 행동하지 않았다(옵션).
  const preflop = [
    seat(0, 100, 900, 100, 'active', true),   // UTG 콜
    seat(1, 50, 950, 50, 'active', false),    // SB — 아직
    seat(2, 100, 900, 100, 'active', false),  // BB — 금액은 같지만 옵션이 남았다
  ];
  ck('BB 옵션이 남아 있으면 라운드가 끝나지 않는다', !H.bettingRoundClosed(preflop));

  preflop[1].bet = 100; preflop[1].stack = 900; preflop[1].committed = 100; preflop[1].acted = true;
  ck('SB가 콜해도 BB 옵션 때문에 계속', !H.bettingRoundClosed(preflop));

  preflop[2].acted = true;
  ck('BB가 체크하면 종료', H.bettingRoundClosed(preflop));

  // 한 명만 남으면 즉시 종료
  const folded = [
    seat(0, 100, 900, 100, 'active', true),
    seat(1, 0, 1000, 50, 'folded', true),
    seat(2, 0, 1000, 100, 'folded', true),
  ];
  ck('한 명만 남으면 즉시 종료', H.bettingRoundClosed(folded));

  // 전부 올인이면 더 물어볼 게 없다
  const allin = [
    seat(0, 500, 0, 500, 'allin', true),
    seat(1, 500, 0, 500, 'allin', true),
  ];
  ck('전부 올인이면 종료', H.bettingRoundClosed(allin));

  // 금액이 안 맞으면 종료가 아니다
  const uneven = [
    seat(0, 300, 700, 300, 'active', true),
    seat(1, 100, 900, 100, 'active', true),
  ];
  ck('베팅액이 다르면 종료 아님', !H.bettingRoundClosed(uneven));

  // 상대가 전부 올인/폴드고 나 혼자 남았는데 이미 최고액을 맞췄으면 종료
  const lone = [
    seat(0, 500, 500, 500, 'active', true),
    seat(1, 500, 0, 500, 'allin', true),
  ];
  ck('혼자 남고 최고액을 맞췄으면 종료', H.bettingRoundClosed(lone));
}

/* ── 2. 최소 레이즈 ─────────────────────────────────────────────── */
section('[2] 최소 레이즈와 올인 예외');
{
  const BB = 100;
  // 앞에서 100까지 올라왔고 인상폭이 100이면 최소 레이즈는 200
  {
    const seats = [seat(0, 100, 900, 100), seat(1, 0, 1000, 0)];
    const la = H.legalActions(seats[1], seats, 100, BB);
    ck('최소 레이즈 = 최고베팅 + 인상폭 (100+100=200)', la.minRaiseTo === 200, String(la.minRaiseTo));
    ck('콜 금액 = 100', la.callAmount === 100);
    ck('체크 불가', !la.canCheck);
    ck('최대 = 내 스택 전부 (1000)', la.maxRaiseTo === 1000, String(la.maxRaiseTo));
  }
  // 300까지 올라왔고 인상폭이 200이면 최소 레이즈는 500
  {
    const seats = [seat(0, 300, 700, 300), seat(1, 100, 900, 100)];
    const la = H.legalActions(seats[1], seats, 200, BB);
    ck('인상폭 200 → 최소 레이즈 500', la.minRaiseTo === 500, String(la.minRaiseTo));
  }
  // 스택이 최소 레이즈에 못 미치면 올인만 가능
  {
    const seats = [seat(0, 100, 900, 100), seat(1, 0, 150, 0)];
    const la = H.legalActions(seats[1], seats, 100, BB);
    ck('스택이 최소 레이즈 미달 → 올인액이 최소치가 된다', la.minRaiseTo === 150, String(la.minRaiseTo));
    const r = H.applyAction(seats, 1, 'allin', 0, 100, BB);
    ck('최소 레이즈 미달 올인 허용 (실제 규칙)', r.ok === true);
    ck('올인 후 스택 0 · 상태 allin', seats[1].stack === 0 && seats[1].state === 'allin');
  }
  // 최소 레이즈 미달인 "일반 레이즈"는 거절
  {
    const seats = [seat(0, 100, 900, 100), seat(1, 0, 1000, 0)];
    const r = H.applyAction(seats, 1, 'raise', 150, 100, BB);
    ck('최소 미달 레이즈는 거절', r.ok === false && r.error === 'below_min_raise');
    ck('거절 시 스택 변화 없음', seats[1].stack === 1000 && seats[1].bet === 0);
  }
  // 스택 초과는 거절
  {
    const seats = [seat(0, 100, 900, 100), seat(1, 0, 500, 0)];
    const r = H.applyAction(seats, 1, 'raise', 900, 100, BB);
    ck('스택 초과 레이즈 거절', r.ok === false && r.error === 'above_stack');
  }
  // 체크할 수 없는 상황에서 체크 거절
  {
    const seats = [seat(0, 100, 900, 100), seat(1, 0, 1000, 0)];
    const r = H.applyAction(seats, 1, 'check', 0, 100, BB);
    ck('콜해야 하는데 체크는 거절', r.ok === false && r.error === 'cannot_check');
  }
}

/* ── 3. 레이즈가 행동 기회를 다시 연다 ─────────────────────────── */
section('[3] 레이즈 후 행동 기회 재개');
{
  const BB = 100;
  const seats = [
    seat(0, 100, 900, 100, 'active', true),
    seat(1, 100, 900, 100, 'active', true),
    seat(2, 100, 900, 100, 'active', true),
  ];
  ck('전원 콜 상태에서는 종료', H.bettingRoundClosed(seats));
  const r = H.applyAction(seats, 2, 'raise', 300, 100, BB);
  ck('레이즈 성공 (300까지)', r.ok === true && r.ok && r.paid === 200, r.ok ? String(r.paid) : '');
  ck('레이즈로 인상폭이 200으로 갱신', r.ok === true && r.lastRaiseSize === 200);
  ck('다른 사람의 acted가 풀린다', !seats[0].acted && !seats[1].acted);
  ck('레이즈한 본인은 acted 유지', seats[2].acted);
  ck('재개됐으니 라운드는 안 끝났다', !H.bettingRoundClosed(seats));

  // 최고 베팅을 넘지 못한 짧은 올인은 재개하지 않는다
  const short = [
    seat(0, 300, 700, 300, 'active', true),
    seat(1, 100, 120, 100, 'active', false),
    seat(2, 300, 700, 300, 'active', true),
  ];
  const r2 = H.applyAction(short, 1, 'allin', 0, 200, BB);
  ck('짧은 올인(220 < 300)도 성공', r2.ok === true);
  ck('최고베팅을 못 넘긴 올인은 재개하지 않는다', short[0].acted && short[2].acted);
}

/* ── 4. 사이드 팟 ───────────────────────────────────────────────── */
section('[4] 사이드 팟 구성');
{
  // 교과서 사례: 100 / 500 / 1000 올인 3인
  //  메인 팟 = 100×3 = 300 (전원 자격)
  //  두 번째 = (500-100)×2 = 800 (B, C)
  //  세 번째 = (1000-500)×1 = 500 (C만) — 실제로는 반환되지만 여기선 팟으로 잡고
  //            쇼다운에서 C가 유일 자격자라 되돌려받는다
  {
    const seats = [
      seat(0, 100, 0, 100, 'allin', true),
      seat(1, 500, 0, 500, 'allin', true),
      seat(2, 1000, 0, 1000, 'allin', true),
    ];
    const pots = H.buildPots(seats);
    ck('층이 3개', pots.length === 3, String(pots.length));
    ck('메인 팟 300 · 자격 3인', pots[0].amount === 300 && pots[0].eligible.length === 3,
      JSON.stringify(pots[0]));
    ck('둘째 팟 800 · 자격 2인', pots[1].amount === 800 && pots[1].eligible.join() === '1,2',
      JSON.stringify(pots[1]));
    ck('셋째 팟 500 · 자격 1인', pots[2].amount === 500 && pots[2].eligible.join() === '2',
      JSON.stringify(pots[2]));
    const total = pots.reduce((a, p) => a + p.amount, 0);
    ck('팟 합계 = 총 투입액 1600', total === 1600, String(total));
  }

  // 폴드한 사람의 돈도 팟에 들어가지만 자격은 없다
  {
    const seats = [
      seat(0, 0, 900, 100, 'folded', true),   // 100 내고 폴드
      seat(1, 200, 0, 200, 'allin', true),
      seat(2, 200, 800, 200, 'active', true),
    ];
    const pots = H.buildPots(seats);
    ck('폴드한 사람의 돈도 팟에 포함 (100+200+200=500)',
      pots.reduce((a, p) => a + p.amount, 0) === 500, JSON.stringify(pots));
    ck('폴드한 사람은 자격자에서 제외',
      pots.every(p => !p.eligible.includes(0)), JSON.stringify(pots));
  }

  // 동액 올인 2인 — 층은 하나
  {
    const seats = [seat(0, 500, 0, 500, 'allin', true), seat(1, 500, 0, 500, 'allin', true)];
    const pots = H.buildPots(seats);
    ck('동액 올인은 층이 하나', pots.length === 1 && pots[0].amount === 1000, JSON.stringify(pots));
  }
}

/* ── 5. 팟 분배 ─────────────────────────────────────────────────── */
section('[5] 팟 분배와 홀수 칩');
{
  // 단독 승자
  {
    const pots: H.Pot[] = [{ amount: 300, eligible: [0, 1, 2] }];
    const scores = new Map([[0, 500], [1, 900], [2, 100]]);
    const aw = H.awardPots(pots, scores, 0, 9);
    ck('최고 핸드가 전액', aw.length === 1 && aw[0].seat === 1 && aw[0].amount === 300, JSON.stringify(aw));
  }
  // 2인 동점 — 딱 나뉜다
  {
    const pots: H.Pot[] = [{ amount: 300, eligible: [0, 1] }];
    const scores = new Map([[0, 700], [1, 700]]);
    const aw = H.awardPots(pots, scores, 0, 9);
    ck('동점 2인 150/150', aw.length === 2 && aw.every(a => a.amount === 150), JSON.stringify(aw));
  }
  // 2인 동점 — 홀수 칩은 버튼 왼쪽부터
  {
    const pots: H.Pot[] = [{ amount: 301, eligible: [3, 5] }];
    const scores = new Map([[3, 700], [5, 700]]);
    const aw = H.awardPots(pots, scores, 8, 9);   // 버튼 8 → 다음은 0,1,2,3… 이므로 3이 먼저
    const s3 = aw.find(a => a.seat === 3)!.amount, s5 = aw.find(a => a.seat === 5)!.amount;
    ck('홀수 칩은 버튼 왼쪽(자리3)이 받는다', s3 === 151 && s5 === 150, `3=${s3} 5=${s5}`);
    ck('분배 합계 = 팟 301', s3 + s5 === 301);
  }
  // 3인 동점 — 나머지 2칩을 순서대로
  {
    const pots: H.Pot[] = [{ amount: 302, eligible: [0, 1, 2] }];
    const scores = new Map([[0, 700], [1, 700], [2, 700]]);
    const aw = H.awardPots(pots, scores, 8, 9);   // 버튼 8 → 0,1,2 순
    ck('3인 동점 302 → 101/101/100',
      aw.find(a => a.seat === 0)!.amount === 101 && aw.find(a => a.seat === 1)!.amount === 101
      && aw.find(a => a.seat === 2)!.amount === 100, JSON.stringify(aw));
  }
  // 사이드 팟: 짧은 올인이 메인만 먹고 사이드는 다른 사람이
  {
    const pots: H.Pot[] = [
      { amount: 300, eligible: [0, 1, 2] },
      { amount: 800, eligible: [1, 2] },
    ];
    const scores = new Map([[0, 999], [1, 500], [2, 700]]);   // 자리0이 최강이지만 100만 냈다
    const aw = H.awardPots(pots, scores, 8, 9);
    const a0 = aw.find(a => a.seat === 0)?.amount ?? 0;
    const a2 = aw.find(a => a.seat === 2)?.amount ?? 0;
    ck('짧은 올인 최강자는 메인 팟만 (300)', a0 === 300, String(a0));
    ck('사이드 팟은 남은 사람 중 최강자 (800)', a2 === 800, String(a2));
    ck('분배 합계 = 1100', aw.reduce((a, x) => a + x.amount, 0) === 1100);
  }
}

/* ── 6. 블라인드 위치 ───────────────────────────────────────────── */
section('[6] 블라인드 위치와 헤즈업 예외');
{
  // 9인: 버튼 0 → SB 1, BB 2, 첫 행동 3
  {
    const p = H.blindPositions([0, 1, 2, 3, 4, 5, 6, 7, 8], 0, 9)!;
    ck('9인 · 버튼0 → SB1 BB2 UTG3', p.sb === 1 && p.bb === 2 && p.firstToAct === 3, JSON.stringify(p));
  }
  // 빈 자리를 건너뛴다
  {
    const p = H.blindPositions([0, 3, 7], 0, 9)!;
    ck('빈 자리 건너뛰기 (0,3,7 · 버튼0) → SB3 BB7 첫행동0',
      p.sb === 3 && p.bb === 7 && p.firstToAct === 0, JSON.stringify(p));
  }
  // 헤즈업: 버튼이 SB이고 프리플랍에 먼저 행동한다
  {
    const p = H.blindPositions([2, 6], 2, 9)!;
    ck('헤즈업 · 버튼이 SB', p.sb === 2 && p.bb === 6, JSON.stringify(p));
    ck('헤즈업 · 프리플랍은 버튼(SB)이 먼저', p.firstToAct === 2, String(p.firstToAct));
    const post = H.firstToActPostflop([2, 6], 2, 9);
    ck('헤즈업 · 플랍 이후는 BB가 먼저', post === 6, String(post));
  }
  // 1인이면 블라인드가 없다
  ck('1인이면 null', H.blindPositions([4], 4, 9) === null);
  // 플랍 이후 첫 행동은 버튼 왼쪽
  {
    const post = H.firstToActPostflop([0, 3, 7], 7, 9);
    ck('플랍 이후 첫 행동 = 버튼 왼쪽 (버튼7 → 0)', post === 0, String(post));
  }
  // 버튼 이동
  {
    ck('버튼 이동 (0,3,7 · 버튼3 → 7)', H.nextButton([0, 3, 7], 3, 9) === 7);
    ck('버튼 이동 한 바퀴 (버튼7 → 0)', H.nextButton([0, 3, 7], 7, 9) === 0);
  }
}

/* ── 7. 무작위 칩 보존 ─────────────────────────────────────────────
   이 스위트의 핵심. 무작위 올인/폴드 조합을 만들어
   "팟 합계 == 총 투입액" 과 "분배 합계 == 팟 합계"를 확인한다.
   사이드 팟 로직이 한 칩이라도 흘리면 여기서 걸린다.                        */
section('[7] 무작위 칩 보존 (사이드 팟 + 분배)');
{
  let potMismatch = 0, awardMismatch = 0, negative = 0;
  const N = 20_000;
  for (let iter = 0; iter < N; iter++) {
    const n = 2 + randomInt(8);            // 2~9명
    const seats: H.SeatView[] = [];
    for (let i = 0; i < n; i++) {
      const committed = randomInt(2000);
      const roll = randomInt(10);
      const state: H.SeatState = roll < 3 ? 'folded' : roll < 7 ? 'allin' : 'active';
      seats.push(seat(i, 0, randomInt(1000), committed, state, true));
    }
    const total = seats.reduce((a, s) => a + s.committed, 0);
    const pots = H.buildPots(seats);
    const potSum = pots.reduce((a, p) => a + p.amount, 0);
    if (potSum !== total) potMismatch++;
    if (pots.some(p => p.amount < 0)) negative++;

    // 자격자에게 무작위 점수를 주고 분배
    const scores = new Map<number, number>();
    for (const s of seats) if (s.state !== 'folded') scores.set(s.seat, randomInt(100));
    const aw = H.awardPots(pots, scores, randomInt(9), 9);
    const awSum = aw.reduce((a, x) => a + x.amount, 0);
    // 자격자가 아무도 없는 팟(전원 폴드)은 분배되지 않는다 — 그만큼은 빼고 비교한다
    const orphan = pots.filter(p => !p.eligible.some(e => scores.has(e)))
      .reduce((a, p) => a + p.amount, 0);
    if (awSum !== potSum - orphan) awardMismatch++;
    if (aw.some(x => x.amount < 0)) negative++;
  }
  ck(`팟 합계 = 총 투입액 (${N.toLocaleString('ko-KR')}회)`, potMismatch === 0, `불일치 ${potMismatch}회`);
  ck('분배 합계 = 팟 합계', awardMismatch === 0, `불일치 ${awardMismatch}회`);
  ck('음수 금액 없음', negative === 0, `${negative}회`);
}

/* ── 8. 핸드 평가 연동 ─────────────────────────────────────────── */
section('[8] 핸드 평가 (evaluate7 재사용)');
{
  const C = (r: number, s = 0) => r * 4 + s;
  const A = (s = 0) => C(12, s), K = (s = 0) => C(11, s), Q = (s = 0) => C(10, s);
  const J = (s = 0) => C(9, s), T = (s = 0) => C(8, s), N = (n: number, s = 0) => C(n - 2, s);

  // 로열 플러시 > 쿼드 > 풀하우스
  const board = [T(0), J(0), Q(0), N(2, 1), N(7, 2)];
  const royal = H.handScore([K(0), A(0)], board);
  const quads = H.handScore([N(2, 0), N(2, 2)], [T(0), J(0), Q(0), N(2, 1), N(2, 3)]);
  ck('로열 플러시가 쿼드보다 높다', royal > quads);

  // 같은 보드에서 킥커로 갈린다
  const b2 = [A(0), K(1), N(7, 2), N(4, 3), N(2, 0)];
  const aq = H.handScore([A(1), Q(2)], b2);
  const aj = H.handScore([A(2), J(3)], b2);
  ck('A+Q 투페어가 A+J 투페어보다 높다 (킥커)', aq > aj, `${aq} vs ${aj}`);

  // 같은 패면 점수도 같다 (무늬만 다른 경우)
  const x1 = H.handScore([N(9, 0), N(9, 1)], b2);
  const x2 = H.handScore([N(9, 2), N(9, 3)], b2);
  ck('무늬만 다른 같은 패는 동점', x1 === x2);

  ck('카드 표기 변환', H.cardsToStrings([A(0), T(1)]).length === 2);
}

/* ── 9. 덱 ──────────────────────────────────────────────────────── */
section('[9] 덱');
{
  const d = H.shuffleDeck(randomInt);
  ck('52장', d.length === 52);
  ck('중복 없음', new Set(d).size === 52);
  ck('0~51 범위', d.every(c => c >= 0 && c < 52));
  // 매 핸드 새 덱이므로 두 번 섞으면 순서가 달라야 한다
  const d2 = H.shuffleDeck(randomInt);
  ck('두 번 섞으면 순서가 다르다', d.join() !== d2.join());
}

/* ── 10. 일정 (KST) ─────────────────────────────────────────────── */
section('[10] 일정 (KST)');
{
  // 2026-08-03은 월요일
  const mon = T.scheduleForDate('2026-08-03');
  ck('월요일 = 평일 · 배수 1,000P', !mon.weekend && mon.prizeMultiplier === 1000, JSON.stringify(mon));
  ck('평일 제목', mon.title === '데일리 프리롤', mon.title);
  const sat = T.scheduleForDate('2026-08-08');
  ck('토요일 = 주말 · 배수 2,000P', sat.weekend && sat.prizeMultiplier === 2000, JSON.stringify(sat));
  ck('일요일 = 주말', T.scheduleForDate('2026-08-09').weekend);
  ck('주말 제목', sat.title === '주말 더블 프리롤', sat.title);

  /* 시각이 정말 KST인지 본다. 서버는 UTC로 돌아가므로 여기서 틀리면
     운영에서 한 시간씩 어긋난 채로 아무도 모른다. */
  const fmt = (u: number) => new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(u * 1000));
  ck('등록 오픈 = KST 21:00', fmt(mon.regOpenAt) === '21:00', fmt(mon.regOpenAt));
  ck('예정 시작 = KST 22:00', fmt(mon.scheduledStartAt) === '22:00', fmt(mon.scheduledStartAt));
  ck('대기 마감 = KST 22:20', fmt(mon.graceEndsAt) === '22:20', fmt(mon.graceEndsAt));
  ck('등록→시작 정확히 1시간', mon.scheduledStartAt - mon.regOpenAt === 3600);
  ck('대기 20분', mon.graceEndsAt - mon.scheduledStartAt === 1200);
  ck('KST 요일 판정 (2026-08-03 = 월)', T.kstWeekday(mon.scheduledStartAt * 1000) === 1,
    String(T.kstWeekday(mon.scheduledStartAt * 1000)));
}

/* ── 11. 상태 판정 ──────────────────────────────────────────────── */
section('[11] 토너먼트 상태 판정');
{
  const s = T.scheduleForDate('2026-08-03');
  const none: T.TournamentFacts = { startedAt: null, finishedAt: null, cancelledAt: null };

  ck('20:59 → SCHEDULED', T.statusAt(s.regOpenAt - 60, s, none, 0) === 'SCHEDULED');
  ck('21:00 → REGISTRATION_OPEN', T.statusAt(s.regOpenAt, s, none, 0) === 'REGISTRATION_OPEN');
  ck('21:59 → REGISTRATION_OPEN', T.statusAt(s.scheduledStartAt - 1, s, none, 2) === 'REGISTRATION_OPEN');
  ck('22:00 · 3명 → RUNNING', T.statusAt(s.scheduledStartAt, s, none, 3) === 'RUNNING');
  ck('22:00 · 2명 → WAITING_MIN_PLAYERS',
    T.statusAt(s.scheduledStartAt, s, none, 2) === 'WAITING_MIN_PLAYERS');
  ck('22:10 · 2명 → 계속 대기',
    T.statusAt(s.scheduledStartAt + 600, s, none, 2) === 'WAITING_MIN_PLAYERS');
  ck('22:10 · 3명 채워짐 → 즉시 RUNNING',
    T.statusAt(s.scheduledStartAt + 600, s, none, 3) === 'RUNNING');
  ck('22:20 · 2명 → CANCELLED', T.statusAt(s.graceEndsAt, s, none, 2) === 'CANCELLED');
  ck('22:25 · 2명 → CANCELLED', T.statusAt(s.graceEndsAt + 300, s, none, 2) === 'CANCELLED');

  // 저장된 "되돌릴 수 없는 사실"이 계산보다 우선한다
  const started: T.TournamentFacts = { startedAt: s.scheduledStartAt, finishedAt: null, cancelledAt: null };
  ck('시작 기록이 있으면 인원과 무관하게 RUNNING',
    T.statusAt(s.scheduledStartAt + 5000, s, started, 1) === 'RUNNING');
  const finished: T.TournamentFacts = {
    startedAt: s.scheduledStartAt, finishedAt: s.scheduledStartAt + 4000, cancelledAt: null,
  };
  ck('종료 기록이 있으면 FINISHED', T.statusAt(s.scheduledStartAt + 9999, s, finished, 5) === 'FINISHED');
  const cancelled: T.TournamentFacts = { startedAt: null, finishedAt: null, cancelledAt: s.graceEndsAt };
  ck('취소 기록이 있으면 CANCELLED', T.statusAt(s.graceEndsAt + 10, s, cancelled, 9) === 'CANCELLED');
  ck('취소 후 인원이 늘어도 되살아나지 않는다',
    T.statusAt(s.graceEndsAt + 600, s, cancelled, 9) === 'CANCELLED');
}

/* ── 12. 등록 · 늦은 등록 ───────────────────────────────────────── */
section('[12] 등록 · 늦은 등록');
{
  const s = T.scheduleForDate('2026-08-03');
  const none: T.TournamentFacts = { startedAt: null, finishedAt: null, cancelledAt: null };
  const started: T.TournamentFacts = { startedAt: s.scheduledStartAt, finishedAt: null, cancelledAt: null };

  ck('20:00 → 아직 안 열림', T.canRegister(s.regOpenAt - 3600, s, none, 0, 0).ok === false);
  ck('21:30 → 등록 가능', T.canRegister(s.regOpenAt + 1800, s, none, 1, 1).ok === true);
  ck('9명이면 자리 없음', T.canRegister(s.regOpenAt + 1800, s, none, 9, 9).ok === false);
  ck('시작 후 10분 · 빈자리 있음 → 늦은 등록 가능',
    T.canRegister(s.scheduledStartAt + 600, s, started, 5, 4).ok === true);
  ck('시작 후 23분 59초 → 아직 가능',
    T.canRegister(s.scheduledStartAt + 24 * 60 - 1, s, started, 5, 4).ok === true);
  ck('시작 후 정확히 24분 → 마감',
    T.canRegister(s.scheduledStartAt + 24 * 60, s, started, 5, 4).ok === false);
  {
    const r = T.canRegister(s.scheduledStartAt + 24 * 60, s, started, 5, 4);
    ck('마감 이유가 late_reg_closed', r.ok === false && r.reason === 'late_reg_closed', r.ok ? '' : r.reason);
  }
  ck('늦은 등록 창 안이지만 9명 꽉 참 → 거절',
    T.canRegister(s.scheduledStartAt + 600, s, started, 12, 9).ok === false);
  ck('탈락자가 생겨 8명이면 → 허용',
    T.canRegister(s.scheduledStartAt + 600, s, started, 12, 8).ok === true);
  ck('늦은 등록 남은 시간 (시작 후 4분 → 20분)',
    T.lateRegLeft(s.scheduledStartAt + 240, started) === 20 * 60,
    String(T.lateRegLeft(s.scheduledStartAt + 240, started)));
  ck('창이 닫히면 null', T.lateRegLeft(s.scheduledStartAt + 24 * 60, started) === null);
  ck('시작 전이면 null', T.lateRegLeft(s.regOpenAt, none) === null);
}

/* ── 13. 블라인드 구조 ──────────────────────────────────────────── */
section('[13] 블라인드 구조');
{
  ck('11단계', T.BLIND_LEVELS.length === 11, String(T.BLIND_LEVELS.length));
  ck('레벨 1 = 25/50', T.BLIND_LEVELS[0].sb === 25 && T.BLIND_LEVELS[0].bb === 50);
  ck('레벨 11 = 1000/2000 앤티 250',
    T.BLIND_LEVELS[10].sb === 1000 && T.BLIND_LEVELS[10].bb === 2000 && T.BLIND_LEVELS[10].ante === 250);
  ck('BB = SB × 2 (전 레벨)', T.BLIND_LEVELS.every(l => l.bb === l.sb * 2));
  ck('블라인드가 단조 증가', T.BLIND_LEVELS.every((l, i) => i === 0 || l.bb > T.BLIND_LEVELS[i - 1].bb));
  ck('앤티가 줄어들지 않는다', T.BLIND_LEVELS.every((l, i) => i === 0 || l.ante >= T.BLIND_LEVELS[i - 1].ante));

  ck('0초 → 레벨 1', T.levelAt(0).level === 1);
  ck('7분59초 → 레벨 1', T.levelAt(479).level === 1);
  ck('정확히 8분 → 레벨 2', T.levelAt(480).level === 2);
  ck('스펙 예시: 16분 → 레벨 3 (75/150 앤티 0)', (() => {
    const l = T.levelAt(960);
    return l.level === 3 && l.sb === 75 && l.bb === 150 && l.ante === 0;
  })(), JSON.stringify(T.levelAt(960)));
  ck('80분 → 레벨 11', T.levelAt(4800).level === 11);
  ck('11레벨을 넘겨도 마지막 레벨 유지 (블라인드 폭주 방지)',
    T.levelAt(99999).level === 11, String(T.levelAt(99999).level));
  ck('음수 경과도 레벨 1', T.levelAt(-100).level === 1);
  ck('다음 상승까지 (0초 → 480초)', T.nextLevelIn(0) === 480, String(T.nextLevelIn(0)));
  ck('다음 상승까지 (200초 → 280초)', T.nextLevelIn(200) === 280, String(T.nextLevelIn(200)));
  ck('마지막 레벨이면 null', T.nextLevelIn(4800) === null);
}

/* ── 14. ITM 인원 ───────────────────────────────────────────────── */
section('[14] ITM 인원');
{
  ck('3명 → 1명', T.itmCount(3) === 1);
  ck('4명 → 2명', T.itmCount(4) === 2);
  ck('5명 → 2명', T.itmCount(5) === 2);
  ck('6명 → 3명', T.itmCount(6) === 3);
  ck('8명 → 3명', T.itmCount(8) === 3);
  ck('9명 → ceil(9×0.4) = 4명', T.itmCount(9) === 4, String(T.itmCount(9)));
  ck('12명 → ceil(4.8) = 5명', T.itmCount(12) === 5, String(T.itmCount(12)));
  ck('20명 → 8명', T.itmCount(20) === 8, String(T.itmCount(20)));
  ck('100명 → 40명', T.itmCount(100) === 40, String(T.itmCount(100)));
  ck('ITM 비율이 40~45% 구간', [9, 12, 20, 50, 100].every(n => {
    const r = T.itmCount(n) / n;
    return r >= 0.40 && r <= 0.45;
  }));
  ck('ITM은 참가자 수를 넘지 않는다',
    Array.from({ length: 60 }, (_, i) => i + 1).every(n => T.itmCount(n) <= n));
}

/* ── 15. 상금 비율 ──────────────────────────────────────────────── */
section('[15] 상금 비율');
{
  for (const k of [1, 2, 3, 4, 5, 8, 10, 20, 40]) {
    const sh = T.prizeShares(k);
    const sum = sh.reduce((a, b) => a + b, 0);
    const mono = sh.every((v, i) => i === 0 || v <= sh[i - 1] + 1e-12);
    ck(`k=${k}: 합 1 · 단조 감소 · 1위 ${(sh[0] * 100).toFixed(1)}%`,
      Math.abs(sum - 1) < 1e-9 && mono, `합=${sum} 단조=${mono}`);
  }
  ck('1명이면 100%', T.prizeShares(1)[0] === 1);
  // 여기가 스펙을 그대로 따르면 안 되는 곳이다. 2명에게 40/60을 주면 2위가 더 받는다.
  ck('2명은 1위가 절반 초과 (2위가 더 받으면 안 된다)', T.prizeShares(2)[0] > 0.5);
  ck('3명 1위 50% 근처', Math.abs(T.prizeShares(3)[0] - 0.5) < 0.01);
  ck('4명 이상은 1위가 40~45%',
    [4, 5, 8, 10, 20, 40].every(k => { const t = T.prizeShares(k)[0]; return t >= 0.395 && t <= 0.455; }),
    [4, 5, 8, 10, 20, 40].map(k => k + ':' + (T.prizeShares(k)[0] * 100).toFixed(1)).join(' '));
  ck('모든 비율이 양수', [1, 2, 3, 4, 9, 40].every(k => T.prizeShares(k).every(v => v > 0)));
}

/* ── 16. 상금 금액 ──────────────────────────────────────────────── */
section('[16] 상금 금액 — 합이 정확히 상금 풀');
{
  const cases: [number, number][] = [
    [3000, 3], [4000, 4], [5000, 5], [6000, 6], [9000, 9],
    [18000, 9], [1, 3], [7, 4], [13, 6], [100, 9], [1_000_000, 40],
  ];
  let bad = 0;
  for (const [pool, players] of cases) {
    const amts = T.prizeAmounts(pool, players);
    const sum = amts.reduce((a, b) => a + b, 0);
    const mono = amts.every((v, i) => i === 0 || v <= amts[i - 1]);
    const ints = amts.every(v => Number.isInteger(v) && v >= 0);
    if (sum !== pool || !mono || !ints) {
      bad++; console.log(`    (${pool}P/${players}명) → ${JSON.stringify(amts)} 합=${sum}`);
    }
  }
  ck('표 사례 전부 합 일치 · 단조 감소 · 정수', bad === 0, `${bad}건 실패`);

  /* 무작위. 합이 상금 풀과 한 포인트라도 다르면 포인트가 새로 생기거나 사라진다 —
     내림만 하면 나머지가 사라지고, 올리면 없던 포인트가 발행된다. */
  let rbad = 0;
  for (let i = 0; i < 20_000; i++) {
    const players = 3 + randomInt(58);
    const pool = randomInt(200_000);
    const amts = T.prizeAmounts(pool, players);
    if (amts.reduce((a, b) => a + b, 0) !== pool) rbad++;
    if (amts.length !== T.itmCount(players)) rbad++;
    if (amts.some(v => v < 0 || !Number.isInteger(v))) rbad++;
  }
  ck('무작위 2만 건 — 합 = 상금 풀 · 인원 = ITM · 정수', rbad === 0, `${rbad}건`);

  console.log('\n  실제 예상 배분:');
  for (const n of [3, 4, 5, 6, 9]) {
    const pool = T.prizePool(n, T.WEEKDAY_MULTIPLIER);
    console.log(`    평일 ${n}명 (${pool.toLocaleString('ko-KR')}P) → ${JSON.stringify(T.prizeAmounts(pool, n))}`);
  }
  for (const n of [3, 5, 9]) {
    const pool = T.prizePool(n, T.WEEKEND_MULTIPLIER);
    console.log(`    주말 ${n}명 (${pool.toLocaleString('ko-KR')}P) → ${JSON.stringify(T.prizeAmounts(pool, n))}`);
  }
}

/* ── 17. 상금 풀 ────────────────────────────────────────────────── */
section('[17] 상금 풀');
{
  ck('누적 참가자 기준 (9명 × 1000 = 9000)', T.prizePool(9, 1000) === 9000);
  ck('주말 배수 (5명 × 2000 = 10000)', T.prizePool(5, 2000) === 10000);
  ck('늦은 등록으로 누적이 늘면 풀도 늘어난다 (12명 → 12000)', T.prizePool(12, 1000) === 12000);
  ck('0명이면 0', T.prizePool(0, 1000) === 0);
  ck('음수 방어', T.prizePool(-5, 1000) === 0);
}

console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
process.exit(fail ? 1 : 0);
