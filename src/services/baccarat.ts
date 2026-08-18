// 바카라(푼토 방코) — 규칙 판정과 확률 계산.
//
// 포커 플립과 결정적으로 다른 점: 바카라에는 플레이어가 내리는 선택이 하나도 없다.
// 몇 장을 더 받을지가 표(table)로 고정돼 있어서, 매 라운드 새 덱으로 딜하는 한
// 승/패/무 확률은 매 라운드 똑같다. 그래서 포커처럼 라운드마다 배당을 다시 계산할 필요가 없고,
// 프로세스 시작 때 한 번만 전수 계산해 캐시한다.
import { cardToString } from './poker';

/* 내부 친선 룰이라 1덱으로 둔다. 한 판이 끝나면 어차피 새 덱을 섞으므로(drawRound)
   덱을 여러 벌 쓸 이유가 없고, 1덱이면 한 판에 같은 카드가 두 번 나올 수 없다.
   아래 확률·배당 계산은 모두 이 값에서 유도되므로 여기만 바꾸면 전부 따라온다.
   (8덱이던 시절의 주석이 남아 있었다 — 값과 설명이 어긋나면 설명이 거짓말을 한다) */
export const DECKS = 1;
const CARDS_PER_DECK = 52;
export const SHOE_SIZE = DECKS * CARDS_PER_DECK;   // 1덱 = 52장

// 카드 인덱스(0~51)는 포커와 같은 인코딩을 쓴다: rank = c >> 2 (0='2' … 12='A'), suit = c & 3.
// 바카라 끗수는 A=1, 2~9는 숫자 그대로, 10·J·Q·K는 0.
export function cardValue(card: number): number {
  const rank = card >> 2;
  if (rank <= 7) return rank + 2;  // '2'~'9'
  if (rank === 12) return 1;       // 'A'
  return 0;                        // 'T','J','Q','K'
}
export function cardRank(card: number): number {
  return card >> 2;
}
export function handTotal(cards: number[]): number {
  return cards.reduce((s, c) => s + cardValue(c), 0) % 10;
}

export type Side = 'player' | 'banker' | 'tie';

/* ── 드로우 규칙 (푼토 방코 표준) ─────────────────────────────────────────
   양쪽 다 선택권이 없다. 아래 두 함수가 규칙 전부다.                        */

// 내추럴(첫 두 장 합이 8 또는 9)이면 양쪽 다 더 받지 않는다
function isNatural(total: number): boolean {
  return total === 8 || total === 9;
}

// 플레이어: 0~5면 한 장 더, 6~7이면 스탠드
export function playerDraws(playerTotal: number): boolean {
  return playerTotal <= 5;
}

// 뱅커: 플레이어가 세 번째 카드를 받았는지에 따라 표가 갈린다.
//   · 플레이어가 스탠드했으면 플레이어와 같은 규칙(0~5 드로우)
//   · 플레이어가 받았으면 그 카드의 끗수(p3)에 따라 달라진다
export function bankerDraws(bankerTotal: number, playerThird: number | null): boolean {
  if (playerThird === null) return bankerTotal <= 5;
  switch (bankerTotal) {
    case 0: case 1: case 2: return true;
    case 3: return playerThird !== 8;
    case 4: return playerThird >= 2 && playerThird <= 7;
    case 5: return playerThird >= 4 && playerThird <= 7;
    case 6: return playerThird === 6 || playerThird === 7;
    default: return false; // 7 이상은 스탠드
  }
}

export interface Outcome {
  winner: Side;
  playerCards: number[];
  bankerCards: number[];
  playerTotal: number;
  bankerTotal: number;
  playerPair: boolean;   // 첫 두 장이 같은 랭크
  bankerPair: boolean;
  natural: boolean;      // 첫 두 장에서 8 또는 9가 나와 바로 끝난 판
}

// 슈에서 순서대로 뽑은 카드 6장(최대)을 받아 규칙대로 판을 진행한다.
// 세 번째 카드가 필요 없으면 뒤쪽 카드는 그냥 쓰지 않는다.
export function playRound(drawn: number[]): Outcome {
  const p = [drawn[0], drawn[2]];
  const b = [drawn[1], drawn[3]];
  let next = 4;

  let pt = handTotal(p), bt = handTotal(b);
  const natural = isNatural(pt) || isNatural(bt);

  let playerThird: number | null = null;
  if (!natural) {
    if (playerDraws(pt)) {
      const c = drawn[next++];
      p.push(c);
      playerThird = cardValue(c);
      pt = handTotal(p);
    }
    if (bankerDraws(bt, playerThird)) {
      b.push(drawn[next++]);
      bt = handTotal(b);
    }
  }

  return {
    winner: pt > bt ? 'player' : bt > pt ? 'banker' : 'tie',
    playerCards: p, bankerCards: b,
    playerTotal: pt, bankerTotal: bt,
    playerPair: cardRank(p[0]) === cardRank(p[1]),
    bankerPair: cardRank(b[0]) === cardRank(b[1]),
    natural,
  };
}

/* ── 확률 전수 계산 ──────────────────────────────────────────────────────
   승패는 카드의 무늬·랭크가 아니라 끗수(0~9)에만 좌우된다. 그래서 52장이 아니라
   끗수 10종만 놓고 세면 된다. 끗수 구성은
     0끗: 랭크 네 개(10·J·Q·K) × 4장 × 덱 수   1~9끗: 각 4장 × 덱 수
   이 게임은 1덱이다 — 0끗 16장, 1~9끗 각 4장 = 52장
   비복원 추출이므로 뽑을 때마다 남은 장수로 가중치를 준다.
   최대 6장까지 가지치기해도 10^6 조합이라 수십 ms면 끝난다.                */
const VALUE_COUNTS = [16 * DECKS, ...Array.from({ length: 9 }, () => 4 * DECKS)];

export interface BaccaratProbabilities {
  player: number;
  banker: number;
  tie: number;
  pair: number;       // 한 쪽 핸드의 첫 두 장이 같은 랭크일 확률 (양쪽 동일)
  natural: number;    // 첫 두 장에서 결판난 판의 비율 (표시용)
}

let cached: BaccaratProbabilities | null = null;

export function baccaratProbabilities(): BaccaratProbabilities {
  if (cached) return cached;

  const counts = VALUE_COUNTS.slice();
  let remaining = SHOE_SIZE;
  let pWin = 0, bWin = 0, tie = 0, naturalW = 0;

  // 끗수 하나를 뽑고(가중치 누적) 콜백을 부른 뒤 되돌린다
  function each(fn: (v: number, w: number) => void): void {
    for (let v = 0; v < 10; v++) {
      const n = counts[v];
      if (n === 0) continue;
      const w = n / remaining;
      counts[v]--; remaining--;
      fn(v, w);
      counts[v]++; remaining++;
    }
  }

  each((p1, w1) => each((b1, w2) => each((p2, w3) => each((b2, w4) => {
    const w = w1 * w2 * w3 * w4;
    const pt0 = (p1 + p2) % 10, bt0 = (b1 + b2) % 10;

    // 내추럴이면 더 받지 않고 여기서 끝
    if (isNatural(pt0) || isNatural(bt0)) {
      naturalW += w;
      if (pt0 > bt0) pWin += w; else if (bt0 > pt0) bWin += w; else tie += w;
      return;
    }

    const settle = (pt: number, bt: number, ww: number) => {
      if (pt > bt) pWin += ww; else if (bt > pt) bWin += ww; else tie += ww;
    };

    if (!playerDraws(pt0)) {
      // 플레이어 스탠드 → 뱅커만 0~5에서 한 장
      if (!bankerDraws(bt0, null)) { settle(pt0, bt0, w); return; }
      each((b3, w5) => settle(pt0, (bt0 + b3) % 10, w * w5));
      return;
    }

    // 플레이어가 세 번째 카드를 받는다
    each((p3, w5) => {
      const pt = (pt0 + p3) % 10;
      const ww = w * w5;
      if (!bankerDraws(bt0, p3)) { settle(pt, bt0, ww); return; }
      each((b3, w6) => settle(pt, (bt0 + b3) % 10, ww * w6));
    });
  }))));

  const total = pWin + bWin + tie;
  // 페어는 승패와 무관한 사이드 마켓이라 따로 구한다.
  // 한 핸드의 두 번째 카드가 첫 카드와 같은 랭크일 확률 = (같은 랭크 남은 장수) / (남은 전체)
  //   1덱이면 랭크당 4장 → 3 / 51
  const pair = (DECKS * 4 - 1) / (SHOE_SIZE - 1);

  cached = {
    player: pWin / total,
    banker: bWin / total,
    tie: tie / total,
    pair,
    natural: naturalW / total,
  };
  return cached;
}

/* ── 슈에서 카드 뽑기 ────────────────────────────────────────────────── */

// 라운드마다 새 슈를 섞어 쓴다. 슈를 이어서 쓰면 남은 카드를 세는 사람이 유리해지는데
// (실제 카지노의 카운팅), 그러면 위에서 구한 고정 확률과 실제 확률이 어긋난다.
export function drawRound(randomInt: (max: number) => number): number[] {
  const shoe: number[] = [];
  for (let d = 0; d < DECKS; d++) {
    for (let c = 0; c < CARDS_PER_DECK; c++) shoe.push(c);
  }
  // 필요한 건 최대 6장이므로 슈 전체를 섞지 않고 앞 6장만 뽑는다(부분 피셔-예이츠)
  const out: number[] = [];
  for (let i = 0; i < 6; i++) {
    const j = i + randomInt(shoe.length - i);
    const t = shoe[i]; shoe[i] = shoe[j]; shoe[j] = t;
    out.push(shoe[i]);
  }
  return out;
}

export function cardsToStrings(cards: number[]): string[] {
  return cards.map(cardToString);
}
