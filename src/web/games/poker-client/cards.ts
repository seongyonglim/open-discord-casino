/* 포커 플립 화면 — 카드 그리기와 딜링 연출.

   브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라 문자열이고,
   poker.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   순서를 바꾸면 안 된다. 나눈 목적은 읽기이고, 산출물은 한 글자도 달라지지 않아야 한다
   (scripts/golden.ts 가 바이트로 확인한다). */
export const PK_CARDS_JS = `      function cardHtml(cstr){
        if (!cstr) return '<img class="pcard back" src="/cards/back.svg?v='+AV+'" alt="">';
        var rank = (cstr[0]==='T'?'10':cstr[0]);
        return '<img class="pcard" src="/cards/'+cstr+'.svg?v='+AV+'" alt="'+rank+SUIT_SYM[cstr[1]]+'">';
      }

      // 카드 슬롯 동기화 — 내용이 바뀐 칸만 교체한다.
      // (매 폴링마다 innerHTML을 통째로 갈아끼우면 tilePop 애니메이션이 초당 한 번씩 재시작돼
      //  카드가 계속 튀고, 플롭→턴→리버 순차 공개 연출도 사라진다)
      var slotCache={};
      function syncCards(el, key, values){
        var cache = slotCache[key];
        if (!cache || cache.length !== values.length) {
          // 처음 채우는 뒷면도 cardHtml(null)로 만들어야 한다.
          // 빈 <div class="pcard back">를 쓰면 .pcard에 배경이 없어서 그림자만 남은 투명 사각형이 되고,
          // 아래 루프는 cache[i]와 v가 둘 다 null이면 continue로 넘어가므로 그 상태가 그대로 굳는다.
          el.innerHTML = values.map(function(){ return cardHtml(null); }).join('');
          cache = slotCache[key] = values.map(function(){ return null; });
        }
        var revealed = 0;
        for (var i=0;i<values.length;i++){
          var v = values[i] || null;
          if (cache[i] === v) continue;
          if (v && cache[i] === null) revealed++;   // 뒷면 → 앞면으로 새로 공개된 장수
          cache[i] = v;
          el.children[i].outerHTML = cardHtml(v);
        }
        return revealed;
      }
      // 플롭처럼 여러 장이 한 번에 열릴 땐 소리를 살짝 어긋나게 겹쳐 카드 넘기는 느낌을 준다
      function playReveal(n){
        if (!n || !window.casinoSfx || !window.casinoSfx.card) return;
        for (var i=0;i<Math.min(n,3);i++) setTimeout(function(){ window.casinoSfx.card(); }, i*110);
      }

      /* ── 새 라운드 딜링 연출 ────────────────────────────────────────
         실제 홀덤처럼 섞고 → 마스터/샤크에 한 장씩 번갈아 두 바퀴 → 보드 5장을 뒷면으로 깐다.
         카드가 실제로 "날아와 놓이는" 것처럼 보이게, 화면 위 딜러 자리에서 각 카드 위치로
         복제본을 날린 뒤 해당 슬롯을 드러낸다. 카드 값 자체는 서버가 준 것만 쓰고
         보드는 뒷면이므로 이 연출이 결과를 미리 노출하지 않는다.                        */
      var dealtRoundId = null, dealing = false, pendingDeal = [];

      // 딜링 순서: 마스터 → 샤크 → 마스터 → 샤크 → 보드 5장
      function dealSlots(){
        return [
          { el: mCardsEl, i: 0 }, { el: sCardsEl, i: 0 },
          { el: mCardsEl, i: 1 }, { el: sCardsEl, i: 1 },
          { el: boardEl, i: 0 }, { el: boardEl, i: 1 }, { el: boardEl, i: 2 },
          { el: boardEl, i: 3 }, { el: boardEl, i: 4 },
        ];
      }

      // 딜링을 중단하면 감춰둔 카드를 반드시 되살려야 한다.
      // syncCards는 값이 바뀐 슬롯만 교체하므로, 안 바뀐 슬롯은 숨긴 채로 영구히 남는다.
      function clearDeal(){
        pendingDeal.forEach(clearTimeout);
        pendingDeal = [];
        dealing = false;
        showAllCards();
      }
      function showAllCards(){
        [mCardsEl, sCardsEl, boardEl].forEach(function(el){
          Array.prototype.forEach.call(el.querySelectorAll('.pcard'), function(c){ c.style.visibility = ''; });
        });
        // 날아가던 복제본이 남아 있으면 같이 치운다
        if (fxLayer) {
          Array.prototype.forEach.call(fxLayer.querySelectorAll('.deal-in'), function(c){
            if (c.parentNode) c.parentNode.removeChild(c);
          });
        }
      }

      function dealSequence(roundId){
        if (dealing || dealtRoundId === roundId) return;
        dealing = true; dealtRoundId = roundId;

        var slots = dealSlots();
        slots.forEach(function(s){
          var c = s.el.children[s.i];
          if (c) c.style.visibility = 'hidden';
        });

        if (window.casinoSfx && window.casinoSfx.shuffle) window.casinoSfx.shuffle();

        var SHUFFLE_MS = 620, STEP = 165, FLY_MS = 300;   // FLY_MS = .deal-in 애니메이션 길이
        slots.forEach(function(s, n){
          pendingDeal.push(setTimeout(function(){
            var card = s.el.children[s.i];
            if (!card) return;
            card.style.visibility = '';
            flyCardIn(card);
            if (window.casinoSfx && window.casinoSfx.deal) window.casinoSfx.deal();
          }, SHUFFLE_MS + n * STEP));
        });
        /* 마지막 장이 날아 도착한 뒤에 연출을 닫는다.
           마지막 장의 콜백 안에서 showAllCards()를 부르면 그 순간 아직 날고 있던
           복제본(마지막 장 + 그 앞 장)까지 같이 걷어내서, 끝의 두 장이 밀려오지 않고
           제자리에 툭 생겨나는 것처럼 보인다 — 딜링이 끊기는 느낌의 원인이었다.
           각 카드는 flyCardIn이 자기 타이머로 되살리니 여기서 되살릴 필요도 없다. */
        pendingDeal.push(setTimeout(function(){ dealing = false; },
          SHUFFLE_MS + (slots.length - 1) * STEP + FLY_MS));
        // 연출이 어떤 이유로 끊겨도 반드시 카드가 다시 보이도록 하는 안전장치
        pendingDeal.push(setTimeout(function(){ dealing = false; showAllCards(); },
          SHUFFLE_MS + slots.length * STEP + 800));
      }

      // 화면 상단 가운데(딜러 자리)에서 카드가 날아와 제자리에 놓이는 연출
      function flyCardIn(card){
        var r = card.getBoundingClientRect();
        if (!r.width) return;
        var stage = document.querySelector('.poker-table');
        var s = stage ? stage.getBoundingClientRect() : { left: r.left, top: r.top, width: 0 };
        var c = card.cloneNode(true);
        c.className = card.className.replace(/\\bdeal-in\\b/g, '').trim();
        c.style.cssText = 'position:fixed;margin:0;left:' + r.left + 'px;top:' + r.top + 'px;' +
          'width:' + r.width + 'px;height:' + r.height + 'px;';
        c.style.setProperty('--dfx', Math.round((s.left + s.width / 2) - (r.left + r.width / 2)) + 'px');
        c.style.setProperty('--dfy', Math.round((s.top - 40) - r.top) + 'px');
        c.classList.add('deal-in');
        getFxLayer().appendChild(c);
        card.style.visibility = 'hidden';
        // 이 타이머도 pendingDeal에 넣어야 중단 시 clearDeal이 함께 정리하고 카드를 되살린다
        pendingDeal.push(setTimeout(function(){
          if (c.parentNode) c.parentNode.removeChild(c);
          card.style.visibility = '';
        }, 300));
      }

`;
