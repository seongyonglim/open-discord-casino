/* 홀덤 화면 — 액션 배지 (폴드·콜·레이즈 표시).

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
export const BADGES = `    var ACT_BADGE_MS = 1700;
    /* 한 폴링에 두 사람의 행동이 함께 도착하면 시차를 두고 띄운다.
       서버는 액션 사이에 최소 1초를 두는데(ACT_GAP_SEC) 폴링도 1초 간격이라,
       두 액션이 같은 응답에 담기는 경우가 생긴다. 그때 배지를 동시에 띄우면
       "누가 무엇을 했는지" 순서가 사라진다 — 액션 음성이 줄을 서는 것과 같은 이유다. */
    var BADGE_STAGGER_MS = 520;
    var badgeKey = {}, badgeHand = null, badgeAt = 0;
    function syncActBadges(tb, list){
      if (tb.handNo !== badgeHand) {
        badgeHand = tb.handNo; badgeKey = {}; badgeAt = 0;
        // 새 판 — 지난 판의 배지와 승자 표시를 걷어낸다
        /* :not(.away)로 걸러야 한다 — 자리 비움 태그가 같은 클래스를 쓰는데
           그건 판이 바뀐다고 걷어낼 것이 아니라 복귀할 때까지 남는 상태다. */
        /* 상태 배지 둘은 건너뛴다 — 자리 비움과 «다음 판부터» 는 행동이 아니라 상태라
           스스로 사라지지 않는다. 여기서 집어 가면 상태 표시가 1.7초 뒤에 지워진다. */
        seatsEl.querySelectorAll('.ht-abadge:not(.away):not(.wait)').forEach(function(el){
          clearTimeout(el.__s); clearTimeout(el.__t);
          el.hidden = true; el.style.animation = 'none';
        });
        clearWinBadges();
      }
      list.forEach(function(x){
        var el = seatsEl.querySelector('.ht-seat[data-seat="' + x.seat + '"] .ht-abadge:not(.away):not(.wait)');
        if (!el) return;
        if (!x.act) {
          // 서버가 표시를 지웠다(스트리트 전환·판 종료) — 열쇠만 비운다.
          // 배지 자체는 자기 타이머로 사라지므로 여기서 억지로 감추면 도중에 툭 끊긴다.
          if (badgeKey[x.seat] != null) badgeKey[x.seat] = null;
          return;
        }
        /* 폴드만 스트리트를 열쇠에서 뺀다.
           서버는 폴드 표시를 스트리트가 바뀌어도 지우지 않으므로(계속 유효한 사실이니까),
           스트리트가 열쇠에 들어 있으면 플랍에서 접은 사람이 턴·리버마다 다시 "폴드"를
           띄운다(실제로 그랬다). 한 판에 폴드는 한 번뿐이니 열쇠도 하나면 된다.
           올인은 서버가 스트리트 전환에서 지우므로 다른 액션과 같이 다뤄도 된다. */
        var key = x.act === 'fold' ? 'fold' : tb.street + ':' + x.act + ':' + (x.amount || 0);
        if (badgeKey[x.seat] === key) return;              // 같은 행동을 다시 띄우지 않는다
        badgeKey[x.seat] = key;

        /* 앞 배지가 뜬 지 얼마 안 됐으면 그만큼 미뤄서 띄운다.
           badgeAt은 "다음 배지를 띄워도 되는 시각"이다 — 새 행동이 여러 개 몰려 오면
           차례차례 밀린다. */
        var now = Date.now();
        var wait = Math.max(0, badgeAt - now);
        badgeAt = now + wait + BADGE_STAGGER_MS;
        var act = x.act, amount = x.amount;
        var show = function(){
          el.textContent = actLabel(act, amount);
          /* 색은 행동의 성격으로 가른다: 돈을 더 넣는 것(베팅·레이즈)은 붉게,
             맞춰 가는 것(콜)은 파랗게, 안 넣는 것(체크)은 초록, 접는 것은 회색.
             올인은 나머지와 다른 등급이라 색만 따로 둔다 — 사라지는 방식은 같다. */
          el.className = 'ht-abadge a-' + act;
          el.hidden = false;
          // 애니메이션을 다시 재생시킨다 — 클래스만 바꾸면 브라우저가 이어서 틀지 않는다
          el.style.animation = 'none';
          void el.offsetWidth;
          el.style.animation = 'actBadge ' + ACT_BADGE_MS + 'ms ease-out forwards';
          /* 다 사라진 뒤에는 실제로 감춘다. 투명해진 요소를 그냥 두면 눈에는 안 보이지만
             같은 자리를 쓰는 WIN 배지와 DOM에서 겹쳐 있어 나중에 헷갈릴 여지가 남는다. */
          clearTimeout(el.__t);
          el.__t = setTimeout(function(){ el.hidden = true; }, ACT_BADGE_MS + 60);
        };
        clearTimeout(el.__s);
        if (wait > 0) el.__s = setTimeout(show, wait); else show();
      });
    }

    /* ── 행동 시간 바 ─────────────────────────────────────────────────
       서버는 남은 초를 정수로만 준다(폴링도 1초 간격이다). 그걸 그대로 그리면 바가
       1초마다 뚝뚝 끊긴다. 그래서 폴링이 준 값을 기준점으로 잡고 그 뒤로는
       실제 흐른 시간으로 보간해 매 프레임 그린다 — 다음 폴링이 오면 기준점만 새로 맞춘다.

       마지막 5초에 색을 바꾸고, 4.5초부터 똑딱 소리를 한 번 낸다(시점이 다른 이유는
       아래 CLOCK_TICK_SEC에 적었다). 시간이 다 되면 서버가 자동으로 체크(불가하면 폴드)
       하므로, 이 경고는 "지금 안 누르면 자동으로 넘어간다"는 뜻이다.

       누구 차례든 울린다. 예전에는 내 차례에만 초당 한 번 카드 소리를 냈는데, 남이
       시간에 쫓기는 것도 판의 긴장이라 보여주는 게 맞다 — 그리고 그 사람이 자동으로
       넘어가면 내 차례가 곧 온다는 신호이기도 하다. */
    /* ── 차례를 가르는 열쇠 ────────────────────────────────────────────
       "한 차례"(누군가에게 행동권이 열려 있는 구간)를 유일하게 가리키는 값이 필요하다.
       시간 바의 기준점과 베팅 슬라이더 초기화가 둘 다 이것으로 "새 차례인가"를 판단한다.

       그 값은 서버가 차례를 열 때 적는 마감 시각이다 — setToAct 이 차례마다
       now + 최소간격 + 20 으로 새로 쓰고, 다음 차례는 최소간격이 지난 뒤에야 열리므로
       두 차례가 같은 값을 가질 수 없다. payload 에 직접 담겨 있지는 않지만
       actionLeft + actOpenIn 으로 정확히 복원된다 — actionLeft 에 씌운 20초 상한이
       깎아낸 몫이 바로 actOpenIn 이기 때문이다(열리는 시각 = 마감 - 20 이 불변식이다).
       서버가 준 값만 더하므로 브라우저 시계 오차가 섞이지 않는다.
       여기는 화면만 다룬다 — 실제 마감 판정은 서버의 action_deadline 이 한다. */
`;
