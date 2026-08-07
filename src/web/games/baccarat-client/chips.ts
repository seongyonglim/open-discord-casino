/* 바카라 화면 — 코인 더미 · 칩 비행 연출.

   브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라 문자열이고,
   baccarat.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   순서를 바꾸면 안 된다. 나눈 목적은 읽기이고, 산출물은 한 글자도 달라지지 않아야 한다
   (scripts/golden.ts 가 바이트로 확인한다). */
export const BC_CHIPS_JS = `         상자별로 "지금까지 올라온 칩 목록"을 들고 있다가, 늘어난 만큼만 새 스프라이트를
         덧붙인다. 총액에서 매번 새로 그리면 애니메이션이 초당 다시 시작되고
         쌓이는 느낌이 사라진다. (포커 플립과 같은 방식)                            */
      var piles={};
      function jit(i, m){ var x=Math.sin(i*12.9898)*43758.5453; return Math.floor((x-Math.floor(x))*m); }
      // anim: '' 없음 · 'pending' 자리만 잡고 숨김(곧 날아올 칩)
      // owner를 심어두면 정산 때 그 칩을 주인 아이콘으로 돌려보낼 수 있다.
      function chipSprite(denom, owner, idx, anim){
        var col = idx % 5, row = Math.floor(idx / 5);
        var x = (col - 2) * 14 + jit(idx, 9) - 4;
        var y = 3 + row * 5 + jit(idx + 7, 3);
        return '<span class="pchip '+chipKind(denom)+(owner===st.me?' mine':'')+(anim?' '+anim:'')+
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
          pile.list.push(denoms[i]);
          el.insertAdjacentHTML('beforeend', chipSprite(denoms[i], owner, pile.n++ % MAX_CHIPS, anim));
          added.push(el.lastElementChild);
        }
        return added;
      }
      function rebuildPile(el, market, byUser, roundId){
        var pile = piles[market] = { round: roundId, byUser: {}, list: [], n: 0 };
        el.style.opacity = '';   // 회수 연출로 숨겨뒀던 더미를 되살린다
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
      function cloneAt(chip, rect, cls){
        var c = chip.cloneNode(true);
        c.className = chip.className.replace(/\\b(drop|toss|pending|fly)\\b/g, '').trim() + ' ' + cls;
        c.style.cssText = 'position:fixed;margin:0;left:' + rect.left + 'px;top:' + rect.top + 'px;' +
          'width:' + rect.width + 'px;height:' + rect.height + 'px;';
        getFxLayer().appendChild(c);
        return c;
      }
      // 우측 참가자 패널에서 그 사람의 아바타 요소를 찾는다 (칩의 출발지·도착지)
      function rosterAvatar(uid){
        return rosterEl.querySelector('.rw[data-uid="'+cssEsc(uid)+'"] .rw-av');
      }
      // src 요소 위치에서 chips(제자리에 숨겨둔 원본)로 칩이 날아오게 한다
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
      // 방금 누른 코인 버튼의 실제 화면 위치에서 출발해 상자 안 제자리로 날아온다.
      function dropMyChip(market, denom){
        var el = document.getElementById('pile-'+market), pile = piles[market];
        if (!el || !pile) return;
        var added = pushChips(el, pile, [denom], st.me, 'pending');
        pile.byUser[st.me] = (pile.byUser[st.me]||0) + denom;
        tossFrom(coinsEl.querySelector('.coin[data-coin="'+denom+'"] .face'), added);
      }
      // 돈이 나온 상자의 칩을 각자 주인에게 돌려보낸다.
      // 내 것은 화면 아래 중앙(칩 바)으로 빨려들어오고, 남의 것은 오른쪽 참가자 아이콘으로 간다.
      function flyChipsToPot(markets){
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
            if (ch.classList.contains('mine')) t = myTarget;
            else {
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
        if (!n) return;
        setTimeout(function(){
          sent.forEach(function(c){ if (c.parentNode) c.parentNode.removeChild(c); });
        }, 900 + n * 40);
      }
      // 돈이 나온 상자 — 무승부면 플레이어·뱅커도 원금이 돌아가므로 함께 회수한다
      function payingMarkets(res){
        var out = res.winner === 'tie' ? ['player','banker','tie'] : [res.winner];
        if (res.playerPair) out.push('ppair');
        if (res.bankerPair) out.push('bpair');
        return out;
      }

`;
