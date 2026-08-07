/* 홀덤 화면 — 테이블 렌더 · 목소리 · 레벨업 · 족보 강조.

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
export const TABLE = `    function renderTable(){
      var tb = st.table;
      noteRabbitScope();      // 대회가 바뀌면 래빗 열림 상태를 버린다
      // 핸드 순차 공개 예약이 먼저다 — 보드 시작 시각이 그 마지막 장에 걸려 있다
      noteHoleReveal(tb);
      syncBoard(tb);
      /* 팟 금액은 다음 판이 시작될 때까지 그대로 둔다.
         한때는 칩이 승자에게 날아간 순간 0으로 바꿨다. 총 칩을 세는 사람에게는 그게 맞다 —
         승자 스택에 이미 반영됐으니 팟까지 남기면 같은 칩이 두 곳에 보인다.
         그런데 실제로 화면을 보는 사람이 그 순간 궁금해하는 건 총 칩이 아니라
         "방금 얼마짜리 판이었나"다. 0으로 지워버리면 그걸 확인할 기회가 사라진다 —
         칩은 이미 날아갔고 숫자도 없어져서 판의 크기를 되짚을 데가 없다.
         중앙 칩 더미는 정산과 함께 사라지므로 "칩은 갔고 금액만 기록으로 남았다"로 읽힌다.
         서버 pot은 다음 판이 열리면 그 판의 블라인드·앤티로 저절로 바뀐다. */
      potEl.textContent = stackText(tb.pot);
      renderSeats();
      dealSequence(tb);
      renderSide();
      // 칩이 중앙으로 밀려가 더미로 쌓이고, 판이 끝나면 그 더미가 승자에게 넘어간다
      rememberSpots(tb);
      syncPotPile(tb);
      // 팟 회수와 래빗 버튼은 카드를 다 깐 뒤에 — 결과가 카드보다 먼저 오면 안 된다
      if (resultReady()) { flyPotToWinners(tb); syncRabbit(tb); syncShow(tb); }
      else {
        /* 공개 버튼이 셋으로 늘었는데 여기서 하나만 내리고 있었다 — 그래서 왼쪽·오른쪽
           버튼이 다음 판이 도는 중에도 화면에 남아 있었다. 결과가 아직이면 셋 다 내린다. */
        showBtn.hidden = true; showLBtn.hidden = true; showRBtn.hidden = true;
        rabbitBtn.hidden = true; rnoteEl.hidden = true;
      }

      /* 중앙에는 이제 보드와 팟만 둔다.
         한때 이 자리에 "OO 차례 · N초"가 있었고, 그다음에는 "OO +12,500 (다음 판 8초)"가
         있었다. 둘 다 같은 이유로 없앴다 — 그 정보가 이미 다른 데서 더 잘 말해지고 있다.
           누가 이겼나  → 좌석 위 WIN 배지
           얼마를 땄나  → 승자에게 날아가는 칩 + 그 자리에서 오르는 스택
           판이 얼마였나 → 중앙 POT (이제 다음 판까지 남는다)
           다음 판까지  → 어차피 몇 초라 읽고 나면 이미 시작한다
         중앙은 커뮤니티 카드를 보는 자리인데, 매 판 끝마다 글자 줄이 나타났다 사라지면서
         시선을 그리로 당겼다. 이 자리는 오류 메시지에만 쓴다(act()가 직접 채운다). */
      msgEl.textContent = '';

      /* 소리 두 가지.
         · 남이 칩을 올렸을 때 (내 것은 클릭 순간에 이미 울렸다)
         · 팟이 승자에게 밀려갈 때 — 한 판에 딱 한 번. 폴링이 같은 종료 상태를 계속
           보내오므로 핸드 번호로 이미 울렸는지 표시해 둔다. */
      playBetSounds();
      /* 카드를 다 깐 뒤에만 울린다. 이 문을 안 지키면 올인 판에서 플랍이 깔리기도 전에,
         또는 쇼다운에서 마지막 사람 핸드가 열리기도 전에 승리 칩 소리가 나서 결과를
         미리 알려준다. 소리는 눈보다 빠르다 — 화면을 안 보고 있어도 들린다. */
      /* 여기서 내는 것은 "이겼다"(potWin) 하나다. 칩이 밀려가는 소리(chipWin)는
         payLayer로 옮겼다 — 예전에는 둘을 같이 냈는데, 승자가 발표되는 시점과 칩이
         실제로 움직이는 시점 사이가 2.5초라서 소리가 먼저 나고 정작 칩이 갈 때는
         조용했다. 소리는 그 소리가 가리키는 움직임과 같은 순간에 나야 한다. */
      if (tb.ended && resultReady() && paidHandNo !== tb.handNo) {
        paidHandNo = tb.handNo;
        if (window.casinoSfx && window.casinoSfx.potWin) window.casinoSfx.potWin();
      }

      /* 내 조합은 이제 글자로 쓰지 않고 카드로만 보여준다 — 내 등급을 만든 카드에
         테두리를 준다(syncHighlight의 'made'). 펠트 한가운데의 글자 줄은 없앴다:
         그 자리는 앤티와 베팅 칩이 모이는 곳이라 프리플랍에는 "QTo"가 칩 금액 위에
         겹쳐 앉았고, 칩에 붙은 라벨처럼 읽혔다. */
      var mh = boardRevealed ? tb.myHand : null;
      syncHighlight(tb, mh);
      syncOutro(tb);
      noteClock(tb);
      paintClock();
      syncLevelUp(tb);
      playActionVoices(tb);
      renderControls();
    }

    /* ── 액션 음성 ────────────────────────────────────────────────────
       칩 소리와 별개다. 칩 소리는 "돈이 나갔다", 이건 "무슨 행동을 했다"를 알린다.
       그래서 체크처럼 칩이 안 나가는 행동도 소리가 나고, 콜은 둘 다 난다.
       (칩 소리를 이걸로 대체하면 안 된다 — 두 정보가 겹치지 않는다)

       같은 행동에 두 번 울리지 않게 (판·스트리트·자리·행동·금액)으로 열쇠를 만든다.
       금액까지 넣는 이유: 같은 자리가 한 스트리트에서 콜 → 레이즈 → 콜을 할 수 있고,
       그때 행동 이름만으로는 새 행동인지 구분되지 않는다.

       판에 처음 들어온 순간에는 울리지 않는다 — 이미 지나간 행동을 소급해서 떠들면
       무슨 일이 일어난 줄 알고 화면을 다시 보게 된다. */
    var voiceSeen = {}, voiceHand = null;
    /* 이 판에서 올인이 올려놓은 가장 높은 총액.
       올인 음악을 "판을 통째로 거는 순간"에만 깔기 위한 기준이다 —
       남이 올인한 뒤 그걸 콜했는데 마침 내 스택 전부였던 경우는 올인이 아니라 콜이다.
       그래서 총액이 이 값을 넘길 때만 음악을 깐다. 더 큰 금액으로 다시 올인하면
       상한 1인 셋이라 앞 음악이 끊기고 새로 시작한다.

       스트리트 베팅액(bet)이 아니라 판 총액(committed)으로 비교한다. 베팅액으로 보면
       "프리플랍 올인 500 → 플랍에서 300 올인"이 500 > 300이라 레이즈가 아닌 것처럼
       읽힌다(실제로는 총 800으로 올린 레이즈다). */
    var allinTop = 0;
    function playActionVoices(tb){
      if (tb.handNo !== voiceHand) { voiceHand = tb.handNo; voiceSeen = {}; allinTop = 0; }
      var sfx = window.casinoSfx;
      if (!sfx || !sfx.action) return;

      function fire(seat, act, amount, committed){
        if (!act) return;
        /* 폴드는 스트리트를 열쇠에 넣지 않는다 — 배지와 같은 이유다.
           서버가 폴드 표시를 스트리트 전환에도 남겨 두므로, 스트리트가 들어 있으면
           플랍에서 접은 사람의 폴드 소리가 턴·리버마다 다시 울렸다. */
        var key = act === 'fold'
          ? 'fold:' + seat
          : tb.street + ':' + seat + ':' + act + ':' + (amount || 0);
        if (voiceSeen[key]) return;
        voiceSeen[key] = 1;

        /* 올인 판정은 소리를 낼지와 별개로 항상 갱신한다 — 들어온 순간에 이미
           올인이 걸려 있었다면, 그 뒤에 콜하는 사람에게 음악이 깔리면 안 된다. */
        var raisedAllin = false;
        if (act === 'allin') {
          var total = committed || 0;
          if (total > allinTop) { allinTop = total; raisedAllin = true; }
        }

        if (firstTablePaint) return;                     // 들어온 순간의 과거 행동은 조용히 넘긴다
        // 음악은 내가 눌렀든 남이 눌렀든 깐다 — 판의 분위기이고, 목소리와 역할이 다르다
        if (raisedAllin && sfx.allinBgm) sfx.allinBgm();
        // 내가 방금 눌렀다면 클릭 순간에 이미 울렸다
        if (seat === tb.mySeat && (Date.now() - myVoiceAt) < 2500) return;
        sfx.action(act);
      }

      (tb.seats || []).forEach(function(s){ fire(s.seat, s.act, s.actAmount, s.committed); });
      /* 스트리트를 닫은 행동은 좌석 표시가 초기화되어 s.act에 안 남는다.
         칩 소리와 같은 이유로 여기서도 hand에 남은 기록을 따로 본다. */
      var la = tb.lastActor;
      if (la && la.seat != null) fire(la.seat, la.act, la.amount, la.committed);
    }

    /* 메인 팟 / 사이드 팟의 알약 줄(.ht-pots)은 없앴다.
       이제 층마다 칩 더미가 따로 서고 각 더미가 이름표와 금액을 직접 달고 있다 —
       같은 것을 두 곳에 적을 이유가 없다. 층 구성은 syncPotPile이 그린다. */

    /* ── 블라인드 상승 알림 ───────────────────────────────────────────
       예전에는 오른쪽 패널 숫자가 조용히 바뀌기만 했다. 토너먼트에서 블라인드가 오른 걸
       모르면 스택을 BB로 환산하는 감각이 어긋나서 판단이 통째로 틀어진다.
       레벨이 바뀐 것을 처음 본 순간 이전 값과 새 값을 함께 띄운다. */
    var seenLevel = null, levelTimer = null;
    function syncLevelUp(tb){
      var lv = tb.level;
      if (!lv) return;
      if (seenLevel == null) { seenLevel = lv; return; }   // 들어온 순간은 알림 없이 기준만 잡는다
      if (lv.level === seenLevel.level) return;
      var prev = seenLevel;
      seenLevel = lv;
      document.getElementById('htLvFrom').textContent = num(prev.sb) + ' / ' + num(prev.bb);
      document.getElementById('htLvTo').textContent = num(lv.sb) + ' / ' + num(lv.bb);
      document.getElementById('htLvNo').textContent = 'LEVEL ' + lv.level;
      lvEl.hidden = false;
      if (window.casinoSfx && window.casinoSfx.chipWin) window.casinoSfx.chipWin();
      clearTimeout(levelTimer);
      levelTimer = setTimeout(function(){ lvEl.hidden = true; }, 3000);
    }

    /* ── 어느 카드가 지금 내 손을 만들고 있나 ─────────────────────────
       카드 요소의 alt에 카드 코드가 들어 있다(cardImg가 넣는다). 한 판에 같은 카드는
       한 장뿐이므로 코드로 찾으면 어디에 있든(내 손·보드) 정확히 그 한 장이 잡힌다.

       클래스만 토글한다 — 요소를 다시 만들면 cardFlip이 재생되어 카드가 다시 뒤집힌다.
       상태에서 매 폴링 다시 계산하므로, 스트리트가 넘어가면 저절로 맞춰진다. */
    function markCards(codes, cls){
      var want = {};
      (codes || []).forEach(function(c){ if (c) want[c] = 1; });
      tableEl.querySelectorAll('.pcard').forEach(function(el){
        var code = el.getAttribute('alt');
        el.classList.toggle(cls, !!(code && want[code]));
      });
    }

    function syncHighlight(tb, mh){
      /* 판이 끝나면 "이긴 5장"으로 넘어간다. 진행 중에는 "내 등급을 만든 카드"다 —
         목적이 다르다. 진행 중에 5장을 다 밝히면 플랍에서는 전부가 밝아져 아무
         신호가 되지 않고, 쇼다운에서 등급 카드만 밝히면 킥커로 갈린 판을 설명하지 못한다. */
      var reveal = (tb.ended && resultReady() && tb.result && tb.result.reveal) || [];
      var awards = (tb.ended && resultReady() && tb.result && tb.result.awards) || [];
      if (reveal.length && awards.length) {
        /* 팟을 받은 자리 중 공개된 사람 = 이긴 손. 분할 팟이면 여럿일 수 있다.

           사이드 팟이 있으면 "지금 정산 중인 층"의 승자만 밝힌다. 예전에는 층과
           무관하게 상금을 받은 사람을 전부 한꺼번에 밝혔다 — 세 층을 세 사람이
           나눠 가지는 판에서 카드가 동시에 셋 빛나고, 그 뒤에 칩만 하나씩 날아갔다.
           어느 5장이 어느 팟을 가져갔는지가 끊긴다.
           이제 [이 층 승자의 5장 → 이 층 칩] 이 한 쌍으로 움직인다.

           hiSeats는 showWinBadges가 층마다 갱신한다. 아직 정산 전이면(첫 하이라이트)
           서버가 준 첫 층으로 시작한다 — 화면도 그 층부터 재생한다. */
        var wonSeats = hiSeats;
        if (!wonSeats) {
          var pa0 = (tb.result.potAwards || [])[0];
          if (pa0 && pa0.winners) {
            wonSeats = {};
            pa0.winners.forEach(function(w){ wonSeats[w.seat] = 1; });
          }
        }
        if (!wonSeats) {
          wonSeats = {};
          awards.forEach(function(a){ if (a.amount > 0) wonSeats[a.seat] = 1; });
        }
        var five = [], winnerCards = [];
        reveal.forEach(function(r){
          if (!wonSeats[r.seat]) return;
          five = five.concat(r.five || []);
          winnerCards = winnerCards.concat(r.cards || []);
        });
        markCards(five, 'win5');
        markCards([], 'made');
        /* 이긴 손에 쓰이지 않은 카드는 물린다 — 승자의 홀 카드와 보드 중 5장에 안 든 것.
           강조의 반대편이 있어야 "이 5장"이 읽힌다. 진 사람의 카드는 건드리지 않는다
           (그 손은 전부가 진 것이지 "안 쓰인" 게 아니다). */
        var inFive = {};
        five.forEach(function(c){ inFive[c] = 1; });
        var pool = winnerCards.concat((tb.board || []));
        markCards(pool.filter(function(c){ return !inFive[c]; }), 'unused');
        return;
      }
      markCards([], 'win5');
      markCards([], 'unused');
      markCards(mh ? mh.highlight : [], 'made');
    }

    /* ── 무엇으로 이겼나를 승자 좌석에 붙인다 ─────────────────────────
       족보명이 없으면 무엇으로 이겼는지 카드를 직접 읽어야 한다. 실제로 다른 클라이언트도
       이걸 안 보여줘서 "4초 안에 카드를 다 읽어야 한다"는 불만이 흔하다.

       한때는 펠트 한가운데 노란 캡슐 한 줄이었다. 정보는 맞았지만 자리가 틀렸다 —
       "누가"는 좌석에, "무엇으로"는 중앙에 있어서 눈이 두 번 움직였고, 무엇보다
       커뮤니티 카드를 보는 자리에 글자가 떴다. 이제 이긴 사람 위에 직접 붙인다. */
    function syncOutro(tb){
      var reveal = (tb.ended && resultReady() && tb.result && tb.result.reveal) || [];
      var awards = (tb.ended && resultReady() && tb.result && tb.result.awards) || [];
      /* 정산이 시작되면 showWinBadges가 층마다 주인이 된다 — 여기서 덮어쓰면
         층별 족보가 1초 폴링에 지워진다. */
      if (potPaidHand === tb.handNo) return;
      var wonSeats = {};
      awards.forEach(function(a){ if (a.amount > 0) wonSeats[a.seat] = 1; });
      (tb.seats || []).forEach(function(s){
        var hEl = seatsEl.querySelector('.ht-seat[data-seat="' + s.seat + '"] .ht-win-h');
        if (!hEl) return;
        var r = wonSeats[s.seat] ? reveal.filter(function(x){ return x.seat === s.seat; })[0] : null;
        hEl.textContent = r ? r.hand : '';
        hEl.hidden = !r;
      });
    }

    /* ── 베팅 컨트롤 ─────────────────────────────────────────────── */
`;
