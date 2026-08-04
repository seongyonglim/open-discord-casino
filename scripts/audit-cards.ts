/* 카드 무결성 감사 — 한 게임에서 카드가 정당한 개수를 넘겨 나오지 않는지 실측한다.
 *
 * 배경: "블랙잭 한 판에 스페이드 K가 3장 나왔다"는 신고가 있었다. 블랙잭과 바카라는
 * 실제 카지노처럼 8덱 슈를 쓰므로 같은 카드가 최대 8장까지 나오는 것이 정상이다.
 * 반면 포커 플립과 홀덤은 52장 한 덱이라 같은 카드가 두 번 나오면 그건 버그다.
 * 이 감사는 그 경계를 숫자로 못 박는다 — 다시 의심할 필요가 없게.
 *
 * 검사하는 것
 *   1. 각 게임이 쓰는 덱 수 (상수와 실제 생성물이 일치하는가)
 *   2. 셔플 결과가 "각 카드가 정확히 덱 수만큼" 들어 있는가 (카드를 잃거나 만들지 않는가)
 *   3. 한 판에 실제로 배분된 카드가 덱 수를 넘지 않는가 (슈 커서가 같은 자리를 두 번 주지 않는가)
 *   4. 52장 덱 게임(포커 플립·홀덤)은 한 판에 같은 카드가 절대 두 번 나오지 않는가
 *   5. 셔플이 한쪽으로 치우치지 않는가 (섞지 않은 덱을 그대로 쓰고 있지 않은가)
 */
if (!process.env.DB_PATH) {
  const os = require('node:os'), path = require('node:path'), fsx = require('node:fs');
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'casino-cards-'));
  process.env.DB_PATH = dir;
}

import { randomInt } from 'node:crypto';
import { rmSync } from 'node:fs';
import { getDb } from '../src/db/schema';
import {
  upsertUser, adjustBalance,
  advanceBlackjackRound, seatBlackjackBet, blackjackAction, getBlackjackHands,
  advanceBaccaratRound,
  type BjHelpers,
} from '../src/db/queries';
import * as BJ from '../src/services/blackjack';
import * as BC from '../src/services/baccarat';
import * as PK from '../src/services/poker';
import * as HD from '../src/services/holdem';

let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
const db = getDb();

/** 카드 배열의 최다 중복 수 */
function maxDup(cards: number[]): number {
  const m = new Map<number, number>();
  for (const c of cards) m.set(c, (m.get(c) ?? 0) + 1);
  let max = 0;
  for (const n of m.values()) if (n > max) max = n;
  return max;
}
/** 중복된 카드를 사람이 읽는 이름으로.
 *  cardsToStrings를 쓴다 — services/holdem은 cardToString을 재수출하지 않는다.
 *  이 함수는 "중복을 찾았을 때만" 불리므로, 여기서 터지면 검사가 실패를 보고하는 대신
 *  통째로 죽는다. 실패 경로일수록 안전해야 한다. */
function dupNames(cards: number[], deckCount: number): string {
  const m = new Map<number, number>();
  for (const c of cards) m.set(c, (m.get(c) ?? 0) + 1);
  const over: string[] = [];
  for (const [c, n] of m) if (n > deckCount) over.push(`${HD.cardsToStrings([c])[0]}×${n}`);
  return over.join(', ');
}

console.log('[1] 덱 구성 — 상수와 실제 생성물이 일치하는가');
{
  ck('블랙잭은 8덱 슈다 (실제 카지노와 같다)', BJ.DECKS === 8, String(BJ.DECKS));
  ck('블랙잭 슈 크기 = 8 × 52 = 416', BJ.SHOE_SIZE === 416, String(BJ.SHOE_SIZE));
  ck('바카라는 8덱 슈다', BC.DECKS === 8, String(BC.DECKS));
  ck('바카라 슈 크기 = 416', BC.SHOE_SIZE === 416, String(BC.SHOE_SIZE));

  const shoe = BJ.shuffleShoe(randomInt);
  ck('블랙잭 슈가 416장이다', shoe.length === 416, String(shoe.length));
  const counts = new Map<number, number>();
  for (const c of shoe) counts.set(c, (counts.get(c) ?? 0) + 1);
  ck('블랙잭 슈에 52종이 전부 있다', counts.size === 52, String(counts.size));
  ck('블랙잭 슈의 모든 카드가 정확히 8장이다 (잃거나 만들지 않는다)',
    [...counts.values()].every(n => n === 8),
    [...counts.values()].filter(n => n !== 8).join(','));

  const deck = HD.shuffleDeck(randomInt);
  ck('홀덤은 52장 한 덱이다', deck.length === 52, String(deck.length));
  ck('홀덤 덱에 중복이 없다', new Set(deck).size === 52, String(new Set(deck).size));

  const flip = PK.dealFlip(randomInt);
  ck('포커 플립도 52장 한 덱이다', flip.deck.length === 52, String(flip.deck.length));
  ck('포커 플립 덱에 중복이 없다', new Set(flip.deck).size === 52, String(new Set(flip.deck).size));
}

console.log('\n[2] 52장 덱 게임 — 한 판에 같은 카드가 두 번 나오면 버그다');
{
  // 포커 플립: 공개되는 카드는 마스터 2 + 샤크 2 + 보드 5 = 9장
  let flipDup = 0, flipDetail = '';
  for (let i = 0; i < 3000; i++) {
    const f = PK.dealFlip(randomInt);
    const seen = [...f.master, ...f.shark, ...f.deck.slice(4, 9)];
    if (new Set(seen).size !== seen.length) { flipDup++; flipDetail = dupNames(seen, 1); }
  }
  ck('포커 플립 3,000판 — 공개 9장에 중복 0', flipDup === 0, `${flipDup}판 ${flipDetail}`);

  /* 홀덤은 52장 한 덱이므로 "덱 안에 중복이 없다"만으로는 부족하다 —
     딜링이 같은 인덱스를 두 번 쓰면 중복이 나온다. 그건 감사가 인덱스를 다시 쓰는
     방식으로는 검증할 수 없다(자기 코드를 검증하는 셈이다).
     그래서 실제 서버 딜링(startHand → advanceHoldem)이 남긴 값을 대조하는 것은
     audit-holdem-db.ts에 맡기고, 여기서는 덱 자체의 무결성만 반복 확인한다. */
  let deckBad = 0;
  for (let i = 0; i < 3000; i++) {
    const deck = HD.shuffleDeck(randomInt);
    if (deck.length !== 52 || new Set(deck).size !== 52) deckBad++;
    if (Math.min(...deck) !== 0 || Math.max(...deck) !== 51) deckBad++;
  }
  ck('홀덤 3,000회 셔플 — 항상 0~51 서로 다른 52장', deckBad === 0, `${deckBad}회`);
}

console.log('\n[3] 8덱 슈 게임 — 같은 카드는 최대 8장까지가 정상이다');
{
  // 바카라: 한 판에 최대 6장
  let over = 0, six = 0;
  for (let i = 0; i < 3000; i++) {
    const cards = BC.drawRound(randomInt);
    if (cards.length !== 6) six++;
    if (maxDup(cards) > BC.DECKS) { over++; }
  }
  ck('바카라 3,000판 — 항상 6장을 뽑는다', six === 0, `${six}판`);
  ck(`바카라 3,000판 — 같은 카드가 ${BC.DECKS}장을 넘지 않는다`, over === 0, `${over}판`);

  /* 부분 피셔-예이츠가 편향되지 않았는가.
     drawRound는 슈 416장을 다 섞지 않고 앞 6장만 뽑는다(j를 i부터 고른다).
     구현이 j를 0부터 고르면 앞자리가 편향되는데, 그건 분포로만 잡힌다. */
    const firstCard = new Map<number, number>();
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const c = BC.drawRound(randomInt)[0];
    firstCard.set(c, (firstCard.get(c) ?? 0) + 1);
  }
  const expect = N / 52;
  const devs = [...firstCard.values()].map(v => Math.abs(v - expect) / expect);
  const worstDev = Math.max(...devs);
  ck('바카라 부분 셔플이 편향되지 않았다 (첫 장 분포 20,000회)',
    firstCard.size === 52 && worstDev < 0.25,
    `${firstCard.size}종 · 최대 편차 ${(worstDev * 100).toFixed(1)}% (기대 ${expect}회)`);
}

console.log('\n[4] 실제 블랙잭 라운드 — DB를 거쳐 배분된 카드를 센다');
{
  const H: BjHelpers = {
    shuffle: () => BJ.shuffleShoe(randomInt),
    isBlackjack: BJ.isBlackjack,
    dealerShouldHit: BJ.dealerShouldHit,
    handTotal: (c: number[]) => { const t = BJ.handTotal(c); return { total: t.total, bust: t.bust }; },
    settle: BJ.settleHand,
  };
  const nowSec = () => Math.floor(Date.now() / 1000);
  const PLAYERS = [
    { id: 'c_a', seat: 0 }, { id: 'c_b', seat: 2 }, { id: 'c_c', seat: 4 },
  ];
  for (const p of PLAYERS) { upsertUser(p.id, p.id, null); adjustBalance(p.id, 5_000_000, 'test:seed'); }

  let rounds = 0, overDecks = 0, posReuse = 0, detail = '';
  let sawThreeSame = 0, maxSeen = 0;
  /* 목표 라운드 수를 채울 때까지 돈다. 시도 횟수를 고정하면 라운드가 엉뚱한 단계에
     있어 건너뛴 만큼 완주 수가 들쭉날쭉해진다(실측 33~120회). */
  const WANT_ROUNDS = 60;
  for (let r = 0; r < 600 && rounds < WANT_ROUNDS; r++) {
    /* 끝난 라운드는 공개 시간(BJ_REVEAL_SEC)이 지나야 다음 판이 열린다.
       감사는 기다리지 않으므로 그 시각을 과거로 밀어 바로 다음 판을 받는다. */
    let round = advanceBlackjackRound(H);
    for (let guard = 0; guard < 5 && round.phase === 'done'; guard++) {
      db.prepare(`UPDATE blackjack_rounds SET resolved_at = ? WHERE id = ?`)
        .run(nowSec() - 600, round.id);
      round = advanceBlackjackRound(H);
    }
    if (round.phase !== 'waiting' && round.phase !== 'betting') continue;
    // 3명이 함께 앉는다 — 사용자가 지적한 "여러 명이 참여한 판"을 그대로 재현한다
    let seated = 0;
    for (const p of PLAYERS) if (seatBlackjackBet(p.id, p.id, round.id, p.seat, 100).ok) seated++;
    if (seated === 0) continue;
    db.prepare(`UPDATE blackjack_rounds SET betting_ends_at = ? WHERE id = ?`).run(nowSec() - 1, round.id);
    round = advanceBlackjackRound(H);

    // 전원 최대한 힛해서 카드를 많이 뽑게 한다 (중복이 생길 여지를 최대로 만든다)
    for (let step = 0; step < 40; step++) {
      const hands = getBlackjackHands(round.id);
      const playing = hands.filter(h => h.status === 'playing');
      if (!playing.length) break;
      for (const h of playing) {
        const cards = JSON.parse(h.cards_json) as number[];
        if (BJ.handTotal(cards).total < 17) blackjackAction(h.user_id, round.id, 'hit', H);
        else blackjackAction(h.user_id, round.id, 'stand', H);
      }
    }
    // 딜러까지 마무리
    for (let step = 0; step < 20; step++) {
      const cur = db.prepare(`SELECT * FROM blackjack_rounds WHERE id = ?`).get(round.id) as
        { phase: string; dealer_json: string; shoe_json: string; shoe_pos: number };
      if (cur.phase === 'done') {
        rounds++;
        const dealer = JSON.parse(cur.dealer_json) as number[];
        const hands = getBlackjackHands(round.id);
        const all = [...dealer];
        for (const h of hands) all.push(...(JSON.parse(h.cards_json) as number[]));
        const dup = maxDup(all);
        if (dup > maxSeen) maxSeen = dup;
        if (dup >= 3) sawThreeSame++;
        if (dup > BJ.DECKS) { overDecks++; detail = dupNames(all, BJ.DECKS); }
        /* 이게 이 감사의 핵심 단정문이다.
           실제로 배분된 카드가 "슈의 앞 shoe_pos장"과 정확히 같은 다중집합인지 본다.
           커서가 같은 자리를 두 번 주면 어떤 카드가 늘고 어떤 카드가 빠져서 어긋나고,
           슈에 없는 카드를 만들어내도 어긋난다. 감사가 딜링을 다시 구현하지 않고
           서버가 실제로 남긴 shoe_json·shoe_pos와 대조하므로 자기충족적이지 않다. */
        const shoe = JSON.parse(cur.shoe_json) as number[];
        const expected = shoe.slice(0, cur.shoe_pos);
        const key = (a: number[]) => a.slice().sort((x, y) => x - y).join(',');
        if (all.length !== cur.shoe_pos) { posReuse++; detail = `배분 ${all.length}장 ≠ 커서 ${cur.shoe_pos}`; }
        else if (key(all) !== key(expected)) {
          posReuse++;
          detail = `배분 카드가 슈 앞 ${cur.shoe_pos}장과 다르다`;
        }
        break;
      }
      db.prepare(`UPDATE blackjack_rounds SET betting_ends_at = ? WHERE id = ?`)
        .run(nowSec() - 60, round.id);
      advanceBlackjackRound(H);
    }
  }
  console.log(`    ${rounds}라운드 완주 · 3명 동시 참여 · 한 판 최다 동일 카드 ${maxSeen}장`);
  ck(`라운드가 실제로 돌았다 (검증이 헛돌지 않았다)`, rounds >= WANT_ROUNDS, `${rounds}/${WANT_ROUNDS}라운드`);
  ck('배분 장수 = 슈 커서 위치 (같은 자리를 두 번 주지 않는다)', posReuse === 0, detail);
  ck(`한 판에 같은 카드가 ${BJ.DECKS}장을 넘지 않는다`, overDecks === 0, detail);
  /* 8덱이면 같은 카드가 3장 나오는 일은 드물지만 실재한다 — 신고가 버그가 아니었음을
     숫자로 남겨 둔다. 이 판정이 0이면 "그런 일이 없다"가 아니라 표본이 작다는 뜻이다. */
  console.log(`    같은 카드가 3장 이상 나온 판: ${sawThreeSame}/${rounds}`);
}

console.log('\n[5] 실제 바카라 라운드 — DB를 거쳐 배분된 카드를 센다');
{
  let rounds = 0, over = 0, detail = '';
  const nowSec = () => Math.floor(Date.now() / 1000);
  for (let r = 0; r < 200; r++) {
    const round = advanceBaccaratRound(
      () => BC.drawRound(randomInt),
      (cards: number[]) => BC.playRound(cards),
    );
    db.prepare(`UPDATE baccarat_rounds SET betting_ends_at = ? WHERE id = ?`).run(nowSec() - 60, round.id);
    const done = advanceBaccaratRound(
      () => BC.drawRound(randomInt),
      (cards: number[]) => BC.playRound(cards),
    );
    const cur = db.prepare(`SELECT cards_json FROM baccarat_rounds WHERE id = ?`).get(done.id) as
      { cards_json: string } | undefined;
    if (!cur?.cards_json) continue;
    const cards = JSON.parse(cur.cards_json) as number[];
    if (!cards.length) continue;
    rounds++;
    if (maxDup(cards) > BC.DECKS) { over++; detail = dupNames(cards, BC.DECKS); }
  }
  ck('바카라 라운드가 실제로 돌았다', rounds >= 50, `${rounds}라운드`);
  ck(`바카라 한 판에 같은 카드가 ${BC.DECKS}장을 넘지 않는다`, over === 0, detail);
}

console.log('\n[6] 셔플 품질 — 섞지 않은 덱을 그대로 쓰고 있지 않은가');
{
  /* 첫 장이 늘 같은 카드면 셔플이 동작하지 않는 것이다.
     52장 덱을 2,000번 섞어 첫 장의 분포를 본다 — 한 값에 쏠려 있으면 실패. */
  const first = new Map<number, number>();
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const d = HD.shuffleDeck(randomInt);
    first.set(d[0], (first.get(d[0]) ?? 0) + 1);
  }
  const worst = Math.max(...first.values());
  ck('홀덤 셔플 2,000회 — 첫 장이 52종에 골고루 나온다',
    first.size >= 45 && worst < N / 52 * 4,
    `${first.size}종 · 최다 ${worst}회 (기대 ${Math.round(N / 52)}회)`);

  /* 셔플이 실제로 자리를 바꾸는가.
     rng를 항상 0으로 고정하면 결정적인 순열이 나오는데, 그것이 원래 순서(0..51)와
     달라야 한다. "카드를 잃지 않는다"만 보면 swap 기반이라 어떤 rng에서도 참이어서
     아무것도 검증하지 못한다(대입으로 바뀌는 회귀만 잡힌다). */
  const fixed = HD.shuffleDeck(() => 0);
  const identity = Array.from({ length: 52 }, (_, i) => i).join(',');
  ck('셔플이 실제로 순서를 바꾼다 (덱을 그대로 반환하지 않는다)',
    new Set(fixed).size === 52 && fixed.join(',') !== identity);
}

console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
try { rmSync(process.env.DB_PATH!, { recursive: true, force: true }); } catch { /* OS가 정리 */ }
process.exit(fail ? 1 : 0);
