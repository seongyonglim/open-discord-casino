/* 홀덤 화면 — 베팅 컨트롤 · 액션 전송 · 미리 정하는 액션.

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
export const CONTROLS = `    function toChips(v){ return unit === 'chip' ? Math.floor(v) : Math.floor(v * (st.table.level.bb || 1)); }
    function fromChips(c){
      return unit === 'chip' ? Math.floor(c) : Math.floor(c / (st.table.level.bb || 1) * 10) / 10;
    }
    /* 슬라이더 금액을 마지막으로 되돌린 차례. (판 · 스트리트 · 콜 금액)으로 가른다.
       차례가 바뀌면 금액을 최소값으로 되돌린다 — renderControls 를 보라. */
    var betTurnKey = null;
    /* 내 차례 알림을 이미 낸 차례. 열쇠는 서버의 마감 시각(turnStamp)이라 한 차례에
       하나뿐이고, 같은 사람이 한 스트리트에서 두 번 말해도 각각 따로 잡힌다. */
    var myTurnRung = null;
    function setAmount(chips){
      var la = st.table.legal; if (!la) return;
      var lo = la.minRaiseTo == null ? la.maxRaiseTo : la.minRaiseTo;
      var v = Math.max(lo, Math.min(la.maxRaiseTo, Math.floor(chips)));
      rangeEl.value = String(v);
      amountEl.value = String(fromChips(v));
    }
    function currentTarget(){ return Math.floor(Number(rangeEl.value) || 0); }

    function renderControls(){
      /* 차례가 아직 열리지 않았으면 버튼을 켜지 않는다.
         "열렸는가"는 서버가 정한다(actOpenIn) — 커뮤니티 카드가 열리는 중이거나
         앞 사람 액션 직후의 최소 간격이다. 예전에는 클라이언트의 boardRevealed만 봤는데,
         그건 내 화면의 애니메이션일 뿐이어서 봇은 그대로 즉시 눌렀다.
         규칙이 서버에 있으니 여기서는 그 값을 그대로 따른다. */
      var la = st.table.legal;
      if (la && st.table.actOpenIn > 0) la = null;
      /* 자리 비움이면 이 줄은 통째로 [게임 복귀] 하나짜리가 된다.
         행동할 수 없는 상태이므로 la는 어차피 비어 있지만, 판이 끝난 뒤의 래빗·패 공개
         버튼은 자리를 비웠어도 뜰 수 있다 — 그것들과 나란히 서면 "지금 눌러야 할 것"이
         흐려지므로 복귀가 있을 때는 나머지를 다 내린다. 자리를 비운 사람이 할 일은 하나다. */
      var away = st.table.myPresence === 'SIT_OUT';
      backAct.hidden = !away;
      /* 판이 끝난 뒤의 두 버튼도 이 패널 안(ht-acts)에 있다. 그래서 내 차례가 아니라고
         패널 전체를 접으면 그 버튼이 뜨고 싶어도 보이지 않는다 — 실제로 그렇게 됐다.
         버튼이 하나라도 뜰 상황이면 패널은 열어두고, 베팅 금액 줄과 미리 지정 줄만 접는다. */
      /* 판이 끝난 뒤에만 뜨는 버튼들. 공개 버튼이 셋으로 늘었는데 여기서 showBtn 하나만
         보고 있었다 — 그래서 왼쪽·오른쪽 버튼이 다음 판이 도는 중에도 남아 있었다.
         "뜰 수 있는 버튼"의 목록을 한 곳에 두고 셋 다 같이 다룬다. */
      var postBtns = [rabbitBtn, showBtn, showLBtn, showRBtn];
      var post = !away && postBtns.some(function(b){ return !b.hidden; });
      if (away) {
        postBtns.forEach(function(b){ b.hidden = true; });
        rnoteEl.hidden = true;
      }
      /* ── 예약의 수명 ─────────────────────────────────────────────────
         예약은 "내 다음 액션 한 번"짜리다. 그런데 비우는 코드가 runPreAction 안에만
         있어서, 실행되지 않은 예약은 아무도 치우지 않았다 — 폴드하고 나가도, 판이
         넘어가도 체크가 그대로 남아 다음 판 첫 차례에 그대로 실행됐다. 다음 판의
         AA 를 지난 판에 걸어 둔 [체크/폴드]가 버리는 모양이다.

         세 갈래로 비운다.
          · 판이 바뀌면 — 예약을 건 판(preHand)과 지금 판이 다르면 버린다. 스트리트가
            넘어가는 것과는 다르다: 같은 판 안에서는 살아 있어야 "내 다음 액션"에 닿는다
            (플랍에서 걸어 둔 것이 턴의 첫 액션에 쓰이는 것이 정상이다).
          · 행동할 수 없게 되면 — 서버의 legal(내 차례)도 pre(내 차례가 아님)도 없는
            상태는 "이 판에서 내가 더 행동하지 않는다"는 뜻뿐이다: 폴드했거나, 올인이거나,
            판이 끝났거나, 자리에 없다. 그때 예약을 남겨 둘 이유가 하나도 없다.
            내 차례에는 legal 이 있으므로 여기 걸리지 않는다 — 실행 전에 비워지지 않는다.
          · 자리 비움 — 서버가 대신 체크·폴드하는 중이라 예약이 닿을 자리가 없고,
            [게임 복귀]를 누른 사람에게 언제 걸었는지도 모를 예약이 살아 있으면 사고가 된다.

         예약이 없을 때(preHand === null)는 아무것도 하지 않는다 — 빈 상자를 매 폴링
         비우는 것은 공짜가 아니고, 사용자가 방금 누른 체크를 지울 위험만 만든다. */
      if (preHand != null && (preHand !== st.table.handNo || away
        || (!st.table.pre && !st.table.legal))) clearPre();
      /* 사전 액션 상자는 내 차례가 "아닐 때" 액션 버튼 자리에 뜬다. 예전에는 la(내 차례)를
         조건으로 두어 내 차례에만 보였는데, 그러면 미리 정해 둘 이유가 없다.
         근거는 서버가 주는 pre 다 — 내 차례가 되면 서버가 그것을 비우고 진짜 버튼이 뜬다. */
      var pre = st.table.pre;
      preEl.hidden = !pre || away;
      if (pre && !away) updatePreLabels();
      ctrlEl.hidden = !la && !post && !away && !pre;
      ctopEl.hidden = !la || away;
      if (!la || away) {
        /* 행동할 수 없으면 네 버튼을 반드시 내린다. 전에는 패널이 통째로 닫혀서
           그냥 두어도 보이지 않았는데, 이제 판이 끝나도 패널이 열려 있으므로
           내리지 않으면 지난 판의 "폴드·콜 100"이 공개 버튼 옆에 그대로 남는다. */
        ACT_BTNS.forEach(function(b){ b.hidden = true; });
        return;
      }
      var lo = la.minRaiseTo == null ? la.maxRaiseTo : la.minRaiseTo;
      rangeEl.min = String(lo);
      rangeEl.max = String(la.maxRaiseTo);
      /* 차례가 새로 열리면 금액을 최소값으로 되돌린다.
         예전에는 "범위를 벗어났을 때만" 되돌렸다. 그런데 판이 넘어가도 최소·최대는
         비슷하게 유지되므로 대개 범위 안에 들어가고, 그러면 지난 판에 맞춰 둔 금액이
         그대로 남는다 — 플랍에서 팟 사이즈로 올려 두면 다음 판 프리플랍에도 그 숫자가
         꽂혀 있다. 슬라이더는 "이번에 얼마를 낼까"를 정하는 도구라 판이 바뀌면 백지여야
         한다. 남아 있는 숫자는 도움이 아니라 오조작의 씨앗이다.

         차례는 시간 바와 같은 열쇠로 가른다 — 서버의 마감 시각(turnStamp).
         (판 · 스트리트 · 콜 금액)으로는 갈리지 않는 차례가 있다. 콜 100 을 낸 뒤 상대가
         200 으로 올리면 콜 금액이 다시 100 이라(hb 200 - 내 베팅 100) 같은 열쇠가 나온다 —
         노리밋에서 가장 흔한 미니 레이즈 모양이고, 하필 이전 값이 가장 위험한 순간이다.
         마감 시각은 차례마다 새로 쓰이므로 그런 충돌이 없다.

         범위 검사는 남긴다. 같은 차례 안에서도 최대치는 바뀔 수 있다(다른 사람이
         올리면 내 maxRaiseTo 가 줄어든다). 그때 밖으로 나간 값은 끌어와야 한다. */
      var stamp = turnStamp(st.table);
      var betKey = stamp == null
        ? st.table.handNo + ':' + st.table.street + ':' + (la.callAmount || 0)
        : 'd' + stamp;
      if (betKey !== betTurnKey) { betTurnKey = betKey; setAmount(lo); }
      else if (currentTarget() < lo || currentTarget() > la.maxRaiseTo) setAmount(lo);
      /* 체크할 수 있을 때는 폴드를 내린다.
         낼 금액이 없는 상황에서 폴드는 공짜로 받을 수 있는 패를 버리는 것이라 어떤 패에서도
         이득이 될 수 없다 — 이길 확률이 0이어도 체크가 같거나 낫다. 남는 건 오조작 위험뿐이다.
         낼 금액이 생기면(canCheck=false) 그때 다시 나온다.

         서버는 폴드를 계속 허용한다(canFold는 항상 true). 마감 초과 자동 처리가
         "체크 가능하면 체크, 아니면 폴드"로 폴드를 쓰고, 클라이언트가 버튼을 감추는 것과
         규칙이 허용하는 것은 별개다. 여기서 막는 건 손가락이 미끄러지는 경우다. */
      /* ── 내 차례 알림 ───────────────────────────────────────────────
         버튼이 실제로 눌리는 상태가 된 바로 이 지점에서 울린다.
         예전에는 시계 기준점을 잡는 곳(noteClock)에서 울리고 0.8초를 기다렸는데, 그건
         "서버가 차례를 알려 준 시점"이지 "내가 누를 수 있게 된 시점"이 아니다. 둘 사이에는
         차례가 열리기까지의 간격(actOpenIn)과 폴링 지연이 끼어서, 소리가 버튼보다 먼저
         나거나 한참 뒤에 나는 일이 생겼다. 0.8초 지연은 그걸 가리려던 우회였다.

         여기까지 내려왔다는 것은 la 가 있고(내 차례) actOpenIn 이 0 이며(열렸고)
         자리 비움이 아니라는 뜻이다 — 즉 네 버튼이 이 줄 다음에 실제로 켜진다.

         자리 비움이면 울리지 않는다. 위에서 away 일 때 이미 돌아갔으므로 여기 닿지 않는다 —
         자동으로 체크·폴드되는 중인 사람에게 "당신 차례"라고 알리는 것은 알림이 아니라
         소음이다. [게임 복귀]로 돌아오면 다음 차례부터 다시 울린다. */
      var turnKey = turnStamp(st.table);
      if (turnKey != null && myTurnRung !== turnKey && !firstTablePaint) {
        myTurnRung = turnKey;
        if (window.casinoSfx && window.casinoSfx.myTurn) window.casinoSfx.myTurn();
      }

      document.getElementById('htFold').hidden = !la.canFold || la.canCheck;
      document.getElementById('htCheck').hidden = !la.canCheck;
      var call = document.getElementById('htCall');
      call.hidden = !la.canCall;
      call.textContent = '콜 ' + stackText(la.callAmount);
      var raise = document.getElementById('htRaise');
      raise.hidden = la.minRaiseTo == null;
      raise.textContent = (currentTarget() >= la.maxRaiseTo ? '올인 '
        : la.raiseIsBet ? '베팅 ' : '레이즈 ') + stackText(currentTarget());
      unitTag.textContent = unit === 'chip' ? '칩' : 'BB';
      /* 태그를 바꿨으면 숫자도 그 단위로 다시 쓴다. 값 쓰기가 초기화(setAmount) 때만
         일어나서, 칩 3,000 을 BB 로 토글하면 태그만 'BB'로 바뀌고 숫자는 3,000 으로
         남았다 — 3,000BB 로 읽히는 화면이다.
         입력 중일 때는 건드리지 않는다. change 는 포커스를 잃을 때 오므로 타이핑
         도중에 폴링이 끼어들면 쓰던 글자가 지워진다. */
      if (document.activeElement !== amountEl) amountEl.value = String(fromChips(currentTarget()));
    }

    document.getElementById('htQuick').addEventListener('click', function(e){
      var b = e.target.closest ? e.target.closest('.ht-q') : null;
      if (!b || !st || !st.table || !st.table.legal) return;
      var la = st.table.legal, tb = st.table, bb = tb.level.bb;
      var q = b.getAttribute('data-q');
      /* 빠른 금액 버튼은 슬라이더에 값만 채운다 — 여기서 바로 서버로 보내면
         손가락이 미끄러진 순간 전 재산이 나간다. 확인 버튼을 눌러야 나간다. */
      var v = q === 'third' ? la.myBet + Math.floor(tb.pot / 3)
        : q === 'half' ? la.myBet + Math.floor(tb.pot / 2)
        : q === 'pot' ? la.myBet + tb.pot
        : q === 'bb1' ? bb
        : q === 'bb2' ? bb * 2
        : la.maxRaiseTo;
      setAmount(v);
      renderControls();
    });
    rangeEl.addEventListener('input', function(){
      amountEl.value = String(fromChips(currentTarget()));
      renderControls();
    });
    amountEl.addEventListener('change', function(){
      setAmount(toChips(parseFloat(String(amountEl.value).replace(/[^0-9.]/g, '')) || 0));
      renderControls();
    });

    /* 남의 베팅은 폴링으로만 알 수 있다. 자리별 "이번 스트리트 베팅액"을 기억해 두고
       늘어난 자리가 있을 때 칩 소리를 낸다. 여러 명이 한꺼번에 늘어도 한 번만 울린다 —
       같은 소리가 겹치면 지저분해진다. 내 자리는 클릭 순간에 이미 울렸으니 뺀다. */
    var lastBets = {}, betHandNo = null, betStreet = null, myClickAt = 0;
    // 스트리트를 닫은 액션에 소리를 한 번만 내기 위한 기억
    var lastCloseKey = null, endSoundHand = null;
    // 내가 직접 눌러 액션 음성을 낸 시각 (폴링이 같은 소리를 또 내지 않게)
    var myVoiceAt = 0;
    function playBetSounds(){
      var tb = st.table;
      if (!tb) return;
      /* 스트리트가 넘어가면 서버가 이 스트리트 베팅을 0으로 되돌린다. 기억을 판 단위로만
         비우면, 새 스트리트의 첫 베팅이 지난 스트리트 금액보다 작을 때 "늘지 않았다"고
         판정되어 소리가 삼켜진다 (프리플랍 200 콜 → 플랍 100 벳 = 무음).
         한 번의 폴링 안에서 스트리트 전환과 새 베팅이 같이 오면 반드시 그렇게 된다. */
      var streetJustChanged = false;
      if (tb.handNo !== betHandNo || tb.street !== betStreet) {
        // 판이 바뀐 것은 "스트리트가 닫혔다"가 아니다 — 새 판의 첫 폴링에서 울리면 안 된다
        streetJustChanged = tb.handNo === betHandNo;
        lastBets = {}; betHandNo = tb.handNo; betStreet = tb.street;
      }
      // 리버에서 콜로 판이 끝나면 street는 그대로 river이므로 위 조건에 걸리지 않는다
      if (tb.ended && !endSoundHand) { endSoundHand = tb.handNo; streetJustChanged = true; }
      if (!tb.ended && endSoundHand === tb.handNo) endSoundHand = null;
      var any = false;
      (tb.seats || []).forEach(function(s){
        /* 내 자리도 센다. 예전에는 "내 것은 클릭 순간에 울렸다"며 빼놨는데, 자리 비움
           자동 콜이나 자동 콜 체크박스로 나간 칩은 클릭이 없어서 아무 소리도 안 났다.
           단 내가 방금 직접 눌렀다면 그 소리는 이미 울렸으므로 겹쳐 울리지 않는다. */
        var grew = s.bet > (lastBets[s.seat] || 0);
        var mineJustClicked = s.seat === tb.mySeat && (Date.now() - myClickAt) < 2500;
        if (grew && !mineJustClicked) any = true;
        lastBets[s.seat] = s.bet;
      });

      /* 스트리트를 닫은 칩 액션은 위 방법으로 절대 잡히지 않는다.
         그 액션이 라운드를 끝내면 서버가 같은 트랜잭션에서 이 스트리트 베팅을 0으로
         되돌리므로, 폴링이 보는 것은 이미 0이다 — "늘었다"가 성립할 수 없다.
         마지막 액션이 콜일 때 소리가 안 난다는 제보가 정확히 이 경로였다.
         그래서 스트리트가 바뀐(또는 판이 끝난) 폴링에서는 hand에 남은 마지막 액션 기록을
         근거로 울린다. 같은 액션에 두 번 울리지 않게 키로 기억해 둔다. */
      var la = tb.lastActor;
      if (streetJustChanged && la && la.seat != null) {
        var chipAct = la.act === 'call' || la.act === 'bet' || la.act === 'raise' || la.act === 'allin';
        var key = tb.handNo + ':' + la.seat + ':' + la.act + ':' + (la.amount || 0);
        if (chipAct && key !== lastCloseKey) {
          lastCloseKey = key;
          var mineJust = la.seat === tb.mySeat && (Date.now() - myClickAt) < 2500;
          if (!mineJust) any = true;
        }
      }
      if (any && window.casinoSfx && window.casinoSfx.chipBet) window.casinoSfx.chipBet();
    }

    /* maxCall — 사전 액션으로 콜할 때만 채운다. "내가 걸어 둘 때 본 콜 금액"이고,
       서버가 지금 금액과 비교해 더 커졌으면 거절한다. amount 와 따로 두는 이유는
       amount 가 레이즈 금액이라는 다른 뜻을 이미 갖고 있기 때문이다. */
    function act(kind, amount, maxCall){
      /* 액션이 하나 나가면 예약은 무조건 끝난다 — 이 예약으로 나갔든, 사용자가 버튼을
         직접 눌렀든 마찬가지다. 예약은 "다음 한 번"짜리이기 때문이다.

         직접 누른 경우를 여기서 잡지 않으면 이렇게 된다: 예약을 걸어 둔 채 내 차례가
         왔는데 아직 차례가 열리지 않아(actOpenIn) 예약이 보류된다. 기다리다 답답해서
         버튼을 직접 누르면 액션은 나가지만 상자는 켜진 채로 남고, 같은 판에서 차례가
         한 번 더 오면 그 낡은 예약이 그대로 실행된다. 제보의 "체크가 안 풀린다"가
         이 경로다 — 화면에는 계속 켜져 있고, 사용자는 자기가 고른 적 없는 액션을 본다. */
      clearPre();
      // 칩이 실제로 나가는 액션에만 소리를 낸다 (폴드·체크는 칩이 안 나간다).
      // 서버 응답을 기다리지 않고 클릭 순간에 울려야 손맛이 난다.
      if (kind !== 'fold' && kind !== 'check') {
        myClickAt = Date.now();        // 폴링이 같은 칩 소리를 또 울리지 않게 표시해 둔다
        if (window.casinoSfx && window.casinoSfx.chipBet) window.casinoSfx.chipBet();
      }
      /* 액션 음성은 칩과 별개로, 체크·폴드에도 낸다. 서버 응답을 기다리지 않고 클릭 순간에
         울려야 손맛이 난다 — 칩 소리와 같은 이유다.
         내 것을 여기서 울렸다고 폴링 쪽에 표시해 둔다(겹쳐 울리지 않게). */
      myVoiceAt = Date.now();
      if (window.casinoSfx && window.casinoSfx.action) window.casinoSfx.action(kind);
      return post('/api/games/holdem/action',
        { action: kind, amount: amount || 0, maxCall: maxCall == null ? null : maxCall })
        .then(function(r){
          if (!r.ok && r.d && r.d.error) msgEl.textContent = r.d.error;
          return poll();
        });
    }
    document.getElementById('htFold').addEventListener('click', function(){ act('fold'); });
    document.getElementById('htCheck').addEventListener('click', function(){ act('check'); });
    document.getElementById('htCall').addEventListener('click', function(){ act('call'); });
    document.getElementById('htRaise').addEventListener('click', function(){
      var la = st.table.legal; if (!la) return;
      var target = currentTarget();
      act(target >= la.maxRaiseTo ? 'allin' : (la.raiseIsBet ? 'bet' : 'raise'), target);
    });
    function sitIn(){ post('/api/games/holdem/sitin', {}).then(poll); }
    backBtn.addEventListener('click', sitIn);
    backAct.addEventListener('click', sitIn);

    /* ── 사전 액션 ───────────────────────────────────────────────────
       내 차례가 오기 전에 미리 정해두는 것. 상황이 바뀌면(베팅·레이즈가 들어오면)
       스스로 해제된다 — 그래야 "콜 200을 걸어뒀는데 상대가 5000으로 올려서
       그대로 콜되는" 사고가 안 난다. */
    var preCF = document.getElementById('htPreCheckFold');
    var preC = document.getElementById('htPreCheck');
    var preF = document.getElementById('htPreFold');
    var preCall = document.getElementById('htPreCall');
    var preCallAmount = null;
    var PRE_BOXES = [preCF, preC, preF, preCall];
    /* 예약을 건 판의 번호. 예약이 없으면 null 이다.
       이 값이 지금 판과 다르면 예약은 실행되지 않고 버려진다 — 화면 정리가 어떤 이유로
       늦거나 건너뛰어도 지난 판의 선택이 새 판에 나가는 일은 없다. */
    var preHand = null;
    /* 예약을 통째로 비운다. 세 값이 반드시 같이 움직여야 한다 — 하나만 비우면
       "체크는 풀렸는데 걸어 둔 금액은 남은" 상태가 되고, 그 다음 예약이 지난 차례의
       금액으로 검사된다(콜 5,000 을 200 이하로 착각한다). */
    function clearPre(){
      PRE_BOXES.forEach(function(b){ b.checked = false; });
      preCallAmount = null;
      preHand = null;
    }
    PRE_BOXES.forEach(function(box){
      box.addEventListener('change', function(){
        if (box.checked) PRE_BOXES.forEach(function(o){ if (o !== box) o.checked = false; });
        /* 콜을 걸어 둔 순간의 금액을 적어 둔다. 그 뒤에 누가 올리면 이 값과 달라지고,
           그때 자동으로 풀린다 — "콜 200을 걸어뒀는데 5000으로 올라 그대로 콜되는"
           사고를 막는 유일한 장치다. 내 차례가 아닐 때는 legal 이 없으므로 pre 를 본다. */
        var cur = st && st.table ? (st.table.legal || st.table.pre) : null;
        preCallAmount = (box === preCall && box.checked && cur) ? cur.callAmount : null;
        preHand = box.checked && st && st.table ? st.table.handNo : null;
      });
    });
    function runPreAction(){
      var la = st.table.legal;
      if (!la) return;
      /* 다른 판의 예약은 실행하지 않고 버린다.
         renderControls 가 이미 같은 판정을 하지만, 그것은 화면을 그리는 길에 얹혀 있다 —
         테이블이 감춰져 있거나(로비 전환) 정산 연출 잠금으로 폴링이 큐에 쌓이는 동안에는
         그 길이 돌지 않는다. 액션이 실제로 나가는 문은 여기 하나뿐이므로, "지난 판에 걸어
         둔 것이 새 판에 나갔다"를 확실히 막으려면 이 자리에 세워야 한다. */
      if (preHand != null && preHand !== st.table.handNo) { clearPre(); return; }
      /* 차례가 아직 열리지 않았으면 보내지 않는다. 서버가 too_soon으로 거절하는데
         아래 코드는 보내기 전에 체크박스를 먼저 끄므로, 거절당하면 미리 지정한 액션이
         사라진 채로 제한 시간까지 흘러 자동 폴드된다. 다음 폴링에서 다시 본다. */
      if (st.table.actOpenIn > 0) return;
      /* 실행하기로 정한 순간 체크를 먼저 끈다 — 성공이든 거절이든, 예약은 한 번 쓰면
         끝이다. 체크를 남기면 다음 차례에 또 실행되고, 그건 사용자가 정한 것이 아니다.
         예전에는 [체크]만 이 처리가 빠져 있었다(아래 preC): 체크가 나간 뒤에도 상자가
         켜진 채로 남아 다음 스트리트·다음 판까지 따라다녔다. */
      if (preCF.checked) { clearPre(); act(la.canCheck ? 'check' : 'fold'); return; }
      if (preF.checked) { clearPre(); act('fold'); return; }
      if (preC.checked) {
        clearPre();
        if (la.canCheck) act('check');        // 베팅이 들어왔으면 그냥 버린다(자동 체크 해제)
        return;
      }
      if (preCall.checked) {
        var maxCall = preCallAmount;
        clearPre();
        /* 걸어 둘 때 본 금액을 함께 보낸다. 화면의 자동 해제는 폴링 사이에 상황이
           바뀌면 늦을 수 있고, 그 틈에 내 차례가 오면 의도하지 않은 금액을 콜하게 된다.
           서버가 같은 값을 다시 확인하고 다르면 거절한다 — 마지막 문은 서버다.
           금액이 올랐으면 아무것도 보내지 않는다 — 자동 콜 해제. */
        if (la.canCall && (maxCall == null || la.callAmount <= maxCall)) act('call', 0, maxCall);
        return;
      }
    }
    /* 상황에 맞는 둘만 보여준다. 베팅이 없으면 [체크/폴드][체크], 있으면 [폴드][콜 N].
       내 차례가 아닐 때만 뜨므로 근거는 pre 다(내 차례에는 진짜 버튼이 뜬다). */
    function updatePreLabels(){
      var pre = st.table && st.table.pre;
      if (!pre) return;                 // 내 차례이거나 판에 없다 — 상자가 애초에 안 뜬다
      var canCheck = pre ? pre.canCheck : true;
      document.getElementById('htPreCFBox').hidden = !canCheck;
      document.getElementById('htPreCBox').hidden = !canCheck;
      document.getElementById('htPreFBox').hidden = canCheck;
      document.getElementById('htPreCallBox').hidden = canCheck;
      /* 안 보이게 된 칸의 체크는 푼다. 남겨 두면 상황이 바뀐 뒤에도 예전 선택이
         살아 있다가 내 차례에 그대로 실행된다. */
      if (canCheck) { preF.checked = false; preCall.checked = false; preCallAmount = null; }
      else { preCF.checked = false; preC.checked = false; }
      /* 상자가 다 꺼졌으면 예약이라는 것 자체가 없어진 것이다 — 판 번호도 함께 지운다.
         남겨 두면 "예약은 없는데 예약을 건 판은 있는" 상태가 되고, 그 뒤의 판정들이
         있지도 않은 예약을 두고 돈다. */
      if (!PRE_BOXES.some(function(b){ return b.checked; })) { preHand = null; preCallAmount = null; }
      /* 콜 금액이 걸어 둘 때보다 커졌으면 그 자리에서 푼다. runPreAction 도 같은 검사를
         하고 서버가 maxCall 로 한 번 더 막지만, 그 둘은 내 차례가 와야 도는 문이다 —
         그때까지 화면에는 "콜 200" 이 체크된 채로 남아 있고, 앞에서 5,000 이 나온 것을
         본 사람은 그 체크가 아직 유효하다고 읽는다. 조건이 깨진 즉시 상자를 비워서
         직접 다시 고르게 한다. 반대로 금액이 줄어드는 일은 없으므로(콜액은 커지기만 한다)
         한쪽만 본다. */
      if (preCall.checked && preCallAmount != null && (pre.callAmount || 0) > preCallAmount) {
        preCall.checked = false;
        preCallAmount = null;
      }
      document.getElementById('htPreCallLabel').textContent =
        pre && pre.callAmount ? '콜 ' + stackText(pre.callAmount) : '콜';
    }

    /* ── 렌더 / 폴링 ─────────────────────────────────────────────── */
`;
