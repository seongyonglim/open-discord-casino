/* 홀덤 화면 — 역대 전적 표.

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
export const RECORDS = `    var recRows = null, recAsked = false;
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
      if (!recRows) return;
      recEmpty = recRows.length === 0;
      // 다음 폴링(1초)까지 기다리지 않고 여기서 바로 접거나 펼친다
      if (lobbyRecEl) lobbyRecEl.hidden = recEmpty || !tableEl.hidden;
      var html = recHtml(recRows);
      ['htRecList', 'htLobbyRecList'].forEach(function(id){
        var el = document.getElementById(id);
        if (el) el.innerHTML = html;
      });
    }
    function loadRecords(force){
      if (recRows && !force) { paintRecords(); return; }
      recAsked = true;
      fetch('/api/games/holdem/records')
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (!d || !d.ok) return;
          recRows = d.rows;
          paintRecords();
        })
        .catch(function(){ /* 실패하면 다음에 탭을 다시 누를 때 받는다 */ });
    }
    document.querySelector('.ht-tabs').addEventListener('click', function(e){
      var b = e.target.closest ? e.target.closest('.ht-tab') : null;
      if (!b) return;
      var which = b.getAttribute('data-htab');
      document.querySelectorAll('.ht-tab').forEach(function(t){
        t.classList.toggle('active', t === b);
      });
      rankEl.hidden = which !== 'live';
      recEl.hidden = which !== 'rec';
      if (which === 'rec') loadRecords(false);
    });
`;
