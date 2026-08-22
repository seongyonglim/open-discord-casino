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

      /* name 은 상자에 크게 적히는 이름이다. label/sub 와 따로 두는 이유:
         본선 셋은 영문 대문자가 그 자리의 이름이고(PLAYER·TIE·BANKER), 페어 둘은
         한글이 이름이며 영문 설명은 부제다. 한 칸으로 둘을 겸하게 했더니 페어 상자의
         이름 자리에 "첫 두 장 같은 숫자" 라는 설명이 크게 찍혔다. */
      var MARKET_DEFS = [
        { key:'player', name:'PLAYER', label:'플레이어', sub:'PLAYER', cls:'m-player' },
        { key:'tie',    name:'TIE',    label:'타이',     sub:'TIE',    cls:'m-tie' },
        { key:'banker', name:'BANKER', label:'뱅커',     sub:'BANKER', cls:'m-banker' }
      ];
      var PAIR_DEFS = [
        { key:'ppair', name:'플레이어 페어', label:'플레이어 페어', sub:'첫 두 장 같은 숫자', cls:'m-pair m-ppair' },
        { key:'bpair', name:'뱅커 페어',     label:'뱅커 페어',     sub:'첫 두 장 같은 숫자', cls:'m-pair m-bpair' }
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

      /* ── 칩은 여섯 액면이 «색» 으로 갈린다 ──────────────────────────
         한동안 앞 세 단은 동전, 뒤 세 단은 골드바였다(포커 플립과 같은 규칙).
         크기 차이가 곧 액면 차이라 읽기는 쉬웠지만, 판에 올라간 것이 «금색 동전과
         금색 막대» 두 가지뿐이라 실제 카지노 판처럼 보이지 않았다.
         이제 전부 같은 크기의 클레이 칩이고, 액면은 색이 말한다 — 실제 테이블의 규칙이다.
         c-coin 은 그대로 붙인다: 날아가는 칩을 정원으로 되돌리는 보정(cloneAt)과
         scripts/check-chips.ts 의 «정사각인가» 검사가 이 클래스로 갈린다. */
      function chipKind(v){ return 'c-coin'; }
      function buttonKind(v){ return 'kind-coin'; }
      var BC_DCLASS = { 10:'d10', 100:'d100', 500:'d500', 1000:'d1k', 5000:'d5k', 10000:'d10k' };
      function denomClass(v){ return BC_DCLASS[v] || 'd10k'; }
      /* 칩 «면» 에 새기는 글자. 옆의 chipLabel(더미 밖에서 쓰는 이름표)과 따로 두는
         이유는 새길 자리가 지름 20px 남짓이기 때문이다 — 그 안에 «5000» 네 글자를
         넣으면 링에 닿는다. 천 단위는 K 로 줄인다(요청). */
      var BC_FACE = { 10:'10', 100:'100', 500:'500', 1000:'1K', 5000:'5K', 10000:'10K' };
      function chipFace(v){ return BC_FACE[v] || String(v); }

`;
}
