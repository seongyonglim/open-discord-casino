/* 블랙잭 화면 — 코인 더미 · 칩 비행 · 폴링.

   브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라 문자열이고,
   blackjack.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   순서를 바꾸면 안 된다. 나눈 목적은 읽기이고, 산출물은 한 글자도 달라지지 않아야 한다
   (scripts/golden.ts 가 바이트로 확인한다). */
export function bjChips(p0: string | number): string {
  return `         늘어난 만큼만 새 스프라이트를 덧붙인다. 총액에서 매번 새로 그리면 애니메이션이
         초당 다시 시작되고 쌓이는 느낌이 사라진다.
         (자리가 132px이라 5열짜리 더미가 들어간다 — 좁은 창 기준으로 재고 안 된다고 판단했었다) */
      var piles = {};
      var MAX_CHIPS = 18;
      function jit(i, m){ var x=Math.sin(i*12.9898)*43758.5453; return Math.floor((x-Math.floor(x))*m); }
      // 뒤 세 단위(1000·5000·1만)는 골드바, 앞은 동전 — 다른 게임과 같은 규칙
      function chipKind(v){
        var c = (st && st.coins) || [], i = c.indexOf(v);
        return (i >= 0 && i < c.length - BAR_COUNT) ? 'c-coin' : 'c-bar';
      }
      function chipLabel(v){ return v>=10000 ? (v/10000)+'만' : String(v); }   // 1000은 1000 그대로 — K로 줄이지 않는다
      // anim: '' 없음 · 'pending' 자리만 잡고 숨김(곧 날아올 칩)
      function chipSprite(denom, owner, idx, anim){
        var col = idx % 5, row = Math.floor(idx / 5);
        var x = (col - 2) * 14 + jit(idx, 9) - 4;
        var y = 3 + row * 5 + jit(idx + 7, 3);
        return '<span class="pchip '+chipKind(denom)+(owner===MEID?' mine':'')+(anim?' '+anim:'')+
          '" data-owner="'+esc(owner)+'"'+
          ' style="left:calc(50% + '+x+'px);bottom:'+y+'px;z-index:'+(10+idx)+'">'+chipLabel(denom)+'</span>';
      }
      // 금액을 큰 단위부터 칩으로 쪼갠다 (코인 단위 합으로만 베팅되므로 항상 정확히 나뉜다)
      function decompose(amount){
        var out=[], d=(st.coins||[]).slice().sort(function(a,b){return b-a;});
        for (var i=0;i<d.length && out.length<60;i++){
          while (amount >= d[i] && out.length < 60) { out.push(d[i]); amount -= d[i]; }
        }
        return out;
      }
      function pushChips(el, pile, denoms, owner, anim){
        var added = [];
        for (var i=0;i<denoms.length;i++){
          if (pile.list.length >= MAX_CHIPS) { pile.list.shift(); if (el.firstChild) el.removeChild(el.firstChild); }
          var slot = pile.n++ % MAX_CHIPS;
          pile.list.push({ d: denoms[i], o: owner, i: slot });
          el.insertAdjacentHTML('beforeend', chipSprite(denoms[i], owner, slot, anim));
          added.push(el.lastElementChild);
        }
        return added;
      }
      /* 기록해 둔 칩 목록 그대로 다시 그린다.
         총액을 다시 쪼개면(decompose) 500 두 개가 1K 한 개로 합쳐져 버린다 —
         올린 그대로 보여야 하므로 복원은 반드시 목록 기준이다. */
      function paintPile(el, pile){
        el.style.opacity = '';   // 회수 연출로 숨겨뒀던 더미를 되살린다
        el.innerHTML = '';
        for (var i=0;i<pile.list.length;i++){
          var c = pile.list[i];
          el.insertAdjacentHTML('beforeend', chipSprite(c.d, c.o, c.i, ''));
        }
      }
      function rebuildPile(el, seat, bet, owner, roundId){
        var pile = piles[seat] = { round: roundId, bet: 0, list: [], n: 0 };
        el.style.opacity = '';
        el.innerHTML = '';
        // 판 도중에 들어왔거나 남의 자리를 처음 볼 땐 총액밖에 모르니 그때만 쪼갠다
        if (bet > 0) { pile.bet = bet; pushChips(el, pile, decompose(bet), owner, ''); }
      }
      function syncPile(s, roundId){
        var el = document.getElementById('bjp-'+s.seat);
        if (!el) return;
        var pile = piles[s.seat];
        if (!pile || pile.round !== roundId) return rebuildPile(el, s.seat, s.bet, s.userId, roundId);
        // 줄었으면(회수) 애니메이션 없이 다시 그린다
        if (s.bet < pile.bet) return rebuildPile(el, s.seat, s.bet, s.userId, roundId);
        var delta = s.bet - pile.bet;
        if (delta > 0) {
          pile.bet = s.bet;
          // 내 칩은 클릭 즉시(dropMyChip) 올려놨으므로 여기서 또 올리지 않는다
          if (s.userId === MEID) return;
          var added = pushChips(el, pile, decompose(delta), s.userId, 'pending');
          tossFrom(rosterAvatar(s.userId), added);
          return;
        }
        // 금액은 그대로인데 칸이 비었다면 골격을 다시 그린 것이다 — 기록대로 복원
        if (el.childElementCount !== pile.list.length) paintPile(el, pile);
      }

      /* 칩이 자리 밖을 지나는 구간이 잘리지 않도록 화면 전체를 덮는 레이어 위에서 날린다 */
      var fxLayer = null;
      function getFxLayer(){
        if (!fxLayer || !fxLayer.parentNode) {
          fxLayer = document.createElement('div');
          fxLayer.className = 'chip-fly-layer';
          document.body.appendChild(fxLayer);
        }
        return fxLayer;
      }
      function cloneAt(chip, rect, cls){
        var c = chip.cloneNode(true);
        c.className = chip.className.replace(/\\b(toss|pending|fly)\\b/g, '').trim() + ' ' + cls;
        c.style.cssText = 'position:fixed;margin:0;left:'+rect.left+'px;top:'+rect.top+'px;' +
          'width:'+rect.width+'px;height:'+rect.height+'px;';
        getFxLayer().appendChild(c);
        return c;
      }
      function rosterAvatar(uid){
        return rosterEl.querySelector('.rw[data-uid="'+cssEsc(uid)+'"] .rw-av');
      }
      // src 위치에서 chips(제자리에 숨겨둔 원본)로 칩이 날아온다
      function tossFrom(src, chips){
        if (!chips || !chips.length) return;
        if (!src) { chips.forEach(function(ch){ ch.classList.remove('pending'); }); return; }
        var a = src.getBoundingClientRect();
        if (!a.width) { chips.forEach(function(ch){ ch.classList.remove('pending'); }); return; }
        chips.forEach(function(ch, i){
          var b = ch.getBoundingClientRect();
          if (!b.width) { ch.classList.remove('pending'); return; }
          var c = cloneAt(ch, b, 'toss');
          c.style.setProperty('--fx', Math.round((a.left+a.width/2) - (b.left+b.width/2)) + 'px');
          c.style.setProperty('--fy', Math.round((a.top+a.height/2) - (b.top+b.height/2)) + 'px');
          c.style.setProperty('--fs', (Math.min(2.6, a.width / b.width)).toFixed(2));
          c.style.animationDelay = (i * 70) + 'ms';
          setTimeout(function(){
            if (c.parentNode) c.parentNode.removeChild(c);
            ch.classList.remove('pending');
          }, 380 + i * 70);
        });
      }
      // 내 클릭은 폴링을 기다리지 않고 즉시 칩을 올린다.
      // 방금 누른 코인 버튼의 실제 화면 위치에서 출발해 자리 안 제자리로 날아온다.
      function dropMyChip(seat, denom){
        var el = document.getElementById('bjp-'+seat), pile = piles[seat];
        if (!el || !pile) return;
        var added = pushChips(el, pile, [denom], MEID, 'pending');
        pile.bet += denom;
        tossFrom(coinsEl.querySelector('.coin[data-coin="'+denom+'"] .face'), added);
      }
      /* 딴 자리의 칩을 각자 주인에게 돌려보낸다.
         내 것은 화면 아래 중앙(칩 바)으로, 남의 것은 오른쪽 참가자 아이콘으로 —
         포커 플립·바카라와 같은 규칙이다. */
      function flyChipsToPot(){
        var controls = document.querySelector('.poker-controls');
        var myTarget = (controls || coinsEl).getBoundingClientRect();
        var sent = [], n = 0;
        (st.seats||[]).forEach(function(s){
          if (!(s.payout > 0)) return;
          var pile = document.getElementById('bjp-'+s.seat);
          if (!pile) return;
          Array.prototype.forEach.call(pile.querySelectorAll('.pchip'), function(ch){
            var r = ch.getBoundingClientRect();
            if (!r.width) return;
            var t = myTarget;
            if (ch.classList.contains('mine')) t = myTarget;
            else {
              var av = rosterAvatar(ch.getAttribute('data-owner') || '');
              var ab = av && av.getBoundingClientRect();
              if (ab && ab.width) t = ab;
            }
            var c = cloneAt(ch, r, 'fly');
            c.style.setProperty('--tx', Math.round((t.left+t.width/2) - (r.left+r.width/2)) + 'px');
            c.style.setProperty('--ty', Math.round((t.top+t.height/2) - (r.top+r.height/2)) + 'px');
            c.style.animationDelay = (n++ * 40) + 'ms';
            sent.push(c);
          });
          pile.style.opacity = '0';
        });
        if (!n) return;
        setTimeout(function(){ sent.forEach(function(c){ if (c.parentNode) c.parentNode.removeChild(c); }); }, 900 + n*40);
      }


      /* ── 입력 ───────────────────────────────────────────────────── */
      async function post(url, body){
        var r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'},
          body: body?JSON.stringify(body):undefined });
        var d = await r.json();
        return { ok:r.ok, d:d };
      }
      seatsEl.addEventListener('click', async function(e){
        var el = e.target.closest('.bj-seat');
        if (!el || !st || !coin) return;
        // 여기서 단계를 따지지 않는다. 화면 상태는 폴링 주기만큼(최대 1초) 뒤처져 있어서,
        // 새 베팅 창이 막 열린 순간에 누르면 "아직 마감된 라운드"로 보고 눌린 걸 삼켜버린다.
        // 받아줄지는 서버가 정한다 — 늦었으면 400이 오고, 그때 자리를 한 번 튕겨 알려준다.
        var seat = Number(el.dataset.seat);
        var res = await post('/api/games/blackjack/bet', { seat: seat, amount: coin });
        if (res.ok) {
          setBalance(res.d.balance);
          dropMyChip(seat, coin);
          if (window.casinoSfx && window.casinoSfx.chip) window.casinoSfx.chip();
        } else {
          // 문구를 띄우면 아래 내용이 밀려서 다음 클릭이 엉뚱한 데로 간다. 자리만 짧게 튕긴다.
          replay(el, 'deny');
        }
        poll();
      });
      hitBtn.addEventListener('click', async function(){
        var res = await post('/api/games/blackjack/action', { action: 'hit' });
        if (res.ok && window.casinoSfx) window.casinoSfx.card();
        poll();
      });
      dblBtn.addEventListener('click', async function(){
        var res = await post('/api/games/blackjack/action', { action: 'double' });
        if (res.ok) {
          setBalance(res.d.balance);
          // 베팅이 두 배가 됐으니 서클 칩도 한 개 더 날려 보낸다
          // 베팅이 두 배가 됐으니 그만큼 칩을 더 올린다
          if (st.myHand) dropMyChip(st.myHand.seat, st.myHand.bet);
          if (window.casinoSfx) window.casinoSfx.card();
        }
        poll();
      });
      standBtn.addEventListener('click', async function(){
        await post('/api/games/blackjack/action', { action: 'stand' });
        poll();
      });
      surBtn.addEventListener('click', async function(){
        /* 확인창 없이 바로 적용한다. 결정 시간이 15초뿐인데 브라우저 기본 대화상자가
           그 위에 뜨면 흐름이 끊기고, 무엇보다 이 버튼은 첫 두 장에서만 나오므로
           실수로 누를 자리가 아니다. 무효 규칙은 버튼 아래 설명과 규칙 도움말에 적혀 있다. */
        var res = await post('/api/games/blackjack/action', { action: 'surrender' });
        if (!res.ok && res.d && res.d.error) alert(res.d.error);
        poll();
      });
      clearBtn.addEventListener('click', async function(){
        var res = await post('/api/games/blackjack/clear');
        if (res.ok) { setBalance(res.d.balance); if (window.casinoSfx) window.casinoSfx.win('gain'); }
        poll();
      });

      /* ── 폴링 ───────────────────────────────────────────────────── */
      var pollFails = 0;
      async function poll(){
        var d = await window.casinoPoll('/api/games/blackjack/state');
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
