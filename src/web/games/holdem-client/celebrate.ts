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
    /* 팝업을 닫고 나온 기록. 축하 열쇠와 같은 모양이어야 한다 — 대회 id만 쓰면 같은 id가
       다시 살아났을 때(운영자가 진행 중인 대회를 되감으면 finished_at 이 지워지고 id는
       그대로다) "이미 나온 대회"로 읽혀 테이블에 영영 못 들어간다. 시뮬레이션에서 실제로
       그랬다 — DB 를 새로 만들어도 id 가 1부터라 지난 실행의 기록이 화면을 막았다. */
    function leftKey(t){ return 'od_ht_left_' + t.id + ':' + (t.finishedAt || 0); }
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
      /* 바운티 대회는 그 뒤에 처형(총 3발)과 현상금 상승이 더 남아 있다. 팝업이 먼저
         뜨면 화면을 덮어 마지막 KO 연출과 오른 현상금을 통째로 못 본다 — 실제로
         처형과 팝업이 동시에 떴다(제보).

         koBurstEndsAt 은 총격이 끝나는 시각이고(seats.ts 가 잡는다), 그 뒤에 오르는
         현상금 숫자가 1.4초 떠 있다. 그것까지 지나고 나서 축하로 넘어간다.
         조각들은 하나의 클로저를 공유하므로 여기서 그 값이 보인다. */
      if (typeof koBurstEndsAt === 'number' && koBurstEndsAt > 0
        && Date.now() < koBurstEndsAt + KO_GAIN_HOLD_MS) return;
      /* 미스터리는 처형 다음에 상자 개봉이 더 남아 있다. 마지막 KO 가 곧 우승이라
         팝업과 상자가 정확히 같은 순간에 겹친다 — 그러면 이 모드에서 금액이 공개되는
         유일한 자리를 통째로 못 본다(머리 위에는 숫자가 없다). */
      if (typeof mysBoxEndsAt === 'number' && mysBoxEndsAt > 0
        && Date.now() < mysBoxEndsAt + KO_GAIN_HOLD_MS) return;
      var key = celebrateKey(t);
      try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); }
      catch (e) { /* 저장을 못 쓰는 환경이면 매번 뜬다 — 축하가 안 뜨는 것보다 낫다 */ }

      /* 받은 돈은 순위 상금 + 바운티다. 순위 상금만 적으면 바운티 대회의 절반이
         사라진다 — 3위로 끝났지만 바운티로 10,000P 를 번 사람이 "0P" 로 찍혔다(제보).
         두 갈래를 나눠 적지 않고 합계 하나로 둔다: 이 팝업은 "얼마 받았나"를 말하는
         자리이고, 갈래는 상금 탭이 이미 보여준다. */
      function tookOf(r){ return (r.prize || 0) + (r.bounty || 0); }
      var first = results[0];
      document.getElementById('htWinAv').innerHTML =
        avatarHtml(first.userId, first.avatar, first.username, 'ht-win-av');
      document.getElementById('htWinWho').textContent = first.username;
      document.getElementById('htWinPrize').textContent =
        tookOf(first) > 0 ? num(tookOf(first)) + 'P' : '';
      /* 상금을 받은 자리와 못 받은 자리를 눈으로 갈라 놓는다.
         예전에는 2~4위를 한 덩어리로 같은 톤에 늘어놓고 상금란에 '-'를 찍었다.
         입상 여부가 이 표의 유일한 의미인데 그게 표에서 안 보였고, '-'는 "정보가 없다"는
         뜻이라 "0원을 받았다"와 다르다. 이제 입상자는 카드로 세우고, 미입상자는
         가라앉혀 0P로 적는다. */
      document.getElementById('htWinRest').innerHTML = results.slice(1).map(function(r){
        /* 카드로 세울지 가라앉힐지도 합계로 가른다 — 순위 상금만 보면 바운티로만 번
           사람이 "못 받은 자리" 톤으로 그려진다. */
        var itm = tookOf(r) > 0;
        return '<div class="ht-win-row' + (itm ? ' itm' : ' out') + '">' +
          '<span class="ht-win-pl">' + r.place + '위</span>' +
          avatarHtml(r.userId, r.avatar, r.username, 'ht-win-av sm') +
          '<span class="ht-win-nm">' + esc(r.username) + '</span>' +
          '<span class="ht-win-pz">' + num(tookOf(r)) + 'P</span></div>';
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
        try { sessionStorage.setItem(leftKey(t), '1'); } catch (e) { /* 없어도 동작한다 */ }
      }
      render();      // 테이블을 접고 로비를 그린다
      poll();        // 결과·역대 전적을 최신으로 한 번 당겨온다
    }
    document.getElementById('htWinClose').addEventListener('click', function(){
      closeWin(st && st.tournament ? st.tournament : null);
    });

    /* ── 리바이 ────────────────────────────────────────────────────────
       탈락한 순간에 «다시 도전하겠는가» 를 묻는다.

       띄울지 말지는 서버가 정한다(st.tournament.rebuy.can). 조건이 여섯이고
       (대회가 리바이를 허용하나 · 횟수가 남았나 · 시작했나 · 늦은 등록 창 안인가 ·
       내가 탈락했나 · 자리가 있나) 그중 셋은 서버만 아는 값이다. 화면이 같은 판단을
       한 벌 더 갖고 있으면 언젠가 두 판단이 갈린다 — 그때 «떠야 하는데 안 뜨는»
       쪽으로 갈리면 사람은 리바이 기회를 통째로 잃는다.

       이 판에서 «관전하겠다» 를 한 번 고르면 다시 묻지 않는다. 표시는
       sessionStorage 에 둔다: 새로고침 한 번에 풀리면 안 되고(같은 판이다),
       다음 판에는 다시 물어야 한다(열쇠에 대회 id 가 들어간다). */
    var rbEl = document.getElementById('htRb');
    var rbSkipped = false;
    function rbKey(t){ return 'od_ht_rbskip_' + t.id; }
    function rbSkippedFor(t){
      if (rbSkipped) return true;
      try { return sessionStorage.getItem(rbKey(t)) === '1'; } catch (e) { return false; }
    }
    function rebuyPrompt(){
      var t = st && st.tournament;
      var r = t && t.rebuy;
      if (!r || !r.can || rbSkippedFor(t)) { rbEl.hidden = true; return; }

      /* ── 결과가 다 나온 다음에 묻는다 ────────────────────────────
         서버는 «칩이 0 이 됐다» 를 endHand 에서 곧바로 쓴다. 그런데 화면은 그때부터
         보드를 마저 깔고 · 패를 열고 · 팟을 승자에게 보낸다 — 그 연출이 몇 초짜리다.
         그 사이에 창을 띄우면 카드가 열리기도 전에 «다시 도전하시겠습니까» 가 떠서,
         내가 졌다는 것을 연출보다 먼저 알려 준다. 결과를 스포한다.

         우승 팝업이 이미 같은 문제를 풀어 놓았다(settleDone). 그 신호를 그대로 쓴다 —
         판단 기준이 둘로 갈리면 언젠가 한쪽만 고쳐진다.
           · settleDone   팟이 승자에게 다 들어갔나 (+ 여유 0.5초)
           · koBurstEndsAt  바운티 처형 총격이 끝났나 — 마지막 총알이 나를 잡은 것이다
           · mysBoxEndsAt   미스터리 상자 개봉이 끝났나
         셋 다 우승 팝업이 기다리는 것과 같은 값이고, 셋 다 «나를 죽인 그 장면» 이다.
         그것을 다 보고 나서 묻는 것이 순서다.

         hidden 은 손대지 않고 그냥 돌아간다. 여기서 감추면 연출 도중에 창이 깜빡였다
         사라진 것처럼 보인다 — 아직 한 번도 안 떴으므로 그대로 두면 된다. */
      var tb = st.table;
      if (tb && !settleDone(tb)) return;
      if (typeof koBurstEndsAt === 'number' && koBurstEndsAt > 0
        && Date.now() < koBurstEndsAt + KO_GAIN_HOLD_MS) return;
      if (typeof mysBoxEndsAt === 'number' && mysBoxEndsAt > 0
        && Date.now() < mysBoxEndsAt + KO_GAIN_HOLD_MS) return;

      /* 시계·남은 횟수·비용은 매초 바뀔 수 있으므로 «글자만» 갈아 끼운다.
         상자를 통째로 다시 그리면 누르려던 버튼이 손가락 밑에서 사라진다. */
      var left = t.lateRegLeft;
      rbPut('htRbLeft', left != null ? mmss(left) : '–');
      rbPut('htRbLeftN', r.left + ' / ' + r.max + '회');
      /* 칩 수만으로는 «많은가» 를 알 수 없다. 600칩이 크게 들리지만 블라인드가
         50/100 이면 6BB — 두 바퀴면 사라지는 스택이고, 그 사실이 리바이 여부를
         가른다. 지금 판의 BB 로 나눠 같이 적는다.
         내림한다: 4.9BB 를 5BB 로 적으면 실제보다 넉넉해 보인다. 판이 아직 안 열려
         BB 를 모르면 칩 수만 적는다 — 모르는 값을 지어내지 않는다. */
      var rbBb = st.table && st.table.level ? st.table.level.bb : 0;
      var rbBbs = rbBb > 0 ? Math.floor(t.startingStack / rbBb) : null;
      rbPut('htRbStack', num(t.startingStack) + ' 칩' + (rbBbs != null ? ' (' + rbBbs + ' BB)' : ''));
      rbPut('htRbCost', num(r.cost) + ' P');
      rbPut('htRbBal', '보유: ' + num(st.balance || 0) + ' P');
      /* 마감이 코앞이면 시계를 붉게 — 남은 시간이 곧 결정 시간이다 */
      document.getElementById('htRbLeft').classList.toggle('soon', left != null && left <= 60);

      /* 낼 수 있는지는 서버가 준 잔고로 본다. 상단바의 data-balance 는 페이지를 열 때
         한 번 서버 렌더된 값이라 홀덤에서는 낡아 있다(아무도 갱신하지 않는다). */
      var poor = (st.balance || 0) < r.cost;
      var go = document.getElementById('htRbGo');
      go.disabled = poor;
      go.classList.toggle('off', poor);
      document.getElementById('htRbWarn').hidden = !poor;
      rbEl.hidden = false;
    }
    /* 짧은 글자 하나만 바꾼다. 같은 글이면 DOM 을 안 건드린다 —
       매초 돌면서 텍스트를 다시 쓰면 그 위의 선택 영역이 매번 풀린다. */
    function rbPut(id, text){
      var el = document.getElementById(id);
      if (el && el.textContent !== text) el.textContent = text;
    }
    /* 이 판에서 다시 묻지 않겠다고 표시한다. 둘 다 «리바이 안 함» 이므로 표시는 같고,
       테이블에 남는지 여부만 다르다. */
    function rbDismiss(){
      var t = st && st.tournament;
      rbSkipped = true;
      if (t) { try { sessionStorage.setItem(rbKey(t), '1'); } catch (e) { /* 없어도 동작한다 */ } }
      rbEl.hidden = true;
      return t;
    }
    /* 관전 — 창만 닫는다. 테이블은 그대로 두고 남은 사람들의 승부를 계속 본다
       (render 가 탈락자를 자동으로 관전으로 넘긴다). */
    document.getElementById('htRbSkip').addEventListener('click', function(){
      rbDismiss();
      render();
    });
    /* 로비 — 테이블을 떠난다. 우승 팝업의 [확인] 과 같은 장치를 쓴다: 이 대회의
       테이블은 더 그리지 않겠다고 표시해 두면 render 가 로비를 그린다. 표시를
       안 하면 다음 폴링에서 관전으로 다시 끌려 들어간다. */
    document.getElementById('htRbLobby').addEventListener('click', function(){
      var t = rbDismiss();
      if (t) {
        leftTableTid = t.id;
        try { sessionStorage.setItem(leftKey(t), '1'); } catch (e) { /* 없어도 동작한다 */ }
      }
      render();
      poll();
    });
    document.getElementById('htRbGo').addEventListener('click', async function(){
      var go = this;
      if (go.disabled) return;
      go.disabled = true;
      var r = await post('/api/games/holdem/rebuy');
      if (!r.ok) {
        /* 실패는 대개 «그 사이에 창이 닫혔다» 이다. 문구를 그대로 보여 주고 창을
           닫는다 — 다시 누를 수 있게 열어 두면 같은 실패를 반복한다. */
        document.getElementById('htRbWarn').textContent = (r.d && r.d.error) || '리바이할 수 없습니다.';
        document.getElementById('htRbWarn').hidden = false;
        go.disabled = false;
        return;
      }
      rbEl.hidden = true;
      if (window.casinoSfx && window.casinoSfx.chipBet) window.casinoSfx.chipBet();
      poll();   // 자리에 앉은 새 상태를 곧바로 당겨온다
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
