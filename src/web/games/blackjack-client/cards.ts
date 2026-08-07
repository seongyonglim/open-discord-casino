/* 블랙잭 화면 — 카드 그리기 · 딜러 패 · 버스트 · 끗수 · 상태 문구.

   브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라 문자열이고,
   blackjack.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   순서를 바꾸면 안 된다. 나눈 목적은 읽기이고, 산출물은 한 글자도 달라지지 않아야 한다
   (scripts/golden.ts 가 바이트로 확인한다). */
export const BJ_CARDS_JS = `      var SUIT_SYM={s:'\\u2660',h:'\\u2665',d:'\\u2666',c:'\\u2663'};
      function cardHtml(cstr){
        if (!cstr) return '<img class="pcard back" src="/cards/back.svg?v='+AV+'" alt="">';
        var rank = (cstr[0]==='T'?'10':cstr[0]);
        return '<img class="pcard" src="/cards/'+cstr+'.svg?v='+AV+'" alt="'+rank+SUIT_SYM[cstr[1]]+'">';
      }

      // 내용이 바뀐 칸만 교체한다 — 매 폴링마다 통째로 갈아끼우면 카드가 초당 한 번씩 다시 튄다
      var slotCache={};
      function syncCards(el, key, values){
        var cache = slotCache[key];
        if (!cache) { cache = slotCache[key] = []; el.innerHTML = ''; }
        if (values.length < cache.length) { el.innerHTML = ''; cache = slotCache[key] = []; }
        var added = 0;
        for (var i=0;i<values.length;i++){
          if (cache[i] === values[i]) continue;
          cache[i] = values[i];
          if (el.children[i]) el.children[i].outerHTML = cardHtml(values[i]);
          else el.insertAdjacentHTML('beforeend', cardHtml(values[i]));
          added++;
        }
        return added;
      }

      /* 깐 만큼만 그린다. 중요한 건 아직 안 뽑은 카드의 "자리"조차 만들지 않는 것이다 —
         뒷면을 미리 깔아두면 홀 카드를 뒤집기도 전에 딜러가 몇 장을 더 받을지가 다 보인다.
         실제 테이블 순서는: 두 장 → 합 확인 → 모자라면 그제서야 한 장 → 다시 합 확인 → … */
      function paintDealer(cards){
        var vals = cards.slice(0, shownD);
        if (shownD < 2) vals.push(null);   // 홀 카드는 아직 엎어져 있다
        var n = syncCards(dCardsEl, 'dealer', vals);
        var seen = cards.slice(0, shownD);
        setDealerTotal(seen.length ? bjTotal(seen) : null, shownD < 2 && seen.length > 0);
        // 깐 카드만으로 21을 넘겼는지 본다 — 안 깐 카드로 미리 판정하면 결과가 새어나간다
        markDealerBust(shownD >= 2 && bjTotal(seen) > 21);
        return n;
      }
      /* 딜러 버스트 연출.
         이 게임에서 가장 결정적인 순간인데 숫자만 조용히 22로 바뀌고 끝나서 밋밋했다.
         카드 위에 도장을 찍고, 끗수를 붉게 물들이고, 테이블을 한 번 번쩍이고,
         짧은 "쿵" 소리를 낸다. 한 번 찍힌 판에서는 다시 재생하지 않는다. */
      var bustShown = false;
      function markDealerBust(on){
        if (on === bustShown) return;
        bustShown = on;
        dTotalEl.classList.toggle('bust', on);
        bustEl.hidden = !on;
        if (!on) { bustEl.classList.remove('pop'); tableEl.classList.remove('bustflash'); return; }
        if (firstState) return;   // 이미 끝난 판을 열었을 뿐이다 — 도장만 남기고 연출은 생략
        replay(bustEl, 'pop');
        replay(tableEl, 'bustflash');
        if (window.casinoSfx && window.casinoSfx.bust) window.casinoSfx.bust();
      }
      function scheduleDealerReveal(want){
        if (want <= shownD || dealerTimers.length) return;
        // 홀 카드를 뒤집고 합을 보여준 뒤, 한 박자 쉬고 다음 장을 받는다.
        // 간격이 같으면 "뽑을지 말지 판단하는" 구간이 사라져 급발진처럼 보인다.
        var t = 0;
        for (var i = shownD; i < want; i++) {
          t += (i === 1) ? HOLE_FLIP_MS : DRAW_STEP_MS;
          (function(target, at){
            dealerTimers.push(setTimeout(function(){
              shownD = target;
              paintDealer((st && st.round.dealer.cards) || []);
              if (window.casinoSfx) {
                // 홀 카드는 뒤집는 것(넘기기), 그 뒤는 새로 받는 카드(나눠주기)
                if (target <= 2) window.casinoSfx.card();
                else window.casinoSfx.deal();
              }
            }, at));
          })(i + 1, t);
        }
      }
      // 화면에 깐 카드만으로 끗수를 낸다 — 서버 합계를 쓰면 아직 안 깐 카드가 미리 반영된다
      function bjTotal(cards){
        var total = 0, aces = 0;
        cards.forEach(function(c){
          var r = c[0];
          if (r === 'A') { total += 1; aces++; }
          else if (r === 'T' || r === 'J' || r === 'Q' || r === 'K') total += 10;
          else total += Number(r);
        });
        if (aces > 0 && total + 10 <= 21) total += 10;
        return total;
      }

      function statusText(r){
        // 아무도 앉지 않았으면 시간이 흐르지 않는다 — 카운트다운을 띄우면 안 된다
        if (r.phase === 'waiting') return '빈 자리를 눌러 앉으면 시작합니다';
        if (r.phase === 'betting') return '자리를 고르고 칩을 올리세요 · ' + r.secondsLeft + '초';
        if (r.phase === 'deal') return '카드를 나눠주는 중…';
        if (r.phase === 'action') return '힛 / 스탠드 · ' + r.secondsLeft + '초';
        if (r.phase === 'dealer') return '딜러 차례…';
        var d = r.dealer;
        return '딜러 ' + (d.total != null ? d.total : '?') + ' · 다음 라운드까지 ' + r.secondsLeft + '초';
      }

      function statusLabel(s){
        return s==='blackjack' ? '블랙잭' : s==='bust' ? '버스트'
          : s==='surrender' ? '서렌더' : s==='stand' ? '스탠드' : '';
      }
      function outcomeLabel(o){
        return o==='blackjack' ? '블랙잭!' : o==='win' ? '승' : o==='push' ? '무승부'
          : o==='bust' ? '버스트' : o==='surrender' ? '서렌더' : '패';
      }

`;
