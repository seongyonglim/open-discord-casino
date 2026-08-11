/* 홀덤 화면 — 홀 카드 공개 · 래빗 헌트 · 자발적 패 공개.

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
export const REVEAL = `    var holeOpenAt = {}, holeRevealHand = null, holeDoneAt = 0, holeTimers = [];
    function clearHoleReveal(){
      holeTimers.forEach(clearTimeout);
      holeTimers = [];
    }
    function noteHoleReveal(tb){
      if (tb.handNo === holeRevealHand) return;
      var reveal = (tb.ended && tb.result && tb.result.reveal) || [];
      if (!reveal.length) {
        // 아직 쇼다운이 아니다 — 판이 바뀌었으면 지난 판의 예약을 버린다
        if (tb.handNo !== holeRevealHand) {
          holeOpenAt = {}; holeDoneAt = 0; clearHoleReveal();
        }
        return;
      }
      holeRevealHand = tb.handNo;
      holeOpenAt = {};
      /* 스몰블라인드부터 시계방향(자리 번호 오름차순)으로 줄을 세운다.
         sb가 이 판에 없으면(폴드·탈락) 그다음 번호부터 도는 것과 같으므로
         자리 번호를 sb 기준으로 회전시키기만 하면 된다. */
      var sb = blindSeatsOf(tb).sb;
      var seats = reveal.map(function(r){ return r.seat; }).sort(function(a, b){ return a - b; });
      if (sb != null) {
        var at = 0;
        for (var i = 0; i < seats.length; i++) if (seats[i] >= sb) { at = i; break; }
        seats = seats.slice(at).concat(seats.slice(0, at));
      }
      var now = Date.now();
      seats.forEach(function(seat, i){
        holeOpenAt[seat] = now + ACTION_HOLD_MS + i * HOLE_STEP_MS;
      });
      holeDoneAt = now + ACTION_HOLD_MS + Math.max(0, seats.length - 1) * HOLE_STEP_MS;
      // 예약해 둔 시각마다 한 번씩 다시 그린다 — 폴링(1초)에만 맡기면 박자가 흔들린다
      clearHoleReveal();
      seats.forEach(function(seat){
        var wait = holeOpenAt[seat] - now;
        holeTimers.push(setTimeout(function(){
          if (st && st.table && st.table.handNo === holeRevealHand && !tableEl.hidden) {
            /* 좌석을 다시 그리면 시간 바가 상태 없이 새로 생기고 --frac 이 비어 있다.
               CSS 기본값이 var(--frac,1) = 100% 라서, 다음 80ms 틱이 오기 전까지 꽉 찬
               바가 한 번 번쩍인다. 그려낸 자리에서 바로 값을 얹는다. */
            renderSeats(); paintClock();
          }
        }, wait + 20));
      });
      /* 마지막 장이 뒤집힌 직후 한 번 더, 이번엔 화면 전체를 다시 그린다.
         결과 연출(보드 하이라이트·팟 이동·효과음)이 resultReady()에 걸려 있는데,
         그 문이 열리는 순간은 어떤 서버 응답과도 무관한 이쪽 타이머다. 폴링(1초)에만
         맡기면 카드가 다 열리고도 최대 1초는 아무 일도 안 일어난 채로 멈춰 있다. */
      holeTimers.push(setTimeout(function(){
        if (st && st.table && st.table.handNo === holeRevealHand && !tableEl.hidden) renderTable();
      }, holeDoneAt - now + 30));
    }
    /* 아직 열리지 않은 핸드가 남았나.
       "보드를 다 깔았나"(boardRevealed)와는 다른 질문이다. 리버까지 이미 깔린 판이
       쇼다운으로 끝나면 보드는 처음부터 완성돼 있고 boardRevealed가 곧바로 true다 —
       그 사이 핸드는 한 사람씩 열리는 중인데, 그 문 하나만 보던 결과 연출(보드 하이라이트·
       팟 이동·승리 효과음)이 먼저 터졌다. 마지막 사람 카드가 뒤집히기도 전에 어느 5장이
       빛나는지 보이니 순서가 통째로 무의미해진다.
       두 조건을 모두 넘겨야 결과를 보여준다. */
    function holesRevealed(){
      return !holeDoneAt || Date.now() >= holeDoneAt;
    }
    function syncHole(hole, s){
      if (!hole) return;
      /* 처형을 위해 판을 비운 상태면 홀 카드도 걷는다 — 보드만 지우고 카드를 두면
         "정리했다"가 아니라 "보드가 사라졌다"로 보인다. 모두의 카드가 같이 내려가야
         빈 테이블이 되고, 그 위에서 총성이 주인공이 된다. */
      if (koClearHand === (st.table || {}).handNo) {
        hole.classList.remove('up');
        while (hole.firstChild) hole.removeChild(hole.firstChild);
        return;
      }
      var cls = s.userId === MEID ? 'hero' : 'sm';
      /* 아직 이 자리를 열 시각이 안 됐으면 서버가 준 카드를 무시하고 뒷면으로 둔다.
         내 카드는 예외다 — 내 패는 언제나 내가 보고 있던 것이다. */
      var mine = s.userId === MEID;
      var due = !holeOpenAt[s.seat] || Date.now() >= holeOpenAt[s.seat];
      var cards = (mine || due) ? s.cards : null;
      var want = (cards && cards.length) ? cards.slice()
        : (s.inHand ? [null, null] : []);
      /* 공개 여부가 카드의 배치를 바꾼다.
           비공개 — 두 장을 겹치고 기울여 아바타 뒤에 둔다
           공개   — 나란히 펼치고 커져서 아바타 앞으로 나온다
         CSS의 .up 하나가 크기·간격·기울기·z를 함께 바꾼다(전환도 CSS가 맡는다).
         내 카드는 언제나 보이므로 항상 펼친 상태다. */
      var open = !!(cards && cards.length);
      hole.classList.toggle('up', open);
      while (hole.children.length > want.length) hole.removeChild(hole.lastChild);
      for (var i = 0; i < want.length; i++) {
        var src = want[i] ? '/cards/' + want[i] + '.svg?v=' + CARD_V
          : '/cards/back-red.svg?v=' + CARD_V;
        var cur = hole.children[i];
        if (!cur) {
          hole.insertAdjacentHTML('beforeend', cardImg(want[i], cls));
          cur = hole.lastChild;
        } else if (cur.getAttribute('src') !== src) {
          cur.outerHTML = cardImg(want[i], cls);
          cur = hole.children[i];
        }
        /* 버린 패 · 자발적 공개 표시는 클래스만 바꾼다 — 요소를 다시 만들지 않는다.
           본인이 깐 패는 흐리게 하지 않는다. 굳이 보여준 것을 가릴 이유가 없다. */
        if (cur && cur.classList) {
          /* 깐 장에만 표시를 붙인다. 좌석 단위로 붙이면 한 장만 깠어도 두 장 다
             깐 것처럼 보인다. shownCards 가 없던 시절의 응답이면 좌석 값으로 되돌린다. */
          var thisShown = s.shownCards ? !!s.shownCards[i] : !!s.shown;
          cur.classList.toggle('mucked', s.state === 'folded' && !thisShown);
          cur.classList.toggle('shown', thisShown);
        }
      }
      /* 접어서 버린 패는 태그 아래로 미끄러져 사라진다. 스스로 깐 패(shown)는 그대로
         둔다 — 굳이 보여준 것을 치우면 안 된다.
         :has 로 CSS 에서 판단할 수도 있지만, "버린 패인가"는 이미 여기서 알고 있는
         사실이라 클래스로 넘긴다 — 같은 판단이 두 곳에 있으면 언젠가 갈라진다. */
      hole.classList.toggle('folded', s.state === 'folded' && !s.shown && want.length > 0);
    }

    /* ── 래빗 헌트 ───────────────────────────────────────────────────
       폴드로 일찍 끝난 판에서 "그대로 갔으면 뭐가 깔렸을까"를 확인한다.
       서버는 핸드가 끝난 뒤에만 이 카드를 내려보낸다(rabbitBoard가 직접 막는다).
       버튼을 누른 판만 보여주고, 새 판이 시작되면 저절로 닫힌다. */
    /* 래빗을 펼쳐 둔 판 번호. 페이지가 살아 있는 동안 유지되므로 대회가 바뀌면 반드시
       지워야 한다 — 판 번호는 대회마다 1부터 다시 시작해서, 안 지우면 새 대회의 같은
       번호 판에서 지난 대회의 열림 상태를 물려받는다. */
    var rabbitShownHand = null, rabbitTid = null;
    function noteRabbitScope(){
      var tid = st && st.tournament ? st.tournament.id : null;
      if (tid !== rabbitTid) { rabbitTid = tid; rabbitShownHand = null; }
    }
    function syncRabbit(tb){
      var rest = tb.rabbit || [];
      var can = tb.ended && rest.length > 0;
      rabbitBtn.hidden = !can || rabbitShownHand === tb.handNo;
      var open = can && rabbitShownHand === tb.handNo;
      rnoteEl.hidden = !open;
      if (open) rnoteEl.textContent = '🐇 파란 점선 ' + rest.length + '장은 실제로 깔리지 않은 카드입니다';
      if (!open) return;
      /* 이미 눌렀다 — 실제 보드 + 래빗 카드를 한 줄로 놓고 슬롯별로 맞춘다.

         예전에는 실제 카드를 paintBoard(real, real.length)로 먼저 맞추고 래빗을 뒤에
         덧붙였는데, paintBoard는 "want보다 많은 자식을 지우는" 함수라서 뒤에 붙여 둔
         래빗 카드를 매 폴링마다 통째로 걷어냈다. 그러면 아래 반복문이 다시 만들어 붙이고,
         요소가 새로 생기니 cardFlip이 다시 재생된다 — 1초마다 카드가 뒤집혔다.
         (덤으로 paintBoard가 카드 추가를 감지해 뒤집는 소리까지 매초 냈다.)
         프리플랍 폴드면 실제 보드가 0장이라 다섯 장 전부가 매초 다시 뒤집혔다.

         그래서 paintBoard를 쓰지 않고 여기서 직접 맞춘다. 같은 카드가 이미 그 자리에
         있으면 요소를 그대로 두고 클래스만 손본다 — 요소를 다시 만들지 않는 것이 핵심이다. */
      var real = tb.board || [];
      var want = real.concat(rest);
      while (boardEl.children.length > want.length) boardEl.removeChild(boardEl.lastChild);
      for (var i = 0; i < want.length; i++) {
        var isRab = i >= real.length;
        var src = '/cards/' + want[i] + '.svg?v=' + CARD_V;
        var cur = boardEl.children[i];
        if (!cur) {
          boardEl.insertAdjacentHTML('beforeend', cardImg(want[i], isRab ? 'rabbit' : ''));
        } else if (cur.getAttribute('src') !== src) {
          cur.outerHTML = cardImg(want[i], isRab ? 'rabbit' : '');
        } else if (cur.classList) {
          cur.classList.toggle('rabbit', isRab);
        }
      }
    }
    rabbitBtn.addEventListener('click', function(){
      if (!st || !st.table) return;
      rabbitShownHand = st.table.handNo;
      rabbitBtn.hidden = true;
      if (window.casinoSfx && window.casinoSfx.card) window.casinoSfx.card();
      syncRabbit(st.table);
    });

    /* ── 내 패 공개 ──────────────────────────────────────────────────
       래빗과 달리 이건 서버에 남는다 — 나만 보는 게 아니라 남에게 보여주는 것이
       목적이니까. 폴드했더라도 공개할 수 있다(블러프를 보여주는 실제 관례).
       판이 끝난 뒤에만 되고, 서버가 SQL 조건으로 다시 확인한다. */
    var showSent = null;                 // 눌러놓고 폴링을 기다리는 판 번호
    function syncShow(tb){
      /* 이미 깐 장의 버튼은 감춘다 — 눌러도 아무 일이 없는 버튼을 남겨 두면
         "안 먹혔나" 싶어 다시 누르게 된다. mask 는 1비트가 왼쪽, 2비트가 오른쪽이다. */
      var mask = tb.shownMask || 0;
      var wait = !tb.canShow || showSent === tb.handNo;
      showLBtn.hidden = wait || (mask & 1) === 1;
      showRBtn.hidden = wait || (mask & 2) === 2;
      // 두 장 버튼은 아직 아무것도 안 깠을 때만 — 한 장을 깐 뒤에는 남은 한 장 버튼이 그 일을 한다
      showBtn.hidden = wait || mask !== 0;
    }
    function sendShow(which){
      if (!st || !st.table || !st.table.ended) return;
      /* 한 장만 깔 때는 다음 폴링에서 나머지 버튼이 다시 나와야 하므로 판을 잠그지 않는다.
         두 장을 다 까는 경우에만 판 번호로 잠근다 — 더 누를 것이 없다. */
      if (which === 3) { showSent = st.table.handNo; }
      showLBtn.hidden = showRBtn.hidden = showBtn.hidden = true;
      fetch('/api/games/holdem/show', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ which: which }),
      })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (d && d.error) { showSent = null; return; }
          if (window.casinoSfx && window.casinoSfx.card) window.casinoSfx.card();
          poll();                        // 내가 깐 게 바로 보이게 한 번 당겨온다
        })
        .catch(function(){ showSent = null; });
    }
    showLBtn.addEventListener('click', function(){ sendShow(1); });
    showRBtn.addEventListener('click', function(){ sendShow(2); });
    showBtn.addEventListener('click', function(){ sendShow(3); });

    /* 행동 이름. 금액이 의미 있는 것만 금액을 붙인다 —
       "체크 0" 같은 표기는 정보가 아니라 잡음이다. */
`;
