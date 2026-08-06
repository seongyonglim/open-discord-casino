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
section('[14] ITM 인원 (30%)');
{
  ck('비율 상수가 30%', T.ITM_RATIO === 0.3, String(T.ITM_RATIO));
  ck('3명 → ceil(0.9) = 1명', T.itmCount(3) === 1);
  ck('4명 → ceil(1.2) = 2명', T.itmCount(4) === 2);
  ck('5명 → ceil(1.5) = 2명', T.itmCount(5) === 2);
  ck('6명 → ceil(1.8) = 2명', T.itmCount(6) === 2, String(T.itmCount(6)));
  ck('7명 → ceil(2.1) = 3명', T.itmCount(7) === 3, String(T.itmCount(7)));
  ck('8명 → ceil(2.4) = 3명', T.itmCount(8) === 3);
  ck('9명 → ceil(2.7) = 3명', T.itmCount(9) === 3, String(T.itmCount(9)));
  ck('10명 → 3명', T.itmCount(10) === 3, String(T.itmCount(10)));
  ck('11명 → ceil(3.3) = 4명', T.itmCount(11) === 4, String(T.itmCount(11)));
  ck('20명 → 6명', T.itmCount(20) === 6, String(T.itmCount(20)));
  ck('100명 → 30명', T.itmCount(100) === 30, String(T.itmCount(100)));
  /* 실제 비율은 올림 때문에 30%를 넘을 수 있다. 넘는 폭의 상한은 1/n이다
     (ceil이 최대 1명을 더 올리므로). 인원이 적을 때 43%까지 가는 건 정상이다 —
     7명은 ceil(2.1)=3명이라 43%다. 그래서 고정 구간이 아니라 이 성질로 검증한다. */
  ck('ITM 비율이 30% 이상, 30% + 1/n 이하',
    Array.from({ length: 100 }, (_, i) => i + 4).every(n => {
      const r = T.itmCount(n) / n;
      return r >= 0.30 - 1e-9 && r <= 0.30 + 1 / n + 1e-9;
    }),
    [7, 10, 20, 50, 100].map(n => n + ':' + (T.itmCount(n) / n * 100).toFixed(0) + '%').join(' '));
  ck('인원이 늘면 30%에 수렴 (100명 30% · 1000명 30%)',
    T.itmCount(100) / 100 === 0.30 && T.itmCount(1000) / 1000 === 0.30,
    `${T.itmCount(100)} / ${T.itmCount(1000)}`);
  ck('ITM은 참가자 수를 넘지 않는다',
    Array.from({ length: 60 }, (_, i) => i + 1).every(n => T.itmCount(n) <= n));
  ck('항상 최소 1명은 받는다',
    Array.from({ length: 60 }, (_, i) => i + 1).every(n => T.itmCount(n) >= 1));
  ck('0명이면 0명', T.itmCount(0) === 0);
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
section('[16] 상금 금액 — 합이 정확히 상금 풀 (최대잉여법)');
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

  /* 최대잉여법이 실제로 의도한 비율에 맞는 숫자를 내는지.
     1위부터 나머지를 얹던 예전 방식은 65/35 배분을 2,601/1,399로 만들었다. */
  ck('4명 4,000P → 2,600 / 1,400 (예전엔 2,601 / 1,399)',
    JSON.stringify(T.prizeAmounts(4000, 4)) === '[2600,1400]', JSON.stringify(T.prizeAmounts(4000, 4)));
  ck('5명 5,000P → 3,250 / 1,750',
    JSON.stringify(T.prizeAmounts(5000, 5)) === '[3250,1750]', JSON.stringify(T.prizeAmounts(5000, 5)));
  ck('6명 6,000P → 3,900 / 2,100 (ITM 2명)',
    JSON.stringify(T.prizeAmounts(6000, 6)) === '[3900,2100]', JSON.stringify(T.prizeAmounts(6000, 6)));
  ck('9명 9,000P → 4,500 / 2,781 / 1,719 (ITM 3명)',
    JSON.stringify(T.prizeAmounts(9000, 9)) === '[4500,2781,1719]', JSON.stringify(T.prizeAmounts(9000, 9)));
  ck('주말 5명 10,000P → 6,500 / 3,500',
    JSON.stringify(T.prizeAmounts(10000, 5)) === '[6500,3500]', JSON.stringify(T.prizeAmounts(10000, 5)));

  /* 무작위. 합이 상금 풀과 한 포인트라도 다르면 포인트가 새로 생기거나 사라진다 —
     내림만 하면 나머지가 사라지고, 올리면 없던 포인트가 발행된다. */
  let rbad = 0;
  for (let i = 0; i < 20_000; i++) {
    const players = 3 + randomInt(58);
    const pool = randomInt(200_000);
    const amts = T.prizeAmounts(pool, players);
    if (amts.reduce((a, b) => a + b, 0) !== pool) rbad++;
    /* 상금 풀이 0이면 나눌 것이 없으니 빈 배열이 맞다 — 실제로는 풀이 최소
       3,000P(3명 × 1,000)라 0이 될 수 없지만, 무작위 표본에는 섞여 들어온다.
       예전엔 길이를 무조건 ITM 인원과 비교해서 이 경우를 실패로 봤다. */
    if (pool > 0 && amts.length !== T.itmCount(players)) rbad++;
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

/* ── 18b. 화면에 보여줄 팟 층 (potLayers) ────────────────────────
   정산용 buildPots를 화면에 그대로 쓰면, 투입액이 다를 때마다 층을 자르기 때문에
   스몰·빅 블라인드만 낸 상태에서도 "사이드 팟"이 생긴다 — 올인한 사람이 없는데도.
   사이드 팟은 올인이 뚜껑을 덮었을 때만 존재한다. */
section('[18b] 화면용 팟 층 — 사이드 팟은 올인이 있을 때만');
{
  const sum = (ps: H.Pot[]) => ps.reduce((a, p) => a + p.amount, 0);

  // 블라인드만 낸 상태 — 층은 하나여야 한다
  {
    const s = [seat(0, 0, 10000, 0), seat(1, 25, 9975, 25), seat(2, 50, 9950, 50)];
    const L = H.potLayers(s);
    ck('블라인드만 있으면 층이 하나 (사이드 팟 없음)', L.length === 1, JSON.stringify(L));
    ck('그래도 합계는 정산과 같다', sum(L) === sum(H.buildPots(s)), `${sum(L)} vs ${sum(H.buildPots(s))}`);
    ck('buildPots는 이 상태에서 층을 나눈다 (이게 화면에 쓰면 안 되는 이유)',
      H.buildPots(s).length === 2, JSON.stringify(H.buildPots(s)));
  }
  // 올인이 있지만 아무도 그 위로 더 내지 않았다 — 뚜껑 위가 비어 있으니 층은 하나
  {
    const s = [seat(0, 500, 0, 500, 'allin'), seat(1, 500, 9500, 500), seat(2, 500, 9500, 500)];
    const L = H.potLayers(s);
    ck('올인 금액을 아무도 넘지 않으면 층이 하나', L.length === 1 && L[0].amount === 1500,
      JSON.stringify(L));
    ck('자격은 세 명 모두', L[0].eligible.join() === '0,1,2', JSON.stringify(L[0].eligible));
  }
  // 올인 위로 돈이 쌓였다 — 여기서부터 사이드 팟이다
  {
    const s = [seat(0, 500, 0, 500, 'allin'), seat(1, 2000, 8000, 2000), seat(2, 2000, 8000, 2000)];
    const L = H.potLayers(s);
    ck('올인 위로 쌓인 돈이 사이드 팟이 된다', L.length === 2, JSON.stringify(L));
    ck('메인 = 올인 금액 × 3 = 1500 · 자격 3인',
      L[0].amount === 1500 && L[0].eligible.join() === '0,1,2', JSON.stringify(L[0]));
    ck('사이드 = 나머지 3000 · 올인한 사람은 자격 없음',
      L[1].amount === 3000 && L[1].eligible.join() === '1,2', JSON.stringify(L[1]));
    ck('합계 = 정산 합계', sum(L) === sum(H.buildPots(s)));
  }
  // 올인 두 명 — 교과서 3층
  {
    const s = [seat(0, 100, 0, 100, 'allin'), seat(1, 500, 0, 500, 'allin'), seat(2, 1000, 9000, 1000)];
    const L = H.potLayers(s);
    ck('올인 두 명이면 3층', L.length === 3, JSON.stringify(L));
    ck('층 금액 300 / 800 / 500',
      L[0].amount === 300 && L[1].amount === 800 && L[2].amount === 500, JSON.stringify(L.map(p => p.amount)));
    ck('합계 = 정산 합계', sum(L) === sum(H.buildPots(s)));
  }
  // 폴드한 사람의 돈도 층에 담기지만 자격은 없다
  {
    const s = [seat(0, 0, 9900, 100, 'folded'), seat(1, 200, 0, 200, 'allin'), seat(2, 200, 9800, 200)];
    const L = H.potLayers(s);
    ck('폴드한 돈도 팟에 포함 (100+200+200=500)', sum(L) === 500, JSON.stringify(L));
    ck('폴드한 사람은 어느 층에도 자격이 없다',
      L.every(p => !p.eligible.includes(0)), JSON.stringify(L));
  }
  ck('아무도 안 냈으면 층이 없다', H.potLayers([seat(0, 0, 100, 0)]).length === 0);

  /* 무작위 검사 — 화면 합계와 정산 합계가 어긋나면 팟 숫자가 거짓말을 한다.
     그리고 올인이 없는 판에서는 절대 층이 갈라져선 안 된다(이번 버그의 본질). */
  let sumBad = 0, splitWithoutAllin = 0;
  for (let i = 0; i < 20_000; i++) {
    const n = 2 + randomInt(8);
    const seats: H.SeatView[] = [];
    for (let k = 0; k < n; k++) {
      const committed = randomInt(3000);
      const roll = randomInt(10);
      const state: H.SeatState = roll < 3 ? 'folded' : roll < 6 ? 'allin' : 'active';
      seats.push(seat(k, 0, randomInt(1000), committed, state, true));
    }
    const L = H.potLayers(seats);
    if (sum(L) !== sum(H.buildPots(seats))) sumBad++;
    const anyAllin = seats.some(s => s.state === 'allin');
    if (!anyAllin && L.length > 1) splitWithoutAllin++;
  }
  ck('무작위 20,000판 — 화면 합계 = 정산 합계', sumBad === 0, `${sumBad}건`);
  ck('올인이 없으면 절대 층이 갈라지지 않는다', splitWithoutAllin === 0, `${splitWithoutAllin}건`);
}

/* ── 18c. 극단 스택 차이의 사이드 팟 (500 / 1,500 / 8,000 / 20,000) ──
   스택이 40배까지 벌어진 전원 올인. 층이 넷으로 갈리고 맨 위층은 아무도 콜하지 않아
   되돌려줘야 한다. 손으로 짜면 거의 항상 틀리는 자리라 강함 순서 24가지를 전수로 돈다.

   단정은 두 가지다:
     (a) 아무도 자기가 딸 수 있는 최대치보다 많이 받지 않는다
         — A는 자기 투입액만큼만 남에게서 딸 수 있으므로 상한이 정해진다
     (b) 나간 칩의 합 = 받은 칩의 합 (반환액 포함) */
section('[18c] 극단 사이드 팟 — 500 / 1,500 / 8,000 / 20,000');
{
  const S = [500, 1500, 8000, 20_000];
  const NM = 'ABCD';
  const TOTAL = S.reduce((a, b) => a + b, 0);
  const mk = () => S.map((c, i): H.SeatView =>
    ({ seat: i, bet: c, stack: 0, committed: c, state: 'allin', acted: true }));

  // 화면 표시용 층 (반환 전) — 넷으로 갈려야 한다
  {
    const L = H.potLayers(mk());
    ck('화면 층이 4개 (올인이 셋의 뚜껑을 만든다)', L.length === 4, JSON.stringify(L.map(p => p.amount)));
    ck('메인 2,000 · 자격 4인',
      L[0].amount === 2000 && L[0].eligible.length === 4, JSON.stringify(L[0]));
    ck('SIDE1 3,000 · 자격 B,C,D',
      L[1].amount === 3000 && L[1].eligible.join() === '1,2,3', JSON.stringify(L[1]));
    ck('SIDE2 13,000 · 자격 C,D',
      L[2].amount === 13_000 && L[2].eligible.join() === '2,3', JSON.stringify(L[2]));
    ck('SIDE3 12,000 · 자격 D만 (아무도 콜하지 않은 층)',
      L[3].amount === 12_000 && L[3].eligible.join() === '3', JSON.stringify(L[3]));
    ck('층 합계 = 총 투입 30,000', L.reduce((a, p) => a + p.amount, 0) === TOTAL);
  }

  // 정산 — 초과분을 먼저 되돌리고 층을 만든다
  {
    const v = mk();
    const unc = H.returnUncalled(v);
    ck('D의 초과 12,000이 반환된다', unc != null && unc.seat === 3 && unc.amount === 12_000,
      JSON.stringify(unc));
    const pots = H.buildPots(v);
    ck('반환 후에는 팟이 3개', pots.length === 3, JSON.stringify(pots.map(p => p.amount)));
    ck('팟 합계 18,000 + 반환 12,000 = 30,000',
      pots.reduce((a, p) => a + p.amount, 0) + (unc?.amount ?? 0) === TOTAL);
  }

  /* 강함 순서 24가지 전수. 각자 딸 수 있는 최대치:
       A = 자기 500 × 4 = 2,000
       B = 메인 2,000 + SIDE1 3,000 = 5,000
       C = + SIDE2 13,000 = 18,000
       D = 전부 + 반환 = 30,000 */
  const CAP = [2000, 5000, 18_000, 30_000];
  const perms = (a: number[]): number[][] => a.length <= 1 ? [a]
    : a.flatMap((x, i) => perms(a.slice(0, i).concat(a.slice(i + 1))).map(p => [x, ...p]));
  let sumBad = 0, capBad = 0, orders = 0;
  for (const order of perms([0, 1, 2, 3])) {
    orders++;
    const v = mk();
    const unc = H.returnUncalled(v);
    const pots = H.buildPots(v);
    const scores = new Map<number, number>();
    order.forEach((seatNo, rank) => scores.set(seatNo, 100 - rank * 25));
    const got = [0, 0, 0, 0];
    for (const a of H.awardPots(pots, scores, 0, 9)) got[a.seat] += a.amount;
    if (unc) got[unc.seat] += unc.amount;
    if (got.reduce((a, b) => a + b, 0) !== TOTAL) sumBad++;
    for (let i = 0; i < 4; i++) if (got[i] > CAP[i]) capBad++;
  }
  ck(`강함 순서 ${orders}가지 전수 — 칩 보존`, sumBad === 0, `${sumBad}가지 어긋남`);
  ck('아무도 자기 상한보다 많이 받지 않는다 (A≤2,000 B≤5,000 C≤18,000 D≤30,000)',
    capBad === 0, `${capBad}건`);

  // 동점 — 같은 층을 나눠 가져도 칩이 보존되어야 한다
  {
    const cases: Array<[string, number[]]> = [
      ['A와 D가 동점', [100, 50, 50, 100]],
      ['C와 D가 동점(위 두 층을 나눈다)', [10, 20, 100, 100]],
      ['전원 동점', [50, 50, 50, 50]],
      ['B와 C가 동점', [10, 100, 100, 20]],
    ];
    for (const [name, sc] of cases) {
      const v = mk();
      const unc = H.returnUncalled(v);
      const pots = H.buildPots(v);
      const got = [0, 0, 0, 0];
      for (const a of H.awardPots(pots, new Map(sc.map((s, i) => [i, s])), 0, 9)) got[a.seat] += a.amount;
      if (unc) got[unc.seat] += unc.amount;
      const tot = got.reduce((a, b) => a + b, 0);
      ck(`${name} — 칩 보존 (${tot})`, tot === TOTAL, `${tot} vs ${TOTAL}`);
      ck(`${name} — 상한 준수`, got.every((g, i) => g <= CAP[i]), JSON.stringify(got));
    }
  }

  /* 무작위 극단 스택 — 위 한 조합만 맞고 다른 조합에서 틀리는 걸 막는다.
     스택 차이를 일부러 크게 벌린다(1 ~ 50,000). */
  let rSum = 0, rCap = 0;
  for (let i = 0; i < 20_000; i++) {
    const n = 2 + randomInt(8);
    const committed: number[] = [];
    for (let k = 0; k < n; k++) committed.push(1 + randomInt(50_000));
    const v = committed.map((c, k): H.SeatView =>
      ({ seat: k, bet: c, stack: 0, committed: c, state: 'allin', acted: true }));
    const total = committed.reduce((a, b) => a + b, 0);
    const unc = H.returnUncalled(v);
    const pots = H.buildPots(v);
    const scores = new Map<number, number>(v.map(s => [s.seat, randomInt(100)]));
    const got = new Array<number>(n).fill(0);
    for (const a of H.awardPots(pots, scores, 0, 9)) got[a.seat] += a.amount;
    if (unc) got[unc.seat] += unc.amount;
    if (got.reduce((a, b) => a + b, 0) !== total) rSum++;
    /* 한 사람이 딸 수 있는 최대 = 자기 투입액 이하로 낸 사람들의 전액 +
       자기보다 많이 낸 사람들에게서 자기 투입액만큼 */
    for (let k = 0; k < n; k++) {
      const cap = committed.reduce((a, c) => a + Math.min(c, committed[k]), 0);
      if (got[k] > cap) rCap++;
    }
  }
  ck('무작위 극단 스택 20,000판 — 칩 보존', rSum === 0, `${rSum}건`);
  ck('무작위 극단 스택 20,000판 — 상한 준수', rCap === 0, `${rCap}건`);
}

/* ── 18. 최강 5장 고르기 ─────────────────────────────────────────
   화면에서 "이 5장으로 이겼다"를 밝히려면 어느 카드가 쓰였는지 알아야 하는데,
   evaluate7은 점수만 준다. 그래서 5장 단위 평가(evaluate5)를 따로 두고 조합을 전개한다.

   두 함수가 갈라지면 화면에 강조된 5장과 실제 승자가 어긋난다 — 그것도 조용히.
   이 절의 첫 검사가 두 구현을 묶어 두는 유일한 장치다. */
section('[18] 최강 5장 (evaluate5 · bestFive · coreOfFive)');
{
  const P = require('../src/services/poker') as typeof import('../src/services/poker');
  let mismatch = 0, notSubset = 0, wrongLen = 0;
  const catSeen = new Array(9).fill(0);
  const N = 60_000;
  for (let i = 0; i < N; i++) {
    const deck = Array.from({ length: 52 }, (_, k) => k);
    for (let j = 51; j > 0; j--) { const k = randomInt(j + 1); const t = deck[j]; deck[j] = deck[k]; deck[k] = t; }
    const c = deck.slice(0, 7);
    const e7 = P.evaluate7(c[0], c[1], c[2], c[3], c[4], c[5], c[6]);
    const bf = P.bestFive(c);
    catSeen[e7 >>> 20]++;
    if (bf.score !== e7) mismatch++;
    if (bf.five.length !== 5) wrongLen++;
    else if (bf.five.some(x => !c.includes(x))) notSubset++;
  }
  ck(`7장 ${N.toLocaleString('ko-KR')}표본 — bestFive 점수 = evaluate7 점수`, mismatch === 0, `${mismatch}건 불일치`);
  ck('고른 것이 항상 5장', wrongLen === 0, `${wrongLen}건`);
  ck('고른 5장이 준 카드의 부분집합', notSubset === 0, `${notSubset}건`);
  ck('표본에 전 등급이 나왔다 (검사가 실제로 전 구간을 지난다)',
    catSeen.every(n => n > 0), catSeen.join(','));

  // 카드 문자열 → 인덱스 (감사 안에서만 쓰는 역변환)
  const s2c = (t: string) => '23456789TJQKA'.indexOf(t[0]) * 4 + ({ s: 0, h: 1, d: 2, c: 3 } as Record<string, number>)[t[1]];
  const set = (...t: string[]) => t.map(s2c);

  // coreOfFive — "등급을 만든 카드"만. 킥커는 빠진다.
  const pair = P.bestFive(set('Qs', 'Qd', '9h', '7c', '2s'));
  ck('원페어의 core는 2장 (킥커 제외)', P.coreOfFive(pair.five, pair.category).length === 2);
  const two = P.bestFive(set('Qs', 'Qd', '7h', '7c', '2s'));
  ck('투페어의 core는 4장', P.coreOfFive(two.five, two.category).length === 4);
  const trips = P.bestFive(set('Qs', 'Qd', 'Qh', '7c', '2s'));
  ck('트리플의 core는 3장', P.coreOfFive(trips.five, trips.category).length === 3);
  const fh = P.bestFive(set('Qs', 'Qd', 'Qh', '7c', '7s'));
  ck('풀하우스의 core는 5장', P.coreOfFive(fh.five, fh.category).length === 5);
  const fl = P.bestFive(set('As', 'Ks', '9s', '7s', '2s'));
  ck('플러시의 core는 5장', P.coreOfFive(fl.five, fl.category).length === 5);
  const straight = P.bestFive(set('9s', '8d', '7h', '6c', '5s'));
  ck('스트레이트의 core는 5장', P.coreOfFive(straight.five, straight.category).length === 5);
  const high = P.bestFive(set('As', 'Jd', '9h', '7c', '2s'));
  ck('하이카드의 core는 없다 (만든 게 없다)', P.coreOfFive(high.five, high.category).length === 0);

  /* readHand(진행 중 힌트)와 bestFive(결과)의 등급이 어긋나면
     "화면 글자는 플러시인데 강조는 스트레이트" 같은 모순이 나온다. */
  let catDiff = 0;
  for (let i = 0; i < 20_000; i++) {
    const deck = Array.from({ length: 52 }, (_, k) => k);
    for (let j = 51; j > 0; j--) { const k = randomInt(j + 1); const t = deck[j]; deck[j] = deck[k]; deck[k] = t; }
    const hole = deck.slice(0, 2);
    const boardLen = [3, 4, 5][randomInt(3)];
    const board = deck.slice(2, 2 + boardLen);
    const r = H.readHand(hole, board);
    const bf = P.bestFive(hole.concat(board));
    if (r.category !== bf.category) catDiff++;
  }
  ck('readHand 등급 = bestFive 등급 (플랍·턴·리버 20,000판)', catDiff === 0, `${catDiff}건`);

  // 강조 카드는 언제나 내 카드 + 보드 안에서만 나온다 (없는 카드를 밝히지 않는다)
  let outside = 0, tooMany = 0;
  for (let i = 0; i < 20_000; i++) {
    const deck = Array.from({ length: 52 }, (_, k) => k);
    for (let j = 51; j > 0; j--) { const k = randomInt(j + 1); const t = deck[j]; deck[j] = deck[k]; deck[k] = t; }
    const hole = deck.slice(0, 2);
    const board = deck.slice(2, 2 + [0, 3, 4, 5][randomInt(4)]);
    const mine = new Set(H.cardsToStrings(hole.concat(board)));
    const r = H.readHand(hole, board);
    if (r.highlight.some(c => !mine.has(c))) outside++;
    if (r.highlight.length > 5) tooMany++;
  }
  ck('강조 카드가 내 카드 + 보드 밖으로 나가지 않는다', outside === 0, `${outside}건`);
  ck('강조는 최대 5장', tooMany === 0, `${tooMany}건`);

  // 쇼다운 표기
  const sd = H.showdownHand(set('As', 'Ks'), set('Qs', 'Js', 'Ts', '2h', '4d'));
  ck('로열 플러시를 이름으로 구분한다', sd.name === '로열 플러시', sd.name);
  ck('쇼다운은 최강 5장을 그대로 준다', sd.five.length === 5, JSON.stringify(sd.five));
  const sdShort = H.showdownHand(set('As', 'Ks'), []);
  ck('보드가 없으면 쇼다운 표기가 비어 있다 (5장을 만들 수 없다)',
    sdShort.name === '' && sdShort.five.length === 0);
}

/* ── 19. 쇼다운 승률 · 역전 카드 ─────────────────────────────────
   화면에 퍼센트를 띄우는 순간 그 숫자는 "사실"로 읽힌다. 틀린 승률은 없는 것보다 나쁘다.
   그래서 손으로 답을 아는 상황과 맞춰 본다.

   덱 장수에 함정이 하나 있다. 흔히 쓰는 "아웃츠 / 46"의 46은 내 홀 카드만 아는 상황의
   수(52 - 2 - 4)다. 쇼다운은 상대 패까지 공개된 상태라 44장이다.
   처음에 46으로 기대값을 적었다가 이 절이 잡아냈다. */
section('[19] 쇼다운 승률 (equityAt · outsAt · equityStages)');
{
  const s2c = (t: string) => '23456789TJQKA'.indexOf(t[0]) * 4 + ({ s: 0, h: 1, d: 2, c: 3 } as Record<string, number>)[t[1]];
  const cs = (t: string) => t.split(' ').map(s2c);
  const P = require('../src/services/poker') as typeof import('../src/services/poker');

  /* AK vs 77, 보드 A K 2 3. AK는 투페어, 77은 원페어 — 77은 7이 떨어져야 이긴다(2장). */
  const ak77 = [{ seat: 0, hole: cs('As Ks') }, { seat: 1, hole: cs('7d 7c') }];
  {
    const board = cs('Ah Kd 2c 3s');
    const eq = H.equityAt(ak77, board)!;
    ck('승률의 합이 정확히 1', Math.abs(eq[0].equity + eq[1].equity - 1) < 1e-12);
    ck('77 = 2/44 (46이 아니다 — 상대 패도 공개돼 있다)',
      Math.abs(eq[1].equity - 2 / 44) < 1e-12, (eq[1].equity * 100).toFixed(2) + '%');
    ck('AK = 42/44', Math.abs(eq[0].equity - 42 / 44) < 1e-12);
    const outs = H.outsAt(ak77, board);
    ck('아웃츠는 지고 있는 쪽에만', outs.length === 1 && outs[0].seat === 1, JSON.stringify(outs));
    ck('아웃츠 2장 · 랭크 7', outs[0]?.count === 2 && outs[0]?.ranks.join('') === '7');
  }

  /* 같은 값의 홀 카드(무늬만 다름) — 어떤 리버가 와도 무승부다. 무승부를 나눠 갖는
     것으로 세지 않으면 합이 1이 되지 않는다. */
  {
    const same = [{ seat: 0, hole: cs('As Kh') }, { seat: 1, hole: cs('Ad Kc') }];
    const eq = H.equityAt(same, cs('2s 7h 9d Jc'))!;
    ck('항상 무승부인 매치업은 0.5 / 0.5',
      Math.abs(eq[0].equity - 0.5) < 1e-12 && Math.abs(eq[1].equity - 0.5) < 1e-12);
    ck('무승부는 win이 아니라 tie로 센다', eq[0].win === 0 && Math.abs(eq[0].tie - 1) < 1e-12);
    ck('앞선 쪽이 없으면 아웃츠도 없다', H.outsAt(same, cs('2s 7h 9d Jc')).length === 0);
  }

  /* 턴+리버 두 장 — 조합을 다른 방식으로 다시 세서 같은 답이 나오는지 본다.
     같은 식을 두 번 쓰는 게 아니라 루프를 따로 돌려 교차 검증하는 것이 목적이다. */
  {
    const board = cs('Ah Kd 2c');
    const eq = H.equityAt(ak77, board)!;
    const used = new Set([...board, ...ak77[0].hole, ...ak77[1].hole]);
    const deck: number[] = [];
    for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
    let n = 0, e0 = 0;
    for (let i = 0; i < deck.length; i++) {
      for (let j = i + 1; j < deck.length; j++) {
        const b = [...board, deck[i], deck[j]];
        const s0 = P.evaluate7(ak77[0].hole[0], ak77[0].hole[1], b[0], b[1], b[2], b[3], b[4]);
        const s1 = P.evaluate7(ak77[1].hole[0], ak77[1].hole[1], b[0], b[1], b[2], b[3], b[4]);
        n++;
        if (s0 > s1) e0 += 1; else if (s0 === s1) e0 += 0.5;
      }
    }
    ck('가짓수 C(45,2) = 990', n === 990, String(n));
    ck('따로 센 값과 완전히 일치', Math.abs(eq[0].equity - e0 / n) < 1e-12);
    ck('보드가 4장이 아니면 아웃츠를 내지 않는다 (두 장 남으면 장수로 말할 수 없다)',
      H.outsAt(ak77, board).length === 0);
  }

  // 세 명 이상에서도 합이 1이어야 한다 — 무승부 분배가 인원수를 따라가는지 본다
  {
    const three = [...ak77, { seat: 2, hole: cs('Th 9h') }];
    const e4 = H.equityAt(three, cs('Ah Kd 2c 3s'))!;
    ck('세 명 · 리버 — 합이 1', Math.abs(e4.reduce((a, x) => a + x.equity, 0) - 1) < 1e-12,
      e4.map(x => (x.equity * 100).toFixed(1)).join('/'));
    const e3 = H.equityAt(three, cs('Ah Kd 2c'))!;
    ck('세 명 · 턴+리버 — 합이 1', Math.abs(e3.reduce((a, x) => a + x.equity, 0) - 1) < 1e-12);
  }

  /* 15아웃 — 스트레이트 드로 + 플러시 드로가 겹친 유명한 상황.
     ♠ 9장 + 5 네 장 + T 네 장 - 겹치는 5♠·T♠ 두 장 = 15장.
     손으로 셀 수 있는 값이라 아웃츠 계산의 좋은 기준점이다. */
  {
    const drw = [{ seat: 0, hole: cs('9s 8s') }, { seat: 1, hole: cs('Ah Ad') }];
    const board = cs('7s 6s 2h Kc');
    const outs = H.outsAt(drw, board);
    ck('15아웃 (스트레이트 + 플러시 드로, 겹침 제외)',
      outs.length === 1 && outs[0].seat === 0 && outs[0].count === 15,
      JSON.stringify(outs));
    const eq = H.equityAt(drw, board)!;
    ck('승률 = 15/44 (교과서의 54%는 두 장 받을 때의 값이다)',
      Math.abs(eq[0].equity - 15 / 44) < 1e-12, (eq[0].equity * 100).toFixed(1) + '%');
  }

  // 프리플랍은 전수가 152만 가지라 표본을 쓴다. 널리 알려진 값에 가까운지 본다
  {
    const eq = H.equityAt(ak77, [], randomInt)!;
    ck('AKs vs 77 ≈ 48% (표본 오차 ±2%p)', Math.abs(eq[0].equity - 0.48) < 0.02,
      (eq[0].equity * 100).toFixed(1) + '%');
    ck('rng 없이는 프리플랍 승률을 내지 않는다 (추측을 사실처럼 내놓지 않는다)',
      H.equityAt(ak77, []) === null);
  }

  /* 단계 배열 — 화면이 보드를 한 장씩 열면서 쓰는 값이다.
     액션이 있던 스트리트의 단계를 만들면 안 된다 (그때는 결과가 카드에만 달려 있지 않았다). */
  {
    const fb = cs('Ah Kd 2c 3s 9h');
    /* 프리플랍 올인은 프리플랍 단계까지 만든다. 한동안 플랍부터였는데, 화면에서는
       핸드가 다 열린 뒤 플랍까지 2.5초가 비어 있고 그 구간이야말로 승률이 가장
       궁금한 자리다(카드 다섯 장이 통째로 남아 있다). */
    ck('프리플랍 올인 → 프리플랍·플랍·턴 세 단계',
      H.equityStages(ak77, fb, 0, randomInt).map(s => s.boardLen).join(',') === '0,3,4');
    ck('플랍 올인 → 플랍·턴 두 단계',
      H.equityStages(ak77, fb, 3, randomInt).map(s => s.boardLen).join(',') === '3,4');
    ck('턴 올인 → 턴 한 단계',
      H.equityStages(ak77, fb, 4, randomInt).map(s => s.boardLen).join(',') === '4');
    ck('리버 쇼다운 → 단계 없음 (보여줄 확률이 없다)',
      H.equityStages(ak77, fb, 5, randomInt).length === 0);
    ck('한 명만 남았으면 단계 없음',
      H.equityStages([ak77[0]], fb, 0, randomInt).length === 0);
    /* 아웃츠는 "한 장만 나오면 뒤집힌다"라서 남은 카드가 정확히 한 장인 턴에만 뜻이 있다.
       프리플랍·플랍 단계에는 붙지 않는다. */
    const st = H.equityStages(ak77, fb, 0, randomInt);
    ck('아웃츠는 턴 단계에만 붙는다',
      st.map(s => (s.boardLen + ':' + (s.outs ? 'Y' : 'N'))).join(' ') === '0:N 3:N 4:Y');
  }
}

console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
process.exit(fail ? 1 : 0);
