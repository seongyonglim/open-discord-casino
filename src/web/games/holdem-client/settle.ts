/* 홀덤 화면 — 칩 비행 · 팟 수거 · WIN 배지.

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
export const SETTLE = `    var fxLayer = null;
    function getFx(){
      if (!fxLayer || !fxLayer.parentNode) {
        fxLayer = document.createElement('div');
        fxLayer.className = 'chip-fly-layer';
        /* 테이블 안에 붙인다. position:fixed라 어디에 붙어도 화면 좌표로 움직이지만,
           body 직속이면 --ht* 변수와 .ht-shell 스코프 규칙이 닿지 않아 복제된 카드가
           기본 .pcard(48×72)로 떨어진다. 지금은 인라인 크기가 그걸 가려 주고 있을 뿐이다. */
        tableEl.appendChild(fxLayer);
      }
      return fxLayer;
    }
    function flyChip(fromRect, toRect, delay, cls){
      var c = document.createElement('i');
      c.className = 'ht-pchip pkchip fly' + (cls ? ' ' + cls : '');
      c.style.cssText = 'position:fixed;left:' + fromRect.left + 'px;top:' + fromRect.top + 'px;' +
        'margin:0;width:20px;height:11px;';
      c.style.setProperty('--tx', Math.round((toRect.left + toRect.width/2) - fromRect.left) + 'px');
      c.style.setProperty('--ty', Math.round((toRect.top + toRect.height/2) - fromRect.top) + 'px');
      c.style.animationDelay = delay + 'ms';
      getFx().appendChild(c);
      setTimeout(function(){ if (c.parentNode) c.parentNode.removeChild(c); }, 700 + delay);
    }
    /* 좌석 앞의 칩 기둥을 통째로 복제해 중앙까지 미끄러뜨린다.
       익명의 칩 하나를 날리는 것과 다른 점: 출발한 것과 도착한 것이 같은 물건이다.
       실제로 그 사람이 낸 액면 조합 그대로 움직이므로 "저 칩이 팟으로 갔다"가 된다. */
    var STACK_FLY_MS = 620;
    function flyStack(snap, toRect, delay){
      if (!snap || !snap.rect.width) return;
      var r = snap.rect;
      var w = document.createElement('div');
      w.className = 'ht-fly-stack';
      w.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;' +
        'width:' + r.width + 'px;height:' + r.height + 'px;';
      w.innerHTML = snap.html;
      w.style.setProperty('--tx',
        Math.round((toRect.left + toRect.width / 2) - (r.left + r.width / 2)) + 'px');
      w.style.setProperty('--ty',
        Math.round((toRect.top + toRect.height / 2) - (r.top + r.height / 2)) + 'px');
      w.style.animationDelay = delay + 'ms';
      getFx().appendChild(w);
      setTimeout(function(){ if (w.parentNode) w.parentNode.removeChild(w); },
        STACK_FLY_MS + delay + 80);
    }

    /* 스트리트가 끝나면 각자 앞의 칩이 중앙 팟으로 밀려간다.
       서버는 스트리트가 넘어갈 때 베팅을 0으로 초기화하므로, 그 순간을 잡아
       "직전에 칩이 있던 자리"에서 팟으로 날린다. 초기화된 뒤에 날리려 하면
       출발 위치가 이미 사라져 있다 — 그래서 좌표를 미리 기억해 둔다. */
    var prevSpots = {}, spotStreet = null, spotHand = null, sweptEndHand = null;
    function rememberSpots(tb){
      var next = {};
      (tb.seats||[]).forEach(function(s){
        var el = document.getElementById('htspot-' + s.seat);
        if (!el || !(s.bet > 0)) return;
        var chips = el.querySelector('.ht-spot-chips');
        if (!chips) return;
        var r = chips.getBoundingClientRect();
        /* 좌표만이 아니라 칩 기둥의 생김새까지 통째로 기억한다.
           날릴 시점에는 이미 서버가 베팅을 0으로 되돌려 원본이 화면에서 사라진 뒤라,
           그때 가서 복제하려 하면 복제할 것이 없다. */
        next[s.seat] = {
          rect: { left: r.left, top: r.top, width: r.width, height: r.height },
          html: chips.innerHTML,
        };
      });
      /* 스트리트가 넘어갈 때, 그리고 판이 끝날 때 각자 앞의 칩이 중앙으로 간다.
         판이 끝나는 경우를 빼먹으면 마지막 스트리트 베팅이 그 자리에서 그냥 사라진다. */
      var streetChanged = (tb.handNo === spotHand && tb.street !== spotStreet);
      var handEnded = tb.ended && sweptEndHand !== tb.handNo;
      if (streetChanged || handEnded) {
        if (handEnded) sweptEndHand = tb.handNo;
        var pot = pileEl.getBoundingClientRect();
        /* 목표는 팟 금액표가 아니라 칩 더미다. 칩이 숫자 알약으로 빨려 들어가면
           "칩이 어디로 갔나"가 어긋난다 — 칩은 칩 더미로 가야 한다.
           더미가 아직 비어 있으면(첫 스트리트) 그 자리라도 팟 알약보다는 낫다. */
        if (!pot.width) pot = potEl.getBoundingClientRect();
        var n = 0;
        Object.keys(prevSpots).forEach(function(k){
          flyStack(prevSpots[k], pot, n * 55);
          n++;
        });
      }
      prevSpots = next;
      spotStreet = tb.street; spotHand = tb.handNo;
    }

    /* 중앙 더미를 통째로 복제해 승자에게 보낸다.
       예전에는 칩을 낱장으로 복제해 45ms씩 흩뿌렸다. 흐름은 좋았지만 금액 배지가
       따라가지 않았다 — 배지는 칩과 같은 상자(.ht-pg) 안의 형제인데 복제 대상이
       칩뿐이라, 칩은 승자에게 가고 배지는 중앙에 홀로 남아 따로 사라졌다.
       상자째 옮기면 그럴 자리가 없다. "얼마가 누구에게" 가 한 덩어리로 움직인다.

       shareOf/shareIdx는 분할 팟용이다. 승자가 둘이면 같은 상자를 두 개 만들되
       칩을 번갈아 나눠 담고 배지에 각자 몫을 적는다 — 안 그러면 같은 금액이 두 번
       날아가 팟이 두 배로 나간 것처럼 보인다.

       .ht-pchip.flyout 애니메이션 길이와 같아야 한다 (CSS htPileFly 1.8s).
       두 단계짜리다 — 승자 앞까지 밀고(0.62초) · 0.7초 멈추고 · 흡수(0.48초).
       이 값이 곧 "도착했다"의 기준이라(도착해야 승자 스택 숫자가 오르고 그 뒤에
       다음 사이드 팟이 걸린다) CSS와 어긋나면 순서가 통째로 밀린다. */
    var PILE_FLY_MS = 1800;
    function flyPileGroup(boxEl, toRect, delay, shareOf, shareIdx, amount){
      var r = boxEl.getBoundingClientRect();
      if (!r.width) return;
      var c = boxEl.cloneNode(true);
      c.classList.remove('pending', 'paid');
      c.className += ' flyout';
      // 분할 팟 — 칩을 번갈아 나누고 배지에 이 사람 몫을 적는다
      if (shareOf > 1) {
        var chips = Array.prototype.slice.call(c.querySelectorAll('.ht-pchip'));
        chips.forEach(function(ch, i){
          if (i % shareOf !== shareIdx && ch.parentNode) ch.parentNode.removeChild(ch);
        });
        var v = c.querySelector('.ht-pg-v');
        if (v) v.textContent = stackText(amount);
      }
      c.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;' +
        'margin:0;width:' + r.width + 'px;height:' + r.height + 'px;z-index:70;';
      c.style.setProperty('--tx', Math.round((toRect.left + toRect.width/2) - (r.left + r.width/2)) + 'px');
      c.style.setProperty('--ty', Math.round((toRect.top + toRect.height/2) - (r.top + r.height/2)) + 'px');
      c.style.animationDelay = delay + 'ms';
      getFx().appendChild(c);
      setTimeout(function(){ if (c.parentNode) c.parentNode.removeChild(c); },
        PILE_FLY_MS + 60 + delay);
    }
    /* 핸드가 끝나면 팟이 승자에게 밀려간다. 한 판에 한 번만.
       중앙에 쌓인 칩을 지분대로 나눠 각 승자에게 보낸다. */
    var potPaidHand = null;
    /* 마지막 층까지 흡수가 끝나는 시각(절대)과 그게 어느 판의 것인지.
       우승 축하 팝업이 이 값을 기다린다 — 연출을 덮지 않으려면 시간이 아니라
       연출 자체가 신호여야 한다.
       판 번호를 함께 두는 것이 중요하다. 시각만 보면 직전 판에서 남은 값(이미 지난
       시각)이 다음 판에서도 "끝났다"로 읽힌다. */
    var potDoneAt = 0, potDoneHand = null;
    /* 중앙 Total Pot 에 지금 적혀 있어야 할 금액. 층을 하나씩 보내면서 그만큼 줄인다.
       서버가 주는 tb.pot 은 판이 끝난 뒤에도 총액 그대로라, 이 값이 없으면 마지막 층이
       날아간 뒤에도 위쪽 숫자는 총액에 멈춰 있다.
       renderTable(TABLE 조각)이 이 값을 보고 그린다 — 조각 순서가 SETTLE → TABLE 이라
       거기서 이 변수가 보인다. potShownHand 로 그 판의 값인지 확인한다: 판이 넘어가면
       서버 값으로 돌아가야 한다. */
    var potShown = 0, potShownHand = null;
    /* .ht-pg 가 접히는 연출 길이(CSS .5s). 이 시간이 지난 뒤 상자를 DOM 에서 지운다. */
    var PILE_FADE_MS = 500;
    function flyPotToWinners(tb){
      if (!tb.ended || !tb.result || potPaidHand === tb.handNo) return;
      potPaidHand = tb.handNo;
      potDoneAt = 0; potDoneHand = null; hiSeats = null;
      /* 판이 끝나는 순간에는 마지막 스트리트 베팅이 아직 중앙으로 모이는 중이다
         (칩이 날아오고 더미에 나타나기까지 약 420ms). 그게 끝난 뒤에 밀어야
         "모아서 넘겨준다"로 읽힌다 — 실제 딜러도 걷어서 한 박자 쉬고 넘긴다. */
      var forHand = tb.handNo;
      setTimeout(function(){
        /* 지연 콜백이 도는 사이에 새 판이 시작됐으면 아무것도 하지 않는다.
           pushPotToWinners는 실시간 pileEl을 읽고 마지막에 비우므로, 그냥 두면
           다음 판의 팟 더미를 지워 버린다. */
        if (!st || !st.table || st.table.handNo !== forHand) return;
        /* 보여줄 층이 하나도 없으면(승자가 화면 밖에 있는 등) 연출도 없다.
           그때는 여기서 끝났다고 표시해 둔다 — 안 그러면 potDoneAt이 영원히 0이라
           우승 축하 팝업이 링거가 끝날 때까지 붙들려 있는다. */
        if (!pushPotToWinners(tb, forHand)) { potDoneAt = Date.now(); potDoneHand = forHand; }
      }, 550);
    }

    /* ── 팟을 층별로 하나씩 넘겨 준다 ─────────────────────────────────
       예전에는 모든 층을 한 번에 정산해서 칩이 여러 자리로 동시에 흩어졌다. 사이드 팟이
       있으면 누가 어느 팟을 가져갔는지 알 수 없었고, 큰 판일수록 더 그랬다.

       이제 한 층씩 간다: 그 층의 승자와 족보를 띄우고 → 칩을 그 사람에게 보내고 →
       도착할 때까지 기다렸다가 다음 층으로. 서버가 이긴 손이 강한 층부터 담아 주므로
       가장 센 손이 먼저 자기 몫을 가져간다(실제 딜러의 순서다).

       한 층의 순서는 [WIN 배지 → 대기 → 칩이 승자 앞까지 → 0.7초 정지 → 흡수]다.

       ── 왜 고정 격자가 아니라 사슬인가
       예전에는 층 i를 i × 2.5초에 예약했다. 격자는 예약이 간단한 대신 실제 소요를
       모른다 — 칩이 많은 층은 시차(45ms씩) 때문에 2.5초를 넘겨서 다음 층이 그 위로
       올라탔고, 칩이 두 장뿐인 층은 1초 만에 끝나고 1.5초를 그냥 서 있었다.
       지금은 payLayer가 "마지막 칩이 도착하는 시각"을 돌려주고 그 뒤에 다음 층을 건다.
       빈 시간도 겹침도 생기지 않는다.

       대기 시간은 첫 층과 그 뒤가 다르다. 첫 층의 2.5초는 "누가 무엇으로 이겼나"를
       읽는 시간이라 넉넉해야 하고, 두 번째부터는 그 답을 이미 알고 있어서 같은 길이를
       주면 늘어지기만 한다. 그래서 1초다. */
    var POT_WAIT_FIRST_MS = 2500;   // 승자 판정 → 첫 팟이 움직이기까지
    var POT_WAIT_NEXT_MS = 1000;    // 사이드 팟 사이
    /* 마지막 흡수 → 판이 끝났다고 보는 시점.
       1.75초였는데 "다음 판까지 답답하다"는 말이 나왔다. 이 구간에 남아 있는 정보는
       승자 스택이 오른 숫자 하나뿐이라, 길게 잡아도 더 읽을 것이 생기지 않는다.
       1.25초면 결과를 확인하고 바로 다음 판으로 넘어간다. */
    var POT_AFTER_MS = 1250;
    function pushPotToWinners(tb, forHand){
      /* 칩이 도착하는 곳은 아바타다 — "사람이 앉아 있는 자리"다.
         예전에는 좌석판이었고 그때는 그것이 좌석의 몸통이었다. 지금 좌석판은 아바타 아래에
         걸친 작은 이름 태그이고, 6시 자리에서는 그 태그 중심이 펠트 경계보다 아래에 있다 —
         거기로 칩을 보내면 칩이 테이블을 벗어나 사라지는 것처럼 보인다.
         seatOf는 "이 좌석이 화면에 있나"를 확인하는 문(gate)도 겸하므로 한 곳에서 정한다.
         두 곳에 따로 적어 한쪽만 바꾸면 문은 통과하고 목표가 null이 되어, 그 승자만
         칩·WIN·층 이름표가 통째로 사라진다. */
      var seatOf = function(seat){
        return seatsEl.querySelector('.ht-seat[data-seat="' + seat + '"] .ht-avbox');
      };
      var raw = (tb.result.potAwards || []).filter(function(pa){
        return pa.winners && pa.winners.some(function(w){ return seatOf(w.seat); });
      });
      /* 폴드로 끝난 판이나 옛 판(potAwards가 없는 기록)은 층 정보가 없다.
         그때는 좌석별 합계 하나를 층 하나로 취급한다 — 층이 하나뿐이라 순서를 보여줄
         것은 없지만, WIN 배지와 "먼저 띄우고 나중에 칩" 순서는 똑같이 밟아야 한다.
         예전에는 이 경로가 payLayer를 바로 불러서, 폴드로 끝난 판에서는 승자 표시가
         아예 없고 칩만 날아갔다. 판의 대부분이 이 경로다. */
      var layers;
      if (!raw.length) {
        var flat = (tb.result.awards || []).filter(function(a){ return seatOf(a.seat); });
        if (!flat.length) return false;   // 보여줄 것이 없다 (부른 쪽이 끝났다고 표시한다)
        layers = [{ __key: '', __span: 1, index: 0, score: 0, amount: tb.pot || 0, winners: flat }];
      } else {
        layers = mergeSameWinner(raw);
      }
      /* WIN 배지를 먼저 띄우고 한 박자 쉰 뒤에 칩을 옮긴다.
         칩이 곧바로 날아가면 "누가 이겼나"를 읽기 전에 정산이 끝나 버린다. */
      /* 이 판의 Total Pot 표시를 총액에서 시작해 층마다 깎아 내려간다. */
      potShown = tb.pot || 0; potShownHand = tb.handNo;
      var idx = 0;
      function step(){
        if (!st || !st.table || st.table.handNo !== forHand) return;   // 새 판이면 중단
        if (idx >= layers.length) return;
        var pa = layers[idx], first = idx === 0, last = idx === layers.length - 1;
        showWinBadges(tb, pa);
        /* 층마다 다시 낸다 — 첫 층에서만 울리면 뒤 층은 조용히 지나가서
           "이게 아직 정산 중인가, 끝난 건가"가 소리로는 안 잡힌다.
           첫 층은 renderTable이 이미 울렸으므로 두 번째 층부터다.
           칩 소리는 여기가 아니라 payLayer에서 낸다(칩이 실제로 움직이는 순간). */
        if (!first && window.casinoSfx && window.casinoSfx.potWin) window.casinoSfx.potWin();
        setTimeout(function(){
          if (!st || !st.table || st.table.handNo !== forHand) return;
          var landed = payLayer(tb, pa, last);
          idx++;
          if (!last) { setTimeout(step, landed); return; }
          /* 마지막 층까지 흡수됐다. 여기가 "이 판의 연출이 다 끝난" 시점이다 —
             우승 팝업이 이 신호를 기다린다(potDoneAt). */
          potDoneAt = Date.now() + landed + POT_AFTER_MS; potDoneHand = forHand;
          /* 폴링(1초)을 기다리지 않고 그 시각에 직접 깨운다. 대회를 끝낸 판이라면
             여기가 곧 축하 팝업이 뜨는 시점이라(potDoneAt + 0.5초), 폴링에 맡기면
             같은 판인데도 최대 1초씩 들쭉날쭉해진다. */
          setTimeout(function(){
            if (!st || !st.table || st.table.handNo !== forHand) return;
            if (!tableEl.hidden) renderTable();
            celebrate();
          }, landed + POT_AFTER_MS + WIN_POPUP_AFTER_MS + 20);
        }, first ? POT_WAIT_FIRST_MS : POT_WAIT_NEXT_MS);
      }
      step();
      return true;
    }

    /* 인접한 층의 승자가 같으면 하나로 합친다.
       사이드 팟 세 개를 같은 사람이 다 가져가는 상황에서 세 번 따로 칩을 보내면,
       같은 사람에게 같은 연출이 세 번 반복되면서 "무슨 일이 세 번 일어났나" 싶어진다.
       실제 딜러도 그때는 한 번에 밀어 준다.

       승자가 다른 층은 합치지 않는다 — 그 경계가 바로 사이드 팟이 존재하는 이유이고,
       누가 어느 팟을 가져갔는지 순서로 보여줘야 한다. */
    function mergeSameWinner(layers){
      var out = [];
      layers.forEach(function(pa){
        var key = pa.winners.map(function(w){ return w.seat; }).sort().join(',');
        var prev = out.length ? out[out.length - 1] : null;
        /* 승자가 둘 이상인 층(분할 팟)은 합치지 않는다.
           합치면 배지 금액이 정확히 묶은 층 수만큼 부풀었다 — 아래 배지 코드가 분할 팟에서
           "이 층 총액"을 각 승자에게 각각 적기 때문이다(그래야 한 명이 얼마 받는지 보인다).
           층 [2000,1400] 을 두 명이 나눠 이긴 판에서 화면 배지 합이 6,800P 로 찍혔다 —
           실제 팟은 3,400P 다(무작위 6,000판 중 43.9%에서 발생).
           돈은 정확했다. 배지 글자만 틀렸다. */
        if (prev && prev.__key === key && pa.winners.length === 1) {
          prev.amount += pa.amount || 0;
          prev.winners = prev.winners.map(function(w){
            var add = pa.winners.filter(function(x){ return x.seat === w.seat; })[0];
            return { seat: w.seat, amount: (w.amount || 0) + (add ? add.amount || 0 : 0) };
          });
          // 합쳐진 층은 이름표에서 "MAIN + SIDE 1" 처럼 묶어 보여준다
          prev.__span = (prev.__span || 1) + 1;
          /* 서버는 팟 층을 **내림차순**으로 준다(db/holdem.ts, score desc → index desc).
             그래서 묶음의 첫 원소 index 가 가장 크고, 그것을 그대로 남기면 아래 payLayer 가
             그 값을 범위의 **시작**으로 읽어(li >= first && li < first+span) 뒤 묶음의
             칩 더미를 미리 집어 간다. 그러면 뒤 묶음은 집을 것이 없어 남은 더미를 통째로
             쓸어 가고, 폴링 재도색이 층을 되살려 같은 칩이 두 번 날았다(6,000판 중 9.9%).
             묶음이 실제로 덮는 index 의 최솟값을 남긴다. */
          prev.index = Math.min(prev.index, pa.index);
          return;
        }
        out.push({
          __key: key, __span: 1, index: pa.index, score: pa.score,
          amount: pa.amount || 0,
          winners: pa.winners.map(function(w){ return { seat: w.seat, amount: w.amount || 0 }; }),
        });
      });
      return out;
    }

    /* ── WIN 배지 ────────────────────────────────────────────────────
       이 층을 가져가는 사람의 좌석판 위에 WIN을 띄운다. 칩이 움직이기 전에 먼저 뜬다 —
       칩부터 날아가면 이미 끝난 뒤에 누가 이겼는지 알게 된다.
       배지가 떠 있고 칩이 아직 안 움직이는 시간은 pushPotToWinners가 정한다
       (첫 층 POT_WAIT_FIRST_MS · 그 뒤 POT_WAIT_NEXT_MS). */
    /* 이 판에서 WIN 배지가 이미 떴나. 승률 말풍선이 이 값을 보고 물러난다 —
       배지와 말풍선은 같은 자리를 놓고 다투는 것이 아니라 바통을 주고받는 관계다. */
    var badgeShownHand = null;
    /* 지금 정산 중인 층의 승자들. syncHighlight가 이 자리들의 5장만 밝힌다 —
       층과 칩이 1:1로 움직여야 "이 손이 이 팟을 가져갔다"가 읽힌다.
       null이면 아직 층이 정해지기 전이라는 뜻이다(새 판마다 되돌린다). */
    var hiSeats = null;
    function showWinBadges(tb, pa){
      var win = {};
      pa.winners.forEach(function(w){ win[w.seat] = 1; });
      hiSeats = win;
      // 이 층으로 하이라이트를 옮긴다 — 팟 사슬에서 불리므로 여기서 직접 다시 그린다
      if (st && st.table) syncHighlight(st.table, boardRevealed ? st.table.myHand : null);
      /* 배지가 뜨는 이 순간에 말풍선을 내린다. syncEquity는 renderSeats 안에서만
         도는데 이 함수는 팟 사슬에서 불리므로, 여기서 직접 한 번 걷어 준다.
         (안 그러면 다음 폴링까지 최대 1초 동안 배지와 말풍선이 같이 떠 있다.) */
      var first = badgeShownHand !== tb.handNo;
      badgeShownHand = tb.handNo;
      if (first) syncEquity(tb);
      /* 족보는 층 정보(pa.hand)가 있으면 그걸, 없으면 공개된 패에서 찾는다.
         폴드로 끝난 판은 둘 다 없다 — 보여줄 족보가 실제로 없는 것이다. */
      var reveal = (tb.result && tb.result.reveal) || [];
      (tb.seats || []).forEach(function(s){
        var seatSel = '.ht-seat[data-seat="' + s.seat + '"] ';
        var el = seatsEl.querySelector(seatSel + '.ht-win-b');
        var hEl = seatsEl.querySelector(seatSel + '.ht-win-h');
        if (!el) return;
        if (!win[s.seat]) {
          el.hidden = true;
          if (hEl) hEl.hidden = true;
          return;
        }
        el.hidden = false;
        el.style.animation = 'none';
        void el.offsetWidth;
        el.style.animation = '';
        if (hEl) {
          var r = reveal.filter(function(x){ return x.seat === s.seat; })[0];
          var name = pa.hand || (r && r.hand) || '';
          hEl.textContent = name;
          hEl.hidden = !name;
        }
      });
    }
    function clearWinBadges(){
      seatsEl.querySelectorAll('.ht-win-b,.ht-win-h').forEach(function(el){ el.hidden = true; });
    }

    /* 층 이름표를 펠트에 띄우던 함수는 없앴다.
       "MAIN + SIDE 1 POT 89,550 — 정폴드 · 플러시"를 중앙에 한 줄로 적었는데,
       그 정보는 이미 세 곳에 흩어져 있지 않고 제자리에 다 있다:
         어느 팟이 얼마인가 → 더미마다 붙은 MAIN/SIDE 이름표와 금액
         누가 가져가는가   → 그 사람 좌석 위의 WIN 배지
         무엇으로 이겼나   → 그 아래 족보 라벨
       한가운데에 요약을 한 번 더 적으면 눈이 카드에서 글자로 끌려간다. */

    /* 한 층의 칩을 승자에게 보낸다.
       "그 층의 더미"에서만 꺼낸다 — 층마다 더미가 따로 서 있으므로 어느 팟이 누구에게
       가는지가 칩의 출발점으로 드러난다. 예전에는 하나의 더미에서 비율만큼 세어 꺼냈고,
       그래서 세 사람이 각각 다른 층을 가져가도 칩이 늘 같은 자리에서 출발했다.
       합쳐진 층(mergeSameWinner)은 __span만큼 여러 더미를 함께 비운다.
       last면 남은 더미까지 전부 털어 중앙을 비운다. */
    function payLayer(tb, pa, last){
      var payHand = tb.handNo;
      /* 이미 보낸 더미(.paid)는 절대 다시 집지 않는다.
         .paid 는 opacity:0 일 뿐 DOM 에 남아 있어서, 마지막 층이 "남은 것 전부"를 집을 때
         앞 층의 상자까지 함께 복제해 날렸다 — 이미 승자에게 도착한 메인 팟 칩과 금액
         배지가 중앙에 되살아나 다음 층의 칩과 붙어 이동하는 것으로 보였다(제보).
         그래서 목록을 만드는 이 자리에서 걸러 낸다. */
      var boxes = Array.prototype.slice.call(pileEl.querySelectorAll('.ht-pg:not(.paid)'));
      var first = pa.index || 0, span = pa.__span || 1;
      var mine = boxes.filter(function(b, i){
        // 마지막 층은 아직 안 보낸 것 전부 — 층 번호가 안 맞는 잔여 더미까지 정리한다
        if (last) return true;
        var li = Number(b.getAttribute('data-layer'));
        void i;
        return li >= first && li < first + span;
      });
      /* 층 정보가 없는 옛 기록이나 폴드 종료는 더미가 하나뿐이라 그것이 곧 전부다.
         다만 **마지막 층에서만** 그렇게 본다. 중간 층에서 빈손이면 그건 "이 층 상자가
         아직 없다"는 뜻이지 "남은 게 다 내 것"이라는 뜻이 아니다 — 그때 전부를 쓸어 가면
         뒤 층이 집을 것이 없어지고, 폴링 재도색이 층을 되살려 같은 칩이 두 번 난다. */
      if (!mine.length && last) mine = boxes;
      var winners = pa.winners;
      var n = 0, sent = 0;
      /* 더미를 통째로 옮긴다 — 칩과 금액 배지가 한 상자(.ht-pg) 안에 있으므로
         그 상자를 복제해 날리면 둘이 같이 움직이고 같이 흡수된다.
         예전에는 칩만 낱장으로 복제해 보냈다. 그래서 칩은 승자에게 가는데 금액 배지는
         중앙에 홀로 남아 있다가 따로 사라졌다 — 같은 물건이 두 조각으로 갈라졌다.

         ── 무승부(분할 팟)
         승자가 N명이면 상자를 N개로 복제하고, 칩을 번갈아 나눠 담고, 배지에 각자
         실수령액을 적는다. 같은 금액을 N번 보여주면 팟이 N배로 나간 것처럼 보인다.

         N개는 동시에 출발한다 — 시차를 주면 "먼저 한 명에게 갔다가 다시 나눠 준다"로
         읽혀서, 정작 알려야 할 "동시에 나눠 가졌다"가 사라진다. 시차는 층(사이드 팟)
         사이에만 준다. 그쪽은 순서 자체가 정보다. */
      mine.forEach(function(b, bi){
        winners.forEach(function(w, k){
          // 위 seatOf와 반드시 같은 요소여야 한다 (다르면 문은 통과하고 목표가 null이 된다)
          var target = seatsEl.querySelector('.ht-seat[data-seat="' + w.seat + '"] .ht-avbox');
          if (!target) return;
          flyPileGroup(b, target.getBoundingClientRect(), bi * 90,
            winners.length, k, w.amount || 0);
          sent++;
        });
        n = Math.max(n, bi);
      });
      /* 칩이 실제로 움직이는 이 순간에 소리를 낸다 — 승자 발표 때가 아니라.
         분할 팟이어도 한 번이다. 사람 수만큼 겹쳐 울리면 소리가 뭉개진다. */
      if (sent && window.casinoSfx && window.casinoSfx.chipWin) window.casinoSfx.chipWin();
      /* 더미가 비어 있으면(판 도중 합류 등) 최소한 칩 몇 개는 날아가게 한다 */
      if (!mine.length) {
        winners.forEach(function(w){
          var target = seatsEl.querySelector('.ht-seat[data-seat="' + w.seat + '"] .ht-avbox');
          if (!target) return;
          var pot = potEl.getBoundingClientRect(), tr = target.getBoundingClientRect();
          var amt = w.amount || 0;
          var cnt = amt >= tb.level.bb * 20 ? 5 : amt >= tb.level.bb * 5 ? 3 : 2;
          for (var j = 0; j < cnt; j++) flyChip(pot, tr, (n++) * 45, 'towin');
        });
      }
      /* 보낸 더미는 그 자리에서 접는다 — 마지막 층에서만 전부 접으면 앞 층의 빈 상자가
         이름표만 남아 계속 서 있다. 층이 비워지는 것이 보여야 "이 팟은 끝났다"가 읽힌다.

         접은 뒤에는 DOM 에서 실제로 지운다. .paid 는 투명해질 뿐이라 상자가 남고, 남아
         있는 동안에는 언제든 다시 집힐 수 있다 — 위에서 :not(.paid) 로 막았지만 그건
         한 겹이고, 지워 버리면 다시 집는 일이 원리적으로 불가능해진다.
         지우는 시점은 접히는 연출(.5s)이 끝난 뒤다. 바로 지우면 상자가 접히는 것이
         안 보이고 툭 사라진다. */
      mine.forEach(function(b){
        b.classList.add('paid');
        setTimeout(function(){
          if (!st || !st.table || st.table.handNo !== payHand) return;
          if (b.parentNode) b.parentNode.removeChild(b);
        }, PILE_FADE_MS);
      });
      /* 중앙의 Total Pot 도 이 층만큼 줄인다. 서버가 준 tb.pot 은 판이 끝난 뒤에도
         그대로라, 층을 하나씩 보내는 동안 위쪽 숫자는 총액에 멈춰 있었다 —
         마지막 층이 날아간 뒤에도 "Total Pot 3,000" 이 떠 있는 셈이다.
         마지막 층에서는 남은 금액을 다 털어 정확히 0 으로 맞춘다(반올림 잔여 방지). */
      potShown = last ? 0 : Math.max(0, potShown - (pa.amount || 0));
      potEl.textContent = stackText(potShown);
      /* 칩이 도착한 다음에야 스택 숫자를 올린다.
         서버는 판이 끝나는 순간 이미 상금이 반영된 스택을 보낸다. 그걸 그대로 그리면
         쇼다운 카드가 열리기도 전에 숫자가 먼저 올라 누가 이겼는지 알려 버린다 —
         올인 판에서 특히 심했다. 그래서 화면은 "아직 안 받은 상금"을 빼고 그리다가
         (renderSeats의 stackOf), 그 층의 칩이 실제로 날아가 닿는 시점에 풀어 준다.
         더미가 여럿이면 90ms씩 시차를 두고 띄우므로 마지막 더미까지 기다린다. */
      var landed = PILE_FLY_MS + n * 90;
      setTimeout(function(){
        if (!st || !st.table || st.table.handNo !== payHand) return;
        winners.forEach(function(w){
          paidSeat[w.seat] = (paidSeat[w.seat] || 0) + (w.amount || 0);
        });
        renderSeats(); paintClock();
      }, landed);
      /* 마지막 층까지 보냈으면 중앙을 완전히 비운다 — 칩도 금액 배지도 남기지 않는다.
         비우는 시점은 마지막 칩이 승자 안으로 흡수된 뒤다. 예전처럼 0.9초에 지우면
         아직 1단계(승자 앞으로 미는 중)인 칩들의 출발지가 먼저 사라져, 중앙이 빈
         상태에서 칩만 허공을 날아간다.
         potClearedHand를 세워 두는 것이 핵심이다 — 이게 없으면 다음 폴링의
         syncPotPile이 "더미가 없네" 하고 tb.pot 기준으로 통째로 되살린다. */
      if (last) {
        potClearedHand = payHand;
        setTimeout(function(){
          if (!st || !st.table || st.table.handNo !== payHand) return;
          pileEl.innerHTML = ''; potPile.list = []; potPile.cnt = null;
        }, landed + 120);
      }
      // 호출한 쪽(pushPotToWinners)이 다음 층을 언제 걸지 정하는 기준
      return landed;
    }

    /* ── 딜링 연출 ───────────────────────────────────────────────────
       서버는 "두 장을 다 받은 상태"만 준다. 그대로 그리면 카드가 그냥 생겨 있다.
       실제 딜러처럼 테이블 중앙에서 각 자리로 한 장씩, 두 바퀴 돌며 날린다.
       카드 값 자체는 서버가 준 것만 쓰고 남의 것은 뒷면이라 이 연출이 결과를 노출하지 않는다.

       포커 플립·바카라에서 배운 것: 마지막 장의 콜백에서 연출을 닫으면 아직 날고 있던
       복제본까지 걷어내 끝의 두 장이 툭 생겨난다. 닫는 일은 별도 타이머로 뺀다. */
    /* 한 장씩 도는 간격. 인원에 따라 정한다 — 3인(6장)에 고정 간격을 쓰면 순식간에
       끝나 "사사삭" 소리만 나고, 9인(18장)에 같은 간격을 쓰면 늘어진다.
       총 딜링 시간을 1.3~1.6초에 맞춰, 장당 90~220ms 사이로 조절한다. */
`;
