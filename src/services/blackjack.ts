// 블랙잭 — 손패 계산, 딜러 규칙, 정산.
//
// 다른 게임과 결정적으로 다른 점: 하우스 엣지를 우리가 배당으로 만들지 않는다.
// 블랙잭의 엣지는 규칙 자체에서 나온다 — 플레이어가 먼저 행동해서 버스트하면 딜러가
// 카드를 받기도 전에 지기 때문이다(더블 버스트가 딜러 승). 그래서 배당은 손대지 않고
// 실제 카지노와 같은 값을 쓴다: 승 1:1, 블랙잭 3:2, 무승부 원금 환불.
// 딜러가 소프트 17에서 스탠드(S17)하는 규칙이라 기본 전략 기준 하우스 엣지는 0.5% 안팎이다.
import { cardToString } from './poker';

/* 내부 친선 룰이라 1덱으로 둔다. 한 판이 끝나면 어차피 새로 섞으므로 덱을 여러 벌
   쓸 이유가 없고, 1덱이면 한 판에 같은 카드가 두 번 나올 수 없다.

   단 1덱은 한 판에 소진될 수 있다. 5석 + 딜러 = 6핸드가 저가 카드를 계속 받으면
   52장을 넘길 수 있어서, 커서를 그냥 되감으면(예전 방식) 그 순간부터 같은 카드가
   다시 나온다 — 1덱으로 바꾸는 목적 자체가 무너진다.
   그래서 drawCard가 소진 시점에 "지금 테이블에 나와 있는 카드를 뺀 나머지"로
   새로 섞어 이어간다(src/db/queries.ts). */
export const DECKS = 1;
export const SHOE_SIZE = DECKS * 52;

// 카드 인덱스(0~51)는 포커·바카라와 같은 인코딩: rank = c >> 2 (0='2' … 12='A')
export function cardRank(card: number): number { return card >> 2; }
export function isAce(card: number): boolean { return cardRank(card) === 12; }

// 그림카드는 10, A는 일단 1로 세고 나중에 10을 더할지 정한다
export function baseValue(card: number): number {
  const r = cardRank(card);
  if (r <= 7) return r + 2;   // '2'~'9'
  if (r === 12) return 1;     // 'A'
  return 10;                  // 'T','J','Q','K'
}

export interface HandTotal {
  total: number;
  soft: boolean;   // A를 11로 세고도 21을 넘지 않는 상태 (한 번은 더 받아도 안전하다)
  bust: boolean;
}

/* A는 1 또는 11이다. 11로 세도 21을 넘지 않을 때만 11로 친다.
   A를 여러 장 들어도 11로 셀 수 있는 건 최대 한 장이다(두 장이면 22라 이미 넘는다). */
export function handTotal(cards: number[]): HandTotal {
  let total = 0, aces = 0;
  for (const c of cards) {
    total += baseValue(c);
    if (isAce(c)) aces++;
  }
  let soft = false;
  if (aces > 0 && total + 10 <= 21) { total += 10; soft = true; }
  return { total, soft, bust: total > 21 };
}

// 블랙잭 = 처음 받은 두 장이 A + 10끗. 세 장으로 만든 21은 블랙잭이 아니다.
export function isBlackjack(cards: number[]): boolean {
  return cards.length === 2 && handTotal(cards).total === 21;
}

/* 딜러는 선택권이 없다. 16 이하면 반드시 받고, 17 이상이면 반드시 선다.
   소프트 17(A+6)에서도 선다(S17) — 플레이어에게 유리한 쪽 규칙이다. */
export function dealerShouldHit(cards: number[]): boolean {
  return handTotal(cards).total < 17;
}

export type HandOutcome = 'blackjack' | 'win' | 'push' | 'lose' | 'bust';

/* 정산. 돌려주는 값은 "배수"다 — 실제 지급액은 베팅액 × 이 값(내림).
     블랙잭 2.5 (3:2 배당 + 원금)   승 2   무승부 1 (원금 환불)   패 0            */
export function settleHand(player: number[], dealer: number[]): { outcome: HandOutcome; multiplier: number } {
  const p = handTotal(player), d = handTotal(dealer);
  const pBJ = isBlackjack(player), dBJ = isBlackjack(dealer);

  // 플레이어 버스트는 딜러가 무엇을 들었든 진다 — 이게 블랙잭 하우스 엣지의 원천이다
  if (p.bust) return { outcome: 'bust', multiplier: 0 };
  if (pBJ && dBJ) return { outcome: 'push', multiplier: 1 };
  if (pBJ) return { outcome: 'blackjack', multiplier: 2.5 };
  if (dBJ) return { outcome: 'lose', multiplier: 0 };
  if (d.bust) return { outcome: 'win', multiplier: 2 };
  if (p.total > d.total) return { outcome: 'win', multiplier: 2 };
  if (p.total < d.total) return { outcome: 'lose', multiplier: 0 };
  return { outcome: 'push', multiplier: 1 };
}

/* ── 슈 ──────────────────────────────────────────────────────────────────
   블랙잭은 몇 장이 필요한지 미리 알 수 없다(각자 원하는 만큼 힛한다).
   그래서 바카라처럼 필요한 만큼만 뽑을 수 없고, 라운드 시작에 슈를 통째로 섞어두고
   커서를 하나씩 밀며 꺼내 쓴다.

   슈의 순서는 앞으로 나올 카드 전부라서 절대 클라이언트로 내려보내면 안 된다.
   (딜러 홀 카드 한 장이 아니라 남은 판 전체가 새는 셈이다)                        */
export function shuffleShoe(randomInt: (max: number) => number): number[] {
  const shoe: number[] = [];
  for (let d = 0; d < DECKS; d++) for (let c = 0; c < 52; c++) shoe.push(c);
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const t = shoe[i]; shoe[i] = shoe[j]; shoe[j] = t;
  }
  return shoe;
}

export function cardsToStrings(cards: number[]): string[] {
  return cards.map(cardToString);
}
