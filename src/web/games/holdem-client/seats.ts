/* 홀덤 화면 — 좌석 배치와 좌석 렌더.

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
export const SEATS = `    var seatXY = {};
    /* ── PKO 연출용 기억 ────────────────────────────────────────────
       좌석 번호를 키로 둔다.
         bountyShown  마지막으로 그린 머리 값 — 봉투가 열릴 때 번쩍이기 위해서다.
         wonShown     마지막으로 본 확보 누계 — 늘어난 만큼을 +N P 로 띄우기 위해서다.
                      머리 값이 자라지 않게 되면서(잡은 사람이 전액 독식) 명찰 숫자는
                      대회 내내 고정된다. 그래서 "잡았다"는 보상 피드백을 명찰 상승이
                      아니라 이쪽에서 만든다.
         koFired      그 자리의 KO 연출을 이미 터뜨렸나 — 폴링마다 다시 터지지 않게.
         koSeen       한 번이라도 그려 본 적이 있나 — 첫 프레임에는 터뜨리지 않는다.
                      이미 탈락자가 있는 판에 뒤늦게 들어오면 그 몫이 한꺼번에 터진다. */
    var bountyShown = {}, wonShown = {}, koFired = {}, koSeen = false;
    /* 총알이 박히는 시각. 음원(gunshot.mp3)의 실제 발사 시점을 그대로 읽어 쓴다 —
       간격을 우리가 정하면 소리와 그림이 어긋난다. 값은 app.js 의 소리 옆에 있다.
       음원을 못 읽는 환경(구형 브라우저 등)에서도 배열은 있으므로 연출은 그대로 돈다. */
    function koShotTimes(){
      var s = (window.casinoSfx && casinoSfx.gunfireShots) || [30, 305, 1335];
      var base = s[0] || 0;
      return s.map(function(ms){ return ms - base; });   // 첫 발을 0 으로 맞춘다
    }
    /* 총격 전체 길이 — 마지막 발 이후 잔향까지. 현상금 상승이 이 뒤에 온다. */
    function koBurstLen(){
      var t = koShotTimes();
      return t[t.length - 1] + 420;
    }
    /* 이 총격 묶음이 끝나는 시각. 두 사람이 같은 판에 털릴 때 소리와 흔들림이 두 배로
       겹치는 것을 막는다 — 자국은 각자에게 박히되 청각·흔들림은 한 묶음만 간다.
       (셋이 동시에 털리면 아홉 발이 되어 화면이 멈추지 않고 떨린다.) */
    var koBurstUntil = 0;
    /* 좌석별 총격 시작 시각 — 발사가 도는 중에는 갱신 루프가 자국을 건드리지 않게 한다. */
    var koBurstSeat = {};
    /* 총격이 완전히 끝나는 시각. 현상금 상승 연출이 이때까지 기다린다 —
       요구한 순서가 [칩 이동 → 처형(3발) → 현상금 상승]이고, 처형과 상승이 같은 순간에
       터지면 무엇 때문에 올랐는지가 안 읽힌다. */
    var koBurstEndsAt = 0;
    /* 총격이 끝난 뒤 오른 현상금 숫자가 떠 있는 시간(.ht-bgain 애니메이션 1.4초).
       우승 축하 팝업이 이만큼 더 기다린다 — 먼저 뜨면 화면을 덮어 마지막 KO 연출과
       오른 현상금을 통째로 못 본다. celebrate.ts 가 이 값을 읽는다. */
    var KO_GAIN_HOLD_MS = 1600;
    /* 카드를 걷고 나서 첫 발까지의 한 박자. 카드가 사라지는 것과 총성이 동시면
       "정리했다"가 안 읽히고 그냥 화면이 바뀐 것으로 보인다. 빈 테이블을 한 번
       보여 주고 쏜다. */
    var KO_LEAD_MS = 600;
    /* ── 미스터리 바운티 개봉 ────────────────────────────────────────
       미스터리는 머리 위에 금액이 없다. 그래서 "얼마짜리를 잡았나"가 공개되는 자리가
       화면에 이 연출 하나뿐이고, 그만큼 이 순간이 모드의 전부다.

       카지노 전광판이다. 숫자가 빠르게 굴러가다 당첨 금액에서 딱 멈춘다 — 굴러가는
       동안이 긴장이고, 멈추는 순간이 결과다. (상자 그림을 CSS 로 만들어 봤는데 조악했다.
       연출의 내용은 "숫자가 굴러가다 멈춘다"이지 상자가 아니다.)

       봉투마다 한 번씩 돈다. 여러 명이 동시에 털리면 누구 봉투가 얼마였는지가 각각
       보여야 한다 — 합쳐서 한 숫자로 적으면 그 정보가 사라진다. 서버가 판마다
       [탈락자 · 금액 · 가져간 사람] 목록을 내려준다(table.bountyReveals).

       처형(총 3발) 다음에 온다. 순서는
         칩 이동 → 카드 정리 → 처형 → 개봉(봉투마다) → 확보 표시(+N P) → 다음 판 / 우승 팝업
       서버의 nextHandDelaySec 이 이 길이를 알고 다음 판을 미룬다(mysteryReveals). */
    var MYS_IN_MS = 340;        // 전광판이 올라온다
    var MYS_ROLL_MS = 1600;     // 숫자가 굴러간다 (긴장을 만드는 구간)
    var MYS_LAND_MS = 1500;     // 당첨 금액에서 멈추고 읽는 시간
    var MYS_OUT_MS = 300;       // 내려간다. 다음 봉투는 이것이 끝난 뒤에 시작한다
    var MYS_TICK_MS = 55;       // 굴러가는 숫자가 바뀌는 간격
    function mysBoxLen(){ return MYS_IN_MS + MYS_ROLL_MS + MYS_LAND_MS; }
    function mysBoxTotal(){ return mysBoxLen() + MYS_OUT_MS; }
    /* 개봉이 끝나는 시각. 우승 팝업과 상금 탭이 이 뒤까지 기다린다 — 먼저 갱신되면
       결과가 그쪽에서 새어 나간다(처형에서 똑같은 제보를 받았다).
       celebrate.ts 와 side.ts 가 이 값을 읽는다. */
    var mysBoxEndsAt = 0;
    /* 한 번에 하나만 돈다. 전광판이 하나뿐이라 겹쳐 돌리면 둘 다 안 읽힌다 —
       줄을 세워 차례로 돌린다. */
    var mysQueue = [], mysBusy = false;
    /* 이미 재생한 판 — 폴링마다 같은 목록이 다시 오므로 판 번호로 한 번만 잡는다.
       창을 다시 열어도 같은 판이 또 재생되지 않게 여기서 기억한다. */
    var mysPlayed = {};
    var mysRollTimer = null;
    /* 봉투 하나를 돌린다. 끝나면 가져간 사람 아바타 위로 +N P 를 띄우고 다음 봉투로 넘어간다. */
    function mysPump(){
      if (mysBusy || !mysQueue.length) return;
      var job = mysQueue.shift();
      mysBusy = true;
      var box = document.getElementById('htMysBox');
      var amtEl = document.getElementById('htMysAmt');
      var ofEl = document.getElementById('htMysOf');
      var whoEl = document.getElementById('htMysWho');
      var dotsEl = document.getElementById('htMysDots');
      if (!box || !amtEl) {             // 골격이 없으면 연출을 건너뛰고 숫자만 띄운다
        mysFinish(job);
        return;
      }
      /* 누구 봉투인가 — 굴러가는 동안 이것만 보인다. 금액과 가져간 사람은 멈춘 뒤에 온다.
         셋을 한꺼번에 띄우면 굴러가는 숫자를 볼 이유가 없어진다. */
      if (ofEl) ofEl.textContent = job.victim ? job.victim + ' 님의 바운티' : '바운티';
      if (whoEl) whoEl.textContent = '';
      /* 봉투가 여럿이면 몇 번째인지 점으로 알려준다 — 안 그러면 두 번 도는 것이
         "버그로 다시 돌았다"로 읽힌다. */
      if (dotsEl) {
        dotsEl.innerHTML = job.total > 1
          ? Array.apply(null, Array(job.total)).map(function(_, i){
            return '<i class="' + (i === job.idx ? 'on' : '') + '"><\\/i>';
          }).join('')
          : '';
      }
      amtEl.textContent = '?';
      box.hidden = false;
      box.className = 'ht-mysbox in';
      void box.offsetWidth;
      /* 굴리기. 실제 봉투 금액들에서 무작위로 뽑아 보여준다 — 아무 숫자나 굴리면
         자릿수가 들쭉날쭉해서 폭이 흔들리고, 무엇보다 "있을 수 있는 금액"으로 안 보인다. */
      setTimeout(function(){
        box.className = 'ht-mysbox in roll';
        var pool = (job.pool && job.pool.length) ? job.pool : [job.amount];
        /* 소리를 숫자와 같은 타이머에서 낸다 — 따로 예약하면 눈은 55ms 마다 바뀌는데
           소리는 제 리듬으로 가서 "소리 따로 그림 따로"가 된다. 그래서 굴러가는 소리는
           음원 파일을 두지 않는다(파일 길이는 이 간격을 모른다). */
        mysRollTimer = setInterval(function(){
          var pick = pool[Math.floor(Math.random() * pool.length)];
          amtEl.textContent = stackText(pick) + 'P';
          if (window.casinoSfx && casinoSfx.reelTick) casinoSfx.reelTick();
        }, MYS_TICK_MS);
      }, MYS_IN_MS);
      // 멈춤 — 당첨 금액에서 딱 선다. 여기가 결과다
      setTimeout(function(){
        if (mysRollTimer) { clearInterval(mysRollTimer); mysRollTimer = null; }
        box.className = 'ht-mysbox in land';
        amtEl.textContent = stackText(job.amount) + 'P';
        if (window.casinoSfx && casinoSfx.reelStop) casinoSfx.reelStop();
        /* 마지막 판에서는 우승자가 자기 봉투도 함께 회수한다. 그때 "가져갔습니다"만
           적으면 그 몫이 어디서 왔는지 설명이 없다. */
        if (whoEl) {
          whoEl.textContent = !job.takers.length ? ''
            : job.takers.join(' · ') + (job.takers.length > 1 ? ' 나눠 가집니다' : ' 획득');
        }
      }, MYS_IN_MS + MYS_ROLL_MS);
      /* 정리가 끝난 뒤에 다음 봉투로 넘긴다. mysFinish 를 여기서 부르면 다음 봉투가
         곧바로 시작되고, 그 뒤에 이 정리 타이머가 돌면서 새로 올라온 전광판을 감춘다 —
         요소를 하나만 두었기 때문에 생기는 함정이고, 실측으로 두 번째가 사라졌다. */
      setTimeout(function(){
        box.className = 'ht-mysbox out';
        setTimeout(function(){
          box.hidden = true;
          box.className = 'ht-mysbox';
          mysFinish(job);
        }, MYS_OUT_MS);
      }, mysBoxLen());
    }
    /* 전광판이 내려간 뒤 상금이 프로필로 들어간다 — 전광판에서 본 금액과 같은 숫자가
       아바타 위로 떠오르며 "저게 저 사람 것이 됐다"를 잇는다. 순서가 뒤집히면 두 숫자가
       무슨 관계인지 읽히지 않는다. 공동 KO 면 나눠 가진 몫을 각자에게 띄운다. */
    function mysFinish(job){
      var n = job.takers.length || 1;
      var each = Math.floor(job.amount / n);
      job.takers.forEach(function(name, i){
        var seat = mysSeatOf(name);
        if (seat == null) return;
        var seatEl = seatsEl.querySelector('.ht-seat[data-seat="' + seat + '"]');
        /* 나눠 가질 때 남는 1P 는 앞사람에게 — 서버의 splitBounty 와 같은 방향이다.
           반대로 두면 화면 합계가 실제 지급액과 1P 어긋난다. */
        if (seatEl) floatBGain(seatEl, each + (i < job.amount - each * n ? 1 : 0));
      });
      mysBusy = false;
      mysPump();
    }
    /* 이름으로 자리를 찾는다. 서버가 개봉 목록을 이름으로 주기 때문이다 — 탈락자는 좌석
       목록에서 사라질 수 있어서 id 로 두면 이름을 찾을 데가 없다. 한 테이블에 같은 이름이
       둘일 수는 없다(디스코드 계정 하나가 자리 하나다). */
    function mysSeatOf(name){
      var seats = (st.table || {}).seats || [];
      for (var i = 0; i < seats.length; i++) {
        if (seats[i].username === name) return seats[i].seat;
      }
      return null;
    }
    /* 확보한 만큼을 아바타 위로 띄운다. 미스터리는 상자가 닫힌 뒤, 프로그레시브는
       처형이 끝난 뒤 곧바로 — 부르는 자리만 다르고 연출은 같다. */
    function floatBGain(seatEl, amount){
      if (amount <= 0) return;
      if (window.casinoSfx && casinoSfx.bountyUp) casinoSfx.bountyUp();
      var gEl = seatEl.querySelector('.ht-bgain');
      if (!gEl) return;
      gEl.textContent = '+' + stackText(amount) + 'P';
      gEl.hidden = false;
      gEl.classList.remove('rise');
      void gEl.offsetWidth;
      gEl.classList.add('rise');
      /* 떠오른 숫자는 남지 않는다 — 다음 판까지 붙어 있으면 지금 걸린 금액과
         헷갈린다. 애니메이션(1.4초)이 끝나면 치운다. */
      setTimeout(function(){ gEl.hidden = true; }, 1400);
    }
    /* 처형을 위해 판을 비운 판 번호. board.ts·reveal.ts 가 이 값을 보고 카드를 다시
       그리지 않는다(조각들은 하나의 클로저를 공유한다). 다음 판이 오면 번호가 달라져
       저절로 풀리므로 되돌리는 코드가 따로 없다. */
    var koClearHand = null;
    /* 한 발. 소리·섬광·흔들림·자국이 같은 박자에 온다 — 따로 예약하면 미세하게
       엇나가고, 그러면 "맞았다"로 안 읽힌다. */
    function koShot(seatEl, idx, withSound){
      var shot = seatEl.querySelector('.ht-hole-shot.s' + (idx + 1));
      if (shot) {
        shot.hidden = false;
        shot.classList.remove('hit');
        void shot.offsetWidth;          // 같은 프레임으로 묶이면 애니메이션이 다시 안 돈다
        shot.classList.add('hit');
      }
      var mz = seatEl.querySelector('.ht-muzzle');
      if (mz) {
        mz.hidden = false;
        mz.classList.remove('flash');
        void mz.offsetWidth;
        mz.classList.add('flash');
        /* 섬광은 남지 않는다 — 총구 불빛이라 발사 순간에만 있어야 한다.
           자국(.ht-hole-shot)은 반대로 판이 끝날 때까지 남는다. */
        setTimeout(function(){ mz.hidden = true; }, 180);
      }
      if (!withSound) return;
      /* 흔들림은 펠트에 준다. 좌석만 흔들면 "그 사람이 떨었다"로 보이고, 판이 흔들려야
         "총이 발사됐다"가 된다.

         왜 #htTable 이 아니라 .ht-felt 인가: 날아가는 칩 층(.chip-fly-layer)이
         #htTable 에 붙는데(settle.ts), 그 층의 칩은 position:fixed 다. 조상에 transform 이
         걸리면 fixed 가 화면이 아니라 그 조상을 기준으로 움직여 칩이 통째로 어긋난다.
         하필 KO 와 팟 정산은 같은 순간에 일어나므로 반드시 겹친다. 펠트는 칩 층의
         형제라 여기서 끊긴다.

         발사마다 다시 건다(remove → 리플로우 → add). 예전에는 "이미 흔들리는 중이면
         건너뛴다"였는데, 세 발로 늘리면서 그 규칙이 첫 발만 흔들고 나머지 둘은 소리만
         남게 만든다 — 한 방을 세 방으로 만든 이유가 바로 그 튀는 느낌이라 안 된다. */
      var felt = tableEl ? tableEl.querySelector('.ht-felt') : null;
      if (felt) {
        felt.classList.remove('koshake');
        void felt.offsetWidth;
        felt.classList.add('koshake');
        setTimeout(function(){ felt.classList.remove('koshake'); }, 240);
      }
    }
    /* KO 세 발. 자국은 늘 세 개가 박히고, 소리와 흔들림은 같은 순간에 여러 명이
       털렸을 때 한 묶음만 낸다. */
    function koBang(seatEl, seat){
      var t = Date.now();
      var at = koShotTimes();
      var lead = t >= koBurstUntil;     // 이 묶음의 첫 사람인가
      if (lead) {
        /* 처형 전에 판을 비운다 — 보드와 모두의 홀 카드를 걷는다.
           레퍼런스도 그렇게 한다: 카드가 있는 채로 쏘면 총성이 카드와 자리를 다투고,
           빈 테이블이면 그 순간의 주인공이 처형이 된다.
           지우는 것은 화면뿐이고 결과(서버가 준 board·cards)는 그대로다 — 다음 판이
           오면 handNo 가 달라져 저절로 원래대로 그린다. */
        koClearHand = (st.table || {}).handNo;
        if (typeof syncBoard === 'function' && st.table) syncBoard(st.table);
        var holes = seatsEl.querySelectorAll('.ht-hole');
        for (var hi = 0; hi < holes.length; hi++) {
          holes[hi].classList.remove('up');
          while (holes[hi].firstChild) holes[hi].removeChild(holes[hi].firstChild);
        }
      }
      if (lead) {
        koBurstUntil = t + KO_LEAD_MS + koBurstLen() + 200;
        /* 소리는 한 번만 재생한다 — 세 발이 한 파일에 들어 있다. */
        if (casinoSfx && casinoSfx.gunfire) {
          setTimeout(function(){ casinoSfx.gunfire(); }, KO_LEAD_MS);
        }
      }
      koBurstSeat[seat] = t;
      /* 총격이 끝나는 시각을 남긴다 — 현상금 상승은 이 뒤에 온다.
         여러 명이 동시에 털리면 가장 늦게 끝나는 것을 기준으로 둔다. */
      var ends = t + KO_LEAD_MS + koBurstLen();
      if (ends > koBurstEndsAt) koBurstEndsAt = ends;
      at.forEach(function(ms, k){
        setTimeout(function(){ koShot(seatEl, k, lead); }, KO_LEAD_MS + ms);
      });
    }
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
           ny로 비례를 주어 아래쪽 반원도 같이 따라온다. 픽셀이 아니라 H 비율로 적는다 —
           좁은 화면에서는 카드도 같이 작아지므로 고정 픽셀이면 그쪽에서만 과하게 올라간다.

           0.067(22px)이었다. PKO 명찰이 아바타 위에 앉으면서 그 22px 자리를 명찰이
           함께 쓰게 됐고, 6시 자리에서 칩 기둥 아래끝이 명찰 위쪽을 11px 파고들었다(실측).
           0.119(39px)로 올려 17px 를 더 벌린다 — 겹침 11px 을 지우고 6px 여백을 남긴다.
           일반 대회에는 명찰이 없지만 같은 값을 쓴다: 칩이 조금 더 안쪽에 놓이는 것은
           어느 판에서도 문제가 아니고, 판마다 칩 자리가 달라지면 그게 더 이상하다. */
        by -= Math.max(0, ny) * H * 0.119;
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
      /* 바운티 대회인가. 좌석 골격에 바운티·KO 요소를 넣을지 여부를 이 값 하나가 정한다.
         서버가 PKO 가 아니면 mode 를 CLASSIC 으로 주고 좌석에 bounty 칸 자체를 안 싣는다. */
      /* 바운티가 걸린 판이면 켠다 — 두 모드 모두 처형 연출과 확보 표시가 같다.
         서버의 isPko 와 같은 뜻을 여기서도 유지해야 한다. */
      var tmode = (st.tournament || {}).mode;
      var mystery = tmode === 'MYSTERY_BOUNTY';
      var pko = tmode === 'PKO_BOUNTY' || mystery;
      /* 머리 위 명찰은 미스터리에서 그리지 않는다. 금액이 비공개인 모드라 명찰에 적을
         숫자가 없다 — 한동안 물음표를 띄워 뒀는데, 다섯 자리에 똑같은 "?" 가 걸린 화면은
         정보가 0 이면서 자리만 차지했다. 미스터리의 금액은 개봉 연출 한 곳에서만 나온다. */
      var badgeOn = pko && !mystery;
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
              /* 머리 위 바운티 — 금액이 공개된 바운티 판에서만 그린다. 일반 대회와
                 미스터리에서는 이 요소가 아예 만들어지지 않는다: 숨기는 것으로 두면
                 언젠가 조건이 빠지면서 엉뚱한 판에 바운티가 뜨고, 그건 "같은 베이스지만
                 다른 게임"이라는 약속을 깨는 종류의 실수다. 없으면 실수로 보일 수가 없다. */
              (badgeOn ? '<span class="ht-bounty" hidden></span>' : '') +
              /* 오른 만큼을 명찰 위로 띄운다. 명찰 숫자만 바뀌면 "얼마를 받았나"를
                 이전 값과 비교해서 뺄셈해야 알 수 있다 — 그 순간에 그럴 사람은 없다.
                 증가액을 따로, 크게, 위로 떠오르며 보여 준다. */
              (pko ? '<span class="ht-bgain" hidden></span>' : '') +
              /* KO 총자국 — 탈락하는 순간 세 발이 연달아 박힌다. 역시 PKO 전용이다.
                 한 발이면 "탈락 표시"로 보이고, 세 발이 시차를 두고 박히면서 그때마다
                 화면이 흔들려야 "총에 맞았다"가 된다.

                 세 자리를 미리 흩어 둔다(s1·s2·s3). 무작위로 뽑으면 폴링마다 자리가
                 바뀌고, 한 곳에 모으면 세 발이 한 발로 보인다.
                 총구 섬광(.ht-muzzle)은 발사마다 한 번 번쩍인다. */
              (pko ? '<span class="ht-hole-shot s1" hidden></span>'
                + '<span class="ht-hole-shot s2" hidden></span>'
                + '<span class="ht-hole-shot s3" hidden></span>'
                + '<span class="ht-muzzle" hidden></span>' : '') +
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
        sigParts.push(s.seat + ':' + s.userId + ':' + rot + '/' + seatCount + (pko ? ':pko' : ''));

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

      /* 이 프레임에 새로 털린 자리가 있으면 아래 루프에 들어가기 전에 총격 시각을 잡아 둔다.

         이 줄이 없으면 순서에 걸린다: 아래 루프는 좌석 번호대로 도는데, 승자가 탈락자보다
         먼저 나오면 승자의 현상금 상승을 판단하는 시점에 koBurstEndsAt 이 아직 0 이라
         "기다릴 것 없다"가 되어 증가액이 총알보다 먼저 뜬다(실측: 총알 0ms 인데 증가액이
         그보다 앞).

         정산이 끝난 판인지(settleDone)까지 함께 봐야 한다 — 안 그러면 카드가 열리는
         중에 미리 창을 열어 두고, 정작 총격은 나중에 시작된다. */
      // 아래 루프의 koShow 와 같은 조건이어야 한다 — 어긋나면 창을 미리 열거나 못 연다
      if (pko && resultReady() && settleDone(tb)) {
        var fresh = seats.some(function(s){
          return s.presence === 'OUT' && !koFired[s.seat];
        });
        if (fresh && koSeen) {
          var end = Date.now() + KO_LEAD_MS + koBurstLen();
          if (end > koBurstEndsAt) koBurstEndsAt = end;
        }
      }
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
        /* ── 머리 위 바운티 (금액이 공개된 바운티 판 전용) ─────────────
           골격에 뱃지가 있을 때만 그린다 — 미스터리와 일반 판에는 요소가 아예 없으므로
           여기서 조건을 한 번 더 걸지 않는다.

           숫자는 대회 내내 고정이다(잡은 사람이 전액 가져가고 자기 머리는 안 오른다).
           그래서 올라갈 때 번쩍이는 연출이 없다 — 올라가는 일이 없다. 한때 있었는데,
           절대 실행되지 않는 애니메이션이 코드에 남아 있으면 다음에 읽는 사람이
           "왜 안 보이나"를 쫓게 된다.

           대신 KO 당해 0 이 되는 순간은 붙들고 있는다. 서버는 판이 끝나는 순간 정산을
           확정하지만 화면은 그때부터 보드를 한 장씩 열고 팟을 옮기는 중이다. 털린 사람의
           뱃지가 그 사이에 사라지면 이 판에 무엇이 걸려 있었는지 읽을 수 없다.
           처형(3발)이 끝날 때까지 기다린다. */
        var bEl = seatEl.querySelector('.ht-bounty');
        if (bEl) {
          var bv = s.bounty || 0;
          var prev = bountyShown[s.seat];
          var waiting = !settleDone(tb) || Date.now() < koBurstEndsAt;
          if (prev !== undefined && bv !== prev && waiting) bv = prev;
          if (bv > 0) {
            bEl.textContent = stackText(bv) + 'P';
            bEl.hidden = false;
          } else {
            bEl.hidden = true;
          }
          bountyShown[s.seat] = bv;
        }
        /* ── 잡아서 확보한 금액 (+N P) ────────────────────────────────
           명찰 숫자는 대회 내내 고정이다(잡은 사람이 전액을 가져가고 자기 머리 값은
           오르지 않는다). 그래서 "얼마를 벌었나"는 명찰이 아니라 이 숫자가 말한다.

           명찰의 붙들기와 같은 규칙을 쓴다: 결과 연출과 처형(3발)이 끝날 때까지 기다린다.
           순서가 [칩 이동 → 처형 → 확보 표시]라, 처형과 같은 순간에 터지면 무엇 때문에
           들어온 돈인지가 안 읽힌다. */
        var wv = s.bountyWon;
        if (typeof wv === 'number') {
          var wPrev = wonShown[s.seat];
          /* 처음 본 값은 그대로 받아 둔다 — 판 중간에 들어온 사람에게 남의 누계를
             "방금 벌었다"로 보여줄 이유가 없다. 기다리는 것은 "증가"뿐이다. */
          if (wPrev === undefined) wonShown[s.seat] = wv;
          /* 미스터리는 이 경로를 쓰지 않는다. 확보 누계의 증가분은 봉투 여러 개가 합쳐진
             값이라 "누구 봉투가 얼마였나"를 알 수 없다 — 개봉은 서버가 주는 봉투 목록으로
             따로 돌린다(아래 mysQueue). 여기서는 다음 증가를 재기 위해 값만 따라간다. */
          else if (mystery) wonShown[s.seat] = wv;
          else if (wv > wPrev && settleDone(tb) && Date.now() >= koBurstEndsAt) {
            floatBGain(seatEl, wv - wPrev);
            wonShown[s.seat] = wv;
          }
        }
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
        /* ── KO 연출 (PKO 전용) ──────────────────────────────────────
           칩이 0 이 되어 자리가 OUT 으로 바뀌는 그 순간에 한 번만 터진다.
           presence 를 매 폴링마다 보고 "이번에 바뀌었나"를 좌석별로 기억한다 —
           상태만 보고 그리면 탈락자가 화면에 남아 있는 동안 총성이 계속 울린다.

           koFired 에 남기는 이유가 하나 더 있다: 폴링은 창을 다시 열 때도 돌아서,
           기억이 없으면 새로고침한 사람에게 남의 탈락이 방금 일어난 것처럼 터진다. */
        /* 처형은 쇼다운의 마지막 순서다. 두 조건을 함께 봐야 한다:
             resultReady()  모든 홀 카드와 보드가 다 열렸고 읽을 한 박자까지 지났다
             settleDone(tb) 팟이 승자에게 넘어가는 연출까지 끝났다
           settleDone 만 보면 부족했다 — 팟 연출은 tb.ended 를 보고 시작하므로 보드가
           아직 깔리는 중에도 끝날 수 있고, 그러면 턴 카드가 떨어지자마자 화면이
           처형으로 넘어간다(제보로 확인). 카드가 다 나오고 칩이 옮겨진 뒤여야 한다.
           폴드로 끝난 판은 둘 다 즉시 참이라 곧바로 진행된다. */
        var koShow = pko && s.presence === 'OUT' && resultReady() && settleDone(tb);
        if (koShow && !koFired[s.seat]) {
          koFired[s.seat] = 1;
          /* 처음 그리는 프레임에는 터뜨리지 않는다. 이미 탈락한 사람이 있는 판에
             뒤늦게 들어오면 그 사람들 몫이 한꺼번에 터진다. */
          if (koSeen) koBang(seatEl, s.seat);
        } else if (s.presence !== 'OUT') {
          koFired[s.seat] = 0;
        }
        /* 자국 세 개를 함께 다룬다.
             · 살아 있는 자리 → 전부 감춘다.
             · 총격이 도는 중  → 손대지 않는다. koShot 이 하나씩 드러내는 시차가 이 연출의
                                 전부이고, 여기서 켜면 폴링이 세 발을 한꺼번에 띄워 버린다.
             · 그 밖에        → 전부 드러낸다. 이미 털린 판에 새로고침해서 들어온 경우가
                                 이쪽인데, 한때 "감추기만" 하도록 두었다가 그 화면에서
                                 총자국이 아예 안 보였다(흑백 처리만 남았다). */
        var shots = seatEl.querySelectorAll('.ht-hole-shot');
        var bursting = koShow && koBurstSeat[s.seat]
          && Date.now() - koBurstSeat[s.seat] < KO_LEAD_MS + koBurstLen() + 300;
        if (!bursting) {
          for (var si = 0; si < shots.length; si++) shots[si].hidden = !koShow;
        }
        if (!koShow) {
          var mzEl = seatEl.querySelector('.ht-muzzle');
          if (mzEl) mzEl.hidden = true;
        }
        seatEl.classList.toggle('koed', koShow);
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
      /* ── 미스터리 개봉 걸기 ──────────────────────────────────────
         좌석 루프 밖에서 한 번만 판단한다. 개봉은 좌석이 아니라 판에 붙은 사건이고
         (봉투 여러 개가 한 판에 열린다), 루프 안에서 걸면 좌석 순서에 따라 순서가
         바뀐다 — 처형에서 그 함정에 한 번 빠졌다.

         처형(3발)이 끝난 뒤에 시작한다. 그 전에 돌리면 총성과 숫자가 겹쳐 둘 다 안 읽힌다. */
      if (mystery && koSeen && tb.bountyReveals && tb.bountyReveals.length
        && !mysPlayed[tb.handNo] && settleDone(tb) && Date.now() >= koBurstEndsAt) {
        mysPlayed[tb.handNo] = 1;
        var rv = tb.bountyReveals;
        /* 굴러가는 숫자로 쓸 후보들 — 이 판에 실제로 열린 금액들이다. 아무 숫자나 굴리면
           자릿수가 들쭉날쭉해서 폭이 흔들리고, "있을 수 있는 금액"으로 보이지 않는다. */
        var pool = rv.map(function(r){ return r.a; });
        rv.forEach(function(r, i){
          mysQueue.push({ victim: r.v, amount: r.a, takers: r.k || [],
            idx: i, total: rv.length, pool: pool });
        });
        /* 이 묶음이 끝나는 시각을 여기서 잡아 둔다 — 우승 팝업과 상금 탭이 이 값을 보고
           기다리므로, 첫 봉투가 돌기 전에 세워져 있어야 한다. */
        var mEnds = Date.now() + mysBoxTotal() * mysQueue.length;
        if (mEnds > mysBoxEndsAt) mysBoxEndsAt = mEnds;
        mysPump();
      }
      /* 여기까지 한 번 돌았으면 다음부터는 "방금 바뀐 것"을 믿을 수 있다.
         맨 끝에 세우는 것이 요점이다 — 위에서 세우면 첫 프레임의 탈락자들이 그대로 터진다. */
      koSeen = true;
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
