/* 홀덤 화면 — 오른쪽 패널 (대회 정보·칩 순위).

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
export const SIDE = `    var paidSeat = {}, paidSeatHand = null;
    /* 상금 탭을 마지막으로 그렸을 때의 값 서명. 바운티 획득 표가 살아 있는 값이라
       폴링마다 다시 그려야 하는데, 매번 innerHTML 을 갈아 끼우면 글자가 튄다. */
    var prizeSig = null;
    /* 화면에 그려도 되는 바운티 획득 표. 서버 값을 그대로 쓰지 않는 이유는 스포일러다 —
       정산은 판이 끝나는 순간 확정되지만 화면은 그때부터 카드를 열고 봉투를 여는 중이고,
       그 사이에 이 표가 갱신되면 결과가 오른쪽에서 먼저 새어 나간다. 연출이 끝날 때
       비로소 갈아 끼운다(renderSide 가 정한다). */
    var prizeBoard = null;
    function stackOf(tb, s){
      if (!tb.ended || !tb.result || !tb.result.awards) return s.stack;
      var owed = 0;
      tb.result.awards.forEach(function(a){
        if (a.seat === s.seat) owed += a.amount || 0;
      });
      owed -= (paidSeat[s.seat] || 0);
      return owed > 0 ? Math.max(0, s.stack - owed) : s.stack;
    }

    /* ── 오른쪽 패널 ─────────────────────────────────────────────── */
    /* ── 칩 순위의 스포일러 막기 ──────────────────────────────────────
       판이 끝나면 서버는 그 자리에서 스택을 정산한다. 화면은 그 뒤로도 몇 초 동안
       카드를 한 장씩 열고 팟을 밀어 주는데, 오른쪽 순위가 서버 값을 그대로 쓰면
       카드가 열리기 전에 숫자가 먼저 움직인다 — 누가 이겼는지 거기서 새어 나간다.
       제보로 들어온 그대로다.

       그래서 판이 도는 동안 본 스택을 기억해 두고, 끝난 뒤에는 팟이 승자에게 실제로
       도착할 때까지(potDoneAt) 그 값을 계속 보여준다. 판 중의 스택은 이미 베팅한 만큼
       빠져 있으므로, 그게 곧 "정산 전"의 정확한 값이다.

       화면에 도중부터 들어온 사람은 기억이 없다 — 그때는 서버 값을 쓴다. 그 경우
       스포일러가 될 수 있지만, 이미 결과가 나온 판에 들어온 것이라 숨길 것도 없다. */
    /* ── 총 보유 칩 ──────────────────────────────────────────────────
       순위의 기준은 «앞에 남은 칩» 이 아니라 «이 사람이 가진 칩» 이다. 둘은 판이 도는
       동안 다르다: 베팅한 칩은 좌석에서 빠져 앞에 나가 있고(s.bet), 올인하면 좌석이
       0 이 된다. 그 0 으로 줄을 세우면 판을 지배하고 있는 사람이 꼴찌로 떨어진다 —
       제일 크게 이기고 있는 순간에 순위표에서 사라지는 셈이다.
       포커에서 스택을 셀 때는 언제나 이번 판에 넣은 것까지 함께 센다. 그대로 따른다.

       판이 끝나면 베팅은 이미 팟으로 쓸려 가 s.bet 이 비므로 이 덧셈은 저절로 멎고,
       정산이 끝난 뒤에는 승패가 반영된 s.stack 으로 자연히 넘어간다. */
    function totalChips(s){ return (s.stack || 0) + (s.bet || 0); }
    /* ── 판이 도는 동안의 순위는 «판이 시작될 때» 로 고정한다 ──────────
       매 폴링마다 다시 재면 판 안에서 일어나는 일이 순위표로 새어 나간다:
         · 올인하면 좌석 스택이 0 이 되어 그 순간 꼴찌로 떨어진다 — 제일 크게
           걸고 있는 사람이 사라지는 셈이다
         · 앞 스트리트에 넣은 칩은 stack 에도 bet 에도 없어서 stack+bet 로도 못 메운다
         · 서버가 정산을 끝낸 순간 숫자가 먼저 움직여, 카드가 열리기 전에 승패가 샌다
       판이 시작될 때의 스택이 곧 «이 사람이 이 판에 걸 수 있는 전부» 이고, 판이
       끝나 팟이 실제로 도착할 때까지 그 값은 아직 사실이다. 그 하나만 붙들면
       위의 셋이 한꺼번에 사라진다.
       그래서 handNo 가 바뀔 때 한 번만 찍는다(매 폴링 덮어쓰기가 아니다). */
    var stackMemo = null;      // { handNo, map, remaining, avg, bustedIds }
    function noteStacks(tb){
      if (!tb || tb.handNo == null) return;
      if (stackMemo && stackMemo.handNo === tb.handNo) return;   // 이 판은 이미 찍었다
      if (tb.ended) return;                    // 끝난 판에 들어왔다 — 찍을 «시작» 이 없다
      var map = {};
      (tb.seats || []).forEach(function(s){ map[s.seat] = totalChips(s); });
      var ids = {};
      (tb.busted || []).forEach(function(b){ ids[b.userId] = 1; });
      stackMemo = { handNo: tb.handNo, map: map, remaining: tb.remaining,
        avg: tb.avgStack, bustedIds: ids };
    }
    /* 정산 연출이 끝났나 — 끝났으면 서버 값이 곧 사실이다.
       celebrate.ts 의 settleDone 을 그대로 쓴다(조각들은 한 클로저를 공유한다):
       우승 팝업과 리바이 창이 기다리는 것과 같은 신호여야 셋이 한 박자로 움직인다. */
    function settledNow(tb){
      if (!tb.ended) return false;
      return settleDone(tb);
    }
    function shownStack(tb, s){
      if (settledNow(tb)) return s.stack;
      if (stackMemo && stackMemo.handNo === tb.handNo && stackMemo.map[s.seat] != null) {
        return stackMemo.map[s.seat];
      }
      return totalChips(s);
    }
    /* 이 판에 죽은 사람인가 — 판이 시작될 때는 없던 이름인가로 가른다.
       탈락자 명단을 통째로 붙들면 «지난 판에 죽은 사람» 까지 매 쇼다운마다
       살아 있는 줄로 돌아온다. 새로 는 이름만 늦춘다. */
    function bustedYet(tb, userId){
      if (settledNow(tb)) return true;
      if (!stackMemo || stackMemo.handNo !== tb.handNo) return true;
      return stackMemo.bustedIds[userId] === 1;
    }

    /* ── 상금 구조 ────────────────────────────────────────────────────
       예전에는 "지급 인원 2명"만 적혀 있었다. 몇 등까지 얼마를 받는지 알려면 규칙
       도움말을 열어야 했는데, 그건 판이 도는 중에 볼 것이 못 된다.

       금액은 서버가 계산해 준 것을 그대로 쓴다(t.prizes). 여기서 다시 계산하면 산식이 두
       벌이 되고, 언젠가 화면에 적힌 상금과 실제로 들어오는 상금이 갈라진다 — 그건 표시
       오류가 아니라 거짓말이 된다. 비율만 여기서 만든다(금액 ÷ 풀).

       참가자가 늘면 지급 인원과 금액이 함께 바뀐다. 서버가 매 폴링마다 다시 계산해 주므로
       이 화면도 저절로 따라간다. */
    function prizeRows(t){
      var list = t.prizes || [];
      var pool = t.prizePool || 0;
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var amt = list[i] || 0;
        out.push({
          place: i + 1, amount: amt,
          pct: pool > 0 ? Math.round(amt / pool * 1000) / 10 : 0,
        });
      }
      return out;
    }
    function medal(place){
      return place === 1 ? '🥇' : place === 2 ? '🥈' : place === 3 ? '🥉' : '';
    }
    function prizeListHtml(t){
      var rows = prizeRows(t);
      if (!rows.length) {
        return '<div class="empty" style="padding:14px 0">아직 상금이 정해지지 않았습니다</div>';
      }
      var html = rows.map(function(r){
        return '<div class="ht-pz-row">' +
          '<span class="ht-pz-pl">' + r.place + '위 ' + medal(r.place) + '<\\/span>' +
          '<span class="ht-pz-amt">' + num(r.amount) + 'P<\\/span>' +
          '<span class="ht-pz-pct">' + r.pct + '%<\\/span>' +
          '<\\/div>';
      }).join('');
      /* 못 받는 자리도 한 줄로 적는다. "여기까지"가 보여야 지금 내 자리가 상금권인지
         한눈에 판단된다 — 지급 인원 숫자만으로는 그 경계가 안 잡힌다. */
      if (t.registered > rows.length) {
        html += '<div class="ht-pz-row out">' +
          '<span class="ht-pz-pl">' + (rows.length + 1) + '위 이하<\\/span>' +
          '<span class="ht-pz-amt">—<\\/span>' +
          '<span class="ht-pz-pct">0%<\\/span><\\/div>';
      }
      return html;
    }
    function renderPrizeTab(){
      if (!st || !st.tournament) return;
      var t = st.tournament;
      /* 이 탭은 숫자만 보여준다. 한동안 규칙 설명을 여기 붙여 뒀는데, 좁은 칸에 문장이
         네 줄씩 들어가면서 라벨이 줄바꿈되고("바운티 상 / 금") 정작 금액이 안 보였다.
         규칙은 공지에 적어 두면 되고, 게임 중에 알고 싶은 것은 규칙이 아니라 판세다.

         그래서 위에서 아래로 세 덩어리만 둔다:
           총 상금 = 순위 상금 + 바운티 상금   ← 이 대회가 얼마짜리인가
           누가 얼마를 벌었나 (많이 번 순)      ← 지금 누가 앞서 있나
           등수별 순위 상금                    ← 끝까지 가면 얼마인가

         바운티를 등수 표에 섞지 않는 이유는 그것이 등수가 아니라 KO 로 갈리기 때문이다 —
         1위가 KO 하나 없이 우승할 수 있고, 그때 "1위 상금 + 바운티"는 거짓이 된다. */
      var mystery = t.mode === 'MYSTERY_BOUNTY';
      var isPko = t.mode === 'PKO_BOUNTY' || mystery;
      var btyPool = t.bountyPool || 0;
      /* 순위 상금이 없으면(전액 바운티) 등수 표를 그리지 않는다 — 0P 짜리 표는
         "1위 0P" 라고 적힌 거짓말이 된다. */
      var hasRank = t.prizePool > 0;
      /* 서버 값이 아니라 renderSide 가 걸러 준 값을 쓴다 — 연출이 끝나기 전에 그리면
         결과가 이 표에서 먼저 새어 나간다. 아직 한 번도 안 걸러졌으면(탭을 처음 열었다)
         서버 값을 그대로 쓴다: 그 시점에는 붙들 이전 값이 없다. */
      var board = prizeBoard || t.bountyBoard || [];
      /* 실제로 일어난 리바이 횟수 = 엔트리 수 − 사람 수. 서버가 둘을 다 내려주므로
         빼기 하나로 나온다(따로 필드를 늘리지 않는다). */
      var rbTotal = Math.max(0, (t.totalEntries || 0) - (t.registered || 0));
      prizeTabEl.innerHTML =
        '<div class="ht-pz-head">' +
          '<span>' + (isPko ? '총 상금' : '상금 풀') + ' <b>'
            + num(t.prizePool + (isPko ? btyPool : 0)) + 'P<\\/b><\\/span>' +
          /* 리바이가 있는 판에서는 «참가 7명» 만으로 풀이 설명되지 않는다 —
             110,000P 인데 7명이면 1인당 15,714P 라는 이상한 수가 나온다. 실제 근거는
             엔트리 11(7명 + 리바이 4)이다. 그 4를 적어 두면 곱셈이 맞아떨어진다. */
          '<span>참가 ' + t.registered + '명'
            + (rbTotal > 0 ? ' · 리바이 ' + rbTotal + '회' : '')
            + (hasRank ? ' · 지급 ' + t.itm + '명' : ' · 순위 상금 없음') + '<\\/span>' +
        '<\\/div>' +
        /* 총액만 적으면 "그게 전부인가"가 되고, 갈래만 적으면 이 대회가 얼마짜리인지
           한눈에 안 잡힌다. 한 줄에 등식으로 두면 둘 다 해결된다. */
        (isPko
          ? '<div class="ht-pz-split">' +
              '<span>순위 상금 <b>' + num(t.prizePool) + 'P<\\/b><\\/span>' +
              '<span class="pz-plus">+<\\/span>' +
              '<span class="bty">바운티 <b>' + num(btyPool) + 'P<\\/b><\\/span>' +
            '<\\/div>'
          : '') +
        /* 바운티 획득 현황. 시작 전에는 전원 0 이고 그 0 도 그린다 — "아직 아무도 못
           벌었다"와 "표가 없다"는 다르다. 내 줄만 표시해 두면 눈이 바로 찾는다.
           미스터리는 금액이 감춰져 있어도 이 표는 그린다: 여기 적히는 것은 이미 열린
           봉투에서 나온 돈이라 감출 것이 없다. */
        (isPko && board.length
          ? '<div class="ht-pz-bsec">' +
              /* 내 머리 값은 여기 적지 않는다 — 명찰이 이미 보여주고 있고, 제목 옆에
                 숫자가 하나 더 붙으면 그 줄이 표의 머리인지 정보인지 흐려진다. */
              '<div class="ht-pz-bttl">바운티 획득<\\/div>' +
              '<div class="ht-pz-brows">' +
                board.map(function(r){
                  return '<div class="ht-pz-brow' + (r.won > 0 ? ' has' : '') + '">' +
                    '<span class="nm">' + esc(r.name) + '<\\/span>' +
                    '<b>' + num(r.won) + 'P<\\/b><\\/div>';
                }).join('') +
              '<\\/div>' +
            '<\\/div>'
          : '') +
        (hasRank
          ? '<div class="ht-pz-rsec">' +
              '<div class="ht-pz-bttl">순위 상금<i>등수로 나눕니다<\\/i><\\/div>' +
              '<div class="ht-pz-list">' + prizeListHtml(t) + '<\\/div>' +
            '<\\/div>'
          : '') +
        '<div class="ht-pz-note">' + (isPko
          ? '확보한 바운티는 대회가 끝날 때 한 번에 지급됩니다'
          : t.buyIn > 0
            ? '참가비 ' + num(t.buyIn) + 'P가 그대로 상금이 됩니다'
            : '참가비 없는 프리롤입니다 — 상금은 운영에서 지급합니다') + '<\\/div>';
    }

    function renderSide(){
      var t = st.tournament, tb = st.table;
      sideTitle.textContent = t.title;
      /* 상금 탭이 열려 있으면 값이 바뀔 때 다시 그린다. 예전에는 탭을 누를 때 한 번만
         그렸고 그래도 됐다 — 등수 표는 대회 내내 고정이다. 지금은 바운티 획득 표가
         들어 있어서 KO 마다 값과 순서가 바뀐다(안 그리면 끝까지 전원 0P 로 보인다).

         매 폴링마다 innerHTML 을 갈아 끼우면 1초마다 글자가 튀므로, 실제로 달라졌을
         때만 그린다. 서명은 금액·순서·인원처럼 표에 그려지는 값 전부다. */
      /* ── 스포일러 막기 ────────────────────────────────────────────
         서버는 판이 끝나는 순간 바운티 정산을 확정한다. 화면은 그때부터 보드를 한 장씩
         열고 팟을 옮기고 처형을 하고 봉투를 여는 중이다 — 그 사이에 이 표가 갱신되면
         "카드도 안 열렸는데 누가 이겼는지"가 오른쪽에서 먼저 새어 나간다(제보).
         명찰·확보 표시가 이미 쓰는 것과 같은 규칙을 여기에도 건다: 결과 연출과 처형,
         그리고 미스터리 개봉이 끝날 때까지 직전 값을 그대로 붙들고 있는다. */
      var showBty = settleDone(tb) && Date.now() >= koBurstEndsAt
        && Date.now() >= mysBoxEndsAt;
      if (showBty) prizeBoard = t.bountyBoard || null;
      if (!prizeTabEl.hidden) {
        var sig = [t.prizePool, t.bountyPool, t.registered, t.itm, t.myBounty,
          (prizeBoard || []).map(function(r){ return r.name + ':' + r.won; }).join(',')
        ].join('|');
        if (sig !== prizeSig) { prizeSig = sig; renderPrizeTab(); }
      }
      /* 대회 종료 안내는 오른쪽 패널 머리에 붙인다. 예전에는 펠트 한가운데에
         "대회 종료 · 결과 8초"라고 찍었는데, 테이블 바닥에 시스템 문구가 인쇄된 꼴이라
         마지막 판의 쇼다운 위로 글자가 겹쳤다. 테이블은 게임만 그리는 자리다. */
      /* 남은 초는 적지 않는다. 축하 팝업은 이제 이 카운트다운이 아니라 정산 연출이
         끝나는 시점에 뜨므로(celebrate의 settleDone), 숫자를 적어 두면 그것과
         상관없는 시각을 세는 셈이 된다 — 30초라고 적어 놓고 8초 만에 뜬다. */
      if (tb.tournamentOver) {
        sideNote.hidden = false;
        sideNote.textContent = '대회 종료';
      } else {
        sideNote.hidden = true;
      }
      /* ── 왜 값이 아니라 "구조"로 다시 그리는가 ────────────────────────
         예전에는 완성된 HTML 문자열을 서명으로 삼아, 값이 하나라도 바뀌면 블록을 통째로
         새로 만들었다. 그런데 이 블록 안에는 지급 인원 툴팁이 들어 있다. 마우스를 올린
         채로 블록이 새로 만들어지면 툴팁 DOM 도 함께 새로 생기고, 그 순간 :hover 가
         끊겨 툴팁이 사라졌다 다시 나타난다 — 제보된 "1초마다 깜빡인다"가 이것이다.

         그래서 두 가지를 나눈다. 줄이 생기거나 없어지는 것(구조)만 서명으로 삼아 다시
         그리고, 숫자는 매번 자리에 글자만 갈아 끼운다. 구조는 앤티 유무·레이트 레지
         유무·표시 단위로만 바뀌므로 대부분의 순간에는 아무것도 다시 만들지 않는다. */
      var infoSig = [!!tb.level.ante, t.lateRegLeft != null, unit].join('|');
      var infoHtml =
        '<div class="ht-i"><span class="k">블라인드</span><span class="v gold" id="htBlinds"></span></div>' +
        '<div class="ht-i"><span class="k">레벨</span><span class="v" id="htLevel"></span></div>' +
        /* 블라인드 업까지 남은 시간은 따로 한 줄을 준다. 예전에는 레벨 옆에 10.5px 회색
           <i>로 붙어 있어서 사실상 안 보였다. 이건 다음 판을 어떻게 칠지 정하는 정보다.
           1분 이하면 색을 올리고 깜빡인다. mmss는 항상 5글자라 등폭 폰트에서 폭이 고정된다. */
        /* 초마다 바뀌는 값은 서명에서 뺀다 — 빈 칸으로 그려 두고 아래에서 글자만 채운다.
           안 그러면 이 블록이 매초 통째로 다시 그려지고, 그때마다 지급 인원 툴팁의 DOM 이
           새로 만들어져 마우스를 올린 채로 1초마다 깜빡였다. */
        '<div class="ht-i"><span class="k">블라인드 업</span><span class="v">' +
          '<span class="ht-nextlv" id="htNextLv"></span></span></div>' +
        '<div class="ht-i"><span class="k">남은 인원</span><span class="v" id="htRemain"></span></div>' +
        '<div class="ht-i"><span class="k">평균 스택</span><span class="v" id="htAvg"></span></div>' +
        '<div class="ht-i"><span class="k">상금 풀</span><span class="v gold" id="htPool"></span></div>' +
        /* 지급 인원 옆에 등수별 금액을 붙인다. 숫자만 있으면 "2명"이 몇 등까지인지,
           얼마씩인지가 안 보인다. 마우스를 올렸을 때만 펼쳐서 평소에는 조용히 둔다.
           툴팁 안쪽도 내용이 바뀔 때만 갈아 끼운다 — 매번 새로 쓰면 마우스를 올린 채로
           내용이 한 번 사라졌다 돌아온다. */
        '<div class="ht-i ht-i-pz"><span class="k">지급 인원 <i class="ht-help">ⓘ</i></span>' +
          '<span class="v" id="htItm"></span>' +
          '<div class="ht-tip" id="htPzTip"></div></div>' +
        (t.lateRegLeft != null
          ? '<div class="ht-i late"><span class="k">LATE REG</span>' +
            '<span class="v" id="htLateLeft"></span></div>'
          : '') +
        '<div class="ht-i"><span class="k">표시 단위</span>' +
          '<span class="v"><button type="button" class="ht-unit" id="htUnit">' +
          (unit === 'chip' ? '칩' : 'BB') + '</button></span></div>';
      if (infoEl.dataset.sig !== infoSig) {
        infoEl.dataset.sig = infoSig;
        infoEl.innerHTML = infoHtml;
        // 버튼이 새로 만들어질 때만 이벤트를 다시 붙인다
        document.getElementById('htUnit').addEventListener('click', function(){
          unit = unit === 'chip' ? 'bb' : 'chip';
          render();
        });
      }
      /* 값은 자리에 글자만 갈아 끼운다 — 요소를 다시 만들지 않으므로 툴팁이 끊기지 않는다 */
      var put = function(id, text){
        var e = document.getElementById(id);
        if (e && e.textContent !== text) e.textContent = text;
      };
      put('htBlinds', num(tb.level.sb) + ' / ' + num(tb.level.bb)
        + (tb.level.ante ? ' (앤티 ' + num(tb.level.ante) + ')' : ''));
      put('htLevel', 'Level ' + tb.level.level);
      /* 남은 인원과 평균 스택도 정산 전에는 판 시작 값이다 — 팟이 아직 안 갔는데
         «6 / 7명» 으로 줄면 그 숫자 하나가 «누가 죽었다» 를 먼저 말한다. */
      var stSet = settledNow(tb);
      var remN = (!stSet && stackMemo && stackMemo.handNo === tb.handNo)
        ? stackMemo.remaining : tb.remaining;
      var avgN = (!stSet && stackMemo && stackMemo.handNo === tb.handNo)
        ? stackMemo.avg : tb.avgStack;
      put('htRemain', remN + ' / ' + t.registered + '명');
      put('htAvg', stackText(avgN));
      put('htPool', num(t.prizePool) + 'P');
      put('htItm', t.itm + '명');
      var tip = document.getElementById('htPzTip');
      var tipHtml = prizeListHtml(t);
      if (tip && tip.dataset.sig !== tipHtml) { tip.dataset.sig = tipHtml; tip.innerHTML = tipHtml; }
      var nx = document.getElementById('htNextLv');
      if (nx) {
        if (tb.nextLevelIn == null) {
          nx.textContent = '최종 레벨';
          nx.className = 'ht-nextlv done';
        } else {
          nx.textContent = mmss(tb.nextLevelIn);
          nx.className = 'ht-nextlv' + (tb.nextLevelIn <= 60 ? ' soon' : '');
        }
      }
      var lr = document.getElementById('htLateLeft');
      if (lr && t.lateRegLeft != null) lr.textContent = mmss(t.lateRegLeft);

      /* 칩 순위 — 스택 많은 순. 번호·아바타·이름·스택 한 줄.
         스택은 shownStack 을 쓴다: 판이 끝나고 팟이 아직 승자에게 안 갔으면 마지막으로
         본 값을 그대로 둔다(아래 noteStacks 를 보라). 서버 값을 바로 쓰면 카드가 열리기
         전에 숫자가 먼저 움직여서 누가 이겼는지 여기서 새어 나간다. */
      noteStacks(tb);
      /* 방금 탈락한 사람은 좌석 목록에도 남아 있다(끝난 판의 쇼다운을 그리려고 서버가
         남겨 둔다). 그대로 두면 같은 사람이 위아래 두 번 나온다 — 아래 탈락자 줄에만
         세운다. */
      /* 이름 뒤에 리바이 횟수를 괄호로 붙인다 — «미리보기 (1)».
         칩 순위는 «누가 얼마를 들고 있나» 를 보는 자리인데, 리바이가 열린 판에서는
         스택만으로 판단이 안 된다: 같은 600칩이라도 처음부터 버틴 600 과 방금 10,000P
         를 더 넣고 받은 600 은 다른 사실이다. 값을 치른 횟수가 스택 옆에 있어야
         순위표가 지금까지의 이야기가 된다.
         0 이면 아무것도 안 붙인다 — 프리즈아웃에서는 줄마다 뜻 없는 (0) 이 붙는다. */
      var rbBy = {};
      ((t && t.players) || []).forEach(function(p){ if (p.rebuys > 0) rbBy[p.userId] = p.rebuys; });
      function nameHtml(s){
        var n = rbBy[s.userId];
        return '<span class="ht-rw-nm">' + esc(s.username)
          + (n ? '<i class="ht-rw-rb">(' + n + ')</i>' : '') + '</span>';
      }
      var outIds = {};
      (tb.busted || []).forEach(function(b){ if (bustedYet(tb, b.userId)) outIds[b.userId] = 1; });
      var rows = (tb.seats||[]).filter(function(s){ return !outIds[s.userId]; })
        .sort(function(a,b){ return shownStack(tb, b) - shownStack(tb, a); });
      var rankHtml = rows.map(function(s, i){
        return '<div class="ht-rw' + (s.userId === MEID ? ' me' : '') + '">' +
          '<span class="ht-rw-n">' + (i+1) + '</span>' +
          avatarHtml(s.userId, s.avatar, s.username, 'ht-rw-av') +
          nameHtml(s) +
          '<span class="ht-rw-st">' + stackText(shownStack(tb, s)) + '</span>' +
          '</div>';
      }).join('');
      /* 탈락자는 지우지 않고 아래에 남긴다 — 늦게 나간 사람이 위다(오래 버텼다).
         칩은 0, 이름에 취소선, 줄 전체를 가라앉힌다. 살아 있는 사람과 한눈에 갈려야 하고,
         동시에 "여기 있었다"는 사실은 남아야 한다. */
      var out = (tb.busted || []).filter(function(b){ return bustedYet(tb, b.userId); });
      rankHtml += out.map(function(s, i){
        return '<div class="ht-rw out' + (s.userId === MEID ? ' me' : '') + '">' +
          '<span class="ht-rw-n">' + (rows.length + i + 1) + '</span>' +
          avatarHtml(s.userId, s.avatar, s.username, 'ht-rw-av') +
          nameHtml(s) +
          '<span class="ht-rw-st">' + stackText(0) + '</span>' +
          '</div>';
      }).join('');
      if (!rankHtml) rankHtml = '<div class="empty" style="padding:14px 0">아직 없습니다</div>';
      if (rankEl.dataset.sig !== rankHtml) { rankEl.dataset.sig = rankHtml; rankEl.innerHTML = rankHtml; }
      backBtn.hidden = tb.myPresence !== 'SIT_OUT';
    }

    /* ── 테이블 ───────────────────────────────────────────────────── */
    /* ── 보드를 한 장씩 깐다 ─────────────────────────────────────────
       서버는 플랍 세 장을 한꺼번에 준다(스트리트 단위로 상태가 바뀐다).
       그대로 그리면 프리플랍이 끝난 순간 세 장이 뿅 나타난다.
       그래서 클라이언트가 "지금 몇 장까지 보여줄지"를 따로 들고, 남은 장을
       한 장씩 늘려가며 깐다. 서버는 초 단위 해상도라 이 박자는 클라이언트 몫이다. */
`;
