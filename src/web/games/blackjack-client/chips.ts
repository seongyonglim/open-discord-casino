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
      var drewOnce = false;   // 자리를 한 바퀴 다 그려 봤다 (seats.ts 가 세운다)
      /* 한 줄에 다섯 장씩 여덟 줄 = 마흔 장(요청: 기둥당 여덟 장).
         넘으면 버리는 게 아니라 바닥부터 큰 칩으로 바꾼다(compressPile). */
      var MAX_CHIPS = 40;
      function jit(i, m){ var x=Math.sin(i*12.9898)*43758.5453; return Math.floor((x-Math.floor(x))*m); }
      /* 액면은 «크기» 가 아니라 «색» 이 말한다. 한동안 앞 세 단은 동전, 뒤 세 단은
         골드바였다 — 크기 차이가 곧 액면 차이였다. 읽기는 됐지만 판에 올라간 것이
         금색 동전과 금색 막대 두 가지뿐이라 실제 카지노 판처럼 보이지 않았다.
         이제 전부 같은 크기의 클레이 칩이고 색이 액면이다(바카라와 같은 규칙).
         c-coin 은 그대로 붙인다: 날아가는 칩을 정원으로 되돌리는 보정(cloneAt)과
         scripts/check-chips.ts 의 «정사각인가» 검사가 이 클래스로 갈린다 —
         c-bar 를 남기면 1000·5000·1만 이 그 검사에서 통째로 빠진다. */
      function chipKind(v){ return 'c-coin'; }
      function denomClass(v){ return window.casinoChip ? casinoChip.cls(v) : 'd10k'; }
      function chipArt(v){ return window.casinoChip ? casinoChip.art(v) : String(v); }
      function chipLabel(v){ return v>=10000 ? (v/10000)+'만' : String(v); }   // 1000은 1000 그대로 — K로 줄이지 않는다
      // anim: '' 없음 · 'pending' 자리만 잡고 숨김(곧 날아올 칩)
      /* 가로로 벌어지는 폭을 px 로 박지 않는다 — 자리 폭이 화면에 따라 달라지기 때문이다.
         데스크톱에서는 자리가 132px 이라 5열 더미가 넉넉했는데, 폰에서는 같은 자리가
         63px 로 줄어든다(5자리 + 간격이 375px 을 나눠 갖는다). 그런데 벌어지는 폭은
         고정이라, 골드바 칩이 중심에서 53px 까지 나가 옆자리로 삐져나왔다.
         칸 간격과 흔들림을 CSS 변수로 빼서 좁은 화면에서 함께 줄인다. */
      function chipSprite(denom, owner, idx, anim){
        var col = idx % 5, row = Math.floor(idx / 5);
        var c = col - 2, jx = jit(idx, 9) - 4;
        var x = 'calc(50% + '+c+' * var(--pcPitch, 14px) + '+jx+' * var(--pcJit, 1px))';
        var y = 3 + row * 5 + jit(idx + 7, 3);
        return '<span class="pchip bc3d '+chipKind(denom)+' '+denomClass(denom)+
          (owner===MEID?' mine':'')+(anim?' '+anim:'')+
          '" data-owner="'+esc(owner)+'"'+
          ' style="left:'+x+';bottom:'+y+'px;z-index:'+(10+idx)+'">'+chipArt(denom)+'</span>';
      }
      // 금액을 큰 단위부터 칩으로 쪼갠다 (코인 단위 합으로만 베팅되므로 항상 정확히 나뉜다)
      function decompose(amount){
        var out=[], d=(st.coins||[]).slice().sort(function(a,b){return b-a;});
        for (var i=0;i<d.length && out.length<60;i++){
          while (amount >= d[i] && out.length < 60) { out.push(d[i]); amount -= d[i]; }
        }
        return out;
      }
      /* ── 꽉 차면 «맨 밑에서부터» 큰 칩으로 바꾼다 ────────────────────
         한동안은 상한을 넘으면 오래된 칩을 하나씩 «버렸다». 그러면 그려진 합이
         올린 금액보다 작아진다 — 그리고 바로 그 어긋남을 안전망이 «다시 그려라» 로
         읽어서, 상한을 넘는 순간부터 매 폴링마다 판이 통째로 다시 그려진다.
         쌓이는 느낌이 사라질 뿐 아니라 총액을 다시 쪼개므로 «올린 그대로» 도 아니다.

         실제 딜러가 하는 일은 다르다. 판이 커지면 바닥의 잔칩을 큰 칩 한 장으로
         바꿔 준다(color-up). 장수는 줄지만 금액은 한 푼도 안 바뀐다.
         코인 단위가 모두 위 단위의 약수라 정확히 나누어떨어진다:
         10×10=100 · 5×100=500 · 2×500=1000 · 5×1000=5000 · 2×5000=10000.
         바꿀 것이 없으면(전부 최고 액면이면) 그때만 오래된 쪽을 자른다. */
      function colorUpOnce(list){
        var d = (st.coins||[]).slice().sort(function(a,b){ return a-b; });
        for (var i=0;i<d.length-1;i++){
          var small = d[i], big = d[i+1], need = big / small;
          if (need !== Math.floor(need) || need < 2) continue;
          var idx = [];
          for (var j=0;j<list.length && idx.length<need;j++) if (list[j].d === small) idx.push(j);
          if (idx.length < need) continue;
          var owner = list[idx[0]].o;
          for (var k=idx.length-1;k>=0;k--) list.splice(idx[k], 1);
          list.unshift({ d: big, o: owner, i: 0 });   // 바뀐 큰 칩은 맨 아래에 깔린다
          return true;
        }
        return false;
      }
      function compressPile(pile){
        var guard = 0;
        while (pile.list.length > MAX_CHIPS && colorUpOnce(pile.list) && ++guard < 400) {}
        while (pile.list.length > MAX_CHIPS) pile.list.shift();
        // 자리 번호를 다시 매긴다 — 목록 순서가 곧 자리다
        for (var i=0;i<pile.list.length;i++) pile.list[i].i = i;
      }
      /* anim 이 'pending' 이면 새로 얹은 칩만 제자리에 «숨긴 채» 그리고 그 요소들을
         돌려준다 — 부르는 쪽이 그 자리로 칩을 날린 뒤 드러낸다. */
      function pushChips(el, pile, denoms, owner, anim){
        if (!denoms.length) return [];
        for (var i=0;i<denoms.length;i++) pile.list.push({ d: denoms[i], o: owner, i: 0 });
        compressPile(pile);
        var from = pile.list.length - denoms.length;
        if (from < 0) from = 0;
        paintPile(el, pile, anim === 'pending' ? from : null);
        return anim === 'pending' ? [].slice.call(el.querySelectorAll('.pchip.pending')) : [];
      }
      /* 기록해 둔 칩 목록 그대로 다시 그린다.
         총액을 다시 쪼개면(decompose) 500 두 개가 1K 한 개로 합쳐져 버린다 —
         올린 그대로 보여야 하므로 복원은 반드시 목록 기준이다. */
      function paintPile(el, pile, pendFrom){
        el.style.opacity = '';   // 회수 연출로 숨겨뒀던 더미를 되살린다
        el.innerHTML = '';
        for (var i=0;i<pile.list.length;i++){
          var c = pile.list[i];
          el.insertAdjacentHTML('beforeend',
            chipSprite(c.d, c.o, c.i, (pendFrom != null && i >= pendFrom) ? 'pending' : ''));
        }
      }
      function rebuildPile(el, seat, bet, owner, roundId){
        var prev = piles[seat];
        /* 남의 자리에 베팅이 새로 나타난 것은 «방금 일어난 일» 이므로 날려서 보여 준다.
           단 페이지에 막 들어와 이미 걸려 있던 것을 발견한 경우는 그냥 그린다 — 그건
           방금 일어난 일이 아니라 이미 있던 상태다. 그래서 첫 한 바퀴만 조용히 그린다.

           처음엔 «다른 자리가 이 라운드로 그려져 있나» 로 판정했는데, 그러면 그 라운드에서
           가장 먼저 도는 자리는 아직 아무도 안 그려져 있어 늘 조용히 지나갔다
           (실측: 다섯 자리가 걸었는데 날아온 자리는 넷). 자리 순서에 기대지 않도록,
           한 바퀴를 다 돌아 봤는지만 본다 — 그 표시는 seats.ts 가 세운다.

           이 갈래가 없어서 남의 베팅은 한 번도 안 날았다. 봇이든 사람이든 대개
           라운드마다 «한 번에» 거는데, 그러면 그 자리를 처음 보는 순간이 곧 그 금액이라
           아래 syncPile 의 delta 가지에 갈 일이 없고 늘 여기로 온다.
           실측: 100초 동안 남의 금액이 54번 바뀌었는데 날아간 칩은 0개였다. */
        var arrived = drewOnce && owner !== MEID && bet > 0
          && (!prev || prev.round !== roundId || prev.bet < bet);
        var pile = piles[seat] = { round: roundId, bet: 0, list: [], n: 0 };
        el.style.opacity = '';
        el.innerHTML = '';
        // 판 도중에 들어왔거나 남의 자리를 처음 볼 땐 총액밖에 모르니 그때만 쪼갠다
        if (bet > 0) {
          pile.bet = bet;
          var added = pushChips(el, pile, decompose(bet), owner, arrived ? 'pending' : '');
          if (arrived) { tossFrom(rosterAvatar(owner), added); betSfx(); }
        }
      }
      /* 남이 걸 때 나는 소리. 여럿이 동시에 걸면 겹쳐 지저분해지므로 150ms 에 한 번만
         낸다 — 알리는 것이 목적이지 개수를 세어 주는 것이 아니다. */
      function betSfx(){
        if (Date.now() - lastBetSfx <= 150) return;
        lastBetSfx = Date.now();
        if (window.casinoSfx && window.casinoSfx.chipBet) window.casinoSfx.chipBet();
      }
      /* 지금 그려 둔 칩들의 합. pile.bet 이라는 별도 카운터가 아니라 이 값을 근거로 삼는다 —
         카운터는 "올렸다고 믿는 금액"이고 이건 "실제로 화면에 있는 금액"이다. 둘이 어긋나는
         경로가 실제로 있었다(아래 dropMyChip 주석). */
      function pileSum(pile){
        var s = 0;
        for (var i = 0; i < pile.list.length; i++) s += pile.list[i].d;
        return s;
      }
      /* 자리에서 빠진 좌석의 기록을 버린다.
         Clear Screen 을 누르면 그 좌석이 st.seats 에서 사라지고, 그러면 아래 syncPile 이
         그 좌석에 대해 아예 돌지 않아 옛 기록이 남는다 — 같은 자리에 다시 올리면 그
         옛 기록이 되살아난다(동전 세 개를 지우고 골드바를 올렸는데 동전이 다시 나왔다). */
      function dropStalePiles(seats){
        var live = {};
        for (var i = 0; i < seats.length; i++) live[seats[i].seat] = 1;
        for (var k in piles) if (!live[k]) delete piles[k];
      }
      function syncPile(s, roundId){
        var el = document.getElementById('bjp-'+s.seat);
        if (!el) return;
        var pile = piles[s.seat];
        if (!pile || pile.round !== roundId) return rebuildPile(el, s.seat, s.bet, s.userId, roundId);
        // 줄었으면(회수) 애니메이션 없이 다시 그린다
        if (s.bet < pile.bet) return rebuildPile(el, s.seat, s.bet, s.userId, roundId);
        /* 화면에 그려진 합이 «우리가 그렸다고 적어 둔 값» 과 다르면 어긋난 것이다.
           한때 여기서 서버 금액(s.bet)과 견줬는데, 그러면 남이 «더» 걸 때마다 이 줄에
           걸렸다 — 그려진 합은 아직 옛 금액이고 서버는 새 금액이니 당연히 다르다.
           그래서 아래 delta 가지(칩을 날리는 자리)에 영영 못 갔고, 남의 베팅은 조용히
           다시 그려지기만 했다. 실측: 100초 동안 남의 금액이 52번 바뀌었는데 날아간
           칩은 0개(정산 회수만 28개).
           이 검사가 물어야 하는 것은 "지금 화면이 내 기록과 맞나" 이지 "서버와 맞나" 가
           아니다. 서버와의 차이는 바로 아래 delta 가 다룬다. */
        if (pileSum(pile) !== pile.bet) return rebuildPile(el, s.seat, s.bet, s.userId, roundId);
        var delta = s.bet - pile.bet;
        if (delta > 0) {
          pile.bet = s.bet;
          // 내 칩은 클릭 즉시(dropMyChip) 올려놨으므로 여기서 또 올리지 않는다
          if (s.userId === MEID) return;
          var added = pushChips(el, pile, decompose(delta), s.userId, 'pending');
          tossFrom(rosterAvatar(s.userId), added);
          betSfx();
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
      var lastBetSfx = 0;
      function cloneAt(chip, rect, cls){
        var c = chip.cloneNode(true);
        c.className = chip.className.replace(/\\b(toss|pending|fly)\\b/g, '').trim() + ' ' + cls;
        /* 동전은 동전이어야 한다. 눌리는 원인이 두 겹이었다.
           (1) 칩이 담긴 자리가 한 축으로 눌려 있으면(가로에서 더미를 줄여 둔다) 그 눌린
               비율이 복제본에 그대로 복사된다 — 긴 변에 맞춰 1:1 로 편다.
           (2) 진짜 원인. .pchip.c-coin 에 min-width:21px 이 박혀 있어서, 인라인으로
               width 를 줄여도 min-width 가 이긴다. 축소된 더미에서 날리면 폭만 21px 로
               버티고 높이는 13px 이 되어 눌린 타원이 된다(실측 55×34, 정사각 아님).
               인라인에서 min- 쪽도 같이 덮어써야 한다.
           막대칩(c-bar)은 원래 직사각형이므로 1:1 로 펴지 않는다. */
        var w = rect.width, h = rect.height;
        if (c.className.indexOf('c-coin') >= 0) { var d = Math.max(w, h); w = d; h = d; }
        c.style.cssText = 'position:fixed;margin:0;left:'+rect.left+'px;top:'+rect.top+'px;' +
          'width:'+w+'px;height:'+h+'px;min-width:'+w+'px;min-height:'+h+'px;';
        getFxLayer().appendChild(c);
        return c;
      }
      function rosterAvatar(uid){
        return rosterEl.querySelector('.rw[data-uid="'+cssEsc(uid)+'"] .rw-av');
      }
      // src 위치에서 chips(제자리에 숨겨둔 원본)로 칩이 날아온다
      function tossFrom(src, chips){
        if (!chips || !chips.length) return;
        /* 출발점이 없으면 예전에는 조용히 건너뛰었다 — 애니메이션만 안 돌고 칩은 그냥
           나타난다. 그런데 남이 걸었을 때의 출발점은 오른쪽 목록의 그 사람 줄인데,
           그 줄이 아직 안 그려진 순간이 흔하다(첫 베팅이면 목록 자체가 비어 있다).
           그래서 남의 베팅에서는 날아오는 모션이 아예 안 보였다(제보).
           그 사람 줄이 없으면 목록 상자 자체에서 날린다. 정확히 그 자리는 아니지만
           저쪽에서 왔다는 것은 맞고, 아무 일도 안 일어나는 것보다 훨씬 낫다. */
        var a = src && src.getBoundingClientRect();
        if (!a || !a.width) {
          var rb = rosterEl && rosterEl.getBoundingClientRect();
          if (rb && rb.width) a = rb;
        }
        if (!a || !a.width) { chips.forEach(function(ch){ ch.classList.remove('pending'); }); return; }
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
        /* 요소나 기록이 없으면 여기서 그릴 수가 없다 — Clear 로 자리가 비면 그 좌석의
           칸이 화면에서 사라지고, 폴링이 돌기 전에 다시 올리면 이 경로로 들어온다.
           조용히 돌아가도 괜찮다: 다음 폴링의 syncPile 이 "그려진 합 ≠ 서버 금액"을 보고
           다시 그린다. 그 안전망이 없을 때는 옛 동전이 되살아났다. */
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
        /* 회수가 «시작될 때» 가 아니라 칩이 도착할 즈음에 한 번 낸다. 홀덤의 팟
           회수음과 같은 소리다 — 세 테이블 게임이 같은 순간에 같은 소리를 낸다.
           승자가 여럿이어도 한 번이다. 소리는 «돈이 옮겨졌다» 를 알리는 것이지
           칩 수를 세어 주는 것이 아니다. */
        if (n && window.casinoSfx && window.casinoSfx.chipWin)
          setTimeout(function(){ casinoSfx.chipWin(); }, 260);
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
          if (window.casinoSfx && window.casinoSfx.chipBet) window.casinoSfx.chipBet();
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
        /* 채팅은 폴을 따로 돌지 않는다 — 응답의 마지막 메시지 id 만 넘겨주면 값이
           늘었을 때만 채팅이 스스로 받아 간다(app.js 의 casinoChat). */
        if (window.casinoChat) casinoChat.note(d.chatMax, d.chatMod);
      }
      /* 탭이 숨겨져 있거나 한참 아무 조작이 없으면 폴링을 멈춘다. 사다리·그래프·포커가
         이미 쓰는 규칙인데 여기만 빠져 있었다 — 백그라운드 탭이 1초마다 계속 요청을
         보내고 있었다. 서버가 이 폴링을 세어 "지금 몇 명이 보고 있나"를 만들므로
         (services/presence.ts) 안 보는 탭이 섞이면 그 숫자도 거짓이 된다. */
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
