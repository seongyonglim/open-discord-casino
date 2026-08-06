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
      var post = !away && (!rabbitBtn.hidden || !showBtn.hidden);
      if (away) { rabbitBtn.hidden = true; showBtn.hidden = true; rnoteEl.hidden = true; }
      ctrlEl.hidden = !la && !post && !away;
      ctopEl.hidden = !la || away;
      preEl.hidden = !la || away;
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

    function act(kind, amount){
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
      return post('/api/games/holdem/action', { action: kind, amount: amount || 0 })
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
    var preCall = document.getElementById('htPreCall');
    var preCallAmount = null;
    [preCF, preC, preCall].forEach(function(box){
      box.addEventListener('change', function(){
        if (box.checked) [preCF, preC, preCall].forEach(function(o){ if (o !== box) o.checked = false; });
        preCallAmount = (box === preCall && box.checked && st && st.table && st.table.legal)
          ? st.table.legal.callAmount : null;
      });
    });
    function runPreAction(){
      var la = st.table.legal;
      if (!la) return;
      /* 차례가 아직 열리지 않았으면 보내지 않는다. 서버가 too_soon으로 거절하는데
         아래 코드는 보내기 전에 체크박스를 먼저 끄므로, 거절당하면 미리 지정한 액션이
         사라진 채로 제한 시간까지 흘러 자동 폴드된다. 다음 폴링에서 다시 본다. */
      if (st.table.actOpenIn > 0) return;
      if (preCF.checked) { preCF.checked = false; act(la.canCheck ? 'check' : 'fold'); return; }
      if (preC.checked) {
        if (la.canCheck) { act('check'); return; }
        preC.checked = false;                 // 베팅이 들어왔다 — 자동 체크 해제
        return;
      }
      if (preCall.checked) {
        if (la.canCall && (preCallAmount == null || la.callAmount <= preCallAmount)) {
          preCall.checked = false; act('call'); return;
        }
        preCall.checked = false;              // 레이즈가 들어왔다 — 자동 콜 해제
      }
    }
    function updatePreLabels(){
      var la = st.table && st.table.legal;
      document.getElementById('htPreCallLabel').textContent =
        la && la.callAmount ? '자동 콜 ' + stackText(la.callAmount) : '자동 콜';
    }

    /* ── 렌더 / 폴링 ─────────────────────────────────────────────── */
`;
