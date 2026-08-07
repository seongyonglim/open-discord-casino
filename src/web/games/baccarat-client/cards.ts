/* 바카라 화면 — 카드 그리기와 딜링 연출.

   브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라 문자열이고,
   baccarat.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   순서를 바꾸면 안 된다. 나눈 목적은 읽기이고, 산출물은 한 글자도 달라지지 않아야 한다
   (scripts/golden.ts 가 바이트로 확인한다). */
export const BC_CARDS_JS = `      var SUIT_SYM={s:'\\u2660',h:'\\u2665',d:'\\u2666',c:'\\u2663'};
      function cardHtml(cstr){
        if (!cstr) return '<img class="pcard back" src="/cards/back.svg?v='+AV+'" alt="">';
        var rank = (cstr[0]==='T'?'10':cstr[0]);
        return '<img class="pcard" src="/cards/'+cstr+'.svg?v='+AV+'" alt="'+rank+SUIT_SYM[cstr[1]]+'">';
      }

      /* ── 카드 슬롯 동기화 ────────────────────────────────────────────
         매 폴링마다 innerHTML을 통째로 갈아끼우면 카드가 초당 한 번씩 다시 튀고
         순차 공개 연출이 사라진다. 그래서 내용이 바뀐 칸만 교체한다.
         바카라는 손패 장수 자체가 2장에서 3장으로 늘어나므로 길이 변화도 함께 다룬다. */
      var slotCache={};
      function syncCards(el, key, values){
        var cache = slotCache[key];
        if (!cache) { cache = slotCache[key] = []; el.innerHTML = ''; }
        // 장수가 줄었으면(새 라운드) 통째로 비운다
        if (values.length < cache.length) { el.innerHTML = ''; cache = slotCache[key] = []; }
        var revealed = 0;
        for (var i=0;i<values.length;i++){
          if (cache[i] === values[i]) continue;
          cache[i] = values[i];
          if (el.children[i]) el.children[i].outerHTML = cardHtml(values[i]);
          else el.insertAdjacentHTML('beforeend', cardHtml(values[i]));
          revealed++;
        }
        return revealed;
      }

      /* ── 딜링 연출 ───────────────────────────────────────────────────
         베팅 10초 동안 테이블이 비어 있으면 셔플 소리만 나고 볼 게 없다.
         그래서 새 라운드가 열리면 뒷면 네 장을 딜러 자리에서 한 장씩 내려놓는다.
         순서는 실제 바카라 그대로 플레이어 → 뱅커 → 플레이어 → 뱅커.
         마감되면 이 뒷면들이 그 자리에서 앞면으로 뒤집힌다(.pcard의 cardFlip). */
      var dealtRoundId = null, dealing = false, pendingDeal = [];
      function dealSlots(){
        return [
          { el: pCardsEl, i: 0 }, { el: bCardsEl, i: 0 },
          { el: pCardsEl, i: 1 }, { el: bCardsEl, i: 1 },
        ];
      }
      function showAllCards(){
        [pCardsEl, bCardsEl].forEach(function(el){
          Array.prototype.forEach.call(el.querySelectorAll('.pcard'), function(c){ c.style.visibility = ''; });
        });
        if (fxLayer) {
          Array.prototype.forEach.call(fxLayer.querySelectorAll('.deal-in'), function(c){
            if (c.parentNode) c.parentNode.removeChild(c);
          });
        }
      }
      function clearDeal(){
        pendingDeal.forEach(clearTimeout);
        pendingDeal = [];
        dealing = false;
        showAllCards();
      }
      // 카드가 테이블 상단 중앙(딜러 자리)에서 제자리로 날아온다.
      // 원본은 잠깐 숨기고 화면 전체 레이어에 복제본을 띄운다 — 자리 상자 밖 구간이 잘리지 않게.
      function flyCardIn(card){
        var r = card.getBoundingClientRect();
        if (!r.width) return;
        var stage = document.querySelector('.bacc-table');
        var s = stage ? stage.getBoundingClientRect() : { left: r.left, top: r.top, width: 0 };
        var c = card.cloneNode(true);
        c.className = card.className.replace(/\\bdeal-in\\b/g, '').trim();
        c.style.cssText = 'position:fixed;margin:0;left:' + r.left + 'px;top:' + r.top + 'px;' +
          'width:' + r.width + 'px;height:' + r.height + 'px;';
        c.style.setProperty('--dfx', Math.round((s.left + s.width / 2) - (r.left + r.width / 2)) + 'px');
        c.style.setProperty('--dfy', Math.round((s.top - 34) - r.top) + 'px');
        c.classList.add('deal-in');
        getFxLayer().appendChild(c);
        card.style.visibility = 'hidden';
        // 이 타이머도 pendingDeal에 넣어야 중단 시 clearDeal이 함께 정리하고 카드를 되살린다
        pendingDeal.push(setTimeout(function(){
          if (c.parentNode) c.parentNode.removeChild(c);
          card.style.visibility = '';
        }, 300));
      }
      function dealSequence(roundId){
        if (dealing || dealtRoundId === roundId) return;
        dealing = true; dealtRoundId = roundId;

        var slots = dealSlots();
        slots.forEach(function(s){
          var c = s.el.children[s.i];
          if (c) c.style.visibility = 'hidden';
        });
        /* 소리는 두 종류를 역할대로 갈라 쓴다:
             나눠주기(card-deal) — 카드가 새로 날아와 놓이는 순간. 여기, 그리고 세 번째 카드.
             넘기기(card-flip)   — 이미 놓인 뒷면을 뒤집는 순간.
           한때 뒤집기에도 "나눠주는" 소리를 썼는데, 카드가 새로 오는 것도 아닌데 딜링 소리가 나서
           방금 나눠준 걸 또 나눠주는 것처럼 들렸다. 같은 카드 네 장에 딜링 소리가 여덟 번 난 셈이다. */
        if (window.casinoSfx && window.casinoSfx.shuffle) window.casinoSfx.shuffle();

        // 셔플 소리가 잦아든 뒤부터 한 장씩. 네 장에 1.2초 남짓이라 10초 베팅 창에 넉넉히 들어간다.
        var SHUFFLE_MS = 500, STEP = 175, FLY_MS = 300;   // FLY_MS = .deal-in 애니메이션 길이
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
           복제본(넷째 장 + 셋째 장)까지 같이 걷어내서, 두 장이 밀려오지 않고 제자리에
           툭 생겨나는 것처럼 보인다 — 딜링이 끊기는 느낌의 원인이었다. */
        pendingDeal.push(setTimeout(function(){ dealing = false; },
          SHUFFLE_MS + (slots.length - 1) * STEP + FLY_MS));
        // 연출이 어떤 이유로 끊겨도 반드시 카드가 다시 보이도록 하는 안전장치
        pendingDeal.push(setTimeout(function(){ dealing = false; showAllCards(); },
          SHUFFLE_MS + slots.length * STEP + 800));
      }

      /* ── 한 장씩 공개 ────────────────────────────────────────────────
`;
