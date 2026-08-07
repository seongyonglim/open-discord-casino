/* 블랙잭 화면 — 자리 · 코인 버튼 · 참가자 목록.

   브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라 문자열이고,
   blackjack.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   순서를 바꾸면 안 된다. 나눈 목적은 읽기이고, 산출물은 한 글자도 달라지지 않아야 한다
   (scripts/golden.ts 가 바이트로 확인한다). */
export const BJ_SEATS_JS = `      /* ── 자리 ──────────────────────────────────────────────────────
         일곱 자리를 항상 그린다. 빈 자리는 눌러서 앉을 수 있고, 앉으면 그 자리에 칩이 쌓인다.
         (앉기와 베팅을 따로 두면 앉아만 놓고 베팅 안 한 자리가 남아 남이 못 앉는다) */
      function renderSeats(){
        var r = st.round;
        var bySeat = {};
        (st.seats||[]).forEach(function(s){ bySeat[s.seat] = s; });
        var betting = r.phase === 'betting' || r.phase === 'waiting';

        var html = '', sigParts = [];
        for (var i=0;i<SEATS;i++){
          var s = bySeat[i];
          if (!s) {
            html += '<div class="bj-seat empty' + (betting ? ' open' : '') + '" data-seat="'+i+'">' +
              '<div class="bj-seat-num">' + (i+1) + '</div>' +
              '<div class="bj-seat-hint">' + (betting ? '앉기' : '빈자리') + '</div></div>';
            sigParts.push(i + ':빈');
            continue;
          }
          var mine = s.userId === MEID;
          var cls = 'bj-seat' + (mine ? ' mine' : '') +
            (s.status==='bust' ? ' bust' : '') +
            (s.status==='blackjack' ? ' bj' : '') +
            (s.outcome==='win'||s.outcome==='blackjack' ? ' won' : '') +
            (s.outcome==='lose'||s.outcome==='bust' ? ' lost' : '');
          html += '<div class="'+cls+'" data-seat="'+i+'">' +
            '<div class="bj-seat-top"><span class="bj-seat-name">'+esc(s.username)+'</span>' +
              '<span class="bj-seat-total" id="bjt-'+i+'"></span></div>' +
            '<div class="bj-hand small" id="bjh-'+i+'"></div>' +
            // 21을 넘긴 순간 손패 위에 찍히는 도장 (딜러 쪽과 같은 규칙).
            // 손패 div 안에 넣으면 syncCards가 관리하는 자식 순서와 섞이므로 형제로 둔다.
            '<span class="bj-seat-bust" id="bjx-'+i+'" hidden>BUST</span>' +
            '<div class="bj-pile" id="bjp-'+i+'"></div>' +
            '<div class="bj-seat-foot">' +
              '<span class="bj-seat-bet" id="bjb-'+i+'"></span>' +
              '<span class="bj-seat-tag" id="bjg-'+i+'"></span>' +
            '</div></div>';
          sigParts.push(i + ':' + s.userId + ':' + cls);
        }
        /* 골격은 "누가 어느 자리에 앉았나 / 상태 클래스"가 바뀔 때만 다시 그린다.
           금액·끗수까지 서명에 넣으면 칩을 올릴 때마다 통째로 갈아끼워져서
           쌓아둔 칩 더미와 카드 애니메이션이 매번 처음부터 다시 시작된다. */
        var sig = sigParts.join('|') + '|' + betting;
        if (seatsEl.dataset.sig !== sig) {
          seatsEl.dataset.sig = sig;
          seatsEl.innerHTML = html;
          slotCache = Object.keys(slotCache).reduce(function(a,k){ if(k==='dealer') a[k]=slotCache[k]; return a; }, {});
          // 더미 기록은 버리지 않는다 — 아래 syncPile이 기록 그대로 새 칸에 다시 그린다
        }
        var dealt = 0;
        (st.seats||[]).forEach(function(s){
          var el = document.getElementById('bjh-'+s.seat);
          if (el) dealt += syncCards(el, 'seat'+s.seat, s.cards);
          // 자주 바뀌는 값은 골격을 건드리지 않고 제자리에서 갱신한다
          var t = document.getElementById('bjt-'+s.seat);
          if (t) t.textContent = s.total != null ? s.total : '';
          var b = document.getElementById('bjb-'+s.seat);
          if (b) b.textContent = compact(s.bet);
          var g = document.getElementById('bjg-'+s.seat);
          if (g) g.textContent = s.outcome ? outcomeLabel(s.outcome) : statusLabel(s.status);
          markSeatBust(s);
          syncPile(s, r.id);
        });
        return dealt;
      }

      /* 플레이어 버스트 연출.
         딜러 쪽과 같은 도장을 자리에 찍고, 자리를 한 번 흔든다.
         소리는 내 자리에서만 낸다 — 다섯 자리가 같은 판에서 함께 죽으면
         "쿵"이 다섯 번 겹쳐 울려서 무슨 일이 났는지 알 수 없게 된다. */
      var seatBust = {};
      function markSeatBust(s){
        var el = document.getElementById('bjx-'+s.seat);
        if (!el) return;
        var on = s.status === 'bust';
        if (on === !!seatBust[s.seat]) { el.hidden = !on; return; }
        seatBust[s.seat] = on;
        el.hidden = !on;
        if (!on) { el.classList.remove('pop'); return; }
        if (firstState) return;   // 이미 끝난 판을 열었을 뿐이다 — 도장만 남기고 연출은 생략
        replay(el, 'pop');
        var seat = seatsEl.querySelector('.bj-seat[data-seat="'+s.seat+'"]');
        if (seat) replay(seat, 'bustshake');
        if (s.userId === MEID && window.casinoSfx && window.casinoSfx.bust) window.casinoSfx.bust();
      }


      function renderCoins(){
        if (coinsEl.dataset.done) return;
        coinsEl.dataset.done = '1';
        coinsEl.innerHTML = (st.coins||[]).map(function(v){
          return '<button type="button" class="coin '+buttonKind(v)+'" data-coin="'+v+'">' +
            '<span class="face">'+coinLabel(v)+'</span></button>';
        }).join('');
        coin = (st.coins||[])[0];
        coinsEl.querySelectorAll('.coin').forEach(function(b){
          b.addEventListener('click', function(){ coin = Number(b.dataset.coin); syncCoinActive(); });
        });
        syncCoinActive();
      }
      function syncCoinActive(){
        coinsEl.querySelectorAll('.coin').forEach(function(b){
          b.classList.toggle('active', Number(b.dataset.coin) === coin);
        });
      }

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
              return '<div class="rw'+(p.user_id===MEID?' me':'')+'" data-uid="'+esc(p.user_id)+'">' + av +
                '<span class="rw-mid"><span class="rw-name">'+esc(p.username)+'</span>' +
                '<span class="rw-bal" id="bjbal-'+esc(p.user_id)+'">'+fmt(p.balance)+'</span></span>' +
                '<span class="rw-bet" id="bjbet-'+esc(p.user_id)+'"></span></div>';
            }).join('');
          }
        }
        players.forEach(function(p){
          var b = document.getElementById('bjbal-'+p.user_id);
          if (b) {
            var prev = lastBal[p.user_id];
            if (prev != null && p.balance !== prev) replay(b, p.balance > prev ? 'up' : 'down');
            b.textContent = fmt(p.balance);
          }
          lastBal[p.user_id] = p.balance;
          var e = document.getElementById('bjbet-'+p.user_id);
          if (e) e.innerHTML = (p.payout > 0)
            ? '<span class="pos">+'+fmt(p.payout)+'</span>'
            : '<span class="rw-amt">'+fmt(p.bet)+'</span>';
          var row = rosterEl.querySelector('.rw[data-uid="'+cssEsc(p.user_id)+'"]');
          if (row) row.classList.toggle('won', p.payout > 0);
        });
        potEl.textContent = fmt(players.reduce(function(a,p){ return a + p.bet; }, 0));
      }

`;
