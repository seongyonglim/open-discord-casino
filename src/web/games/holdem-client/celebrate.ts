/* 홀덤 화면 — 우승 축하 팝업 — 정산 연출이 끝난 뒤에 뜬다.

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
export const CELEBRATE = `       서버를 다시 띄우면 그날 대회가 같은 id로 초기화된다) 축하가 영구히 억제된다.
       실제로 이 때문에 "우승 연출이 안 뜬다"는 제보가 나왔다. */
    function celebrateKey(t){ return 'od_ht_win_' + t.id + ':' + (t.finishedAt || 0); }
    /* 마지막 판의 정산 연출이 100% 끝났나.
       예전에는 서버가 준 링거(고정 초)만 보고 넘어갔다. 고정 시간이라 판마다 어긋난다 —
       폴드로 끝난 판에서는 한참 남아 빈 테이블을 보고 있었고, 프리플랍 올인으로 끝난
       판에서는 보드가 아직 깔리는 중에 팝업이 그 위를 덮었다.
       이제 연출이 스스로 "끝났다"고 말한다(potDoneAt). 링거는 그 사이 테이블을
       살려 두는 상한일 뿐이고, 축하 시점을 정하지 않는다.

       "아직 시작 안 함"과 "할 것이 없음"을 가르는 것이 핵심이다. 처음에는 정산이
       시작됐는지(potPaidHand)만 봤는데, 마지막 판이 끝난 직후는 아직 카드를 여는
       중이라 정산이 시작 전이고 — 그걸 "할 것이 없음"으로 읽어 팝업이 먼저 떴다.
       실측으로 팝업 t=119.7초, WIN 배지 t=123.8초, 칩 이동 t=126.3초였다.
       그래서 판 자체를 본다: 상금이 걸린 판이면 아직 시작 전이어도 기다린다. */
    var WIN_POPUP_AFTER_MS = 500;
    /* 팝업은 저절로 닫지 않는다. 잠깐 자리를 비운 사이에 결과가 사라지면 무슨 일이
       있었는지 알 방법이 없다 — 읽는 속도는 사람마다 다르고, 그걸 초로 정할 이유가 없다.
       [확인]을 누를 때만 닫힌다. */
    function settleDone(tb){
      /* potDoneAt은 반드시 이 판의 것이어야 한다. 판 번호를 같이 안 보면 직전 판에서
         남은 값(이미 지난 시각)이 "이 판도 끝났다"로 읽힌다 — 실제로 그래서 마지막
         판의 카드가 열리기도 전에 팝업이 떴다(실측 t=176.9초 팝업, t=178.0초 첫 핸드). */
      if (potDoneHand === tb.handNo && potDoneAt) {
        return Date.now() >= potDoneAt + WIN_POPUP_AFTER_MS;
      }
      var r = tb.ended && tb.result;
      var payable = !!r && (((r.awards || []).length > 0) || ((r.potAwards || []).length > 0));
      return !payable;
    }
    function celebrate(){
      var t = st.tournament;
      if (t.status !== 'FINISHED') return;
      var results = st.results || [];
      if (!results.length) return;
      // 마지막 판의 팟이 승자에게 다 들어간 뒤에 축하한다
      if (st.table && st.table.tournamentOver && !settleDone(st.table)) return;
      var key = celebrateKey(t);
      try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); }
      catch (e) { /* 저장을 못 쓰는 환경이면 매번 뜬다 — 축하가 안 뜨는 것보다 낫다 */ }

      var first = results[0];
      document.getElementById('htWinAv').innerHTML =
        avatarHtml(first.userId, first.avatar, first.username, 'ht-win-av');
      document.getElementById('htWinWho').textContent = first.username;
      document.getElementById('htWinPrize').textContent =
        first.prize > 0 ? num(first.prize) + 'P' : '';
      /* 상금을 받은 자리와 못 받은 자리를 눈으로 갈라 놓는다.
         예전에는 2~4위를 한 덩어리로 같은 톤에 늘어놓고 상금란에 '-'를 찍었다.
         입상 여부가 이 표의 유일한 의미인데 그게 표에서 안 보였고, '-'는 "정보가 없다"는
         뜻이라 "0원을 받았다"와 다르다. 이제 입상자는 카드로 세우고, 미입상자는
         가라앉혀 0P로 적는다. */
      document.getElementById('htWinRest').innerHTML = results.slice(1).map(function(r){
        var itm = r.prize > 0;
        return '<div class="ht-win-row' + (itm ? ' itm' : ' out') + '">' +
          '<span class="ht-win-pl">' + r.place + '위</span>' +
          avatarHtml(r.userId, r.avatar, r.username, 'ht-win-av sm') +
          '<span class="ht-win-nm">' + esc(r.username) + '</span>' +
          '<span class="ht-win-pz">' + num(r.prize) + 'P</span></div>';
      }).join('');
      winEl.hidden = false;
      if (window.casinoSfx && window.casinoSfx.victory) window.casinoSfx.victory();
      // 우승 기록이 하나 늘었다 — 역대 전적을 다시 받아 온다
      if (recAsked) loadRecords(true);
    }
    /* 팝업을 닫고 곧바로 로비로 나간다.
       서버는 끝난 뒤에도 잠시 테이블을 계속 내려보내는데(마지막 쇼다운을 보여주려는
       창이다), 그동안 화면이 테이블에 붙들려 있으면 팝업만 사라지고 갈 데가 없다.
       그래서 이 대회의 테이블은 더 그리지 않겠다고 표시해 둔다.

       표시는 sessionStorage 에도 남긴다. 탭을 새로 고치거나 다른 화면을 들렀다 와도
       이미 끝난 판의 테이블로 되돌아가지 않아야 한다 — 메모리에만 두면 새로고침 한 번에
       풀린다. 열쇠는 축하 팝업이 쓰는 것과 같다(대회 id + 끝난 시각). */
    function closeWin(t){
      winEl.hidden = true;
      if (t) {
        leftTableTid = t.id;
        try { sessionStorage.setItem('od_ht_left_' + t.id, '1'); } catch (e) { /* 없어도 동작한다 */ }
      }
      render();      // 테이블을 접고 로비를 그린다
      poll();        // 결과·역대 전적을 최신으로 한 번 당겨온다
    }
    document.getElementById('htWinClose').addEventListener('click', function(){
      closeWin(st && st.tournament ? st.tournament : null);
    });

    /* ── 역대 전적 탭 ─────────────────────────────────────────────────
       지표를 게임별 랭킹(판수·승률·수익액)과 다르게 잡는다. 프리롤은 참가비가 0이라
       상금만 양수로 들어와서 "수익액"이 실력과 무관하게 참가 횟수만큼 오른다.
       그래서 우승·입상·참가·누적 상금을 센다.

       처음 열 때 한 번만 받아 온다. 판마다 바뀌는 값이 아니라 매초 받을 이유가 없고,
       대회가 끝나면 그때 한 번 더 받는다(우승 기록이 늘었으므로). */
    /* 표는 두 곳에 걸린다 — 로비(#htLobbyRecList)와 테이블 오른쪽 패널(#htRecList).
       받아 온 줄을 한 번만 담아 두고 두 곳에 같이 그린다. 화면마다 따로 받으면
       같은 순위표가 두 벌이 되고, 대회가 끝날 때 한쪽만 갱신되는 일이 생긴다. */
`;
