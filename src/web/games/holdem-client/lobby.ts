/* 홀덤 화면 — 대기 화면 (등록·인원·상금).

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
export const LOBBY = `    function renderLobby(){
      var t = st.tournament, now = st.serverNow;
      var badge = '', action = '', note = '';
      if (t.status === 'SCHEDULED') {
        badge = '<span class="ht-badge">예정</span>';
        note = '등록은 ' + dur(t.regOpenAt - now) + ' 후에 열립니다 (KST 21:00)';
        action = '<button type="button" class="btn btn-gold" disabled>참가 신청</button>';
      } else if (t.status === 'REGISTRATION_OPEN') {
        badge = '<span class="ht-badge open">등록 중</span>';
        note = '시작까지 ' + dur(t.scheduledStartAt - now);
        /* 시작 전에는 신청을 되돌릴 수 있다. 좌석과 스택은 대회가 시작될 때
           한꺼번에 만들어지므로, 이 시점의 취소는 등록 행 하나를 지우는 것뿐이다.
           시작한 뒤에는 이미 칩을 들고 앉아 있어 취소가 성립하지 않는다. */
        action = t.iRegistered
          ? '<span class="ht-joined">신청 완료</span>'
            + ' <button type="button" class="btn ht-leave" id="htLeave">신청 취소</button>'
          : '<button type="button" class="btn btn-gold" id="htJoin">참가 신청</button>';
      } else if (t.status === 'WAITING_MIN_PLAYERS') {
        badge = '<span class="ht-badge wait">최소 인원 대기</span>';
        note = '최소 인원 대기 중 — ' + dur(t.graceEndsAt - now) + ' 남음';
        /* 시작 전에는 신청을 되돌릴 수 있다. 좌석과 스택은 대회가 시작될 때
           한꺼번에 만들어지므로, 이 시점의 취소는 등록 행 하나를 지우는 것뿐이다.
           시작한 뒤에는 이미 칩을 들고 앉아 있어 취소가 성립하지 않는다. */
        action = t.iRegistered
          ? '<span class="ht-joined">신청 완료</span>'
            + ' <button type="button" class="btn ht-leave" id="htLeave">신청 취소</button>'
          : '<button type="button" class="btn btn-gold" id="htJoin">참가 신청</button>';
      } else if (t.status === 'RUNNING') {
        if (t.lateRegLeft != null) {
          badge = '<span class="ht-badge late">LATE REGIST</span>';
          note = '늦은 등록 마감까지 ' + dur(t.lateRegLeft);
          action = '<button type="button" class="btn btn-gold" id="htJoin">Late Reg 참가하기</button>' +
            ' <button type="button" class="btn" id="htSpectate">관전하기</button>';
        } else {
          badge = '<span class="ht-badge run">진행 중</span>';
          note = '늦은 등록이 마감되었습니다';
          action = '<button type="button" class="btn" id="htSpectate">관전하기</button>';
        }
      } else if (t.status === 'FINISHED') {
        badge = '<span class="ht-badge done">종료</span>';
        note = '오늘 대회가 끝났습니다';
      } else {
        badge = '<span class="ht-badge cancel">취소</span>';
        note = '최소 인원(' + t.minPlayers + '명)이 모이지 않아 취소되었습니다';
      }

      /* 상금 구조와 결과를 한 표로 합친다.
         예전에는 [순위|상금] 표와 [순위|이름|상금] 표가 따로 세로로 쌓여서, 대회가 끝난
         뒤에는 같은 순위가 두 번 나오고 스크롤이 두 배로 길어졌다. 둘은 사실 같은 표의
         "예정"과 "확정"이다 — 결과가 있으면 이름을 채우고 없으면 비워 둔다. */
      var prizeList = t.prizes || [];
      var resList = st.results || [];
      var rowCount = Math.max(prizeList.length, resList.length);
      var payTable = '';
      if (rowCount) {
        var rows = '';
        for (var pi = 0; pi < rowCount; pi++) {
          var res = resList[pi];
          var place = res ? res.place : pi + 1;
          var amt = res ? res.prize : (prizeList[pi] || 0);
          // 상금을 받는 자리만 밝게. 나머지는 가라앉히고 금액도 0P로 적는다("-"는 정보가 없다)
          var itm = amt > 0;
          rows += '<tr class="' + (itm ? 'itm' : 'out') + '">' +
            '<td class="pl">' + place + '위</td>' +
            '<td class="nm">' + (res ? esc(res.username) : '<i>—<\i>') + '</td>' +
            '<td class="pz">' + num(amt) + 'P</td></tr>';
        }
        payTable = '<h3 class="ht-h3">' + (resList.length ? '결과' : '상금 구조') + '</h3>' +
          '<table class="ht-prize"><thead><tr><th>순위</th><th>플레이어</th><th>상금</th></tr></thead>' +
          '<tbody>' + rows + '<\/tbody><\/table>';
      }

      /* 안내 문구는 배지 옆으로 붙인다. 한 줄짜리 <p>로 따로 두면 그 줄 하나 때문에
         위아래 여백이 두 겹 생겨 카드가 늘어졌다 — 상태를 말하는 짧은 문장이므로
         상태 배지와 같은 줄에 있는 것이 읽기에도 맞다. */
      lobbyEl.innerHTML =
        '<div class="ht-card">' +
          '<div class="ht-card-top">' +
            '<div><h2>' + esc(t.title) + '</h2>' +
              '<p class="ht-when">' + esc(t.dateStr) + ' · 등록 21:00 · 시작 22:00 (KST)</p></div>' +
            '<div class="ht-badge-wrap">' + badge +
              (note ? '<span class="ht-note">' + esc(note) + '</span>' : '') + '</div>' +
          '</div>' +
          /* 여섯 지표를 2×3 미니 카드로 나눈다. 줄 형태(k ····· v)로 쌓았을 때는
             여섯 줄이 같은 무게로 늘어서서 무엇을 봐야 할지 정해지지 않았다. */
          '<div class="ht-grid">' +
            '<div><span class="k">참가자</span><span class="v">' + t.registered + ' / ' + t.maxPlayers + '</span></div>' +
            '<div><span class="k">상금 풀</span><span class="v gold">' + num(t.prizePool) + 'P</span></div>' +
            '<div><span class="k">1인당</span><span class="v">' + num(t.multiplier) + 'P</span></div>' +
            '<div><span class="k">시작 스택</span><span class="v">' + num(t.startingStack) + '</span></div>' +
            '<div><span class="k">지급 인원</span><span class="v">' + t.itm + '명</span></div>' +
            '<div><span class="k">최소 인원</span><span class="v">' + t.minPlayers + '명</span></div>' +
          '</div>' +
          '<div class="ht-actions">' + action + '</div>' +
          payTable +
        '</div>';

      var join = document.getElementById('htJoin');
      if (join) join.addEventListener('click', function(){
        join.disabled = true;
        post('/api/games/holdem/register', {}).then(function(r){
          if (!r.ok) { alert(r.d && r.d.error ? r.d.error : '등록할 수 없습니다'); join.disabled = false; }
          poll();
        });
      });
      var spec = document.getElementById('htSpectate');
      var leave = document.getElementById('htLeave');
      if (leave) leave.addEventListener('click', function(){
        if (!confirm('참가 신청을 취소할까요?')) return;
        leave.disabled = true;
        post('/api/games/holdem/unregister', {}).then(function(r){
          if (!r.ok) alert(r.d && r.d.error ? r.d.error : '취소할 수 없습니다');
          leave.disabled = false;
          poll();
        });
      });
      if (spec) spec.addEventListener('click', function(){ spectate = true; render(); });
    }

    /* ── 좌석 좌표 ──────────────────────────────────────────────────
       펠트(.ht-cloth) 기준 % 좌표다. 순서는 6시에서 시작해 시계방향.
         plate  아바타 중심 — 이 점이 테이블 경계에 놓여 절반은 펠트, 절반은 레일이다
         bet    베팅 칩 자리 — 좌석과 중앙 사이

       손으로 적지 않고 계산한다. 테이블이 타원이므로 경계는
         x = 50 + R·cos t,  y = 50 + R·sin t
       이고 이 식은 가로세로 비율과 무관하게 항상 경계 위의 점을 준다. 그래서 폭이
       달라져도 좌석이 경계를 따라간다 — 예전 스타디움(직선 구간이 폭에 따라 길어진다)에서는
       % 좌표로 경계를 따라갈 방법이 없었고, 그래서 좌석을 안쪽에 넉넉히 넣어야 했다.

       아바타는 R=50(경계 위), 칩은 R=41(펠트 안쪽).
       칩 반지름을 따로 두는 이유: 좌석에 붙이면 카드와 겹치고, 더 안쪽이면 보드를 가린다.
       36으로 뒀다가 좁은 티어에서 위쪽 칩이 중앙 블록을 밟았다 — 중앙 블록의 높이는
       고정 px 합이라 펠트가 작아질수록 비중이 커지는데, 칩 반지름은 %라 같이 줄어든다.
       41이면 320px 티어에서도 13px 여유가 남는다.

       ── 자리를 실제 인원으로 나눈다
       9칸을 고정해 두고 그 중 몇 칸만 채우면 사람이 한쪽에 몰린다. 4인 테이블이 오른쪽
       아래에 넉 줄로 붙어 서고 왼쪽 절반이 비었다(실측). 자리 번호는 서버가 정하지만
       화면 위치는 화면의 몫이므로, 지금 앉아 있는 인원으로 360도를 나눈다.
       내 자리는 언제나 6시이고 시계방향 순서는 그대로 유지된다 — 포지션(누가 먼저
       말하는가)이 자리 순서로 읽히므로 그 순서가 흐트러지면 게임을 잘못 읽는다. */
    /* 지금 화면에서 각 자리가 어디인가 — renderSeats가 채우고 다른 연출이 읽는다.
       좌표 계산을 두 곳에 두면 반드시 어긋난다(앤티 칩이 옛 9칸 각도에 놓인 적이 있다). */
`;
