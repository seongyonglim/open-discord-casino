/* 홀덤 화면 — 컨트롤 DOM 핸들과 서식 유틸 (금액·시간·아바타·카드).

   이 파일은 브라우저로 나가는 인라인 스크립트의 한 조각이다. 실행되는 코드가 아니라
   문자열이고, holdem.ts 가 조각들을 원래 순서로 이어 붙여 하나의 <script> 로 만든다.
   조각으로 나눈 이유는 3,000줄짜리 한 덩어리를 읽을 수 없었기 때문이고, 순서를 바꾸지
   않는 이유는 산출물이 한 글자도 달라지지 않아야 하기 때문이다(scripts/golden.ts 가
   바이트로 확인한다).

   조각들은 하나의 클로저를 공유한다 — 여기 있는 var·function 은 다른 조각에서도 보인다.
   그래서 파일이 나뉘어 있어도 스코프는 하나다. import 로 주고받는 것이 아니다. */
export const FORMAT = `    var ctrlEl = document.getElementById('htControls');
    var ctopEl = document.getElementById('htCtop');
    var preEl = document.getElementById('htPre');
    var ACT_BTNS = ['htFold', 'htCheck', 'htCall', 'htRaise'].map(function(id){
      return document.getElementById(id);
    });
    var rangeEl = document.getElementById('htRange');
    var amountEl = document.getElementById('htAmount');
    var unitTag = document.getElementById('htUnitTag');
    var backBtn = document.getElementById('htBack');
    var backAct = document.getElementById('htBack3');
    var clothEl = document.getElementById('htCloth');
    var infoEl = document.getElementById('htInfo');
    var rankEl = document.getElementById('htRank');
    var prizeTabEl = document.getElementById('htPrizeTab');
    var recEl = document.getElementById('htRec');
    var sideTitle = document.getElementById('htSideTitle');

    function esc(s){ return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function num(n){ return Number(n||0).toLocaleString('ko-KR'); }
    /* 두 가지 시간 표기를 쓴다.
       mmss는 '똑딱거리는 시계'용이다 — 다음 블라인드(04:32)처럼 1시간 안쪽의 카운트다운.
       dur은 사람이 읽는 길이용이다. 내일 21:00까지 남은 시간을 mmss로 찍으면
       '1253:42'가 되어 무슨 뜻인지 알 수 없다. */
    function mmss(sec){
      if (sec == null) return '--:--';
      var s = Math.max(0, Math.floor(sec));
      return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
    }
    function dur(sec){
      if (sec == null) return '-';
      var s = Math.max(0, Math.floor(sec));
      var d = Math.floor(s/86400); s -= d*86400;
      var h = Math.floor(s/3600); s -= h*3600;
      var m = Math.floor(s/60), ss = s - m*60;
      if (d) return d + '일 ' + h + '시간';
      if (h) return h + '시간 ' + m + '분';
      if (m) return m + '분 ' + ss + '초';
      return ss + '초';
    }
    /* KST 시계 표기. 대회 시각이 21:00/22:00 로 고정돼 있던 동안에는 문구에 그대로
       적어 뒀는데, 운영자가 시각을 정하게 되면서 그 문장이 거짓이 됐다. 서버가 준
       실제 시각에서 뽑아 쓴다 — 브라우저의 시간대와 무관하게 KST 로 읽는다. */
    function kstClock(sec){
      if (sec == null) return '--:--';
      return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul',
        hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(sec * 1000));
    }
    function kstDay(sec){
      if (sec == null) return '';
      return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul',
        month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(sec * 1000));
    }
    /* 스택 표기 — 칩 또는 BB. 숏스택일 때 3.4BB처럼 소수 한 자리가 의미 있다. */
    function stackText(chips){
      if (unit === 'chip' || !st || !st.table) return num(chips);
      var bb = (st.table.level && st.table.level.bb) || 1;
      var v = chips / bb;
      return (v >= 10 ? Math.floor(v) : Math.floor(v * 10) / 10) + 'BB';
    }
    /* 바운티 표기 — 칩/BB 토글과 무관하게 언제나 절대 포인트다.
       스택은 대회용 가짜 칩이라 BB 로 환산하는 것이 읽기에 낫지만, 바운티는 대회가 끝나면
       그대로 계좌에 들어오는 진짜 포인트다. 여기에 BB 를 씌우면 두 가지가 동시에 깨진다:
        · 뜻이 깨진다 — 10,000P 짜리 봉투가 블라인드가 오를 때마다 다른 숫자로 보인다.
        · 글자가 깨진다 — 붙이는 쪽에서 'P' 를 덧붙이므로 "12.5BBP" 가 그대로 찍힌다
          (실제로 BB 표기를 켜 둔 사람 화면에 그렇게 나왔다).
       그래서 바운티를 그리는 자리는 stackText 가 아니라 이 함수를 쓴다. */
    function pointText(p){ return num(p) + 'P'; }
    /* avatar 는 이미 완성된 이미지 주소다 — 해시가 아니다.
       users.avatar 에는 로그인할 때(web/auth.ts) CDN 주소를 통째로 만들어 넣는다.
       여기서 그 값을 해시로 보고 주소를 한 번 더 조립하고 있었다:

         https://cdn.discordapp.com/avatars/{id}/https://cdn.discordapp.com/avatars/{id}/{hash}.png?size=64.png?size=64

       두 번 감싼 주소라 언제나 404였고, 화면에는 깨진 이미지 아이콘이 남았다.
       헤더 프로필(views.ts)은 저장값을 그대로 src 에 넣어서 멀쩡했다 —
       그래서 "홀덤에서만 프로필이 안 나온다"로 보였다.

       onerror 폴백을 함께 둔다. 아바타를 바꾸면 예전 해시로 만든 주소는 404가 되는데,
       그때 깨진 아이콘 대신 이니셜이 나와야 한다. 한 번만 갈아끼우고 스스로 해제한다
       (폴백 이미지가 또 실패하면 무한 루프가 된다). */
    function avatarHtml(userId, avatar, username, cls){
      var ini = esc((username || '?').slice(0, 1));
      var ph = '<span class="' + cls + ' ph">' + ini + '<\/span>';
      if (!avatar) return ph;
      /* referrerpolicy="no-referrer" — 다른 화면(views.ts·바카라·블랙잭·포커)이 이미
         쓰는 것과 맞춘다. 리퍼러를 보내면 CDN이 우리 주소를 알게 되고, 일부 환경에서는
         그것 때문에 이미지가 거부된다. */
      return '<img class="' + cls + '" src="' + esc(avatar) + '" alt="" referrerpolicy="no-referrer"' +
        ' onerror="this.onerror=null;this.outerHTML=' + esc(JSON.stringify(ph)) + '">';
    }
    function cardImg(code, cls){
      var k = 'pcard' + (cls ? ' ' + cls : '');
      if (!code) return '<img class="' + k + ' back" src="/cards/back-red.svg?v=' + CARD_V + '" alt="">';
      return '<img class="' + k + '" src="/cards/' + code + '.svg?v=' + CARD_V + '" alt="' + code + '">';
    }

    /* ── 로비 ─────────────────────────────────────────────────────── */
`;
