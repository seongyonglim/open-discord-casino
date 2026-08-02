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
} from '../../services/blackjack';
import { readJson, sendJson } from '../http';
import { layout, jsonForScript, helpButton, helpDialog } from '../views';
import { ASSET_V } from '../assets';
import { gameSwitcher } from '../pages';
import { COIN_SIZES } from './poker';

const helpers: BjHelpers = {
  shuffle: () => shuffleShoe(randomInt),
  isBlackjack,
  dealerShouldHit,
  handTotal: (c: number[]) => { const t = handTotal(c); return { total: t.total, bust: t.bust }; },
  settle: settleHand,
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
    : data?.action === 'double' ? 'double' : null;
  if (!action) return sendJson(res, 400, { error: '알 수 없는 동작입니다' });

  const round = advance();
  const r = blackjackAction(userId, round.id, action, helpers);
  if (!r.ok) {
    const msg = r.error === 'closed' ? '결정 시간이 지났습니다'
      : r.error === 'no_hand' ? '이번 라운드에 참여하지 않았습니다'
      : r.error === 'cannot_double' ? '더블다운은 처음 두 장에서만 할 수 있습니다'
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
  <p>처음 두 장을 받은 직후에만 쓸 수 있습니다. <b>베팅을 두 배로 올리는 대신 딱 한 장만 더 받고 멈춥니다.</b></p>
  <ul>
    <li>합이 <b>9 · 10 · 11</b>이고 딜러 업카드가 약할 때(2~6) 쓰는 수입니다 — 한 장으로 20~21이 될 확률이 높은 자리</li>
    <li>10판에 1번쯤 기회가 오고, 잘 쓰면 하우스 엣지가 <b>2.35% → 1.12%</b>로 절반이 됩니다 (실측)</li>
    <li>한 장 받고 21을 넘기면 그대로 두 배로 잃습니다. 12 이상에서는 쓰지 마세요</li>
  </ul>

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
    ${gameSwitcher('blackjack')}
    <div class="game-shell">
      <div class="game-main">
        <div class="card">
          <div class="bj-table">
            <!-- 딜러 앞 반원 라인 — 실제 테이블의 인쇄선. 자리들이 이 곡선을 따라 앉는다 -->
            <div class="bj-arc" aria-hidden="true"></div>
            <div class="bj-dealer">
              <div class="bj-dealer-head">
                <span class="bj-label">DEALER</span>
                <span id="bjDealerTotal" class="bj-total">–</span>
              </div>
              <div id="bjDealerCards" class="bj-hand"></div>
              <p class="bj-rule">blackjack pays 3 to 2 · dealer stands on all 17</p>
            </div>
            ${helpButton('bjHelp')}
            <div id="bjStatus" class="bj-status">테이블을 준비하는 중…</div>
            <div id="bjSeats" class="bj-seats"></div>
          </div>

          <div id="bjActions" class="bj-actions" hidden>
            <button type="button" class="btn btn-primary" id="bjHit">힛</button>
            <button type="button" class="btn" id="bjStand">스탠드</button>
            <button type="button" class="btn btn-gold" id="bjDouble">더블다운</button>
          </div>
        </div>

        <div class="card game-controls poker-controls">
          <div class="coin-row" id="bjCoins"></div>
          <button id="bjClear" class="btn" type="button">Clear Screen</button>
        </div>
      </div>

      <div class="card game-side">
        <div class="side-head"><span>참가자</span><span id="bjPot" class="num">0P</span></div>
        <div id="bjRoster" class="roster"><div class="empty" style="padding:16px 0">아직 참가자가 없습니다</div></div>
      </div>
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
      var actionsEl=document.getElementById('bjActions');
      var hitBtn=document.getElementById('bjHit'), standBtn=document.getElementById('bjStand');
      var dblBtn=document.getElementById('bjDouble');
      var coinsEl=document.getElementById('bjCoins'), clearBtn=document.getElementById('bjClear');
      var rosterEl=document.getElementById('bjRoster'), potEl=document.getElementById('bjPot');
      var pbal=document.querySelector('.prof .pbal');
      var card=document.querySelector('.card');

      var st=null, coin=null, lastRoundId=null, notedRoundId=null;
      var firstState = true;

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
        return s==='blackjack' ? '블랙잭' : s==='bust' ? '버스트' : s==='stand' ? '스탠드' : '';
      }
      function outcomeLabel(o){
        return o==='blackjack' ? '블랙잭!' : o==='win' ? '승' : o==='push' ? '무승부' : o==='bust' ? '버스트' : '패';
      }

      /* ── 자리 ──────────────────────────────────────────────────────
         일곱 자리를 항상 그린다. 빈 자리는 눌러서 앉을 수 있고, 앉으면 그 자리에 칩이 쌓인다.
         (앉기와 베팅을 따로 두면 앉아만 놓고 베팅 안 한 자리가 남아 남이 못 앉는다) */
      function renderSeats(){
        var r = st.round;
        var bySeat = {};
        (st.seats||[]).forEach(function(s){ bySeat[s.seat] = s; });
        var betting = r.phase === 'betting' || r.phase === 'waiting';

        var html = '';
        for (var i=0;i<SEATS;i++){
          var s = bySeat[i];
          if (!s) {
            html += '<div class="bj-seat empty' + (betting ? ' open' : '') + '" data-seat="'+i+'">' +
              '<div class="bj-seat-num">' + (i+1) + '</div>' +
              '<div class="bj-seat-hint">' + (betting ? '앉기' : '빈자리') + '</div></div>';
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
              '<span class="bj-seat-total">'+(s.total!=null ? s.total : '')+'</span></div>' +
            '<div class="bj-hand small" id="bjh-'+i+'"></div>' +
            '<div class="bj-spot" id="bjs-'+i+'"></div>' +
            '<div class="bj-seat-foot">' +
              '<span class="bj-seat-bet">'+compact(s.bet)+'</span>' +
              '<span class="bj-seat-tag">'+(s.outcome ? outcomeLabel(s.outcome) : statusLabel(s.status))+'</span>' +
            '</div></div>';
        }
        // 골격은 구성이 바뀔 때만 다시 그린다 (매초 갈아끼우면 카드 애니메이션이 초기화된다)
        var sig = html.replace(/<div class="bj-hand small"[^>]*><\\/div>/g, '');
        if (seatsEl.dataset.sig !== sig) {
          seatsEl.dataset.sig = sig;
          seatsEl.innerHTML = html;
          slotCache = Object.keys(slotCache).reduce(function(a,k){ if(k==='dealer') a[k]=slotCache[k]; return a; }, {});
        }
        var dealt = 0;
        (st.seats||[]).forEach(function(s){
          var el = document.getElementById('bjh-'+s.seat);
          if (el) dealt += syncCards(el, 'seat'+s.seat, s.cards);
          syncSpot(s);
        });
        return dealt;
      }

      /* ── 베팅 서클 ───────────────────────────────────────────────────
         포커·바카라처럼 칩을 수북이 쌓지는 않는다. 거기서는 여러 명이 같은 시장에 쌓아
         더미 자체가 "다들 어디에 걸었나"라는 정보판이 되지만, 블랙잭은 각자 자기 손패에만
         걸어서 남의 베팅액이 나에게 아무 의미가 없다. 자리도 72px이라 더미가 들어갈 폭이 없다.
         그래서 실제 테이블처럼 서클 하나에 칩 한 개만 얹는다. */
      function syncSpot(s){
        var el = document.getElementById('bjs-'+s.seat);
        if (!el) return;
        var key = s.bet + '|' + (s.payout != null ? s.payout : '');
        if (el.dataset.key === key) return;
        el.dataset.key = key;
        el.innerHTML = s.bet > 0
          ? '<span class="pchip '+chipKind(s.bet)+(s.userId===MEID?' mine':'')+'">'+chipLabel(s.bet)+'</span>'
          : '';
      }
      // 칩 모양은 금액대로 고른다 (코인 단위와 정확히 맞지 않아도 큰 금액은 골드바로 보이게)
      function chipKind(v){
        var c = (st && st.coins) || [];
        return v >= (c[c.length - BAR_COUNT] || 1000) ? 'c-bar' : 'c-coin';
      }
      function chipLabel(v){ return v>=10000 ? Math.floor(v/10000)+'만' : (v>=1000 ? Math.floor(v/1000)+'K' : String(v)); }

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
          dCardsEl.innerHTML = ''; seatsEl.dataset.sig = '';
          dTotalEl.textContent = '–';
          if (!firstState && window.casinoSfx) window.casinoSfx.shuffle();
        }

        // 딜러: 공개 전에는 업카드 한 장 + 뒷면 한 장
        var d = r.dealer;
        var dealerSlots = d.hidden ? d.cards.concat([null]) : d.cards;
        var dealt = syncCards(dCardsEl, 'dealer', dealerSlots);
        dTotalEl.textContent = d.total != null ? (d.hidden ? d.total + ' +?' : d.total) : '–';

        dealt += renderSeats();
        if (dealt && !firstState && window.casinoSfx) window.casinoSfx.deal();

        // 내 차례 버튼 — 결정 창에서 아직 안 정했을 때만
        var can = st.myHand && st.myHand.canAct;
        actionsEl.hidden = !can;
        hitBtn.disabled = !can; standBtn.disabled = !can;
        // 더블은 처음 두 장에서만 뜬다. 못 쓸 때 회색으로 남겨두면 왜 안 되는지 알 수 없어 아예 숨긴다.
        dblBtn.hidden = !(st.myHand && st.myHand.canDouble);

        renderRoster();
        firstState = false;

        if (r.phase === 'done' && notedRoundId !== r.id) {
          notedRoundId = r.id;
          collectWinnings();
          var me = (st.seats||[]).filter(function(s){ return s.userId === MEID; })[0];
          if (me && me.outcome) {
            if ((me.payout||0) > 0) {
              if (window.casinoSfx) window.casinoSfx.win();
              if (me.payout > me.bet) { if (card) replay(card, 'gold-flash'); if (pbal) replay(pbal, 'bump'); }
            } else if (window.casinoSfx) window.casinoSfx.lose();
          }
        }
      }

      /* ── 칩이 날아가는 연출 ──────────────────────────────────────────
         상자 밖을 지나는 구간이 잘리지 않도록 화면 전체를 덮는 레이어 위에서 날린다.
         포커·바카라와 같은 방식이지만 여기서는 두 장면만 쓴다:
         내가 칩을 올릴 때(코인 버튼 → 내 자리)와, 딸 때(내 자리 → 화면 하단).
         남이 거는 건 날리지 않는다 — 정보값이 없는데 다섯 자리에서 동시에 날면 카드를 가린다. */
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
        c.className = chip.className.replace(/\\b(toss|fly)\\b/g, '').trim() + ' ' + cls;
        c.style.cssText = 'position:fixed;margin:0;left:'+rect.left+'px;top:'+rect.top+'px;' +
          'width:'+rect.width+'px;height:'+rect.height+'px;';
        getFxLayer().appendChild(c);
        return c;
      }
      // 코인 버튼에서 내 자리 서클로 칩이 날아온다
      function tossToSeat(seat, denom){
        var spot = document.getElementById('bjs-'+seat);
        var src = coinsEl.querySelector('.coin[data-coin="'+denom+'"] .face');
        if (!spot || !src) return;
        var a = src.getBoundingClientRect(), b = spot.getBoundingClientRect();
        if (!a.width || !b.width) return;
        var ghost = document.createElement('span');
        ghost.className = 'pchip ' + chipKind(denom) + ' mine';
        ghost.textContent = chipLabel(denom);
        var c = cloneAt(ghost, { left: b.left + b.width/2 - 11, top: b.top + b.height/2 - 11, width: 22, height: 22 }, 'toss');
        c.style.setProperty('--fx', Math.round((a.left+a.width/2) - (b.left+b.width/2)) + 'px');
        c.style.setProperty('--fy', Math.round((a.top+a.height/2) - (b.top+b.height/2)) + 'px');
        c.style.setProperty('--fs', (Math.min(2.6, a.width / 22)).toFixed(2));
        setTimeout(function(){ if (c.parentNode) c.parentNode.removeChild(c); }, 380);
      }
      // 딴 칩이 내 쪽(화면 하단 칩 바)으로 빨려 들어온다
      function collectWinnings(){
        var controls = document.querySelector('.poker-controls');
        var target = (controls || coinsEl).getBoundingClientRect();
        var sent = [], n = 0;
        (st.seats||[]).forEach(function(s){
          if (!(s.payout > 0)) return;
          var spot = document.getElementById('bjs-'+s.seat);
          var chip = spot && spot.querySelector('.pchip');
          if (!chip) return;
          var r = chip.getBoundingClientRect();
          if (!r.width) return;
          // 남의 것은 오른쪽 참가자 아이콘으로, 내 것은 화면 하단으로
          var t = target;
          if (s.userId !== MEID) {
            var av = rosterEl.querySelector('.rw[data-uid="'+cssEsc(s.userId)+'"] .rw-av');
            var ab = av && av.getBoundingClientRect();
            if (ab && ab.width) t = ab;
          }
          var c = cloneAt(chip, r, 'fly');
          c.style.setProperty('--tx', Math.round((t.left+t.width/2) - (r.left+r.width/2)) + 'px');
          c.style.setProperty('--ty', Math.round((t.top+t.height/2) - (r.top+r.height/2)) + 'px');
          c.style.animationDelay = (n++ * 60) + 'ms';
          sent.push(c);
          spot.style.opacity = '0';
        });
        if (!n) return;
        setTimeout(function(){ sent.forEach(function(c){ if (c.parentNode) c.parentNode.removeChild(c); }); }, 900 + n*60);
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
          tossToSeat(seat, coin);
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
          if (st.myHand) tossToSeat(st.myHand.seat, coin || 0);
          if (window.casinoSfx) window.casinoSfx.card();
        }
        poll();
      });
      standBtn.addEventListener('click', async function(){
        await post('/api/games/blackjack/action', { action: 'stand' });
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
    </script>`;

  return layout('블랙잭', 'lobby', body);
}
