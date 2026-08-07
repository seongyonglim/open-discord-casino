/* 바카라 화면 — 배당·확률 · DOM 핸들 · 상태 · 서식 유틸.

   브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라 문자열이고,
   baccarat.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   순서를 바꾸면 안 된다. 나눈 목적은 읽기이고, 산출물은 한 글자도 달라지지 않아야 한다
   (scripts/golden.ts 가 바이트로 확인한다). */
export function bcHead(p0: string | number, p1: string | number, p2: string | number): string {
  return `    (function(){
      var AV = ${p0};
      var ODDS = ${p1};
      var PROB = ${p2};

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

`;
}
