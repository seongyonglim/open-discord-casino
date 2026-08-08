/* 홀덤 화면 — 상태 변수와 테이블 DOM 핸들.

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
export function stateFragment(cardV: string): string {
  return `    var MEID = window.__MEID__;
    var CARD_V = ${cardV};
    var st = null, unit = 'chip', spectate = false, paidHandNo = null;
    /* 우승 팝업을 닫고 로비로 나온 대회. 서버는 끝난 뒤에도 30초 동안 테이블을 계속
       내려보내는데(마지막 쇼다운을 보여주려는 창이다), 그동안 화면이 테이블에 붙들려
       있으면 팝업을 닫아도 갈 데가 없다. 여기에 대회 id 를 적어 두고 그 대회의 테이블은
       더 그리지 않는다 — 대회가 바뀌면 값이 달라져 저절로 풀린다. */
    var leftTableTid = null;
    /* 새로고침해도 유지된다. 메모리에만 두면 탭을 다시 열거나 상단 탭으로 돌아왔다 갈 때
       이미 끝난 판의 테이블로 되돌아간다 — 결과를 확인하고 나온 사람을 다시 그 방에
       밀어 넣는 셈이다. */
    function leftStored(t){
      /* 끝난 대회에만 해당한다. 진행 중이면 무조건 테이블을 보여준다 — 운영자가 대회를
         되감으면 같은 id 가 다시 살아나는데, 그때도 막으면 들어갈 방법이 없다. */
      if (!t || t.status !== 'FINISHED') return false;
      try {
        if (sessionStorage.getItem(leftKey(t)) === '1') return true;
        /* [확인]을 안 누르고 상단 탭으로 나갔다가 돌아온 경우. 축하 팝업은 대회당 한 번만
           뜨므로(그 사실이 sessionStorage 에 남는다), 이미 떴던 대회에 다시 들어오면
           보여줄 연출이 없다 — 그런데도 테이블을 그리면 끝난 판의 시체를 다시 보게 된다.
           팝업이 지금 떠 있는 중이면 그건 연출을 보고 있는 것이므로 건드리지 않는다. */
        if (winEl && winEl.hidden && sessionStorage.getItem(celebrateKey(t)) === '1') return true;
      } catch (e) { /* 저장을 못 쓰는 환경이면 예전처럼 동작한다 */ }
      return false;
    }
    // 판에 처음 들어온 순간에는 연출 없이 현재 상태를 그대로 보여준다
    var firstTablePaint = true;

    var lobbyEl = document.getElementById('htLobby');
    var lobbyRecEl = document.getElementById('htLobbyRec');
    var tableEl = document.getElementById('htTable');
    var seatsEl = document.getElementById('htSeats');
    var spotsEl = document.getElementById('htSpots');
    var anteEl = document.getElementById('htAnte');
    var boardEl = document.getElementById('htBoard');
    var potEl = document.getElementById('htPot');
    var msgEl = document.getElementById('htMsg');
    var rabbitBtn = document.getElementById('htRabbit');
    var showBtn = document.getElementById('htShow');
    var showLBtn = document.getElementById('htShowL');
    var showRBtn = document.getElementById('htShowR');
    var rnoteEl = document.getElementById('htRNote');
    var sideNote = document.getElementById('htSideNote');
    var lvEl = document.getElementById('htLvUp');
    var pileEl = document.getElementById('htPotPile');
    var squeezeEl = document.getElementById('htSqueeze');
    var winEl = document.getElementById('htWin');

    /* ── 우승 축하 ───────────────────────────────────────────────────
       마지막 판을 다 보여준 뒤에 뜬다(FINISH_LINGER_SEC). 그 전에 띄우면 대회를
       결정지은 판의 쇼다운을 덮어버린다.

       한 대회에 한 번만 뜨고, 닫으면 다시 뜨지 않는다. 다만 표시 기록의 열쇠에
       종료 시각을 함께 넣는다 — 대회 id만 쓰면, 같은 대회를 다시 돌렸을 때(테스트 중
`;
}
