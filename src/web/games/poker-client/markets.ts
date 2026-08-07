/* 포커 플립 화면 — 베팅 시장 타일 · 참가자 목록 · 합계.

   브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라 문자열이고,
   poker.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   순서를 바꾸면 안 된다. 나눈 목적은 읽기이고, 산출물은 한 글자도 달라지지 않아야 한다
   (scripts/golden.ts 가 바이트로 확인한다). */
export const PK_MARKETS_JS = `      var MARKET_DEFS = [
        { key:'master', label:'MASTER 승', cls:'m-master' },
        { key:'shark',  label:'SHARK 승',  cls:'m-shark' },
      ];

      // 승자 상자의 점등 전적 — 등급 상자(dotsHtml)와 같은 읽는 법이다.
      // 상단에 따로 전적 띠를 두는 대신 각 상자 안에 넣어, 그 시장이 최근에 얼마나
      // 들어왔는지를 베팅하려는 자리에서 바로 보게 한다.
      // 무승부는 어느 쪽 승도 아니므로 초록 점으로 따로 표시한다(꺼진 점과 구분된다).
      function winnerDotsHtml(key){
        var h=(st.history||[]).slice(0, DOTS), cells=[];
        for (var i=0;i<DOTS;i++) cells.push(h[i] || null);
        cells.reverse();
        return '<span class="m-dots w-'+key+'">' + cells.map(function(c){
          if (!c) return '<i class="dot"></i>';
          if (c.winner === 'tie') return '<i class="dot tie"></i>';
          return '<i class="dot'+(c.winner===key?' hit':'')+'"></i>';
        }).join('') + '</span>';
      }

      // 최근 DOTS판의 등급 달성 여부 — 오른쪽이 최신, 왼쪽으로 갈수록 예전 판
      function dotsHtml(bucketIdx){
        var h=(st.history||[]).slice(0, DOTS), cells=[];
        for (var i=0;i<DOTS;i++) cells.push(h[i] || null);
        cells.reverse();
        return '<span class="m-dots">' + cells.map(function(c){
          if (!c) return '<i class="dot"></i>';
          return '<i class="dot'+(c.buckets.indexOf(bucketIdx)>=0?' hit':'')+'"></i>';
        }).join('') + '</span>';
      }
      // 풀하우스 이상은 자주 안 나와서 점으로 보면 거의 다 꺼진 줄이 된다.
      // 그래서 이쪽은 점 대신 "몇 판째 안 나왔는지"만 보여준다.
      function droughtHtml(bucketIdx){
        var h=(st.history||[]), k=-1;
        for (var i=0;i<h.length;i++){ if (h[i].buckets.indexOf(bucketIdx)>=0){ k=i; break; } }
        if (k === 0) return '<span class="m-drought">직전 판 적중</span>';
        if (k > 0) return '<span class="m-drought">'+k+'판째 미출현</span>';
        return h.length ? '<span class="m-drought">'+h.length+'판+ 미출현</span>' : '<span class="m-drought">기록 없음</span>';
      }
      // b0~b2는 점등 전적, b3~b4(풀하우스·포카드 이상)는 미출현 판수
      function bucketFoot(bucketIdx){
        return bucketIdx <= 2 ? dotsHtml(bucketIdx) : droughtHtml(bucketIdx);
      }

      function marketTile(key, label, odds, cls, betting, opt){
        var disabled = odds == null || !betting;
        var res = st.round.result;
        var winCls = '';
        if (res) {
          var isWinner = (key==='master'||key==='shark');
          // 무승부는 승패가 아니라 환불이므로 두 시장 모두 흐리게 처리하지 않는다
          if (isWinner && res.winner==='tie') winCls = '';
          else {
            var isWin = isWinner ? res.winner===key : res.buckets.indexOf(Number(key.slice(1))) >= 0;
            winCls = isWin ? ' hit' : ' miss';
          }
        }
        var foot = opt.bucketIdx != null ? bucketFoot(opt.bucketIdx) : winnerDotsHtml(key);
        return '<button type="button" class="market '+cls+(disabled?' disabled':'')+winCls+'" data-market="'+key+'">' +
          '<span class="m-top"><span class="m-total" id="tot-'+key+'">0</span>' +
            '<span class="m-odds">'+(odds==null?'—':odds.toFixed(2)+'x')+'</span></span>' +
          '<span class="m-pile" id="pile-'+key+'"></span>' +
          '<span class="m-body"><span class="m-label">'+esc(label)+'</span>'+foot+'</span>' +
          '</button>';
      }

      // 상자 골격은 라운드/단계/배당/결과가 바뀔 때만 다시 그린다.
      // (매초 새로 만들면 그 순간의 클릭이 씹히고 코인 더미도 날아간다)
      var marketSig=null;
      function renderMarkets(){
        var o=st.round.odds, betting = st.round.phase==='betting';
        var sig = st.round.id+'|'+st.round.phase+'|'+JSON.stringify(o)+'|'+
          JSON.stringify(st.round.result||null)+'|'+(st.history||[]).length;
        if (sig === marketSig) return;
        marketSig = sig;

        var html = '<div class="market-row">';
        MARKET_DEFS.forEach(function(d){
          html += marketTile(d.key, d.label, o[d.key], d.cls, betting, {});
        });
        html += '</div><div class="market-row bucket-row">';
        (st.bucketNames||[]).forEach(function(name, i){
          html += marketTile('b'+i, name, o.buckets[i], 'm-bucket', betting, { bucketIdx:i });
        });
        html += '</div>';
        marketsEl.innerHTML = html;
        piles = {};   // 골격을 새로 만들었으니 더미 캐시도 초기화

        marketsEl.querySelectorAll('.market').forEach(function(el){
          el.addEventListener('click', function(){
            if (el.classList.contains('disabled')) return;
            placeChip(el.getAttribute('data-market'));
          });
        });
      }

      /* ── 우측 참가자 패널 ────────────────────────────────────────────
         디스코드 아바타 · 닉네임 · 보유 포인트. 목록 구성이 바뀔 때만 다시 그리고,
         보유 포인트는 값이 변한 사람만 제자리에서 갱신하며 증감 표시를 준다.       */
      var rosterSig=null, lastBal={};
      function renderRoster(){
        var players = st.players || [];
        var sig = players.map(function(p){ return p.user_id; }).join(',');
        if (sig !== rosterSig) {
          rosterSig = sig;
          if (!players.length) {
            rosterEl.innerHTML = '<div class="empty" style="padding:16px 0">아직 참가자가 없습니다</div>';
          } else {
            rosterEl.innerHTML = players.map(function(p){
              var ini = esc((String(p.username||'?').trim()[0] || '?').toUpperCase());
              /* 이미지가 실패하면 이니셜로 되돌린다. 디스코드에서 프로필을 바꾸면
                 저장해 둔 주소는 404가 되는데(아바타 갱신은 다시 로그인할 때뿐이고
                 세션이 60일 슬라이딩이라 그 사이 내내 죽은 주소다), 폴백이 없으면
                 그 자리에 빈 원이 남는다. 클래스는 그대로 두어야 칩 연출이 이 자리를
                 계속 찾는다(rosterAvatar가 .rw-av로 찾는다). */
              var ph = '<span class="rw-av">'+ini+'</span>';
              var av = p.avatar
                ? '<img class="rw-av" src="'+esc(p.avatar)+'" alt="" referrerpolicy="no-referrer"'
                  + ' onerror="this.onerror=null;this.outerHTML='+esc(JSON.stringify(ph))+'">'
                : ph;
              return '<div class="rw'+(p.user_id===st.me?' me':'')+'" data-uid="'+esc(p.user_id)+'">' +
                av +
                '<span class="rw-mid"><span class="rw-name">'+esc(p.username)+'</span>' +
                '<span class="rw-bal" id="bal-'+esc(p.user_id)+'">'+fmt(p.balance)+'</span></span>' +
                '<span class="rw-bet" id="bet-'+esc(p.user_id)+'"></span></div>';
            }).join('');
          }
        }
        players.forEach(function(p){
          var balEl = document.getElementById('bal-'+p.user_id);
          if (balEl) {
            var prev = lastBal[p.user_id];
            if (prev != null && p.balance !== prev) replay(balEl, p.balance > prev ? 'up' : 'down');
            balEl.textContent = fmt(p.balance);
          }
          lastBal[p.user_id] = p.balance;
          var betEl = document.getElementById('bet-'+p.user_id);
          if (betEl) {
            betEl.innerHTML = (p.payout > 0)
              ? '<span class="pos">+'+fmt(p.payout)+'</span>'
              : fmt(p.staked);
          }
          var row = rosterEl.querySelector('.rw[data-uid="'+cssEsc(p.user_id)+'"]');
          if (row) row.classList.toggle('won', p.payout > 0);
        });
      }

      // 총액 표기 + 코인 더미는 매 폴링마다 갱신 (골격은 건드리지 않는다)
      function updateTotals(){
        var byMarket={}, total=0;
        (st.bets||[]).forEach(function(b){
          if (!byMarket[b.market]) byMarket[b.market] = {};
          byMarket[b.market][b.user_id] = (byMarket[b.market][b.user_id]||0) + b.amount;
          total += b.amount;
        });

        ALL_KEYS.forEach(function(k){
          var per = byMarket[k] || {};
          var t = 0;
          Object.keys(per).forEach(function(u){ t += per[u]; });
          var el=document.getElementById('tot-'+k);
          if (el) el.textContent = compact(t);
          syncPile(k, per, st.round.id);
        });

        potEl.textContent = fmt(total);
        // 내가 올린 칩 총액은 Clear 버튼 활성 여부를 정하는 데만 쓴다(표시는 참가자 패널이 담당)
        var staked = (st.myBets||[]).reduce(function(a,b){return a+b.amount;},0);
        clearBtn.disabled = st.round.phase!=='betting' || staked<=0;
      }

`;
