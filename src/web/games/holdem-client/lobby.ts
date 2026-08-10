/* 홀덤 화면 — 대기 화면 (등록·인원·상금).

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
/* 예정된 대회가 없을 때의 화면.
   대회가 저절로 열리지 않게 되면서 "아무것도 없는 상태"가 정상적인 상태가 됐다.
   그때 빈 카드만 남으면 서비스가 죽은 것처럼 보이므로 세 조각을 순서대로 채운다 —
   다음 대회 안내(있으면) · 지난 대회 결과(있으면) · 마지막으로 안내 문구.
   셋 다 없을 수는 없다. 안내 문구는 언제나 나온다. */
export const LOBBY_EMPTY = `    function renderNoTournament(){
      var now = st.serverNow, html = '';
      var up = st.upcoming, rc = st.recap;

      if (up) {
        var opened = up.regOpenAt <= now;
        html +=
          '<div class="ht-card ht-next">' +
            '<div class="ht-next-top">' +
              '<span class="ht-badge open">다음 대회</span>' +
              '<span class="ht-next-when">' + esc(kstDay(up.startAt)) + ' ' + esc(kstClock(up.startAt)) + '<\/span>' +
            '<\/div>' +
            '<div class="ht-next-count">' + esc(dur((opened ? up.startAt : up.regOpenAt) - now)) + '<\/div>' +
            '<div class="ht-next-sub">' +
              esc(opened ? '시작까지 남았습니다' : '등록 시작까지 남았습니다') + ' · 등록 ' +
              esc(kstClock(up.regOpenAt)) + ' · 시작 ' + esc(kstClock(up.startAt)) + ' (KST)' +
            '<\/div>' +
          '<\/div>';
      }

      if (rc) {
        var champ = rc.top[0];
        var rest = '';
        for (var i = 1; i < rc.top.length; i++) {
          rest += '<li><span class="pl">' + rc.top[i].place + '위<\/span>' +
            '<span class="nm">' + esc(rc.top[i].username) + '<\/span>' +
            '<span class="pz">' + num(rc.top[i].prize) + 'P<\/span><\/li>';
        }
        html +=
          '<div class="ht-card ht-recap">' +
            '<h3 class="ht-h3">지난 대회</h3>' +
            '<div class="ht-champ">' +
              avatarHtml(champ.userId, champ.avatar, champ.username, 'ht-champ-av') +
              '<div class="ht-champ-txt">' +
                '<span class="ht-champ-tag">우승<\/span>' +
                '<strong>' + esc(champ.username) + '<\/strong>' +
                '<span class="ht-champ-sub">' + num(champ.prize) + 'P' +
                  (rc.winningHand ? ' · ' + esc(rc.winningHand) : '') + '<\/span>' +
              '<\/div>' +
            '<\/div>' +
            (rest ? '<ul class="ht-recap-rest">' + rest + '<\/ul>' : '') +
            '<div class="ht-recap-foot">' + esc(rc.dateStr) + ' · 참가 ' + rc.entries + '명 · 총 상금 ' +
              num(rc.prizeTotal) + 'P<\/div>' +
          '<\/div>';
      }

      /* 다음 대회 카드가 있으면 빈 상태 카드를 띄우지 않는다.
         예전에는 셋을 이 순서로 세웠다: 다음 대회 → 지난 대회 → "지금은 진행 중인 대회가
         없습니다 · 위 시각에 등록이 열립니다". 그 카드가 하는 말은 첫 카드가 이미 다 하고
         있고("21시간 40분 · 등록 시작까지 남았습니다"), 게다가 "위 시각"이 가리키는 것이
         두 칸 위라 지난 대회를 건너뛰고 읽어야 했다 — 순서가 이상해 보인 이유가 그것이다.

         예정이 아예 없을 때만 이 카드가 뜻을 갖는다. 그때는 맨 위에 세운다: 지금 상태를
         먼저 알려야 하고, 그 아래로 지난 대회와 누적 순위가 이어지는 것이 자연스럽다. */
      if (!up) {
        html =
          '<div class="ht-card ht-empty">' +
            '<div class="ht-empty-ico">♠<\/div>' +
            '<p class="ht-empty-msg">현재 예정된 토너먼트가 없습니다.<\/p>' +
            '<p class="ht-empty-sub">다음 공지사항을 확인해 주세요!<\/p>' +
          '<\/div>' + html;
      }

      lobbyEl.innerHTML = html;
    }
`;

export const LOBBY = `    function renderLobby(){
      var t = st.tournament, now = st.serverNow;
      if (!t) { renderNoTournament(); return; }
      var badge = '', action = '', note = '';
      if (t.status === 'SCHEDULED') {
        badge = '<span class="ht-badge">예정</span>';
        // 시각은 대회 행에서 읽는다 — 예전에는 문장 안에 시각을 박아 뒀는데,
        // 운영자가 시각을 정하게 된 뒤로 그 문장이 사실과 어긋났다
        note = '등록은 ' + dur(t.regOpenAt - now) + ' 후에 열립니다 (KST ' + kstClock(t.regOpenAt) + ')';
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
      /* ── 신청자 명단 ────────────────────────────────────────────
         숫자만 "2 / 9"로 적어 두면 누가 왔는지 알 수 없어서, 아는 사람이 있는지 보려고
         디스코드를 다시 열어야 한다. 최소 인원이 모여야 열리는 판이라 "누가 있나"가
         갈지 말지를 정하는 정보다.

         빈 자리도 함께 그린다. 몇 명 더 오면 열리는지가 한눈에 보여야 한다 —
         "2 / 9"라는 숫자보다 빈 칸 일곱 개가 더 빨리 읽힌다.
         최소 인원까지 남은 자리는 다르게 칠한다(그만큼은 반드시 차야 열린다). */
      var plist = t.players || [];
      var roster = '';
      if (!t.finishedAt) {
        var slots = '';
        for (var si = 0; si < t.maxPlayers; si++) {
          var p = plist[si];
          if (p) {
            var isMe = p.userId === MEID;
            slots += '<div class="ht-reg' + (isMe ? ' me' : '') + '" title="' + esc(p.username) + '">' +
              avatarHtml(p.userId, p.avatar, p.username, 'ht-reg-av') +
              '<span class="ht-reg-nm">' + esc(p.username) + '</span></div>';
          } else {
            var needed = si < t.minPlayers;
            slots += '<div class="ht-reg empty' + (needed ? ' need' : '') + '">' +
              '<span class="ht-reg-av ph"></span>' +
              '<span class="ht-reg-nm">' + (needed ? '더 필요' : '빈자리') + '</span></div>';
          }
        }
        /* 최소 인원을 채운 것과 자리가 다 찬 것은 다른 말이다. 3/9 에 "인원이 찼습니다"라고
           적으면 더 못 들어오는 것으로 읽힌다 — 실제로는 여섯 자리가 비어 있다. */
        var short = Math.max(0, t.minPlayers - plist.length);
        var sub = short > 0 ? short + '명 더 모이면 열립니다'
          : t.startedAt ? '진행 중'
          : plist.length >= t.maxPlayers ? '자리가 모두 찼습니다'
          : '인원이 모여 예정대로 시작합니다';
        roster = '<h3 class="ht-h3">신청자 <span class="ht-h3sub">' + sub + '</span></h3>' +
          '<div class="ht-regs">' + slots + '</div>';
      }

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
              '<p class="ht-when">' + esc(t.dateStr) + ' · 등록 ' + kstClock(t.regOpenAt) +
                ' · 시작 ' + kstClock(t.scheduledStartAt) + ' (KST)</p></div>' +
            '<div class="ht-badge-wrap">' + badge +
              (note ? '<span class="ht-note">' + esc(note) + '</span>' : '') + '</div>' +
          '</div>' +
          /* 여섯 지표를 2×3 미니 카드로 나눈다. 줄 형태(k ····· v)로 쌓았을 때는
             여섯 줄이 같은 무게로 늘어서서 무엇을 봐야 할지 정해지지 않았다. */
          '<div class="ht-grid">' +
            '<div><span class="k">참가자</span><span class="v">' + t.registered + ' / ' + t.maxPlayers + '</span></div>' +
            '<div><span class="k">상금 풀</span><span class="v gold">' + num(t.prizePool) + 'P</span></div>' +
            /* 참가비가 있으면 그 자리에 참가비를 적는다. "1인당 배수"는 프리롤에서
               서비스가 얹어 주는 금액이라 참가비 대회에서는 뜻이 없다 — 두 값을 나란히
               두면 어느 쪽이 내 돈인지 헷갈린다. */
            (t.buyIn > 0
              ? '<div><span class="k">참가비</span><span class="v warn">' + num(t.buyIn) + 'P</span></div>'
              : '<div><span class="k">1인당</span><span class="v">' + num(t.multiplier) + 'P</span></div>') +
            '<div><span class="k">시작 스택</span><span class="v">' + num(t.startingStack) + '</span></div>' +
            '<div><span class="k">지급 인원</span><span class="v">' + t.itm + '명</span></div>' +
            '<div><span class="k">최소 인원</span><span class="v">' + t.minPlayers + '명</span></div>' +
          '</div>' +
          '<div class="ht-actions">' + action + '</div>' +
          roster +
          payTable +
        '</div>';

      var join = document.getElementById('htJoin');
      if (join) join.addEventListener('click', function(){
        /* 돈이 나가는 신청이면 먼저 묻는다. 프리롤은 잃을 것이 없어 그냥 넣지만,
           참가비 대회는 누르는 순간 잔액이 줄어든다 — 얼마인지 모르고 눌리면 안 된다. */
        if (t.buyIn > 0 &&
            !confirm('참가비 ' + num(t.buyIn) + 'P를 내고 신청합니다.\\n'
              + '시작 전에 취소하거나 대회가 인원 미달로 취소되면 전액 돌려받습니다.')) return;
        join.disabled = true;
        post('/api/games/holdem/register', {}).then(function(r){
          if (!r.ok) { alert(r.d && r.d.error ? r.d.error : '등록할 수 없습니다'); join.disabled = false; }
          poll();
        });
      });
      var spec = document.getElementById('htSpectate');
      var leave = document.getElementById('htLeave');
      if (leave) leave.addEventListener('click', function(){
        if (!confirm('참가 신청을 취소할까요?'
          + (t.buyIn > 0 ? '\\n참가비 ' + num(t.buyIn) + 'P는 돌려드립니다.' : ''))) return;
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
