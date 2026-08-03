/* 노리밋 텍사스 홀덤 한 판(핸드)의 규칙.
 *
 * 이 파일은 순수 함수만 둔다 — DB도, 시각도, 난수도 여기서 만들지 않는다.
 * 이유는 두 가지다:
 *  · 포커 규칙에서 틀리기 쉬운 곳(베팅 라운드 종료 판정, 최소 레이즈, 사이드 팟)을
 *    DB 없이 표로 검증할 수 있다. 실제로 사이드 팟은 손으로 짜면 거의 항상 틀린다.
 *  · 토너먼트 엔진과 완전히 분리된다(스펙 9항). 이 파일은 토너먼트를 모른다.
 *
 * 카드 표현은 포커 플립과 같다: rank*4 + suit (rank 0='2' … 8='T' 9='J' 10='Q' 11='K' 12='A').
 * 그래서 7장 평가기(evaluate7)를 그대로 쓴다 — 홀덤 엔진에서 가장 어려운 조각이 이미 있다.
 */
import { evaluate7, cardToString } from './poker';

export type Street = 'preflop' | 'flop' | 'turn' | 'river';
export type SeatState = 'active' | 'folded' | 'allin' | 'out';
export type ActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';

export const STREETS: Street[] = ['preflop', 'flop', 'turn', 'river'];
// 스트리트별로 보드에 깔리는 누적 장수
export const BOARD_COUNT: Record<Street, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };

export interface SeatView {
  seat: number;
  /** 이 스트리트에 이미 낸 금액 */
  bet: number;
  /** 남은 스택 */
  stack: number;
  /** 이 핸드에 총 투입한 금액 (사이드 팟 계산의 유일한 근거) */
  committed: number;
  state: SeatState;
  /** 이 스트리트에서 한 번이라도 행동했는가 — 라운드 종료 판정에 쓴다 */
  acted: boolean;
}

/* ── 베팅 라운드 ─────────────────────────────────────────────────────
   "다음에 누가 행동하나"와 "라운드가 끝났나"는 규칙에서 제일 자주 틀리는 곳이다.
   판정 근거를 하나로 못 박아 둔다:

     라운드는 (a) 아직 행동할 수 있는 사람이 1명 이하이거나
              (b) 살아있는 모두가 이 스트리트에 한 번은 행동했고
                  각자 낸 금액이 현재 최고 베팅과 같을 때 끝난다.

   (b)의 "한 번은 행동했고"가 없으면 빅블라인드가 프리플랍에서 행동 기회를 잃는다 —
   BB는 이미 최고 베팅과 같은 금액을 냈지만 레이즈할 권리가 남아 있다(옵션). */

/** 지금 행동할 수 있는 자리 — 베팅으로 더 낼 수 있는 사람만 */
export function canAct(s: SeatView): boolean {
  return s.state === 'active';
}

/** from 다음(시계방향)으로 행동 가능한 첫 자리. 없으면 null. */
export function nextActor(seats: SeatView[], from: number, seatCount: number): number | null {
  for (let i = 1; i <= seatCount; i++) {
    const seat = (from + i) % seatCount;
    const s = seats.find(x => x.seat === seat);
    if (s && canAct(s)) return seat;
  }
  return null;
}

/** 이 스트리트의 최고 베팅액 */
export function highBet(seats: SeatView[]): number {
  return seats.reduce((m, s) => (s.bet > m ? s.bet : m), 0);
}

/** 아직 팟을 다툴 수 있는(폴드하지 않은) 자리 수 — 올인 포함 */
export function contenders(seats: SeatView[]): SeatView[] {
  return seats.filter(s => s.state === 'active' || s.state === 'allin');
}

export function bettingRoundClosed(seats: SeatView[]): boolean {
  const live = contenders(seats);
  if (live.length <= 1) return true;                 // 한 명만 남았다 — 팟을 가져간다
  const actors = seats.filter(canAct);
  if (actors.length === 0) return true;              // 전부 올인 — 더 낼 사람이 없다
  const hb = highBet(seats);
  // 행동할 수 있는 사람이 딱 한 명이고 이미 최고 베팅을 맞춰놨다면 더 물어볼 게 없다
  if (actors.length === 1 && actors[0].acted && actors[0].bet === hb) return true;
  return actors.every(s => s.acted && s.bet === hb);
}

/** 이 자리가 지금 할 수 있는 행동들. UI 버튼과 서버 검증이 같은 함수를 쓴다. */
export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  /** 콜에 필요한 금액 (스택이 부족하면 스택 전부 = 올인 콜) */
  callAmount: number;
  canCall: boolean;
  /** 베팅/레이즈로 이 스트리트에 올릴 수 있는 최소 총액. 불가면 null */
  minRaiseTo: number | null;
  /** 올릴 수 있는 최대 총액(= 내 스택 전부) */
  maxRaiseTo: number;
  /** 이번 행동이 베팅인가(앞에 베팅이 없었다) 레이즈인가 */
  raiseIsBet: boolean;
}

/**
 * @param lastRaiseSize 이 스트리트의 마지막 "인상폭". 노리밋의 최소 레이즈는
 *   "직전 인상폭만큼 더" 올리는 것이다. 프리플랍 시작 시엔 빅블라인드가 인상폭이다.
 */
export function legalActions(
  me: SeatView, seats: SeatView[], lastRaiseSize: number, bigBlind: number
): LegalActions {
  const hb = highBet(seats);
  const toCall = Math.max(0, hb - me.bet);
  const callAmount = Math.min(toCall, me.stack);
  const step = Math.max(lastRaiseSize, bigBlind);
  const maxRaiseTo = me.bet + me.stack;              // 올인했을 때의 이 스트리트 총액
  // 최소 레이즈 목표액. 스택이 모자라면 올인만 가능하므로 minRaiseTo를 올인액으로 낮춘다.
  let minRaiseTo: number | null = hb + step;
  if (minRaiseTo > maxRaiseTo) minRaiseTo = maxRaiseTo > hb ? maxRaiseTo : null;
  // 나 말고 더 낼 수 있는 사람이 없으면 올려도 의미가 없다(콜만 남는다)
  const othersCanRespond = contenders(seats).some(s => s.seat !== me.seat && s.state === 'active');
  if (!othersCanRespond && minRaiseTo != null && toCall === 0) minRaiseTo = null;
  return {
    canFold: true,
    canCheck: toCall === 0,
    callAmount,
    canCall: toCall > 0 && me.stack > 0,
    minRaiseTo,
    maxRaiseTo,
    raiseIsBet: hb === 0,
  };
}

export interface ApplyResult {
  ok: true;
  kind: ActionKind;
  /** 스택에서 실제로 빠져나간 금액 */
  paid: number;
  /** 이 행동으로 갱신된 인상폭 (레이즈가 아니면 그대로) */
  lastRaiseSize: number;
  /** 레이즈였다면 true — 다른 사람들의 acted를 풀어야 한다 */
  reopened: boolean;
}
export type ApplyError =
  | 'not_your_turn' | 'cannot_check' | 'nothing_to_call' | 'below_min_raise'
  | 'above_stack' | 'cannot_raise';

/**
 * 한 자리의 행동을 seats에 반영한다(제자리 수정).
 * `amount`는 "이 스트리트에 올릴 총액"이다. 추가로 내는 금액이 아니다 —
 * 실제 포커 UI가 "Raise to 300"으로 말하는 그 300이다. 차액으로 받으면
 * 클라이언트가 내 현재 베팅을 잘못 알고 있을 때 조용히 다른 금액이 나간다.
 */
export function applyAction(
  seats: SeatView[], seat: number, kind: ActionKind, amount: number,
  lastRaiseSize: number, bigBlind: number
): ApplyResult | { ok: false; error: ApplyError } {
  const me = seats.find(s => s.seat === seat);
  if (!me || !canAct(me)) return { ok: false, error: 'not_your_turn' };
  const la = legalActions(me, seats, lastRaiseSize, bigBlind);

  if (kind === 'fold') {
    me.state = 'folded';
    me.acted = true;
    return { ok: true, kind, paid: 0, lastRaiseSize, reopened: false };
  }

  if (kind === 'check') {
    if (!la.canCheck) return { ok: false, error: 'cannot_check' };
    me.acted = true;
    return { ok: true, kind, paid: 0, lastRaiseSize, reopened: false };
  }

  if (kind === 'call') {
    if (!la.canCall) return { ok: false, error: 'nothing_to_call' };
    const paid = la.callAmount;
    me.stack -= paid; me.bet += paid; me.committed += paid;
    me.acted = true;
    if (me.stack === 0) me.state = 'allin';
    return { ok: true, kind: me.state === 'allin' ? 'allin' : 'call', paid, lastRaiseSize, reopened: false };
  }

  // bet / raise / allin — 전부 "이 스트리트 총액을 amount로 만든다"로 처리한다
  const target = kind === 'allin' ? la.maxRaiseTo : Math.floor(amount);
  if (target > la.maxRaiseTo) return { ok: false, error: 'above_stack' };
  /* 올인은 언제나 legal이다 — 최소 레이즈에 못 미쳐도, 아예 최고 베팅에 못 미쳐도 된다
     (스택이 콜 금액보다 적으면 "올인 콜"이 된다). 그래서 minRaiseTo 검사보다 먼저 걸러낸다.
     처음엔 minRaiseTo가 null이면 무조건 막았는데, 그 탓에 최고 베팅에 못 미치는 짧은 올인이
     거절됐다 — 스택이 적은 사람이 콜조차 못 하게 되는 심각한 버그였다. */
  const isAllIn = target === la.maxRaiseTo;
  if (!isAllIn) {
    if (la.minRaiseTo == null) return { ok: false, error: 'cannot_raise' };
    if (target < la.minRaiseTo) return { ok: false, error: 'below_min_raise' };
  }

  const hb = highBet(seats);
  const paid = target - me.bet;
  if (paid <= 0) return { ok: false, error: 'below_min_raise' };
  me.stack -= paid; me.bet = target; me.committed += paid;
  me.acted = true;
  if (me.stack === 0) me.state = 'allin';

  /* 인상폭 갱신과 "행동 기회 재개".
     최고 베팅을 넘겼을 때만 다른 사람의 acted를 풀어 다시 물어본다.
     올인이 최고 베팅을 못 넘긴 경우(짧은 올인 콜)는 재개하지 않는다 — 실제 규칙이다. */
  const raisedOver = target > hb;
  const newRaiseSize = raisedOver ? target - hb : lastRaiseSize;
  if (raisedOver) {
    for (const s of seats) if (s.seat !== seat && s.state === 'active') s.acted = false;
  }
  return {
    ok: true,
    kind: isAllIn ? 'allin' : la.raiseIsBet ? 'bet' : 'raise',
    paid, lastRaiseSize: newRaiseSize, reopened: raisedOver,
  };
}

/* ── 사이드 팟 ───────────────────────────────────────────────────────
   여러 명이 서로 다른 금액으로 올인하면 팟이 층으로 갈린다.
   근거는 오직 committed(이 핸드에 총 투입한 금액)다. 스트리트별 bet으로 계산하면
   스트리트가 넘어갈 때 정보가 사라져서 틀린다.

   층을 만드는 방법: 폴드하지 않은 사람들의 committed를 오름차순으로 훑으며,
   각 금액 구간마다 "그 구간까지 낸 모든 사람(폴드한 사람 포함)"의 돈을 모은다.
   폴드한 사람의 돈도 팟에 들어가야 한다 — 다만 그들은 팟을 다툴 자격이 없다. */
export interface Pot {
  amount: number;
  /** 이 팟을 다툴 자격이 있는 자리 (폴드하지 않고 이 층까지 돈을 낸 사람) */
  eligible: number[];
}

export function buildPots(seats: SeatView[]): Pot[] {
  const live = seats.filter(s => s.state !== 'folded' && s.committed > 0);
  /* 층의 경계는 "누구든 낸 서로 다른 투입액"이다 — 폴드한 사람의 투입액도 경계가 된다.
     살아있는 사람 기준으로만 층을 자르면, 그들보다 많이 낸 폴드 칩이 어느 층에도
     담기지 않아 조용히 사라진다(무작위 검사에서 20,000회 중 306회 총액이 어긋났다). */
  const levels = [...new Set(seats.filter(s => s.committed > 0).map(s => s.committed))]
    .sort((a, b) => a - b);
  const pots: Pot[] = [];
  let prev = 0;
  for (const lv of levels) {
    const slice = lv - prev;
    let amount = 0;
    for (const s of seats) {
      if (s.committed <= prev) continue;
      amount += Math.min(s.committed - prev, slice);   // 폴드한 사람의 돈도 포함
    }
    const eligible = live.filter(s => s.committed >= lv).map(s => s.seat);
    if (amount > 0) pots.push({ amount, eligible });
    prev = lv;
  }
  /* 자격자가 똑같은 인접 층은 합친다. 폴드 칩 때문에 생긴 경계는 자격자를 바꾸지 않으므로
     합쳐야 실제 카지노가 말하는 팟 구성(메인 + 사이드)과 같아진다. */
  const merged: Pot[] = [];
  for (const p of pots) {
    const last = merged[merged.length - 1];
    if (last && last.eligible.length === p.eligible.length
        && last.eligible.every((e, i) => e === p.eligible[i])) {
      last.amount += p.amount;
    } else merged.push(p);
  }
  return merged;
}

/* ── 쇼다운 ──────────────────────────────────────────────────────────
   각 팟을 자격자 중 최고 핸드가 나눠 갖는다. 나눌 때 1칩 단위로 딱 안 나뉘면
   나머지는 버튼 왼쪽(= 버튼 다음 자리)부터 시계방향으로 한 칩씩 준다 — 실제 규칙이다.
   내림으로 버려버리면 칩이 사라져서 총량이 안 맞는다. */
export interface Award { seat: number; amount: number }

export function handScore(hole: number[], board: number[]): number {
  return evaluate7(hole[0], hole[1], board[0], board[1], board[2], board[3], board[4]);
}

export function awardPots(
  pots: Pot[],
  scoreBySeat: Map<number, number>,   // 폴드하지 않은 자리의 핸드 점수 (높을수록 강함)
  buttonSeat: number,
  seatCount: number,
): Award[] {
  const bySeat = new Map<number, number>();
  const add = (seat: number, n: number) => bySeat.set(seat, (bySeat.get(seat) ?? 0) + n);

  // 홀수 칩 배분 순서: 버튼 다음 자리부터 시계방향
  const order = (seat: number) => (seat - buttonSeat - 1 + seatCount * 2) % seatCount;

  for (const pot of pots) {
    const scored = pot.eligible
      .filter(s => scoreBySeat.has(s))
      .map(s => ({ seat: s, score: scoreBySeat.get(s)! }));
    if (!scored.length) continue;
    const best = Math.max(...scored.map(x => x.score));
    const winners = scored.filter(x => x.score === best).map(x => x.seat).sort((a, b) => order(a) - order(b));
    const share = Math.floor(pot.amount / winners.length);
    let rest = pot.amount - share * winners.length;
    for (const w of winners) {
      add(w, share + (rest > 0 ? 1 : 0));
      if (rest > 0) rest--;
    }
  }
  return [...bySeat].map(([seat, amount]) => ({ seat, amount })).sort((a, b) => a.seat - b.seat);
}

/* ── 블라인드 위치 ───────────────────────────────────────────────────
   헤즈업(2인)은 예외다: 버튼이 스몰블라인드를 내고 프리플랍에 먼저 행동한다.
   3인 이상은 버튼 다음이 SB, 그 다음이 BB, 프리플랍 첫 행동은 BB 다음이다.
   이 예외를 안 넣으면 토너먼트 막판 1대1에서 블라인드가 뒤집힌다. */
export interface BlindPositions { sb: number; bb: number; firstToAct: number }

export function blindPositions(occupied: number[], buttonSeat: number, seatCount: number): BlindPositions | null {
  const live = [...occupied].sort((a, b) => a - b);
  if (live.length < 2) return null;
  const after = (from: number, steps: number): number => {
    let seat = from;
    for (let n = 0; n < steps; n++) {
      for (let i = 1; i <= seatCount; i++) {
        const cand = (seat + i) % seatCount;
        if (live.includes(cand)) { seat = cand; break; }
      }
    }
    return seat;
  };
  if (live.length === 2) {
    const sb = buttonSeat;
    const bb = after(buttonSeat, 1);
    return { sb, bb, firstToAct: sb };
  }
  const sb = after(buttonSeat, 1);
  const bb = after(buttonSeat, 2);
  return { sb, bb, firstToAct: after(buttonSeat, 3) };
}

/** 플랍 이후 첫 행동은 항상 버튼 왼쪽(SB 자리)부터다. 헤즈업도 마찬가지로 BB가 아닌 쪽이 아니라 SB가 아닌... */
export function firstToActPostflop(occupied: number[], buttonSeat: number, seatCount: number): number | null {
  const live = [...occupied].sort((a, b) => a - b);
  if (!live.length) return null;
  // 헤즈업 포함 모든 경우: 버튼 다음 자리부터 시계방향으로 첫 생존자.
  // 헤즈업에서 버튼=SB이므로 플랍 이후엔 BB가 먼저 행동한다 — 실제 규칙 그대로다.
  for (let i = 1; i <= seatCount; i++) {
    const cand = (buttonSeat + i) % seatCount;
    if (live.includes(cand)) return cand;
  }
  return live[0];
}

/** 다음 버튼 자리 — 생존자 중 현재 버튼 다음 */
export function nextButton(occupied: number[], buttonSeat: number, seatCount: number): number | null {
  if (!occupied.length) return null;
  for (let i = 1; i <= seatCount; i++) {
    const cand = (buttonSeat + i) % seatCount;
    if (occupied.includes(cand)) return cand;
  }
  return occupied[0];
}

/** 카드 배열을 사람이 읽는 표기로 (클라이언트 전송용) */
export function cardsToStrings(cards: number[]): string[] {
  return cards.map(cardToString);
}

/** 52장 덱을 섞는다. 홀덤은 매 핸드 새 덱이다(슈를 쓰지 않는다). */
export function shuffleDeck(randomInt: (max: number) => number): number[] {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
  }
  return deck;
}
