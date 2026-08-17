/* 홀덤 화면 — 역대 전적 표.

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
export const RECORDS = `    var recData = null, recAsked = false;
    /* 어느 갈래를 보고 있나. 두 자리(로비 카드 · 우측 탭)가 같은 값을 쓴다 —
       한쪽에서 바꾸고 다른 쪽으로 갔더니 예전 갈래가 떠 있으면 무엇을 보는지 헷갈린다. */
    var recGenre = 'classic';
    var REC_TABS = [['classic', '홀덤 클래식'], ['bounty', '홀덤 바운티']];
    /* 그 갈래에 기록이 있어야 탭을 붙인다. 한 번도 안 연 종류의 빈 표는 자리만 먹고,
       탭이 하나뿐이면 그건 탭으로 읽히지도 않는다. */
    function recLive(){
      if (!recData) return [];
      return REC_TABS.filter(function(t){ return (recData[t[0]] || []).length > 0; });
    }
    function recRowsNow(){
      if (!recData) return [];
      var live = recLive();
      /* 보고 있던 갈래가 비어 버렸으면(시즌이 바뀌었거나 처음 열었거나) 살아 있는
         첫 갈래로 옮긴다 — 안 그러면 빈 표를 보여주고 탭은 눌리지도 않는다. */
      if (!live.some(function(t){ return t[0] === recGenre; }) && live.length) recGenre = live[0][0];
      return recData[recGenre] || [];
    }
    function recTabsHtml(){
      var live = recLive();
      if (live.length < 2) return '';
      return '<div class="ht-rec-tabs">' + live.map(function(t){
        return '<button type="button" class="ht-rec-tab' + (t[0] === recGenre ? ' on' : '') +
          '" data-recgen="' + t[0] + '">' + t[1] + '<\\/button>';
      }).join('') + '<\\/div>';
    }
    function recHtml(rows){
      if (!rows.length) return '<div class="empty" style="padding:16px 0">아직 끝난 대회가 없습니다</div>';
      /* 줄 세운 기준(누적 상금)을 오른쪽 굵은 자리에 놓는다. 우승·입상·판수는
         작게 아래에 붙인다 — 순위를 만든 값과 참고 값이 섞이지 않게.

         1~3위는 금·은·동 카드로 묶어 낸다. 순위표에서 눈이 실제로 찾는 것은 위 세 자리와
         내 자리다. 스무 줄이 같은 무게로 늘어서면 그 넷을 찾는 데도 스무 줄을 다 읽어야
         한다. 4위 아래는 글자를 줄이고 가라앉혀서, 읽지 않아도 되는 줄이라는 것을
         모양으로 말한다. */
      var PODIUM = ['gold', 'silver', 'bronze'];
      return rows.map(function(r, i){
        var mine = r.userId === MEID;
        var rank = PODIUM[i] || '';
        var sub = (r.wins > 0 ? '👑 ' + r.wins + ' · ' : '') +
          '입상 ' + r.itm + ' / ' + r.played + '판';
        return '<div class="ht-rec-row' + (mine ? ' me' : '') +
            (rank ? ' pod ' + rank : ' low') + '">' +
          '<span class="ht-rec-no">' + (i === 0 ? '👑' : (i + 1)) + '</span>' +
          '<span class="ht-rec-nm">' + esc(r.username) + '</span>' +
          '<span class="ht-rec-p">' + num(r.prize) + 'P</span>' +
          '<span class="ht-rec-s">' + sub + '</span>' +
          '</div>';
      }).join('');
    }
    /* 기록이 하나도 없으면 로비 쪽 블록은 아예 접는다 — 첫 대회 전에는 "아직 없습니다"만
       적힌 빈 카드가 로비 절반을 차지한다. 탭 쪽은 사용자가 직접 눌러서 들어온 것이니
       빈 상태라도 그대로 말해 준다. */
    var recEmpty = true;
    function paintRecords(){
      if (!recData) return;
      /* 두 갈래가 다 비었을 때만 "기록 없음"이다 — 클래식만 열린 시즌에 로비 카드가
         통째로 접히면 그동안의 대회 기록을 볼 자리가 사라진다. */
      recEmpty = recLive().length === 0;
      // 다음 폴링(1초)까지 기다리지 않고 여기서 바로 접거나 펼친다
      if (lobbyRecEl) lobbyRecEl.hidden = recEmpty || !tableEl.hidden;
      var html = recTabsHtml() + recHtml(recRowsNow());
      ['htRecList', 'htLobbyRecList'].forEach(function(id){
        var el = document.getElementById(id);
        if (el) el.innerHTML = html;
      });
    }
    function loadRecords(force){
      if (recData && !force) { paintRecords(); return; }
      recAsked = true;
      fetch('/api/games/holdem/records')
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (!d || !d.ok) return;
          recData = { classic: d.classic || [], bounty: d.bounty || [] };
          paintRecords();
        })
        .catch(function(){ /* 실패하면 다음에 탭을 다시 누를 때 받는다 */ });
    }
    /* 갈래 탭. 표 안쪽에 그려지므로 위임으로 받는다 — 표를 다시 그릴 때마다 버튼이
       새로 생기고, 그때마다 리스너를 붙이면 두 벌 세 벌로 쌓인다. */
    document.addEventListener('click', function(e){
      var b = e.target.closest ? e.target.closest('.ht-rec-tab') : null;
      if (!b) return;
      var g = b.getAttribute('data-recgen');
      if (!g || g === recGenre) return;
      recGenre = g;
      paintRecords();          // 두 자리를 함께 다시 그린다
    });
    document.querySelector('.ht-tabs').addEventListener('click', function(e){
      var b = e.target.closest ? e.target.closest('.ht-tab') : null;
      if (!b) return;
      var which = b.getAttribute('data-htab');
      document.querySelectorAll('.ht-tab').forEach(function(t){
        t.classList.toggle('active', t === b);
      });
      rankEl.hidden = which !== 'live';
      prizeTabEl.hidden = which !== 'prize';
      recEl.hidden = which !== 'rec';
      if (which === 'rec') loadRecords(false);
      if (which === 'prize') renderPrizeTab();
    });
`;
