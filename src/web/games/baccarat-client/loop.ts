/* 바카라 화면 — 렌더 · 폴링.

   브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라 문자열이고,
   baccarat.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   순서를 바꾸면 안 된다. 나눈 목적은 읽기이고, 산출물은 한 글자도 달라지지 않아야 한다
   (scripts/golden.ts 가 바이트로 확인한다). */
export function bcLoop(p0: string | number): string {
  return `      function render(){
        var r = st.round;
        setBalance(st.balance);
        renderCoins();
        renderHistory(st.history);
        statusEl.textContent = phaseText(r);
        statusEl.className = 'bacc-status' + (r.phase === 'betting' ? ' live' : '');

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
          flyChipsToPot(payingMarkets(res));
          var mine = (st.myBets||[]);
          if (mine.length) {
            var gained = mine.reduce(function(a,b){ return a + (b.payout||0); }, 0);
            var net = mine.reduce(function(a,b){ return a + ((b.payout||0) - b.amount); }, 0);
            if (gained > 0) {
              if (window.casinoSfx) window.casinoSfx.win();
              if (net > 0) {
                if (card) replay(card, 'gold-flash');
                if (pbal) replay(pbal, 'bump');
              }
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
        var res = await post('/api/games/baccarat/bet', { market:market, amount:bet });
        if (!res.ok) return;   // 실패하면 칩이 올라가지 않는 것으로 드러난다 (문구 미표시)
        setBalance(res.d.balance);
        dropMyChip(market, bet);
        if (window.casinoSfx && window.casinoSfx.chip) window.casinoSfx.chip();
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
      }
      poll();
      setInterval(poll, 1000);
    })();

      // 우측 패널 랭킹 탭
      ${p0}`;
}
