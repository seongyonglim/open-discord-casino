/* 홀덤 화면 — 오른쪽 패널 (대회 정보·칩 순위).

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
export const SIDE = `    var paidSeat = {}, paidSeatHand = null;
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
    var stackMemo = null;      // { handNo, map }
    function noteStacks(tb){
      if (!tb || tb.handNo == null) return;
      if (tb.ended) return;                    // 끝난 뒤에는 갱신하지 않는다 — 그게 요점이다
      var map = {};
      (tb.seats || []).forEach(function(s){ map[s.seat] = s.stack; });
      stackMemo = { handNo: tb.handNo, map: map };
    }
    function shownStack(tb, s){
      if (!tb.ended) return s.stack;
      // 팟이 승자에게 도착했으면 이제 진짜 값을 보여 준다
      if (potDoneHand === tb.handNo && potDoneAt && Date.now() >= potDoneAt) return s.stack;
      if (stackMemo && stackMemo.handNo === tb.handNo && stackMemo.map[s.seat] != null) {
        return stackMemo.map[s.seat];
      }
      return s.stack;
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
      /* PKO 는 머리에 "상금 풀"만 적으면 안 된다. 걷은 돈의 절반이 현상금으로 빠져 있어서,
         상금 풀 25,000P 만 보이면 이 대회가 25,000P 짜리로 읽힌다 — 실제로는 50,000P 다.
         그래서 머리에는 총액을 적고, 그 아래 한 줄로 두 갈래를 나눈다.

         등수별 표에 바운티를 섞지 않는다. 바운티는 등수가 아니라 KO 로 갈리므로
         "1위 16,250P + 바운티"처럼 적으면 1위가 바운티를 반드시 받는 것처럼 읽힌다 —
         실제로는 1위가 KO 하나도 못 하고 우승할 수 있다(그때도 자기 머리 값은 회수한다).
         갈래가 다른 돈은 줄을 나눠 적는 편이 정확하다. */
      /* 바운티가 걸린 판인가 / 그중 미스터리인가. 두 모드 모두 순위 상금을 함께 둘 수
         있으므로, 갈래를 나눠 적을지는 모드가 아니라 순위 상금이 실제로 있는지로 가른다
         (전액 바운티면 0P 짜리 등수 표가 "1위 0P" 라는 거짓말이 된다). */
      var mystery = t.mode === 'MYSTERY_BOUNTY';
      var isPko = t.mode === 'PKO_BOUNTY' || mystery;
      var btyPool = t.bountyPool || 0;
      var hasRank = t.prizePool > 0;
      prizeTabEl.innerHTML =
        '<div class="ht-pz-head">' +
          '<span>' + (isPko ? '총 상금' : '상금 풀') + ' <b>'
            + num(t.prizePool + (isPko ? btyPool : 0)) + 'P<\\/b><\\/span>' +
          /* 전액 바운티 판에는 등수로 주는 상금이 없으니 "지급 N명"이 거짓이 된다 */
          '<span>참가 ' + t.registered + '명'
            + (hasRank ? ' · 지급 ' + t.itm + '명' : ' · 순위 상금 없음') + '<\\/span>' +
        '<\\/div>' +
        /* 총액만 적으면 "그게 전부인가"가 되고, 갈래만 적으면 이 대회가 얼마짜리인지
           한눈에 안 잡힌다. 한 줄에 등식으로 두면 둘 다 해결된다.
           바운티를 등수 표에 섞지 않는 이유는 그것이 등수가 아니라 KO 로 갈리기 때문이다 —
           1위가 KO 하나 없이 우승할 수 있고, 그때 "1위 상금 + 바운티"는 거짓이 된다.
           대신 표 위에 "순위 상금"이라고 적어 이 표가 어느 갈래인지 못 박는다. */
        (isPko && hasRank
          ? '<div class="ht-pz-split">' +
              '<span>순위 상금 <b>' + num(t.prizePool) + 'P<\\/b><\\/span>' +
              '<span class="pz-plus">+<\\/span>' +
              '<span class="bty">바운티 상금 <b>' + num(btyPool) + 'P<\\/b><\\/span>' +
            '<\\/div>' +
            '<div class="ht-pz-sub">순위 상금 — 등수로 나눕니다<\\/div>'
          : '') +
        /* 순위 상금이 없으면 등수 표를 그리지 않는다 — 0P 짜리 표는
           "1위 0P" 라고 적힌 거짓말이 된다. */
        (hasRank ? '<div class="ht-pz-list">' + prizeListHtml(t) + '<\\/div>' : '') +
        /* PKO 는 참가비의 절반이 현상금으로 빠지므로, 상금표만 보면 "참가비 만 원인데
           상금이 왜 반이지"가 된다. 빠진 절반이 어디 있는지와 그것이 어떻게 오는지를
           같은 자리에 적는다 — 이 블록이 유저가 상금 구조를 확인하는 유일한 곳이다.
           (한동안 화면에 바운티 이야기가 아예 없었다. 걷은 돈의 절반이 설명 없이
            사라진 것으로 보였다.) */
        (isPko
          ? '<div class="ht-pz-bty">' +
              /* 총 현상금 옆에 내가 이미 챙긴 몫을 붙인다 — 전체 중 얼마를 가져왔는지가
                 한 줄에서 읽힌다. 따로 떨어뜨려 두면 두 숫자를 눈으로 비교해야 한다. */
              '<div class="ht-pz-bty-h">바운티 상금 <b>' + num(btyPool) + 'P<\\/b>'
                + (t.myBountyWon > 0
                  ? '<em>내가 획득 ' + num(t.myBountyWon) + 'P<\\/em>' : '') + '<\\/div>' +
              /* 내 봉투/머리 값은 따로 둔다 — 아직 지갑에 없는 돈이라 위의 "획득"과
                 성격이 다르다. 합쳐 적으면 이미 다 받은 것으로 읽는다.
                 미스터리는 금액 자체를 모르므로 물음표를 적는다. */
              '<div class="ht-pz-mine">' +
                '<span>' + (mystery ? '내 봉투' : '내 머리에 걸린 값') + ' <b>'
                  + (t.myBounty == null ? '?' : num(t.myBounty) + 'P') + '<\\/b>'
                  + '<i>' + (mystery ? '잡히거나 우승할 때 열립니다' : '대회가 끝날 때 정산')
                  + '<\\/i><\\/span>' +
              '<\\/div>' +
              /* 규칙은 짧은 줄로 나눠 적는다. 예전에는 한 문단이라 읽히지 않았고,
                 "참가비 10,000P 중…" 으로 시작해서 프리롤에서는 거짓이 됐다(참가비가 없다).
                 그래서 금액의 출처를 말하지 않고 규칙만 적는다 — 출처는 위의 갈래 줄이
                 이미 보여준다. */
              '<div class="ht-pz-bty-b">' + (mystery
                ? '<b>모두의 바운티 금액이 다르고, 잡히기 전까지 비공개입니다.<\\/b><br>'
                  + '· 상대를 탈락시키면 그 사람 봉투가 열리고 <b>전액을 받습니다<\\/b><br>'
                  + '· 내 봉투는 <b>우승하면 내가 받습니다<\\/b><br>'
                  /* 잡은 사람이 봉투를 독식하므로 내 머리 값은 오르지 않는다 —
                     PKO 와 다른 유일한 규칙이라 반드시 적어 준다. */
                  + (hasRank
                    ? '· 순위 상금은 등수로 따로 나눕니다'
                    : '· 순위 상금은 없습니다 — 끝까지 버티면 본전, 잡으면 그만큼 법니다')
                : '· 상대를 탈락시키면 그 사람 바운티의 <b>절반을 즉시 받습니다<\\/b><br>'
                  + '· 남은 절반은 <b>내 바운티에 얹힙니다<\\/b><br>'
                  + '· 내 바운티는 <b>우승하면 전부 받습니다<\\/b>')
              + '<\\/div>' +
            '<\\/div>'
          : '') +
        '<div class="ht-pz-note">' + (isPko
          ? '걷은 바운티는 1P도 남지 않고 참가자에게 돌아갑니다'
          : t.buyIn > 0
            ? '참가비 ' + num(t.buyIn) + 'P가 그대로 상금이 됩니다'
            : '참가비 없는 프리롤입니다 — 상금은 운영에서 지급합니다') + '<\\/div>';
    }

    function renderSide(){
      var t = st.tournament, tb = st.table;
      sideTitle.textContent = t.title;
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
      put('htRemain', tb.remaining + ' / ' + t.registered + '명');
      put('htAvg', stackText(tb.avgStack));
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
      var outIds = {};
      (tb.busted || []).forEach(function(b){ outIds[b.userId] = 1; });
      var rows = (tb.seats||[]).filter(function(s){ return !outIds[s.userId]; })
        .sort(function(a,b){ return shownStack(tb, b) - shownStack(tb, a); });
      var rankHtml = rows.map(function(s, i){
        return '<div class="ht-rw' + (s.userId === MEID ? ' me' : '') + '">' +
          '<span class="ht-rw-n">' + (i+1) + '</span>' +
          avatarHtml(s.userId, s.avatar, s.username, 'ht-rw-av') +
          '<span class="ht-rw-nm">' + esc(s.username) + '</span>' +
          '<span class="ht-rw-st">' + stackText(shownStack(tb, s)) + '</span>' +
          '</div>';
      }).join('');
      /* 탈락자는 지우지 않고 아래에 남긴다 — 늦게 나간 사람이 위다(오래 버텼다).
         칩은 0, 이름에 취소선, 줄 전체를 가라앉힌다. 살아 있는 사람과 한눈에 갈려야 하고,
         동시에 "여기 있었다"는 사실은 남아야 한다. */
      var out = tb.busted || [];
      rankHtml += out.map(function(s, i){
        return '<div class="ht-rw out' + (s.userId === MEID ? ' me' : '') + '">' +
          '<span class="ht-rw-n">' + (rows.length + i + 1) + '</span>' +
          avatarHtml(s.userId, s.avatar, s.username, 'ht-rw-av') +
          '<span class="ht-rw-nm">' + esc(s.username) + '</span>' +
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
