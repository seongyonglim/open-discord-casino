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
export const LOBBY_EMPTY = `    /* 다음 대회 카드에도 같은 뱃지와 이월 배너를 쓴다. renderLobby 안에서 만드는 것과
       모양이 같아야 "같은 판을 미리 보는 것" 으로 읽힌다 — 두 카드가 서로 다르게 생기면
       등록이 열리는 순간 화면이 갈아치워진 것처럼 느껴진다. */
    function nextModeBadge(up){
      var mys = up.mode === 'MYSTERY_BOUNTY';
      var pko = mys || up.mode === 'PKO_BOUNTY';
      return mys
        ? '<span class="ht-mode mys">미스터리 바운티<\\/span>'
        : (pko ? '<span class="ht-mode bty">바운티<\\/span>'
               : '<span class="ht-mode cls">클래식<\\/span>');
    }
    /* 리바이 뱃지 — 이 판이 «다시 살 수 있는 판인가» 를 모드 뱃지 옆에 붙인다.
       모드와 나란히 서야 하는 이유: 둘 다 «참가를 정하기 전에» 알아야 하는 성격이다.
       프리즈아웃은 한 번 죽으면 그날이 끝나는 판이라 초반에 크게 못 지르고, 리바이가
       열린 판은 반대다 — 같은 참가비라도 들고 갈 각오가 다르다. 그런데 지금까지는
       그 사실이 어디에도 안 적혀 있었다(규칙 안내에도 없다).

       0 을 «리바이 0회» 로 적지 않는다. 그렇게 적으면 «리바이라는 게 있는데 내 몫이
       0» 으로 읽힌다 — 남은 횟수를 말하는 것처럼 보인다. 0 은 규칙 자체에 이름이
       따로 있는 상태이므로 그 이름으로 적는다: 프리즈아웃. */
    function rebuyBadge(n){
      n = Math.max(0, Math.floor(n || 0));
      return n > 0
        ? '<span class="ht-mode rb">리바이 ' + n + '회<\/span>'
        : '<span class="ht-mode fz">프리즈아웃<\/span>';
    }
    /* 이월 배너 문구.
       "최소 인원 미달로" 대신 "열리지 못한 회차가 얹혀" 를 쓴다 — 미달은 원인의 이름일
       뿐이고, 읽는 사람이 알고 싶은 것은 "지난번에 안 열려서 그만큼 쌓였다" 는 사실이다.

       "총 상금" 은 쓰지 않는다. 등록 전에는 몇 명이 올지 모르므로 총액이 아직 없는 값이고,
       적으려면 인원을 가정해야 한다 — 그 가정이 틀리면 화면이 거짓말을 한 것이 된다.
       대신 이 제품이 이미 쓰는 말로 적는다: 규칙 안내가 "참가자 1인당 N P 가 상금 풀에
       쌓입니다" 라고 하고 있으므로 여기서도 1인당 · 적립이다. 배수는 뒤에 붙여 "평소의
       몇 배" 로 맥락만 준다 — 숫자가 먼저 오고 이유가 뒤에 오는 것이 읽기 순서다. */
    function nextRollBanner(up){
      var s = up.rolloverSkips || 0;
      if (!s) return '';
      return '<div class="ht-roll">' +
        '<span class="ht-roll-tag">이월 ' + s + '회<\\/span>' +
        '<span class="ht-roll-txt">열리지 못한 회차가 얹혀 '
          + (up.perHead ? '1인당 <b>' + num(up.perHead) + 'P<\\/b> 적립' : '상금이 커집니다')
          + ' — 평소의 <b>' + (s + 1) + '배<\\/b><\\/span>' +
      '<\\/div>';
    }

    function renderNoTournament(){
      var now = st.serverNow, html = '';
      var up = st.upcoming, rc = st.recap;

      if (up) {
        var opened = up.regOpenAt <= now;
        html +=
          '<div class="ht-card ht-next">' +
            /* 1행 — 무슨 판인가(다음 대회 · 모드) | 언제인가(일정).
               모드 뱃지가 카운트다운 아래에 따로 놓여 있었다. 그러면 "8시간 26분" 을
               읽고 내려오다가 뒤늦게 종류를 알게 된다 — 종류는 시간보다 먼저 정해지는
               정보라 같은 줄 맨 앞에 있는 것이 맞다. */
            '<div class="ht-next-top">' +
              '<span class="ht-next-tags">' +
                '<span class="ht-badge open">다음 대회</span>' + nextModeBadge(up) +
                rebuyBadge(up.maxRebuys) +
              '<\/span>' +
              '<span class="ht-next-when">' + esc(kstDay(up.startAt)) + ' ' + esc(kstClock(up.startAt)) + '<\/span>' +
            '<\/div>' +
            /* 2행 — 대회 이름. 예고 카드에는 이름이 아예 없어서 무슨 대회를 기다리는지
               알 수 없었다(로비 카드에는 있는데 여기만 빠져 있었다). */
            (up.title ? '<h2 class="ht-next-title">' + esc(up.title) + '<\/h2>' : '') +
            /* 3행 — 라벨 · 숫자 · 일정 순으로 쌓는다.
               예전에는 "8시간 21분" 아래에 "등록 시작까지 남았습니다 · 등록 09:00 …" 가
               한 줄로 붙어 있었다. 무엇까지 남은 시간인지가 숫자 뒤에 오니 숫자를 먼저
               읽고 나서 되짚어야 했고, 그 뒤에 일정까지 이어 붙어 한 줄이 세 가지를
               말했다. 라벨을 위로 올리면 읽는 순서가 뜻의 순서와 같아진다. */
            '<div class="ht-next-label">' + esc(opened ? '시작까지' : '등록 시작까지') + '<\/div>' +
            '<div class="ht-next-count">' + esc(dur((opened ? up.startAt : up.regOpenAt) - now)) + '<\/div>' +
            '<div class="ht-next-sub">등록 ' + esc(kstClock(up.regOpenAt)) +
              ' · 시작 ' + esc(kstClock(up.startAt)) + ' (KST)<\/div>' +
            /* ── 등록 전에도 규칙은 보여준다 ────────────────────────
               예전에는 남은 시간만 적었다. 그런데 갈지 말지를 정하는 데 필요한 것은
               "언제" 가 아니라 "얼마짜리 판인가 · 몇 명이 모여야 열리나 · 어떤 방식인가"
               이고, 그건 등록이 안 열렸을 뿐 이미 정해져 있다.

               참가자 수와 상금 풀은 안 적는다 — 대회 행이 아직 없어 존재하지 않는 값이다.
               0 을 적으면 "상금 0P 짜리 판" 으로 읽혀 없는 것보다 나쁘다. 대신 인당
               금액과 최소 인원을 나란히 두어 "3명이면 얼마" 를 셀 수 있게 한다. */
            (up.perHead != null
              ? nextRollBanner(up) +
                '<div class="ht-grid ht-next-grid">' +
                  (up.buyIn > 0
                    ? '<div><span class="k">참가비<\/span><span class="v warn">'
                        + num(up.buyIn) + 'P<\/span><\/div>'
                    : '<div><span class="k">1인당<\/span><span class="v gold">'
                        + num(up.perHead) + 'P<\/span><\/div>') +
                  '<div><span class="k">최소 인원<\/span><span class="v">'
                    + up.minPlayers + '명<\/span><\/div>' +
                  '<div><span class="k">정원<\/span><span class="v">'
                    + up.maxPlayers + '명<\/span><\/div>' +
                  '<div><span class="k">시작 스택<\/span><span class="v">'
                    + num(up.startingStack) + '<\/span><\/div>' +
                '<\/div>'
                /* 못 누르는 단추는 두지 않는다. 위에 이미 "등록 시작까지 9시간 8분" 이
                   적혀 있어 지금 신청할 수 없다는 것은 그 줄이 말하고, 회색 단추는
                   같은 말을 한 번 더 하면서 누를 수 있을 것처럼 보이기만 한다. */
              : '') +
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

export const LOBBY = `    /* 매 초 바뀌는 유일한 조각이 들어갈 자리표. 화면에 절대 나올 수 없는
       글자여야 뼈대 비교가 어긋나지 않는다. */
    var NOTE_SLOT = String.fromCharCode(0);
    var lastShell = '', noteEl = null;
    /* ── 참가 완료 = 취소 단추 ──────────────────────────────────────
       예전에는 "신청 완료" 라벨과 "신청 취소" 단추가 따로 있었다. 라벨은 누를 수 없는데
       단추처럼 생겨서 그것을 누르는 사람이 있었고, 둘이 나란히 놓이니 어느 쪽이 지금
       상태이고 어느 쪽이 행동인지도 한눈에 안 갈렸다.

       이제 하나다. 평소에는 초록 테두리로 "되어 있다"를 말하고, 손을 올리면 붉게 바뀌어
       "누르면 물린다"를 말한다 — 상태와 행동이 한 칸을 나눠 쓴다. */
    function joinedBtn(){
      return '<button type="button" class="btn ht-done" id="htLeave">'
        + '<svg class="ht-done-i" width="15" height="15" viewBox="0 0 24 24" fill="none"'
        + ' stroke="currentColor" stroke-width="2.6" stroke-linecap="round"'
        + ' stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/><\/svg>'
        + '참가 완료 <span class="ht-done-x">(등록 취소)<\/span><\/button>';
    }
    /* ── 로비 카드 아래의 두 탭 ────────────────────────────────────────
       [칩 순위] 와 [상금 구조]. 인게임 오른쪽 패널과 같은 모양·같은 조작이라,
       테이블에 들어가 본 사람은 여기서도 이미 쓸 줄 안다.

       껍데기는 정적으로 박혀 있고(holdem.ts 의 #htLobbyTabs) 여기서는 속만 갈아
       끼운다. 그래야 카드가 다시 그려져도 «어느 탭을 보고 있었나» 가 안 풀린다 —
       카드는 인원이 바뀔 때마다 통째로 새로 만들어진다.

       탭 선택은 이 변수 하나가 들고 있다. sessionStorage 에 안 남긴다: 대회마다
       처음 보는 것은 칩 순위여야 하고, 상금표는 궁금할 때 한 번 넘겨 보는 것이다. */
    var ltab = 'rank', ltabBound = false;
    function bindLobbyTabs(){
      if (ltabBound) return;
      var wrap = document.getElementById('htLobbyTabs');
      if (!wrap) return;
      ltabBound = true;
      wrap.addEventListener('click', function(e){
        var b = e.target.closest ? e.target.closest('.ht-tab') : null;
        if (!b) return;
        ltab = b.getAttribute('data-ltab') || 'rank';
        syncLobbyTabs();
      });
    }
    function syncLobbyTabs(){
      var wrap = document.getElementById('htLobbyTabs');
      if (!wrap) return;
      var tabs = wrap.querySelectorAll('.ht-tab');
      for (var i = 0; i < tabs.length; i++) {
        tabs[i].classList.toggle('active', tabs[i].getAttribute('data-ltab') === ltab);
      }
      document.getElementById('htLRank').hidden = ltab !== 'rank';
      document.getElementById('htLPrize').hidden = ltab !== 'prize';
    }
    /* 순위표 한 줄. 사람 하나에 줄 하나다 — 리바이를 세 번 해도 이름은 한 번만 선다
       (payload 의 players 가 이미 사람당 한 줄이라 그 성질을 그대로 물려받는다). */
    function lrankRow(p, n, meId){
      var out = !!p.out;
      /* 탈락자에게는 다음이 있는지를 적는다 — 남은 리바이가 있으면 아직 끝이 아니다.
         «완전 탈락» 은 더 살 수 없거나 이미 창이 닫힌 사람이다. */
      var tag = out
        ? (p.waiting ? '다음 판 대기'
          : p.rebuyLeft > 0 ? '리바이 ' + p.rebuyLeft + '회 남음' : '완전 탈락')
        : (p.rebuys > 0 ? p.rebuys + '차' : '');
      return '<div class="lr-row' + (out ? ' out' : '') + (p.userId === meId ? ' me' : '') + '">' +
        '<span class="lr-n">' + n + '</span>' +
        avatarHtml(p.userId, p.avatar, p.username, 'lr-av') +
        '<span class="lr-nm">' + esc(p.username) + '</span>' +
        (tag ? '<span class="lr-tag">' + esc(tag) + '</span>' : '') +
        '<span class="lr-st">' + (out ? '0' : num(p.stack || 0)) + '</span>' +
        '</div>';
    }
    function paintLobbyTabs(t, running, payTable){
      var wrap = document.getElementById('htLobbyTabs');
      if (!wrap) return;
      if (!running) { wrap.hidden = true; return; }
      bindLobbyTabs();
      var plist = t.players || [];
      /* 살아 있는 사람이 위, 칩 많은 순. 그 아래 탈락자는 «늦게 죽은 사람이 위» 다 —
         오래 버틴 순서이고, 그게 곧 등수다. 탈락 시각을 모르면(감추는 중) 맨 뒤로.
         정렬을 한 번만 하고 번호를 그 위에 붙인다: 두 무리를 따로 세면 번호가 겹친다. */
      /* 순위표도 같은 조건으로 가른다 — 위 격자와 갈리면 «의자에는 없는데 순위에는
         살아 있는» 사람이 생긴다. 칩이 0 인데 탈락 표시가 없는 칸은 아래로 보낸다. */
      var alive = [], dead = [];
      for (var i = 0; i < plist.length; i++) {
        (!plist[i].out && (plist[i].stack || 0) > 0 ? alive : dead).push(plist[i]);
      }
      alive.sort(function(a, b){ return (b.stack || 0) - (a.stack || 0); });
      dead.sort(function(a, b){ return (b.outAt || 0) - (a.outAt || 0); });
      var all = alive.concat(dead), rows = '';
      for (var j = 0; j < all.length; j++) rows += lrankRow(all[j], j + 1, MEID);
      var rankHtml = rows ? '<div class="lr-list">' + rows + '<\/div>'
        : '<div class="empty">아직 없습니다<\/div>';
      var rankEl2 = document.getElementById('htLRank');
      if (rankEl2.dataset.sig !== rankHtml) { rankEl2.dataset.sig = rankHtml; rankEl2.innerHTML = rankHtml; }
      var prizeEl2 = document.getElementById('htLPrize');
      var pz = payTable || '<div class="empty">상금 구조가 아직 없습니다<\/div>';
      if (prizeEl2.dataset.sig !== pz) { prizeEl2.dataset.sig = pz; prizeEl2.innerHTML = pz; }
      wrap.hidden = false;
      syncLobbyTabs();
    }
    function renderLobby(){
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
        action = t.iRegistered ? joinedBtn()
          : '<button type="button" class="btn btn-gold" id="htJoin">참가 신청</button>';
      } else if (t.status === 'WAITING_MIN_PLAYERS') {
        badge = '<span class="ht-badge wait">최소 인원 대기</span>';
        note = '최소 인원 대기 중 — ' + dur(t.graceEndsAt - now) + ' 남음';
        /* 시작 전에는 신청을 되돌릴 수 있다. 좌석과 스택은 대회가 시작될 때
           한꺼번에 만들어지므로, 이 시점의 취소는 등록 행 하나를 지우는 것뿐이다.
           시작한 뒤에는 이미 칩을 들고 앉아 있어 취소가 성립하지 않는다. */
        action = t.iRegistered ? joinedBtn()
          : '<button type="button" class="btn btn-gold" id="htJoin">참가 신청</button>';
      } else if (t.status === 'RUNNING') {
        /* 진행 중인 판에서 이 카드가 답해야 하는 것은 하나다 — «나는 지금 무엇을 할 수
           있나». 상태가 셋이고 각자 할 수 있는 일이 다르므로 단추도 셋으로 갈린다.
             탈락했는데 되살 수 있다  → 리바이(금색) + 관전(조용히)
             아직 앉아 있다            → 복귀(초록) — 내 판이 지금 돌고 있다
             그 밖                     → 관전(회색)
           예전에는 상태와 무관하게 [관전하기] 하나였고, 늦은 등록 창이 열려 있을 때만
           [Late Reg 참가하기] 가 붙었다. 죽은 사람에게 남은 유일한 길(리바이)이 이
           화면에는 없어서, 그걸 하려면 테이블로 들어가 팝업이 뜨기를 기다려야 했다. */
        var lateOpen = t.lateRegLeft != null;
        badge = lateOpen ? '<span class="ht-badge late">LATE REGIST</span>'
          : '<span class="ht-badge run">진행 중</span>';
        note = lateOpen ? '늦은 등록 마감까지 ' + dur(t.lateRegLeft)
          : '늦은 등록이 마감되었습니다';
        var rbS = t.rebuy;
        var seatedNow = st.table && st.table.mySeat != null;
        if (rbS && rbS.can) {
          /* 낼 돈이 없으면 누를 수 없게 둔다. 눌러 보고 «포인트가 부족합니다» 를
             듣는 것보다, 누르기 전에 못 누르는 것이 낫다 — 이미 죽은 마당에
             한 번 더 거절당할 이유가 없다. 대신 얼마가 있는지를 아래에 적는다:
             «부족하다» 만 있으면 얼마를 채워야 하는지 알 수 없다. */
          var poorNow = (st.balance || 0) < rbS.cost;
          action = '<button type="button" class="btn btn-gold" id="htRbGo2"'
              + (poorNow ? ' disabled' : '') + '>리바이 (' + num(rbS.cost) + 'P)</button>' +
            ' <button type="button" class="btn btn-sub" id="htSpectate">테이블 관전하기</button>'
            + (poorNow
              ? '<p class="ht-act-warn">보유 포인트가 부족합니다 (보유: '
                  + num(st.balance || 0) + ' P)</p>'
              : '');
        } else if (rbS && rbS.reason === 'revealing') {
          /* 죽긴 했는데 화면은 아직 그 판을 보여주는 중이다. 여기서 [리바이] 를 켜면
             그 단추 하나가 «너는 졌다» 를 카드보다 먼저 말한다 — 로비 카드에는 가릴
             연출이 없으니 아예 «아직 판이 도는 중» 으로 둔다. 몇 초 뒤 저절로 바뀐다. */
          action = '<button type="button" class="btn btn-back" id="htSpectate">테이블로 복귀하기</button>';
        } else if (rbS && rbS.reason === 'table_full') {
          /* 살 수는 있는데 앉을 데가 없다. 단추를 지우면 «리바이가 없는 판» 으로 읽히고,
             그냥 두면 눌렀다가 거절당한다 — 잠근 채로 이유를 이름에 적는다.
             자리는 곧 난다(누군가 죽거나 60초 우선권이 풀린다). */
          action = '<button type="button" class="btn btn-gold" disabled>빈자리 없음 (대기)</button>' +
            ' <button type="button" class="btn btn-sub" id="htSpectate">테이블 관전하기</button>' +
            '<p class="ht-act-warn">자리가 나면 리바이할 수 있습니다 (남은 리바이 '
              + rbS.left + '회)</p>';
        } else if (rbS && rbS.reason === 'rebuy_pending') {
          /* 이미 냈고 다음 판을 기다리는 중이다. 그 사실을 말하지 않으면 «돈만 나갔다» 가 된다. */
          action = '<button type="button" class="btn btn-sub" id="htSpectate">테이블 보기</button>' +
            '<p class="ht-act-note">리바이 완료 — 다음 판부터 참여합니다</p>';
        } else if (seatedNow) {
          action = '<button type="button" class="btn btn-back" id="htSpectate">테이블로 복귀하기</button>';
        } else if (lateOpen && !t.iRegistered) {
          action = '<button type="button" class="btn btn-gold" id="htJoin">Late Reg 참가하기</button>' +
            ' <button type="button" class="btn" id="htSpectate">관전하기</button>';
        } else {
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
        /* ── 진행 중에는 «신청자» 가 아니라 «누가 살아 있나» 다 ──────────
           시작 전에는 아홉 칸이 곧 신청 현황이라 이름과 빈칸만 있으면 됐다. 판이 열린
           뒤에는 같은 아홉 칸이 다른 것을 뜻한다 — 아홉이 다 차 보이는데 둘이 죽어
           두 자리가 비어 있을 수 있고, 리바이하려는 사람에게는 그 «두 자리» 가 전부다.
           그래서 세 갈래로 나눠 그린다: 살아 있음(칩 표시) · 탈락(흐리게 · 남은 리바이) ·
           빈자리(점선). 살아 있는 사람 먼저, 죽은 사람은 아래로 민다. */
        /* 판이 돌고 있으면 이 격자는 «테이블» 이다 — 실제로 앉아 있는 사람과 빈 의자.
           탈락자는 의자에서 일어난 사람이라 여기 두지 않는다. 예전에는 아래로 밀어
           함께 그렸는데, 그러면 아홉 칸이 늘 꽉 차 보여서 «자리가 몇 개 비었나» 가
           안 읽혔다 — 리바이하려는 사람에게는 그 숫자가 전부다.
           탈락자는 아래 [칩 순위] 탭이 순서까지 붙여 따로 맡는다. */
        /* «살아 있다» 의 조건은 둘이다 — 탈락 표시가 없고, 칩이 있다.
           서버가 이 둘을 함께 보내지만 한쪽만 믿으면 유령이 생긴다: 방금 죽은 사람을
           잠깐 살아 있는 것으로 보여주는 구간(결과 스포 방지)에서 칩이 0 이면
           «초록 카드인데 숫자가 없는» 칸이 되고, 그건 살아 있다는 말도 죽었다는 말도
           아니다. 둘 다 맞을 때만 의자에 앉힌다. */
        function aliveNow(p){ return !p.out && (p.stack || 0) > 0; }
        var running = t.status === 'RUNNING';
        var ordered = plist;
        if (running) {
          var alive = [];
          for (var oi = 0; oi < plist.length; oi++) if (aliveNow(plist[oi])) alive.push(plist[oi]);
          /* 칩이 많은 순 — 아래 순위표와 같은 순서여야 두 화면이 같은 판으로 읽힌다 */
          alive.sort(function(a, b){ return (b.stack || 0) - (a.stack || 0); });
          ordered = alive;
        }
        var slots = '';
        for (var si = 0; si < t.maxPlayers; si++) {
          var p = ordered[si];
          if (p) {
            var isMe = p.userId === MEID;
            if (running) {
              /* 탈락자에게는 «몇 번 더 살 수 있나» 를 적는다. 남의 것도 적는 이유:
                 마지막 자리를 두고 누가 돌아올 수 있는지가 내 판단에 들어간다. */
              var tag = p.out
                ? (p.waiting ? '대기 중'
                  : p.rebuyLeft > 0 ? '리바이 ' + p.rebuyLeft + '회 남음' : '탈락')
                : (p.stack != null ? num(p.stack) : '');
              slots += '<div class="ht-reg' + (isMe ? ' me' : '') + (p.out ? ' dead' : ' alive')
                  + '" title="' + esc(p.username) + '">' +
                avatarHtml(p.userId, p.avatar, p.username, 'ht-reg-av') +
                '<span class="ht-reg-nm">' + esc(p.username) + '</span>' +
                (tag ? '<span class="ht-reg-tag">' + esc(tag) + '</span>' : '') +
                '</div>';
              continue;
            }
            slots += '<div class="ht-reg' + (isMe ? ' me' : '') + '" title="' + esc(p.username) + '">' +
              avatarHtml(p.userId, p.avatar, p.username, 'ht-reg-av') +
              '<span class="ht-reg-nm">' + esc(p.username) + '</span></div>';
          } else {
            var needed = si < t.minPlayers;
            slots += '<div class="ht-reg empty' + (needed ? ' need' : '') + '">' +
              '<span class="ht-reg-av ph"></span>' +
              /* "더 필요" 는 무엇이 더 필요한지 안 적혀 있어 말이 끊긴 것처럼 읽혔다.
                 이 칸이 뜻하는 것은 "여기까지 차야 판이 열린다" 이므로 그 기준의
                 이름을 그대로 쓴다 — 아래 정보 카드의 [최소 인원 3명] 과 같은 말이다. */
              '<span class="ht-reg-nm">' + (needed ? '최소 인원' : '빈자리') + '</span></div>';
          }
        }
        /* 최소 인원을 채운 것과 자리가 다 찬 것은 다른 말이다. 3/9 에 "인원이 찼습니다"라고
           적으면 더 못 들어오는 것으로 읽힌다 — 실제로는 여섯 자리가 비어 있다. */
        var short = Math.max(0, t.minPlayers - plist.length);
        var sub = short > 0 ? short + '명 더 모이면 열립니다'
          : t.startedAt ? '진행 중'
          : plist.length >= t.maxPlayers ? '자리가 모두 찼습니다'
          : '인원이 모여 예정대로 시작합니다';
        /* 진행 중이면 머리글도 «신청자» 가 아니다 — 지금 보는 것은 생존 현황이다.
           빈자리 수를 같이 적는다: 리바이할 수 있는지가 그 숫자 하나로 정해진다. */
        if (running) {
          var freeN = t.freeSeats != null ? t.freeSeats
            : Math.max(0, t.maxPlayers - ordered.length);
          sub = '생존 ' + ordered.length + '명 · 빈자리 ' + freeN + '개';
        }
        roster = '<h3 class="ht-h3">' + (running ? '테이블' : '신청자')
            + ' <span class="ht-h3sub">' + esc(sub) + '</span></h3>' +
          '<div class="ht-regs">' + slots + '</div>';
      }

      /* ── 모드 뱃지 ────────────────────────────────────────────────
         제목만 보면 이 판이 클래식인지 바운티인지 알 수 없었다. 참가를 정하기 전에
         알아야 하는 정보다 — 바운티는 순위 상금이 절반으로 줄고 대신 남을 떨어뜨려
         버는 판이라, 같은 "프리롤" 이라도 성격이 다르다. */
      var isPko = t.mode === 'PKO_BOUNTY' || t.mode === 'MYSTERY_BOUNTY';
      var isMys = t.mode === 'MYSTERY_BOUNTY';
      var modeBadge = isMys
        ? '<span class="ht-mode mys">미스터리 바운티<\/span>'
        : (isPko ? '<span class="ht-mode bty">바운티<\/span>'
                 : '<span class="ht-mode cls">클래식<\/span>');

      /* ── 상금 풀 ──────────────────────────────────────────────────
         여기는 순위 상금만 적고 있었다(t.prizePool). 바운티 대회에서는 참가비의 절반이
         바운티로 빠지므로, 그 값은 실제로 걸린 돈의 절반이다 — 10,000P 짜리 판이
         5,000P 로 보였다. 인게임 사이드 패널은 이미 합계로 그리고 있어서 같은 대회가
         두 화면에서 다른 금액으로 보이기까지 했다.
         총액을 크게 적고 갈래는 아래 작은 줄로 둔다. */
      var btyPool = isPko ? (t.bountyPool || 0) : 0;
      var poolTotal = (t.prizePool || 0) + btyPool;
      var poolSub = isPko
        ? '<span class="ht-sub">순위 ' + num(t.prizePool || 0) + 'P + 바운티 '
            + num(btyPool) + 'P<\/span>'
        : '';

      /* ── 바운티 배너 ──────────────────────────────────────────────
         전에는 상금표 맨 아래에 작은 한 줄로 있었다. 그 자리는 표를 다 읽고 나서야
         닿는 곳이라, 정작 이 대회를 고를 이유(잭팟이 얼마까지 나오나)가 맨 나중에
         읽혔다. 상금 구조의 머리로 올린다.

         이모지는 안 쓴다 — 대괄호 표지와 색으로 구분한다. */
      var btyPct = t.bountyPct || 50;
      var splitBanner = '';
      if (isPko) {
        splitBanner =
          '<div class="ht-bty-banner' + (isMys ? ' mys' : '') + '">' +
            '<span class="ht-bty-tag">' + (isMys ? 'MYSTERY BOUNTY' : 'BOUNTY') + '<\/span>' +
            (isMys && t.mysteryTop
              ? '<span class="ht-bty-top">최고 잭팟 바운티 <b>' + num(t.mysteryTop) + 'P<\/b><\/span>'
              : '') +
            '<span class="ht-bty-split">순위 상금 ' + (100 - btyPct)
              + '% / 바운티 풀 ' + btyPct + '%<\/span>' +
          '<\/div>';
      }

      /* ── 이월 배너 ────────────────────────────────────────────────
         못 열린 회차만큼 프리롤 배수가 커진다(db/rollover.ts). 금액에는 이미 반영돼
         있으므로 여기서 다시 계산하지 않고, "왜 평소보다 큰가"만 말한다 — 안 적으면
         상금이 갑자기 네 배가 된 이유를 아무도 모른다. 이모지는 안 쓴다. */
      /* 상금 풀 총액이 아니라 1인당으로 적는다. 총액은 인원에 비례하므로 아직 아무도
         신청하지 않았으면 0P 다 — "상금 풀 0P · 평소의 3배" 는 이월을 알리려던 배너가
         정반대로 읽히는 문장이다. 1인당 금액은 인원과 무관하게 지금 확정돼 있고,
         예고 카드와도 같은 말이 된다. */
      var skips = t.rolloverSkips || 0;
      var rollBanner = skips > 0
        ? '<div class="ht-roll">' +
            '<span class="ht-roll-tag">이월 ' + skips + '회<\/span>' +
            '<span class="ht-roll-txt">열리지 못한 회차가 얹혀 1인당 <b>'
              + num(t.multiplier || 0) + 'P<\/b> 적립 — 평소의 <b>'
              + (skips + 1) + '배<\/b><\/span>' +
          '<\/div>'
        : '';

      var payTable = '';
      if (rowCount) {
        var rows = '';
        for (var pi = 0; pi < rowCount; pi++) {
          var res = resList[pi];
          var place = res ? res.place : pi + 1;
          /* 받은 돈은 순위 상금 + 바운티다. 순위 상금만 적으면 바운티 대회의 절반이
             사라진다 — 3위로 끝났지만 바운티로 10,000P 를 번 사람이 "0P" 로 찍힌다.
             (우승 팝업도 같은 이유로 합계를 적는다.)
             아직 안 끝난 대회에서는 res 가 없어 상금 구조표를 그리는데, 그때는 바운티가
             누구에게 갈지 정해지지 않았으므로 등수별 상금만 적는 것이 맞다. */
          var amt = res ? (res.prize || 0) + (res.bounty || 0) : (prizeList[pi] || 0);
          // 상금을 받는 자리만 밝게. 나머지는 가라앉히고 금액도 0P로 적는다("-"는 정보가 없다)
          var itm = amt > 0;
          rows += '<tr class="' + (itm ? 'itm' : 'out') + '">' +
            '<td class="pl">' + place + '위</td>' +
            '<td class="nm">' + (res ? esc(res.username) : '<i>—<\i>') + '</td>' +
            '<td class="pz">' + num(amt) + 'P</td></tr>';
        }
        /* 바운티 판은 표 아래에 분배율을 적는다. 표에 적힌 등수별 금액이 전부가
           아니라는 것을 말해 주지 않으면, 순위 상금만 보고 "이 판은 절반짜리" 로
           읽힌다. 미스터리는 봉투 최고액도 함께 알린다 — 그게 이 모드를 고르는 이유다. */
        payTable = '<h3 class="ht-h3">' + (resList.length ? '결과' : '상금 구조') + '</h3>' +
          splitBanner +
          '<table class="ht-prize"><thead><tr><th>순위</th><th>플레이어</th><th>상금</th></tr></thead>' +
          '<tbody>' + rows + '<\/tbody><\/table>';
      } else if (splitBanner) {
        /* 등수표가 아직 없어도(참가자가 적어 지급 인원이 안 잡힌 때) 배너는 띄운다 —
           이 대회가 어떤 판인지는 표와 상관없이 알려야 한다. */
        payTable = '<h3 class="ht-h3">상금 구조</h3>' + splitBanner;
      }

      /* 안내 문구는 배지 옆으로 붙인다. 한 줄짜리 <p>로 따로 두면 그 줄 하나 때문에
         위아래 여백이 두 겹 생겨 카드가 늘어졌다 — 상태를 말하는 짧은 문장이므로
         상태 배지와 같은 줄에 있는 것이 읽기에도 맞다. */
      /* ── 왜 통째로 다시 그리지 않는가 ────────────────────────────────
         이 함수는 1초마다 불린다. 예전에는 그때마다 lobbyEl.innerHTML 을 새로 대입해서
         카드 안의 모든 노드가 사라지고 다시 태어났다 — 단추도 포함이다.

         그래서 누르는 동안 틱이 한 번 끼면, 눌렀던 그 노드가 없어진 채로 손을 떼게 되고
         브라우저는 click 을 아예 만들지 않는다. 누른 사람 눈에는 "눌렀는데 아무 일도
         없었다"로 보인다. 사람이 단추를 누르는 데 걸리는 시간이 100ms 안팎이니
         열 번에 한 번꼴로 삼켜졌고, 망설이다 누르는 [등록 취소]에서 특히 잦았다.

         고치는 방법은 안 지우는 것이다. 매 초 바뀌는 값은 남은 시간 하나뿐이므로,
         그 자리를 표식으로 비운 "뼈대"를 만들어 지난번 것과 견준다. 같으면 DOM 은
         손대지 않고 남은 시간 글자만 갈아 끼운다 — 단추는 계속 같은 노드로 살아 있다.
         상태가 실제로 바뀌었을 때만(신청·취소·인원 변동) 다시 그린다. */
      /* ── 여섯 칸 ────────────────────────────────────────────────
         시작 전과 진행 중은 알고 싶은 것이 다르다.
           시작 전 — 갈까 말까: 몇 명 모였나 · 얼마 걸렸나 · 참가비 · 시작 스택 ·
                     몇 명이 받나 · 몇 명이면 열리나
           진행 중 — 지금 어떤가: 몇 명 남았나 · 지금 얼마 · 블라인드가 어디까지 왔나 ·
                     평균 스택이 시작 스택 대비 어떤가
         같은 여섯 칸을 그대로 두면 진행 중인 판에서 «최소 인원 3명» 같은, 이미 지나간
         조건이 자리를 차지한다. 칸 수와 모양은 같게 두고 내용만 바꾼다 — 카드가
         갑자기 다른 물건이 되지 않아야 상태가 넘어가는 것으로 읽힌다. */
      var tbNow = st.table;
      var running = t.status === 'RUNNING' && tbNow != null;
      var costCell = t.buyIn > 0
        /* 참가비가 있으면 그 자리에 참가비를 적는다. "1인당 배수"는 프리롤에서
           서비스가 얹어 주는 금액이라 참가비 대회에서는 뜻이 없다 — 두 값을 나란히
           두면 어느 쪽이 내 돈인지 헷갈린다. */
        ? '<div><span class="k">참가비</span><span class="v warn">' + num(t.buyIn) + 'P</span></div>'
        : '<div><span class="k">1인당</span><span class="v">' + num(t.multiplier) + 'P</span></div>';
      var poolCell = '<div><span class="k">상금 풀</span><span class="v gold">'
        + num(poolTotal) + 'P</span>' + poolSub + '</div>';
      var gridHtml = running
        ? '<div class="ht-grid">' +
            /* «남은 인원 / 총 참가자». 총은 사람 수다 — 엔트리 수로 적으면 리바이가
               있는 판에서 «6 / 11명» 이 되어 다섯이 어디 갔는지 설명할 자리가 없다.
               리바이 횟수는 아래 상금 풀이 이미 설명한다. */
            '<div><span class="k">남은 인원</span><span class="v">' + tbNow.remaining
              + ' / ' + t.registered + '명</span></div>' +
            poolCell +
            /* 블라인드는 «레벨» 만으로는 크기를 모르고 «75/150» 만으로는 어디쯤인지를
               모른다. 큰 글자에 레벨, 아래 작은 줄에 실제 금액 — 둘 다 있어야 읽힌다. */
            '<div><span class="k">블라인드</span><span class="v">Level ' + tbNow.level.level
              + '</span><span class="ht-sub">' + num(tbNow.level.sb) + ' / ' + num(tbNow.level.bb)
              + (tbNow.level.ante > 0 ? ' · 앤티 ' + num(tbNow.level.ante) : '') + '</span></div>' +
            '<div><span class="k">시작 스택</span><span class="v">' + num(t.startingStack) + '</span></div>' +
            /* 평균 스택은 시작 스택 옆에 있어야 뜻이 생긴다 — 600 이 큰지 작은지는
               시작이 얼마였는지를 알아야 정해진다. */
            '<div><span class="k">평균 스택</span><span class="v">' + num(tbNow.avgStack) + '</span></div>' +
            '<div><span class="k">지급 인원</span><span class="v">' + t.itm + '명</span></div>' +
          '</div>'
        : '<div class="ht-grid">' +
            '<div><span class="k">참가자</span><span class="v">' + t.registered + ' / ' + t.maxPlayers + '</span></div>' +
            poolCell +
            costCell +
            '<div><span class="k">시작 스택</span><span class="v">' + num(t.startingStack) + '</span></div>' +
            '<div><span class="k">지급 인원</span><span class="v">' + t.itm + '명</span></div>' +
            '<div><span class="k">최소 인원</span><span class="v">' + t.minPlayers + '명</span></div>' +
          '</div>';

      /* 진행 중이면 아래 두 탭이 상금표를 맡는다 — 카드 안에 그대로 두면 같은 표가
         두 번 나온다. 시작 전·끝난 뒤에는 탭이 안 뜨므로 예전처럼 카드 안에 둔다. */
      var cardPay = running ? '' : payTable;

      var shell =
        '<div class="ht-card">' +
          /* 머리를 세 줄로 나눈다.
             예전에는 제목 왼쪽에 모드 뱃지가 붙고 오른쪽에 상태 뱃지와 남은 시간이
             따로 떠 있어서, 한 줄에 성격이 다른 네 가지가 섞였다 — 눈이 제목을
             찾으려면 뱃지를 먼저 지나야 했다.
               1행  무슨 판인가(모드·상태)          |  언제까지인가(남은 시간)
               2행  대회 이름 — 이 카드의 주인공이라 혼자 쓴다
               3행  날짜와 시각 */
          '<div class="ht-head">' +
            '<div class="ht-head-meta">' +
              /* 모드 · 리바이 · 상태 순. 앞의 둘은 «어떤 판인가»(열리기 전에 이미
                 정해진 것)이고 상태는 «지금 어떤가»(계속 바뀌는 것)라, 안 바뀌는 것부터
                 세운다. */
              '<span class="ht-head-badges">' + modeBadge
                + rebuyBadge(t.rebuy ? t.rebuy.max : 0) + badge + '</span>' +
              /* 시간은 여기 한 곳에만 들어간다. 아래 뼈대 비교가 이 자리를 표식으로
                 비워 두고 견주므로, 다른 곳에 초 단위 값이 새로 생기면 뼈대가 매 초
                 달라져서 단추가 다시 1초마다 무너진다 — 새 값은 반드시 이 note 로. */
              (note ? '<span class="ht-note">' + NOTE_SLOT + '</span>' : '') +
            '</div>' +
            '<h2 class="ht-title">' + esc(t.title) + '</h2>' +
            '<p class="ht-when">' + esc(t.dateStr) + ' · 등록 ' + kstClock(t.regOpenAt) +
              ' · 시작 ' + kstClock(t.scheduledStartAt) + ' (KST)</p>' +
          '</div>' +
          rollBanner +
          /* 여섯 지표를 2×3 미니 카드로 나눈다. 줄 형태(k ····· v)로 쌓았을 때는
             여섯 줄이 같은 무게로 늘어서서 무엇을 봐야 할지 정해지지 않았다. */
          gridHtml +
          '<div class="ht-actions">' + action + '</div>' +
          roster +
          cardPay +
        '</div>';

      /* ── 아래 두 탭 ─────────────────────────────────────────────
         탭은 카드 «밖» 의 정적 껍데기다(holdem.ts 의 #htLobbyTabs). 그래서 카드가
         통째로 다시 그려져도 탭 선택이 안 풀리고, 탭을 눌러도 카드가 다시 그려지지
         않는다. 여기서는 두 칸의 «속» 만 갈아 끼운다.
         진행 중일 때만 세운다 — 시작 전에는 순위라 할 것이 없고(전원 같은 스택),
         끝난 뒤에는 카드 안의 결과표가 그 일을 한다. */
      paintLobbyTabs(t, running, payTable);

      /* 뼈대가 그대로면 남은 시간만 바꾸고 끝낸다. 여기서 돌아가면 아래 바인딩도
         건너뛰는데, 그래도 되는 이유는 단추가 지워진 적이 없어서 예전에 붙인 리스너가
         그대로 살아 있기 때문이다. 다시 붙이면 오히려 한 번 누른 것이 두 번 실행된다. */
      if (shell === lastShell) {
        if (noteEl && noteEl.isConnected) noteEl.textContent = note;
        return;
      }
      lastShell = shell;
      lobbyEl.innerHTML = shell.replace(NOTE_SLOT, function(){ return esc(note); });
      noteEl = lobbyEl.querySelector('.ht-note');

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
          /* 늦은 등록이면 이미 판이 돌고 있다 — 그대로 들여보낸다. 시작 전 신청이면
             테이블 자체가 없으므로 이 표시는 아무 일도 하지 않고, 판이 열릴 때
             render 가 «방금 열렸다» 를 보고 들여보낸다. */
          else if (t.status === 'RUNNING') enterTable(t);
          pollNow();
        });
      });
      /* 카드에서 바로 리바이한다. 팝업(.ht-rb)과 같은 일을 하지만 여기서는 확인 창이
         한 겹 더 필요하다 — 팝업은 «방금 죽었다» 는 맥락 위에 떠서 금액이 이미 눈앞에
         있지만, 카드는 아무 때나 들어와서 누를 수 있는 자리다. */
      /* 카드의 [리바이] 는 «결제» 가 아니라 «창 열기» 다.
         결제는 리바이 창(.ht-rb)이 맡는다 — 비용 · 지급 스택 · 남은 횟수 · 마감 시계를
         이미 그 창이 다 적고 있고, 잔고가 모자라면 단추를 잠그는 것도 그쪽이다.
         여기서 confirm() 으로 한 번 더 묻던 것을 걷어냈다: 환경에 따라 confirm 이
         대화상자 없이 그냥 false 를 돌려준다(내장 브라우저 · 앱 웹뷰). 그러면 단추를
         눌러도 «아무 일도 안 일어남» 이 된다 — 실제로 그렇게 보고됐다.
         묻는 자리를 하나로 모으면 그런 일이 생길 자리도 하나가 된다. */
      var rbGo2 = document.getElementById('htRbGo2');
      if (rbGo2) rbGo2.addEventListener('click', function(){ rbShow(); });

      var spec = document.getElementById('htSpectate');
      var leave = document.getElementById('htLeave');
      if (leave) leave.addEventListener('click', function(){
        if (!confirm('참가 신청을 취소할까요?'
          + (t.buyIn > 0 ? '\\n참가비 ' + num(t.buyIn) + 'P는 돌려드립니다.' : ''))) return;
        /* 누른 것이 닿았다는 표시를 즉시 준다. 응답까지 아무 변화가 없으면 안 눌린 줄
           알고 한 번 더 누르는데, 두 번째는 이미 지워진 등록을 지우려다 "신청하지
           않으셨습니다" 경고를 띄운다 — 사실 첫 번째가 성공한 것인데도. */
        leave.disabled = true;
        leave.classList.add('is-busy');
        post('/api/games/holdem/unregister', {}).then(function(r){
          if (!r.ok) {
            alert(r.d && r.d.error ? r.d.error : '취소할 수 없습니다');
            leave.disabled = false;
            leave.classList.remove('is-busy');
            return;
          }
          /* 성공했으면 서버 상태를 곧바로 다시 받는다. 다음 폴링을 기다리면 최대 1초
             동안 [참가 완료]가 남아 있어서, 취소가 된 것인지 아닌지 알 수 없다.
             참가자 수·내 참가 여부·좌석은 전부 이 한 번의 상태 응답에서 온다 —
             화면이 저 혼자 앞서 나가서 서버와 어긋나는 길을 만들지 않는다. */
          pollNow();
        });
      });
      /* [관전하기]·[테이블로 복귀하기] — 하는 일은 같다. 판으로 들어간다.
         문구만 상태에 따라 다른 이유는, 앉아 있는 사람에게 «관전» 이라고 쓰면
         제 자리가 사라진 줄 알기 때문이다. */
      if (spec) spec.addEventListener('click', function(){
        spectate = true; enterTable(t); render();
      });
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
