/* 바카라 화면 — 베팅 상자.

   브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라 문자열이고,
   baccarat.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   순서를 바꾸면 안 된다. 나눈 목적은 읽기이고, 산출물은 한 글자도 달라지지 않아야 한다
   (scripts/golden.ts 가 바이트로 확인한다). */
export const BC_MARKETS_JS = `      /* ── 베팅 상자 ──────────────────────────────────────────────────
         골격은 라운드/단계/결과가 바뀔 때만 다시 그린다.
         매초 새로 만들면 그 순간의 클릭이 씹히고 쌓아둔 칩 더미도 날아간다. */
      function marketTile(d, betting, isPair){
        var res = st.round.result;
        var winCls = '';
        if (res) {
          var hit = (d.key==='player' && res.winner==='player')
                 || (d.key==='banker' && res.winner==='banker')
                 || (d.key==='tie'    && res.winner==='tie')
                 || (d.key==='ppair'  && res.playerPair)
                 || (d.key==='bpair'  && res.bankerPair);
          // 무승부는 플레이어·뱅커에 승패가 아니라 환불이므로 흐리게 처리하지 않는다
          if ((d.key==='player'||d.key==='banker') && res.winner==='tie') winCls = '';
          else winCls = hit ? ' hit' : ' miss';
        }
        var pr = isPair ? PROB.pair : PROB[d.key];
        return '<button type="button" class="market '+d.cls+(betting?'':' disabled')+winCls+'" data-market="'+d.key+'">' +
          '<span class="m-top"><span class="m-total" id="tot-'+d.key+'">0</span>' +
            '<span class="m-odds">'+ODDS[d.key].toFixed(2)+'x</span></span>' +
          '<span class="m-pile" id="pile-'+d.key+'"></span>' +
          '<span class="m-body"><span class="m-label">'+d.label+'</span>' +
            '<span class="m-sub">'+d.sub+' · '+(pr*100).toFixed(1)+'%</span></span>' +
          '</button>';
      }
      var marketSig=null;
      function renderMarkets(){
        var betting = st.round.phase==='betting';
        var sig = st.round.id+'|'+st.round.phase+'|'+JSON.stringify(st.round.result||null);
        if (sig === marketSig) return;
        marketSig = sig;
        var html = '<div class="market-row bacc-main">' +
          MARKET_DEFS.map(function(d){ return marketTile(d, betting, false); }).join('') +
          '</div><div class="market-row bacc-pair">' +
          PAIR_DEFS.map(function(d){ return marketTile(d, betting, true); }).join('') +
          '</div>';
        marketsEl.innerHTML = html;
        piles = {};   // 골격을 새로 만들었으니 더미 캐시도 초기화
        marketsEl.querySelectorAll('.market').forEach(function(el){
          el.addEventListener('click', function(){
            if (el.classList.contains('disabled')) return;
            placeChip(el.getAttribute('data-market'));
          });
        });
      }

      /* ── 코인 더미 ───────────────────────────────────────────────────
`;
