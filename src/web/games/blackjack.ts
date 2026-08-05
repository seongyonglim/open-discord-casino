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
  BJ_SEATS, BJ_REVEAL_SEC, bjSchedule,
  type BjRoundRow, type BjHelpers, type WebUser,
} from '../../db/queries';
import {
  shuffleShoe, isBlackjack, dealerShouldHit, handTotal, settleHand, cardsToStrings,
  canSurrender, settleSurrender,
} from '../../services/blackjack';
import { readJson, sendJson } from '../http';
import { layout, jsonForScript, helpDialog, sidePanel, rankPane, rankJs } from '../views';
import { ASSET_V } from '../assets';
import { gameSwitcher } from '../pages';
import { COIN_SIZES } from './poker';

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
  return sendJson(res, 200, statePayload(advance(), userId));
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
  return sendJson(res, 200, { ok: true, cards: cardsToStrings(r.cards), status: r.status, bet: r.bet, balance: r.balance });
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
    <li><b>자리 선택</b> — 빈 자리를 눌러 앉고 칩을 올립니다 (12초)</li>
    <li><b>힛 / 스탠드</b> — 모두 같은 15초 안에 각자 결정합니다. 힛은 한 장 더 받기, 스탠드는 여기서 멈추기입니다</li>
    <li>시간이 지나면 <b>자동으로 스탠드</b>됩니다 (마음대로 카드를 더 받지 않습니다)</li>
    <li><b>딜러</b> — 16 이하면 반드시 더 받고, 17 이상이면 반드시 멈춥니다. 딜러에게는 선택권이 없습니다</li>
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
              <p class="bj-rule">blackjack pays 3 to 2 · dealer stands on all 17</p>
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
          <button id="bjClear" class="btn" type="button">Clear Screen</button>
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
      window.__SFX_NEED__ = ['coin','gain','card','shuffle','deal'];
    </script>
    <script>
    (function(){
      var AV = ${JSON.stringify(ASSET_V)};
      var SEATS = ${BJ_SEATS};
      var MEID = window.__MEID__;

      var statusEl=document.getElementById('bjStatus'), seatsEl=document.getElementById('bjSeats');
      var dCardsEl=document.getElementById('bjDealerCards'), dTotalEl=document.getElementById('bjDealerTotal');
      var dNumEl=document.getElementById('bjDealerNum'), dHoleEl=document.getElementById('bjDealerHole');
      /* 끗수 표기는 여기 한 곳에서만 만든다.
         세 군데서 각자 문자열을 조립하다가 표기가 갈렸다(한쪽은 '4 +?', 한쪽은 '–'). */
      function setDealerTotal(total, hole){
        dNumEl.textContent = total == null ? '–' : total;
        dHoleEl.hidden = !hole;
      }
      var bustEl=document.getElementById('bjDealerBust'), tableEl=document.querySelector('.bj-table');
      var actionsEl=document.getElementById('bjActions');
      var hitBtn=document.getElementById('bjHit'), standBtn=document.getElementById('bjStand');
      var dblBtn=document.getElementById('bjDouble');
      var surBtn=document.getElementById('bjSurrender');
      var coinsEl=document.getElementById('bjCoins'), clearBtn=document.getElementById('bjClear');
      var rosterEl=document.getElementById('bjRoster'), potEl=document.getElementById('bjPot');
      var pbal=document.querySelector('.prof .pbal');
      var card=document.querySelector('.card');

      var st=null, coin=null, lastRoundId=null, notedRoundId=null;
      var firstState = true;
      /* 딜러 카드는 서버가 차례 시작에 전부 뽑아 내려주지만, 화면에는 한 장씩 깐다.
         한꺼번에 뒤집으면 딜러가 카드를 받아가며 조마조마해지는 구간이 통째로 사라진다. */
      var shownD = 0, dealerTimers = [];
      var HOLE_FLIP_MS = 700;   // 업카드 옆 홀 카드를 뒤집기까지
      var DRAW_STEP_MS = 950;   // 합을 보고 한 장 더 받기까지 — 판단하는 한 박자
      function clearDealerReveal(){ dealerTimers.forEach(clearTimeout); dealerTimers = []; }

      function fmt(n){ return new Intl.NumberFormat('ko-KR').format(Math.floor(n)) + 'P'; }
      function compact(n){ return new Intl.NumberFormat('ko-KR').format(n); }
      function setBalance(n){ if(pbal && typeof n==='number') pbal.textContent = fmt(n); }
      function replay(el, cls){ el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
      function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
      function cssEsc(s){ return String(s).replace(/["\\\\]/g, '\\\\$&'); }
      function coinLabel(v){ return v>=10000 ? (v/10000)+'만' : String(v); }

      var BAR_COUNT = 3;
      function buttonKind(v){
        var c = (st && st.coins) || [], i = c.indexOf(v);
        return (i >= 0 && i < c.length - BAR_COUNT) ? 'kind-coin' : 'kind-bar';
      }

      var SUIT_SYM={s:'\\u2660',h:'\\u2665',d:'\\u2666',c:'\\u2663'};
      function cardHtml(cstr){
        if (!cstr) return '<img class="pcard back" src="/cards/back.svg?v='+AV+'" alt="">';
        var rank = (cstr[0]==='T'?'10':cstr[0]);
        return '<img class="pcard" src="/cards/'+cstr+'.svg?v='+AV+'" alt="'+rank+SUIT_SYM[cstr[1]]+'">';
      }

      // 내용이 바뀐 칸만 교체한다 — 매 폴링마다 통째로 갈아끼우면 카드가 초당 한 번씩 다시 튄다
      var slotCache={};
      function syncCards(el, key, values){
        var cache = slotCache[key];
        if (!cache) { cache = slotCache[key] = []; el.innerHTML = ''; }
        if (values.length < cache.length) { el.innerHTML = ''; cache = slotCache[key] = []; }
        var added = 0;
        for (var i=0;i<values.length;i++){
          if (cache[i] === values[i]) continue;
          cache[i] = values[i];
          if (el.children[i]) el.children[i].outerHTML = cardHtml(values[i]);
          else el.insertAdjacentHTML('beforeend', cardHtml(values[i]));
          added++;
        }
        return added;
      }

      /* 깐 만큼만 그린다. 중요한 건 아직 안 뽑은 카드의 "자리"조차 만들지 않는 것이다 —
         뒷면을 미리 깔아두면 홀 카드를 뒤집기도 전에 딜러가 몇 장을 더 받을지가 다 보인다.
         실제 테이블 순서는: 두 장 → 합 확인 → 모자라면 그제서야 한 장 → 다시 합 확인 → … */
      function paintDealer(cards){
        var vals = cards.slice(0, shownD);
        if (shownD < 2) vals.push(null);   // 홀 카드는 아직 엎어져 있다
        var n = syncCards(dCardsEl, 'dealer', vals);
        var seen = cards.slice(0, shownD);
        setDealerTotal(seen.length ? bjTotal(seen) : null, shownD < 2 && seen.length > 0);
        // 깐 카드만으로 21을 넘겼는지 본다 — 안 깐 카드로 미리 판정하면 결과가 새어나간다
        markDealerBust(shownD >= 2 && bjTotal(seen) > 21);
        return n;
      }
      /* 딜러 버스트 연출.
         이 게임에서 가장 결정적인 순간인데 숫자만 조용히 22로 바뀌고 끝나서 밋밋했다.
         카드 위에 도장을 찍고, 끗수를 붉게 물들이고, 테이블을 한 번 번쩍이고,
         짧은 "쿵" 소리를 낸다. 한 번 찍힌 판에서는 다시 재생하지 않는다. */
      var bustShown = false;
      function markDealerBust(on){
        if (on === bustShown) return;
        bustShown = on;
        dTotalEl.classList.toggle('bust', on);
        bustEl.hidden = !on;
        if (!on) { bustEl.classList.remove('pop'); tableEl.classList.remove('bustflash'); return; }
        if (firstState) return;   // 이미 끝난 판을 열었을 뿐이다 — 도장만 남기고 연출은 생략
        replay(bustEl, 'pop');
        replay(tableEl, 'bustflash');
        if (window.casinoSfx && window.casinoSfx.bust) window.casinoSfx.bust();
      }
      function scheduleDealerReveal(want){
        if (want <= shownD || dealerTimers.length) return;
        // 홀 카드를 뒤집고 합을 보여준 뒤, 한 박자 쉬고 다음 장을 받는다.
        // 간격이 같으면 "뽑을지 말지 판단하는" 구간이 사라져 급발진처럼 보인다.
        var t = 0;
        for (var i = shownD; i < want; i++) {
          t += (i === 1) ? HOLE_FLIP_MS : DRAW_STEP_MS;
          (function(target, at){
            dealerTimers.push(setTimeout(function(){
              shownD = target;
              paintDealer((st && st.round.dealer.cards) || []);
              if (window.casinoSfx) {
                // 홀 카드는 뒤집는 것(넘기기), 그 뒤는 새로 받는 카드(나눠주기)
                if (target <= 2) window.casinoSfx.card();
                else window.casinoSfx.deal();
              }
            }, at));
          })(i + 1, t);
        }
      }
      // 화면에 깐 카드만으로 끗수를 낸다 — 서버 합계를 쓰면 아직 안 깐 카드가 미리 반영된다
      function bjTotal(cards){
        var total = 0, aces = 0;
        cards.forEach(function(c){
          var r = c[0];
          if (r === 'A') { total += 1; aces++; }
          else if (r === 'T' || r === 'J' || r === 'Q' || r === 'K') total += 10;
          else total += Number(r);
        });
        if (aces > 0 && total + 10 <= 21) total += 10;
        return total;
      }

      function statusText(r){
        // 아무도 앉지 않았으면 시간이 흐르지 않는다 — 카운트다운을 띄우면 안 된다
        if (r.phase === 'waiting') return '빈 자리를 눌러 앉으면 시작합니다';
        if (r.phase === 'betting') return '자리를 고르고 칩을 올리세요 · ' + r.secondsLeft + '초';
        if (r.phase === 'deal') return '카드를 나눠주는 중…';
        if (r.phase === 'action') return '힛 / 스탠드 · ' + r.secondsLeft + '초';
        if (r.phase === 'dealer') return '딜러 차례…';
        var d = r.dealer;
        return '딜러 ' + (d.total != null ? d.total : '?') + ' · 다음 라운드까지 ' + r.secondsLeft + '초';
      }

      function statusLabel(s){
        return s==='blackjack' ? '블랙잭' : s==='bust' ? '버스트'
          : s==='surrender' ? '서렌더' : s==='stand' ? '스탠드' : '';
      }
      function outcomeLabel(o){
        return o==='blackjack' ? '블랙잭!' : o==='win' ? '승' : o==='push' ? '무승부'
          : o==='bust' ? '버스트' : o==='surrender' ? '서렌더' : '패';
      }

      /* ── 자리 ──────────────────────────────────────────────────────
         일곱 자리를 항상 그린다. 빈 자리는 눌러서 앉을 수 있고, 앉으면 그 자리에 칩이 쌓인다.
         (앉기와 베팅을 따로 두면 앉아만 놓고 베팅 안 한 자리가 남아 남이 못 앉는다) */
      function renderSeats(){
        var r = st.round;
        var bySeat = {};
        (st.seats||[]).forEach(function(s){ bySeat[s.seat] = s; });
        var betting = r.phase === 'betting' || r.phase === 'waiting';

        var html = '', sigParts = [];
        for (var i=0;i<SEATS;i++){
          var s = bySeat[i];
          if (!s) {
            html += '<div class="bj-seat empty' + (betting ? ' open' : '') + '" data-seat="'+i+'">' +
              '<div class="bj-seat-num">' + (i+1) + '</div>' +
              '<div class="bj-seat-hint">' + (betting ? '앉기' : '빈자리') + '</div></div>';
            sigParts.push(i + ':빈');
            continue;
          }
          var mine = s.userId === MEID;
          var cls = 'bj-seat' + (mine ? ' mine' : '') +
            (s.status==='bust' ? ' bust' : '') +
            (s.status==='blackjack' ? ' bj' : '') +
            (s.outcome==='win'||s.outcome==='blackjack' ? ' won' : '') +
            (s.outcome==='lose'||s.outcome==='bust' ? ' lost' : '');
          html += '<div class="'+cls+'" data-seat="'+i+'">' +
            '<div class="bj-seat-top"><span class="bj-seat-name">'+esc(s.username)+'</span>' +
              '<span class="bj-seat-total" id="bjt-'+i+'"></span></div>' +
            '<div class="bj-hand small" id="bjh-'+i+'"></div>' +
            // 21을 넘긴 순간 손패 위에 찍히는 도장 (딜러 쪽과 같은 규칙).
            // 손패 div 안에 넣으면 syncCards가 관리하는 자식 순서와 섞이므로 형제로 둔다.
            '<span class="bj-seat-bust" id="bjx-'+i+'" hidden>BUST</span>' +
            '<div class="bj-pile" id="bjp-'+i+'"></div>' +
            '<div class="bj-seat-foot">' +
              '<span class="bj-seat-bet" id="bjb-'+i+'"></span>' +
              '<span class="bj-seat-tag" id="bjg-'+i+'"></span>' +
            '</div></div>';
          sigParts.push(i + ':' + s.userId + ':' + cls);
        }
        /* 골격은 "누가 어느 자리에 앉았나 / 상태 클래스"가 바뀔 때만 다시 그린다.
           금액·끗수까지 서명에 넣으면 칩을 올릴 때마다 통째로 갈아끼워져서
           쌓아둔 칩 더미와 카드 애니메이션이 매번 처음부터 다시 시작된다. */
        var sig = sigParts.join('|') + '|' + betting;
        if (seatsEl.dataset.sig !== sig) {
          seatsEl.dataset.sig = sig;
          seatsEl.innerHTML = html;
          slotCache = Object.keys(slotCache).reduce(function(a,k){ if(k==='dealer') a[k]=slotCache[k]; return a; }, {});
          // 더미 기록은 버리지 않는다 — 아래 syncPile이 기록 그대로 새 칸에 다시 그린다
        }
        var dealt = 0;
        (st.seats||[]).forEach(function(s){
          var el = document.getElementById('bjh-'+s.seat);
          if (el) dealt += syncCards(el, 'seat'+s.seat, s.cards);
          // 자주 바뀌는 값은 골격을 건드리지 않고 제자리에서 갱신한다
          var t = document.getElementById('bjt-'+s.seat);
          if (t) t.textContent = s.total != null ? s.total : '';
          var b = document.getElementById('bjb-'+s.seat);
          if (b) b.textContent = compact(s.bet);
          var g = document.getElementById('bjg-'+s.seat);
          if (g) g.textContent = s.outcome ? outcomeLabel(s.outcome) : statusLabel(s.status);
          markSeatBust(s);
          syncPile(s, r.id);
        });
        return dealt;
      }

      /* 플레이어 버스트 연출.
         딜러 쪽과 같은 도장을 자리에 찍고, 자리를 한 번 흔든다.
         소리는 내 자리에서만 낸다 — 다섯 자리가 같은 판에서 함께 죽으면
         "쿵"이 다섯 번 겹쳐 울려서 무슨 일이 났는지 알 수 없게 된다. */
      var seatBust = {};
      function markSeatBust(s){
        var el = document.getElementById('bjx-'+s.seat);
        if (!el) return;
        var on = s.status === 'bust';
        if (on === !!seatBust[s.seat]) { el.hidden = !on; return; }
        seatBust[s.seat] = on;
        el.hidden = !on;
        if (!on) { el.classList.remove('pop'); return; }
        if (firstState) return;   // 이미 끝난 판을 열었을 뿐이다 — 도장만 남기고 연출은 생략
        replay(el, 'pop');
        var seat = seatsEl.querySelector('.bj-seat[data-seat="'+s.seat+'"]');
        if (seat) replay(seat, 'bustshake');
        if (s.userId === MEID && window.casinoSfx && window.casinoSfx.bust) window.casinoSfx.bust();
      }


      function renderCoins(){
        if (coinsEl.dataset.done) return;
        coinsEl.dataset.done = '1';
        coinsEl.innerHTML = (st.coins||[]).map(function(v){
          return '<button type="button" class="coin '+buttonKind(v)+'" data-coin="'+v+'">' +
            '<span class="face">'+coinLabel(v)+'</span></button>';
        }).join('');
        coin = (st.coins||[])[0];
        coinsEl.querySelectorAll('.coin').forEach(function(b){
          b.addEventListener('click', function(){ coin = Number(b.dataset.coin); syncCoinActive(); });
        });
        syncCoinActive();
      }
      function syncCoinActive(){
        coinsEl.querySelectorAll('.coin').forEach(function(b){
          b.classList.toggle('active', Number(b.dataset.coin) === coin);
        });
      }

      var rosterSig=null, lastBal={};
      function renderRoster(){
        var players = st.players || [];
        var sig = players.map(function(p){ return p.user_id; }).join(',');
        if (sig !== rosterSig) {
          rosterSig = sig;
          if (!players.length) {
            rosterEl.innerHTML = '<div class="empty" style="padding:16px 0">아직 참가자가 없습니다</div>';
          } else {
            rosterEl.innerHTML = players.map(function(p){
              var ini = esc((String(p.username||'?').trim()[0] || '?').toUpperCase());
              var av = p.avatar
                ? '<img class="rw-av" src="'+esc(p.avatar)+'" alt="" referrerpolicy="no-referrer">'
                : '<span class="rw-av">'+ini+'</span>';
              return '<div class="rw'+(p.user_id===MEID?' me':'')+'" data-uid="'+esc(p.user_id)+'">' + av +
                '<span class="rw-mid"><span class="rw-name">'+esc(p.username)+'</span>' +
                '<span class="rw-bal" id="bjbal-'+esc(p.user_id)+'">'+fmt(p.balance)+'</span></span>' +
                '<span class="rw-bet" id="bjbet-'+esc(p.user_id)+'"></span></div>';
            }).join('');
          }
        }
        players.forEach(function(p){
          var b = document.getElementById('bjbal-'+p.user_id);
          if (b) {
            var prev = lastBal[p.user_id];
            if (prev != null && p.balance !== prev) replay(b, p.balance > prev ? 'up' : 'down');
            b.textContent = fmt(p.balance);
          }
          lastBal[p.user_id] = p.balance;
          var e = document.getElementById('bjbet-'+p.user_id);
          if (e) e.innerHTML = (p.payout > 0)
            ? '<span class="pos">+'+fmt(p.payout)+'</span>'
            : '<span class="rw-amt">'+fmt(p.bet)+'</span>';
          var row = rosterEl.querySelector('.rw[data-uid="'+cssEsc(p.user_id)+'"]');
          if (row) row.classList.toggle('won', p.payout > 0);
        });
        potEl.textContent = fmt(players.reduce(function(a,p){ return a + p.bet; }, 0));
      }

      function render(){
        var r = st.round;
        setBalance(st.balance);
        renderCoins();
        statusEl.textContent = statusText(r);
        statusEl.className = 'bj-status' + (r.phase === 'action' ? ' live' : '');

        if (r.id !== lastRoundId) {
          lastRoundId = r.id;
          slotCache = {};
          clearDealerReveal(); shownD = 0;
          dCardsEl.innerHTML = ''; seatsEl.dataset.sig = '';
          setDealerTotal(null, false);
          seatBust = {};   // 지난 판의 버스트 도장 기록을 버린다
          if (!firstState && window.casinoSfx) window.casinoSfx.shuffle();
        }

        // 딜러: 공개 전에는 업카드 한 장 + 뒷면 한 장
        // 딜러: 공개 전에는 업카드 한 장 + 뒷면 한 장. 공개되면 한 장씩 깐다.
        var d = r.dealer;
        var dealt = 0;
        if (d.hidden) {
          clearDealerReveal();
          shownD = 0;
          dealt += syncCards(dCardsEl, 'dealer', d.cards.length ? d.cards.concat([null]) : []);
          setDealerTotal(d.total, d.total != null);
          markDealerBust(false);   // 새 판이 시작됐다 — 지난 판의 도장을 걷는다
        } else {
          // 페이지에 막 들어왔거나 이미 끝난 판이면 연출 없이 다 보여준다
          if (firstState || r.phase === 'done') { clearDealerReveal(); shownD = d.cards.length; }
          else {
            // 업카드는 결정 창 내내 보이고 있었다 — 0부터 그리면 잠깐 사라졌다 다시 나타난다
            if (shownD === 0) shownD = 1;
            scheduleDealerReveal(d.cards.length);
          }
          dealt += paintDealer(d.cards);
        }

        dealt += renderSeats();
        if (dealt && !firstState && window.casinoSfx) window.casinoSfx.deal();

        // 내 차례 버튼 — 결정 창에서 아직 안 정했을 때만
        var can = st.myHand && st.myHand.canAct;
        actionsEl.hidden = !can;
        hitBtn.disabled = !can; standBtn.disabled = !can;
        // 더블은 처음 두 장에서만 뜬다. 못 쓸 때 회색으로 남겨두면 왜 안 되는지 알 수 없어 아예 숨긴다.
        dblBtn.hidden = !(st.myHand && st.myHand.canDouble);
        // 서렌더도 처음 두 장에서만 — 쓸 수 없을 때는 아예 숨긴다(더블과 같은 규칙)
        surBtn.hidden = !(st.myHand && st.myHand.canSurrender);
        // 얼마가 더 나가는지 버튼에 적어 둔다 — '두 배'라는 말만으로는 액수가 안 잡힌다
        var costEl = document.getElementById('bjDblCost');
        if (costEl && st.myHand) costEl.textContent = '+' + compact(st.myHand.bet) + 'P';

        renderRoster();
        firstState = false;

        if (r.phase === 'done' && notedRoundId !== r.id) {
          notedRoundId = r.id;
          flyChipsToPot();
          var me = (st.seats||[]).filter(function(s){ return s.userId === MEID; })[0];
          if (me && me.outcome) {
            if ((me.payout||0) > 0) {
              if (window.casinoSfx) window.casinoSfx.win();
              if (me.payout > me.bet) { if (card) replay(card, 'gold-flash'); if (pbal) replay(pbal, 'bump'); }
            } else if (window.casinoSfx) window.casinoSfx.lose();
          }
        }
      }

      /* ── 코인 더미 ───────────────────────────────────────────────────
         포커 플립·바카라와 같은 방식이다. 자리별로 "지금까지 올라온 칩 목록"을 들고 있다가
         늘어난 만큼만 새 스프라이트를 덧붙인다. 총액에서 매번 새로 그리면 애니메이션이
         초당 다시 시작되고 쌓이는 느낌이 사라진다.
         (자리가 132px이라 5열짜리 더미가 들어간다 — 좁은 창 기준으로 재고 안 된다고 판단했었다) */
      var piles = {};
      var MAX_CHIPS = 18;
      function jit(i, m){ var x=Math.sin(i*12.9898)*43758.5453; return Math.floor((x-Math.floor(x))*m); }
      // 뒤 세 단위(1000·5000·1만)는 골드바, 앞은 동전 — 다른 게임과 같은 규칙
      function chipKind(v){
        var c = (st && st.coins) || [], i = c.indexOf(v);
        return (i >= 0 && i < c.length - BAR_COUNT) ? 'c-coin' : 'c-bar';
      }
      function chipLabel(v){ return v>=10000 ? (v/10000)+'만' : String(v); }   // 1000은 1000 그대로 — K로 줄이지 않는다
      // anim: '' 없음 · 'pending' 자리만 잡고 숨김(곧 날아올 칩)
      function chipSprite(denom, owner, idx, anim){
        var col = idx % 5, row = Math.floor(idx / 5);
        var x = (col - 2) * 14 + jit(idx, 9) - 4;
        var y = 3 + row * 5 + jit(idx + 7, 3);
        return '<span class="pchip '+chipKind(denom)+(owner===MEID?' mine':'')+(anim?' '+anim:'')+
          '" data-owner="'+esc(owner)+'"'+
          ' style="left:calc(50% + '+x+'px);bottom:'+y+'px;z-index:'+(10+idx)+'">'+chipLabel(denom)+'</span>';
      }
      // 금액을 큰 단위부터 칩으로 쪼갠다 (코인 단위 합으로만 베팅되므로 항상 정확히 나뉜다)
      function decompose(amount){
        var out=[], d=(st.coins||[]).slice().sort(function(a,b){return b-a;});
        for (var i=0;i<d.length && out.length<60;i++){
          while (amount >= d[i] && out.length < 60) { out.push(d[i]); amount -= d[i]; }
        }
        return out;
      }
      function pushChips(el, pile, denoms, owner, anim){
        var added = [];
        for (var i=0;i<denoms.length;i++){
          if (pile.list.length >= MAX_CHIPS) { pile.list.shift(); if (el.firstChild) el.removeChild(el.firstChild); }
          var slot = pile.n++ % MAX_CHIPS;
          pile.list.push({ d: denoms[i], o: owner, i: slot });
          el.insertAdjacentHTML('beforeend', chipSprite(denoms[i], owner, slot, anim));
          added.push(el.lastElementChild);
        }
        return added;
      }
      /* 기록해 둔 칩 목록 그대로 다시 그린다.
         총액을 다시 쪼개면(decompose) 500 두 개가 1K 한 개로 합쳐져 버린다 —
         올린 그대로 보여야 하므로 복원은 반드시 목록 기준이다. */
      function paintPile(el, pile){
        el.style.opacity = '';   // 회수 연출로 숨겨뒀던 더미를 되살린다
        el.innerHTML = '';
        for (var i=0;i<pile.list.length;i++){
          var c = pile.list[i];
          el.insertAdjacentHTML('beforeend', chipSprite(c.d, c.o, c.i, ''));
        }
      }
      function rebuildPile(el, seat, bet, owner, roundId){
        var pile = piles[seat] = { round: roundId, bet: 0, list: [], n: 0 };
        el.style.opacity = '';
        el.innerHTML = '';
        // 판 도중에 들어왔거나 남의 자리를 처음 볼 땐 총액밖에 모르니 그때만 쪼갠다
        if (bet > 0) { pile.bet = bet; pushChips(el, pile, decompose(bet), owner, ''); }
      }
      function syncPile(s, roundId){
        var el = document.getElementById('bjp-'+s.seat);
        if (!el) return;
        var pile = piles[s.seat];
        if (!pile || pile.round !== roundId) return rebuildPile(el, s.seat, s.bet, s.userId, roundId);
        // 줄었으면(회수) 애니메이션 없이 다시 그린다
        if (s.bet < pile.bet) return rebuildPile(el, s.seat, s.bet, s.userId, roundId);
        var delta = s.bet - pile.bet;
        if (delta > 0) {
          pile.bet = s.bet;
          // 내 칩은 클릭 즉시(dropMyChip) 올려놨으므로 여기서 또 올리지 않는다
          if (s.userId === MEID) return;
          var added = pushChips(el, pile, decompose(delta), s.userId, 'pending');
          tossFrom(rosterAvatar(s.userId), added);
          return;
        }
        // 금액은 그대로인데 칸이 비었다면 골격을 다시 그린 것이다 — 기록대로 복원
        if (el.childElementCount !== pile.list.length) paintPile(el, pile);
      }

      /* 칩이 자리 밖을 지나는 구간이 잘리지 않도록 화면 전체를 덮는 레이어 위에서 날린다 */
      var fxLayer = null;
      function getFxLayer(){
        if (!fxLayer || !fxLayer.parentNode) {
          fxLayer = document.createElement('div');
          fxLayer.className = 'chip-fly-layer';
          document.body.appendChild(fxLayer);
        }
        return fxLayer;
      }
      function cloneAt(chip, rect, cls){
        var c = chip.cloneNode(true);
        c.className = chip.className.replace(/\\b(toss|pending|fly)\\b/g, '').trim() + ' ' + cls;
        c.style.cssText = 'position:fixed;margin:0;left:'+rect.left+'px;top:'+rect.top+'px;' +
          'width:'+rect.width+'px;height:'+rect.height+'px;';
        getFxLayer().appendChild(c);
        return c;
      }
      function rosterAvatar(uid){
        return rosterEl.querySelector('.rw[data-uid="'+cssEsc(uid)+'"] .rw-av');
      }
      // src 위치에서 chips(제자리에 숨겨둔 원본)로 칩이 날아온다
      function tossFrom(src, chips){
        if (!chips || !chips.length) return;
        if (!src) { chips.forEach(function(ch){ ch.classList.remove('pending'); }); return; }
        var a = src.getBoundingClientRect();
        if (!a.width) { chips.forEach(function(ch){ ch.classList.remove('pending'); }); return; }
        chips.forEach(function(ch, i){
          var b = ch.getBoundingClientRect();
          if (!b.width) { ch.classList.remove('pending'); return; }
          var c = cloneAt(ch, b, 'toss');
          c.style.setProperty('--fx', Math.round((a.left+a.width/2) - (b.left+b.width/2)) + 'px');
          c.style.setProperty('--fy', Math.round((a.top+a.height/2) - (b.top+b.height/2)) + 'px');
          c.style.setProperty('--fs', (Math.min(2.6, a.width / b.width)).toFixed(2));
          c.style.animationDelay = (i * 70) + 'ms';
          setTimeout(function(){
            if (c.parentNode) c.parentNode.removeChild(c);
            ch.classList.remove('pending');
          }, 380 + i * 70);
        });
      }
      // 내 클릭은 폴링을 기다리지 않고 즉시 칩을 올린다.
      // 방금 누른 코인 버튼의 실제 화면 위치에서 출발해 자리 안 제자리로 날아온다.
      function dropMyChip(seat, denom){
        var el = document.getElementById('bjp-'+seat), pile = piles[seat];
        if (!el || !pile) return;
        var added = pushChips(el, pile, [denom], MEID, 'pending');
        pile.bet += denom;
        tossFrom(coinsEl.querySelector('.coin[data-coin="'+denom+'"] .face'), added);
      }
      /* 딴 자리의 칩을 각자 주인에게 돌려보낸다.
         내 것은 화면 아래 중앙(칩 바)으로, 남의 것은 오른쪽 참가자 아이콘으로 —
         포커 플립·바카라와 같은 규칙이다. */
      function flyChipsToPot(){
        var controls = document.querySelector('.poker-controls');
        var myTarget = (controls || coinsEl).getBoundingClientRect();
        var sent = [], n = 0;
        (st.seats||[]).forEach(function(s){
          if (!(s.payout > 0)) return;
          var pile = document.getElementById('bjp-'+s.seat);
          if (!pile) return;
          Array.prototype.forEach.call(pile.querySelectorAll('.pchip'), function(ch){
            var r = ch.getBoundingClientRect();
            if (!r.width) return;
            var t = myTarget;
            if (ch.classList.contains('mine')) t = myTarget;
            else {
              var av = rosterAvatar(ch.getAttribute('data-owner') || '');
              var ab = av && av.getBoundingClientRect();
              if (ab && ab.width) t = ab;
            }
            var c = cloneAt(ch, r, 'fly');
            c.style.setProperty('--tx', Math.round((t.left+t.width/2) - (r.left+r.width/2)) + 'px');
            c.style.setProperty('--ty', Math.round((t.top+t.height/2) - (r.top+r.height/2)) + 'px');
            c.style.animationDelay = (n++ * 40) + 'ms';
            sent.push(c);
          });
          pile.style.opacity = '0';
        });
        if (!n) return;
        setTimeout(function(){ sent.forEach(function(c){ if (c.parentNode) c.parentNode.removeChild(c); }); }, 900 + n*40);
      }


      /* ── 입력 ───────────────────────────────────────────────────── */
      async function post(url, body){
        var r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'},
          body: body?JSON.stringify(body):undefined });
        var d = await r.json();
        return { ok:r.ok, d:d };
      }
      seatsEl.addEventListener('click', async function(e){
        var el = e.target.closest('.bj-seat');
        if (!el || !st || !coin) return;
        // 여기서 단계를 따지지 않는다. 화면 상태는 폴링 주기만큼(최대 1초) 뒤처져 있어서,
        // 새 베팅 창이 막 열린 순간에 누르면 "아직 마감된 라운드"로 보고 눌린 걸 삼켜버린다.
        // 받아줄지는 서버가 정한다 — 늦었으면 400이 오고, 그때 자리를 한 번 튕겨 알려준다.
        var seat = Number(el.dataset.seat);
        var res = await post('/api/games/blackjack/bet', { seat: seat, amount: coin });
        if (res.ok) {
          setBalance(res.d.balance);
          dropMyChip(seat, coin);
          if (window.casinoSfx && window.casinoSfx.chip) window.casinoSfx.chip();
        } else {
          // 문구를 띄우면 아래 내용이 밀려서 다음 클릭이 엉뚱한 데로 간다. 자리만 짧게 튕긴다.
          replay(el, 'deny');
        }
        poll();
      });
      hitBtn.addEventListener('click', async function(){
        var res = await post('/api/games/blackjack/action', { action: 'hit' });
        if (res.ok && window.casinoSfx) window.casinoSfx.card();
        poll();
      });
      dblBtn.addEventListener('click', async function(){
        var res = await post('/api/games/blackjack/action', { action: 'double' });
        if (res.ok) {
          setBalance(res.d.balance);
          // 베팅이 두 배가 됐으니 서클 칩도 한 개 더 날려 보낸다
          // 베팅이 두 배가 됐으니 그만큼 칩을 더 올린다
          if (st.myHand) dropMyChip(st.myHand.seat, st.myHand.bet);
          if (window.casinoSfx) window.casinoSfx.card();
        }
        poll();
      });
      standBtn.addEventListener('click', async function(){
        await post('/api/games/blackjack/action', { action: 'stand' });
        poll();
      });
      surBtn.addEventListener('click', async function(){
        /* 확인창 없이 바로 적용한다. 결정 시간이 15초뿐인데 브라우저 기본 대화상자가
           그 위에 뜨면 흐름이 끊기고, 무엇보다 이 버튼은 첫 두 장에서만 나오므로
           실수로 누를 자리가 아니다. 무효 규칙은 버튼 아래 설명과 규칙 도움말에 적혀 있다. */
        var res = await post('/api/games/blackjack/action', { action: 'surrender' });
        if (!res.ok && res.d && res.d.error) alert(res.d.error);
        poll();
      });
      clearBtn.addEventListener('click', async function(){
        var res = await post('/api/games/blackjack/clear');
        if (res.ok) { setBalance(res.d.balance); if (window.casinoSfx) window.casinoSfx.win('gain'); }
        poll();
      });

      /* ── 폴링 ───────────────────────────────────────────────────── */
      var pollFails = 0;
      async function poll(){
        var d = await window.casinoPoll('/api/games/blackjack/state');
        if (!d) { if (++pollFails >= 2) statusEl.textContent = '서버에 연결하는 중…'; return; }
        pollFails = 0;
        st = d;
        render();
      }
      poll();
      setInterval(poll, 1000);
    })();

      // 우측 패널 랭킹 탭
      ${rankJs('bj', 'blackjack')}
    </script>`;

  return layout('블랙잭', 'lobby', body);
}
