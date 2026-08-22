/* 포커 플립 화면 — 코인 버튼 · 칩 더미 · 칩 비행 연출.

   브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라 문자열이고,
   poker.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   순서를 바꾸면 안 된다. 나눈 목적은 읽기이고, 산출물은 한 글자도 달라지지 않아야 한다
   (scripts/golden.ts 가 바이트로 확인한다). */
export const PK_CHIPS_JS = `      function renderCoins(){
        coinsEl.innerHTML = (st.coins||[]).map(function(v){
          return '<button type="button" class="coin bcoin bc3d '+buttonKind(v)+' '+denomClass(v)+
            (v===coin?' active':'')+'" data-coin="'+v+'">'+
            '<span class="face">'+chipArt(v)+'</span></button>';
        }).join('');
        coinsEl.querySelectorAll('.coin').forEach(function(b){
          b.addEventListener('click', function(){
            coin = Number(b.getAttribute('data-coin'));
            try { localStorage.setItem('poker_coin', String(coin)); } catch(e){}
            renderCoins();
          });
        });
      }

      /* ── 코인 더미 ─────────────────────────────────────────────
         상자별로 "지금까지 올라온 칩 목록"을 들고 있다가, 늘어난 만큼만 새 스프라이트를
         덧붙여 아래에서 슬라이드해 올라오게 한다. 총액에서 매번 새로 그리면
         애니메이션이 초당 다시 시작되고 쌓이는 느낌이 사라진다.                     */
      var piles={};
      function jit(i, m){ var x=Math.sin(i*12.9898)*43758.5453; return Math.floor((x-Math.floor(x))*m); }
      // anim: '' 없음 · 'drop' 제자리에서 등장 · 'pending' 자리만 잡고 숨김(곧 날아올 칩)
      // owner를 심어두면 정산 때 그 칩을 주인 아이콘으로 돌려보낼 수 있다.
      function chipSprite(denom, owner, idx, anim){
        var col = idx % 5, row = Math.floor(idx / 5);
        var x = (col - 2) * 14 + jit(idx, 9) - 4;
        var y = 3 + row * 5 + jit(idx + 7, 3);
        return '<span class="pchip bc3d '+chipKind(denom)+' '+denomClass(denom)+
          (owner===st.me?' mine':'')+(anim?' '+anim:'')+
          '" data-owner="'+esc(owner)+'"'+
          ' style="left:calc(50% + '+x+'px);bottom:'+y+'px;z-index:'+(10+idx)+'">'+chipArt(denom)+'</span>';
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
          var owner = list[idx[0]].o;   // 바뀐 칩의 주인은 바닥에 있던 그 사람이다
          for (var k=idx.length-1;k>=0;k--) list.splice(idx[k], 1);
          list.unshift({ d: big, o: owner });   // 바뀐 큰 칩은 맨 아래에 깔린다
          return true;
        }
        return false;
      }
      function compressPile(pile){
        var guard = 0;
        while (pile.list.length > MAX_CHIPS && colorUpOnce(pile.list) && ++guard < 400) {}
        while (pile.list.length > MAX_CHIPS) pile.list.shift();
      }
      /* 목록 그대로 다시 그린다. pendFrom 이 있으면 그 뒤의 칩을 제자리에 숨긴 채
         그리고, 그 요소들을 돌려준다 — 부르는 쪽이 그 자리로 날린 뒤 드러낸다. */
      /* 비어 가는 더미를 한 박자 쓸어 낸다. 참이면 «지우는 중» 이므로 부르는 쪽은
         그대로 돌아가면 된다 — 300ms 뒤에 스스로 비운다. */
      function sweepPile(el){
        if (!el.childElementCount || el.classList.contains('pile-sweep')) return false;
        el.classList.add('pile-sweep');
        setTimeout(function(){
          if (!el.classList.contains('pile-sweep')) return;   // 그새 새 칩이 올라왔다
          el.classList.remove('pile-sweep');
          el.innerHTML = '';
        }, 300);
        return true;
      }
      function paintPile(el, pile, pendFrom){
        el.style.opacity = '';   // 회수 연출로 숨겨뒀던 더미를 되살린다
        el.classList.remove('pile-sweep');
        el.innerHTML = '';
        for (var i=0;i<pile.list.length;i++){
          var c = pile.list[i];
          el.insertAdjacentHTML('beforeend',
            chipSprite(c.d, c.o, i, (pendFrom != null && i >= pendFrom) ? 'pending' : ''));
        }
      }
      function pushChips(el, pile, denoms, owner, anim){
        if (!denoms.length) return [];
        for (var i=0;i<denoms.length;i++) pile.list.push({ d: denoms[i], o: owner });
        compressPile(pile);
        var from = pile.list.length - denoms.length;
        if (from < 0) from = 0;
        paintPile(el, pile, anim === 'pending' ? from : null);
        return anim === 'pending' ? [].slice.call(el.querySelectorAll('.pchip.pending')) : [];
      }
      // 더미 상태는 "누가 얼마" 단위로 들고 있어야 새로 들어온 칩의 주인을 알 수 있다
      function rebuildPile(el, market, byUser, roundId){
        var pile = piles[market] = { round: roundId, byUser: {}, list: [], n: 0 };
        /* 걸린 것이 하나도 없으면 «비우는 중» 이다 — 초기화를 눌렀거나 판이 넘어갔다.
           그때만 쓸어 내는 연출로 간다(칩이 있는데 다시 그리는 경우와 구분된다). */
        var empty = Object.keys(byUser).every(function(u){ return !byUser[u]; });
        if (empty && sweepPile(el)) return;
        el.style.opacity = '';   // 회수 연출로 숨겨뒀던 더미를 되살린다
        el.classList.remove('pile-sweep');
        el.innerHTML = '';
        Object.keys(byUser).forEach(function(uid){
          pile.byUser[uid] = byUser[uid];
          pushChips(el, pile, decompose(byUser[uid]), uid, '');
        });
      }
      function syncPile(market, byUser, roundId){
        var el = document.getElementById('pile-'+market);
        if (!el) return;
        var pile = piles[market];
        if (!pile || pile.round !== roundId) return rebuildPile(el, market, byUser, roundId);
        /* 골격이 다시 그려져 칸이 비었으면 «목록 기준» 으로 복원한다.
           총액을 다시 쪼개면 500 두 개가 1000 한 개로 합쳐져 «올린 그대로» 가 아니다. */
        if (el.childElementCount !== pile.list.length) paintPile(el, pile);

        // 누구든 금액이 줄었으면(회수/Clear Screen) 애니메이션 없이 다시 그린다
        var uids = Object.keys(pile.byUser);
        for (var i=0;i<uids.length;i++){
          if ((byUser[uids[i]]||0) < pile.byUser[uids[i]]) return rebuildPile(el, market, byUser, roundId);
        }
        // 늘어난 사람만큼 그 사람 아이콘에서 칩이 날아온다
        Object.keys(byUser).forEach(function(uid){
          var delta = byUser[uid] - (pile.byUser[uid]||0);
          if (delta <= 0) return;
          pile.byUser[uid] = byUser[uid];
          // 내 칩은 이미 클릭 즉시(dropMyChip) 올려놨으므로 여기서 또 올리지 않는다
          if (uid === st.me) return;
          var added = pushChips(el, pile, decompose(delta), uid, 'pending');
          tossFrom(rosterAvatar(uid), added);
          /* 남이 걸 때도 같은 소리를 낸다 — 지금까지는 칩만 날고 조용해서, 옆에서
             판이 커지고 있다는 것이 눈을 그쪽에 두고 있을 때만 전해졌다.
             다만 한 번에 여럿이 걸면 소리가 겹쳐 지저분해지므로 150ms 안에는 한 번만
             낸다. 알리는 것이 목적이지 개수를 세어 주는 것이 아니다. */
          if (Date.now() - lastBetSfx > 150) {
            lastBetSfx = Date.now();
            if (window.casinoSfx && window.casinoSfx.chipBet) window.casinoSfx.chipBet();
          }
        });
      }
      // 칩이 상자 밖을 지나는 구간은 .market의 overflow:hidden에 잘려 보이지 않으므로,
      // 날아가는 연출은 전부 화면 전체를 덮는 이 레이어 위에서 한다.
      var fxLayer = null;
      function getFxLayer(){
        if (!fxLayer || !fxLayer.parentNode) {
          fxLayer = document.createElement('div');
          fxLayer.className = 'chip-fly-layer';
          document.body.appendChild(fxLayer);
        }
        return fxLayer;
      }
      // 제자리(rect)에 놓인 복제본을 만들어 레이어에 올린다
      var lastBetSfx = 0;
      function cloneAt(chip, rect, cls){
        var c = chip.cloneNode(true);
        c.className = chip.className.replace(/\\b(drop|toss|pending|fly)\\b/g, '').trim() + ' ' + cls;
        /* 동전은 동전이어야 한다 — 자세한 이유는 blackjack-client/chips.ts 의 같은 자리. */
        var w = rect.width, h = rect.height;
        if (c.className.indexOf('c-coin') >= 0) { var d = Math.max(w, h); w = d; h = d; }
        c.style.cssText = 'position:fixed;margin:0;left:' + rect.left + 'px;top:' + rect.top + 'px;' +
          'width:' + w + 'px;height:' + h + 'px;min-width:' + w + 'px;min-height:' + h + 'px;';
        getFxLayer().appendChild(c);
        return c;
      }

      // 우측 참가자 패널에서 그 사람의 아바타 요소를 찾는다 (칩의 출발지·도착지)
      function rosterAvatar(uid){
        return rosterEl.querySelector('.rw[data-uid="'+cssEsc(uid)+'"] .rw-av');
      }
      function cssEsc(s){ return String(s).replace(/["\\\\]/g, '\\\\$&'); }

      // src 요소 위치에서 chips(제자리에 숨겨둔 원본)로 칩이 날아오게 한다
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
      // 방금 누른 코인 버튼의 실제 화면 위치에서 출발해 상자 안 제자리로 날아온다.
      function dropMyChip(market, denom){
        var el = document.getElementById('pile-'+market), pile = piles[market];
        if (!el || !pile) return;
        var added = pushChips(el, pile, [denom], st.me, 'pending');
        pile.byUser[st.me] = (pile.byUser[st.me]||0) + denom;
        tossFrom(coinsEl.querySelector('.coin[data-coin="'+denom+'"] .face'), added);
      }

      // 적중한 상자의 칩을 화면 아래 중앙(코인 버튼 줄)으로 빨아들이는 연출.
      // 원본 더미는 감추고 복제본을 최상위 레이어에 띄워 날린다.
      // 돈이 나온 상자의 칩을 각자 주인 아이콘으로 돌려보낸다.
      // 주인을 못 찾으면(패널에 없는 경우) 코인 버튼 줄로 보낸다.
      function flyChipsToPot(markets){
        // 내 당첨금은 화면 중앙 하단(칩 바)으로 빨려들어오고,
        // 다른 사람 것은 각자 오른쪽 참가자 목록의 아이콘으로 돌아간다.
        var controls = document.querySelector('.poker-controls');
        var myTarget = (controls || coinsEl).getBoundingClientRect();
        var sent = [], n = 0;

        markets.forEach(function(m){
          var pile = document.getElementById('pile-' + m);
          if (!pile) return;
          Array.prototype.forEach.call(pile.querySelectorAll('.pchip'), function(ch){
            var r = ch.getBoundingClientRect();
            if (!r.width) return;
            var t;
            if (ch.classList.contains('mine')) {
              t = myTarget;
            } else {
              var av = rosterAvatar(ch.getAttribute('data-owner') || '');
              t = (av && av.getBoundingClientRect().width) ? av.getBoundingClientRect() : myTarget;
            }
            var c = cloneAt(ch, r, 'fly');
            c.style.setProperty('--tx', Math.round((t.left + t.width/2) - (r.left + r.width/2)) + 'px');
            c.style.setProperty('--ty', Math.round((t.top + t.height/2) - (r.top + r.height/2)) + 'px');
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
        setTimeout(function(){
          sent.forEach(function(c){ if (c.parentNode) c.parentNode.removeChild(c); });
        }, 900 + n * 40);
      }

      // 이번 라운드에 돈이 나온 시장 목록 (무승부면 승자 시장 둘 다 원금 환불)
      function payingMarkets(res){
        var out = res.winner === 'tie' ? ['master','shark'] : [res.winner];
        (res.buckets||[]).forEach(function(i){ out.push('b'+i); });
        return out;
      }

`;
