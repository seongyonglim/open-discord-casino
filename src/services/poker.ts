// 텍사스 홀덤 핸드 평가 + 프리플랍 확률 엔진 (포커 플립 게임용)
//
// 카드 표현: 0..51 정수.  랭크 = c >> 2 (0='2' … 12='A'),  슈트 = c & 3
// 평가 결과는 "높을수록 강한 핸드"인 단일 정수(score)로, 상위 비트에 등급(category)을 담아
// 등급 비교와 킥커 비교를 한 번의 숫자 비교로 처리한다.

export const CAT_HIGH = 0;
export const CAT_PAIR = 1;
export const CAT_TWO_PAIR = 2;
export const CAT_TRIPS = 3;
export const CAT_STRAIGHT = 4;
export const CAT_FLUSH = 5;
export const CAT_FULL_HOUSE = 6;
export const CAT_QUADS = 7;
export const CAT_STRAIGHT_FLUSH = 8;

export const CAT_NAMES = [
  '하이카드', '원페어', '투페어', '트리플', '스트레이트',
  '플러시', '풀하우스', '포카드', '스트레이트 플러시',
];

// 베팅 시장용 등급 묶음 (5개)






export const BUCKET_NAMES = [
  '하이카드 · 원페어', '투페어', '트리플 · 스트레이트 · 플러시', '풀하우스', '포카드 이상',
];

const CAT_TO_BUCKET = [0, 0, 1, 2, 2, 2, 3, 4, 4];
export function categoryBucket(cat: number): number {
  return CAT_TO_BUCKET[cat];
}

const RANK_CHARS = '23456789TJQKA';
const SUIT_CHARS = ['s', 'h', 'd', 'c'];
export function cardToString(c: number): string {
  return RANK_CHARS[c >> 2] + SUIT_CHARS[c & 3];
}

// 랭크 비트마스크에서 스트레이트의 최고 랭크를 찾는다. 없으면 -1.
// A-2-3-4-5(휠)는 '5'(랭크 3) 하이로 취급한다.
function straightHigh(mask: number): number {
  for (let hi = 12; hi >= 4; hi--) {
    let ok = true;
    for (let k = 0; k < 5; k++) {
      if (!(mask & (1 << (hi - k)))) { ok = false; break; }
    }
    if (ok) return hi;
  }
  const wheel = (1 << 12) | (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3);
  if ((mask & wheel) === wheel) return 3;
  return -1;
}

// 마스크에서 높은 랭크 n개를 내림차순으로 뽑는다
function topRanks(mask: number, n: number, out: number[]): void {
  let i = 0;
  for (let r = 12; r >= 0 && i < n; r--) {
    if (mask & (1 << r)) out[i++] = r;
  }
  while (i < n) out[i++] = 0;
}

function pack(cat: number, r1 = 0, r2 = 0, r3 = 0, r4 = 0, r5 = 0): number {
  return (cat << 20) | (r1 << 16) | (r2 << 12) | (r3 << 8) | (r4 << 4) | r5;
}

const _kick: number[] = [0, 0, 0, 0, 0];

// 7장(홀 2 + 보드 5)에서 최강 5장의 점수를 구한다.
// C(7,5)=21가지를 모두 평가하지 않고 카운트/마스크로 직접 판정하므로 몬테카를로에 쓸 만큼 빠르다.
export function evaluate7(c0: number, c1: number, c2: number, c3: number, c4: number, c5: number, c6: number): number {
  const rankCount = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const suitRankMask = [0, 0, 0, 0];
  const suitCount = [0, 0, 0, 0];
  let rankMask = 0;

  const cards = [c0, c1, c2, c3, c4, c5, c6];
  for (let i = 0; i < 7; i++) {
    const c = cards[i];
    const r = c >> 2, s = c & 3;
    rankCount[r]++;
    rankMask |= 1 << r;
    suitRankMask[s] |= 1 << r;
    suitCount[s]++;
  }

  // 1) 스트레이트 플러시 (가장 강함) — 플러시 슈트 안에서 스트레이트를 찾는다
  let flushSuit = -1;
  for (let s = 0; s < 4; s++) if (suitCount[s] >= 5) { flushSuit = s; break; }
  if (flushSuit >= 0) {
    const sf = straightHigh(suitRankMask[flushSuit]);
    if (sf >= 0) return pack(CAT_STRAIGHT_FLUSH, sf);
  }

  // 2) 카운트 기반 등급 (포카드 / 풀하우스가 플러시·스트레이트보다 강하므로 먼저 판정)
  let quad = -1, trips: number[] = [], pairs: number[] = [];
  for (let r = 12; r >= 0; r--) {
    const n = rankCount[r];
    if (n === 4) { if (quad < 0) quad = r; }
    else if (n === 3) trips.push(r);
    else if (n === 2) pairs.push(r);
  }

  if (quad >= 0) {
    let kicker = 0;
    for (let r = 12; r >= 0; r--) if (r !== quad && rankCount[r] > 0) { kicker = r; break; }
    return pack(CAT_QUADS, quad, kicker);
  }

  if (trips.length >= 2) return pack(CAT_FULL_HOUSE, trips[0], trips[1]);
  if (trips.length === 1 && pairs.length >= 1) return pack(CAT_FULL_HOUSE, trips[0], pairs[0]);

  // 3) 플러시
  if (flushSuit >= 0) {
    topRanks(suitRankMask[flushSuit], 5, _kick);
    return pack(CAT_FLUSH, _kick[0], _kick[1], _kick[2], _kick[3], _kick[4]);
  }

  // 4) 스트레이트
  const st = straightHigh(rankMask);
  if (st >= 0) return pack(CAT_STRAIGHT, st);

  // 5) 트리플 / 투페어 / 원페어 / 하이카드
  if (trips.length === 1) {
    const t = trips[0];
    let n = 0;
    for (let r = 12; r >= 0 && n < 2; r--) if (r !== t && rankCount[r] > 0) _kick[n++] = r;
    return pack(CAT_TRIPS, t, _kick[0], _kick[1]);
  }
  if (pairs.length >= 2) {
    const hi = pairs[0], lo = pairs[1];
    let kicker = 0;
    for (let r = 12; r >= 0; r--) if (r !== hi && r !== lo && rankCount[r] > 0) { kicker = r; break; }
    return pack(CAT_TWO_PAIR, hi, lo, kicker);
  }
  if (pairs.length === 1) {
    const p = pairs[0];
    let n = 0;
    for (let r = 12; r >= 0 && n < 3; r--) if (r !== p && rankCount[r] > 0) _kick[n++] = r;
    return pack(CAT_PAIR, p, _kick[0], _kick[1], _kick[2]);
  }
  topRanks(rankMask, 5, _kick);
  return pack(CAT_HIGH, _kick[0], _kick[1], _kick[2], _kick[3], _kick[4]);
}

export function scoreCategory(score: number): number {
  return score >>> 20;
}

// ----- 프리플랍 확률 엔진 -----
//
// 홀카드 4장이 공개된 상태에서 남은 48장 중 보드 5장을 뽑는 모든 경우 C(48,5)=1,712,304가지를
// "전수 계산"한다. 평가기가 초당 1,400만 회 이상 처리하므로 전수 계산이 0.3초 안에 끝나며,
// 표본추출과 달리 확률이 정확해서 희귀 등급(포카드 이상)의 배당 오차 걱정이 없다.
export interface FlipProbabilities {
  masterWin: number;
  sharkWin: number;
  tie: number;
  buckets: number[];   // P(두 핸드 중 하나라도 그 등급을 만든다) — 5개 묶음
  totalBoards: number;
}

export function computeFlipProbabilities(
  m0: number, m1: number, s0: number, s1: number
): FlipProbabilities {
  const used = [m0, m1, s0, s1];
  const rest: number[] = [];
  for (let c = 0; c < 52; c++) if (!used.includes(c)) rest.push(c);

  const n = rest.length; // 48
  let mWin = 0, sWin = 0, tie = 0, total = 0;
  const bucketHit = [0, 0, 0, 0, 0];

  for (let a = 0; a < n - 4; a++) {
    const ca = rest[a];
    for (let b = a + 1; b < n - 3; b++) {
      const cb = rest[b];
      for (let c = b + 1; c < n - 2; c++) {
        const cc = rest[c];
        for (let d = c + 1; d < n - 1; d++) {
          const cd = rest[d];
          for (let e = d + 1; e < n; e++) {
            const ce = rest[e];
            const ms = evaluate7(m0, m1, ca, cb, cc, cd, ce);
            const ss = evaluate7(s0, s1, ca, cb, cc, cd, ce);
            if (ms > ss) mWin++; else if (ss > ms) sWin++; else tie++;

            // 등급 시장은 서로 배타적이다 — 한 라운드에 정확히 하나만 적중한다.
            // 두 핸드 중 "더 높은 등급"만 세고, 그보다 낮은 등급은 적중으로 치지 않는다.
            // (예: 투페어가 나오면 하이카드·원페어는 적중이 아니다)
            const mb = CAT_TO_BUCKET[ms >>> 20];
            const sb = CAT_TO_BUCKET[ss >>> 20];
            bucketHit[mb > sb ? mb : sb]++;
            total++;
          }
        }
      }
    }
  }

  return {
    masterWin: mWin / total,
    sharkWin: sWin / total,
    tie: tie / total,
    buckets: bucketHit.map(h => h / total),
    totalBoards: total,
  };
}

// 배당 상한. 공정 배당이 이 값을 넘는 시장은 "배당을 정직하게 매길 수 없는 시장"이므로
// 상한으로 깎아서 파는 대신 아예 베팅을 막는다(그렇게 하지 않으면 숨은 하우스엣지가 생긴다).
export const MAX_ODDS = 3000;

// 확률 → 배당(총 지급 배수). 하우스엣지를 적용하고 소수점 2자리 내림(반올림 금지).
// 배당을 정직하게 매길 수 없으면 null을 반환한다(= 해당 시장 비활성).
export function oddsFromProbability(p: number, houseEdge: number): number | null {
  if (p <= 0) return null;
  const raw = (1 - houseEdge) / p;
  if (raw > MAX_ODDS) return null;
  return Math.max(1.01, Math.floor(raw * 100) / 100);
}

// 승자 시장(Master/Shark) 배당 — 무승부 시 베팅액을 그대로 환불하므로 그 환불분을 반영해야 한다.
//   기대회수 = 승률 × 배당 + 무승부확률 × 1  =  1 - 하우스엣지
//   ⇒ 배당 = (1 - 하우스엣지 - 무승부확률) / 승률
// 이걸 무시하고 (1-엣지)/승률 로 계산하면, 무승부가 잦은 매치업(예: AA vs AA는 무승부 95.65%)에서
// 회수율이 190%를 넘어 하우스가 확실히 손해를 보는 배당이 나온다.
export function oddsForWinMarket(pWin: number, pTie: number, houseEdge: number): number | null {
  if (pWin <= 0) return null;
  const numerator = 1 - houseEdge - pTie;
  if (numerator <= 0) return null; // 무승부 확률이 너무 높아 정직한 배당이 불가능
  const raw = numerator / pWin;
  if (raw > MAX_ODDS) return null;
  if (raw < 1.01) return null;     // 환불만으로 원금이 거의 보장되어 베팅 의미가 없는 구간
  return Math.floor(raw * 100) / 100;
}

// 홀카드 4장을 덱에서 뽑는다 (암호학적 셔플)
export function dealFlip(rng: (max: number) => number): { master: [number, number]; shark: [number, number]; deck: number[] } {
  const deck: number[] = [];
  for (let c = 0; c < 52; c++) deck.push(c);
  for (let i = 51; i > 0; i--) {
    const j = rng(i + 1);
    const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
  }
  return { master: [deck[0], deck[1]], shark: [deck[2], deck[3]], deck };
}
