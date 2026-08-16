/* 포커 플립 화면 — 렌더 · 폴링 · 유휴 정지.

   브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라 문자열이고,
   poker.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   순서를 바꾸면 안 된다. 나눈 목적은 읽기이고, 산출물은 한 글자도 달라지지 않아야 한다
   (scripts/golden.ts 가 바이트로 확인한다). */
export function pkLoop(p0: string | number): string {
  return `      function render(){
        var r=st.round;
        setBalance(st.balance);

        var newRound = r.id !== lastRoundId;
        if (newRound) { lastRoundId=r.id; clearDeal(); }

        var opened = syncCards(mCardsEl, 'm', [r.hole[0], r.hole[1]])
          + syncCards(sCardsEl, 's', [r.hole[2], r.hole[3]])
          + syncCards(boardEl, 'b', [r.board[0], r.board[1], r.board[2], r.board[3], r.board[4]]);

        // 딜링 연출은 "보고 있는 동안 새 라운드가 시작될 때"만 돌린다.
        // 페이지에 처음 들어온 순간은 lastRoundId가 비어 있어 무조건 새 라운드로 판정되는데,
        // 그때 연출을 돌리면 카드 9장을 전부 숨긴 뒤 2.24초에 걸쳐 채우므로
        // 들어올 때마다 빈 보드를 2초 넘게 보게 된다(페이지가 안 뜬 것처럼 느껴진다).
        // 처음 받은 상태는 연출 없이 즉시 그리고, 그 다음 라운드부터 연출한다.
        if (newRound && r.phase === 'betting' && !firstState) dealSequence(r.id);
        else playReveal(firstState ? 0 : opened);
        firstState = false;

        var phaseLabel = r.phase==='betting' ? ('베팅 마감까지 '+r.secondsLeft+'초')
          : r.phase==='flop' ? '플롭'
          : r.phase==='turn' ? '턴'
          : r.phase==='river' ? '리버'
          : ('다음 라운드까지 '+r.secondsLeft+'초');
        statusEl.textContent = phaseLabel;

        // 결과는 정산 후에만 공개
        if (r.phase==='done' && revealedRoundId !== r.id) revealedRoundId = r.id;
        var res = (r.phase==='done' && r.result) ? r.result : null;
        mCatEl.textContent = res ? res.masterCat : '';
        sCatEl.textContent = res ? res.sharkCat : '';
        mCatEl.className = 'seat-cat' + (res && res.winner==='master' ? ' win' : '');
        sCatEl.className = 'seat-cat' + (res && res.winner==='shark' ? ' win' : '');

        renderMarkets();
        renderRoster();   // 칩이 아바타에서 출발하므로 더미보다 먼저 그려져 있어야 한다
        updateTotals();

        if (res && notedRoundId !== r.id) {
          notedRoundId = r.id;
          // 돈이 나온 상자의 칩은 참가자 전원이 각자 아이콘으로 회수해 간다
          flyChipsToPot(payingMarkets(res));
          var mine = (st.myBets||[]);
          var net = mine.reduce(function(a,b){ return a + ((b.payout||0) - b.amount); }, 0);
          if (mine.length) {
            // 손익(net)과 별개로 "돌려받은 게 한 푼이라도 있는지"(gained)로 연출을 가른다.
            // 여러 곳에 걸어 전체로는 손해여도 맞은 상자가 있으면 그쪽 칩은 회수해 와야 한다.
            var gained = mine.reduce(function(a,b){ return a + (b.payout||0); }, 0);

            if (gained > 0) {
              if (window.casinoSfx) window.casinoSfx.win();
              if (net > 0) {
                if (card) replay(card, 'gold-flash');
                if (pbal) replay(pbal, 'bump');
              }
            } else {
              // 한 푼도 못 건짐 — 낙첨 사운드
              if (window.casinoSfx) window.casinoSfx.lose();
            }
          }
        }
      }

      async function post(url, body){
        var r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: body?JSON.stringify(body):undefined });
        var d = await r.json();
        return { ok:r.ok, d:d };
      }

      async function placeChip(market){
        var bet = coin;
        var res = await post('/api/games/poker/bet', { market:market, amount:bet });
        if (!res.ok) return;   // 실패하면 칩이 올라가지 않는 것으로 드러난다 (문구 미표시)
        setBalance(res.d.balance);
        dropMyChip(market, bet);
        if (window.casinoSfx && window.casinoSfx.chip) window.casinoSfx.chip();
        poll();
      }

      async function clearAll(){
        var res = await post('/api/games/poker/clear');
        if (!res.ok) { poll(); return; }
        setBalance(res.d.balance);
        poll();
      }
      clearBtn.addEventListener('click', clearAll);

      // 통신 실패는 화면에 알리고 다음 주기에 다시 시도한다 (조용히 죽으면 반쪽 화면으로 굳는다)
      var pollFails = 0;
      async function poll(){
        var __first = st === null;
        if (__first && window.casinoMark) window.casinoMark('첫 상태 요청 보냄');
        var d = await window.casinoPoll('/api/games/poker/state');
        if (__first && window.casinoMark) window.casinoMark('첫 상태 응답 받음');
        if (!d) {
          if (++pollFails >= 2) statusEl.textContent = '서버에 연결하는 중… 잠시만요';
          return;
        }
        pollFails = 0;
        st = d;
        if (coin == null) {
          coin = st.coins[1] != null ? st.coins[1] : st.coins[0];
          try { var c=localStorage.getItem('poker_coin'); if (c && st.coins.indexOf(Number(c))>=0) coin=Number(c); } catch(e){}
        }
        if (!coinsEl.children.length) renderCoins();
        render();
        /* 채팅은 폴을 따로 돌지 않는다 — 응답의 마지막 메시지 id 만 넘겨주면 값이
           늘었을 때만 채팅이 스스로 받아 간다(app.js 의 casinoChat). */
        if (window.casinoChat) casinoChat.note(d.chatMax);
        if (__first && window.casinoMark) window.casinoMark('첫 렌더 완료 (카드·베팅판 표시)');
      }

      // 폴링 비용 관리 (다른 게임과 동일): 탭 숨김·장시간 무조작 시 중단
      var IDLE_MS = 3*60*1000;
      var timer=null, lastAct=Date.now();
      function startPolling(){
        if (timer) return;
        poll();
        timer = setInterval(function(){
          if (document.hidden) { stopPolling(); return; }
          if (Date.now()-lastAct > IDLE_MS) { stopPolling(); statusEl.textContent='일시정지 (화면을 클릭하면 재개)'; return; }
          poll();
        }, 1000);
      }
      function stopPolling(){ if (timer) { clearInterval(timer); timer=null; } }
      function activity(){ lastAct=Date.now(); if (!timer && !document.hidden) startPolling(); }
      ['pointerdown','keydown','focus'].forEach(function(ev){ window.addEventListener(ev, activity, true); });
      document.addEventListener('visibilitychange', function(){ if (document.hidden) stopPolling(); else activity(); });
      startPolling();
    })();

      // 우측 패널 랭킹 탭
      ${p0}`;
}
