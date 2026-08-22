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

        // 베팅 중에는 뒷면 네 장을 딜러 자리에서 한 장씩 내려놓는다.
        // 페이지에 막 들어온 순간에는 돌리지 않는다 — 이미 진행 중인 베팅 창
        // 한가운데일 수 있어, 그때 딜링을 시작하면 앞뒤가 안 맞는다.
        if (betting && !firstState) dealSequence(r.id);

        var res = r.result;
        pSeatEl.classList.toggle('win', !!res && res.winner === 'player');
        bSeatEl.classList.toggle('win', !!res && res.winner === 'banker');
        pSeatEl.classList.toggle('lose', !!res && res.winner === 'banker');
        bSeatEl.classList.toggle('lose', !!res && res.winner === 'player');

        renderMarkets();
        renderRoster();   // 칩이 아바타에서 출발하므로 더미보다 먼저 그려져 있어야 한다
        updateTotals();
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
