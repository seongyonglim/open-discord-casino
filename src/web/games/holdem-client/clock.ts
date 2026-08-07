/* 홀덤 화면 — 차례 시간 바.

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
export const CLOCK = `    function turnLeft(tb){
      // 마감까지 남은 초. 상한이 벗겨진 값이라 차례가 열리기 전 구간에서는 20을 넘는다.
      if (!tb || tb.actionLeft == null) return null;
      return tb.actionLeft + (tb.actOpenIn || 0);
    }
    function turnStamp(tb){
      // 마감 시각 자체(서버 초). 한 차례 안에서는 상수다 — serverNow 가 1 늘면 남은 초가
      // 1 줄어 합이 보존된다. 그래서 드래그 중에 열쇠가 바뀌어 초기화되는 일이 없다.
      var left = turnLeft(tb);
      return left == null ? null : st.serverNow + left;
    }
    var CLOCK_WARN_SEC = 5;    // 바가 붉어지고 점멸하는 시점
    var CLOCK_TICK_SEC = 4.5;  // 똑딱 소리가 시작되는 시점 (음원 길이에 맞춘 값)
    var clockBase = null;      // { key, dl, seat, left, at, total }
    // 화면에 그린 마지막 게이지 비율과 그것이 어느 차례의 것인지 (단조 감소 보장용)
    var fracKey = null, fracLast = 1;
    var clockWarned = null;    // 이미 경고를 낸 차례의 열쇠 — 한 차례에 한 번만 울린다
    /* 내 차례 알림을 이미 낸 차례. 시계 경고와 열쇠는 같지만 따로 둔다 — 하나는 차례가
       열릴 때, 하나는 5초 남았을 때라 시점이 다르다. */
    var myTurnRung = null;
    function noteClock(tb){
      if (!tb || tb.toActSeat == null || tb.actionLeft == null || tb.ended) {
        clockBase = null;
        return;
      }
      /* ── 왜 기준점을 쉽게 다시 잡지 않는가 ─────────────────────────
         서버가 주는 actionLeft 는 초 단위 정수다(deadline - Math.floor(now)).
         예전에는 그 값이 바뀔 때마다 기준점을 다시 잡았다 — 남은 초가 매초 줄어드니
         사실상 매 폴링마다 다시 잡은 셈이다. 그런데 정수로 자른 값은 화면이 보간해
         내려온 실수값보다 최대 1초까지 클 수 있다. 그 순간 게이지가 뒤로 튄다:

           화면 12.4초 진행 중 → 서버가 13 을 주면 기준점이 13 으로 올라간다
           → 게이지가 0.6초분 다시 차오르고 나서 또 줄어든다

         제보된 "잠깐 다시 차올랐다 줄어든다"가 정확히 이것이다.

         이제 차례가 바뀔 때만 새로 잡는다. 차례는 마감 시각으로 가른다 — turnStamp 를
         보라. (자리 · 판 · 스트리트)로는 부족하다. 한 자리가 같은 스트리트에서 두 번 이상
         말하기 때문이다(베팅 → 상대 리레이즈 → 콜). 그 사이 행동자의 차례를 폴링이 못 보면
         (advanceHoldem 이 내 폴링 안에서 봇의 액션을 처리해 버리므로 실제로 못 볼 수 있다)
         열쇠가 그대로여서 새 차례의 20초가 "늘어나는 값"으로 버려지고, 게이지는 지난 차례의
         남은 시간에서 계속 줄어든다 — 살아 있는 차례에 빈 바가 서 있게 된다.

         같은 차례 안에서는 서버 값을 "더 줄일 때만" 받아들인다. 늦게 도착한 응답이나
         시계 차이로 화면이 실제보다 느긋해질 수는 있는데, 그건 서버가 마감을 판정하는
         순간과 어긋나므로 따라잡아야 한다. 반대로 늘리는 것은 받지 않는다 —
         한 차례 안에서 게이지는 단조 감소여야 한다.
         (실제 마감 판정은 서버의 action_deadline 이 하고, 여기는 화면만 다룬다.) */
      var full = turnLeft(tb), dl = turnStamp(tb);
      var key = tb.toActSeat + ':' + dl;
      if (clockBase && clockBase.key === key) {
        var shown = clockBase.left - (Date.now() - clockBase.at) / 1000;
        if (full < shown) { clockBase.left = full; clockBase.at = Date.now(); }
        return;
      }
      /* 지나간 차례로 되돌아가지 않는다. 정산 연출 잠금(settleBusy)이 붙잡아 둔 응답은
         최대 LOCK_MAX_MS(20초) 묵은 것이라 이미 끝난 차례의 마감을 들고 올 수 있다. */
      if (clockBase && dl < clockBase.dl) return;
      /* 기준점은 상한이 벗겨진 값(full)으로 잡는다.
         스트리트가 열리는 구간에서 actionLeft 는 STREET_OPEN_SEC(3초) 동안 20에 붙어 있다.
         그 20을 기준점으로 잡으면 마감이 3초 더 남았는데도 바가 비고, 그 뒤 3초를 빈 채로
         서 있으며, 경고색과 똑딱 소리도 3초 일찍 난다 — 게다가 그 구간에서는 서버 값이
         화면값보다 항상 3 크므로 위의 "줄일 때만 수용"이 영원히 성립하지 않아 교정될
         기회조차 없다. full 로 잡으면 이 구간의 비율이 1을 넘고 paintClock 이 1로 자른다:
         차례가 열릴 때까지 바는 꽉 찬 채로 서 있다가 열리는 순간부터 정확히 20초를 줄어든다. */
      clockBase = {
        key: key, dl: dl, seat: tb.toActSeat, left: full, at: Date.now(),
        total: tb.actionSec || 20,
      };

      /* 내 차례가 열렸으면 한 번 알린다.
         차례의 주인에게만 낸다 — 남의 차례까지 울리면 알림이 아니라 소음이고, 무엇보다
         "내가 눌러야 한다"는 뜻이 사라진다. 시계 경고(clock-warn)가 누구 차례든 울리는
         것과 반대다: 그건 "곧 자동으로 넘어간다"는 판 전체의 소식이고, 이건 나에게만
         해당하는 요구다.

         화면에 처음 들어온 순간에는 울리지 않는다(firstTablePaint). 이미 진행 중이던
         내 차례를 뒤늦게 알리는 것은 알림이 아니라 놀람이다. */
      if (tb.toActSeat === tb.mySeat && myTurnRung !== key && !firstTablePaint) {
        myTurnRung = key;
        if (window.casinoSfx && window.casinoSfx.myTurn) window.casinoSfx.myTurn();
      }
    }
    function paintClock(){
      var seats = seatsEl.querySelectorAll('.ht-seat');
      if (!clockBase) {
        seats.forEach(function(el){
          var b = el.querySelector('.ht-tbar'); if (b) b.hidden = true;
        });
        return;
      }
      var left = clockBase.left - (Date.now() - clockBase.at) / 1000;
      if (left < 0) left = 0;
      var frac = clockBase.total > 0 ? left / clockBase.total : 0;
      if (frac > 1) frac = 1;
      /* 한 차례 안에서 게이지는 절대 늘지 않는다.
         위 noteClock 이 기준점을 함부로 안 흔들도록 고쳤지만, 여기서 한 겹 더 막는다 —
         계산이 어디서 튀든(늦게 온 응답·시계 보정·탭이 백그라운드에서 돌아온 직후)
         화면에 그리는 값은 내려가기만 한다. 눈에 보이는 것을 보장하는 쪽이 여기다.
         차례가 바뀌면 열쇠가 달라지므로 다시 100%에서 시작한다. */
      if (fracKey === clockBase.key) { if (frac > fracLast) frac = fracLast; }
      else { fracKey = clockBase.key; }
      fracLast = frac;
      /* 색과 소리의 시점을 따로 둔다.
         색은 5초부터 — 눈으로 먼저 알아채는 게 낫다.
         소리는 4.5초부터 — 음원의 들리는 길이가 3.75초라(4.63초 파일에서 앞뒤 무음을
         잘라낸 값), 4.5초에 시작하면 0.75초쯤 남기고 끝난다. 5초에 시작하면 1.25초를
         남기고 조용해져서 "아직 시간이 남았나" 싶은 공백이 생긴다. */
      var warn = left <= CLOCK_WARN_SEC;
      var tick = left <= CLOCK_TICK_SEC;
      seats.forEach(function(el){
        var b = el.querySelector('.ht-tbar');
        if (!b) return;
        var mine = Number(el.getAttribute('data-seat')) === clockBase.seat;
        b.hidden = !mine;
        if (!mine) return;
        b.style.setProperty('--frac', String(frac));
        b.classList.toggle('warn', warn);
      });
      /* 경고음은 한 차례에 한 번. 매초 다시 부르면 겹겹이 깔려 무슨 소리인지 알 수 없다.
         "한 차례"는 기준점의 열쇠(자리 · 마감 시각)를 그대로 쓴다. 예전에는
         (판 · 스트리트 · 자리)였는데 그건 같은 사람이 한 스트리트에서 두 번 말할 때
         두 번째를 삼킨다 — 베팅하고 리레이즈를 받아 다시 시간에 쫓기는 그 순간이다. */
      if (tick && left > 0) {
        if (clockWarned !== clockBase.key) {
          clockWarned = clockBase.key;
          if (window.casinoSfx && window.casinoSfx.clockWarn) window.casinoSfx.clockWarn();
        }
      }
    }
    // 바는 폴링과 무관하게 계속 줄어든다 — 폴링 사이 1초를 메우는 것이 목적이다
    setInterval(function(){ if (st && st.table && !tableEl.hidden) paintClock(); }, 80);

    /* 홀 카드를 "바뀐 칸만" 갈아 끼운다.
       카드마다 cardFlip 애니메이션이 걸려 있어서, 같은 카드인데 요소를 새로 만들면
       애니메이션이 다시 재생되고 위치도 흔들린다. src가 실제로 달라진 칸만 교체한다
       (다른 게임의 syncCards와 같은 방식). */
    /* ── 쇼다운 핸드를 한 사람씩 연다 ────────────────────────────────
       서버는 판이 끝나는 순간 모두의 홀 카드를 한꺼번에 내려보낸다. 그대로 그리면
       네 사람의 패가 동시에 뒤집혀서 무엇과 무엇이 붙었는지 읽을 틈이 없다.
       실제 딜러는 한 사람씩 연다 — 순서는 스몰블라인드에 가까운 쪽부터다
       (그 사람이 이 스트리트에서 먼저 말할 차례였다).

       여기서 정하는 것은 "언제부터 이 자리의 카드를 앞면으로 그릴 수 있는가"뿐이다.
       실제 그리기는 syncHole이 하고, 이 시각이 지나지 않은 자리는 뒷면으로 남는다.
       holeDoneAt은 보드가 언제 열리기 시작할지의 기준이 된다(마지막 핸드 + 2.5초). */
    /* 타이머를 boardTimers와 섞으면 안 된다. syncBoard가 "이미 깔고 있는 중"을
       boardTimers.length로 판단하는데, 핸드 공개 타이머가 거기 들어가 있으면 보드가
       영영 예약되지 않거나 엉뚱한 시점에 예약된다 — 실제로 보드가 먼저 다 열리고
       핸드가 10초 뒤에 열렸다(실측). 배열을 나눈다. */
`;
