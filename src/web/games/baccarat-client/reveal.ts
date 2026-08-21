/* 바카라 화면 — 카드 공개 순서 · 끗수 · 구슬판 히스토리.

   브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라 문자열이고,
   baccarat.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   순서를 바꾸면 안 된다. 나눈 목적은 읽기이고, 산출물은 한 글자도 달라지지 않아야 한다
   (scripts/golden.ts 가 바이트로 확인한다). */
export const BC_REVEAL_JS = `         실제 푼토 방코의 공개 순서를 그대로 따른다:
           플레이어 두 장 → (끗수 확인) → 뱅커 두 장 → (끗수 확인)
           → 플레이어 서드 → 뱅커 서드
         네 장을 한꺼번에 뒤집으면 이미 끝난 결과를 통보받는 느낌이라 볼 맛이 없다.
         서버는 단계별로 카드를 다 내려주고, 그중 "지금까지 깐 만큼"만 화면에 그린다.
         (서버 시간 해상도는 1초라 이 정도 간격은 클라이언트에서 재는 게 맞다)                */
      // shown = 지금 화면에 깐 장수, scheduled = 예약까지 끝난 장수.
      // 둘을 나눠 두는 이유: 1초 폴링이 공개 도중에 들어올 때 shown만 보고 다시 예약하면
      // 아직 안 터진 타이머를 취소하고 지연 0으로 새로 잡아, 마지막 장이 일찍 튀어나온다
      // (실측으로 320ms 간격이 186ms로 무너졌다). 예약된 몫은 건드리지 않는다.
      var shown = { p: 0, b: 0 }, scheduled = { p: 0, b: 0 };
      var revealTimers = [];
      var FLIP_MS = 320;      // 같은 손 안에서 카드 한 장 간격
      // 플레이어 끗수가 뜬 뒤 뱅커로 넘어가기 전 한 박자.
      // 카드 간격과 비슷하게 잡았더니(260ms) 그냥 네 장이 죽 넘어가는 걸로만 보였다 —
      // "플레이어 얼마 나왔네" 하고 뱅커를 기다리는 구간이 생기려면 확실히 더 벌려야 한다.
      var HAND_GAP_MS = 520;

      function clearReveal(){ revealTimers.forEach(clearTimeout); revealTimers = []; }

      // 끗수는 화면에 깐 카드만으로 계산한다 — 아직 안 깐 카드가 합계에 미리 반영되면
      // 뒤집기 전에 결과가 새어 나간다
      function cardVal(c){
        var r = c[0];
        if (r === 'A') return 1;
        if (r === 'T' || r === 'J' || r === 'Q' || r === 'K') return 0;
        return Number(r);
      }
      function totalOf(cards){
        return cards.reduce(function(s, c){ return s + cardVal(c); }, 0) % 10;
      }

      function scheduleReveal(r){
        var wantP = r.player.length, wantB = r.banker.length;
        if (wantP <= scheduled.p && wantB <= scheduled.b) return;
        // 아직 예약 안 된 카드만 카지노 순서대로 줄 세운다 — 플레이어가 먼저, 그다음 뱅커
        var steps = [];
        for (var i = scheduled.p; i < wantP; i++) steps.push('p');
        var handBreak = steps.length;           // 여기서 손이 바뀐다
        for (var j = scheduled.b; j < wantB; j++) steps.push('b');
        scheduled.p = wantP; scheduled.b = wantB;

        var t = 0;
        steps.forEach(function(side, n){
          if (n === handBreak && n > 0) t += HAND_GAP_MS;   // 플레이어 끗수를 볼 틈
          else if (n > 0) t += FLIP_MS;
          revealTimers.push(setTimeout(function(){
            shown[side]++;
            paintHands(st && st.round);
            // 공개는 전부 "넘기는" 소리다 — 뒤집는 것뿐이라 카드가 새로 오지 않는다.
            // 예외로 세 번째 카드는 진짜 새로 오는 카드라 "나눠주는" 소리를 쓴다.
            if (window.casinoSfx) {
              if (shown[side] > 2) window.casinoSfx.deal();
              else window.casinoSfx.card();
            }
          }, t));
        });
      }

      // 깐 만큼만 그린다. 아직 안 깐 자리는 뒷면으로 남겨 둔다(베팅 중 네 장도 이 경로다).
      function paintHands(r){
        if (!r) return;
        function slots(cards, n){
          var len = Math.max(n, 2);
          var out = [];
          for (var i = 0; i < len; i++) out.push(i < n ? cards[i] : null);
          return out;
        }
        syncCards(pCardsEl, 'p', slots(r.player, shown.p));
        syncCards(bCardsEl, 'b', slots(r.banker, shown.b));
        // 한 장만 깐 상태의 끗수는 의미가 없으므로 두 장부터 보여준다
        /* 끗수는 이름 오른쪽 알약이다(07-bacc.css). 아직 안 열렸을 때는 색을 빼야
           하는데 CSS 는 «글자가 – 인가» 를 볼 수 없으므로 여기서 표시를 붙인다. */
        var pOpen = shown.p >= 2, bOpen = shown.b >= 2;
        pTotalEl.textContent = pOpen ? totalOf(r.player.slice(0, shown.p)) : '–';
        bTotalEl.textContent = bOpen ? totalOf(r.banker.slice(0, shown.b)) : '–';
        pTotalEl.classList.toggle('wait', !pOpen);
        bTotalEl.classList.toggle('wait', !bOpen);
      }

      /* ── 최근 결과 (구슬판) ─────────────────────────────────────────
         바카라 테이블에 항상 붙어 있는 그 판이다. 최신이 왼쪽. */
      function renderHistory(rows){
        if (!rows || !rows.length) { histEl.innerHTML = '<span class="bacc-bead-empty">아직 기록이 없습니다</span>'; return; }
        var sig = rows.map(function(r){ return r.winner[0]+r.playerTotal+r.bankerTotal; }).join('');
        if (histEl.dataset.sig === sig) return;
        histEl.dataset.sig = sig;
        histEl.innerHTML = rows.map(function(r){
          var c = r.winner === 'player' ? 'p' : r.winner === 'banker' ? 'b' : 't';
          var mark = r.winner === 'player' ? 'P' : r.winner === 'banker' ? 'B' : 'T';
          return '<span class="bacc-bead '+c+'" title="플레이어 '+r.playerTotal+' : 뱅커 '+r.bankerTotal+'">'+mark+'</span>';
        }).join('');
      }

`;
