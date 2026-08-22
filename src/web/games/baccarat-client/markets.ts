/* 바카라 화면 — 베팅 상자.

   브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라 문자열이고,
   baccarat.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   순서를 바꾸면 안 된다. 나눈 목적은 읽기이고, 산출물은 한 글자도 달라지지 않아야 한다
   (scripts/golden.ts 가 바이트로 확인한다). */
export const BC_MARKETS_JS = `      /* ── 베팅 상자 ──────────────────────────────────────────────────
         골격은 라운드/단계/결과가 바뀔 때만 다시 그린다.
         매초 새로 만들면 그 순간의 클릭이 씹히고 쌓아둔 칩 더미도 날아간다. */
      /* 배당은 배율 하나로만 적는다. 한동안 «1 : 1» 같은 비율을 함께 적었는데,
         두 숫자가 같은 것을 다르게 말하는 것이라 읽는 사람이 한 번 더 계산하게 된다 —
         정작 알고 싶은 것은 "이기면 얼마가 되나" 이고 그것이 배율이다(제보). */
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
        /* 상자 안에 두는 것은 셋뿐이다.
             위    무엇에 거는가(이름) · 이기면 몇 배인가
             가운데 칩이 쌓이는 자리
             아래   몇 명이 · 얼마를 걸었나(나를 포함한 모두)

           한동안 여기에 «몇 대 몇» 비율과 «판의 몇 %» 막대와 «내 베팅» 알약을 함께
           두었다. 셋 다 이미 있는 것을 다르게 말하는 값이었다 — 비율은 배율과 같은
           말이고, 퍼센트는 총액 셋을 견주면 보이고, 내 베팅은 칩 더미가 이미 보여 준다.
           좁은 상자에 그것들이 겹쳐 쌓이면서 선이 어지럽게 났다(제보). 걷어 낸다. */
        return '<button type="button" class="market '+d.cls+(betting?'':' disabled')+winCls+'" data-market="'+d.key+'">' +
          '<span class="m-head">' +
            '<span class="m-name">'+d.name+'</span>' +
            '<span class="m-odds">'+ODDS[d.key].toFixed(2)+'x</span>' +
          '</span>' +
          '<span class="m-mid">' +
            '<span class="m-pile" id="pile-'+d.key+'"></span>' +
          '</span>' +
          '<span class="m-foot">' +
            '<span class="m-cnt" id="cnt-'+d.key+'">0명</span>' +
            '<span class="m-total" id="tot-'+d.key+'">0P</span>' +
          '</span>' +
          '</button>';
      }
      var marketSig=null;
      /* ── 다섯 구역을 한 덩어리로 세운다 ────────────────────────────────
         바깥 둘은 페어(좁은 날개), 가운데 셋이 일체형이다 — 플레이어와 뱅커가 위쪽
         가로를 반씩 채우며 가는 선으로 맞닿고, 타이는 그 아래 가운데에 둥근 돔으로
         얹힌다. 타이를 별도 줄에 두지 않는 이유는 «세 곳 중 하나를 고르는 것» 이기
         때문이다 — 줄이 나뉘면 페어처럼 곁다리로 읽힌다.
         돔은 흐름에서 빼서(absolute) 두 상자 위에 얹는다. 그래야 플레이어·뱅커가
         가로를 온전히 반씩 갖고, 그 경계가 돔 뒤로 자연스럽게 이어진다. */
      function renderMarkets(){
        var betting = st.round.phase==='betting';
        var sig = st.round.id+'|'+st.round.phase+'|'+JSON.stringify(st.round.result||null);
        if (sig === marketSig) return;
        marketSig = sig;
        var by = {};
        MARKET_DEFS.concat(PAIR_DEFS).forEach(function(d){ by[d.key] = d; });
        var html =
          marketTile(by.ppair, betting, true) +
          '<span class="bacc-core">' +
            marketTile(by.player, betting, false) +
            marketTile(by.banker, betting, false) +
            marketTile(by.tie, betting, false) +
          '</span>' +
          marketTile(by.bpair, betting, true);
        marketsEl.innerHTML = html;
        towers = {};   // 골격을 새로 만들었으니 타워 캐시도 초기화
        marketsEl.querySelectorAll('.market').forEach(function(el){
          el.addEventListener('click', function(){
            if (el.classList.contains('disabled')) return;
            placeChip(el.getAttribute('data-market'));
          });
        });
      }

      /* ── 코인 더미 ───────────────────────────────────────────────────
`;
