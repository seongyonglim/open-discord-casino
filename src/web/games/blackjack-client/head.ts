/* 블랙잭 화면 — DOM 핸들 · 상태 · 딜러 공개 · 서식 유틸.

   브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라 문자열이고,
   blackjack.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   순서를 바꾸면 안 된다. 나눈 목적은 읽기이고, 산출물은 한 글자도 달라지지 않아야 한다
   (scripts/golden.ts 가 바이트로 확인한다). */
export function bjHead(p0: string | number, p1: string | number): string {
  return `    (function(){
      var AV = ${p0};
      var SEATS = ${p1};
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

      var BAR_COUNT = 3;   // 아직 남겨 둔다 — 다른 곳에서 참조한다
      function buttonKind(v){ return 'kind-coin'; }

`;
}
