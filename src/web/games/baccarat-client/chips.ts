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

      /* ══ 클레이 칩 한 장의 그림 ═══════════════════════════════════════
         칩처럼 보이게 하는 것은 여섯 겹이다 — 바닥 그림자 · 옆면(두께) · 면 ·
         테두리 인레이 톱니 · 메탈릭 인셋 링 · 곡면 반사광. 하나라도 빠지면
         «동그란 색 딱지» 가 된다.

         그림은 문서에 «한 장만» 둔다(<symbol>). 칩마다 그리면 여섯 액면 × 최대
         스무 장이면 같은 도형이 백 벌 넘게 문서에 쌓인다. <use> 로 불러 쓰고,
         색은 CSS 사용자 지정 속성으로 갈아 끼운다 — 그 속성은 <use> 가 만드는
         그림자 트리에도 상속되므로, 액면 클래스(.d1k 등) 하나로 같은 그림이
         다른 색이 된다.

         흐림 효과(filter)는 한 겹도 쓰지 않는다. 정산 때 칩 열댓 장이 동시에
         transform 으로 날아가는데, 흐림이 걸려 있으면 매 프레임 다시 래스터해서
         폰에서 프레임이 떨어진다. 그림자도 «그린» 그림자다(맨 아래 타원).

         면의 명암·링·반사광은 흰색과 검정의 투명도만 쓴다 — 액면과 무관하므로
         여섯 벌이 아니라 한 벌이면 된다. */
      var chipDefsDone = false;
      function ensureChipDefs(){
        if (chipDefsDone || document.getElementById('bcChipDefs')) { chipDefsDone = true; return; }
        chipDefsDone = true;
        var d = document.createElement('div');
        d.innerHTML =
          '<svg id="bcChipDefs" width="0" height="0" aria-hidden="true" focusable="false"' +
          ' style="position:absolute;width:0;height:0;overflow:hidden"><defs>' +
            '<radialGradient id="bcFaceG" cx="50%" cy="24%" r="78%">' +
              '<stop offset="0" stop-color="#fff" stop-opacity=".26"/>' +
              '<stop offset=".46" stop-color="#fff" stop-opacity=".04"/>' +
              '<stop offset="1" stop-color="#000" stop-opacity=".30"/></radialGradient>' +
            '<linearGradient id="bcRingG" x1="0" y1="0" x2="0" y2="1">' +
              '<stop offset="0" stop-color="#fff" stop-opacity=".55"/>' +
              '<stop offset=".5" stop-color="#fff" stop-opacity=".10"/>' +
              '<stop offset="1" stop-color="#fff" stop-opacity=".40"/></linearGradient>' +
            '<radialGradient id="bcGlossG" cx="50%" cy="6%" r="60%">' +
              '<stop offset="0" stop-color="#fff" stop-opacity=".46"/>' +
              '<stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>' +
            '<radialGradient id="bcShadG" cx="50%" cy="50%" r="50%">' +
              '<stop offset="0" stop-color="#000" stop-opacity=".5"/>' +
              '<stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>' +
            '<symbol id="bcChip" viewBox="0 0 48 48">' +
              /* 바닥 그림자 — 칩이 «놓여» 있다는 것은 이 한 겹이 만든다 */
              '<ellipse cx="24" cy="42.5" rx="16" ry="3.8" fill="url(#bcShadG)"/>' +
              /* 옆면(두께) — 면보다 2.6px 아래에 더 어두운 원 */
              '<circle cx="24" cy="24.6" r="19.4" fill="var(--bc-deep,#4b5563)"/>' +
              /* 면 */
              '<circle cx="24" cy="22" r="19.4" fill="var(--bc-face,#9ca3af)"/>' +
              /* 테두리 인레이 — 60도마다 여섯. 실제 칩의 인상은 거의 여기서 나온다 */
              '<g fill="var(--bc-edge,#e5e7eb)">' + bcNotches() + '</g>' +
              /* 면의 명암 (위가 밝고 아래로 어두워진다) */
              '<circle cx="24" cy="22" r="19.4" fill="url(#bcFaceG)"/>' +
              /* 메탈릭 인셋 링 — 밝은 실선 하나와 그 안쪽 어두운 홈 하나 */
              '<circle cx="24" cy="22" r="15.4" fill="none" stroke="url(#bcRingG)" stroke-width="1"/>' +
              '<circle cx="24" cy="22" r="13.9" fill="none" stroke="#000" stroke-opacity=".22" stroke-width=".8"/>' +
              /* 중앙 코어 — 각인이 얹히는 자리 */
              '<circle cx="24" cy="22" r="13.3" fill="var(--bc-face,#9ca3af)"/>' +
              '<circle cx="24" cy="22" r="13.3" fill="url(#bcFaceG)" opacity=".5"/>' +
              /* 테두리 마감 */
              '<circle cx="24" cy="22" r="19" fill="none" stroke="var(--bc-rim,#d1d5db)" stroke-width=".9" opacity=".85"/>' +
              /* 상단 곡면 반사광 */
              '<ellipse cx="24" cy="11" rx="13.5" ry="8" fill="url(#bcGlossG)"/>' +
              /* 최고 액면의 골드 네온 림 — 평소엔 CSS 에서 stroke 가 없어 안 그려진다 */
              '<circle class="bc-neon" cx="24" cy="22" r="20.4" fill="none"/>' +
            '</symbol>' +
          '</defs></svg>';
        document.body.appendChild(d.firstChild);
      }
      function bcNotches(){
        var out = '';
        for (var i = 0; i < 6; i++) {
          out += '<rect x="20" y="3.4" width="8" height="8.4" rx="2"' +
            (i ? ' transform="rotate(' + (i * 60) + ' 24 22)"' : '') + '/>';
        }
        return out;
      }
      /* 루트 <svg> 에 fill/stroke 를 none 으로 못 박는다. 색은 전부 자식이 갖고 있어
         그림에는 영향이 없고, scripts/check-states.ts 의 «아이콘이 배경에 묻혔나»
         검사가 색을 못 읽는 SVG 를 건너뛰므로 헛경고가 나지 않는다. */
      var CHIP_ART = '<svg class="bc-ck" viewBox="0 0 48 48" fill="none" stroke="none"' +
        ' aria-hidden="true" focusable="false"><use href="#bcChip"/></svg>';
      function chipArt(denom){ return CHIP_ART + '<i class="bc-t">' + chipFace(denom) + '</i>'; }

      // anim: '' 없음 · 'pending' 자리만 잡고 숨김(곧 날아올 칩)
      // owner를 심어두면 정산 때 그 칩을 주인 아이콘으로 돌려보낼 수 있다.
      function chipSprite(denom, owner, idx, anim){
        ensureChipDefs();
        /* 다섯 열 · 14px 간격이면 더미 폭이 ±42px 이다. 판을 다섯 구역으로 나눈 뒤로
           플레이어·뱅커의 더미 칸은 상자의 «바깥 절반»(75px 남짓)이라 그 폭이 안 들어가
           맨 왼쪽 칩이 상자 밖으로 잘렸다(제보). 간격과 흔들림을 줄여 ±34px 로 맞춘다.
           열 수는 그대로 둔다 — 줄이면 같은 금액이 더 높이 쌓여 위쪽 글자를 가린다. */
        var col = idx % 5, row = Math.floor(idx / 5);
        var x = (col - 2) * 11 + jit(idx, 5) - 3;
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
          /* 남이 걸 때도 같은 소리를 낸다 — 지금까지는 칩만 날고 조용해서, 옆에서
             판이 커지고 있다는 것이 눈을 그쪽에 두고 있을 때만 전해졌다.
             다만 한 번에 여럿이 걸면 소리가 겹쳐 지저분해지므로 150ms 안에는 한 번만
             낸다. 알리는 것이 목적이지 개수를 세어 주는 것이 아니다. */
          if (Date.now() - lastBetSfx > 150) {
            lastBetSfx = Date.now();
            if (window.casinoSfx && window.casinoSfx.chip) window.casinoSfx.chip();
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
