/* 홀덤 화면 — 좌석 배치와 좌석 렌더.

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
export const SEATS = `    var seatXY = {};
    /* ── 스타디움(알약) 둘레 위의 자리 ──────────────────────────────
       테이블은 위아래가 직선이고 좌우 끝만 반원인 알약 모양이다. 타원이었을 때는
       위아래도 곡선이라 12시 근처 자리들이 안쪽으로 휘어 들어와 펠트를 파고들었다.
       직선 구간에서는 좌석이 한 줄로 나란히 서고 그 아래가 통째로 빈 초록이 된다.

       한때 타원을 썼던 이유는 % 좌표로 경계를 따라갈 수 있어서였다(스타디움은 직선
       구간 길이가 폭에 따라 달라져 % 하나로 표현되지 않는다). 지금은 좌표를 골격에
       굽지 않고 매 렌더마다 넣으므로, 펠트를 실측해서 픽셀로 풀면 된다.

       둘레를 n등분한다 — 각도가 아니라 길이다. 그래야 직선 구간과 반원 구간에
       사람이 고르게 선다. 0번(나)은 언제나 바닥 한가운데이고 거기서 왼쪽으로 돈다.

       각 점에서 바깥 법선도 같이 낸다. 직선 구간은 (0,±1), 반원 구간은 그 원의
       반지름 방향이다 — 이게 좌석을 밖으로 밀어내는 방향이 된다. */
    function stadiumSeats(n, W, H){
      var r = Math.min(W, H) / 2;
      var flat = Math.max(0, W - 2 * r);      // 위(아래) 직선 한 변의 길이
      var half = flat / 2;
      var cap = Math.PI * r;                  // 반원 하나의 길이
      var L = 2 * flat + 2 * cap;
      var out = [];
      for (var i = 0; i < n; i++) {
        var s = (L * i / n) % L;
        var x, y, nx, ny, ph;
        if (s < half) {                                   // 바닥 가운데 → 왼쪽
          x = W / 2 - s; y = H; nx = 0; ny = 1;
        } else if (s < half + cap) {                      // 왼쪽 반원 (아래 → 위)
          ph = Math.PI / 2 + (s - half) / r;
          x = r + r * Math.cos(ph); y = H / 2 + r * Math.sin(ph);
          nx = Math.cos(ph); ny = Math.sin(ph);
        } else if (s < half + cap + flat) {               // 윗변 왼쪽 → 오른쪽
          x = r + (s - half - cap); y = 0; nx = 0; ny = -1;
        } else if (s < half + 2 * cap + flat) {           // 오른쪽 반원 (위 → 아래)
          ph = -Math.PI / 2 + (s - half - cap - flat) / r;
          x = (W - r) + r * Math.cos(ph); y = H / 2 + r * Math.sin(ph);
          nx = Math.cos(ph); ny = Math.sin(ph);
        } else {                                          // 바닥 오른쪽 → 가운데
          x = (W - r) - (s - half - 2 * cap - flat); y = H; nx = 0; ny = 1;
        }
        /* 베팅 칩은 그 자리에서 안쪽으로 들어온 점이다. 가로로 들어올 때와 세로로
           들어올 때 여유가 다르다 — 세로는 중앙 블록이 거의 다 쓰고 있고 가로는 넓다.
           그래서 방향에 따라 다른 거리를 쓴다. */
        var inX = W * 0.15, inY = H * 0.11;
        var bx = x - nx * (Math.abs(nx) * inX + Math.abs(ny) * inY);
        var by = y - ny * (Math.abs(nx) * inX + Math.abs(ny) * inY);
        /* 아래쪽 자리만 한 번 더 올린다. 홀 카드는 어느 자리에서나 아바타 위로 자라는데,
           위쪽 자리에서는 그게 테이블 밖(위)이라 걸릴 것이 없고 아래쪽 자리에서만
           테이블 안쪽으로 뻗는다. 그래서 6시 자리에서만 칩 기둥과 금액 배지가 카드
           윗부분(숫자·문양이 있는 자리)에 얹혔다 — 실측 10px 겹침.
           22px 올리면 11px 여백이 남는다. ny로 비례를 주어 아래쪽 반원도 같이 따라온다.
           픽셀이 아니라 H 비율로 적는다 — 좁은 화면에서는 카드도 같이 작아지므로
           고정 픽셀이면 그쪽에서만 과하게 올라간다(0.067 × 326 = 22). */
        by -= Math.max(0, ny) * H * 0.067;
        out.push({
          x: +(x / W * 100).toFixed(2), y: +(y / H * 100).toFixed(2),
          nx: nx, ny: ny,
          bet: [+(bx / W * 100).toFixed(2), +(by / H * 100).toFixed(2)],
        });
      }
      return out;
    }
    /* ── 좌석을 경계 밖으로 밀어내기 ────────────────────────────────
       미는 거리는 "그 방향으로 좌석 덩어리가 뻗은 길이"다. 덩어리는 위아래가 비대칭이라
       (태그가 아바타 아래에만 있다) 세 성분으로 나눠 CSS 변수로 둔다.
         --htPushX  가로로 뻗은 길이
         --htPushU  아래로 뻗은 길이 (위로 밀 때 이만큼 밀어야 아래끝이 경계에 온다)
         --htPushD  위로 뻗은 길이
       거리 = |nx|·X + |ny|·(위로 밀면 U, 아래로 밀면 D)
       이걸 법선 방향으로 뿌리면 각 축의 계수가 나온다. px 값은 CSS가 알고 방향은
       JS가 아니까, 곱셈만 calc에 맡긴다. */
    /* 승률 말풍선이 붙는 쪽. 'l'이면 좌석의 왼쪽, 'r'이면 오른쪽이다.
       규칙은 하나다 — 화면이 남아 있는 쪽으로 붙인다. 좌석의 가로 위치만 보면 된다.
         가운데 무리(26~74%)  → 바깥으로 벌린다. 12시 두 자리를 둘 다 안쪽으로 보내면
                                가운데에서 서로 포개진다(실측: 완전히 겹쳤다).
         좌우 끝(26% 밖)      → 안쪽. 여기서 바깥은 곧 화면 밖이다 —
                                12%에 앉은 자리를 바깥으로 보냈더니 23px 잘렸다(실측).
       법선(|ny|)으로 직선/반원을 갈라 봤지만 그것으로는 부족했다. 직선 구간이라도
       끝에 가까운 자리는 바깥에 자리가 없다. 결국 기준은 "구간"이 아니라 "여유"다. */
    function eqSide(p){
      var x = p.plate[0];
      if (x < 26) return 'r';
      if (x > 74) return 'l';
      return x < 50 ? 'l' : 'r';
    }
    function seatPos(pt){
      var nx = pt.nx, ny = pt.ny;
      var ax = Math.abs(nx), ay = Math.abs(ny);
      var up = ny < 0 ? ay : 0, dn = ny > 0 ? ay : 0;
      var expr = function(pct, axis){
        return 'calc(' + pct + '%'
          + ' + var(--htPushX) * ' + (axis * ax).toFixed(4)
          + ' + var(--htPushU) * ' + (axis * up).toFixed(4)
          + ' + var(--htPushD) * ' + (axis * dn).toFixed(4) + ')';
      };
      return {
        plate: [pt.x, pt.y],
        left: expr(pt.x, nx),
        top:  expr(pt.y, ny),
        bet:  pt.bet,
        // 법선도 함께 넘긴다 — 말풍선을 어느 쪽에 붙일지가 여기서 갈린다(eqSide)
        nx: nx, ny: ny,
      };
    }

    /* 이 판의 SB·BB 자리. 딜링 순서를 정할 때 쓰는 sbSeatOf를 그대로 쓴다 —
       규칙이 두 곳에 따로 적히면 배지와 실제 블라인드가 어긋난다. */
    function blindSeatsOf(tb){
      var inHand = (tb.seats || []).filter(function(s){ return s.inHand; });
      if (inHand.length < 2) return { sb: null, bb: null };
      var sb = sbSeatOf(inHand, tb.buttonSeat);
      var nums = inHand.map(function(s){ return s.seat; });
      var bb = null;
      for (var i = 1; i <= 9; i++) {
        var cand = (sb + i) % 9;
        if (nums.indexOf(cand) >= 0) { bb = cand; break; }
      }
      return { sb: sb, bb: bb };
    }

    /* 태그에 적는 이름. 예전에는 'Seat 4'였다 — 자리 번호는 규칙을 읽는 데는 쓸모가 있지만
       "누구와 겨루는가"를 말해 주지 않았고, 실제 이름은 아바타 이니셜과 오른쪽 패널에만
       있었다. 이름을 앞에 두고, 자리 번호는 이름이 없을 때만 쓴다.
       태그 폭이 한정되어 있어 길면 잘린다(CSS ellipsis). */
    function seatLabel(s){
      var nm = (s.username || '').trim();
      if (!nm) nm = 'Seat ' + (s.seat + 1);
      return s.userId === MEID ? nm + ' (나)' : nm;
    }

    function renderSeats(){
      var tb = st.table, seats = tb.seats || [];
      // 판이 바뀌면 "아직 안 받은 상금" 장부를 비운다
      if (paidSeatHand !== tb.handNo) { paidSeatHand = tb.handNo; paidSeat = {}; }
      var blindSeats = blindSeatsOf(tb);
      /* 보드를 깔고 있는 동안(정지 + 한 장씩 공개)에는 스트리트를 닫은 행동을 붙들고 있는다.
         syncBoard가 이 함수보다 먼저 돌아 boardRevealed를 정해 준다. */
      var holdActor = !boardRevealed ? tb.lastActor : null;
      /* Hero를 항상 6시에 두려면 "내 자리 번호"를 기준으로 돌린다.
         자리 번호는 서버가 정한 그대로 두고 화면 위치만 돌린다 —
         내가 3번이든 7번이든 언제나 아래 가운데에서 플레이한다.

         자리 번호 오름차순이 곧 화면상 시계방향이므로, 내 자리에서 시작하도록 목록을
         한 바퀴 돌려 놓으면 그 순서가 그대로 배치 순서가 된다. */
      var anchor = tb.mySeat != null ? tb.mySeat : (seats.length ? seats[0].seat : 0);
      var order = seats.slice().sort(function(a, b){ return a.seat - b.seat; });
      var at = 0;
      for (var oi = 0; oi < order.length; oi++) if (order[oi].seat === anchor) { at = oi; break; }
      order = order.slice(at).concat(order.slice(0, at));
      var rotOf = {};
      order.forEach(function(s, i){ rotOf[s.seat] = i; });
      var seatCount = order.length;

      var html = '', vol = '', sigParts = [], actNow = [];
      /* 펠트의 실제 크기. 스타디움은 직선 구간 길이가 폭에 따라 달라져서 % 만으로는
         경계를 표현할 수 없다 — 재서 픽셀로 푼 뒤 %로 되돌린다. 재는 값이라 창 크기가
         바뀌면 달라지므로, 좌표는 골격에 굽지 않고 아래 갱신 루프에서 매번 넣는다. */
      var clothBox = clothEl ? clothEl.getBoundingClientRect() : null;
      var cw = clothBox && clothBox.width > 0 ? clothBox.width : 560;
      var ch = clothBox && clothBox.height > 0 ? clothBox.height : 300;
      var pts = stadiumSeats(seatCount, cw, ch);
      seatXY = {};
      seats.forEach(function(s){
        var rot = rotOf[s.seat] || 0;
        var p = seatPos(pts[rot] || pts[0]);
        // 다른 연출(앤티 등)이 같은 좌표를 써야 한다 — 계산을 두 곳에 두면 어긋난다
        seatXY[s.seat] = p;

        /* 좌석 한 자리 = 세 겹.
             .ht-hole   홀 카드 — 아바타 위. 비공개면 아바타 뒤(z1), 공개되면 앞(z3).
             .ht-avbox  아바타 원 — 좌표가 꽂히는 곳. 시계 고리·행동 배지가 여기 붙는다.
             .ht-plate  이름 + 스택 태그 — 아바타 하단을 덮는다(z5, 가장 앞).

           예전에는 카드·아바타·이름이 한 줄(.ht-plate)에 가로로 나열됐고 좌석이 테이블
           안쪽에 있었다. 그래서 테이블이 커야 했고, 보드 카드가 위로 밀려 작아졌다.
           지금은 좌석이 경계에 걸쳐 앉아 중앙이 온전히 비고, 그 공간을 보드가 쓴다.

           cards-below(12시 두 자리는 카드를 아래로) 예외는 없앴다. 카드가 위로 자라도
           테이블 밖이라 걸리는 것이 없다 — 그 예외 자체가 좌석을 안쪽에 두던 시절의
           증상이었다. */
        html += '<div class="ht-seat" data-seat="' + s.seat + '">' +
            '<div class="ht-hole"></div>' +
            '<div class="ht-avbox">' +
              avatarHtml(s.userId, s.avatar, s.username, 'ht-av') +
              /* 자리 비움 — 행동 배지와 같은 생김새의 회색 태그. 다만 스스로 사라지지 않는다.
                 행동은 "방금 일어난 일", 자리 비움은 "지금의 상태"다.
                 행동 배지와 별도 요소로 두어야 한다 — 같은 span을 쓰면 자리 비운 사람이
                 자동 체크될 때 그 배지가 덮어썼다가 1.7초 뒤 사라지면서 상태까지 지운다. */
              '<span class="ht-abadge away" hidden>자리 비움</span>' +
              /* 방금 한 행동 — 프로필 사진 위에 잠깐 떴다 사라진다.
                 "누가"와 "무엇을"이 한 점에서 읽힌다. */
              '<span class="ht-abadge" hidden></span>' +
              /* 폴드 F 배지는 없앴다. 접은 사람은 좌석이 통째로 흐려지고 아바타가
                 흑백이 되며 카드도 어두워진다 — 세 겹으로 이미 말하고 있는 것을
                 네 번째로 말하는 표시였고, 태그 오른쪽 위에 동그라미가 하나 더
                 붙으면서 딜러 버튼·블라인드 배지와 같은 자리를 놓고 다퉜다. */
            '</div>' +
            '<div class="ht-plate">' +
              /* 배경을 따로 둔다 — 사다리꼴은 clip-path로 자르는데, 그걸 태그 자체에
                 걸면 자식(글자·시간 바)까지 같이 잘린다. 자를 것만 따로 깐다. */
              '<span class="ht-plate-bg"></span>' +
              /* 이름도 스택처럼 제자리 갱신한다(id).
                 골격 HTML에 구워 넣으면, 서버가 username을 빈 문자열로 먼저 보낸 뒤
                 실제 이름을 보내도 좌석 배치가 바뀔 때까지 'Seat N'으로 굳는다.
                 골격 서명에 이름을 넣어 해결하려 하면 이름이 바뀔 때마다 좌석 DOM이 통째로
                 다시 만들어져 카드가 다시 뒤집히고 움찔거린다 — 그건 서명 주석이 경고하는 상황이다. */
              '<span class="ht-who">' +
                '<span class="ht-nm" id="htnm-' + s.seat + '"></span>' +
                '<span class="ht-stk" id="htstk-' + s.seat + '"></span>' +
              '</span>' +
              /* 남은 행동 시간 — 태그 바로 아래, 태그와 같은 폭의 얇은 바.
                 태그의 자식이라 폭이 저절로 맞는다(태그는 이름 길이에 따라 늘어난다). */
              '<span class="ht-tbar" hidden><i></i></span>' +
            '</div>' +
            '<span class="ht-puck ' + (p.plate[0] < 50 ? 'r' : 'l') + '" title="딜러 버튼" hidden>D</span>' +
            /* 블라인드 배지 — 딜러 버튼 반대쪽에 붙인다. 같은 쪽에 두면 D와 겹친다.
               포지션(누가 먼저 말하는지)이 보이지 않으면 초보는 프리플랍 순서를 못 읽는다. */
            '<span class="ht-blind ' + (p.plate[0] < 50 ? 'l' : 'r') + '" hidden></span>' +
            /* 이 판(또는 이 팟 층)을 가져간 사람 — 칩이 움직이기 전에 먼저 뜬다 */
            '<span class="ht-win-b" hidden>WIN</span>' +
            /* 무엇으로 이겼나. 예전에는 펠트 한가운데 노란 캡슐이었는데,
               "누가"와 "무엇으로"가 화면의 서로 다른 곳에 있어 눈이 두 번 움직였다. */
            '<span class="ht-win-h" hidden></span>' +
            /* 쇼다운 승률 말풍선을 어느 쪽에 붙일지는 좌석이 테이블의 어디에 앉았느냐로 갈린다.
                 직선 구간(위·아래 변)  → 바깥쪽. 12시 두 자리를 둘 다 안쪽으로 보내면
                                          가운데에서 서로 겹친다(실측: 완전히 포개졌다).
                 반원 구간(좌·우 끝)    → 안쪽. 여기서는 바깥쪽이 곧 화면 밖이라
                                          9시 자리의 말풍선이 통째로 잘려 나갔다.
               |ny|가 큰 자리가 직선 구간이다 — 법선이 거의 수직이라는 뜻이다. */
            '<span class="ht-eq ' + eqSide(p) + '" hidden></span>' +
          '</div>';

        /* 골격 서명은 "누가 어느 자리에 앉았나"만 본다.
           카드·상태·딜러 버튼·스택은 전부 아래에서 제자리 갱신한다.
           여기에 하나라도 변하는 값을 넣으면 그때마다 좌석 DOM이 새로 만들어지고,
           카드 요소가 다시 생겨 cardFlip이 재생되고 판 폭이 흔들려 카드가 움찔거린다.
           실제로 카드가 액션마다 최대 7.5px씩 움직였다. */
        /* 화면 위치는 (순번, 인원)에서 나온다. 둘 다 넣어야 한다 —
           누가 탈락해 인원이 줄면 순번이 그대로여도 모든 자리의 각도가 달라진다.
           인원을 빼먹으면 좌석이 옛 각도에 그대로 남는다. */
        sigParts.push(s.seat + ':' + s.userId + ':' + rot + '/' + seatCount);

        // 베팅 칩과 행동 표시는 카드와 무관한 별도 레이어에 그린다 (여기가 바뀌어도 카드는 그대로)
        var act = s.act, amt = s.actAmount;
        /* 스트리트를 닫은 행동은 서버가 좌석 표시를 초기화해 버려서 s.act가 비어 있다.
           보드를 깔기 전 정지 구간에서는 핸드 쪽에 남은 기록으로 그 자리를 채운다 —
           이게 없으면 "딜러가 체크했는데 안 보이고 플랍이 바로 깔린다"가 된다. */
        if (!act && holdActor && holdActor.seat === s.seat) {
          act = holdActor.act; amt = holdActor.amount;
        }
        /* 올인도 다른 액션과 같이 "방금 한 행동"으로만 다룬다 — 잠깐 떴다 사라진다.
           "지금 올인 상태다"는 스택 자리의 ALL IN 문구가 따로 말한다(아래 htstk 갱신).
           둘은 서로 다른 것을 말하는 서로 다른 UI다:
             프로필 위 배지 = 방금 무슨 행동을 했나
             스택 자리      = 지금 칩이 하나도 없나 */
        /* 판이 끝나면 좌석 앞 칩을 그리지 않는다. 서버는 판이 끝날 때 bet을 0으로
           되돌리지 않는데(초기화는 스트리트 전환에만 있다), 그 사이 팟 더미는 이미
           마지막 스트리트 베팅까지 중앙에 그려 놓는다 — 같은 칩이 두 곳에 보인다. */
        /* 행동 이름은 여기서 그리지 않는다 — 좌석판 위 배지(.ht-abadge)가 맡는다.
           베팅 자리에는 "실제로 나간 칩"만 남긴다. 이름까지 여기 있으면 이미 지나간
           행동이 판이 끝날 때까지 테이블에 널려 있게 된다. */
        if (s.bet > 0 && !tb.ended) {
          vol += '<div class="ht-spot" id="htspot-' + s.seat + '"' +
            ' style="left:' + p.bet[0] + '%;top:' + p.bet[1] + '%">' +
            '<span class="ht-spot-chips">' + chipStack(s.bet) + '</span>' +
            '<span class="ht-spot-amt">' + stackText(s.bet) + '</span>' +
            '</div>';
        }
        actNow.push({ seat: s.seat, act: act, amount: amt });
      });

      var sig = sigParts.join('|');
      if (seatsEl.dataset.sig !== sig) { seatsEl.dataset.sig = sig; seatsEl.innerHTML = html; }
      if (spotsEl.dataset.sig !== vol) { spotsEl.dataset.sig = vol; spotsEl.innerHTML = vol; }

      // 자주 바뀌는 것은 골격을 건드리지 않고 제자리에서 갱신한다
      seats.forEach(function(s){
        var nmEl = document.getElementById('htnm-' + s.seat);
        if (nmEl) {
          var label = seatLabel(s);
          if (nmEl.textContent !== label) nmEl.textContent = label;
        }
        var el = document.getElementById('htstk-' + s.seat);
        if (el) {
          /* 스택 자리에 ALL IN을 쓴다 — 단 "정말로 칩이 하나도 없을 때"만.
             올인 상태(state)와 칩이 0인 것은 같은 말이 아니다: 100BB를 밀었는데 상대가
             40BB만 콜했으면 콜되지 않은 60BB가 판이 끝날 때 돌아온다(returnUncalled).
             그 순간부터 나는 칩을 가진 사람이므로 ALL IN이 아니고, 돌아온 숫자를 보여줘야
             한다. state만 보고 찍으면 스택이 60BB인 사람에게 ALL IN이 붙는다.
             그래서 두 조건을 함께 본다. */
          var shown = stackOf(tb, s);
          var allIn = s.state === 'allin' && shown === 0;
          var want = allIn ? 'ALL IN' : stackText(shown);
          if (el.textContent !== want) el.textContent = want;
          el.className = allIn ? 'ht-stk allin' : 'ht-stk';
        }
        var seatEl = seatsEl.querySelector('.ht-seat[data-seat="' + s.seat + '"]');
        if (!seatEl) return;
        /* 좌표는 골격이 아니라 여기서 넣는다. 등간격 계산이 실측한 가로세로 비율에
           의존하므로, 창 폭이 바뀌면 값도 바뀐다 — 골격에 구워 두면 좌석 구성이
           바뀔 때까지 옛 자리에 남는다. */
        var pp = seatXY[s.seat];
        if (pp) {
          if (seatEl.style.left !== pp.left) seatEl.style.left = pp.left;
          if (seatEl.style.top !== pp.top) seatEl.style.top = pp.top;
        }
        seatEl.classList.toggle('hero', s.userId === MEID);
        seatEl.classList.toggle('turn', s.seat === tb.toActSeat);
        seatEl.classList.toggle('folded', s.state === 'folded');
        seatEl.classList.toggle('allin', s.state === 'allin');
        seatEl.classList.toggle('sitout', s.presence === 'SIT_OUT');
        seatEl.classList.toggle('disc', s.presence === 'DISCONNECTED');
        // 딜러 버튼·배지는 만들어 두고 감췄다 켠다 (요소를 새로 만들면 카드까지 딸려 다시 생긴다)
        var puck = seatEl.querySelector('.ht-puck');
        if (puck) puck.hidden = s.seat !== tb.buttonSeat;
        /* SB / BB 배지. 판이 끝난 뒤에는 지운다 — 다음 판이면 자리가 바뀐다.
           헤즈업에서는 버튼이 곧 SB라 D와 SB가 같은 자리에 나란히 붙는다(실제 규칙이다). */
        var blind = seatEl.querySelector('.ht-blind');
        if (blind) {
          var role = !tb.ended && s.inHand
            ? (s.seat === blindSeats.sb ? 'SB' : s.seat === blindSeats.bb ? 'BB' : '')
            : '';
          blind.hidden = !role;
          blind.textContent = role;
          blind.classList.toggle('bb', role === 'BB');
        }
        /* 자리 비움은 행동이 아니라 상태다 — 복귀할 때까지 계속 보여야 한다.
           예전에는 폴드하지 않은 사람에게만 띄웠다. 그런데 자리 비움이 되는 계기가
           "시간 초과로 자동 폴드"라서, 붙는 순간 폴드도 함께 붙어 표시가 곧바로 사라졌다.
           잠깐 떴다 사라지는 것으로 보인 이유가 이것이다. */
        var awayB = seatEl.querySelector('.ht-abadge.away');
        if (awayB) awayB.hidden = s.presence !== 'SIT_OUT';
        syncHole(seatEl.querySelector('.ht-hole'), s);
      });
      syncActBadges(tb, actNow);
      syncEquity(tb);
    }

    /* ── 쇼다운 승률 · 역전 카드 ───────────────────────────────────────
       리버 이전에 액션이 끝나면 결과는 남은 카드에만 달려 있다. 그 구간에 각자의 승률을
       보여주면 남은 카드를 기다리는 재미가 생긴다 — 관전자에게는 특히 그렇다.

       서버가 스트리트별로 미리 계산해 보냈다(result.equity). 여기서는 "지금 화면에 깔린
       보드 장수"에 맞는 단계를 고르기만 한다 — 카드가 열리는 것보다 승률이 앞서 바뀌면
       카드를 보기 전에 결과를 알려주는 것이 된다.

       팟 정산이 시작되면(WIN 배지) 내린다. 그때부터는 확률이 아니라 사실이 나온다. */
    /* 카드 번호 → 랭크·무늬. 서버(services/poker.ts cardToString)와 같은 규칙이다:
       카드 = 랭크*4 + 무늬, 무늬 순서는 스페이드·하트·다이아·클럽.
       순서를 틀리면 아웃츠 미니 카드의 무늬가 통째로 어긋난다. */
`;
