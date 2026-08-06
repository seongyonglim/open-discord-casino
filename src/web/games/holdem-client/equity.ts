/* 홀덤 화면 — 승률·아웃츠 말풍선.

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
export const EQUITY = `    var RANK_CH = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
    var SUIT_CH = ['\\u2660', '\\u2665', '\\u2666', '\\u2663'];
    function syncEquity(tb){
      var stages = (tb.ended && tb.result && tb.result.equity) || [];
      var stage = null;
      /* 언제까지 띄우나 — WIN 배지가 뜨는 순간까지다.
         예전에는 정산이 시작될 때(potPaidHand) 내렸는데, 그보다 앞서 리버가 열리는
         순간 이미 사라졌다. boardLen 5 단계가 없어서 "지금 깔린 장수에 맞는 단계"를
         못 찾았기 때문이다. 마지막 카드를 보고 "그래서 누가 이겼나"를 스스로 계산해야
         하는 몇 초가 거기서 생겼다 — 답은 이미 나와 있는데 화면이 먼저 치운 것이다.
         이제 100.00%와 DRAWING DEAD가 남아 있다가, 승자 표시(WIN)가 그 자리를
         이어받을 때 내려간다. 말풍선의 수명이 "승률 계산"이 아니라 "승자 연출"에
         묶인다.

         핸드가 다 열린 뒤부터다 — 프리플랍 올인에는 boardLen 0 단계가 있어서,
         이 문이 없으면 아직 뒷면인 패의 승률이 카드보다 먼저 뜬다. */
      if (stages.length && badgeShownHand !== tb.handNo && holesRevealed()) {
        for (var i = 0; i < stages.length; i++) {
          if (stages[i].boardLen === shownBoard) { stage = stages[i]; break; }
        }
      }
      var byS = {}, outs = {};
      if (stage) {
        stage.seats.forEach(function(x){ byS[x.seat] = x; });
        (stage.outs || []).forEach(function(o){ outs[o.seat] = o; });
      }
      /* 지금 앞선 사람이 누구인지 — 말풍선의 색을 가르는 기준이다.
         승률이 가장 높은 사람(들)이 초록, 나머지는 붉은 쪽이다. */
      var top = 0;
      Object.keys(byS).forEach(function(k){ if (byS[k].equity > top) top = byS[k].equity; });

      (tb.seats || []).forEach(function(s){
        var seatEl = seatsEl.querySelector('.ht-seat[data-seat="' + s.seat + '"]');
        var el = seatEl && seatEl.querySelector('.ht-eq');
        if (!el) return;
        var e = byS[s.seat];
        /* 말풍선이 떠 있는 동안에는 좌석 전체를 위로 올린다.
           말풍선은 좌석 밖으로 뻗어 나가는데, 좌석끼리는 형제라서 나중에 그려진 좌석이
           이깁니다 — 6시 자리(내 자리)의 말풍선이 옆 좌석의 프로필·카드 뒤로 묻혔다.
           좌석 안에서 z-index를 아무리 올려도 소용없다. 올려야 하는 것은 좌석 자체다. */
        seatEl.classList.toggle('eqon', !!e);
        if (!e) { el.hidden = true; return; }
        var pct = Math.round(e.equity * 1000) / 10;
        var lead = e.equity >= top - 1e-9;
        var o = outs[s.seat];
        var body = '';
        if (lead) {
          // 앞선 쪽 — 숫자 하나면 된다. 이 사람에게 남은 관심사는 "얼마나 안전한가"뿐이다
          body = '<span class="ht-eq-p">' + pct.toFixed(1) + '%</span>';
        } else if (pct <= 0) {
          /* 역전할 카드가 한 장도 없다. 0.0%를 적는 것보다 이름을 붙이는 것이 낫다 —
             포커에서 이 상태에는 이미 이름이 있다.
             폭발 안에 넣는다(.ht-eq-outs) — 가장 절박한 상태인데 배경 없는 글자로
             두면 다른 말풍선들 사이에서 오히려 가장 조용해진다. */
          body = '<span class="ht-eq-outs"><span class="ht-eq-dead">DRAWING DEAD<\/span><\/span>';
        } else {
          /* 쫓는 쪽 — 숫자보다 "무엇이 나와야 하나"가 먼저다. 실제 카드를 그린다.
             글자로 "아웃 8장 · A K"라고 적던 것을 없앴다. 카드 게임인데 카드를 글자로
             옮겨 적으면 한 번 더 번역해서 읽어야 한다.
             한 무늬가 통째로 아웃이면(플러시 드로우) 무늬 하나로 줄인다. */
          var mini = '';
          (o && o.bySuit || []).forEach(function(su){
            mini += '<i class="ht-oc suit s' + su + '">' + SUIT_CH[su] + '<\/i>';
          });
          var cards = (o && o.cards) || [];
          /* 열 장까지 그린다 — 다섯 장씩 두 줄이다(줄바꿈은 .ht-oc-row의 max-width가 정한다).
             그보다 많으면 마지막 칸을 +N으로 접는다. 한 줄로 계속 늘리면 말풍선이 옆자리까지
             뻗고, 줄이 셋이 되면 좌석을 통째로 덮어서 카드가 몇 장인지도 안 읽힌다.
             무늬로 묶인 것은 카드 여러 장을 대신하므로 두 칸을 쓴 것으로 친다. */
          var room = 10 - ((o && o.bySuit) || []).length * 2;
          cards.slice(0, Math.max(0, room)).forEach(function(c){
            var su = c & 3;
            mini += '<i class="ht-oc s' + su + '">' + RANK_CH[c >> 2] +
              '<b>' + SUIT_CH[su] + '<\/b><\/i>';
          });
          if (cards.length > room && room > 0) {
            mini += '<i class="ht-oc more">+' + (cards.length - room) + '<\/i>';
          }
          /* 승률은 폭발 안, 카드 아래 가운데다. 밖에 두었더니 말풍선과 숫자가 서로 다른
             두 물체로 보였고, 좌석이 몰린 곳에서는 옆 사람 말풍선의 숫자와 헷갈렸다. */
          body = '<span class="ht-eq-outs">'
            + '<span class="ht-oc-row">' + mini + '<\/span>'
            + '<span class="ht-eq-p">' + pct.toFixed(1) + '%<\/span>'
            + '<\/span>';
        }
        el.hidden = false;
        // 좌우 위치 클래스는 골격이 정해 준 것이니 건드리지 않고 상태만 토글한다
        el.classList.toggle('lead', lead);
        el.classList.toggle('chase', !lead);
        el.title = o ? '이 카드가 나오면 이깁니다 (' + o.count + '장): ' + o.ranks.join(', ') : '';
        el.innerHTML = body;
      });
    }

    /* ── 좌석판 위 행동 배지 ──────────────────────────────────────────
       행동한 순간 좌석판 위에 뜨고 스스로 사라진다(CSS 애니메이션이 페이드까지 맡는다).
       예전에는 베팅 자리에 계속 남아서, 이미 지나간 "체크"가 판이 끝날 때까지 붙어 있었다.

       올인만 계속 남긴다 — 판이 끝날 때까지 유효한 사실이고, 남은 사람들이 무엇을 상대로
       겨루는지 알아야 한다. 나머지는 방금 일어난 일이라 잠깐 보이면 된다.

       열쇠는 (스트리트 · 자리 · 행동 · 금액)이다. 금액을 넣는 이유는 한 스트리트에서
       같은 자리가 콜 → 레이즈 → 콜을 할 수 있어서, 행동 이름만으로는 새 행동인지
       구분되지 않기 때문이다(액션 음성과 같은 규칙이다). */
`;
