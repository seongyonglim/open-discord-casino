/* 바카라 화면 — 렌더 · 폴링.

   브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라 문자열이고,
   baccarat.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   순서를 바꾸면 안 된다. 나눈 목적은 읽기이고, 산출물은 한 글자도 달라지지 않아야 한다
   (scripts/golden.ts 가 바이트로 확인한다). */
export function bcLoop(p0: string | number): string {
  return `      var balHeld = null;
      function render(){
        var r = st.round;
        /* 서버는 결과를 내보내기 «전에» 잔액부터 올린다. 그대로 그리면 카드가 아직
           안 뒤집혔는데 숫자가 먼저 오르고, 곧이어 정산 연출이 그것을 되돌려 잔고가
           한 번 튀었다 내려간다(실측: 1,317,062 로 올랐다가 1,297,062 로 돌아온 뒤
           세어 올랐다).
           베팅이 끝나는 순간의 잔고를 들고 있다가, 연출이 시작될 때까지 그것을
           보여 준다. 연출이 시작되면(notedRoundId) 카운트업이 이어받는다. */
        if (r.phase === 'betting') balHeld = st.balance;
        setBalance(r.phase !== 'betting' && balHeld != null && notedRoundId !== r.id
          ? balHeld : st.balance);
        renderCoins();
        renderHistory(st.history);
        /* 사다리와 같은 배지 모양으로 그린다 — 모양은 19-timer.css, 그리는 일은
           app.js 의 casinoBadge. 문구를 만드는 일은 여기 그대로다.
           알약은 이 요소의 «자식» 이라, 아래에서 className 을 덮어써도 살아남는다. */
        statusEl.className = 'bacc-status' + (r.phase === 'betting' ? ' live' : '');
        if (window.casinoBadge) casinoBadge.set(statusEl, phaseText(r));
        else statusEl.textContent = phaseText(r);

        if (r.id !== lastRoundId) {
          lastRoundId = r.id;
          clearDeal();                 // 지난 라운드의 딜링 타이머를 정리한다
          clearReveal();
          shown = { p: 0, b: 0 }; scheduled = { p: 0, b: 0 };
          slotCache = {};
          pCardsEl.innerHTML = ''; bCardsEl.innerHTML = '';
          pSeatEl.classList.remove('win','lose'); bSeatEl.classList.remove('win','lose');
        }

        /* ── 들어온 순간의 판은 «이미 지나간 판» 이다 ────────────────────
           다른 화면에 갔다가 돌아오면 카드가 통째로 회수됐다가 다시 깔렸다.
           베팅 창 한가운데인데 처음부터 다시 시작하는 것처럼 보인다.

           까닭: 연출을 «판마다 한 번» 으로 막고 있는 열쇠(dealtRoundId · notedRoundId)가
           페이지를 새로 열면 비어 있다. 첫 렌더는 firstState 가 막아 주지만 그것뿐이라,
           1초 뒤 두 번째 폴링에서 같은 베팅 판에 딜링이 그대로 돌았다.
           firstState 는 «첫 렌더» 를 뜻하지 두 번째 폴링까지 덮지 못한다.

           그래서 들어온 순간 그 판의 열쇠를 미리 찍어 둔다. 이 판의 딜링도 정산도
           이미 지나간 것으로 치고, 지금 페이즈의 정지 화면만 그린다.
           다음 판(r.id 가 바뀐다)부터는 열쇠가 안 맞으므로 정상으로 돌아간다 —
           즉 «화면에 머무르는 동안 실제로 넘어간 판» 에만 연출이 돈다. */
        if (firstState) {
          dealtRoundId = r.id;
          if (r.result) notedRoundId = r.id;
        }

        var betting = r.phase === 'betting';
        if (firstState || r.phase === 'done') {
          // 페이지에 막 들어왔거나 이미 끝난 판이면 한 장씩 까는 게 의미가 없다.
          // (이미 정해진 결과를 뒤늦게 연출하면 앞뒤가 안 맞는다)
          clearReveal();
          shown = { p: r.player.length, b: r.banker.length };
          scheduled = { p: shown.p, b: shown.b };
        } else if (!betting) {
          scheduleReveal(r);
        }
        paintHands(r);

        /* 베팅 중에는 뒷면 네 장을 딜러 자리에서 한 장씩 내려놓는다.
           들어온 판은 위에서 dealtRoundId 를 찍어 두었으므로 여기서 걸러진다 —
           firstState 검사만으로는 두 번째 폴링을 못 막는다(위 주석을 보라). */
        if (betting) dealSequence(r.id);

        var res = r.result;
        pSeatEl.classList.toggle('win', !!res && res.winner === 'player');
        bSeatEl.classList.toggle('win', !!res && res.winner === 'banker');
        pSeatEl.classList.toggle('lose', !!res && res.winner === 'banker');
        bSeatEl.classList.toggle('lose', !!res && res.winner === 'player');

        renderMarkets();
        renderRoster();   // 칩이 아바타에서 출발하므로 더미보다 먼저 그려져 있어야 한다
        updateTotals();
        /* 윤곽선은 매 렌더마다 다시 잰다. 골격이 새로 그려지면 SVG 도 같이 날아가고,
           창 크기가 바뀌면 판과 돔의 자리가 달라진다 — 값을 캐시하면 선이 어긋난다.
           하는 일은 속성 세 개를 쓰는 것뿐이라 매초 돌아도 싸다. */
        paintContour(res);
        firstState = false;

        if (res && notedRoundId !== r.id) {
          notedRoundId = r.id;
          burstAndFly(res);
          var mine = (st.myBets||[]);
          if (mine.length) {
            var gained = mine.reduce(function(a,b){ return a + (b.payout||0); }, 0);
            var net = mine.reduce(function(a,b){ return a + ((b.payout||0) - b.amount); }, 0);
            if (gained > 0) {
              if (window.casinoSfx) window.casinoSfx.win();
              // 잔고의 bump 는 카운트업이 끝나는 순간에 친다(countBalance) — 여기서
              // 치면 숫자가 아직 안 오른 채로 튄다
              if (net > 0 && card) replay(card, 'gold-flash');
            } else if (window.casinoSfx) {
              window.casinoSfx.lose();
            }
          }
        }
      }

      /* ── 입력 ───────────────────────────────────────────────────── */
      async function post(url, body){
        var r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'},
          body: body?JSON.stringify(body):undefined });
        var d = await r.json();
        return { ok:r.ok, d:d };
      }
      async function placeChip(market){
        var bet = coin;
        /* 소리는 «누른 그 순간» 이다 — 서버 응답을 기다리면 200ms 뒤에 울려서
           내 손가락과 어긋난다. 홀덤이 같은 이유로 같은 자리에서 낸다.
           실패하면 헛소리가 한 번 나지만, 그것이 늦은 소리보다 낫다. */
        if (window.casinoSfx && window.casinoSfx.chipBet) window.casinoSfx.chipBet();
        var res = await post('/api/games/baccarat/bet', { market:market, amount:bet });
        if (!res.ok) return;   // 실패하면 칩이 올라가지 않는 것으로 드러난다 (문구 미표시)
        setBalance(res.d.balance);
        dropMyChip(market, bet);
        poll();
      }
      clearBtn.addEventListener('click', async function(){
        var res = await post('/api/games/baccarat/clear');
        if (!res.ok) { poll(); return; }
        setBalance(res.d.balance);
        /* 회수 소리는 «칩이 내게 돌아온다» 다 — 이기고 받을 때와 같은 일이므로
           같은 소리를 쓴다(casinoSfx.chipWin). 세 게임이 같은 소리를 내야 «초기화» 가
           어느 판에서나 같은 뜻으로 들린다. 예전에는 바카라·포커 플립이 무음이었고
           블랙잭만 옛 코인 승리음을 냈다. */
        if (window.casinoSfx && window.casinoSfx.chipWin) window.casinoSfx.chipWin();
        poll();
      });

      /* ── 폴링 ───────────────────────────────────────────────────── */
      var pollFails = 0;
      async function poll(){
        var d = await window.casinoPoll('/api/games/baccarat/state');
        if (!d) { if (++pollFails >= 2) statusEl.textContent = '서버에 연결하는 중…'; return; }
        pollFails = 0;
        st = d;
        render();
        /* 채팅은 폴을 따로 돌지 않는다 — 응답의 마지막 메시지 id 만 넘겨주면 값이
           늘었을 때만 채팅이 스스로 받아 간다(app.js 의 casinoChat). */
        if (window.casinoChat) casinoChat.note(d.chatMax, d.chatMod);
      }
      /* 탭이 숨겨져 있거나 한참 아무 조작이 없으면 폴링을 멈춘다.
         사다리·그래프·포커가 이미 이 규칙을 쓰고 있는데 여기만 빠져 있었다 —
         백그라운드 탭이 1초마다 계속 요청을 보내고 있었다는 뜻이다.

         지금은 이유가 하나 더 있다: 서버가 이 폴링을 세어 "지금 몇 명이 보고 있나"를
         만든다(services/presence.ts). 안 보는 탭이 섞이면 그 숫자가 거짓이 된다. */
      var IDLE_MS = 3 * 60 * 1000;
      var lastAct = Date.now(), timer = null;
      function startPolling(){
        if (timer) return;
        timer = setInterval(function(){
          if (document.hidden) { stopPolling(); return; }
          if (Date.now() - lastAct > IDLE_MS) { stopPolling(); return; }
          poll();
        }, 1000);
      }
      function stopPolling(){ if (timer) { clearInterval(timer); timer = null; } }
      function wake(){ lastAct = Date.now(); if (!document.hidden) { startPolling(); poll(); } }
      ['click','keydown','touchstart','mousemove'].forEach(function(ev){
        document.addEventListener(ev, function(){ lastAct = Date.now(); if (!timer) wake(); },
          { passive: true });
      });
      document.addEventListener('visibilitychange', function(){
        if (document.hidden) stopPolling(); else wake();
      });
      poll();
      startPolling();
    })();

      // 우측 패널 랭킹 탭
      ${p0}`;
}
