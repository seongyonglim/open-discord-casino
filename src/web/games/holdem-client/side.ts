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
      var infoHtml =
        '<div class="ht-i"><span class="k">블라인드</span><span class="v gold">' +
          num(tb.level.sb) + ' / ' + num(tb.level.bb) +
          (tb.level.ante ? ' <i>앤티 ' + num(tb.level.ante) + '</i>' : '') + '</span></div>' +
        '<div class="ht-i"><span class="k">레벨</span><span class="v">Level ' + tb.level.level + '</span></div>' +
        /* 블라인드 업까지 남은 시간은 따로 한 줄을 준다. 예전에는 레벨 옆에 10.5px 회색
           <i>로 붙어 있어서 사실상 안 보였다. 이건 다음 판을 어떻게 칠지 정하는 정보다.
           1분 이하면 색을 올리고 깜빡인다. mmss는 항상 5글자라 등폭 폰트에서 폭이 고정된다. */
        '<div class="ht-i"><span class="k">블라인드 업</span><span class="v">' +
          (tb.nextLevelIn == null
            ? '<span class="ht-nextlv done">최종 레벨</span>'
            : '<span class="ht-nextlv' + (tb.nextLevelIn <= 60 ? ' soon' : '') + '">' +
              mmss(tb.nextLevelIn) + '</span>') + '</span></div>' +
        '<div class="ht-i"><span class="k">남은 인원</span><span class="v">' + tb.remaining +
          ' / ' + t.registered + '명</span></div>' +
        '<div class="ht-i"><span class="k">평균 스택</span><span class="v">' + stackText(tb.avgStack) + '</span></div>' +
        '<div class="ht-i"><span class="k">상금 풀</span><span class="v gold">' + num(t.prizePool) + 'P</span></div>' +
        '<div class="ht-i"><span class="k">지급 인원</span><span class="v">' + t.itm + '명</span></div>' +
        (t.lateRegLeft != null
          ? '<div class="ht-i late"><span class="k">LATE REG</span><span class="v">' + mmss(t.lateRegLeft) + '</span></div>'
          : '') +
        '<div class="ht-i"><span class="k">표시 단위</span>' +
          '<span class="v"><button type="button" class="ht-unit" id="htUnit">' +
          (unit === 'chip' ? '칩' : 'BB') + '</button></span></div>';
      if (infoEl.dataset.sig !== infoHtml) {
        infoEl.dataset.sig = infoHtml;
        infoEl.innerHTML = infoHtml;
        // 버튼이 새로 만들어질 때만 이벤트를 다시 붙인다
        document.getElementById('htUnit').addEventListener('click', function(){
          unit = unit === 'chip' ? 'bb' : 'chip';
          render();
        });
      }

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
