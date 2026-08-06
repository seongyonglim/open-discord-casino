/* 홀덤 화면 — 액션 라벨 · 칩 분해 · 팟 더미.

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
export const CHIPS = `    function actLabel(kind, amount){
      if (kind === 'fold') return '폴드';
      if (kind === 'check') return '체크';
      if (kind === 'allin') return 'ALL IN';
      if (kind === 'call') return '콜';
      if (kind === 'bet') return '베팅';
      if (kind === 'raise') return '레이즈';
      void amount;
      return '';
    }

    /* ── 중앙 팟 칩 더미 ────────────────────────────────────────────
       스트리트가 닫힐 때마다 각자 앞의 칩이 중앙으로 모인다. 그 "모인 것"을 실제로
       쌓아 둔다 — 숫자만 있으면 팟이 커지는 게 보이지 않고, 끝나서 승자에게 갈 때도
       무엇이 가는지가 없다.

       올린 칩은 목록으로 기억한다. 총액을 다시 쪼개면 500 두 개가 1000 한 개로
       합쳐져 버린다 — 블랙잭에서 똑같은 문제를 겪고 칩 로그로 고쳤다. */
    /* ── 칩 액면 ────────────────────────────────────────────────────
       실제 카지노의 색 규약을 그대로 쓴다:
         흰 100 · 빨강 500 · 초록 1,000 · 검정 5,000 · 보라 10,000
       색이 곧 금액이라 숫자를 읽지 않아도 판의 크기가 보인다 — 보라가 섞이기
       시작하면 큰 판이다. 예전에는 전부 금색 동전과 금색 골드바 두 종류였다.
       다른 게임과 부품을 공유해서 편했지만, 홀덤 테이블 위에서 모든 칩이 같은
       색이면 "쌓였다"밖에 말하지 못한다.

       다섯 종으로 정한 근거는 이 대회의 규모다 — 시작 스택 10,000, 15명이면
       전체 15만이고 블라인드는 25/50에서 시작해 후반에 수천 단위가 된다.
       어느 구간에서도 칩 두세 개로 표현된다.
       25·50 같은 초반 블라인드는 100 하나로 뭉뚱그린다. 개수를 금액과 1:1로
       맞추는 것보다 "칩이 놓였다"가 눈에 보이는 것이 중요하다. */
    var HT_DENOMS = [10000, 5000, 1000, 500, 100];
    var HT_DCLASS = { 10000: 'd10k', 5000: 'd5k', 1000: 'd1k', 500: 'd500', 100: 'd100' };
    var HT_MAX_CHIPS = 30;
    function htDenomClass(v){ return HT_DCLASS[v] || 'd100'; }
    function htDecompose(amount){
      var out = [];
      for (var i = 0; i < HT_DENOMS.length && out.length < HT_MAX_CHIPS; i++) {
        while (amount >= HT_DENOMS[i] && out.length < HT_MAX_CHIPS) {
          out.push(HT_DENOMS[i]); amount -= HT_DENOMS[i];
        }
      }
      /* 100으로 안 나뉘는 잔액(25 스몰블라인드, 앤티 나머지)이 남는다.
         가장 작은 칩 하나로 대신 보여준다. */
      if (amount > 0 && out.length < HT_MAX_CHIPS) out.push(HT_DENOMS[HT_DENOMS.length - 1]);
      return out;
    }
    /* ── 중앙 더미를 액면별 기둥으로 세운다 ─────────────────────────
       예전에는 6열 격자에 난수 지터를 얹어 흩뿌렸다. "많이 쌓였다"는 느껴졌지만
       무엇이 얼마나 쌓였는지는 안 보였다 — 실제 딜러는 팟을 액면별로 세워 정리한다.

       규칙은 둘이다.
         같은 액면 → 위로 쌓아 기둥 하나 (Y축)
         다른 액면 → 옆으로 나란히      (X축, 큰 액면이 왼쪽)
       기둥 하나가 너무 높아지면(6장) 같은 액면이라도 옆에 새 기둥을 세운다.
       칩 위에 숫자는 적지 않는다 — 액면은 색이 말하고 금액은 아래 배지가 말한다. */
    var PILE_COL_MAX = 6;      // 기둥 하나에 쌓는 최대 장수
    var PILE_COL_W = 15;       // 기둥 사이 가로 간격
    var PILE_LIFT = 4;         // 한 장 올라갈 때의 세로 간격
    function pileLayout(chips){
      /* 액면 순서를 HT_DENOMS(큰 것부터)로 고정한다. 등장 순서로 세우면 같은 금액인데
         판마다 기둥 순서가 달라져서 "무엇이 쌓였나"를 눈이 다시 읽어야 한다. */
      var byD = {};
      chips.forEach(function(c){ (byD[c.d] = byD[c.d] || []).push(c); });
      var cols = [];
      HT_DENOMS.forEach(function(d){
        var list = byD[d]; if (!list) return;
        for (var i = 0; i < list.length; i += PILE_COL_MAX) {
          cols.push({ d: d, n: Math.min(PILE_COL_MAX, list.length - i) });
        }
      });
      return cols;
    }
    function htChipSprite(denom, col, row, nCols, pending){
      // 기둥 묶음을 가운데 정렬한다
      var x = Math.round((col - (nCols - 1) / 2) * PILE_COL_W);
      var y = row * PILE_LIFT;
      return '<span class="ht-pchip pkchip ' + htDenomClass(denom) +
        (pending ? ' pending' : '') + '" data-d="' + denom + '"' +
        ' style="left:calc(50% + ' + x + 'px);bottom:' + y + 'px;z-index:' + (10 + row) + '">' +
        '</span>';
    }
    /* ── 층별 칩 더미 ───────────────────────────────────────────────
       팟이 갈라지면 더미도 갈라진다. 하나로 뭉쳐 두면 "어느 팟을 누가 가져갔나"를
       보여줄 방법이 없다 — 정산 연출이 층마다 따로 날아가려면 칩도 층마다 있어야 한다.

       칩은 금액의 표현이므로 층 금액에 비례해 나눈다. 쌓인 칩 목록(append-only)은
       그대로 두고, 그 목록을 층 금액의 누적 경계로 잘라 각 더미에 넣는다.
       총액을 층마다 다시 쪼개지 않는 이유는 예전과 같다 — 500 두 개가 1000 한 개로
       합쳐져 보이면 얼마가 어떻게 모였는지가 사라진다. */
    var potPile = { hand: null, total: 0, list: [], n: 0, sig: '', cnt: null };
    // 이 판의 중앙 더미를 이미 승자에게 다 보냈다 — 다시 그리지 않는다
    var potClearedHand = null;
    /* 지금 중앙에 실제로 모여 있는 돈을 층별로.
       서버의 pots는 committed 기준이라 "각자 앞에 놓인 이번 스트리트 베팅"까지 들어 있다.
       그대로 그리면 같은 칩이 두 곳에 보인다 — 앞에는 콜한 칩이 놓여 있는데 중앙에도
       그만큼 쌓이고, 사이드 팟이 갈리는 판에서는 SIDE 1·SIDE 2 이름표까지 미리 뜬다.

       그래서 앞에 놓인 몫을 층에서 덜어낸다. 위 층부터 덜어낸다 — 이번 스트리트의
       베팅은 언제나 가장 위 층으로 들어가기 때문이다. 덜어내다 0이 된 층은 사라지고,
       라운드가 닫혀 칩이 중앙으로 날아오면 그 층이 칩과 함께 다시 나타난다.
       "수거가 끝난 뒤에 중앙 팟을 만든다"가 규칙 하나로 저절로 나온다.

       판이 끝나면 마지막 스트리트까지 전부 중앙으로 모이므로 덜 것이 없다 —
       그때는 서버의 층 구성과 정확히 같아진다(정산 연출이 그 번호에 걸려 있다). */
    function pileLayers(tb){
      if (!tb) return [0];
      var live = 0;
      if (!tb.ended) (tb.seats || []).forEach(function(s){ live += s.bet || 0; });
      var ps = (tb.pots || []).map(function(p){ return p.amount || 0; });
      if (ps.length < 2) return [Math.max(0, (tb.pot || 0) - live)];
      for (var i = ps.length - 1; i >= 0 && live > 0; i--) {
        var cut = Math.min(ps[i], live);
        ps[i] -= cut; live -= cut;
      }
      var out = ps.filter(function(a){ return a > 0; });
      return out.length ? out : [0];
    }
    /* 더미에는 금액만 적는다.
       예전에는 층이 갈라지면 위에 MAIN / SIDE 1 이름표를 얹었다. 층이 몇 개인지는
       더미가 몇 덩이인지로 이미 보이고, 어느 층이 누구에게 가는지는 정산할 때
       그 더미가 실제로 날아가는 것으로 보인다 — 글자는 그 위에 한 겹 더 얹은 설명이었다.
       펠트 한가운데에서 걷어낸 다른 글자들과 같은 이유다.

       금액 배지는 층이 하나여도 붙인다. "하나뿐이면 위쪽 Total Pot이 이미 말한다"고
       봤는데, 실제 화면에서는 보드 아래에 칩 한 장만 덩그러니 놓여 있고 그것이 얼마인지
       옆에 아무것도 없었다 — 위쪽 숫자와 이 칩이 같은 것이라는 연결이 안 잡힌다. */
    /* 칩 단위일 때 'P'는 붙이지 않는다. 테이블 위의 모든 숫자가 같은 단위라 매번
       적으면 그 글자만 다섯 군데에 반복된다 — 스택에도, 베팅에도, 팟에도 안 붙는다.
       BB 표기는 남긴다. 그건 단위가 아니라 "블라인드 몇 배"라는 다른 척도라서,
       빼면 5,000과 5BB를 구분할 방법이 사라진다(stackText가 직접 붙인다). */
    function pileLabel(amount){
      if (amount <= 0) return '';
      return '<span class="ht-pg-v">' + stackText(amount) + '</span>';
    }
    /* 더미를 다시 그린다. 층마다 자기 금액을 직접 액면으로 분해한다.

       예전에는 쌓인 칩 목록 하나를 층 금액의 누적 비율로 잘라 나눠 줬다. 그 방식은
       금액 차이가 크면 작은 층이 통째로 굶는다 — MAIN 39,000 · SIDE 450 · SIDE 200에서
       비율 반올림이 서른 장을 전부 MAIN에 주고 사이드 두 층은 0장이 됐다(실측:
       금액 배지만 뜨고 칩이 하나도 없었다).

       층 금액을 각각 분해하면 그 문제가 아예 생기지 않고, 덤으로 각 층의 칩 색이
       그 층의 실제 금액과 맞는다 — 450짜리 사이드 팟에 검정 5,000칩이 놓이지 않는다. */
    var PILE_LAYER_MAX = 14;   // 한 층에 그리는 최대 장수
    /* prev는 "직전 그림에서 각 층에 있던 칩 수"다. 그보다 뒤에 오는 칩은 이번에 새로
       도착하는 칩이므로 pending으로 숨겨 두고, 좌석 앞 칩이 날아와 닿을 때 드러낸다.
       칩이 하나도 없던 층(새로 갈라진 사이드 팟)은 이름표까지 통째로 숨긴다 —
       칩은 아직 날아오는 중인데 "SIDE 1 · 450"만 먼저 떠 있으면 그 순간 화면에는
       같은 돈이 두 곳에 적혀 있게 된다.
       prev를 안 넘기면(리셋·복원) 아무것도 숨기지 않는다. */
    function paintPotPile(tb, prev){
      var amts = pileLayers(tb);
      pileEl.style.opacity = '';
      pileEl.className = 'ht-piles' + (amts.length > 1 ? ' split' : '');
      var html = '', counts = [];
      for (var i = 0; i < amts.length; i++) {
        var ds = htDecompose(amts[i]).slice(0, PILE_LAYER_MAX);
        var have = prev ? (prev[i] || 0) : -1;    // -1이면 숨기지 않는다
        var inner = '', cols = pileLayout(ds.map(function(d){ return { d: d }; })), k = 0;
        cols.forEach(function(c, cx){
          for (var rw = 0; rw < c.n; rw++) inner += htChipSprite(c.d, cx, rw, cols.length, have >= 0 && k++ >= have);
        });
        counts.push(ds.length);
        html += '<div class="ht-pg' + (have === 0 ? ' pending' : '') + '" data-layer="' + i + '">' +
          '<span class="ht-pg-chips">' + inner + '</span>' +
          pileLabel(amts[i]) + '</div>';
      }
      pileEl.innerHTML = html;
      return counts;
    }
    function resetPotPile(tb, settled){
      potPile = { hand: tb.handNo, total: 0, list: [], n: 0, sig: '', cnt: null };
      if (settled > 0) { potPile.total = settled; potPile.list = htDecompose(settled).map(function(d, i){
        return { d: d, i: i % HT_MAX_CHIPS };
      }); }
      potPile.n = potPile.list.length;
      potPile.sig = pileLayers(tb).join(',') + '/' + unit;
      potPile.cnt = paintPotPile(tb);
    }
    function syncPotPile(tb){
      /* 지금 이 스트리트에 각자 앞에 놓인 칩은 아직 중앙에 온 것이 아니다.
         팟 총액에서 그것을 빼면 "이미 중앙에 모인 금액"이 된다.
         단 판이 끝나면 마지막 스트리트의 베팅까지 전부 중앙으로 모인다 — 그걸 빼두면
         팟은 1,050인데 더미에는 450어치만 쌓인 채로 승자에게 날아간다. */
      var live = 0;
      (tb.seats || []).forEach(function(s){ live += s.bet || 0; });
      var settled = tb.ended ? (tb.pot || 0) : Math.max(0, (tb.pot || 0) - live);
      if (potPile.hand !== tb.handNo) return resetPotPile(tb, settled);
      /* 이미 승자에게 다 보낸 판이면 여기서 끝이다.
         이것이 "정산이 끝났는데 칩이 다시 나타나는" 잔상의 원인이었다. payLayer가
         중앙을 비우고 나면 아래 복원 분기가 "더미가 하나도 없네"로 읽고 tb.pot을
         기준으로 통째로 다시 그렸다 — 서버 pot은 다음 판이 열릴 때까지 그대로라서
         칩과 금액 배지가 1초 뒤에 되살아났다. 상단 Total Pot만 남기는 것이 맞다. */
      if (potClearedHand === tb.handNo) return;
      // 콜되지 않은 초과 베팅을 돌려주면 팟이 줄어든다 — 그때는 연출 없이 다시 그린다
      if (settled < potPile.total) return resetPotPile(tb, settled);
      /* 시그니처에 표시 단위를 함께 넣는다. 층 금액만 보면 칩↔BB 토글이 아무것도
         바꾸지 않은 것으로 보여서 다시 그리지 않았고, 스택과 Total Pot은 BB로 바뀌는데
         팟 더미 배지만 "2,500 P"로 남아 있었다(실측). 단위도 그리기의 입력이다. */
      var sig = pileLayers(tb).join(',') + '/' + unit;
      var delta = settled - potPile.total;
      if (delta > 0) {
        potPile.total = settled;
        var denoms = htDecompose(delta);
        for (var i = 0; i < denoms.length; i++) {
          if (potPile.list.length >= HT_MAX_CHIPS) potPile.list.shift();
          potPile.list.push({ d: denoms[i], i: potPile.n++ % HT_MAX_CHIPS });
        }
        potPile.sig = sig;
        /* 각자 앞의 칩 기둥이 중앙으로 미끄러지는 연출(flyStack)이 620ms다.
           그것이 도착하는 바로 그 순간 더미에 나타나야 "모여서 쌓였다"로 읽힌다 —
           일찍 켜면 칩이 두 벌 보이고, 늦게 켜면 사라졌다가 다시 생긴 것처럼 보인다.

           숨길 대상은 "직전 그림보다 늘어난 칩"이다. 예전에는 DOM 순서로 뒤에서부터
           delta 장수만큼 셌는데, 층이 갈라지는 판에서는 늘어난 칩이 여러 층에 흩어져서
           엉뚱한 칩이 숨겨졌다. 층별 장수를 기억해 두고 층마다 따로 센다.
           칩이 하나도 없던 층은 이름표까지 같이 숨는다(paintPotPile). */
        var before = firstTablePaint ? null : potPile.cnt;
        potPile.cnt = paintPotPile(tb, before);
        if (before) {
          var k = 0;
          pileEl.querySelectorAll('.ht-pchip.pending').forEach(function(el){
            setTimeout(function(){ el.classList.remove('pending'); }, STACK_FLY_MS - 60 + (k++) * 40);
          });
          pileEl.querySelectorAll('.ht-pg.pending').forEach(function(el){
            setTimeout(function(){ el.classList.remove('pending'); }, STACK_FLY_MS - 60);
          });
        }
        return;
      }
      // 층 구성이 바뀌었거나 골격이 다시 그려졌다면 기록대로 복원한다
      if (sig !== potPile.sig || !pileEl.querySelector('.ht-pg')) {
        potPile.sig = sig;
        potPile.cnt = paintPotPile(tb);
      }
    }

    /* ── 좌석 앞 베팅 칩 ────────────────────────────────────────────
       금액을 액면으로 쪼개 실제로 그 조합대로 쌓는다. 예전에는 금액 구간에 따라
       똑같이 생긴 금색 원반을 1~3장 얹었다 — 높이는 대충 맞았지만 색이 하나뿐이라
       "얼마"인지는 옆의 숫자를 읽어야만 알 수 있었다.

       지금은 큰 액면이 아래, 작은 액면이 위로 쌓인다(실제 딜러가 쌓는 순서다).
       그래서 더미의 아래쪽 색만 봐도 자릿수를 알 수 있다 — 검정이 깔려 있으면 만 단위,
       흰 것만 있으면 몇백이다.

       8장에서 끊는다. 그 위로는 높이가 화면 밖으로 자라기만 하고 정보는 늘지 않는다
       (정확한 금액은 바로 옆 숫자가 말한다). */
    var BET_MAX_CHIPS = 12;
    function chipStack(amount){
      var ds = htDecompose(amount).slice(0, BET_MAX_CHIPS);
      /* 좌석 앞 베팅 칩도 중앙 팟과 똑같은 부품(htChipSprite)으로 그린다.
         예전에는 베팅 전용으로 "옆면 띠 + 맨 위 한 장만 윗면"인 다른 부품을 썼다.
         같은 물건인데 테이블 위 두 곳에서 생김새가 달랐고, 팟 칩을 3D로 고칠 때
         이쪽은 따라오지 않아 한 화면에 구형과 신형이 같이 보였다.
         부품이 하나면 그런 어긋남이 생길 자리가 없다. */
      var cols = pileLayout(ds.map(function(d){ return { d: d }; }));
      var out = '';
      cols.forEach(function(c, cx){
        for (var rw = 0; rw < c.n; rw++) out += htChipSprite(c.d, cx, rw, cols.length, false);
      });
      return out;
    }
    /* 태그 안에는 칩 그림을 넣지 않는다. 한때 스택 숫자 앞에 액면 세 종을 겹쳐
       규모를 색으로 보였는데, 아홉 자리에 작은 색점이 스물일곱 개 붙으니 테이블 위에서
       가장 시끄러운 요소가 됐다. 태그는 이름과 숫자만 말한다 —
       칩 그림이 필요한 곳은 실제로 칩이 움직이는 곳(베팅 자리·중앙 팟)이다. */

    /* ── 스택 숫자는 칩이 도착한 뒤에 오른다 ────────────────────────
       서버는 판이 끝나는 순간 상금이 이미 반영된 스택을 보낸다. 그대로 그리면
       쇼다운 카드가 열리기도 전에 숫자가 먼저 올라 결과를 알려 버린다 — 전원 올인이면
       카드 다섯 장이 깔리는 동안 이미 누가 이겼는지 스택에 적혀 있었다.
       그래서 "아직 화면에서 안 받은 상금"을 빼고 그린다. payLayer가 그 층의 칩을
       실제로 날려 보내고 도착할 때 paidSeat에 적고, 그때 숫자가 오른다.
       판이 바뀌면 초기화한다(그 판의 상금은 이미 다 반영된 뒤다). */
`;
