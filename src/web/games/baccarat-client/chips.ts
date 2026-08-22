/* 바카라 화면 — 코인 더미 · 칩 비행 연출.

   브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라 문자열이고,
   baccarat.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   순서를 바꾸면 안 된다. 나눈 목적은 읽기이고, 산출물은 한 글자도 달라지지 않아야 한다
   (scripts/golden.ts 가 바이트로 확인한다). */
export const BC_CHIPS_JS = `         상자별로 "지금까지 올라온 칩 목록"을 들고 있다가, 늘어난 만큼만 새 스프라이트를
         덧붙인다. 총액에서 매번 새로 그리면 애니메이션이 초당 다시 시작되고
         쌓이는 느낌이 사라진다. (포커 플립과 같은 방식)                            */
      var towers={};
      var TOWER_CHIP = 34;   // 07-bacc.css 의 .bc-tower .pchip 지름과 같아야 한다
      function jit(i, m){ var x=Math.sin(i*12.9898)*43758.5453; return Math.floor((x-Math.floor(x))*m); }

      /* 칩 그림은 app.js 의 casinoChip 이 갖고 있다 — 테이블 게임 셋이 같은 것을
         쓰므로 여기 한 벌 더 두면 언젠가 세 벌이 어긋난다. 여기서는 부르기만 한다. */
      function ensureChipDefs(){ if (window.casinoChip) casinoChip.ensure(); }
      function denomClass(v){ return window.casinoChip ? casinoChip.cls(v) : 'd10k'; }
      function chipArt(denom){ return window.casinoChip ? casinoChip.art(denom) : String(denom); }

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
      /* ══ 구역마다 «칩 타워 하나» ══════════════════════════════════════
         한동안 사람마다 자기 칩이 따로 쌓였다. 스무 명이 걸면 스무 무더기가 한 상자
         안에서 겹치고, 어느 것이 누구 것인지도 안 보이면서 판만 어지러웠다(제보).
         실제 테이블에서 베팅 구역에 놓이는 것은 «그 구역에 걸린 돈» 한 무더기다.

         그래서 구역마다 타워 하나만 세운다. 총액을 큰 액면부터 그리디로 쪼개
         최대 세 장까지 쌓는다.

         세 장으로는 임의의 총액을 «정확히» 표현할 수 없다(12,340P 를 세 장으로
         나눌 수 없다). 나눌 필요도 없다 — 정확한 숫자는 바로 아래 .m-total 이 매
         폴링마다 적고 있다. 타워가 말하는 것은 «규모» 다. 역할을 나눠 둔다.

         사람별 칩이 사라지면서 잃는 것이 둘 있는데 둘 다 되살린다.
           · «내가 여기 걸었다» → 타워 밑동의 금색 광(.bc-tower.mine)
           · «남이 방금 걸었다» → 그 사람 아이콘에서 유령 칩 한 장이 날아와
             타워에 흡수된다. 타워에 남지 않고 도착과 함께 사라지므로 타워는 늘
             세 장 이하다. */
      /* ── 누른 칩이 «그대로» 쌓인다 ────────────────────────────────────
         금액을 큰 액면으로 합쳐서 그렸더니 열 번을 눌러도 기둥이 안 자랐다. 1000 을
         열 번 누르면 10K 한 장이 되니 화면상 아무 일도 안 일어난 것과 같다.
         그래서 누른 칩을 그대로 한 장씩 얹는다 — 누를 때마다 기둥이 실제로 한 칸씩
         높아지는 것이 이 게임의 손맛이다.

         다만 «남이 누른 순서» 는 알 수 없다. 서버는 사람·구역마다 한 줄에 금액을
         더해서 저장하지(bacc.ts 의 ON CONFLICT … amount + excluded.amount) 클릭을
         한 건씩 남기지 않는다. 그것을 남기려면 표를 하나 더 만들어야 하는데, 화면에
         보이는 결과는 거의 같다 — 그래서 남의 몫은 금액을 큰 액면부터 쪼개 쌓는다.
         내 클릭만 누른 그대로 간다. 손맛이 필요한 쪽은 내 손이다.

         칩이 예순 장을 넘어가면 그때만 상위 액면으로 «승격» 시킨다(color-up).
         실제 딜러가 판이 커지면 잔칩을 큰 칩으로 바꿔 주는 것과 같고, 그 위로는
         기둥이 판을 가리고 그리는 값도 비싸진다. */
      /* ── 칩은 «가로로» 펼쳐진다 ────────────────────────────────────
         한동안 기둥으로 세웠다. 그러면 맨 위 한 장만 얼굴이 보이고 나머지는 테두리만
         남아서, 무슨 액면이 몇 장 걸렸는지가 색으로 안 읽힌다.
         포커 플립과 블랙잭은 처음부터 가로로 펼쳐 놓고 있었고 그쪽이 훨씬 시원하다 —
         셋을 같은 것으로 맞춘다(요청).
         한 줄에 다섯 장, 14px 씩 겹치며 나아간다(칩 지름 26px 이므로 12px 이 겹친다 —
         얼굴 절반이 남는다). 다섯이 차면 5px 위에 다음 줄이 얹힌다. */
      var FAN_COLS = 5, FAN_PITCH = 14, FAN_RISE = 5;
      /* 한 줄에 다섯 장씩 여덟 줄 = 마흔 장(요청: 기둥당 여덟 장).
         이보다 많아지면 바닥부터 큰 칩으로 바꾼다 — 버리지 않는다. */
      var CHIP_LIMIT = 40;
      // 금액을 큰 액면부터 그리디로 쪼갠다
      function splitAmount(amount){
        var d=(st.coins||[]).slice().sort(function(a,b){return b-a;}), out=[];
        for (var i=0;i<d.length && out.length<CHIP_LIMIT*2;i++){
          while (amount >= d[i] && out.length < CHIP_LIMIT*2) { out.push(d[i]); amount -= d[i]; }
        }
        return out;
      }
      /* 구역마다 «올라온 칩» 을 올라온 순서대로. 사람 구분 없이 한 목록이다.
         (블랙잭의 pile.list 와 같은 물건이다.)

         이것은 화면이 아니라 «자료» 다 — 골격(.market)이 다시 그려질 때 같이 버리면
         안 된다. 베팅이 닫히는 순간 단계가 바뀌면서 골격이 새로 그려지는데, 그때
         이 목록을 비웠더니 누른 칩들이 서버 금액으로 다시 합쳐져서 «분명 안 합쳐져
         있었는데 갑자기 합쳐진다» 가 됐다(제보). 라운드가 바뀔 때만 버린다.

         사람별로 나눠 두지 않고 «한 줄» 로 두는 이유가 하나 더 있다. 새로 올라온 칩이
         언제나 목록의 «끝» 에 있어야, 판을 다시 그린 뒤 그 칩들만 골라 날릴 수 있다.
         사람별로 다시 쪼개면 남이 걸 때마다 그 사람 몫이 목록 «가운데» 에서 통째로
         바뀌어서, 무엇이 새 것인지 알 수 없다. */
      var raw = {}, rawRound = null;
      /* ── 꽉 차면 «맨 밑에서부터» 큰 칩으로 바꾼다 ──────────────────────
         한동안은 쉰 장을 넘는 순간 총액을 통째로 다시 쪼갰다. 그러면 열 몇 장씩
         쌓여 있던 다섯 기둥이 한 기둥으로 폭삭 주저앉는다 — 돈은 늘었는데 판이
         작아지는, 앞뒤가 안 맞는 그림이었다(제보).

         실제 딜러가 하는 일은 다르다. 판이 커지면 «바닥의 잔칩을 큰 칩 한 장으로
         바꿔» 준다(color-up). 자리는 그대로 다섯 기둥이고, 대신 바닥부터 색이
         고급 쪽으로 물들어 간다. 그것을 그대로 옮긴다.

         한 번에 한 뭉치만 바꾼다 — 가장 낮은 액면 중 아래쪽 것들을 그 위 액면
         한 장으로. 금액은 정확히 보존된다(코인 단위가 모두 위 단위의 약수라
         나누어떨어진다: 10×10=100 · 5×100=500 · 2×500=1000 · 5×1000=5000 ·
         2×5000=10000). 바꿀 것이 없으면(전부 최고 액면이면) 그때는 위쪽부터
         자른다 — 정확한 숫자는 상자 아래 총액이 계속 말한다. */
      function colorUpOnce(list){
        var d = (st.coins||[]).slice().sort(function(a,b){ return a-b; });
        for (var i=0;i<d.length-1;i++){
          var small = d[i], big = d[i+1], need = big / small;
          if (need !== Math.floor(need) || need < 2) continue;
          var idx = [];
          for (var j=0;j<list.length && idx.length<need;j++) if (list[j] === small) idx.push(j);
          if (idx.length < need) continue;
          for (var k=idx.length-1;k>=0;k--) list.splice(idx[k], 1);
          list.unshift(big);          // 바뀐 큰 칩은 맨 아래에 깔린다
          return true;
        }
        return false;
      }
      function compressRaw(market){
        var list = raw[market], guard = 0;
        while (list.length > CHIP_LIMIT && colorUpOnce(list) && ++guard < 400) {}
        // 바꿀 것이 없으면(전부 최고 액면이면) 오래된 쪽을 자른다 — 방금 올라온 것이 남는다
        if (list.length > CHIP_LIMIT) raw[market] = list.slice(list.length - CHIP_LIMIT);
      }
      // 서버 금액에서 목록을 통째로 다시 세운다 (회수했거나 판에 처음 들어왔을 때)
      function rebuildRaw(market, byUser){
        var out = [];
        Object.keys(byUser).forEach(function(uid){ out = out.concat(splitAmount(byUser[uid])); });
        raw[market] = out;
        compressRaw(market);
      }
      // 금액 하나를 대표하는 칩 한 장 — 유령 칩과 버스트 칩이 쓴다
      function bestDenom(amount){
        var d=(st.coins||[]).slice().sort(function(a,b){return b-a;});
        for (var i=0;i<d.length;i++) if (amount >= d[i]) return d[i];
        return d[d.length-1];
      }
      /* 부채는 «판 바깥» 에서 시작해 안쪽으로 편다 — 플레이어는 왼쪽 끝에서
         오른쪽으로, 뱅커는 오른쪽 끝에서 왼쪽으로. 그래야 쉰 장이 다 깔려도 가운데
         타이 돔 쪽으로 자랄 자리가 구조적으로 없다.
         타이와 페어는 좌우가 좁으므로 가운데에서 펼친다. */
      function chipX(market, x){
        if (market === 'player') return 'left:calc(0% + ' + (20 + x) + 'px)';
        if (market === 'banker') return 'left:calc(100% - ' + (20 + x) + 'px)';
        return 'left:calc(50% + ' + (x - (FAN_COLS - 1) * FAN_PITCH / 2) + 'px)';
      }
      /* 밑동에 깔던 타원(내 베팅 표시 · 큰 판 표시)과 칩 위 총액 뱃지는 둘 다 걷었다.
         타원은 혼자 엉뚱한 자리에 떠 있었고, 뱃지는 같은 숫자가 상자 아래 .m-total 에
         이미 크게 적혀 있었다(둘 다 제보). 칩은 이제 제 그림만으로 선다. */
      /* pendFrom 이 있으면 그 인덱스부터의 칩을 «제자리에 숨긴 채» 그리고,
         그 요소들을 돌려준다 — 부르는 쪽이 그 자리로 칩을 날린 뒤 드러낸다. */
      function paintTower(el, market, ds, total, pendFrom){
        if (!ds.length) { el.innerHTML = ''; return null; }
        var html = '';
        for (var i=0;i<ds.length;i++){
          var col = i % FAN_COLS, row = Math.floor(i / FAN_COLS);
          /* 흔들림을 조금 준다 — 자로 잰 듯 정렬하면 «놓인 칩» 이 아니라 «찍힌 무늬»
             로 보인다. 포커 플립·블랙잭이 같은 이유로 같은 jit 를 쓴다. */
          var x = col * FAN_PITCH + jit(i, 5) - 2;
          var y = 2 + row * FAN_RISE + jit(i + 7, 3);
          html += '<span class="pchip bc3d c-coin ' + denomClass(ds[i]) +
            (pendFrom != null && i >= pendFrom ? ' pending' : '') +
            '" style="' + chipX(market, x) + ';bottom:' + y + 'px;z-index:' + (10 + i) + '">' +
            chipArt(ds[i]) + '</span>';
        }
        el.innerHTML = '<span class="bc-tower">' + html + '</span>';
        if (pendFrom == null) return null;
        return [].slice.call(el.querySelectorAll('.pchip.pending'));
      }
      function syncTower(market, byUser, roundId){
        var el = document.getElementById('pile-'+market);
        if (!el) return;
        ensureChipDefs();
        var total = 0, uids = Object.keys(byUser);
        for (var i=0;i<uids.length;i++) total += byUser[uids[i]];
        var t = towers[market];
        var fresh = !t || t.round !== roundId;
        if (rawRound !== roundId) { raw = {}; rawRound = roundId; }
        if (fresh) t = towers[market] = { round: roundId, sig: null, byUser: {} };
        if (!raw[market]) rebuildRaw(market, byUser);

        /* 누구든 금액이 «줄었으면»(회수·Clear) 목록을 서버 값으로 다시 세운다.
           늘어난 쪽만 덧붙이면 회수한 칩이 화면에 남는다. */
        var shrank = false;
        Object.keys(t.byUser).forEach(function(uid){
          if ((byUser[uid]||0) < t.byUser[uid]) shrank = true;
        });
        var added = [];   // 이번에 새로 올라온 칩 — [{uid, n}] 순서대로
        if (shrank) rebuildRaw(market, byUser);
        else if (!fresh) {
          uids.forEach(function(uid){
            var delta = byUser[uid] - (t.byUser[uid]||0);
            if (delta <= 0 || uid === st.me) return;   // 내 것은 dropMyChip 이 이미 얹었다
            var ds2 = splitAmount(delta);
            if (!ds2.length) return;
            raw[market] = raw[market].concat(ds2);
            added.push({ uid: uid, n: ds2.length });
            /* 남이 걸 때도 같은 소리를 낸다 — 칩만 날고 조용하면 판이 커지고 있다는
               것이 눈을 그쪽에 두고 있을 때만 전해진다. 다만 한 번에 여럿이 걸면
               소리가 겹쳐 지저분하므로 150ms 안에는 한 번만 낸다. */
            if (Date.now() - lastBetSfx > 150) {
              lastBetSfx = Date.now();
              if (window.casinoSfx && window.casinoSfx.chipBet) window.casinoSfx.chipBet();
            }
          });
          if (added.length) compressRaw(market);
        }
        t.byUser = {};
        uids.forEach(function(uid){ t.byUser[uid] = byUser[uid]; });

        /* 내 몫이 서버와 어긋나면 맞춘다 — 다른 창에서 걸었거나 폴이 내 클릭보다
           먼저 온 경우다. 목록 전체를 다시 세우지 않고 «차이만» 덧붙인다.
           통째로 다시 세우면 클릭 직후의 폴이 내 순서를 지운다. */
        var mineAmt = byUser[st.me] || 0, listSum = 0;
        raw[market].forEach(function(v){ listSum += v; });
        if (!shrank && listSum < total) {
          var lack = splitAmount(total - listSum);
          if (lack.length) { raw[market] = raw[market].concat(lack); compressRaw(market); }
        }

        // 쌓인 모양이 그대로면 다시 그리지 않는다 — 매초 새로 그리면 쌓인 느낌이 사라진다
        var ds = raw[market];
        var sig = total + '|' + ds.join(',');
        if (t.sig === sig && !added.length) return;
        t.sig = sig;
        el.style.opacity = '';
        /* 새로 올라온 칩은 «제자리에» 숨겨 두고(pending) 그 자리로 날린다.
           예전에는 화면 위 한 점으로 날린 뒤 판을 다시 그렸는데, 다시 그린 자리가
           날아간 자리와 달라서 칩이 도착하자마자 한 번 튀었다(제보).
           블랙잭·포커 플립이 처음부터 이 방식이다 — 그쪽에서 가져왔다. */
        var pendN = 0;
        added.forEach(function(x){ pendN += x.n; });
        var pend = paintTower(el, market, ds, total,
          pendN ? Math.max(0, ds.length - pendN) : null);
        if (pend && pend.length) {
          var at = 0;
          added.forEach(function(x){
            tossFrom(rosterAvatar(x.uid), pend.slice(at, at + x.n));
            at += x.n;
          });
        }
      }
      // 칩이 상자 밖을 지나는 구간은 .market의 overflow:hidden에 잘려 보이지 않으므로,
      // 날아가는 연출은 전부 화면 전체를 덮는 이 레이어 위에서 한다.
      // (버스트도 마찬가지다 — 타워 자리에서 사방으로 튀어야 하는데 상자가 그것을 자른다)
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
      /* 화면 좌표 하나를 만든다. 액면 칩을 그 자리에 띄우는 데 쓰는 공통 뼈대 —
         유령 칩과 버스트 칩이 같은 함수를 쓴다.
         min-width/min-height 를 함께 박는 것이 중요하다: .pchip.c-coin 에 min-width
         가 걸려 있어서 폭만 지정하면 복제본이 한 축으로 눌려 타원으로 날아간다
         (scripts/audit-pages.ts 가 이 두 문자열이 여기 있는지 검사한다). */
      function chipNode(denom, owner, d, left, top, cls){
        var c = document.createElement('span');
        c.className = 'pchip bc3d c-coin ' + denomClass(denom) + (cls ? ' ' + cls : '');
        c.setAttribute('data-owner', esc(owner || ''));
        c.style.cssText = 'position:fixed;margin:0;left:' + left + 'px;top:' + top + 'px;' +
          'width:' + d + 'px;height:' + d + 'px;min-width:' + d + 'px;min-height:' + d + 'px;';
        c.innerHTML = chipArt(denom);
        return c;
      }
      // 우측 참가자 패널에서 그 사람의 아바타 요소를 찾는다 (칩의 출발지·도착지)
      function rosterAvatar(uid){
        return rosterEl.querySelector('.rw[data-uid="'+cssEsc(uid)+'"] .rw-av');
      }
      /* 내 클릭은 폴링을 기다리지 않고 즉시 반영한다 — 타워를 그 자리에서 다시
         세우고, 방금 누른 코인 버튼에서 유령 칩 한 장을 날린다. */
      /* ── 이미 «제자리에» 놓인 칩을 그 자리로 날린다 ─────────────────
         원본은 pending 으로 숨겨 두고, 화면 전체 레이어에 복제본을 띄워 출발점에서
         제자리까지 당겨 온다. 도착하면 복제본을 지우고 원본을 드러낸다 — 그래서 칩이
         «도착한 그 자리에» 남는다.
         예전에는 화면 위 한 점으로 날린 뒤 판을 다시 그렸다. 다시 그린 자리가 날아간
         자리와 달라서 칩이 도착하자마자 한 번 튀었다(제보: 일정 점으로 날아갔다가
         배치가 바뀌어 어색하다). 블랙잭·포커 플립이 처음부터 이 방식이고, 그쪽에서
         그대로 가져왔다. */
      function cloneAt(chip, rect, cls){
        var c = chip.cloneNode(true);
        c.className = chip.className.replace(/\\b(drop|toss|pending|fly)\\b/g, '').trim() + ' ' + cls;
        /* 동전은 동전이어야 한다 — 폭만 주면 .pchip.c-coin 의 min-width 가 남아
           복제본이 한 축으로 눌려 타원으로 날아간다. 둘을 함께 박는다
           (scripts/audit-pages.ts 가 이 두 문자열이 여기 있는지 검사한다). */
        var w = rect.width, h = rect.height;
        if (c.className.indexOf('c-coin') >= 0) { var d = Math.max(w, h); w = d; h = d; }
        c.style.cssText = 'position:fixed;margin:0;left:' + rect.left + 'px;top:' + rect.top + 'px;' +
          'width:' + w + 'px;height:' + h + 'px;min-width:' + w + 'px;min-height:' + h + 'px;';
        getFxLayer().appendChild(c);
        return c;
      }
      function tossFrom(src, chips){
        if (!chips || !chips.length) return;
        /* 출발점이 없으면 그냥 드러낸다. 남이 걸었을 때의 출발점은 오른쪽 목록의 그
           사람 줄인데, 그 줄이 아직 안 그려진 순간이 흔하다(첫 베팅이면 목록 자체가
           비어 있다). 그때는 목록 상자에서 날린다 — 정확히 그 자리는 아니지만
           저쪽에서 왔다는 것은 맞고, 아무 일도 안 일어나는 것보다 낫다. */
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
      function dropMyChip(market, denom){
        var el = document.getElementById('pile-'+market), t = towers[market];
        if (!el || !t) return;
        t.byUser[st.me] = (t.byUser[st.me]||0) + denom;
        if (!raw[market]) raw[market] = [];
        raw[market].push(denom);
        compressRaw(market);
        var total = 0;
        Object.keys(t.byUser).forEach(function(u){ total += t.byUser[u]; });
        var ds = raw[market];
        t.sig = total + '|' + ds.join(',');
        // 방금 누른 한 장만 숨긴 채 그리고, 코인 버튼에서 그 자리로 날린다
        var pend = paintTower(el, market, ds, total, Math.max(0, ds.length - 1));
        tossFrom(coinsEl.querySelector('.coin[data-coin="'+denom+'"] .face'), pend);
        // 얹힌 것이 손에 느껴지게 판이 아주 살짝 부푼다
        var tw = el.querySelector('.bc-tower');
        if (tw) { tw.classList.add('bc-pop'); }
      }
      /* ══ 승리 윤곽선은 «한 줄» 이다 ═══════════════════════════════════
         CSS 테두리로는 끝까지 안 됐다. 이긴 상자의 테두리를 켜면 가운데 돔이 그 위에
         얹혀 있어서 선이 돔에 닿는 자리에서 끊기고, 돔의 «맞닿는 쪽» 테두리를 같이
         켜면 이번엔 둥근 모서리가 반만 물든다(모서리에서 두 면의 색이 대각선으로
         갈리기 때문이다). 마스크로 절반을 잘라 덧그리는 데까지 갔지만, 그것도 «두
         조각을 이어 붙인 것» 이지 한 줄이 아니다.

         선 하나로 그리려면 선을 «상자» 가 아니라 «길» 로 다뤄야 한다. 판 위에 투명한
         SVG 를 한 장 얹고, 이긴 구역의 바깥을 도는 폐곡선을 path 하나로 그린다.
         돔의 곡면도 그 길의 일부다 — 이으려고 애쓸 필요 없이 처음부터 한 줄이다.

         자리는 «재서» 쓴다. 판 크기와 돔 자리가 화면마다 달라지므로 값을 박아 두면
         선이 어긋난다. viewBox 를 잰 픽셀 크기 그대로 두면 배율이 1 이라 아크도
         선 두께도 찌그러지지 않는다(preserveAspectRatio 는 그래서 none 이다).
         non-scaling-stroke 는 그래도 남긴다 — 재기 전 한 프레임의 보험이다. */
      var CT_R = 11, CT_D = 30;   // 판 모서리 · 돔 위 모서리 반지름 (07-bacc.css 와 같아야 한다)
      function contourPath(side, W, H, T){
        var m = Math.round(W / 2), TL = T.x, TR = T.x + T.w, TY = T.y;
        var R = CT_R, D = CT_D, h = H - 0.5, w = W - 0.5;
        if (side === 'tie') {
          return 'M' + (TL+D) + ',' + (TY+0.5) +
            'L' + (TR-D) + ',' + (TY+0.5) +
            'A' + D + ',' + D + ' 0 0 1 ' + TR + ',' + (TY+D) +
            'L' + TR + ',' + (h-R) +
            'A' + R + ',' + R + ' 0 0 1 ' + (TR-R) + ',' + h +
            'L' + (TL+R) + ',' + h +
            'A' + R + ',' + R + ' 0 0 1 ' + TL + ',' + (h-R) +
            'L' + TL + ',' + (TY+D) +
            'A' + D + ',' + D + ' 0 0 1 ' + (TL+D) + ',' + (TY+0.5) + 'Z';
        }
        if (side === 'banker') {
          /* 위 가운데에서 출발해 오른쪽을 돌아 바닥을 타고 오다가, 돔의 오른쪽
             옆면을 타고 올라 돔의 오른쪽 어깨를 넘어 제자리로 돌아온다. */
          return 'M' + m + ',0.5' +
            'L' + (w-R) + ',0.5' +
            'A' + R + ',' + R + ' 0 0 1 ' + w + ',' + (0.5+R) +
            'L' + w + ',' + (h-R) +
            'A' + R + ',' + R + ' 0 0 1 ' + (w-R) + ',' + h +
            'L' + (TR+R) + ',' + h +
            /* 여기는 «오목한» 모서리다 — 판 바닥이 돔의 옆면으로 파고드는 자리라
               곡률의 중심이 길 «바깥» 에 있다. 볼록한 모서리와 반대 방향(sweep 1)을
               써야 한다. 반대로 주면 중심이 반대편에 잡혀 작은 갈고리가 튀어나온다
               (제보로 온 그 조각이 이것이다). */
            'A' + R + ',' + R + ' 0 0 1 ' + TR + ',' + (h-R) +
            'L' + TR + ',' + (TY+D) +
            'A' + D + ',' + D + ' 0 0 0 ' + (TR-D) + ',' + (TY+0.5) +
            'L' + m + ',' + (TY+0.5) + 'Z';
        }
        return 'M' + m + ',0.5' +
          'L' + (0.5+R) + ',0.5' +
          'A' + R + ',' + R + ' 0 0 0 0.5,' + (0.5+R) +
          'L0.5,' + (h-R) +
          'A' + R + ',' + R + ' 0 0 0 ' + (0.5+R) + ',' + h +
          'L' + (TL-R) + ',' + h +
          // 오목한 모서리 — 위 뱅커 쪽의 짝이다(방향만 좌우로 뒤집힌다)
          'A' + R + ',' + R + ' 0 0 0 ' + TL + ',' + (h-R) +
          'L' + TL + ',' + (TY+D) +
          'A' + D + ',' + D + ' 0 0 1 ' + (TL+D) + ',' + (TY+0.5) +
          'L' + m + ',' + (TY+0.5) + 'Z';
      }
      var CT_COLOR = { player:'#38bdf8', banker:'#f43f5e', tie:'#fbbf24' };
      function paintContour(res){
        var core = marketsEl.querySelector('.bacc-core');
        if (!core) return;
        var el = core.querySelector('.bc-contour');
        if (!el) {
          core.insertAdjacentHTML('beforeend',
            /* 루트에 fill/stroke 를 none 으로 못 박는다. 색은 path 가 갖고 있어 그림에는
               영향이 없고, scripts/check-states.ts 의 «아이콘이 배경에 묻혔나» 검사가
               색을 못 읽는 SVG 를 건너뛴다 — 안 주면 기본 검정으로 읽혀 초록 펠트와의
               밝기차 5 로 실패한다(실측). */
            '<svg class="bc-contour" aria-hidden="true" focusable="false"' +
            ' fill="none" stroke="none" preserveAspectRatio="none">' +
            '<path fill="none" stroke-width="2"' +
            ' vector-effect="non-scaling-stroke" stroke-linejoin="round"' +
            ' stroke-linecap="round"/></svg>');
          el = core.querySelector('.bc-contour');
        }
        var p = el.firstChild;
        var side = res && CT_COLOR[res.winner] ? res.winner : null;
        if (!side) { el.removeAttribute('data-side'); p.setAttribute('d', ''); return; }
        var cr = core.getBoundingClientRect();
        var tieEl = core.querySelector('.market.m-tie');
        var tr = tieEl && tieEl.getBoundingClientRect();
        if (!cr.width || !tr || !tr.width) return;
        var W = Math.round(cr.width), H = Math.round(cr.height);
        var T = { x: Math.round(tr.left - cr.left), y: Math.round(tr.top - cr.top),
                  w: Math.round(tr.width), h: Math.round(tr.height) };
        el.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
        p.setAttribute('d', contourPath(side, W, H, T));
        p.setAttribute('stroke', CT_COLOR[side]);
        el.setAttribute('data-side', side);
      }

      /* ══ 정산 — 버스트 앤 플라잉 ═════════════════════════════════════
         예전에는 «이긴 구역의 칩이 각자 주인에게 직선으로 빨려 간다» 였다. 칩이
         사람별로 쌓여 있었으니 그럴 수 있었다. 이제 구역마다 기둥이 하나뿐이라
         그 기둥을 «몫대로 쪼개서» 보내야 한다. 네 단계다.

           1 (0~250ms)   이긴 기둥이 금빛으로 부풀었다 사라진다. 진 기둥은 조용히
                         가라앉는다 — 이긴 쪽만 지우면 판이 반쯤 남은 채로 멈춘다.
           2 (250ms~)    그 자리에서 승자 수만큼 칩이 튀어나온다.
           3 (~1.2초)    포물선을 그리며 각자에게 간다. 내 몫은 우측 상단 잔고로,
                         남의 몫은 우측 목록의 그 사람 줄로.
           4 (도착)      흡수되고 내 잔고가 세어 오른다.

         포물선은 한 겹으로는 안 된다. 가로는 등속, 세로는 가속이어야 «던진 것» 으로
         보인다 — transform 하나에 둘을 넣으면 같은 가속을 공유해 직선이 된다.
         그래서 겉(.bc-fly)이 가로를, 속(.pchip)이 세로를 맡는다.

         라운드가 넘어가면 스스로 끝낸다. 폴이 1초마다 도는데 정산 감지가 늦으면
         다음 라운드가 연출 위에 겹친다 — 타이머와 노드를 들고 있다가 정리한다. */
      var BURST_MAX = 12;         // 이보다 많은 승자는 한 장으로 묶어 목록 상자로 보낸다
      var burstTimers = [], burstNodes = [];
      function burstCancel(){
        burstTimers.forEach(function(t){ clearTimeout(t); });
        burstTimers = [];
        burstNodes.forEach(function(n){ if (n.parentNode) n.parentNode.removeChild(n); });
        burstNodes = [];
      }
      function later(fn, ms){ burstTimers.push(setTimeout(fn, ms)); }
      function towerOf(market){
        var el = document.getElementById('pile-'+market);
        return el && el.querySelector('.bc-tower');
      }
      /* 돈이 나온 구역 중 «이긴» 것만. 무승부의 플레이어·뱅커는 환불이지 승리가
         아니다 — 거기까지 금빛으로 터뜨리면 둘 다 이긴 것처럼 읽힌다. */
      function winMarkets(res){
        var out = [res.winner];
        if (res.playerPair) out.push('ppair');
        if (res.bankerPair) out.push('bpair');
        return out;
      }
      /* 도착지가 화면 밖일 수 있다. 폰 세로에서는 참가자 목록이 판 아래로 밀리고,
         PC 라도 목록이 스크롤 안에 있으면 그 줄이 상자 밖이다. 화면 밖으로 날리면
         «아무 일도 안 일어난» 것과 구별이 안 되므로 가장자리 안쪽으로 끌어당긴다. */
      function clampToView(r){
        var m = 26;
        return { cx: Math.min(Math.max(r.left + r.width/2, m), innerWidth - m),
                 cy: Math.min(Math.max(r.top + r.height/2, m), innerHeight - m) };
      }
      function usable(el){ var r = el && el.getBoundingClientRect(); return (r && r.width) ? r : null; }
      /* 내 몫은 화면 «아래 가운데» 칩 바로 온다. 우측 상단 잔고로 보내 봤는데,
         다른 게임(포커 플립 · 블랙잭 · 지뢰찾기)이 전부 아래 칩 바로 회수하므로
         혼자만 다른 방향으로 날아가 «내 돈» 이라는 것이 오히려 덜 읽혔다(요청).
         잔고가 오르는 것은 우측 상단 숫자가 세어 오르며 따로 말한다.
         남의 몫은 그대로 우측 참가자 목록의 그 사람 줄로 간다. */
      function landingFor(uid){
        var r;
        if (uid === st.me) {
          r = usable(document.querySelector('.poker-controls')) || usable(coinsEl)
            || usable(document.querySelector('.prof'));
          if (r) return clampToView(r);
        }
        r = usable(rosterAvatar(uid))
          || usable(rosterEl && rosterEl.querySelector('.rw[data-uid="'+cssEsc(uid)+'"]'))
          || usable(rosterEl)
          || usable(document.querySelector('.poker-controls'))
          || usable(coinsEl);
        return r ? clampToView(r) : { cx: innerWidth/2, cy: innerHeight/2 };
      }
      function burstAndFly(res){
        burstCancel();
        var pay = payingMarkets(res), win = winMarkets(res);
        ALL_KEYS.forEach(function(m){
          var tw = towerOf(m); if (!tw) return;
          if (pay.indexOf(m) < 0) return tw.classList.add('bc-sink');
          tw.classList.add(win.indexOf(m) >= 0 ? 'bc-flash' : 'bc-refund');
        });
        /* 내 몫만큼 잔고를 되돌린다. render() 는 첫 줄에서 이미 정산 후 잔고를
           써 놓았으므로(loop.ts), 그대로 두면 칩이 날기도 전에 숫자가 올라가 있다.
           되돌린 뒤 칩이 «닿는 순간» 부터 세어 올린다. */
        var myGain = 0;
        (st.myBets||[]).forEach(function(b){ if (b.payout > 0) myGain += b.payout; });
        var balTo = st.balance, balFrom = balTo - myGain;
        if (myGain > 0 && pbal) {
          pbal.textContent = fmt(balFrom);
          /* 되돌린 뒤 «카운트업이 시작될 때까지» 도 잠가 둔다. 연출은 1초쯤 뒤에
             시작하는데 폴은 그 사이에 한 번 더 돌아서, 잠그지 않으면 최종값을 다시
             써 놓는다 — 숫자가 올랐다가 내려갔다가 다시 세어 오른다
             (실측: 되돌린 1.28초 뒤에 최종값이 한 번 스쳤다).
             시한을 두는 것은 setBalance 와 같은 이유다 — 연출이 어떤 까닭으로 안
             돌더라도 잔고는 결국 맞아야 한다. */
          balAnim = { to: balTo, until: Date.now() + 2600 };
        }
        later(function(){ burstSpawn(pay, balFrom, balTo, myGain); }, 250);
      }
      function burstSpawn(pay, balFrom, balTo, myGain){
        var n = 0, mineDelay = -1;
        pay.forEach(function(m){
          var tw = towerOf(m), from = tw && tw.getBoundingClientRect();
          if (!from || !from.width) return;
          // 사람별로 합친다 — 한 사람이 같은 구역에 여러 번 걸 수 있다
          var by = {}, order = [];
          (st.bets||[]).forEach(function(b){
            if (b.market !== m || !(b.payout > 0)) return;
            if (by[b.user_id] == null) { by[b.user_id] = 0; order.push(b.user_id); }
            by[b.user_id] += b.payout;
          });
          if (!order.length) return;
          var shown = order.slice(0, BURST_MAX);
          shown.forEach(function(uid){
            var delay = n * 45;
            if (uid === st.me && (mineDelay < 0 || delay < mineDelay)) mineDelay = delay;
            flyChip(from, landingFor(uid), bestDenom(by[uid]), uid, delay, n);
            n++;
          });
          /* 상한을 넘는 승자들은 한 장으로 묶어 목록 상자로 보낸다. 스무 장이 동시에
             날면 어느 것이 누구 것인지도 안 보이면서 프레임만 떨어진다. */
          if (order.length > shown.length) {
            var rest = 0;
            order.slice(BURST_MAX).forEach(function(u){ rest += by[u]; });
            flyChip(from, landingFor(order[BURST_MAX]), bestDenom(rest), '', n * 45, n);
            n++;
          }
        });
        if (!n) { if (myGain > 0) countBalance(balFrom, balTo, 600); return; }
        // 첫 칩이 «닿는» 순간에 소리와 카운트업을 건다 (승자가 열둘이어도 소리는 한 번)
        var hit = (mineDelay >= 0 ? mineDelay : 0) + 820;
        later(function(){
          if (window.casinoSfx && window.casinoSfx.chipWin) window.casinoSfx.chipWin();
          if (myGain > 0) countBalance(balFrom, balTo, 700);
        }, hit);
        later(burstCancel, n * 45 + 1300);
      }
      function flyChip(from, to, denom, uid, delay, idx){
        var d = TOWER_CHIP;
        var x0 = from.left + from.width/2, y0 = from.bottom - d/2;
        /* fly 를 함께 붙이는 이유: scripts/check-chips.ts 가 «회수된 칩» 을 그 클래스로
           센다. 모양은 아래 .pchip.bc-burst 가 정한다(07-bacc.css 가 05-poker.css 뒤라
           같은 무게면 이쪽이 이긴다). */
        var chip = chipNode(denom, uid, d, 0, 0, 'fly bc-burst');
        chip.style.position = 'absolute';
        chip.style.left = '0'; chip.style.top = '0';
        chip.style.setProperty('--ty', Math.round(to.cy - y0) + 'px');
        chip.style.setProperty('--bx', (jit(idx, 30) - 15) + 'px');
        chip.style.animationDelay = delay + 'ms';
        var wrap = document.createElement('span');
        wrap.className = 'bc-fly';
        wrap.style.cssText = 'position:fixed;margin:0;left:' + (x0 - d/2) + 'px;top:' + (y0 - d/2) + 'px;' +
          'width:' + d + 'px;height:' + d + 'px;';
        wrap.style.setProperty('--tx', Math.round(to.cx - x0) + 'px');
        wrap.style.animationDelay = delay + 'ms';
        wrap.appendChild(chip);
        getFxLayer().appendChild(wrap);
        burstNodes.push(wrap);
      }
      // 돈이 나온 상자 — 무승부면 플레이어·뱅커도 원금이 돌아가므로 함께 회수한다
      function payingMarkets(res){
        var out = res.winner === 'tie' ? ['player','banker','tie'] : [res.winner];
        if (res.playerPair) out.push('ppair');
        if (res.bankerPair) out.push('bpair');
        return out;
      }

`;
