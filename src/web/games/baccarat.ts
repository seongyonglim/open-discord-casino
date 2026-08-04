// 바카라(푼토 방코): 여러 유저가 같은 라운드에 함께 베팅하는 실시간 공용 게임.
//
// 포커 플립과 화면 구조·칩 조작은 같지만, 게임 원리가 다르다:
//   · 플레이어가 내리는 선택이 하나도 없다. 몇 장을 더 받을지가 규칙 표로 고정돼 있다.
//   · 그래서 확률이 매 라운드 똑같고, 배당도 고정이다(포커처럼 라운드마다 다시 계산하지 않는다).
//   · 대신 "무엇이 나올지"가 아니라 "어느 쪽에 걸지"만 정하면 되므로 판단이 빠르고 회전이 빠르다.
//
// 시장 5개: 플레이어 / 뱅커 / 타이 + 사이드 베팅 P페어 · B페어.
// 무승부가 나면 플레이어·뱅커 베팅은 원금을 그대로 돌려준다(배당 계산이 그 환불분을 이미 반영한다).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';
import {
  advanceBaccaratRound, stackBaccaratBet, clearBaccaratBets,
  getBaccaratBets, getBaccaratPlayers, getMyBaccaratBets, getRecentBaccaratResults, getWebUser,
  BACC_THIRD_SEC, BACC_SETTLE_SEC, BACC_REVEAL_SEC,
  type BaccRoundRow, type BaccOutcome, type WebUser,
} from '../../db/queries';
import { baccaratProbabilities, drawRound, playRound, cardsToStrings, handTotal } from '../../services/baccarat';
import { oddsFromProbability, oddsForWinMarket } from '../../services/poker';
import { readJson, sendJson } from '../http';
import { layout, jsonForScript, sidePanel, rankPane, rankJs, helpButton, helpDialog } from '../views';
import { ASSET_V } from '../assets';
import { gameSwitcher } from '../pages';
import { COIN_SIZES } from './poker';

const HOUSE_EDGE = 0.01;

/* ── 배당 ────────────────────────────────────────────────────────────────
   확률이 고정이므로 배당도 고정이다. 프로세스 시작 때 한 번만 구해 캐시한다.
   플레이어·뱅커는 무승부가 환불이라 oddsForWinMarket(환불분을 빼고 계산)을 쓴다. */
export interface BaccOdds {
  player: number; banker: number; tie: number; ppair: number; bpair: number;
}

let oddsCache: BaccOdds | null = null;

export function baccaratOdds(): BaccOdds {
  if (oddsCache) return oddsCache;
  const p = baccaratProbabilities();
  // 확률이 0이 되는 시장이 없으므로 여기서 null이 나올 수 없다. 그래도 타입을 좁혀 둔다.
  const need = (v: number | null, name: string): number => {
    if (v == null) throw new Error(`바카라 ${name} 배당을 계산할 수 없습니다`);
    return v;
  };
  const pair = need(oddsFromProbability(p.pair, HOUSE_EDGE), 'pair');
  oddsCache = {
    player: need(oddsForWinMarket(p.player, p.tie, HOUSE_EDGE), 'player'),
    banker: need(oddsForWinMarket(p.banker, p.tie, HOUSE_EDGE), 'banker'),
    tie: need(oddsFromProbability(p.tie, HOUSE_EDGE), 'tie'),
    ppair: pair, bpair: pair,
  };
  return oddsCache;
}

const VALID_MARKETS = new Set(['player', 'banker', 'tie', 'ppair', 'bpair']);

/* ── 라운드 진행 ─────────────────────────────────────────────────────── */

function resolve(cards: number[]): BaccOutcome {
  const o = playRound(cards);
  return {
    winner: o.winner,
    playerTotal: o.playerTotal, bankerTotal: o.bankerTotal,
    playerPair: o.playerPair, bankerPair: o.bankerPair,
    natural: o.natural,
    playerCards: o.playerCards, bankerCards: o.bankerCards,
  };
}

function advance(): BaccRoundRow {
  return advanceBaccaratRound(() => drawRound(randomInt), resolve);
}

/* 공개 범위: 마감 즉시 양쪽 두 장 → 세 번째 카드 → 정산.
   공개 전 카드는 절대 클라이언트로 내려보내지 않는다(미리 알면 게임이 성립하지 않는다).

   끗수는 보이는 카드만으로 그때그때 계산한다. 정산 결과(result_json)를 기다렸다가 쓰면
   카드가 다 나온 뒤에도 큰 숫자가 '–'로 남아, 정작 결론이 제일 늦게 보인다.
   첫 두 장의 끗수는 "세 번째 카드가 올지"를 가늠하는 정보라 실제 테이블에서도 바로 보여준다. */
interface VisibleHands { player: string[]; banker: string[]; playerTotal: number | null; bankerTotal: number | null }

function visible(round: BaccRoundRow): VisibleHands {
  if (round.phase === 'betting') {
    return { player: [], banker: [], playerTotal: null, bankerTotal: null };
  }
  const o = playRound(JSON.parse(round.cards_json) as number[]);
  // deal 단계에서는 첫 두 장까지만
  const n = round.phase === 'deal' ? 2 : 3;
  const p = o.playerCards.slice(0, n);
  const b = o.bankerCards.slice(0, n);
  return {
    player: cardsToStrings(p),
    banker: cardsToStrings(b),
    playerTotal: handTotal(p),
    bankerTotal: handTotal(b),
  };
}

function secondsLeft(round: BaccRoundRow): number {
  const now = Math.floor(Date.now() / 1000);
  if (round.phase === 'betting') return Math.max(0, round.betting_ends_at - now);
  if (round.phase === 'done') return Math.max(0, (round.resolved_at ?? now) + BACC_REVEAL_SEC - now);
  const e = now - round.betting_ends_at;
  const next = e < BACC_THIRD_SEC ? BACC_THIRD_SEC : BACC_SETTLE_SEC;
  return Math.max(0, next - e);
}

function statePayload(round: BaccRoundRow, userId: string) {
  const vis = visible(round);
  const result = round.result_json ? JSON.parse(round.result_json) as BaccOutcome : null;
  const p = baccaratProbabilities();

  return {
    ok: true,
    round: {
      id: round.id,
      phase: round.phase,
      secondsLeft: secondsLeft(round),
      player: vis.player,
      banker: vis.banker,
      playerTotal: vis.playerTotal,
      bankerTotal: vis.bankerTotal,
      result: result && round.phase === 'done'
        ? {
            winner: result.winner,
            playerTotal: result.playerTotal, bankerTotal: result.bankerTotal,
            playerPair: result.playerPair, bankerPair: result.bankerPair,
            natural: result.natural,
          }
        : null,
    },
    odds: baccaratOdds(),
    prob: { player: p.player, banker: p.banker, tie: p.tie, pair: p.pair },
    coins: COIN_SIZES,
    me: userId,
    balance: getWebUser(userId)?.balance ?? 0,
    bets: getBaccaratBets(round.id),
    myBets: getMyBaccaratBets(round.id, userId),
    players: getBaccaratPlayers(round.id),
    history: getRecentBaccaratResults(20),
  };
}

export async function handleState(_req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  return sendJson(res, 200, statePayload(advance(), userId));
}

export async function handleBet(req: IncomingMessage, res: ServerResponse, userId: string, username: string): Promise<void> {
  // 본문 파싱(await)을 먼저 끝낸다 — 라운드 확인과 베팅 사이에 await가 있으면 그 틈에
  // 라운드가 마감·정산되어 이미 끝난 라운드에 베팅이 들어갈 수 있다.
  const data = await readJson(req);
  const market = String(data?.market ?? '');
  const amount = Math.floor(Number(data?.amount));
  if (!VALID_MARKETS.has(market)) return sendJson(res, 400, { error: '알 수 없는 베팅 시장입니다' });
  if (!COIN_SIZES.includes(amount)) return sendJson(res, 400, { error: '코인 단위가 올바르지 않습니다' });

  const round = advance();
  if (round.phase !== 'betting') return sendJson(res, 400, { error: '베팅이 마감되었습니다. 다음 라운드를 기다려주세요.' });

  const odds = baccaratOdds()[market as keyof BaccOdds];
  const r = stackBaccaratBet(userId, username, round.id, market, amount, odds);
  if (!r.ok) {
    return sendJson(res, 400, {
      error: r.error === 'closed' ? '베팅이 마감되었습니다. 다음 라운드를 기다려주세요.' : '잔액이 부족합니다',
    });
  }
  return sendJson(res, 200, { ok: true, balance: r.balance, staked: r.staked });
}

export async function handleClear(_req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const round = advance();
  const r = clearBaccaratBets(userId, round.id);
  if (!r.ok) {
    return sendJson(res, 400, {
      error: r.error === 'nothing' ? '회수할 칩이 없습니다' : '베팅이 마감되어 회수할 수 없습니다',
    });
  }
  return sendJson(res, 200, { ok: true, balance: r.balance, refunded: r.refunded });
}

/* ── 화면 ────────────────────────────────────────────────────────────── */

/* 규칙 도움말.
   확률은 baccaratProbabilities()가 1덱 전수 계산으로 내는 값이고(플레이어 44.68 ·
   뱅커 45.96 · 타이 9.36 · 페어 5.88%), 배당은 거기서 HOUSE_EDGE 1%로 만든다.
   배당은 화면에서 실제 값을 보여주므로 여기에는 숫자를 박지 않는다 — 어긋날 수 있다. */
const RULES_HTML = `
  <h4>목표</h4>
  <p><b>플레이어</b>와 <b>뱅커</b> 중 카드 합이 <b>9에 가까운 쪽</b>이 이깁니다.
     나는 카드를 받지 않고 어느 쪽이 이길지에만 겁니다.</p>

  <h4>끗수</h4>
  <ul>
    <li><b>A</b> 1 · <b>2~9</b> 숫자 그대로 · <b>10 · J · Q · K</b> 0</li>
    <li>합이 두 자리면 <b>일의 자리만</b> 씁니다 (7 + 8 = 15 → <b>5</b>)</li>
  </ul>

  <h4>다섯 갈래에 걸 수 있습니다</h4>
  <table>
    <tr><td>플레이어 승</td><td>약 44.7%</td></tr>
    <tr><td>뱅커 승</td><td>약 46.0%</td></tr>
    <tr><td>타이 (무승부)</td><td>약 9.4%</td></tr>
    <tr><td>플레이어 페어 · 뱅커 페어</td><td>각 약 5.9%</td></tr>
  </table>
  <p>배당은 이 확률에서 만들어 화면에 표시됩니다.
     <b>플레이어·뱅커에 걸었는데 타이가 나오면 원금을 돌려받습니다.</b></p>

  <h4>카드는 한 벌(52장)입니다</h4>
  <p>매 판 <b>한 벌을 새로 섞어</b> 씁니다. 실제 카지노는 6~8벌을 쓰지만
     여기는 내부 친선 룰로 한 벌만 씁니다.</p>

  <h4>세 번째 카드</h4>
  <p>두 장씩 받은 뒤 규칙에 따라 <b>자동으로</b> 한 장을 더 받습니다.
     내가 고를 것은 없습니다 — 정해진 표대로 딜러가 처리합니다.</p>

  <p class="tip"><b>꿀팁 —</b> 뱅커가 플레이어보다 조금 자주 이깁니다(46.0% vs 44.7%).
     타이와 페어는 배당이 큰 만큼 드뭅니다.</p>
`;

export function baccaratPage(user: WebUser): string {
  const o = baccaratOdds();
  const p = baccaratProbabilities();

  const body = `
    ${gameSwitcher('baccarat')}
    <div class="game-shell">
      <div class="game-main">
        <div class="card">
          ${helpButton('bcHelp')}
          <div class="bacc-bead-head">
            <span>최근 결과</span>
            <span class="bacc-bead-legend">
              <i class="bacc-bead p"></i>플레이어 <i class="bacc-bead b"></i>뱅커 <i class="bacc-bead t"></i>타이
            </span>
          </div>
          <div id="bHistory" class="bacc-bead-row"></div>

          <div class="bacc-table">
            <div id="bStatus" class="bacc-status">베팅을 기다리는 중…</div>
            <div class="bacc-seats">
              <div class="bacc-seat side-player" id="bPlayerSeat">
                <div class="bacc-name">PLAYER</div>
                <div id="bPlayerCards" class="bacc-hand"></div>
                <div id="bPlayerTotal" class="bacc-total">–</div>
              </div>
              <div class="bacc-vs">VS</div>
              <div class="bacc-seat side-banker" id="bBankerSeat">
                <div class="bacc-name">BANKER</div>
                <div id="bBankerCards" class="bacc-hand"></div>
                <div id="bBankerTotal" class="bacc-total">–</div>
              </div>
            </div>
          </div>

          <!-- 상자 골격은 스크립트가 통째로 그린다 — 칩 더미가 상자 안에 살기 때문에
               라운드/결과가 바뀔 때만 다시 그려야 쌓아둔 칩이 날아가지 않는다 -->
          <div class="market-grid" id="bMarkets"></div>
        </div>

        <div class="card game-controls poker-controls">
          <div class="coin-row" id="bCoins"></div>
          <button id="bClear" class="btn" type="button">Clear Screen</button>
        </div>
      </div>

      ${sidePanel('b', `
        <div class="side-head"><span>참가자</span><span id="bPot" class="num">0P</span></div>
        <div id="bRoster" class="roster"><div class="empty" style="padding:16px 0">아직 참가자가 없습니다</div></div>
      `, rankPane('b'))}
    </div>
    <script>
      window.__ME__ = ${jsonForScript(user.username)};
      window.__MEID__ = ${jsonForScript(user.id)};
      window.__SFX_NEED__ = ['coin','gain','card','shuffle','deal'];
    </script>
    <script>
    (function(){
      var AV = ${JSON.stringify(ASSET_V)};
      var ODDS = ${jsonForScript(o)};
      var PROB = ${jsonForScript({ player: p.player, banker: p.banker, tie: p.tie, pair: p.pair })};

      var statusEl=document.getElementById('bStatus'), histEl=document.getElementById('bHistory');
      var marketsEl=document.getElementById('bMarkets');
      var pCardsEl=document.getElementById('bPlayerCards'), bCardsEl=document.getElementById('bBankerCards');
      var pTotalEl=document.getElementById('bPlayerTotal'), bTotalEl=document.getElementById('bBankerTotal');
      var pSeatEl=document.getElementById('bPlayerSeat'), bSeatEl=document.getElementById('bBankerSeat');
      var coinsEl=document.getElementById('bCoins'), clearBtn=document.getElementById('bClear');
      var rosterEl=document.getElementById('bRoster'), potEl=document.getElementById('bPot');
      var pbal=document.querySelector('.prof .pbal');
      var card=document.querySelector('.card');

      var st=null, coin=null, lastRoundId=null, notedRoundId=null;
      // 페이지 진입 직후에는 카드 공개음을 건너뛴다 — 들어오자마자 소리가 몰아치면 정신없다
      var firstState = true;
      var MAX_CHIPS = 18;   // 상자 하나에 그리는 칩 스프라이트 상한 (넘으면 오래된 것부터 제거)

      var MARKET_DEFS = [
        { key:'player', label:'플레이어', sub:'PLAYER', cls:'m-player' },
        { key:'tie',    label:'타이',     sub:'TIE',    cls:'m-tie' },
        { key:'banker', label:'뱅커',     sub:'BANKER', cls:'m-banker' }
      ];
      var PAIR_DEFS = [
        { key:'ppair', label:'플레이어 페어', sub:'첫 두 장 같은 숫자', cls:'m-pair' },
        { key:'bpair', label:'뱅커 페어',     sub:'첫 두 장 같은 숫자', cls:'m-pair' }
      ];
      var ALL_KEYS = ['player','tie','banker','ppair','bpair'];

      function fmt(n){ return new Intl.NumberFormat('ko-KR').format(Math.floor(n)) + 'P'; }
      function compact(n){ return new Intl.NumberFormat('ko-KR').format(n); }
      function setBalance(n){ if(pbal && typeof n==='number') pbal.textContent = fmt(n); }
      function replay(el, cls){ el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
      function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
      function cssEsc(s){ return String(s).replace(/["\\\\]/g, '\\\\$&'); }
      function chipLabel(v){ return v>=10000 ? (v/10000)+'만' : String(v); }   // 1000은 1000 그대로 — K로 줄이지 않는다
      function coinLabel(v){ return v>=10000 ? (v/10000)+'만' : String(v); }

      // 뒤 세 단위(1000·5000·1만)는 골드바, 앞은 동전 — 포커 플립과 같은 규칙
      var BAR_COUNT = 3;
      function chipKind(v){
        var c = (st && st.coins) || [], i = c.indexOf(v);
        return (i >= 0 && i < c.length - BAR_COUNT) ? 'c-coin' : 'c-bar';
      }
      function buttonKind(v){ return chipKind(v) === 'c-coin' ? 'kind-coin' : 'kind-bar'; }

      var SUIT_SYM={s:'\\u2660',h:'\\u2665',d:'\\u2666',c:'\\u2663'};
      function cardHtml(cstr){
        if (!cstr) return '<img class="pcard back" src="/cards/back.svg?v='+AV+'" alt="">';
        var rank = (cstr[0]==='T'?'10':cstr[0]);
        return '<img class="pcard" src="/cards/'+cstr+'.svg?v='+AV+'" alt="'+rank+SUIT_SYM[cstr[1]]+'">';
      }

      /* ── 카드 슬롯 동기화 ────────────────────────────────────────────
         매 폴링마다 innerHTML을 통째로 갈아끼우면 카드가 초당 한 번씩 다시 튀고
         순차 공개 연출이 사라진다. 그래서 내용이 바뀐 칸만 교체한다.
         바카라는 손패 장수 자체가 2장에서 3장으로 늘어나므로 길이 변화도 함께 다룬다. */
      var slotCache={};
      function syncCards(el, key, values){
        var cache = slotCache[key];
        if (!cache) { cache = slotCache[key] = []; el.innerHTML = ''; }
        // 장수가 줄었으면(새 라운드) 통째로 비운다
        if (values.length < cache.length) { el.innerHTML = ''; cache = slotCache[key] = []; }
        var revealed = 0;
        for (var i=0;i<values.length;i++){
          if (cache[i] === values[i]) continue;
          cache[i] = values[i];
          if (el.children[i]) el.children[i].outerHTML = cardHtml(values[i]);
          else el.insertAdjacentHTML('beforeend', cardHtml(values[i]));
          revealed++;
        }
        return revealed;
      }

      /* ── 딜링 연출 ───────────────────────────────────────────────────
         베팅 10초 동안 테이블이 비어 있으면 셔플 소리만 나고 볼 게 없다.
         그래서 새 라운드가 열리면 뒷면 네 장을 딜러 자리에서 한 장씩 내려놓는다.
         순서는 실제 바카라 그대로 플레이어 → 뱅커 → 플레이어 → 뱅커.
         마감되면 이 뒷면들이 그 자리에서 앞면으로 뒤집힌다(.pcard의 cardFlip). */
      var dealtRoundId = null, dealing = false, pendingDeal = [];
      function dealSlots(){
        return [
          { el: pCardsEl, i: 0 }, { el: bCardsEl, i: 0 },
          { el: pCardsEl, i: 1 }, { el: bCardsEl, i: 1 },
        ];
      }
      function showAllCards(){
        [pCardsEl, bCardsEl].forEach(function(el){
          Array.prototype.forEach.call(el.querySelectorAll('.pcard'), function(c){ c.style.visibility = ''; });
        });
        if (fxLayer) {
          Array.prototype.forEach.call(fxLayer.querySelectorAll('.deal-in'), function(c){
            if (c.parentNode) c.parentNode.removeChild(c);
          });
        }
      }
      function clearDeal(){
        pendingDeal.forEach(clearTimeout);
        pendingDeal = [];
        dealing = false;
        showAllCards();
      }
      // 카드가 테이블 상단 중앙(딜러 자리)에서 제자리로 날아온다.
      // 원본은 잠깐 숨기고 화면 전체 레이어에 복제본을 띄운다 — 자리 상자 밖 구간이 잘리지 않게.
      function flyCardIn(card){
        var r = card.getBoundingClientRect();
        if (!r.width) return;
        var stage = document.querySelector('.bacc-table');
        var s = stage ? stage.getBoundingClientRect() : { left: r.left, top: r.top, width: 0 };
        var c = card.cloneNode(true);
        c.className = card.className.replace(/\\bdeal-in\\b/g, '').trim();
        c.style.cssText = 'position:fixed;margin:0;left:' + r.left + 'px;top:' + r.top + 'px;' +
          'width:' + r.width + 'px;height:' + r.height + 'px;';
        c.style.setProperty('--dfx', Math.round((s.left + s.width / 2) - (r.left + r.width / 2)) + 'px');
        c.style.setProperty('--dfy', Math.round((s.top - 34) - r.top) + 'px');
        c.classList.add('deal-in');
        getFxLayer().appendChild(c);
        card.style.visibility = 'hidden';
        // 이 타이머도 pendingDeal에 넣어야 중단 시 clearDeal이 함께 정리하고 카드를 되살린다
        pendingDeal.push(setTimeout(function(){
          if (c.parentNode) c.parentNode.removeChild(c);
          card.style.visibility = '';
        }, 300));
      }
      function dealSequence(roundId){
        if (dealing || dealtRoundId === roundId) return;
        dealing = true; dealtRoundId = roundId;

        var slots = dealSlots();
        slots.forEach(function(s){
          var c = s.el.children[s.i];
          if (c) c.style.visibility = 'hidden';
        });
        /* 소리는 두 종류를 역할대로 갈라 쓴다:
             나눠주기(card-deal) — 카드가 새로 날아와 놓이는 순간. 여기, 그리고 세 번째 카드.
             넘기기(card-flip)   — 이미 놓인 뒷면을 뒤집는 순간.
           한때 뒤집기에도 "나눠주는" 소리를 썼는데, 카드가 새로 오는 것도 아닌데 딜링 소리가 나서
           방금 나눠준 걸 또 나눠주는 것처럼 들렸다. 같은 카드 네 장에 딜링 소리가 여덟 번 난 셈이다. */
        if (window.casinoSfx && window.casinoSfx.shuffle) window.casinoSfx.shuffle();

        // 셔플 소리가 잦아든 뒤부터 한 장씩. 네 장에 1.2초 남짓이라 10초 베팅 창에 넉넉히 들어간다.
        var SHUFFLE_MS = 500, STEP = 175, FLY_MS = 300;   // FLY_MS = .deal-in 애니메이션 길이
        slots.forEach(function(s, n){
          pendingDeal.push(setTimeout(function(){
            var card = s.el.children[s.i];
            if (!card) return;
            card.style.visibility = '';
            flyCardIn(card);
            if (window.casinoSfx && window.casinoSfx.deal) window.casinoSfx.deal();
          }, SHUFFLE_MS + n * STEP));
        });
        /* 마지막 장이 날아 도착한 뒤에 연출을 닫는다.
           마지막 장의 콜백 안에서 showAllCards()를 부르면 그 순간 아직 날고 있던
           복제본(넷째 장 + 셋째 장)까지 같이 걷어내서, 두 장이 밀려오지 않고 제자리에
           툭 생겨나는 것처럼 보인다 — 딜링이 끊기는 느낌의 원인이었다. */
        pendingDeal.push(setTimeout(function(){ dealing = false; },
          SHUFFLE_MS + (slots.length - 1) * STEP + FLY_MS));
        // 연출이 어떤 이유로 끊겨도 반드시 카드가 다시 보이도록 하는 안전장치
        pendingDeal.push(setTimeout(function(){ dealing = false; showAllCards(); },
          SHUFFLE_MS + slots.length * STEP + 800));
      }

      /* ── 한 장씩 공개 ────────────────────────────────────────────────
         실제 푼토 방코의 공개 순서를 그대로 따른다:
           플레이어 두 장 → (끗수 확인) → 뱅커 두 장 → (끗수 확인)
           → 플레이어 서드 → 뱅커 서드
         네 장을 한꺼번에 뒤집으면 이미 끝난 결과를 통보받는 느낌이라 볼 맛이 없다.
         서버는 단계별로 카드를 다 내려주고, 그중 "지금까지 깐 만큼"만 화면에 그린다.
         (서버 시간 해상도는 1초라 이 정도 간격은 클라이언트에서 재는 게 맞다)                */
      // shown = 지금 화면에 깐 장수, scheduled = 예약까지 끝난 장수.
      // 둘을 나눠 두는 이유: 1초 폴링이 공개 도중에 들어올 때 shown만 보고 다시 예약하면
      // 아직 안 터진 타이머를 취소하고 지연 0으로 새로 잡아, 마지막 장이 일찍 튀어나온다
      // (실측으로 320ms 간격이 186ms로 무너졌다). 예약된 몫은 건드리지 않는다.
      var shown = { p: 0, b: 0 }, scheduled = { p: 0, b: 0 };
      var revealTimers = [];
      var FLIP_MS = 320;      // 같은 손 안에서 카드 한 장 간격
      // 플레이어 끗수가 뜬 뒤 뱅커로 넘어가기 전 한 박자.
      // 카드 간격과 비슷하게 잡았더니(260ms) 그냥 네 장이 죽 넘어가는 걸로만 보였다 —
      // "플레이어 얼마 나왔네" 하고 뱅커를 기다리는 구간이 생기려면 확실히 더 벌려야 한다.
      var HAND_GAP_MS = 520;

      function clearReveal(){ revealTimers.forEach(clearTimeout); revealTimers = []; }

      // 끗수는 화면에 깐 카드만으로 계산한다 — 아직 안 깐 카드가 합계에 미리 반영되면
      // 뒤집기 전에 결과가 새어 나간다
      function cardVal(c){
        var r = c[0];
        if (r === 'A') return 1;
        if (r === 'T' || r === 'J' || r === 'Q' || r === 'K') return 0;
        return Number(r);
      }
      function totalOf(cards){
        return cards.reduce(function(s, c){ return s + cardVal(c); }, 0) % 10;
      }

      function scheduleReveal(r){
        var wantP = r.player.length, wantB = r.banker.length;
        if (wantP <= scheduled.p && wantB <= scheduled.b) return;
        // 아직 예약 안 된 카드만 카지노 순서대로 줄 세운다 — 플레이어가 먼저, 그다음 뱅커
        var steps = [];
        for (var i = scheduled.p; i < wantP; i++) steps.push('p');
        var handBreak = steps.length;           // 여기서 손이 바뀐다
        for (var j = scheduled.b; j < wantB; j++) steps.push('b');
        scheduled.p = wantP; scheduled.b = wantB;

        var t = 0;
        steps.forEach(function(side, n){
          if (n === handBreak && n > 0) t += HAND_GAP_MS;   // 플레이어 끗수를 볼 틈
          else if (n > 0) t += FLIP_MS;
          revealTimers.push(setTimeout(function(){
            shown[side]++;
            paintHands(st && st.round);
            // 공개는 전부 "넘기는" 소리다 — 뒤집는 것뿐이라 카드가 새로 오지 않는다.
            // 예외로 세 번째 카드는 진짜 새로 오는 카드라 "나눠주는" 소리를 쓴다.
            if (window.casinoSfx) {
              if (shown[side] > 2) window.casinoSfx.deal();
              else window.casinoSfx.card();
            }
          }, t));
        });
      }

      // 깐 만큼만 그린다. 아직 안 깐 자리는 뒷면으로 남겨 둔다(베팅 중 네 장도 이 경로다).
      function paintHands(r){
        if (!r) return;
        function slots(cards, n){
          var len = Math.max(n, 2);
          var out = [];
          for (var i = 0; i < len; i++) out.push(i < n ? cards[i] : null);
          return out;
        }
        syncCards(pCardsEl, 'p', slots(r.player, shown.p));
        syncCards(bCardsEl, 'b', slots(r.banker, shown.b));
        // 한 장만 깐 상태의 끗수는 의미가 없으므로 두 장부터 보여준다
        pTotalEl.textContent = shown.p >= 2 ? totalOf(r.player.slice(0, shown.p)) : '–';
        bTotalEl.textContent = shown.b >= 2 ? totalOf(r.banker.slice(0, shown.b)) : '–';
      }

      /* ── 최근 결과 (구슬판) ─────────────────────────────────────────
         바카라 테이블에 항상 붙어 있는 그 판이다. 최신이 왼쪽. */
      function renderHistory(rows){
        if (!rows || !rows.length) { histEl.innerHTML = '<span class="bacc-bead-empty">아직 기록이 없습니다</span>'; return; }
        var sig = rows.map(function(r){ return r.winner[0]+r.playerTotal+r.bankerTotal; }).join('');
        if (histEl.dataset.sig === sig) return;
        histEl.dataset.sig = sig;
        histEl.innerHTML = rows.map(function(r){
          var c = r.winner === 'player' ? 'p' : r.winner === 'banker' ? 'b' : 't';
          var mark = r.winner === 'player' ? 'P' : r.winner === 'banker' ? 'B' : 'T';
          return '<span class="bacc-bead '+c+'" title="플레이어 '+r.playerTotal+' : 뱅커 '+r.bankerTotal+'">'+mark+'</span>';
        }).join('');
      }

      /* ── 베팅 상자 ──────────────────────────────────────────────────
         골격은 라운드/단계/결과가 바뀔 때만 다시 그린다.
         매초 새로 만들면 그 순간의 클릭이 씹히고 쌓아둔 칩 더미도 날아간다. */
      function marketTile(d, betting, isPair){
        var res = st.round.result;
        var winCls = '';
        if (res) {
          var hit = (d.key==='player' && res.winner==='player')
                 || (d.key==='banker' && res.winner==='banker')
                 || (d.key==='tie'    && res.winner==='tie')
                 || (d.key==='ppair'  && res.playerPair)
                 || (d.key==='bpair'  && res.bankerPair);
          // 무승부는 플레이어·뱅커에 승패가 아니라 환불이므로 흐리게 처리하지 않는다
          if ((d.key==='player'||d.key==='banker') && res.winner==='tie') winCls = '';
          else winCls = hit ? ' hit' : ' miss';
        }
        var pr = isPair ? PROB.pair : PROB[d.key];
        return '<button type="button" class="market '+d.cls+(betting?'':' disabled')+winCls+'" data-market="'+d.key+'">' +
          '<span class="m-top"><span class="m-total" id="tot-'+d.key+'">0</span>' +
            '<span class="m-odds">'+ODDS[d.key].toFixed(2)+'x</span></span>' +
          '<span class="m-pile" id="pile-'+d.key+'"></span>' +
          '<span class="m-body"><span class="m-label">'+d.label+'</span>' +
            '<span class="m-sub">'+d.sub+' · '+(pr*100).toFixed(1)+'%</span></span>' +
          '</button>';
      }
      var marketSig=null;
      function renderMarkets(){
        var betting = st.round.phase==='betting';
        var sig = st.round.id+'|'+st.round.phase+'|'+JSON.stringify(st.round.result||null);
        if (sig === marketSig) return;
        marketSig = sig;
        var html = '<div class="market-row bacc-main">' +
          MARKET_DEFS.map(function(d){ return marketTile(d, betting, false); }).join('') +
          '</div><div class="market-row bacc-pair">' +
          PAIR_DEFS.map(function(d){ return marketTile(d, betting, true); }).join('') +
          '</div>';
        marketsEl.innerHTML = html;
        piles = {};   // 골격을 새로 만들었으니 더미 캐시도 초기화
        marketsEl.querySelectorAll('.market').forEach(function(el){
          el.addEventListener('click', function(){
            if (el.classList.contains('disabled')) return;
            placeChip(el.getAttribute('data-market'));
          });
        });
      }

      /* ── 코인 더미 ───────────────────────────────────────────────────
         상자별로 "지금까지 올라온 칩 목록"을 들고 있다가, 늘어난 만큼만 새 스프라이트를
         덧붙인다. 총액에서 매번 새로 그리면 애니메이션이 초당 다시 시작되고
         쌓이는 느낌이 사라진다. (포커 플립과 같은 방식)                            */
      var piles={};
      function jit(i, m){ var x=Math.sin(i*12.9898)*43758.5453; return Math.floor((x-Math.floor(x))*m); }
      // anim: '' 없음 · 'pending' 자리만 잡고 숨김(곧 날아올 칩)
      // owner를 심어두면 정산 때 그 칩을 주인 아이콘으로 돌려보낼 수 있다.
      function chipSprite(denom, owner, idx, anim){
        var col = idx % 5, row = Math.floor(idx / 5);
        var x = (col - 2) * 14 + jit(idx, 9) - 4;
        var y = 3 + row * 5 + jit(idx + 7, 3);
        return '<span class="pchip '+chipKind(denom)+(owner===st.me?' mine':'')+(anim?' '+anim:'')+
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
          pile.list.push(denoms[i]);
          el.insertAdjacentHTML('beforeend', chipSprite(denoms[i], owner, pile.n++ % MAX_CHIPS, anim));
          added.push(el.lastElementChild);
        }
        return added;
      }
      function rebuildPile(el, market, byUser, roundId){
        var pile = piles[market] = { round: roundId, byUser: {}, list: [], n: 0 };
        el.style.opacity = '';   // 회수 연출로 숨겨뒀던 더미를 되살린다
        el.innerHTML = '';
        Object.keys(byUser).forEach(function(uid){
          pile.byUser[uid] = byUser[uid];
          pushChips(el, pile, decompose(byUser[uid]), uid, '');
        });
      }
      function syncPile(market, byUser, roundId){
        var el = document.getElementById('pile-'+market);
        if (!el) return;
        var pile = piles[market];
        if (!pile || pile.round !== roundId) return rebuildPile(el, market, byUser, roundId);

        // 누구든 금액이 줄었으면(회수/Clear Screen) 애니메이션 없이 다시 그린다
        var uids = Object.keys(pile.byUser);
        for (var i=0;i<uids.length;i++){
          if ((byUser[uids[i]]||0) < pile.byUser[uids[i]]) return rebuildPile(el, market, byUser, roundId);
        }
        // 늘어난 사람만큼 그 사람 아이콘에서 칩이 날아온다
        Object.keys(byUser).forEach(function(uid){
          var delta = byUser[uid] - (pile.byUser[uid]||0);
          if (delta <= 0) return;
          pile.byUser[uid] = byUser[uid];
          // 내 칩은 이미 클릭 즉시(dropMyChip) 올려놨으므로 여기서 또 올리지 않는다
          if (uid === st.me) return;
          var added = pushChips(el, pile, decompose(delta), uid, 'pending');
          tossFrom(rosterAvatar(uid), added);
        });
      }

      // 칩이 상자 밖을 지나는 구간은 .market의 overflow:hidden에 잘려 보이지 않으므로,
      // 날아가는 연출은 전부 화면 전체를 덮는 이 레이어 위에서 한다.
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
        c.className = chip.className.replace(/\\b(drop|toss|pending|fly)\\b/g, '').trim() + ' ' + cls;
        c.style.cssText = 'position:fixed;margin:0;left:' + rect.left + 'px;top:' + rect.top + 'px;' +
          'width:' + rect.width + 'px;height:' + rect.height + 'px;';
        getFxLayer().appendChild(c);
        return c;
      }
      // 우측 참가자 패널에서 그 사람의 아바타 요소를 찾는다 (칩의 출발지·도착지)
      function rosterAvatar(uid){
        return rosterEl.querySelector('.rw[data-uid="'+cssEsc(uid)+'"] .rw-av');
      }
      // src 요소 위치에서 chips(제자리에 숨겨둔 원본)로 칩이 날아오게 한다
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
      // 방금 누른 코인 버튼의 실제 화면 위치에서 출발해 상자 안 제자리로 날아온다.
      function dropMyChip(market, denom){
        var el = document.getElementById('pile-'+market), pile = piles[market];
        if (!el || !pile) return;
        var added = pushChips(el, pile, [denom], st.me, 'pending');
        pile.byUser[st.me] = (pile.byUser[st.me]||0) + denom;
        tossFrom(coinsEl.querySelector('.coin[data-coin="'+denom+'"] .face'), added);
      }
      // 돈이 나온 상자의 칩을 각자 주인에게 돌려보낸다.
      // 내 것은 화면 아래 중앙(칩 바)으로 빨려들어오고, 남의 것은 오른쪽 참가자 아이콘으로 간다.
      function flyChipsToPot(markets){
        var controls = document.querySelector('.poker-controls');
        var myTarget = (controls || coinsEl).getBoundingClientRect();
        var sent = [], n = 0;
        markets.forEach(function(m){
          var pile = document.getElementById('pile-' + m);
          if (!pile) return;
          Array.prototype.forEach.call(pile.querySelectorAll('.pchip'), function(ch){
            var r = ch.getBoundingClientRect();
            if (!r.width) return;
            var t;
            if (ch.classList.contains('mine')) t = myTarget;
            else {
              var av = rosterAvatar(ch.getAttribute('data-owner') || '');
              t = (av && av.getBoundingClientRect().width) ? av.getBoundingClientRect() : myTarget;
            }
            var c = cloneAt(ch, r, 'fly');
            c.style.setProperty('--tx', Math.round((t.left + t.width/2) - (r.left + r.width/2)) + 'px');
            c.style.setProperty('--ty', Math.round((t.top + t.height/2) - (r.top + r.height/2)) + 'px');
            c.style.animationDelay = (n++ * 40) + 'ms';
            sent.push(c);
          });
          pile.style.opacity = '0';
        });
        if (!n) return;
        setTimeout(function(){
          sent.forEach(function(c){ if (c.parentNode) c.parentNode.removeChild(c); });
        }, 900 + n * 40);
      }
      // 돈이 나온 상자 — 무승부면 플레이어·뱅커도 원금이 돌아가므로 함께 회수한다
      function payingMarkets(res){
        var out = res.winner === 'tie' ? ['player','banker','tie'] : [res.winner];
        if (res.playerPair) out.push('ppair');
        if (res.bankerPair) out.push('bpair');
        return out;
      }

      /* ── 코인 버튼 ──────────────────────────────────────────────── */
      function renderCoins(){
        if (coinsEl.dataset.done) return;
        coinsEl.dataset.done = '1';
        coinsEl.innerHTML = (st.coins||[]).map(function(v){
          return '<button type="button" class="coin '+buttonKind(v)+'" data-coin="'+v+'">' +
            '<span class="face">'+coinLabel(v)+'</span></button>';
        }).join('');
        coin = (st.coins||[])[0];
        coinsEl.querySelectorAll('.coin').forEach(function(b){
          b.addEventListener('click', function(){
            coin = Number(b.dataset.coin);
            syncCoinActive();
          });
        });
        syncCoinActive();
      }
      function syncCoinActive(){
        coinsEl.querySelectorAll('.coin').forEach(function(b){
          b.classList.toggle('active', Number(b.dataset.coin) === coin);
        });
      }

      /* ── 우측 참가자 패널 ──────────────────────────────────────────
         칩이 아바타에서 출발하고 아바타로 돌아가므로 더미보다 먼저 그려져 있어야 한다. */
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
              return '<div class="rw'+(p.user_id===st.me?' me':'')+'" data-uid="'+esc(p.user_id)+'">' +
                av +
                '<span class="rw-mid"><span class="rw-name">'+esc(p.username)+'</span>' +
                '<span class="rw-bal" id="bal-'+esc(p.user_id)+'">'+fmt(p.balance)+'</span></span>' +
                '<span class="rw-bet" id="bet-'+esc(p.user_id)+'"></span></div>';
            }).join('');
          }
        }
        players.forEach(function(p){
          var balEl = document.getElementById('bal-'+p.user_id);
          if (balEl) {
            var prev = lastBal[p.user_id];
            if (prev != null && p.balance !== prev) replay(balEl, p.balance > prev ? 'up' : 'down');
            balEl.textContent = fmt(p.balance);
          }
          lastBal[p.user_id] = p.balance;
          var betEl = document.getElementById('bet-'+p.user_id);
          if (betEl) {
            betEl.innerHTML = (p.payout > 0)
              ? '<span class="pos">+'+fmt(p.payout)+'</span>'
              : fmt(p.staked);
          }
          var row = rosterEl.querySelector('.rw[data-uid="'+cssEsc(p.user_id)+'"]');
          if (row) row.classList.toggle('won', p.payout > 0);
        });
      }

      // 총액 표기 + 코인 더미는 매 폴링마다 갱신 (골격은 건드리지 않는다)
      function updateTotals(){
        var byMarket={}, total=0;
        (st.bets||[]).forEach(function(b){
          if (!byMarket[b.market]) byMarket[b.market] = {};
          byMarket[b.market][b.user_id] = (byMarket[b.market][b.user_id]||0) + b.amount;
          total += b.amount;
        });
        ALL_KEYS.forEach(function(k){
          var per = byMarket[k] || {};
          var t = 0;
          Object.keys(per).forEach(function(u){ t += per[u]; });
          var el=document.getElementById('tot-'+k);
          if (el) el.textContent = compact(t);
          syncPile(k, per, st.round.id);
        });
        potEl.textContent = fmt(total);
        var staked = (st.myBets||[]).reduce(function(a,b){return a+b.amount;},0);
        clearBtn.disabled = st.round.phase!=='betting' || staked<=0;
      }

      function phaseText(r){
        if (r.phase === 'betting') return '베팅 마감까지 ' + r.secondsLeft + '초';
        if (r.phase === 'deal') return '카드 공개 · ' + r.secondsLeft + '초';
        if (r.phase === 'third') {
          // 세 번째 카드가 아예 안 오는 판이 절반쯤 된다(내추럴이거나 양쪽 다 스탠드).
          // 그때도 "세 번째 카드"라고 띄우면 오지 않는 카드를 기다리게 된다.
          var drew = r.player.length > 2 || r.banker.length > 2;
          return (drew ? '세 번째 카드' : '추가 카드 없음') + ' · ' + r.secondsLeft + '초';
        }
        var w = r.result && r.result.winner;
        var name = w==='player' ? '플레이어' : w==='banker' ? '뱅커' : '타이';
        return name + ' 승 · 다음 라운드까지 ' + r.secondsLeft + '초';
      }

      function render(){
        var r = st.round;
        setBalance(st.balance);
        renderCoins();
        renderHistory(st.history);
        statusEl.textContent = phaseText(r);
        statusEl.className = 'bacc-status' + (r.phase === 'betting' ? ' live' : '');

        if (r.id !== lastRoundId) {
          lastRoundId = r.id;
          clearDeal();                 // 지난 라운드의 딜링 타이머를 정리한다
          clearReveal();
          shown = { p: 0, b: 0 }; scheduled = { p: 0, b: 0 };
          slotCache = {};
          pCardsEl.innerHTML = ''; bCardsEl.innerHTML = '';
          pSeatEl.classList.remove('win','lose'); bSeatEl.classList.remove('win','lose');
        }

        var betting = r.phase === 'betting';
        if (firstState || r.phase === 'done') {
          // 페이지에 막 들어왔거나 이미 끝난 판이면 한 장씩 까는 게 의미가 없다.
          // (이미 정해진 결과를 뒤늦게 연출하면 앞뒤가 안 맞는다)
          clearReveal();
          shown = { p: r.player.length, b: r.banker.length };
          scheduled = { p: shown.p, b: shown.b };
        } else if (!betting) {
          scheduleReveal(r);
        }
        paintHands(r);

        // 베팅 중에는 뒷면 네 장을 딜러 자리에서 한 장씩 내려놓는다.
        // 페이지에 막 들어온 순간에는 돌리지 않는다 — 이미 진행 중인 베팅 창
        // 한가운데일 수 있어, 그때 딜링을 시작하면 앞뒤가 안 맞는다.
        if (betting && !firstState) dealSequence(r.id);

        var res = r.result;
        pSeatEl.classList.toggle('win', !!res && res.winner === 'player');
        bSeatEl.classList.toggle('win', !!res && res.winner === 'banker');
        pSeatEl.classList.toggle('lose', !!res && res.winner === 'banker');
        bSeatEl.classList.toggle('lose', !!res && res.winner === 'player');

        renderMarkets();
        renderRoster();   // 칩이 아바타에서 출발하므로 더미보다 먼저 그려져 있어야 한다
        updateTotals();
        firstState = false;

        if (res && notedRoundId !== r.id) {
          notedRoundId = r.id;
          flyChipsToPot(payingMarkets(res));
          var mine = (st.myBets||[]);
          if (mine.length) {
            var gained = mine.reduce(function(a,b){ return a + (b.payout||0); }, 0);
            var net = mine.reduce(function(a,b){ return a + ((b.payout||0) - b.amount); }, 0);
            if (gained > 0) {
              if (window.casinoSfx) window.casinoSfx.win();
              if (net > 0) {
                if (card) replay(card, 'gold-flash');
                if (pbal) replay(pbal, 'bump');
              }
            } else if (window.casinoSfx) {
              window.casinoSfx.lose();
            }
          }
        }
      }

      /* ── 입력 ───────────────────────────────────────────────────── */
      async function post(url, body){
        var r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'},
          body: body?JSON.stringify(body):undefined });
        var d = await r.json();
        return { ok:r.ok, d:d };
      }
      async function placeChip(market){
        var bet = coin;
        var res = await post('/api/games/baccarat/bet', { market:market, amount:bet });
        if (!res.ok) return;   // 실패하면 칩이 올라가지 않는 것으로 드러난다 (문구 미표시)
        setBalance(res.d.balance);
        dropMyChip(market, bet);
        if (window.casinoSfx && window.casinoSfx.chip) window.casinoSfx.chip();
        poll();
      }
      clearBtn.addEventListener('click', async function(){
        var res = await post('/api/games/baccarat/clear');
        if (!res.ok) { poll(); return; }
        setBalance(res.d.balance);
        poll();
      });

      /* ── 폴링 ───────────────────────────────────────────────────── */
      var pollFails = 0;
      async function poll(){
        var d = await window.casinoPoll('/api/games/baccarat/state');
        if (!d) { if (++pollFails >= 2) statusEl.textContent = '서버에 연결하는 중…'; return; }
        pollFails = 0;
        st = d;
        render();
      }
      poll();
      setInterval(poll, 1000);
    })();

      // 우측 패널 랭킹 탭
      ${rankJs('b', 'baccarat')}
    </script>
    ${helpDialog("bcHelp", "바카라 규칙", RULES_HTML)}`;

  return layout('바카라', 'lobby', body);
}
