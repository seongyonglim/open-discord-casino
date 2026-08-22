/* 포커 플립 화면 — DOM 핸들 · 상태 · 서식 유틸 · 칩 종류.

   브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라 문자열이고,
   poker.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   순서를 바꾸면 안 된다. 나눈 목적은 읽기이고, 산출물은 한 글자도 달라지지 않아야 한다
   (scripts/golden.ts 가 바이트로 확인한다). */
export function pkHead(p0: string | number): string {
  return `    (function(){
      var boardEl=document.getElementById('pBoard'), marketsEl=document.getElementById('pMarkets');
      var mCardsEl=document.getElementById('pMasterCards'), sCardsEl=document.getElementById('pSharkCards');
      var mCatEl=document.getElementById('pMasterCat'), sCatEl=document.getElementById('pSharkCat');
      var statusEl=document.getElementById('pStatus');
      var coinsEl=document.getElementById('pCoins');
      var clearBtn=document.getElementById('pClear');
      var rosterEl=document.getElementById('pRoster'), potEl=document.getElementById('pPot');
      var pbal=document.querySelector('.prof .pbal');
      var card=document.querySelector('.card');

      if (window.casinoMark) window.casinoMark('포커 스크립트 시작');
      var st=null, coin=null, lastRoundId=null, notedRoundId=null, revealedRoundId=null;
      // 첫 상태인지 여부 — 페이지 진입 직후에는 딜링 연출과 카드 공개음을 건너뛴다
      var firstState = true;
      var DOTS = 9;                 // 등급별로 보여주는 최근 판 수
      var MAX_CHIPS = 50;           // 넘으면 버리는 게 아니라 바닥부터 큰 칩으로 바꾼다(compressPile)
      var ALL_KEYS = ['master','shark','b0','b1','b2','b3','b4'];

      function fmt(n){ return new Intl.NumberFormat('ko-KR').format(Math.floor(n)) + 'P'; }
      function setBalance(n){ if(pbal && typeof n==='number') pbal.textContent = fmt(n); }
      function replay(el, cls){ el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
      function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

      // 상단 띠의 총액 — 만 단위로 줄이면 10,010이 "1만"으로 보여 정확한 금액을 알 수 없으므로
      // 항상 실제 금액을 그대로 쓴다
      function compact(n){ return new Intl.NumberFormat('ko-KR').format(n); }
      function chipLabel(v){ return v>=10000 ? (v/10000)+'만' : String(v); }   // 1000은 1000 그대로 — K로 줄이지 않는다
      function coinLabel(v){ return v>=10000 ? (v/10000)+'만' : String(v); }
      /* 액면은 «크기» 가 아니라 «색» 이 말한다. 한동안 앞 세 단은 동전, 뒤 세 단은
         골드바였다 — 크기 차이가 곧 액면 차이였다. 읽기는 됐지만 판에 올라간 것이
         금색 동전과 금색 막대 두 가지뿐이라 실제 카지노 판처럼 보이지 않았다.
         이제 전부 같은 크기의 클레이 칩이고 색이 액면이다(바카라와 같은 규칙).
         c-coin 은 그대로 붙인다: 날아가는 칩을 정원으로 되돌리는 보정(cloneAt)과
         scripts/check-chips.ts 의 «정사각인가» 검사가 이 클래스로 갈린다 —
         c-bar 를 남기면 1000·5000·1만 이 그 검사에서 통째로 빠진다. */
      var BAR_COUNT = 3;   // 아직 남겨 둔다 — 다른 곳에서 참조한다
      function chipKind(v){ return 'c-coin'; }
      function buttonKind(v){ return 'kind-coin'; }
      function denomClass(v){ return window.casinoChip ? casinoChip.cls(v) : 'd10k'; }
      function chipArt(v){ return window.casinoChip ? casinoChip.art(v) : String(v); }

      // 카드 렌더링 — 'As' 같은 문자열을 카드 모양으로
      var SUIT_SYM={s:'\\u2660',h:'\\u2665',d:'\\u2666',c:'\\u2663'};
      // 카드 그림은 미리 만들어 둔 SVG (public/cards, scripts/gen-cards.ts로 생성).
      // ?v= 는 도안을 다시 생성했을 때 브라우저 캐시를 무시하고 새로 받게 하는 용도.
      var AV = ${p0};
`;
}
