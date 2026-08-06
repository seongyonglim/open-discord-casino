/* 홀덤 화면 — 딜링과 앤티 연출.

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
export const DEAL = `    function dealStepMs(cards){
      return Math.max(90, Math.min(220, Math.round(1400 / cards)));
    }
    var DEAL_START_MS = 380;      // 셔플 소리가 끝나고 첫 장이 나가기까지
    var DEAL_FLIGHT_MS = 300;     // 복제본이 나는 시간 (CSS deal-in과 맞춘다)
    /* 앤티를 각자 앞에 놓고 중앙으로 보내는 데 드는 시간.
       카드보다 먼저다 — 실제 테이블도 앤티·블라인드를 걷고 나서 딜링을 시작한다. */
    var ANTE_HOLD_MS = 520;
    var dealtHandNo = null, dealTimers = [];
    function clearDeal(){
      dealTimers.forEach(clearTimeout);
      dealTimers = [];
      // 감춰둔 것을 전부 되돌린다 — 연출이 끊겨도 카드는 보여야 한다
      seatsEl.querySelectorAll('.ht-hole').forEach(function(h){
        h.style.visibility = '';
        for (var i = 0; i < h.children.length; i++) h.children[i].style.visibility = '';
      });
    }
    /* 스몰블라인드 좌석 — services/holdem.ts blindPositions와 같은 규칙.
       헤즈업은 버튼이 SB이고, 그 외에는 버튼 다음(시계방향) 자리가 SB다. */
    function sbSeatOf(seatsInHand, buttonSeat){
      var live = seatsInHand.map(function(s){ return s.seat; }).sort(function(a,b){ return a-b; });
      if (live.length < 2) return live.length ? live[0] : null;
      if (live.length === 2) return live.indexOf(buttonSeat) >= 0 ? buttonSeat : live[0];
      for (var i = 1; i <= 9; i++) {
        var cand = (buttonSeat + i) % 9;
        if (live.indexOf(cand) >= 0) return cand;
      }
      return live[0];
    }
    function dealSequence(tb){
      if (tb.handNo === dealtHandNo) return;
      dealtHandNo = tb.handNo;
      clearDeal();
      if (firstTablePaint || tb.ended) return;      // 들어온 순간이거나 이미 끝난 판이면 연출 없이

      var inHand = (tb.seats || []).filter(function(s){ return s.inHand; });
      if (!inHand.length) return;

      /* 실제 딜링 순서 — 스몰블라인드부터 시계방향으로 한 바퀴, 다시 한 바퀴.
         POS 배열이 6시부터 시계방향이고 화면 위치는 (좌석번호 - 내자리)로 회전시키므로,
         "좌석 번호 증가 = 화면상 시계방향"이 된다. 그래서 좌석 번호 오름차순을
         SB에서 시작하도록 돌리면 그대로 시계방향 순서가 된다. */
      var sb = sbSeatOf(inHand, tb.buttonSeat);
      var byNum = inHand.slice().sort(function(a,b){ return a.seat - b.seat; });
      var start = 0;
      for (var i = 0; i < byNum.length; i++) if (byNum[i].seat === sb) { start = i; break; }
      var order = byNum.slice(start).concat(byNum.slice(0, start));

      // 셔플은 작게 깔아 둔다 — 기본 크기면 이어지는 딜링음 열여덟 장을 전부 덮는다
      if (window.casinoSfx && window.casinoSfx.shuffle) window.casinoSfx.shuffle(0.5);

      /* 앤티가 있으면 카드보다 먼저 걷는다. 서버는 앤티를 committed에만 더하고 bet에는
         넣지 않으므로(그래서 좌석 앞에 칩이 안 보인다) 화면이 그 순간을 직접 만든다.
         레벨 6부터 앤티가 붙는다 — 그때부터 매 판 스택이 줄어드는 이유가 보여야 한다. */
      var anteWait = anteSequence(tb, inHand);

      // 두 바퀴 — 실제 테이블처럼 한 사람에게 두 장을 몰아주지 않는다
      var steps = [];
      for (var pass = 0; pass < 2; pass++) {
        for (var j = 0; j < order.length; j++) steps.push({ seat: order[j].seat, idx: pass });
      }

      /* 카드마다 따로 감춘다. 예전에는 .ht-hole 컨테이너를 감췄다가 그 자리의 첫 장을
         돌릴 때 컨테이너를 다시 보이게 했는데, 그러면 아직 돌지 않은 두 번째 장이
         같이 드러났다 — 두 바퀴로 도는 의미가 사라지고 딜링이 어정쩡해 보인 원인이다. */
      var cards = [];
      steps.forEach(function(x){
        var hole = seatsEl.querySelector('.ht-seat[data-seat="' + x.seat + '"] .ht-hole');
        var card = hole && hole.children[x.idx];
        if (card) { card.style.visibility = 'hidden'; cards.push(card); }
      });
      if (!cards.length) return;

      var step = dealStepMs(cards.length);
      var center = boardEl.getBoundingClientRect();
      if (!center.width) center = potEl.getBoundingClientRect();
      cards.forEach(function(card, n){
        dealTimers.push(setTimeout(function(){
          var r = card.getBoundingClientRect();
          if (!r.width) { card.style.visibility = ''; return; }
          // 딜러 자리(테이블 중앙)에서 그 카드 자리로 날아오는 복제본
          var c = card.cloneNode(true);
          c.className = card.className.replace(/\\bdeal-in\\b/g, '').trim() + ' deal-in';
          c.style.cssText = 'position:fixed;margin:0;left:' + r.left + 'px;top:' + r.top + 'px;' +
            'width:' + r.width + 'px;height:' + r.height + 'px;z-index:60;';
          c.style.setProperty('--dfx',
            Math.round((center.left + center.width/2) - (r.left + r.width/2)) + 'px');
          c.style.setProperty('--dfy',
            Math.round((center.top + center.height/2) - (r.top + r.height/2)) + 'px');
          getFx().appendChild(c);
          // 복제본이 도착하는 순간에 실제 카드를 드러낸다
          dealTimers.push(setTimeout(function(){
            if (c.parentNode) c.parentNode.removeChild(c);
            card.style.visibility = '';
          }, DEAL_FLIGHT_MS));
          if (window.casinoSfx && window.casinoSfx.deal) window.casinoSfx.deal();
        }, anteWait + DEAL_START_MS + n * step));
      });
      // 연출이 끊겨도 카드는 반드시 다시 보이게 하는 안전장치
      dealTimers.push(setTimeout(clearDeal,
        anteWait + DEAL_START_MS + cards.length * step + DEAL_FLIGHT_MS + 600));
    }

    /* ── 앤티 제출 ────────────────────────────────────────────────────
       각자 앞에 앤티를 놓고, 잠깐 뒤 전부 중앙으로 보낸다.
       "모두가 같은 금액을 먼저 낸다"는 것이 앤티의 성격이라 한 사람씩 순차로 걷지 않고
       한꺼번에 놓았다가 한꺼번에 보낸다 — 실제 딜러도 그렇게 걷는다.

       돌려주는 값은 "딜링이 이만큼 기다려야 한다"는 시간이다. */
    function anteSequence(tb, inHand){
      var ante = (tb.level && tb.level.ante) || 0;
      if (ante <= 0 || !inHand.length) return 0;

      var made = [];
      inHand.forEach(function(s){
        // 좌표는 renderSeats가 이미 계산해 둔 것을 쓴다 (좌석이 실제로 어디 있는지의 유일한 출처)
        var p = seatXY[s.seat];
        if (!p) return;
        var el = document.createElement('div');
        el.className = 'ht-ante';
        el.style.left = p.bet[0] + '%';
        el.style.top = p.bet[1] + '%';
        el.innerHTML = '<span class="ht-spot-chips">' + chipStack(ante) + '</span>' +
          '<span class="ht-ante-a">' + stackText(ante) + '</span>';
        anteEl.appendChild(el);
        made.push(el);
      });
      if (window.casinoSfx && window.casinoSfx.chipBet) window.casinoSfx.chipBet();

      // 다 놓인 뒤 한꺼번에 중앙으로. 칩이 도착할 즈음 더미가 그 금액을 받아 그린다
      dealTimers.push(setTimeout(function(){
        var pot = pileEl.getBoundingClientRect();
        if (!pot.width) pot = potEl.getBoundingClientRect();
        made.forEach(function(el, k){
          var chips = el.querySelector('.ht-spot-chips');
          var r = chips && chips.getBoundingClientRect();
          if (r && r.width) {
            flyStack({ rect: { left: r.left, top: r.top, width: r.width, height: r.height },
              html: chips.innerHTML }, pot, k * 35);
          }
          if (el.parentNode) el.parentNode.removeChild(el);
        });
        if (window.casinoSfx && window.casinoSfx.chipBet) window.casinoSfx.chipBet();
      }, ANTE_HOLD_MS));
      // 연출이 끊겨도 남지 않게 (clearDeal이 dealTimers를 걷지만 요소는 따로 지운다)
      dealTimers.push(setTimeout(function(){
        made.forEach(function(el){ if (el.parentNode) el.parentNode.removeChild(el); });
      }, ANTE_HOLD_MS + 900));
      return ANTE_HOLD_MS + 150;
    }

`;
