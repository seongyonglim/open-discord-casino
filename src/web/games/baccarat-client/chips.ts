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
            '<symbol id="bcChip" viewBox="0 0 48 48">' +
              /* 바닥 그림자는 두지 않는다. 한동안 칩 밑에 어두운 타원을 깔았는데,
                 칩이 겹겹이 쌓이면 그 그림자가 아래 칩의 «면» 위에 앉아서 판이
                 얼룩덜룩해졌다 — 놓여 있는 느낌보다 때가 낀 느낌이 먼저 왔다(제보).
                 입체는 아래 옆면 한 겹이면 선다. */
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
      var MAX_COL = 10;                    // 한 기둥에 열 장
      var MAX_COLS = 5;                    // 기둥은 다섯 (뒤 셋 · 앞 둘)
      var CHIP_LIMIT = MAX_COL * MAX_COLS; // 쉰 장
      /* 3 + 2 역피라미드. 뒷줄 셋이 먼저 서고, 앞줄 둘이 그 «틈새» 앞에 반 칸 걸친다.
         앞줄은 10px 아래(=화면상 앞)에 서고 한 단 밝다 — 가까운 것이 밝다.
         자리는 bottom 으로 잡으므로 «앞» 은 bottom 이 작은 쪽이다. 뒷줄을 10 올린다. */
      var COL_POS = [
        { x:0,  y:10, z:10, back:1 }, { x:18, y:10, z:10, back:1 }, { x:36, y:10, z:10, back:1 },
        { x:9,  y:0,  z:20, back:0 }, { x:27, y:0,  z:20, back:0 }
      ];
      var CLUSTER_W = 70;                  // 36(마지막 뒷기둥) + 34(칩 지름)
      // 금액을 큰 액면부터 그리디로 쪼갠다
      function splitAmount(amount){
        var d=(st.coins||[]).slice().sort(function(a,b){return b-a;}), out=[];
        for (var i=0;i<d.length && out.length<CHIP_LIMIT*2;i++){
          while (amount >= d[i] && out.length < CHIP_LIMIT*2) { out.push(d[i]); amount -= d[i]; }
        }
        return out;
      }
      /* 구역마다 «내가 누른 칩» 을 누른 순서대로.
         이것은 화면이 아니라 «자료» 다 — 골격(.market)이 다시 그려질 때 같이 버리면
         안 된다. 베팅이 닫히는 순간 단계가 바뀌면서 골격이 새로 그려지는데, 그때
         이 목록을 비웠더니 누른 칩들이 서버 금액으로 다시 합쳐져서 «분명 안 합쳐져
         있었는데 갑자기 합쳐진다» 가 됐다(제보). 라운드가 바뀔 때만 버린다. */
      var myRaw = {}, myRawRound = null;
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
      function zoneChips(market, byUser, total){
        var out = [];
        Object.keys(byUser).forEach(function(uid){
          if (uid === st.me) return;
          out = out.concat(splitAmount(byUser[uid]));
        });
        out = out.concat(myRaw[market] || []);   // 내 칩이 맨 위 — 방금 얹은 것이 보인다
        var guard = 0;
        while (out.length > CHIP_LIMIT && colorUpOnce(out) && ++guard < 400) {}
        if (out.length > CHIP_LIMIT) out = out.slice(0, CHIP_LIMIT);
        return out;
      }
      // 금액 하나를 대표하는 칩 한 장 — 유령 칩과 버스트 칩이 쓴다
      function bestDenom(amount){
        var d=(st.coins||[]).slice().sort(function(a,b){return b-a;});
        for (var i=0;i<d.length;i++) if (amount >= d[i]) return d[i];
        return d[d.length-1];
      }
      /* 클러스터를 «판 바깥» 에 붙인다. 플레이어는 구역 왼쪽 끝, 뱅커는 오른쪽 끝 —
         여섯 기둥이 다 차도 가운데 타이 돔 쪽으로는 자라지 않는다.
         페어와 타이는 좌우가 좁으므로 가운데에 둔다. */
      function chipX(market, x){
        if (market === 'player') return 'left:calc(0% + ' + (23 + x) + 'px)';
        if (market === 'banker') return 'left:calc(100% - ' + (23 + (36 - x)) + 'px)';
        return 'left:calc(50% + ' + (x - 18) + 'px)';
      }
      function paintTower(el, market, ds, total, mine){
        if (!ds.length) { el.innerHTML = ''; return; }
        var cols = [];
        for (var i=0;i<ds.length;i+=MAX_COL) cols.push(ds.slice(i, i+MAX_COL));
        if (cols.length > MAX_COLS) cols = cols.slice(0, MAX_COLS);
        /* 층 간격 4px. 열 장이면 기둥이 34 + 36 = 70px 이고, 뒷줄은 그보다 10px 위라
           80px 이다 — 칸(96px) 안에 선다. 이보다 벌리면 뚫는다. */
        /* 밑동에 타원 하나를 깔아 «내 베팅» 과 «큰 판» 을 표시했는데, 기둥이 다섯으로
           퍼지면서 그 타원만 엉뚱한 자리에 홀로 떠 있게 됐다(제보). 걷는다 —
           입체는 칩 자체가 갖고 있고, 어느 구역에 걸었는지는 상자 아래 «N명» 이
           말한다. */
        var html = '';
        for (var c=0;c<cols.length;c++){
          var p = COL_POS[c];
          for (var j=0;j<cols[c].length;j++){
            html += '<span class="pchip bc3d c-coin ' + denomClass(cols[c][j]) +
              (p.back ? ' bc-back' : ' bc-front') + '" style="' + chipX(market, p.x) +
              ';bottom:' + (p.y + j*4) + 'px;z-index:' + (p.z + j) + '">' +
              chipArt(cols[c][j]) + '</span>';
          }
        }
        el.innerHTML = '<span class="bc-tower">' + html + '</span>';
      }
      function syncTower(market, byUser, roundId){
        var el = document.getElementById('pile-'+market);
        if (!el) return;
        ensureChipDefs();
        var total = 0, uids = Object.keys(byUser);
        for (var i=0;i<uids.length;i++) total += byUser[uids[i]];
        var t = towers[market];
        var fresh = !t || t.round !== roundId;
        if (myRawRound !== roundId) { myRaw = {}; myRawRound = roundId; }
        if (fresh) t = towers[market] = { round: roundId, sig: null, byUser: {} };

        // 늘어난 사람마다 유령 칩 한 장이 날아온다 (내 것은 dropMyChip 이 이미 냈다)
        if (!fresh) {
          uids.forEach(function(uid){
            var delta = byUser[uid] - (t.byUser[uid]||0);
            if (delta <= 0 || uid === st.me) return;
            ghostChip(rosterAvatar(uid), el, bestDenom(delta), uid);
            /* 남이 걸 때도 같은 소리를 낸다 — 칩만 날고 조용하면 판이 커지고 있다는
               것이 눈을 그쪽에 두고 있을 때만 전해진다. 다만 한 번에 여럿이 걸면
               소리가 겹쳐 지저분하므로 150ms 안에는 한 번만 낸다. */
            if (Date.now() - lastBetSfx > 150) {
              lastBetSfx = Date.now();
              if (window.casinoSfx && window.casinoSfx.chipBet) window.casinoSfx.chipBet();
            }
          });
        }
        t.byUser = {};
        uids.forEach(function(uid){ t.byUser[uid] = byUser[uid]; });

        /* 내가 들고 있는 순서를 서버 값에 맞춘다. 스스로 고쳐지는 두 갈래다 —
           내 쪽이 많으면(회수했다) 서버 값으로 다시 쪼개고, 서버 쪽이 많으면
           (다른 창에서 걸었거나 폴이 내 클릭보다 먼저 왔다) 그 차이만 덧붙인다.
           «다르면 통째로 다시» 로 하면 클릭 직후의 폴이 내 순서를 지운다. */
        var mineAmt = byUser[st.me] || 0, rawSum = 0;
        (myRaw[market] || []).forEach(function(v){ rawSum += v; });
        if (rawSum > mineAmt) myRaw[market] = splitAmount(mineAmt);
        else if (rawSum < mineAmt) myRaw[market] = (myRaw[market]||[]).concat(splitAmount(mineAmt - rawSum));

        // 쌓인 모양이 그대로면 다시 그리지 않는다 — 매초 새로 그리면 쌓인 느낌이 사라진다
        var ds = zoneChips(market, byUser, total);
        var sig = total + '|' + ds.join(',') + '|' + (mineAmt > 0);
        if (t.sig === sig) return;
        t.sig = sig;
        el.style.opacity = '';
        paintTower(el, market, ds, total, mineAmt > 0);
      }
      /* 유령 칩 — 그 사람 아이콘에서 타워로 날아와 도착과 함께 사라진다.
         타워에 «남지» 않는 것이 핵심이다. 남으면 타워가 다시 사람 수만큼 자란다. */
      function ghostChip(src, pileEl, denom, owner){
        var a = src && src.getBoundingClientRect();
        if (!a || !a.width) {
          var rb = rosterEl && rosterEl.getBoundingClientRect();
          if (rb && rb.width) a = rb;
        }
        var tw = pileEl.querySelector('.bc-tower') || pileEl;
        var b = tw.getBoundingClientRect();
        if (!a || !a.width || !b.width) return;
        var host = document.createElement('span');
        host.className = 'pchip bc3d c-coin ' + denomClass(denom) + ' toss';
        host.setAttribute('data-owner', owner);
        host.innerHTML = chipArt(denom);
        var d = TOWER_CHIP;
        var cx = b.left + b.width/2 - d/2, cy = b.bottom - d;
        host.style.cssText = 'position:fixed;margin:0;left:' + cx + 'px;top:' + cy + 'px;' +
          'width:' + d + 'px;height:' + d + 'px;min-width:' + d + 'px;min-height:' + d + 'px;';
        host.style.setProperty('--fx', Math.round((a.left+a.width/2) - (cx+d/2)) + 'px');
        host.style.setProperty('--fy', Math.round((a.top+a.height/2) - (cy+d/2)) + 'px');
        host.style.setProperty('--fs', Math.min(2.6, a.width / d).toFixed(2));
        getFxLayer().appendChild(host);
        setTimeout(function(){ if (host.parentNode) host.parentNode.removeChild(host); }, 400);
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
      function dropMyChip(market, denom){
        var el = document.getElementById('pile-'+market), t = towers[market];
        if (!el || !t) return;
        t.byUser[st.me] = (t.byUser[st.me]||0) + denom;
        (myRaw[market] = myRaw[market] || []).push(denom);
        var total = 0;
        Object.keys(t.byUser).forEach(function(u){ total += t.byUser[u]; });
        var ds = zoneChips(market, t.byUser, total);
        t.sig = total + '|' + ds.join(',') + '|true';
        paintTower(el, market, ds, total, true);
        // 얹힌 것이 손에 느껴지게 판이 아주 살짝 부푼다
        var tw = el.querySelector('.bc-tower');
        if (tw) { tw.classList.add('bc-pop'); }
        ghostChip(coinsEl.querySelector('.coin[data-coin="'+denom+'"] .face'), el, denom, st.me);
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
