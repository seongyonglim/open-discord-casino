/* 블랙잭 화면 — 렌더.

   브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라 문자열이고,
   blackjack.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   순서를 바꾸면 안 된다. 나눈 목적은 읽기이고, 산출물은 한 글자도 달라지지 않아야 한다
   (scripts/golden.ts 가 바이트로 확인한다). */
export const BJ_RENDER_JS = `      function render(){
        var r = st.round;
        setBalance(st.balance);
        renderCoins();
        statusEl.textContent = statusText(r);
        statusEl.className = 'bj-status' + (r.phase === 'action' ? ' live' : '');

        if (r.id !== lastRoundId) {
          lastRoundId = r.id;
          slotCache = {};
          clearDealerReveal(); shownD = 0;
          dCardsEl.innerHTML = ''; seatsEl.dataset.sig = '';
          setDealerTotal(null, false);
          seatBust = {};   // 지난 판의 버스트 도장 기록을 버린다
          if (!firstState && window.casinoSfx) window.casinoSfx.shuffle();
        }

        // 딜러: 공개 전에는 업카드 한 장 + 뒷면 한 장
        // 딜러: 공개 전에는 업카드 한 장 + 뒷면 한 장. 공개되면 한 장씩 깐다.
        var d = r.dealer;
        var dealt = 0;
        if (d.hidden) {
          clearDealerReveal();
          shownD = 0;
          dealt += syncCards(dCardsEl, 'dealer', d.cards.length ? d.cards.concat([null]) : []);
          setDealerTotal(d.total, d.total != null);
          markDealerBust(false);   // 새 판이 시작됐다 — 지난 판의 도장을 걷는다
        } else {
          // 페이지에 막 들어왔거나 이미 끝난 판이면 연출 없이 다 보여준다
          if (firstState || r.phase === 'done') { clearDealerReveal(); shownD = d.cards.length; }
          else {
            // 업카드는 결정 창 내내 보이고 있었다 — 0부터 그리면 잠깐 사라졌다 다시 나타난다
            if (shownD === 0) shownD = 1;
            scheduleDealerReveal(d.cards.length);
          }
          dealt += paintDealer(d.cards);
        }

        dealt += renderSeats();
        if (dealt && !firstState && window.casinoSfx) window.casinoSfx.deal();

        // 내 차례 버튼 — 결정 창에서 아직 안 정했을 때만
        var can = st.myHand && st.myHand.canAct;
        actionsEl.hidden = !can;
        hitBtn.disabled = !can; standBtn.disabled = !can;
        // 더블은 처음 두 장에서만 뜬다. 못 쓸 때 회색으로 남겨두면 왜 안 되는지 알 수 없어 아예 숨긴다.
        dblBtn.hidden = !(st.myHand && st.myHand.canDouble);
        // 서렌더도 처음 두 장에서만 — 쓸 수 없을 때는 아예 숨긴다(더블과 같은 규칙)
        surBtn.hidden = !(st.myHand && st.myHand.canSurrender);
        // 얼마가 더 나가는지 버튼에 적어 둔다 — '두 배'라는 말만으로는 액수가 안 잡힌다
        var costEl = document.getElementById('bjDblCost');
        if (costEl && st.myHand) costEl.textContent = '+' + compact(st.myHand.bet) + 'P';

        renderRoster();
        firstState = false;

        if (r.phase === 'done' && notedRoundId !== r.id) {
          notedRoundId = r.id;
          flyChipsToPot();
          var me = (st.seats||[]).filter(function(s){ return s.userId === MEID; })[0];
          if (me && me.outcome) {
            if ((me.payout||0) > 0) {
              if (window.casinoSfx) window.casinoSfx.win();
              if (me.payout > me.bet) { if (card) replay(card, 'gold-flash'); if (pbal) replay(pbal, 'bump'); }
            } else if (window.casinoSfx) window.casinoSfx.lose();
          }
        }
      }

      /* ── 코인 더미 ───────────────────────────────────────────────────
         포커 플립·바카라와 같은 방식이다. 자리별로 "지금까지 올라온 칩 목록"을 들고 있다가
`;
