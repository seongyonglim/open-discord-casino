/* 바카라 화면 — 코인 버튼 · 참가자 목록 · 합계.

   브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라 문자열이고,
   baccarat.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   순서를 바꾸면 안 된다. 나눈 목적은 읽기이고, 산출물은 한 글자도 달라지지 않아야 한다
   (scripts/golden.ts 가 바이트로 확인한다). */
export const BC_ROSTER_JS = `      /* ── 코인 버튼 ──────────────────────────────────────────────── */
      function renderCoins(){
        if (coinsEl.dataset.done) return;
        coinsEl.dataset.done = '1';
        coinsEl.innerHTML = (st.coins||[]).map(function(v){
          return '<button type="button" class="coin '+buttonKind(v)+'" data-coin="'+v+'">' +
            '<span class="face">'+coinLabel(v)+'</span></button>';
        }).join('');
        coin = (st.coins||[])[0];
        coinsEl.querySelectorAll('.coin').forEach(function(b){
          b.addEventListener('click', function(){
            coin = Number(b.dataset.coin);
            syncCoinActive();
          });
        });
        syncCoinActive();
      }
      function syncCoinActive(){
        coinsEl.querySelectorAll('.coin').forEach(function(b){
          b.classList.toggle('active', Number(b.dataset.coin) === coin);
        });
      }

      /* ── 우측 참가자 패널 ──────────────────────────────────────────
         칩이 아바타에서 출발하고 아바타로 돌아가므로 더미보다 먼저 그려져 있어야 한다. */
      var rosterSig=null, lastBal={};
      function renderRoster(){
        var players = st.players || [];
        var sig = players.map(function(p){ return p.user_id; }).join(',');
        if (sig !== rosterSig) {
          rosterSig = sig;
          if (!players.length) {
            rosterEl.innerHTML = '<div class="empty" style="padding:16px 0">아직 참가자가 없습니다</div>';
          } else {
            rosterEl.innerHTML = players.map(function(p){
              var ini = esc((String(p.username||'?').trim()[0] || '?').toUpperCase());
              /* 이미지가 실패하면 이니셜로 되돌린다 — 프로필을 바꾸면 저장된 주소가
                 404가 되는데(갱신은 다시 로그인할 때뿐이다) 폴백이 없으면 빈 원이 남는다.
                 클래스는 그대로 둔다: 칩 연출이 .rw-av로 이 자리를 찾는다. */
              var ph = '<span class="rw-av">'+ini+'</span>';
              var av = p.avatar
                ? '<img class="rw-av" src="'+esc(p.avatar)+'" alt="" referrerpolicy="no-referrer"'
                  + ' onerror="this.onerror=null;this.outerHTML='+esc(JSON.stringify(ph))+'">'
                : ph;
              return '<div class="rw'+(p.user_id===st.me?' me':'')+'" data-uid="'+esc(p.user_id)+'">' +
                av +
                '<span class="rw-mid"><span class="rw-name">'+esc(p.username)+'</span>' +
                '<span class="rw-bal" id="bal-'+esc(p.user_id)+'">'+fmt(p.balance)+'</span></span>' +
                '<span class="rw-bet" id="bet-'+esc(p.user_id)+'"></span></div>';
            }).join('');
          }
        }
        players.forEach(function(p){
          var balEl = document.getElementById('bal-'+p.user_id);
          if (balEl) {
            var prev = lastBal[p.user_id];
            if (prev != null && p.balance !== prev) replay(balEl, p.balance > prev ? 'up' : 'down');
            balEl.textContent = fmt(p.balance);
          }
          lastBal[p.user_id] = p.balance;
          var betEl = document.getElementById('bet-'+p.user_id);
          if (betEl) {
            betEl.innerHTML = (p.payout > 0)
              ? '<span class="pos">+'+fmt(p.payout)+'</span>'
              : fmt(p.staked);
          }
          var row = rosterEl.querySelector('.rw[data-uid="'+cssEsc(p.user_id)+'"]');
          if (row) row.classList.toggle('won', p.payout > 0);
        });
      }

      // 총액 표기 + 코인 더미는 매 폴링마다 갱신 (골격은 건드리지 않는다)
      function updateTotals(){
        var byMarket={}, total=0;
        (st.bets||[]).forEach(function(b){
          if (!byMarket[b.market]) byMarket[b.market] = {};
          byMarket[b.market][b.user_id] = (byMarket[b.market][b.user_id]||0) + b.amount;
          total += b.amount;
        });
        ALL_KEYS.forEach(function(k){
          var per = byMarket[k] || {};
          var t = 0;
          Object.keys(per).forEach(function(u){ t += per[u]; });
          var el=document.getElementById('tot-'+k);
          if (el) el.textContent = compact(t);
          syncPile(k, per, st.round.id);
        });
        potEl.textContent = fmt(total);
        var staked = (st.myBets||[]).reduce(function(a,b){return a+b.amount;},0);
        clearBtn.disabled = st.round.phase!=='betting' || staked<=0;
      }

      /* ── 안내는 «내가 할 일이 있을 때» 만 뜬다 ────────────────────────
         한동안 판의 모든 구간을 글로 중계했다 — "카드 공개 · 3초", "세 번째 카드 · 2초",
         "뱅커 승 · 다음 라운드까지 5초". 그런데 그 셋은 화면이 이미 말하고 있다.
         카드가 뒤집히는 것이 보이고, 세 번째 장이 놓이는 것이 보이고, 이긴 쪽에
         테두리가 켜진다. 글은 그것을 한 번 더 말하면서 펠트 위 한 줄을 계속 차지했다.

         그래서 남기는 것은 하나다 — 베팅 마감까지 몇 초인가. 이것만은 화면이
         말해 줄 수 없고(칩을 언제까지 올릴 수 있는지는 시계에만 있다), 내가 손을
         움직여야 하는 유일한 구간이다. 나머지 구간에서는 빈 문자열을 돌려 뱃지를
         걷는다(app.js 의 casinoBadge 가 st-empty 로 접는다). */
      function phaseText(r){
        if (r.phase === 'betting') return '베팅 마감까지 ' + r.secondsLeft + '초';
        return '';
      }

`;
