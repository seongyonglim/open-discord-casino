/* 홀덤 화면 — 커뮤니티 카드 공개 순서.

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
export const BOARD = `    var BOARD_FIRST_MS = 560;     // 이번에 깔 첫 장까지
    var BOARD_STEP_MS = 330;      // 같은 스트리트 안(플랍 세 장) 사이
    /* 한 번에 여러 스트리트를 여는 경우(올인·전원 콜로 쇼다운이 확정된 판)의 스트리트 사이.
       여기가 이 판의 긴장이 만들어지는 유일한 구간이다 — 결과는 이미 정해져 있고
       사람이 할 수 있는 건 기다리는 것뿐이라, 빠르게 넘기면 판이 그냥 스킵된 것처럼 느껴진다.
       500ms였을 때 "플랍 턴 리버가 너무 빨리 지나간다"는 말이 나왔고, 1,500ms로 올린
       뒤에도 같은 말이 나왔다.

       그리고 세 구간을 같은 값으로 두면 안 된다. 남은 카드가 줄어들수록 한 장의 무게가
       커지기 때문이다 — 플랍은 세 장이 한꺼번에 나와 아직 판이 열리는 중이고,
       턴은 "이 한 장으로 뒤집힐 수 있다"가 처음 성립하는 지점이며, 리버는 마지막이다.
       실제 중계도 리버 앞에서 가장 오래 뜸을 들인다. 그래서 뒤로 갈수록 길게 잡는다.
         핸드 공개 → 플랍  2.5초 (SHOWDOWN_FLOP_MS)
         플랍 → 턴         2.8초
         턴 → 리버         3.0초  그리고 리버는 뒷면으로 놓였다가 2.5초에 걸쳐 벗겨진다
       키는 "들어가는 스트리트"다 — streetOfCard가 0(플랍)·1(턴)·2(리버)를 준다.
       한 스트리트씩 정상 진행할 때는 이 값을 쓰지 않는다 — 그때는 이미 ACTION_HOLD_MS로
       한 박자 쉬고 있고, 거기에 또 얹으면 진행이 늘어진다. */
    var BOARD_RUNOUT_MS = { 1: 2800, 2: 3000 };
    /* 쇼다운에서 마지막 핸드가 공개되고 플랍이 열리기까지. 그 사이가 "이제 카드만
       남았다"를 알아차리는 시간이다 — 곧바로 플랍을 깔면 핸드를 읽을 틈이 없다. */
    var SHOWDOWN_FLOP_MS = 2500;
    var SQUEEZE_MS = 2500;      // 리버 덮개가 벗겨지는 시간 (CSS htSqueeze와 같아야 한다)
    /* 핸드를 한 사람씩 여는 간격. 1초였는데 "체감상 느리다"는 말이 나왔다 —
       읽어야 할 것은 두 장뿐이고, 그 사이 화면에는 다른 변화가 없어서 기다림이 그대로
       비어 있는 시간이 된다. 0.5초면 순서는 그대로 보이면서 늘어지지 않는다. */
    var HOLE_STEP_MS = 500;
    // 몇 번째 카드가 어느 스트리트인지 (0~2 플랍 · 3 턴 · 4 리버)
    function streetOfCard(i){ return i <= 2 ? 0 : i - 2; }
    /* 스트리트가 넘어갈 때 카드를 깔기 전에 두는 정지.
       서버는 마지막 액션과 새 스트리트를 같은 응답에 담아 보낸다 — 그래서 이게 없으면
       "콜 300"이 뜨는 것과 플랍이 깔리는 것이 거의 동시에 일어나 마지막 액션을 볼 틈이 없다.
       실제 딜러도 액션이 끝나면 칩을 팟으로 모으고 나서 카드를 깐다. 칩이 팟으로
       날아가는 연출(약 700ms)과 겹쳐, 칩이 도착할 즈음 첫 장이 나오게 맞췄다.

       650ms로 뒀더니 "체크가 뜨는 것과 카드가 열리는 것이 거의 동시"라는 말이 나왔다.
       칩 연출이 끝나기를 기다리는 게 아니라, 사람이 마지막 액션을 읽을 시간이 기준이어야 한다.
       1,100ms면 첫 장까지 1.44초(+BOARD_FIRST_MS)라서 라벨을 읽고 나서 카드가 열린다. */
    var ACTION_HOLD_MS = 1100;
    var shownBoard = 0, boardTimers = [], boardHandNo = null;
    /* 보드를 다 깔았나. 올인으로 판이 즉시 끝나는 경우가 이 값의 존재 이유다 —
       서버는 액션이 끝나면 보드를 끝까지 깔고 정산까지 해버리므로, 클라이언트가
       ended만 보고 전부 그리면 플랍도 못 보고 결과가 뜬다. 결과를 아는 것과
       보여주는 속도는 별개다. 이 값이 false인 동안 결과 표시·칩 회수를 미룬다. */
    var boardRevealed = true;
    /* 결과를 보여줘도 되는 시점.
       쇼다운 연출은 [핸드 순차 공개] → [남은 보드] 두 구간이고, 둘 다 끝나야 한다.
       한쪽만 보면 반대쪽 구간에서 결과가 샌다:
         boardRevealed만 → 리버까지 깔린 판에서 핸드를 여는 동안 승자가 먼저 뜬다
         holesRevealed만 → 올인 판에서 플랍도 안 깔렸는데 이긴 5장이 빛난다 */
    /* 둘 다 끝나고도 1.5초를 더 기다린다.
       마지막 카드가 뒤집히는 그 프레임에 이긴 5장이 빛나고 족보가 뜨면, 카드를 본
       사람과 결과가 동시에 도착해서 "내가 읽은" 것이 아니라 "화면이 알려 준" 것이 된다.
       한 박자 비워 두면 그 사이에 스스로 판을 읽게 된다 — 쇼다운의 재미가 거기 있다.

       readyAt은 판마다 한 번만 잡는다. resultReady()는 한 번 그릴 때 여러 번 불리므로
       매번 다시 잡으면 시각이 계속 뒤로 밀려 영영 열리지 않는다.
       진행 중인 판에는 아예 false다 — 예전에는 프리플랍(보드 0장 = boardRevealed true,
       holeDoneAt 0 = holesRevealed true)에서도 true였고, 그 상태로 readyAt을 잡으면
       판이 끝나기 한참 전에 1.5초가 지나 버려 지연이 통째로 사라진다. */
    var RESULT_HOLD_MS = 1500;
    var readyHand = null, readyAt = 0;
    function resultReady(){
      var tb = st && st.table;
      if (!tb || !tb.ended) return false;
      if (!(boardRevealed && holesRevealed())) return false;
      if (readyHand !== tb.handNo) {
        readyHand = tb.handNo;
        readyAt = Date.now() + RESULT_HOLD_MS;
        // 폴링(1초)에 맡기면 1.5초가 1.5~2.5초로 흔들린다 — 그 시각에 직접 깨운다
        var forHand = tb.handNo;
        setTimeout(function(){
          if (st && st.table && st.table.handNo === forHand && !tableEl.hidden) renderTable();
        }, RESULT_HOLD_MS + 20);
      }
      return Date.now() >= readyAt;
    }

    function clearBoardReveal(){
      boardTimers.forEach(clearTimeout);
      boardTimers = [];
    }
    /* 연출이 끊겨도 덮개가 남지 않게 한다 — 남으면 다음 판 보드의 마지막 장이
       영원히 뒷면으로 덮여 있다. */
    function clearSqueeze(){
      if (squeezeEl) squeezeEl.hidden = true;
    }
    /* 보드도 "바뀐 칸만" 갈아 끼운다.
       innerHTML을 통째로 쓰면 턴 한 장을 열 때 이미 깔려 있던 플랍 3장까지 새로 만들어져
       네 장 모두 cardFlip이 재생된다 — 실측으로 확인했다(기존 요소 3개가 전부 파괴됐다).
       소리도 새로 깔린 장수만큼만 낸다. */
    function paintBoard(cards, n, cls){
      var want = cards.slice(0, n);
      var added = 0;
      while (boardEl.children.length > want.length) boardEl.removeChild(boardEl.lastChild);
      for (var i = 0; i < want.length; i++) {
        var src = '/cards/' + want[i] + '.svg?v=' + CARD_V;
        var cur = boardEl.children[i];
        if (!cur) {
          boardEl.insertAdjacentHTML('beforeend', cardImg(want[i], cls));
          added++;
        } else if (cur.getAttribute('src') !== src) {
          cur.outerHTML = cardImg(want[i], cls);
          added++;
        }
      }
      if (added && window.casinoSfx && window.casinoSfx.card) window.casinoSfx.card();
      return added;
    }
    /* 이번에 깔 카드 앞에 두는 간격.
       절대 위치가 아니라 "이번 묶음 안에서 몇 번째인가"로 정한다 — 턴 한 장만 여는
       정상 진행에서 그 장은 묶음의 첫 장이므로 BOARD_FIRST_MS를 받아야 한다.
       예전에는 절대 위치로 정해서(i>=3이면 STREET) 턴·리버가 정상 진행에서도
       스트리트 간격을 받았다. */
    function boardGap(i, from){
      if (i === from) return BOARD_FIRST_MS;
      var st1 = streetOfCard(i), st0 = streetOfCard(i - 1);
      // 스트리트가 넘어가는 자리에만 긴 정지를 둔다. 어느 스트리트로 넘어가느냐로 길이가 다르다
      return st1 !== st0 ? (BOARD_RUNOUT_MS[st1] || 1600) : BOARD_STEP_MS;
    }
    function syncBoard(tb){
      var cards = tb.board || [];
      /* 처형(PKO) 을 위해 판을 비운 상태면 아무것도 그리지 않는다.
         정산이 끝난 뒤 보드와 홀 카드를 걷어 내고 그 빈 테이블에서 총을 쏘기 때문이다.
         이 문이 없으면 다음 폴링이 곧바로 보드를 다시 깔아 카드가 되살아난다.
         다음 판이 시작되면 handNo 가 달라져 저절로 풀린다. */
      if (koClearHand === tb.handNo) {
        clearBoardReveal();
        clearSqueeze();
        shownBoard = 0;
        if (boardEl.innerHTML !== '') boardEl.innerHTML = '';
        boardRevealed = true;
        return;
      }
      /* 래빗을 펼쳐 둔 판이면 그쪽이 보드를 그린다.

         조건에 "래빗이 실제로 열릴 수 있는 상태인가"까지 넣는다. 판 번호만 비교하면
         위험한 구멍이 하나 생긴다 — rabbitShownHand는 페이지가 살아 있는 동안 유지되는
         값이고 판 번호는 대회마다 1부터 다시 시작한다. 새 대회의 1판이 열렸을 때
         우연히 번호가 같으면 syncRabbit으로 넘어가는데, 진행 중인 판은 서버가 rabbit을
         빈 배열로 주므로 syncRabbit이 아무것도 그리지 않고 빠져나온다 —
         그러면 그 판은 보드가 영원히 비어 있게 된다.
         (진짜로 열려 있을 때만 위임하면 그 경로가 아예 생기지 않는다) */
      if (rabbitShownHand === tb.handNo && tb.ended && (tb.rabbit || []).length > 0) {
        syncRabbit(tb); return;
      }
      if (tb.handNo !== boardHandNo) {
        boardHandNo = tb.handNo;
        clearBoardReveal();
        clearSqueeze();
        shownBoard = 0;
        boardEl.innerHTML = '';
      }
      /* 판에 처음 들어온 순간만 연출을 건너뛴다(이미 진행 중인 판을 구경하는 경우).
         끝난 판이어도 연출은 그대로 돈다 — 올인 판에서 플랍·턴·리버를 한 장씩 봐야 한다. */
      if (firstTablePaint) {
        clearBoardReveal();
        clearSqueeze();
        /* 진행 중인 판에 들어온 순간에는 핸드도 예약 없이 바로 보여준다 —
           예약을 남겨 두면 이미 끝난 판의 카드가 몇 초 뒤에 다시 뒤집힌다. */
        clearHoleReveal();
        holeOpenAt = {}; holeDoneAt = 0;
        shownBoard = cards.length;
        boardRevealed = true;
        paintBoard(cards, shownBoard);
        return;
      }
      if (cards.length <= shownBoard) {
        paintBoard(cards, shownBoard);
        boardRevealed = true;
        return;
      }
      boardRevealed = false;
      if (boardTimers.length) return;          // 이미 깔고 있는 중
      /* 첫 장 앞에만 정지를 둔다. 한 번에 여러 스트리트를 여는 올인 판에서도
         정지는 맨 앞에 한 번이고, 그 뒤 스트리트 사이는 BOARD_STREET_MS로 이어진다. */
      /* 첫 장까지의 정지. 쇼다운이라면 마지막 핸드가 열린 뒤 2.5초다 —
         핸드를 다 보기도 전에 플랍이 깔리면 무엇과 무엇이 붙었는지 읽을 틈이 없다.
         정상 진행(한 스트리트씩)에서는 예전처럼 마지막 액션을 읽을 시간만 둔다. */
      var t = ACTION_HOLD_MS, from = shownBoard;
      if (holeDoneAt) {
        t = Math.max(t, holeDoneAt - Date.now() + SHOWDOWN_FLOP_MS);
      }
      for (var i = from; i < cards.length; i++) {
        t += boardGap(i, from);
        /* 리버(다섯 번째)는 앞면으로 열지 않는다. 뒷면 덮개를 씌운 채로 놓고
           2.5초에 걸쳐 왼쪽부터 벗긴다. 그동안 shownBoard는 4에 머문다 —
           승률 말풍선이 그 값을 보므로, 카드가 다 까지기 전에 결과가 새는 것을 막는다. */
        var squeeze = tb.ended && i === 4 && cards.length === 5;
        (function(upto, at, sq){
          boardTimers.push(setTimeout(function(){
            var now = (st.table && st.table.board) || [];
            paintBoard(now, upto);
            if (sq) {
              /* 앞면은 이미 그려졌고 그 위를 덮개가 가린다. 덮개가 다 걷히는
                 시점에야 shownBoard를 5로 올리고 승률을 최종값으로 바꾼다. */
              squeezeEl.hidden = false;
              squeezeEl.style.animation = 'none';
              void squeezeEl.offsetWidth;
              squeezeEl.style.animation = '';
              if (window.casinoSfx && window.casinoSfx.card) window.casinoSfx.card();
              boardTimers.push(setTimeout(function(){
                squeezeEl.hidden = true;
                shownBoard = upto;
                boardRevealed = true;
                clearBoardReveal();
                if (st && st.table) syncEquity(st.table);
                if (st && st.table && !tableEl.hidden) { renderSeats(); paintClock(); renderControls(); }
              }, SQUEEZE_MS));
              return;
            }
            shownBoard = upto;
            /* 승률은 "지금 깔린 보드"에 맞는 단계를 보여준다. 폴링(1초)에만 맡기면
               플랍이 다 깔린 뒤에도 최대 1초는 이전 단계가 떠 있고, 런아웃이 빠르면
               플랍 단계를 아예 못 보고 지나간다. 카드를 열 때마다 여기서 갱신한다. */
            if (st && st.table) syncEquity(st.table);
            if (upto >= now.length) {
              boardRevealed = true;
              clearBoardReveal();
              /* 폴링(1초)을 기다리지 않고 바로 다시 그린다 — 액션 버튼이 이 값에 걸려
                 있어서, 기다리면 카드가 다 깔린 뒤에도 최대 1초는 누를 수 없다. */
              if (st && st.table && !tableEl.hidden) { renderSeats(); paintClock(); renderControls(); }
            }
          }, at));
        })(i + 1, t, squeeze);
        if (squeeze) t += SQUEEZE_MS;
      }
    }

    /* ── 칩 이동 연출 ────────────────────────────────────────────────
       화면 전체를 덮는 레이어 위에서 복제본을 날린다. 자리 안에서 움직이면
       테이블 밖을 지나는 구간이 잘린다 (포커 플립·바카라와 같은 방식).      */
`;
