/* 홀덤 화면 — 렌더 · 폴링 · 상태 적용.

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다.

   주의: 이 조각은 마지막이라 끝에 줄바꿈이 없다. 다른 조각과 달리 닫는 백틱이
   `setInterval(poll, 1000);` 바로 뒤에 붙어 있는 것이 그래서다. holdem.ts 쪽에서 조립
   식과 `})();` 사이에 줄바꿈이 하나 있으므로, 여기에도 두면 산출물에 빈 줄이 하나 생긴다.
   실제로 처음에 그렇게 만들어 놓고 golden 검사에서 151,512번째 글자가 다르다고 잡혔다. */
export const LOOP = `    function render(){
      /* 탈락한 뒤에도 대회가 끝날 때까지 테이블에 남긴다(자동 관전).
         예전에는 내 자리가 사라지는 순간 로비로 튕겨서, 내가 어떻게 죽었는지 본 다음의
         이야기 — 남은 사람들의 승부와 대회를 결정짓는 마지막 판 — 을 하나도 못 봤다.
         참가했던 사람만 대상이다. 구경만 하러 온 사람은 로비에서 [관전하기]로 들어온다. */
      if (st.table != null && st.table.mySeat == null && st.tournament && st.tournament.iRegistered) spectate = true;
      /* 우승 팝업을 닫았으면 그 대회의 테이블은 더 보여주지 않는다. 안 그러면 서버가
         30초 동안 테이블을 계속 주는 탓에 팝업만 사라지고 화면은 그대로 멈춰 있다. */
      var left = st.tournament != null && (leftTableTid === st.tournament.id || leftStored(st.tournament));
      var showTable = !left && st.table != null && (st.table.mySeat != null || spectate);
      /* 이 한 페이지가 대기실과 판을 겸한다 — 방향도 그때그때 다르다.
         대기실(등록·정보·기록)은 세로가 낫고, 판이 열리면 좌석 아홉과 보드가
         가로로 늘어서므로 가로가 낫다. 관전도 판이므로 같이 가로다.
         같은 값을 다시 부르면 아무 일도 안 한다(app.js 의 casinoOrient). */
      if (window.casinoOrient) casinoOrient.want(showTable ? 'landscape' : 'portrait');
      lobbyEl.hidden = showTable;
      lobbyRecEl.hidden = showTable || recEmpty;
      tableEl.hidden = !showTable;
      if (showTable) { renderTable(); updatePreLabels(); firstTablePaint = false; }
      else { renderLobby(); loadRecords(false); }
      // 테이블에 있든 로비에 있든 축하는 뜬다 — 예전엔 로비 분기에만 있었다
      celebrate();
    }
    function post(url, body){
      return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}) })
        .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
        .catch(function(){ return { ok: false, d: null }; });
    }
    var polling = false;

    var pollAgain = false;
    /* ── 다음 판을 제때 깨운다 ───────────────────────────────────────
       이 게임에는 서버 타이머가 없다. 판이 끝나면 서버는 "다음 판은 이 시각 이후"만
       적어 두고(next_hand_at), 실제 진행은 누군가 요청을 보낼 때 일어난다.
       그래서 폴링이 1초 간격이면 그 시각이 지나도 최대 1초를 더 서 있게 된다 —
       연출은 이미 끝나고 화면이 멈춘 구간이라 그 1초가 고스란히 "느리다"가 된다.

       서버가 남은 시간(nextHandIn)을 같이 내려주므로, 그 시각에 한 번 직접 폴을 쏜다.
       판마다 한 번만 건다(핸드 번호로 기억). 40ms를 얹는 것은 초 단위로 내려온 값이
       올림·내림으로 아주 살짝 이를 수 있어서다 — 이르면 서버가 그냥 무시하고,
       그러면 다음 1초 틱까지 또 기다리게 된다. */
    var pokeHand = null, pokeTimer = null;
    function nextHandPoke(){
      var tb = st && st.table;
      if (!tb || !tb.ended || tb.nextHandIn == null) return;
      if (pokeHand === tb.handNo) return;
      pokeHand = tb.handNo;
      clearTimeout(pokeTimer);
      pokeTimer = setTimeout(poll, tb.nextHandIn * 1000 + 40);
    }

    /* ── 정산 연출 잠금 ──────────────────────────────────────────────
       다음 판이 서버에서 이미 시작됐더라도, 이쪽 화면의 정산 연출이 끝나기 전에는
       그 상태를 그리지 않는다. 받아 두고(queued) 연출이 끝난 뒤에 한 번에 반영한다.

       서버 지연은 연출 길이를 계산해서 잡지만 그건 예측이다. 탭이 백그라운드로
       내려가 타이머가 눌리거나, 네트워크가 한 번 튀거나, 느린 기기에서 애니메이션이
       밀리면 예측보다 늦게 끝난다. 그때 새 판이 그대로 그려지면 칩이 날아가던
       중간에 테이블이 갈아엎어진다 — 정산이 통째로 사라진 것처럼 보인다.

       잠금은 반드시 스스로 풀려야 한다. potDoneAt은 정산 사슬이 세우는 값이라
       사슬이 어디선가 죽으면 영영 0으로 남는다. 그래서 잠긴 지 LOCK_MAX_MS가 지나면
       무조건 놓아준다 — 연출이 잘리는 것보다 화면이 멈추는 쪽이 훨씬 나쁘다. */
    var LOCK_MAX_MS = 20000;
    var queued = null, lockedSince = 0;
    function settleBusy(next){
      var tb = st && st.table;
      if (!tb || !tb.ended) return false;
      if (!next || !next.table || next.table.handNo === tb.handNo) return false;
      if (potPaidHand !== tb.handNo) return false;          // 정산이 시작도 안 했다
      if (potDoneAt && Date.now() >= potDoneAt) return false; // 흡수 + 여유까지 끝났다
      if (lockedSince && Date.now() - lockedSince > LOCK_MAX_MS) return false;
      return true;
    }
    function apply(d){
      st = d;
      render();
      nextHandPoke();
      if (st.table && st.table.legal) runPreAction();
      /* 채팅은 폴을 따로 돌지 않는다 — 응답에 실려 온 마지막 메시지 id 를 넘겨주면
         그 값이 늘었을 때만 채팅이 스스로 한 번 받아 간다(app.js 의 casinoChat). */
      if (window.casinoChat) casinoChat.note(d.chatMax, d.chatMod);
    }
    function flushQueued(){
      if (!queued) return;
      var d = queued; queued = null; lockedSince = 0;
      apply(d);
    }
    /* 응답이 안 오는 요청 하나가 폴링을 영영 잠그지 못하게 한다.
       polling 자물쇠는 "앞 요청이 끝나기 전에는 다음 요청을 안 보낸다"는 뜻인데,
       그 요청이 영원히 안 끝나면 자물쇠도 영원히 안 풀린다 — 서버가 잠깐 멈췄다가
       돌아와도 화면은 계속 죽어 있게 된다. 서버가 OOM으로 죽었을 때 실제로 그랬다.
       8초면 정상 응답(0.13초)의 60배다. 그보다 늦는 응답은 이미 쓸모가 없다. */
    var POLL_TIMEOUT_MS = 8000;
    function poll(){
      if (polling) return Promise.resolve();
      polling = true;
      var ctl = typeof AbortController === 'function' ? new AbortController() : null;
      var killer = ctl && setTimeout(function(){ ctl.abort(); }, POLL_TIMEOUT_MS);
      return fetch('/api/games/holdem/state', ctl ? { signal: ctl.signal } : undefined)
        .then(function(r){ clearTimeout(killer); return r.json(); })
        .then(function(d){
          if (!d || !d.ok) return;
          if (settleBusy(d)) {
            queued = d;
            if (!lockedSince) lockedSince = Date.now();
            /* 연출이 끝나는 시각에 맞춰 스스로 깨운다. potDoneAt이 아직 없으면
               (사슬이 진행 중) 다음 폴링이 다시 들여다본다. */
            if (potDoneAt) setTimeout(flushQueued, Math.max(0, potDoneAt - Date.now()) + 40);
            return;
          }
          queued = null; lockedSince = 0;
          apply(d);
        })
        .catch(function(){ /* 일시적 실패는 다음 폴링에서 회복된다 */ })
        .then(function(){
          polling = false;
          /* 기다리던 요청이 있으면 곧바로 한 번 더 간다 — 아래 pollNow 를 보라 */
          if (pollAgain) { pollAgain = false; poll(); }
        });
    }

    /* 방금 뭔가를 바꿨으니 지금 상태를 다시 받아 달라 — 신청·취소처럼 화면이
       즉시 바뀌어야 하는 자리가 쓴다.

       그냥 poll() 을 부르면 안 되는 이유: 위 재진입 가드는 이미 날아간 요청이 있으면
       조용히 돌아간다. 그런데 그 날아간 요청은 내가 바꾸기 *전에* 떠난 것이라,
       돌아오는 답에는 내 취소가 안 들어 있다. 그걸로 화면을 그리면 [참가 완료]가
       그대로 남고, 누른 사람은 취소가 안 된 줄 안다.

       그래서 비행 중이면 표식만 남기고, 그 요청이 끝나는 즉시 한 번 더 간다. */
    function pollNow(){ if (polling) pollAgain = true; else poll(); }

    /* ── 안 보고 있으면 «느리게» 묻는다 ────────────────────────────
       한동안 가려지면 아예 멈췄다. 그게 두 가지를 깨뜨렸다(제보):
         · 돌아오면 그 사이 쌓인 차이를 화면이 «사건» 으로 읽어 밀린 연출을 몰아서 냈다
         · 미리 액션이 안 나갔다 — 예약을 실행하는 방아쇠가 폴링 응답 하나뿐이라,
           가려진 동안 내 차례가 열리면 아무도 당기지 않는다(서버가 자동 체크·폴드하고
           «자리 비움» 까지 만든다)
       멈춘 근거도 틀렸다: 요금 때문이라고 적었는데 fly.toml 은 상시 가동이다
       (auto_stop_machines = "off" · min_machines_running = 1, 2026-08-06 b6fd111).
       요청 한 번이 요금을 만들지 않는다.

       그래서 멈추지 않고 «느리게» 묻는다. 공유 CPU 한 개짜리 머신이라 아무도 안 보는
       탭이 초당 한 번 묻는 것은 여전히 값이 없지만, 아예 끊으면 위 둘이 깨진다.
       (브라우저도 가려진 탭의 타이머를 조인다 — 처음엔 1초, 5분쯤 뒤부터 분당 1회.
        그러니 이 값은 상한이지 보장이 아니다. 미리 액션을 확실히 하려면 예약을 서버가
        들고 있어야 한다.)

       유휴 타이머(몇 분 안 만지면 정지)는 여기에 두지 않는다. 포커 테이블에서는
       아무것도 안 누르고 남의 차례를 보고 있는 것이 정상 상태다 — 그때 멈추면
       판이 굴러가는 것을 못 본다. */
    var VISIBLE_MS = 1000, HIDDEN_MS = 5000;
    var loopTimer = null, loopEvery = 0;
    function startLoop(){
      var every = document.hidden ? HIDDEN_MS : VISIBLE_MS;
      if (loopTimer && loopEvery === every) return;
      stopLoop();
      loopEvery = every;
      poll();
      loopTimer = setInterval(poll, every);
    }
    function stopLoop(){ if (loopTimer) { clearInterval(loopTimer); loopTimer = null; loopEvery = 0; } }
    document.addEventListener('visibilitychange', function(){
      /* 돌아오면 «지금 상태» 를 조용히 그린다. 느리게 물었더라도 그 사이 여러 액션이
         한 번에 들어올 수 있고, 그 차이를 사건으로 읽으면 밀린 연출이 몰아서 나온다.
         처음 들어올 때 쓰는 깃발을 다시 켠다 — deal · board · chips · table · controls 가
         모두 이것을 보고 연출을 건너뛴다. 한 번 그리면 스스로 꺼진다.
         내 차례 알림은 이 한 번만 미뤄지고 다음 폴링에서 울린다(myTurnRung 을 그 갈래
         안에서 표시하기 때문에 건너뛴 것이 사라지지 않는다). */
      if (!document.hidden) firstTablePaint = true;
      startLoop();
    });
    startLoop();`;
