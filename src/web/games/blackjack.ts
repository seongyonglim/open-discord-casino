// 블랙잭: 5석 공용 테이블. 딜러 한 명을 여러 명이 함께 상대한다.
//
// 다른 게임과 다른 점:
//  · 결과가 사람마다 다르다. 같은 딜러를 보지만 손패는 각자의 것이다.
//  · 플레이어에게 선택권이 있다(힛/스탠드). 그래서 배당을 우리가 정하지 않는다 —
//    블랙잭의 하우스 엣지는 "플레이어가 먼저 버스트하면 딜러는 카드를 받지도 않고 이긴다"는
//    규칙 자체에서 나온다. 배당은 실제 카지노와 같다(승 1:1, 블랙잭 3:2, 무승부 환불).
//  · 결정은 전원이 같은 15초 창에서 동시에 한다. 순차로 한 명씩 돌리면 라운드 길이가 인원수에
//    비례해 늘고(다섯 명이면 1분 넘음) 그중 내 차례는 10초뿐이라, 사람이 많을수록 오히려
//    남을 기다리는 시간만 길어진다. 동시에 하면 인원이 늘어도 라운드 길이가 그대로다.
//    게다가 전원이 일찍 결정하면 남은 시간을 기다리지 않고 바로 딜러 차례로 넘어간다.
//  · 아무도 앉지 않으면 라운드가 흐르지 않는다(waiting). 첫 사람이 앉는 순간 10초가 시작된다 —
//    빈 테이블에서 카드가 계속 돌면 늦게 온 사람이 남의 라운드가 끝나기를 기다려야 한다.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';
import {
  advanceBlackjackRound, seatBlackjackBet, clearBlackjackBet, blackjackAction,
  getBlackjackHands, getBlackjackPlayers, getMyBlackjackHand, getWebUser,
  BJ_SEATS, BJ_REVEAL_SEC, BJ_BETTING_SEC, bjSchedule,
  type BjRoundRow, type BjHelpers, type WebUser,
  chatTick,
} from '../../db/queries';
import {
  shuffleShoe, isBlackjack, dealerShouldHit, handTotal, settleHand, cardsToStrings,
  canSurrender, settleSurrender,
} from '../../services/blackjack';
import { readJson, sendJson } from '../http';
import { award, withUnlocked, withCommon, commonAwards } from '../achieve-hook';
import { layout, jsonForScript, helpDialog, sidePanel, rankPane, rankJs } from '../views';
import { ASSET_V } from '../assets';
import { gameSwitcher } from '../pages';
import { COIN_SIZES } from './poker';
/* 브라우저로 나가는 인라인 스크립트의 조각들. 아래에서 원래 순서로 이어 붙인다 —
   순서가 곧 산출물이므로 바꾸지 말 것. */
import { bjHead } from './blackjack-client/head';
import { BJ_CARDS_JS } from './blackjack-client/cards';
import { BJ_SEATS_JS } from './blackjack-client/seats';
import { BJ_RENDER_JS } from './blackjack-client/render';
import { bjChips } from './blackjack-client/chips';

const helpers: BjHelpers = {
  shuffle: () => shuffleShoe(randomInt),
  isBlackjack,
  dealerShouldHit,
  handTotal: (c: number[]) => { const t = handTotal(c); return { total: t.total, bust: t.bust }; },
  settle: settleHand,
  canSurrender,
  settleSurrender,
};

function advance(): BjRoundRow {
  return advanceBlackjackRound(helpers);
}

// 아무도 앉지 않은 동안에는 시간이 흐르지 않으므로 남은 초가 없다(null).
function secondsLeft(round: BjRoundRow): number | null {
  const now = Math.floor(Date.now() / 1000);
  if (round.phase === 'waiting') return null;
  if (round.phase === 'done') return Math.max(0, (round.resolved_at ?? now) + BJ_REVEAL_SEC - now);
  const s = bjSchedule(round);
  if (!s) return null;
  if (round.phase === 'betting') return Math.max(0, round.betting_ends_at! - now);
  const next = now < s.deal ? s.deal : now < s.action ? s.action : s.dealer;
  return Math.max(0, next - now);
}

/* 딜러 카드 공개 범위.
   딜러의 둘째 장(홀 카드)은 딜러 차례가 되기 전까지 절대 내려보내지 않는다 —
   그걸 알면 힛할지 스탠드할지가 자명해져서 게임이 성립하지 않는다.
   슈(shoe_json)는 어느 단계에서도 내보내지 않는다. 남은 판 전체가 새는 셈이라 더 위험하다. */
function dealerView(round: BjRoundRow): { cards: string[]; total: number | null; hidden: boolean } {
  const dealer = JSON.parse(round.dealer_json) as number[];
  if (!dealer.length) return { cards: [], total: null, hidden: false };
  if (round.phase === 'waiting' || round.phase === 'betting'
      || round.phase === 'deal' || round.phase === 'action') {
    const up = dealer.slice(0, 1);
    return { cards: cardsToStrings(up), total: handTotal(up).total, hidden: true };
  }
  return { cards: cardsToStrings(dealer), total: handTotal(dealer).total, hidden: false };
}

function statePayload(round: BjRoundRow, userId: string) {
  const hands = getBlackjackHands(round.id);
  const players = getBlackjackPlayers(round.id);
  const byUser = new Map(players.map(p => [p.user_id, p]));
  const dv = dealerView(round);
  const showCards = round.phase !== 'betting' && round.phase !== 'waiting';

  return {
    ok: true,
    round: {
      id: round.id,
      phase: round.phase,
      secondsLeft: secondsLeft(round),
      dealer: dv,
    },
    seats: hands.map(h => {
      const cards = JSON.parse(h.cards_json) as number[];
      const t = handTotal(cards);
      const p = byUser.get(h.user_id);
      return {
        seat: h.seat,
        userId: h.user_id,
        username: h.username,
        avatar: p?.avatar ?? null,
        bet: h.bet,
        cards: showCards ? cardsToStrings(cards) : [],
        total: showCards && cards.length ? t.total : null,
        soft: showCards && cards.length ? t.soft : false,
        status: h.status,
        outcome: h.outcome,
        payout: h.payout,
      };
    }),
    coins: COIN_SIZES,
    me: userId,
    balance: getWebUser(userId)?.balance ?? 0,
    /* 채팅은 폴링을 새로 만들지 않는다 — 이 숫자 하나(마지막 메시지 id)만 얹고,
       화면은 값이 늘었을 때만 /api/chat 을 부른다. 조용하면 요청이 안 는다. */
    ...chatTick(),
    myHand: (() => {
      const h = getMyBlackjackHand(round.id, userId);
      if (!h) return null;
      const cards = JSON.parse(h.cards_json) as number[];
      const acting = round.phase === 'action' && h.status === 'playing';
      const bal = getWebUser(userId)?.balance ?? 0;
      return {
        seat: h.seat, bet: h.bet, status: h.status, canAct: acting,
        // 더블은 처음 두 장에서만, 그리고 같은 금액을 한 번 더 걸 수 있을 때만
        canDouble: acting && cards.length === 2 && bal >= h.bet,
        // 서렌더도 처음 두 장에서만. 내가 블랙잭이면 이미 확정 승이라 뜨지 않는다
        canSurrender: acting && canSurrender(cards),
        total: cards.length ? handTotal(cards).total : null,
      };
    })(),
    players,
  };
}

export async function handleState(_req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const round = advance();
  return sendJson(res, 200, { ...statePayload(round, userId), ...bjAwards(round, userId) });
}

/* ── 도전과제 둘 ───────────────────────────────────────────────────
   판정은 정산이 끝난 뒤에만 성립한다(딜러가 버스트했는지, 이겼는지). 정산은 라운드를
   전진시키는 쪽에서 도는데 그건 누구의 요청인지 정해져 있지 않으므로, 결과를 읽어
   판정하는 것은 각자의 상태 응답에서 한다 — 토스트가 그 사람에게 떠야 하기 때문이다.

   · 너 버스트할거 잖아 — 6점 이하에서 더 안 받고 섰는데 딜러가 터진다.
     "언제 섰나"가 아니라 "선 순간의 점수"로 본다. 2에서 한 번 받아 6이 된 뒤 선 것도
     같은 배짱이고, 화면에 보이는 것도 그 점수다.
   · 카드 야르 — 일곱 장 이상을 받고도 21을 안 넘기고 이긴다. */
const BJ_LOW_STAND = 6;
const BJ_MANY_CARDS = 7;

function bjAwards(round: BjRoundRow, userId: string) {
  const hand = getMyBlackjackHand(round.id, userId);
  // 정산 전에는 outcome 이 없다 — 이길지 질지 모르는 상태에서 판정할 것이 없다
  // 이긴 판이 아니어도 공통 과제는 봐야 한다 — 되살아난 것은 이 판의 승패와 무관하다
  if (!hand || hand.outcome !== 'win') return withUnlocked(commonAwards(userId));
  const cards = JSON.parse(hand.cards_json) as number[];
  const total = handTotal(cards);
  const dealer = handTotal(JSON.parse(round.dealer_json ?? '[]') as number[]);
  return withCommon(userId, award(userId, hand.bet, [
    ['bj-stand-6', () => hand.status === 'stand' && total.total <= BJ_LOW_STAND && dealer.bust],
    ['bj-7-cards', () => cards.length >= BJ_MANY_CARDS && !total.bust],
  ]));
}

export async function handleBet(req: IncomingMessage, res: ServerResponse, userId: string, username: string): Promise<void> {
  // 본문 파싱(await)을 먼저 끝낸다 — 라운드 확인과 쓰기 사이에 await가 있으면
  // 그 틈에 라운드가 넘어가 이미 마감된 라운드에 베팅이 들어갈 수 있다.
  const data = await readJson(req);
  const seat = Math.floor(Number(data?.seat));
  const amount = Math.floor(Number(data?.amount));
  if (!Number.isInteger(seat) || seat < 0 || seat >= BJ_SEATS) return sendJson(res, 400, { error: '자리 번호가 올바르지 않습니다' });
  if (!COIN_SIZES.includes(amount)) return sendJson(res, 400, { error: '코인 단위가 올바르지 않습니다' });

  const round = advance();
  // waiting = 아직 아무도 안 앉은 상태. 여기 앉는 게 곧 라운드 시작이다.
  if (round.phase !== 'betting' && round.phase !== 'waiting') {
    return sendJson(res, 400, { error: '베팅이 마감되었습니다. 다음 라운드를 기다려주세요.' });
  }

  const r = seatBlackjackBet(userId, username, round.id, seat, amount);
  if (!r.ok) {
    const msg = r.error === 'seat_taken' ? '이미 다른 분이 앉은 자리입니다'
      : r.error === 'already_seated' ? '이번 라운드에는 이미 다른 자리에 앉으셨습니다'
      : r.error === 'closed' ? '베팅이 마감되었습니다. 다음 라운드를 기다려주세요.'
      : r.error === 'bad_seat' ? '자리 번호가 올바르지 않습니다'
      : '잔액이 부족합니다';
    return sendJson(res, 400, { error: msg });
  }
  return sendJson(res, 200, { ok: true, balance: r.balance, bet: r.bet });
}

export async function handleClear(_req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const round = advance();
  const r = clearBlackjackBet(userId, round.id);
  if (!r.ok) {
    return sendJson(res, 400, {
      error: r.error === 'nothing' ? '회수할 칩이 없습니다' : '베팅이 마감되어 회수할 수 없습니다',
    });
  }
  return sendJson(res, 200, { ok: true, balance: r.balance, refunded: r.refunded });
}

export async function handleAction(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const data = await readJson(req);
  const action = data?.action === 'hit' ? 'hit'
    : data?.action === 'stand' ? 'stand'
    : data?.action === 'double' ? 'double'
    : data?.action === 'surrender' ? 'surrender' : null;
  if (!action) return sendJson(res, 400, { error: '알 수 없는 동작입니다' });

  const round = advance();
  const r = blackjackAction(userId, round.id, action, helpers);
  if (!r.ok) {
    const msg = r.error === 'closed' ? '결정 시간이 지났습니다'
      : r.error === 'no_hand' ? '이번 라운드에 참여하지 않았습니다'
      : r.error === 'cannot_double' ? '더블다운은 처음 두 장에서만 할 수 있습니다'
      : r.error === 'cannot_surrender' ? '서렌더는 처음 두 장에서만 할 수 있습니다'
      : r.error === 'insufficient_balance' ? '잔액이 부족합니다'
      : '이미 결정을 마쳤습니다';
    return sendJson(res, 400, { error: msg });
  }
  /* ── 도전과제: 김재원이 되어 보자 ──────────────────────────────────
     20에 만족하지 않고, 그것도 히트가 아니라 더블다운으로 21을 만든다.
     더블은 처음 두 장에서만 되고 카드도 딱 한 장만 받는다 — 20에서 그걸 누른다는 건
     이길 판에 판돈을 두 배로 걸고 한 장에 모든 걸 맡긴다는 뜻이다.

     "직전 합"을 다시 재는 대신 방금 받은 카드를 빼고 계산한다 — r.cards 의 마지막 장이
     이번에 뽑은 카드라, 그것만 덜어 내면 누르기 직전의 손이 그대로 나온다.

     소프트 20(A+9)에서 A 를 받아 21이 되는 경우도 포함된다 — 화면에 21로 보이는 것이
     이 과제가 말하는 21이다.

     r.bet 은 더블로 두 배가 된 값이다. 문지기(1,000P)가 재는 것도 그 값이라, 500P 로
     시작해 더블한 판도 통과한다 — 실제로 그 판에 걸린 돈이 1,000P 이므로 맞는 셈이다. */
  const got = action === 'double'
    ? award(userId, r.bet, [['bj-double-21', () => {
      const before = handTotal(r.cards.slice(0, -1));
      return before.total === 20 && handTotal(r.cards).total === 21;
    }]])
    : [];
  return sendJson(res, 200, {
    ok: true, cards: cardsToStrings(r.cards), status: r.status, bet: r.bet, balance: r.balance,
    ...withUnlocked(got),
  });
}

/* ── 화면 ────────────────────────────────────────────────────────────── */

/* 규칙이 이 카지노에서 제일 많은 게임이라 도움말을 붙인다.
   특히 "내가 먼저 버스트하면 딜러가 버스트해도 진다"는 처음 하는 사람이 가장 많이 놀라는
   지점이라 따로 강조해 둔다 — 블랙잭 하우스 엣지가 사실상 전부 여기서 나온다. */
const RULES_HTML = `
  <h4>목표</h4>
  <p>카드 합을 <b>21에 가깝게</b> 만들어 딜러보다 높으면 이깁니다. 21을 넘기면 그 순간 집니다.</p>

  <h4>카드는 한 벌(52장)입니다</h4>
  <p>매 판 <b>52장 한 벌</b>을 새로 섞어 씁니다. 그래서 한 판에 같은 카드가 두 번 나오지 않습니다.
     (실제 카지노는 보통 6~8벌을 겹쳐 쓰지만, 여기는 내부 친선 룰로 한 벌만 씁니다.)</p>

  <h4>카드 끗수</h4>
  <ul>
    <li><b>2~10</b> — 숫자 그대로</li>
    <li><b>J · Q · K</b> — 10</li>
    <li><b>A</b> — 1 또는 11 중 유리한 쪽으로 자동 계산됩니다</li>
  </ul>

  <h4>진행</h4>
  <ul>
    <li><b>자리 선택</b> — 빈 자리를 눌러 앉고 칩을 올립니다 (${BJ_BETTING_SEC}초)</li>
    <li><b>힛 / 스탠드</b> — 모두 같은 15초 안에 각자 결정합니다. 힛은 한 장 더 받기, 스탠드는 여기서 멈추기입니다</li>
    <li>시간이 지나면 <b>자동으로 스탠드</b>됩니다 (마음대로 카드를 더 받지 않습니다)</li>
    <li><b>딜러</b> — 16 이하면 반드시 더 받고, 17 이상이면 반드시 멈춥니다. 딜러에게는 선택권이 없습니다</li>
    <li>다만 <b>살아남은 손패가 하나도 없으면</b>(전원 버스트·서렌더) 딜러는 카드를 더 받지 않습니다 — 상대가 없으므로 칠 이유가 없습니다</li>
  </ul>

  <h4>더블다운</h4>
  <p>처음 두 장을 받은 직후에만 쓸 수 있습니다.
     <b>베팅을 두 배로 올리는 대신 딱 한 장만 더 받고 멈춥니다.</b></p>
  <p class="tip"><b>꿀팁 —</b> 내 합이 <b>9·10·11</b>이고 딜러 업카드가 <b>2~6</b>일 때가 자리입니다.
     12 이상에서는 쓰지 마세요.</p>

  <h4>서렌더 (판 포기)</h4>
  <p>처음 두 장을 받은 직후에만 쓸 수 있습니다.
     <b>베팅의 절반을 잃고 그 자리에서 판을 끝냅니다.</b>
     힛을 한 번이라도 하면 쓸 수 없습니다.</p>
  <p><b>단, 딜러가 블랙잭이면 서렌더는 무효가 되고 전액을 잃습니다.</b>
     우리 딜러는 뒷장을 미리 확인하지 않기 때문입니다.</p>
  <p class="tip"><b>꿀팁 —</b> <b>하드 15·16</b>으로 딜러 <b>10·J·Q·K</b>를 만났을 때만 쓰세요.
     나머지는 그냥 플레이하는 게 낫습니다.</p>

  <h4>배당</h4>
  <table>
    <tr><td>딜러보다 높으면</td><td>1 : 1</td></tr>
    <tr><td>처음 두 장이 21 (블랙잭)</td><td>3 : 2</td></tr>
    <tr><td>딜러와 같으면</td><td>원금 환불</td></tr>
  </table>

  <div class="warn"><b>주의 —</b> 내가 먼저 21을 넘기면, 그 뒤에 딜러가 21을 넘겨도 <b>내가 집니다.</b>
  카지노가 블랙잭에서 이익을 보는 이유가 사실상 이것 하나입니다. 높은 끗수에서 무리하게 받지 마세요.</div>

  <h4>이 판의 규격</h4>
  <p class="spec">1덱 · 블랙잭 2.5배</p>
`;

export function blackjackPage(user: WebUser): string {
  const body = `
    ${gameSwitcher('blackjack', 'bjHelp')}
    <div class="game-shell">
      <div class="game-main">
        <div class="card">
          <div class="bj-table">
            <!-- 딜러 앞 반원 라인 — 실제 테이블의 인쇄선. 자리들이 이 곡선을 따라 앉는다 -->
            <div class="bj-arc" aria-hidden="true"></div>
            <div class="bj-dealer">
              <div class="bj-dealer-head">
                <span class="bj-label">DEALER</span>
                <!-- 끗수와 "아직 안 깐 장" 표시를 따로 둔다. 한 덩어리 텍스트로 "4 +?"라고
                     붙이면 같은 크기·굵기로 나란히 서서 수식처럼 읽힌다. -->
                <span id="bjDealerTotal" class="bj-total"><span id="bjDealerNum">–</span
                  ><i id="bjDealerHole" class="bj-hole" hidden>+?</i></span>
              </div>
              <div id="bjDealerCards" class="bj-hand"></div>
              <!-- 딜러가 21을 넘긴 순간 카드 위에 찍히는 도장. 서 있던 모든 자리가 이기는 순간이다 -->
              <span id="bjDealerBust" class="bj-bust" hidden>DEALER BUST</span>
            </div>
            <div id="bjStatus" class="bj-status">테이블을 준비하는 중…</div>
            <div id="bjSeats" class="bj-seats"></div>
          </div>

          <div id="bjActions" class="bj-actions" hidden>
            <button type="button" class="bja hit" id="bjHit">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
              <span class="bja-t"><b>힛</b><i>한 장 더</i></span>
            </button>
            <button type="button" class="bja stand" id="bjStand">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>
              <span class="bja-t"><b>스탠드</b><i>여기서 멈춤</i></span>
            </button>
            <button type="button" class="bja dbl" id="bjDouble">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M9 7h8v8"/></svg>
              <span class="bja-t"><b>더블다운</b><i id="bjDblCost">두 배로</i></span>
            </button>
            <button type="button" class="bja sur" id="bjSurrender">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4v16"/><path d="M5 5h11l-2 4 2 4H5"/></svg>
              <span class="bja-t"><b>서렌더</b><i>절반 손실</i></span>
            </button>
          </div>
        </div>

        <div class="card game-controls poker-controls">
          <div class="coin-row" id="bjCoins"></div>
          <button id="bjClear" class="btn" type="button">초기화</button>
        </div>
      </div>

      ${sidePanel('bj', `
        <div class="side-head"><span>참가자</span><span id="bjPot" class="num">0P</span></div>
        <div id="bjRoster" class="roster"><div class="empty" style="padding:16px 0">아직 참가자가 없습니다</div></div>
      `, rankPane('bj'))}
    </div>
    ${helpDialog('bjHelp', '블랙잭 규칙', RULES_HTML)}
    <script>
      window.__ME__ = ${jsonForScript(user.username)};
      window.__MEID__ = ${jsonForScript(user.id)};
      window.__SFX_NEED__ = ['gain','card','shuffle','deal','chipbet','chipwin'];
      window.__CHAT_WHERE__ = 'blackjack';
    </script>
    <script>
${bjHead(JSON.stringify(ASSET_V), BJ_SEATS)}${BJ_CARDS_JS}${BJ_SEATS_JS}${BJ_RENDER_JS}${bjChips(rankJs('bj', 'blackjack'))}
    </script>`;

  return layout('블랙잭', 'lobby', body);
}
