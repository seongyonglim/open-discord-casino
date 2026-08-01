// 포커 플립: 텍사스 홀덤 규칙으로 Master/Shark의 홀카드 2장씩을 먼저 공개하고,
// 보드 5장을 뒤집기 전에 여러 시장에 베팅한다. 이후 플롭 3장 → 턴 → 리버 순서로 공개된다.
//
// 시장 (동시에 여러 개 베팅 가능, 칩을 쌓는 방식)
//   · master / shark : 누가 이기는지. 무승부면 원금 환불 (무승부 자체에 거는 시장은 없다)
//   · b0 ~ b4        : 최종 등급 묶음 — "두 핸드 중 하나라도" 그 등급을 만들면 적중
//
// 배당은 공개된 홀카드로부터 남은 48장 전수 계산(C(48,5)=1,712,304)으로 정확히 산출한다.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';
import {
  advancePokerRound, stackPokerBet, clearPokerBets, getPokerBets, getMyPokerBets,
  getPokerPlayers, getRecentPokerResults, getWebUser,
  POKER_TURN_SEC, POKER_RIVER_SEC, POKER_SETTLE_SEC, POKER_REVEAL_SEC,
  POKER_KEEP_ROUNDS,
  type PokerRoundRow, type WebUser,
} from '../../db/queries';
import {
  computeFlipProbabilities, oddsFromProbability, oddsForWinMarket, dealFlip,
  evaluate7, scoreCategory, categoryBucket, cardToString, CAT_NAMES, BUCKET_NAMES,
} from '../../services/poker';
import { readJson, sendJson } from '../http';
import { layout, jsonForScript } from '../views';
import { ASSET_V } from '../assets';
import { gameSwitcher } from '../pages';

const HOUSE_EDGE = 0.01;
// 앞의 4단은 동전, 뒤의 2단(5000·1만)은 골드바로 그린다
export const COIN_SIZES = [1, 10, 100, 1000, 5000, 10000];

// 무승부 시장은 두지 않는다. 무승부가 나면 master/shark 베팅은 원금을 그대로 돌려준다
// (배당 계산에서 무승부 확률을 빼는 oddsForWinMarket이 그 환불분을 이미 반영한다).
interface MarketOdds {
  master: number | null;
  shark: number | null;
  buckets: (number | null)[];
  prob: { master: number; shark: number; tie: number; buckets: number[] };
}

// 새 라운드: 홀카드 4장 + 보드 5장을 미리 뽑고, 홀카드 기준으로 모든 시장 배당을 전수 계산한다
function makeRound() {
  const { master, shark, deck } = dealFlip(randomInt);
  const board = deck.slice(4, 9);
  const p = computeFlipProbabilities(master[0], master[1], shark[0], shark[1]);
  const odds: MarketOdds = {
    master: oddsForWinMarket(p.masterWin, p.tie, HOUSE_EDGE),
    shark: oddsForWinMarket(p.sharkWin, p.tie, HOUSE_EDGE),
    buckets: p.buckets.map(b => oddsFromProbability(b, HOUSE_EDGE)),
    prob: { master: p.masterWin, shark: p.sharkWin, tie: p.tie, buckets: p.buckets },
  };
  return { hole: [...master, ...shark], board, odds };
}

// 라운드 정산: 양쪽 7장을 평가해 승자와 등급 묶음을 확정한다
function resolveRound(hole: number[], board: number[]) {
  const [m0, m1, s0, s1] = hole;
  const [b0, b1, b2, b3, b4] = board;
  const ms = evaluate7(m0, m1, b0, b1, b2, b3, b4);
  const ss = evaluate7(s0, s1, b0, b1, b2, b3, b4);
  const mCat = scoreCategory(ms), sCat = scoreCategory(ss);
  const mBucket = categoryBucket(mCat), sBucket = categoryBucket(sCat);
  const winner: 'master' | 'shark' | 'tie' = ms > ss ? 'master' : ss > ms ? 'shark' : 'tie';
  return {
    winner,
    // 등급 시장은 배타적 — 두 핸드 중 더 높은 등급 하나만 적중한다
    buckets: [mBucket > sBucket ? mBucket : sBucket],
    detail: { masterCat: mCat, sharkCat: sCat },
    masterCat: mCat,
    sharkCat: sCat,
  };
}

function advance(): PokerRoundRow {
  return advancePokerRound(makeRound, resolveRound);
}

// 공개 범위: 플롭 3장 → 턴 4장 → 리버 5장. 공개 전 카드는 절대 클라이언트로 내려보내지 않는다.
function visibleBoardCount(phase: string): number {
  switch (phase) {
    case 'betting': return 0;
    case 'flop': return 3;
    case 'turn': return 4;
    default: return 5; // river, done
  }
}

function secondsLeft(round: PokerRoundRow): number {
  const now = Math.floor(Date.now() / 1000);
  if (round.phase === 'betting') return Math.max(0, round.betting_ends_at - now);
  if (round.phase === 'done') return Math.max(0, (round.resolved_at ?? now) + POKER_REVEAL_SEC - now);
  // 공개 진행 중 — 다음 단계까지 남은 초
  const e = now - round.betting_ends_at;
  const next = e < POKER_TURN_SEC ? POKER_TURN_SEC
    : e < POKER_RIVER_SEC ? POKER_RIVER_SEC : POKER_SETTLE_SEC;
  return Math.max(0, next - e);
}

function statePayload(round: PokerRoundRow, userId: string) {
  const hole = JSON.parse(round.hole_json) as number[];
  const board = JSON.parse(round.board_json) as number[];
  const odds = JSON.parse(round.odds_json) as MarketOdds;
  const vis = visibleBoardCount(round.phase);
  const result = round.result_json ? JSON.parse(round.result_json) : null;

  return {
    ok: true,
    round: {
      id: round.id,
      phase: round.phase,
      secondsLeft: secondsLeft(round),
      hole: hole.map(cardToString),
      board: board.slice(0, vis).map(cardToString), // 공개된 만큼만
      odds: { master: odds.master, shark: odds.shark, buckets: odds.buckets },
      prob: odds.prob,
      result: result
        ? {
            winner: result.winner,
            buckets: result.buckets,
            masterCat: CAT_NAMES[result.masterCat ?? result.detail?.masterCat],
            sharkCat: CAT_NAMES[result.sharkCat ?? result.detail?.sharkCat],
          }
        : null,
    },
    me: userId,
    bets: getPokerBets(round.id),
    myBets: getMyPokerBets(round.id, userId),
    players: getPokerPlayers(round.id),
    // 등급별 "N판 미출현" 표기를 위해 보관 라운드 전체를 내려준다 (최신이 앞)
    history: getRecentPokerResults(POKER_KEEP_ROUNDS),
    balance: getWebUser(userId)?.balance ?? 0,
    coins: COIN_SIZES,
    bucketNames: BUCKET_NAMES,
  };
}

export async function handleState(_req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  return sendJson(res, 200, statePayload(advance(), userId));
}

const VALID_MARKETS = new Set(['master', 'shark', 'b0', 'b1', 'b2', 'b3', 'b4']);

export async function handleBet(req: IncomingMessage, res: ServerResponse, userId: string, username: string): Promise<void> {
  // 본문 파싱(await)을 먼저 — 검증과 쓰기 사이에 await가 끼면 그 틈에 라운드가 넘어갈 수 있다
  const data = await readJson(req);
  const market = String(data?.market ?? '');
  const amount = Math.floor(Number(data?.amount));
  if (!VALID_MARKETS.has(market)) return sendJson(res, 400, { error: '알 수 없는 베팅 시장입니다' });
  if (!Number.isFinite(amount) || amount < 1) return sendJson(res, 400, { error: '베팅 금액은 1P 이상이어야 합니다' });
  if (!COIN_SIZES.includes(amount)) return sendJson(res, 400, { error: '코인 단위가 올바르지 않습니다' });

  const round = advance();
  if (round.phase !== 'betting') return sendJson(res, 400, { error: '베팅이 마감되었습니다. 다음 라운드를 기다려주세요.' });

  // 배당은 서버가 보관한 값을 쓴다 (클라이언트가 보낸 배당은 신뢰하지 않음)
  const odds = JSON.parse(round.odds_json) as MarketOdds;
  const marketOdds = market === 'master' ? odds.master
    : market === 'shark' ? odds.shark
    : odds.buckets[Number(market.slice(1))];
  if (marketOdds == null) return sendJson(res, 400, { error: '이 시장은 이번 라운드에 베팅할 수 없습니다' });

  const result = stackPokerBet(userId, username, round.id, market, amount, marketOdds);
  if (!result.ok) {
    return sendJson(res, 400, {
      error: result.error === 'closed' ? '베팅이 마감되었습니다. 다음 라운드를 기다려주세요.' : '잔액이 부족합니다',
    });
  }
  return sendJson(res, 200, { ok: true, balance: result.balance, staked: result.staked });
}

export async function handleClear(_req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const round = advance();
  const result = clearPokerBets(userId, round.id);
  if (!result.ok) {
    return sendJson(res, 400, {
      error: result.error === 'no_bet' ? '올린 칩이 없습니다' : '베팅이 마감되어 회수할 수 없습니다',
    });
  }
  return sendJson(res, 200, { ok: true, balance: result.balance, refunded: result.refunded });
}

export function pokerPage(user: WebUser): string {
  const body = `
    ${gameSwitcher('poker')}
    <div class="game-shell poker-shell">
      <div class="game-main">
        <div class="card">
          <div id="pHistory" class="hist-row"></div>
          <div class="poker-table">
            <div class="poker-seats">
              <div class="seat">
                <div class="seat-name master">MASTER</div>
                <div id="pMasterCards" class="hand"></div>
                <div id="pMasterCat" class="seat-cat"></div>
              </div>
              <div class="board-wrap">
                <div id="pStatus" class="poker-status"></div>
                <div id="pBoard" class="board"></div>
              </div>
              <div class="seat">
                <div class="seat-name shark">SHARK</div>
                <div id="pSharkCards" class="hand"></div>
                <div id="pSharkCat" class="seat-cat"></div>
              </div>
            </div>
          </div>
          <div id="pMarkets" class="market-grid"></div>
        </div>
        <!-- 칩과 Clear만 한 줄에 둔다.
             올린 칩·참가자수·총액은 오른쪽 참가자 패널에 이미 다 나오고,
             안내 문구는 나타났다 사라질 때마다 칩 위치를 밀어서 아예 넣지 않는다.
             (승패·회수 결과는 사운드·잔액 애니메이션·참가자 패널 금액으로 전달된다) -->
        <div class="card game-controls poker-controls">
          <div class="coin-row" id="pCoins"></div>
          <button id="pClear" class="btn" type="button">Clear Screen</button>
        </div>
      </div>
      <div class="card game-side" id="pSide">
        <div class="side-head"><span>참가자</span><span id="pPot" class="num">0P</span></div>
        <div id="pRoster" class="roster"><div class="empty" style="padding:16px 0">아직 참가자가 없습니다</div></div>
      </div>
    </div>
    <script>window.__ME__ = ${jsonForScript(user.username)}; window.__SFX_NEED__ = ['coin','gain','card','shuffle','deal'];</script>
    <script>
    (function(){
      var boardEl=document.getElementById('pBoard'), marketsEl=document.getElementById('pMarkets');
      var mCardsEl=document.getElementById('pMasterCards'), sCardsEl=document.getElementById('pSharkCards');
      var mCatEl=document.getElementById('pMasterCat'), sCatEl=document.getElementById('pSharkCat');
      var statusEl=document.getElementById('pStatus'), historyEl=document.getElementById('pHistory');
      var coinsEl=document.getElementById('pCoins');
      var clearBtn=document.getElementById('pClear');
      var rosterEl=document.getElementById('pRoster'), potEl=document.getElementById('pPot');
      var pbal=document.querySelector('.prof .pbal');
      var card=document.querySelector('.card');

      var st=null, coin=null, lastRoundId=null, notedRoundId=null, revealedRoundId=null;
      var DOTS = 9;                 // 등급별로 보여주는 최근 판 수
      var MAX_CHIPS = 21;           // 상자 하나에 그리는 칩 스프라이트 상한 (넘으면 오래된 것부터 제거)
      var ALL_KEYS = ['master','shark','b0','b1','b2','b3','b4'];

      function fmt(n){ return new Intl.NumberFormat('ko-KR').format(Math.floor(n)) + 'P'; }
      function setBalance(n){ if(pbal && typeof n==='number') pbal.textContent = fmt(n); }
      function replay(el, cls){ el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
      function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

      // 상단 띠의 총액 — 만 단위로 줄이면 10,010이 "1만"으로 보여 정확한 금액을 알 수 없으므로
      // 항상 실제 금액을 그대로 쓴다
      function compact(n){ return new Intl.NumberFormat('ko-KR').format(n); }
      function chipLabel(v){ return v>=10000 ? (v/10000)+'만' : (v>=1000 ? (v/1000)+'K' : String(v)); }
      function coinLabel(v){ return v>=10000 ? (v/10000)+'만' : String(v); }
      // 코인 단위 배열에서 위쪽 2단은 골드바, 나머지는 동전.
      // 칩 스프라이트는 c-coin/c-bar, 버튼은 kind-coin/kind-bar로 클래스를 분리한다
      // (버튼 쪽 .coin 규칙이 칩에 섞이면 min-width 때문에 칩이 늘어난다)
      function chipKind(v){
        var c = st.coins||[], i = c.indexOf(v);
        return (i >= 0 && i < c.length - 2) ? 'c-coin' : 'c-bar';
      }
      function buttonKind(v){ return chipKind(v) === 'c-coin' ? 'kind-coin' : 'kind-bar'; }

      // 카드 렌더링 — 'As' 같은 문자열을 카드 모양으로
      var SUIT_SYM={s:'\\u2660',h:'\\u2665',d:'\\u2666',c:'\\u2663'};
      // 카드 그림은 미리 만들어 둔 SVG (public/cards, scripts/gen-cards.ts로 생성).
      // ?v= 는 도안을 다시 생성했을 때 브라우저 캐시를 무시하고 새로 받게 하는 용도.
      var AV = ${JSON.stringify(ASSET_V)};
      function cardHtml(cstr){
        if (!cstr) return '<img class="pcard back" src="/cards/back.svg?v='+AV+'" alt="">';
        var rank = (cstr[0]==='T'?'10':cstr[0]);
        return '<img class="pcard" src="/cards/'+cstr+'.svg?v='+AV+'" alt="'+rank+SUIT_SYM[cstr[1]]+'">';
      }

      // 카드 슬롯 동기화 — 내용이 바뀐 칸만 교체한다.
      // (매 폴링마다 innerHTML을 통째로 갈아끼우면 tilePop 애니메이션이 초당 한 번씩 재시작돼
      //  카드가 계속 튀고, 플롭→턴→리버 순차 공개 연출도 사라진다)
      var slotCache={};
      function syncCards(el, key, values){
        var cache = slotCache[key];
        if (!cache || cache.length !== values.length) {
          // 처음 채우는 뒷면도 cardHtml(null)로 만들어야 한다.
          // 빈 <div class="pcard back">를 쓰면 .pcard에 배경이 없어서 그림자만 남은 투명 사각형이 되고,
          // 아래 루프는 cache[i]와 v가 둘 다 null이면 continue로 넘어가므로 그 상태가 그대로 굳는다.
          el.innerHTML = values.map(function(){ return cardHtml(null); }).join('');
          cache = slotCache[key] = values.map(function(){ return null; });
        }
        var revealed = 0;
        for (var i=0;i<values.length;i++){
          var v = values[i] || null;
          if (cache[i] === v) continue;
          if (v && cache[i] === null) revealed++;   // 뒷면 → 앞면으로 새로 공개된 장수
          cache[i] = v;
          el.children[i].outerHTML = cardHtml(v);
        }
        return revealed;
      }
      // 플롭처럼 여러 장이 한 번에 열릴 땐 소리를 살짝 어긋나게 겹쳐 카드 넘기는 느낌을 준다
      function playReveal(n){
        if (!n || !window.casinoSfx || !window.casinoSfx.card) return;
        for (var i=0;i<Math.min(n,3);i++) setTimeout(function(){ window.casinoSfx.card(); }, i*110);
      }

      /* ── 새 라운드 딜링 연출 ────────────────────────────────────────
         실제 홀덤처럼 섞고 → 마스터/샤크에 한 장씩 번갈아 두 바퀴 → 보드 5장을 뒷면으로 깐다.
         카드가 실제로 "날아와 놓이는" 것처럼 보이게, 화면 위 딜러 자리에서 각 카드 위치로
         복제본을 날린 뒤 해당 슬롯을 드러낸다. 카드 값 자체는 서버가 준 것만 쓰고
         보드는 뒷면이므로 이 연출이 결과를 미리 노출하지 않는다.                        */
      var dealtRoundId = null, dealing = false, pendingDeal = [];

      // 딜링 순서: 마스터 → 샤크 → 마스터 → 샤크 → 보드 5장
      function dealSlots(){
        return [
          { el: mCardsEl, i: 0 }, { el: sCardsEl, i: 0 },
          { el: mCardsEl, i: 1 }, { el: sCardsEl, i: 1 },
          { el: boardEl, i: 0 }, { el: boardEl, i: 1 }, { el: boardEl, i: 2 },
          { el: boardEl, i: 3 }, { el: boardEl, i: 4 },
        ];
      }

      // 딜링을 중단하면 감춰둔 카드를 반드시 되살려야 한다.
      // syncCards는 값이 바뀐 슬롯만 교체하므로, 안 바뀐 슬롯은 숨긴 채로 영구히 남는다.
      function clearDeal(){
        pendingDeal.forEach(clearTimeout);
        pendingDeal = [];
        dealing = false;
        showAllCards();
      }
      function showAllCards(){
        [mCardsEl, sCardsEl, boardEl].forEach(function(el){
          Array.prototype.forEach.call(el.querySelectorAll('.pcard'), function(c){ c.style.visibility = ''; });
        });
        // 날아가던 복제본이 남아 있으면 같이 치운다
        if (fxLayer) {
          Array.prototype.forEach.call(fxLayer.querySelectorAll('.deal-in'), function(c){
            if (c.parentNode) c.parentNode.removeChild(c);
          });
        }
      }

      function dealSequence(roundId){
        if (dealing || dealtRoundId === roundId) return;
        dealing = true; dealtRoundId = roundId;

        var slots = dealSlots();
        slots.forEach(function(s){
          var c = s.el.children[s.i];
          if (c) c.style.visibility = 'hidden';
        });

        if (window.casinoSfx && window.casinoSfx.shuffle) window.casinoSfx.shuffle();

        var SHUFFLE_MS = 620, STEP = 165;
        slots.forEach(function(s, n){
          pendingDeal.push(setTimeout(function(){
            var card = s.el.children[s.i];
            if (!card) return;
            card.style.visibility = '';
            flyCardIn(card);
            if (window.casinoSfx && window.casinoSfx.deal) window.casinoSfx.deal();
            if (n === slots.length - 1) { dealing = false; showAllCards(); }
          }, SHUFFLE_MS + n * STEP));
        });
        // 연출이 어떤 이유로 끊겨도 반드시 카드가 다시 보이도록 하는 안전장치
        pendingDeal.push(setTimeout(function(){ dealing = false; showAllCards(); },
          SHUFFLE_MS + slots.length * STEP + 800));
      }

      // 화면 상단 가운데(딜러 자리)에서 카드가 날아와 제자리에 놓이는 연출
      function flyCardIn(card){
        var r = card.getBoundingClientRect();
        if (!r.width) return;
        var stage = document.querySelector('.poker-table');
        var s = stage ? stage.getBoundingClientRect() : { left: r.left, top: r.top, width: 0 };
        var c = card.cloneNode(true);
        c.className = card.className.replace(/\\bdeal-in\\b/g, '').trim();
        c.style.cssText = 'position:fixed;margin:0;left:' + r.left + 'px;top:' + r.top + 'px;' +
          'width:' + r.width + 'px;height:' + r.height + 'px;';
        c.style.setProperty('--dfx', Math.round((s.left + s.width / 2) - (r.left + r.width / 2)) + 'px');
        c.style.setProperty('--dfy', Math.round((s.top - 40) - r.top) + 'px');
        c.classList.add('deal-in');
        getFxLayer().appendChild(c);
        card.style.visibility = 'hidden';
        // 이 타이머도 pendingDeal에 넣어야 중단 시 clearDeal이 함께 정리하고 카드를 되살린다
        pendingDeal.push(setTimeout(function(){
          if (c.parentNode) c.parentNode.removeChild(c);
          card.style.visibility = '';
        }, 300));
      }

      function renderCoins(){
        coinsEl.innerHTML = (st.coins||[]).map(function(v){
          return '<button type="button" class="coin '+buttonKind(v)+(v===coin?' active':'')+'" data-coin="'+v+'">'+
            '<span class="face">'+coinLabel(v)+'</span></button>';
        }).join('');
        coinsEl.querySelectorAll('.coin').forEach(function(b){
          b.addEventListener('click', function(){
            coin = Number(b.getAttribute('data-coin'));
            try { localStorage.setItem('poker_coin', String(coin)); } catch(e){}
            renderCoins();
          });
        });
      }

      /* ── 코인 더미 ─────────────────────────────────────────────
         상자별로 "지금까지 올라온 칩 목록"을 들고 있다가, 늘어난 만큼만 새 스프라이트를
         덧붙여 아래에서 슬라이드해 올라오게 한다. 총액에서 매번 새로 그리면
         애니메이션이 초당 다시 시작되고 쌓이는 느낌이 사라진다.                     */
      var piles={};
      function jit(i, m){ var x=Math.sin(i*12.9898)*43758.5453; return Math.floor((x-Math.floor(x))*m); }
      // anim: '' 없음 · 'drop' 제자리에서 등장 · 'pending' 자리만 잡고 숨김(곧 날아올 칩)
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
      // 더미 상태는 "누가 얼마" 단위로 들고 있어야 새로 들어온 칩의 주인을 알 수 있다
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
      // 제자리(rect)에 놓인 복제본을 만들어 레이어에 올린다
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
      function cssEsc(s){ return String(s).replace(/["\\\\]/g, '\\\\$&'); }

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

      // 적중한 상자의 칩을 화면 아래 중앙(코인 버튼 줄)으로 빨아들이는 연출.
      // 원본 더미는 감추고 복제본을 최상위 레이어에 띄워 날린다.
      // 돈이 나온 상자의 칩을 각자 주인 아이콘으로 돌려보낸다.
      // 주인을 못 찾으면(패널에 없는 경우) 코인 버튼 줄로 보낸다.
      function flyChipsToPot(markets){
        // 내 당첨금은 화면 중앙 하단(칩 바)으로 빨려들어오고,
        // 다른 사람 것은 각자 오른쪽 참가자 목록의 아이콘으로 돌아간다.
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
            if (ch.classList.contains('mine')) {
              t = myTarget;
            } else {
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

      // 이번 라운드에 돈이 나온 시장 목록 (무승부면 승자 시장 둘 다 원금 환불)
      function payingMarkets(res){
        var out = res.winner === 'tie' ? ['master','shark'] : [res.winner];
        (res.buckets||[]).forEach(function(i){ out.push('b'+i); });
        return out;
      }

      var MARKET_DEFS = [
        { key:'master', label:'MASTER 승', cls:'m-master', sub:'무승부 시 원금 환불' },
        { key:'shark',  label:'SHARK 승',  cls:'m-shark',  sub:'무승부 시 원금 환불' },
      ];

      // 최근 DOTS판의 등급 달성 여부 — 오른쪽이 최신, 왼쪽으로 갈수록 예전 판
      function dotsHtml(bucketIdx){
        var h=(st.history||[]).slice(0, DOTS), cells=[];
        for (var i=0;i<DOTS;i++) cells.push(h[i] || null);
        cells.reverse();
        return '<span class="m-dots">' + cells.map(function(c){
          if (!c) return '<i class="dot"></i>';
          return '<i class="dot'+(c.buckets.indexOf(bucketIdx)>=0?' hit':'')+'"></i>';
        }).join('') + '</span>';
      }
      // 풀하우스 이상은 자주 안 나와서 점으로 보면 거의 다 꺼진 줄이 된다.
      // 그래서 이쪽은 점 대신 "몇 판째 안 나왔는지"만 보여준다.
      function droughtHtml(bucketIdx){
        var h=(st.history||[]), k=-1;
        for (var i=0;i<h.length;i++){ if (h[i].buckets.indexOf(bucketIdx)>=0){ k=i; break; } }
        if (k === 0) return '<span class="m-drought">직전 판 적중</span>';
        if (k > 0) return '<span class="m-drought">'+k+'판째 미출현</span>';
        return h.length ? '<span class="m-drought">'+h.length+'판+ 미출현</span>' : '<span class="m-drought">기록 없음</span>';
      }
      // b0~b2는 점등 전적, b3~b4(풀하우스·포카드 이상)는 미출현 판수
      function bucketFoot(bucketIdx){
        return bucketIdx <= 2 ? dotsHtml(bucketIdx) : droughtHtml(bucketIdx);
      }

      function marketTile(key, label, odds, cls, betting, opt){
        var disabled = odds == null || !betting;
        var res = st.round.result;
        var winCls = '';
        if (res) {
          var isWinner = (key==='master'||key==='shark');
          // 무승부는 승패가 아니라 환불이므로 두 시장 모두 흐리게 처리하지 않는다
          if (isWinner && res.winner==='tie') winCls = '';
          else {
            var isWin = isWinner ? res.winner===key : res.buckets.indexOf(Number(key.slice(1))) >= 0;
            winCls = isWin ? ' hit' : ' miss';
          }
        }
        var foot = opt.bucketIdx != null
          ? bucketFoot(opt.bucketIdx)
          : '<span class="m-sub">'+esc(opt.sub)+'</span>';
        return '<button type="button" class="market '+cls+(disabled?' disabled':'')+winCls+'" data-market="'+key+'">' +
          '<span class="m-top"><span class="m-total" id="tot-'+key+'">0</span>' +
            '<span class="m-odds">'+(odds==null?'—':odds.toFixed(2)+'x')+'</span></span>' +
          '<span class="m-pile" id="pile-'+key+'"></span>' +
          '<span class="m-body"><span class="m-label">'+esc(label)+'</span>'+foot+'</span>' +
          '</button>';
      }

      // 상자 골격은 라운드/단계/배당/결과가 바뀔 때만 다시 그린다.
      // (매초 새로 만들면 그 순간의 클릭이 씹히고 코인 더미도 날아간다)
      var marketSig=null;
      function renderMarkets(){
        var o=st.round.odds, betting = st.round.phase==='betting';
        var sig = st.round.id+'|'+st.round.phase+'|'+JSON.stringify(o)+'|'+
          JSON.stringify(st.round.result||null)+'|'+(st.history||[]).length;
        if (sig === marketSig) return;
        marketSig = sig;

        var html = '<div class="market-row">';
        MARKET_DEFS.forEach(function(d){
          html += marketTile(d.key, d.label, o[d.key], d.cls, betting, { sub:d.sub });
        });
        html += '</div><div class="market-row bucket-row">';
        (st.bucketNames||[]).forEach(function(name, i){
          html += marketTile('b'+i, name, o.buckets[i], 'm-bucket', betting, { bucketIdx:i });
        });
        html += '</div>';
        marketsEl.innerHTML = html;
        piles = {};   // 골격을 새로 만들었으니 더미 캐시도 초기화

        marketsEl.querySelectorAll('.market').forEach(function(el){
          el.addEventListener('click', function(){
            if (el.classList.contains('disabled')) return;
            placeChip(el.getAttribute('data-market'));
          });
        });
      }

      /* ── 우측 참가자 패널 ────────────────────────────────────────────
         디스코드 아바타 · 닉네임 · 보유 포인트. 목록 구성이 바뀔 때만 다시 그리고,
         보유 포인트는 값이 변한 사람만 제자리에서 갱신하며 증감 표시를 준다.       */
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
        // 내가 올린 칩 총액은 Clear 버튼 활성 여부를 정하는 데만 쓴다(표시는 참가자 패널이 담당)
        var staked = (st.myBets||[]).reduce(function(a,b){return a+b.amount;},0);
        clearBtn.disabled = st.round.phase!=='betting' || staked<=0;
      }

      function renderHistory(){
        historyEl.innerHTML = (st.history||[]).slice(0,12).map(function(h){
          var t = h.winner==='master'?'M':h.winner==='shark'?'S':'무';
          var cls = h.winner==='master'?'low':h.winner==='shark'?'bust':'mid';
          return '<span class="ch-chip '+cls+'">'+t+'</span>';
        }).join('');
      }

      function render(){
        var r=st.round;
        setBalance(st.balance);
        renderHistory();

        var newRound = r.id !== lastRoundId;
        if (newRound) { lastRoundId=r.id; clearDeal(); }

        var opened = syncCards(mCardsEl, 'm', [r.hole[0], r.hole[1]])
          + syncCards(sCardsEl, 's', [r.hole[2], r.hole[3]])
          + syncCards(boardEl, 'b', [r.board[0], r.board[1], r.board[2], r.board[3], r.board[4]]);

        // 새 라운드의 베팅 구간에 들어섰을 때만 딜링 연출을 돌린다.
        // (중간에 들어온 사람은 이미 진행 중이므로 연출 없이 현재 상태를 보여준다)
        if (newRound && r.phase === 'betting') dealSequence(r.id);
        else playReveal(opened);

        var phaseLabel = r.phase==='betting' ? ('베팅 마감까지 '+r.secondsLeft+'초')
          : r.phase==='flop' ? '플롭'
          : r.phase==='turn' ? '턴'
          : r.phase==='river' ? '리버'
          : ('다음 라운드까지 '+r.secondsLeft+'초');
        statusEl.textContent = phaseLabel;

        // 결과는 정산 후에만 공개
        if (r.phase==='done' && revealedRoundId !== r.id) revealedRoundId = r.id;
        var res = (r.phase==='done' && r.result) ? r.result : null;
        mCatEl.textContent = res ? res.masterCat : '';
        sCatEl.textContent = res ? res.sharkCat : '';
        mCatEl.className = 'seat-cat' + (res && res.winner==='master' ? ' win' : '');
        sCatEl.className = 'seat-cat' + (res && res.winner==='shark' ? ' win' : '');

        renderMarkets();
        renderRoster();   // 칩이 아바타에서 출발하므로 더미보다 먼저 그려져 있어야 한다
        updateTotals();

        if (res && notedRoundId !== r.id) {
          notedRoundId = r.id;
          // 돈이 나온 상자의 칩은 참가자 전원이 각자 아이콘으로 회수해 간다
          flyChipsToPot(payingMarkets(res));
          var mine = (st.myBets||[]);
          var net = mine.reduce(function(a,b){ return a + ((b.payout||0) - b.amount); }, 0);
          if (mine.length) {
            // 손익(net)과 별개로 "돌려받은 게 한 푼이라도 있는지"(gained)로 연출을 가른다.
            // 여러 곳에 걸어 전체로는 손해여도 맞은 상자가 있으면 그쪽 칩은 회수해 와야 한다.
            var gained = mine.reduce(function(a,b){ return a + (b.payout||0); }, 0);

            if (gained > 0) {
              if (window.casinoSfx) window.casinoSfx.win();
              if (net > 0) {
                if (card) replay(card, 'gold-flash');
                if (pbal) replay(pbal, 'bump');
              }
            } else {
              // 한 푼도 못 건짐 — 낙첨 사운드
              if (window.casinoSfx) window.casinoSfx.lose();
            }
          }
        }
      }

      async function post(url, body){
        var r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: body?JSON.stringify(body):undefined });
        var d = await r.json();
        return { ok:r.ok, d:d };
      }

      async function placeChip(market){
        var bet = coin;
        var res = await post('/api/games/poker/bet', { market:market, amount:bet });
        if (!res.ok) return;   // 실패하면 칩이 올라가지 않는 것으로 드러난다 (문구 미표시)
        setBalance(res.d.balance);
        dropMyChip(market, bet);
        if (window.casinoSfx && window.casinoSfx.chip) window.casinoSfx.chip();
        poll();
      }

      async function clearAll(){
        var res = await post('/api/games/poker/clear');
        if (!res.ok) { poll(); return; }
        setBalance(res.d.balance);
        poll();
      }
      clearBtn.addEventListener('click', clearAll);

      async function poll(){
        var r = await fetch('/api/games/poker/state');
        if (!r.ok) return;
        st = await r.json();
        if (coin == null) {
          coin = st.coins[1] != null ? st.coins[1] : st.coins[0];
          try { var c=localStorage.getItem('poker_coin'); if (c && st.coins.indexOf(Number(c))>=0) coin=Number(c); } catch(e){}
        }
        if (!coinsEl.children.length) renderCoins();
        render();
      }

      // 폴링 비용 관리 (다른 게임과 동일): 탭 숨김·장시간 무조작 시 중단
      var IDLE_MS = 3*60*1000;
      var timer=null, lastAct=Date.now();
      function startPolling(){
        if (timer) return;
        poll();
        timer = setInterval(function(){
          if (document.hidden) { stopPolling(); return; }
          if (Date.now()-lastAct > IDLE_MS) { stopPolling(); statusEl.textContent='일시정지 (화면을 클릭하면 재개)'; return; }
          poll();
        }, 1000);
      }
      function stopPolling(){ if (timer) { clearInterval(timer); timer=null; } }
      function activity(){ lastAct=Date.now(); if (!timer && !document.hidden) startPolling(); }
      ['pointerdown','keydown','focus'].forEach(function(ev){ window.addEventListener(ev, activity, true); });
      document.addEventListener('visibilitychange', function(){ if (document.hidden) stopPolling(); else activity(); });
      startPolling();
    })();
    </script>`;
  return layout('포커 플립', 'lobby', body, 'poker-wide');
}
