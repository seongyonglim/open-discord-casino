/* 인게임 껍데기 — 폰을 눕히고 게임에 들어가면 웹 껍데기를 벗고 화면을 판에 내준다.
 *
 * ── 왜 별도 파일인가
 * 이 파일을 안 실으면 정확히 예전으로 돌아간다. 서버가 내보내는 HTML 은 여전히 그대로고
 * (골든 비교가 페이지 10개 바이트 동일을 증명한다), 여기서 하는 일은 이미 있는 요소를
 * 다른 자리에 옮겨 담는 것뿐이다. TICK=off · SW=off 와 같은 성질의 되돌리기 장치다.
 *
 * ── 왜 서버 HTML 을 안 바꾸는가
 * 데스크톱 화면은 만족스럽다는 판단이라 한 픽셀도 안 건드리기로 했다. 그런데 상단바에
 * 필요한 것이 이미 화면에 전부 있다 — 로비 링크, 게임 이름, 잔액, 음량, 규칙 버튼.
 * 새로 만들 필요 없이 자리만 옮기면 된다.
 *
 * ── 옮기는 것과 새로 만드는 것
 * 옮긴다: 로비 탭(a.tab[href="/"]) · 잔액 상자(.profwrap) · 음량(.volwrap) · 규칙(?)
 *   같은 노드를 그대로 옮기므로 거기 걸린 동작(프로필 메뉴, 음량 슬라이더)이 살아 있다.
 * 새로 만든다: 게임 이름(글자만 복사) · 채팅 단추
 *   게임 전환 칩은 접었다 펴는 동작이 .game-switch 에 위임돼 있어 빼내면 끊긴다.
 *   채팅은 app.js 가 window.casinoChat.open() 을 열어 두었으므로 단추만 만들면 된다.
 */
/* ── 게임마다 다른 방향 ────────────────────────────────────────────────
   판 모양이 게임마다 다르다. 사다리는 위에서 아래로 떨어지는 세로형이고 지뢰찾기는
   정사각이라 세로 화면이 맞다. 홀덤·바카라·블랙잭·포커·그래프는 판이 옆으로 넓어
   가로가 맞다. 그래서 한 방향으로 통일하지 않고 게임마다 나눈다.

   ── 잠금은 되면 좋고, 안 되면 그만이다
   screen.orientation.lock() 은 설치된 앱(standalone)이나 전체화면에서만 동작한다.
   그냥 브라우저 탭에서는 NotSupportedError 로 거부되고, iOS 사파리는 아예 없다.
   그러니 잠금에 기대면 안 된다 — 잠금이 실패해도 사용자가 폰을 돌리면 그 방향이
   그대로 보인다. 그래서 두 방향 다 제대로 나와야 한다.

     사다리·지뢰찾기 : 세로가 주력, 가로는 폴백
     나머지 다섯     : 가로가 주력

   여기서는 "지금 인게임 껍데기를 쓸 상황인가" 하나만 정한다. 다섯 개 IIFE 가
   각자 판단하면 조건이 어긋나서 반쪽만 켜지는 상태가 생긴다. */
window.__IG = (function(){
  var LAND = '(max-width:1024px) and (max-height:560px) and (orientation:landscape)';
  var PORT = '(max-width:560px) and (orientation:portrait)';
  /* 세로가 맞는 게임 — 방향 잠금은 여기 적힌 대로 건다 */
  var PORTRAIT_GAMES = ['ladder', 'mines'];
  function key(){
    var m = location.pathname.match(/^\/games\/([a-z]+)\/?$/);
    return m ? m[1] : null;
  }
  function land(){ return window.matchMedia(LAND).matches; }
  /* 세로에서는 «모든» 게임이 상단바를 받는다.
     예전에는 여기서 "세로 배치를 지어 둔 게임"(사다리·지뢰) 만 통과시켰다. 그때는
     상단바와 본문 재배치가 한 조건에 묶여 있어서, 상단바를 주면 본문까지 감춰졌기
     때문이다 — 그릴 격자가 없는 게임은 화면이 통째로 사라졌다.
     지금은 본문 재배치가 ig-grid 로 따로 갈라져 있다(CSS 18-ig-portrait.css).
     그래서 겉은 일곱 게임이 같이 쓰고, 속은 격자를 지어 둔 게임만 바뀐다. */
  function port(){ return window.matchMedia(PORT).matches && !!key(); }
  /* 껍데기를 쓸 상황인가 — 게임 페이지이고, 그 게임에 맞는 방향/크기인가 */
  function on(){ return !!key() && (land() || port()); }

  /* 지금 화면이 어느 게임의 판인가 — 주소가 아니라 실제로 그려진 판을 보고 가린다.
     주소는 /games/graph 인데 판은 크래시 그래프이듯, 이름과 판 모양이 늘 같지는
     않기 때문이다.

     여기(정책)에 두는 이유: 이 값을 쓰는 곳이 두 군데인데 서로 다른 IIFE 다.
     한쪽에만 두었더니 다른 쪽에서 부를 때 ReferenceError 가 났고, 그 예외가
     그 뒤의 일을 통째로 삼켰다 — 사다리의 라이브 띠가 사라지고 쓸어내려 닫기가
     안 붙었다. 한 벌만 두고 둘 다 여기서 읽는다. */
  function kind(){
    var s = document.querySelector('.game-shell');
    if (!s) return null;
    if (s.classList.contains('ht-shell')) return 'holdem';
    if (s.classList.contains('mines-shell')) return 'mines';
    if (s.classList.contains('poker-shell')) return 'poker';
    if (s.querySelector('.bacc-table')) return 'baccarat';
    if (s.querySelector('.bj-table')) return 'blackjack';
    if (s.querySelector('.crash-graph')) return 'graph';
    return 'ladder';
  }

  function subscribe(fn){
    [LAND, PORT].forEach(function(q){
      var m = window.matchMedia(q);
      if (m.addEventListener) m.addEventListener('change', fn);
      else if (m.addListener) m.addListener(fn);
    });
    window.addEventListener('orientationchange', fn);
    window.addEventListener('resize', fn);
  }

  /* 방향 잠금. 실패는 정상이므로 조용히 넘긴다 — 콘솔에 빨간 줄이 남으면
     진짜 오류를 찾을 때 방해가 된다. */
  function lock(){
    var so = window.screen && window.screen.orientation;
    if (!so) return;
    var k = key();
    try {
      if (!k) { so.unlock && so.unlock(); return; }
      var want = PORTRAIT_GAMES.indexOf(k) >= 0 ? 'portrait-primary' : 'landscape-primary';
      var p = so.lock(want);
      if (p && p.catch) p.catch(function(){});
    } catch (e) { /* 지원하지 않는 기기 — 사용자가 돌리는 대로 보여 준다 */ }
  }

  /* 아이콘은 app.js 가 한 벌만 정의한다(window.__ICON) — /app.js 는 app.js + ingame.js
     를 이어 붙인 것이라 app.js 가 먼저 돈다. 여기서 또 만들면 두 벌이 되어 언젠가 어긋난다. */
  var ICON = window.__ICON;

  return { key: key, kind: kind, land: land, port: port, on: on, subscribe: subscribe, lock: lock,
           ICON: ICON };
})();

/* ── 사다리 남은 시간 ─────────────────────────────────────────────────
   이 하나만은 방향을 안 가린다. 세로에서 만든 모양이 마음에 든다는 판단이라
   가로와 데스크톱에도 같은 것을 쓴다 — 남은 시간은 어느 화면에서나 같은 뜻이다.

   ── 원본을 고쳐 쓰지 않는 이유
   사다리 코드는 #lCountdown 의 textContent 를 폴링마다 다시 쓴다. 거기에 우리가
   span 을 심으면 다음 폴링에 지워지고, 매초 다시 심는 싸움이 된다. 그래서 원본은
   감춰 두고 그 글자를 읽어서 우리 것을 그린다. 값의 출처는 하나로 남는다.

   서버 HTML 은 그대로다 — 여기서 만들어 붙일 뿐이라 골든 비교는 영향받지 않는다.

   원본이 쓰는 문장은 다섯 가지다:
     '베팅 마감까지 N초' · '결과 공개 중…' · '다음 라운드까지 N초'
     '일시정지 (화면을 클릭하면 재개)' · '서버에 연결하는 중…' */
(function(){
  var IG = window.__IG;

  function src(){ return document.getElementById('lCountdown'); }

  function build(){
    var s = src();
    if (!s || document.querySelector('.ig-timer')) return;
    /* 원본은 지우지 않는다 — 사다리 코드가 계속 글자를 쓰는 노드다. 감추기만 한다. */
    s.style.display = 'none';
    var t = document.createElement('div');
    t.className = 'ig-timer';
    t.innerHTML = '<span class="ig-t-ico"></span><span class="ig-t-txt"></span>'
      + '<span class="ig-t-num"></span>';
    s.parentNode.insertBefore(t, s.nextSibling);
    sync();
  }

  function sync(){
    var t = document.querySelector('.ig-timer');
    if (!t) return;
    var s = src();
    var v = s ? String(s.textContent).trim() : '';
    var ico = t.querySelector('.ig-t-ico'), txt = t.querySelector('.ig-t-txt'),
        num = t.querySelector('.ig-t-num');
    var m, sec = null, label = v;
    if ((m = v.match(/^베팅 마감까지 (\d+)초$/))) { label = '베팅 마감'; sec = +m[1]; }
    else if ((m = v.match(/^다음 라운드까지 (\d+)초$/))) { label = '다음 라운드'; sec = +m[1]; }
    else if (/결과 공개/.test(v)) { label = '사다리 진행 중…'; }
    else if (/일시정지/.test(v)) { label = '일시정지 — 화면을 누르면 재개'; }
    else if (!v) { label = ''; }
    if (!ico.firstChild) ico.innerHTML = IG.ICON.clock;
    if (txt.textContent !== label) txt.textContent = label;
    /* 두 자리로 고정한다 — 9→10 에서 글자가 밀리면 눈이 그 움직임을 따라간다 */
    var ns = sec === null ? '' : (sec < 10 ? '0' + sec : String(sec)) + '초';
    if (num.textContent !== ns) num.textContent = ns;
    t.classList.toggle('ig-t-hot', sec !== null && sec <= 3);
    t.style.display = (label || ns) ? '' : 'none';
  }

  function start(){
    build();
    /* 원본이 1초마다 바뀌므로 그보다 촘촘히 본다 — 1초로 맞추면 최대 1초를 늦게
       따라가서 남은 시간이 한 박자씩 밀려 보인다. */
    setInterval(function(){ build(); sync(); }, 250);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

(function(){
  var IG = window.__IG;
  var root = document.documentElement;
  var bar = null;
  var home = {};        // 원래 자리 — 껍데기를 벗을 때 그대로 돌려놓는다

  function isGame(){ return /^\/games\//.test(location.pathname); }

  /* 옮기기 전에 원래 자리를 적어 둔다. 부모와 바로 뒤 형제를 기억하면 그 사이에
     다시 끼워 넣을 수 있다 — 마지막 자식이었으면 뒤 형제가 null 이고 append 가 된다. */
  function take(el, key){
    if (!el) return null;
    if (!home[key]) home[key] = { parent: el.parentNode, next: el.nextSibling };
    return el;
  }
  /* 기억해 둔 "바로 뒤 형제" 가 그새 지워졌으면 그 앞에 못 넣는다 — insertBefore 가
     NotFoundError 를 던지고 남은 되돌리기가 통째로 멈춘다. 아직 그 부모의 자식일
     때만 그 앞에 넣고, 아니면 끝에 붙인다. */
  function giveBack(el, key){
    var h = home[key];
    if (!el || !h || !h.parent || !h.parent.isConnected) return;
    h.parent.insertBefore(el, (h.next && h.next.parentNode === h.parent) ? h.next : null);
  }

  /* ── 게임 전환 팝오버 ────────────────────────────────────────────────
     목록은 지어내지 않는다. 페이지에 이미 있는 게임 전환 바(.game-switch)의 칩을
     그대로 읽는다 — 이름·아이콘·주소가 거기 다 있고, 게임이 늘어도 따라온다.
     로비는 그 바에 없으므로 맨 위에 한 줄 더 붙인다(가로에서는 하단 탭바를 걷기
     때문에 여기가 유일한 나가는 길이다). */
  function gamesPop(){
    var p = document.querySelector('.ig-games');
    if (p) return p;
    p = document.createElement('div');
    p.className = 'ig-games';

    var here = location.pathname;
    var add = function(href, label, iconHtml, on){
      var a = document.createElement('a');
      a.className = 'ig-g' + (on ? ' on' : '');
      a.href = href;
      if (iconHtml) { var i = document.createElement('span'); i.className = 'ig-g-ic'; i.innerHTML = iconHtml; a.appendChild(i); }
      var s = document.createElement('span'); s.className = 'ig-g-t'; s.textContent = label;
      a.appendChild(s);
      p.appendChild(a);
    };

    add('/', '로비', IG.ICON.home || '', here === '/');
    [].forEach.call(document.querySelectorAll('.game-switch .gs-pill'), function(pill){
      var ic = pill.querySelector('.gs-ic');
      /* 칩의 글자에서 아이콘 부분을 뺀 나머지가 게임 이름이다. textContent 를 그대로
         쓰면 아이콘이 글자가 아니므로 이름만 남는다. */
      add(pill.getAttribute('href'), pill.textContent.trim(),
        ic ? ic.innerHTML : '', pill.classList.contains('active'));
    });
    document.body.appendChild(p);
    return p;
  }
  function closeGames(){
    var p = document.querySelector('.ig-games');
    var b = document.querySelector('.ig-gamesel');
    if (b) b.setAttribute('aria-expanded', 'false');
    if (!p || !p.classList.contains('on')) return;
    /* 되감기가 끝난 뒤에 .on 을 뗀다 — 먼저 떼면 display:none 이라 그릴 것이 없다.
       도중에 다시 열렸으면 그대로 둔다(빠르게 두 번 누르는 경우). */
    window.__foldOut(p, function(){
      if (b && b.getAttribute('aria-expanded') !== 'true') p.classList.remove('on');
    });
  }

  function build(mode){
    if (bar) return;
    bar = document.createElement('div');
    bar.className = 'ig-bar';

    var prof  = take(document.querySelector('.profwrap'), 'prof');
    var vol   = take(document.querySelector('.volwrap'), 'vol');
    var help  = take(document.querySelector('.game-switch .gs-help'), 'help');
    /* 알림 종은 잔액 상자(.profwrap) 안에 들어 있다. 통째로 옮기면 안 읽은 표시와
       목록 여닫는 동작이 그대로 따라온다 — 우리가 다시 만들 것이 없다. */
    var bel   = take(document.querySelector('.profwrap .belwrap'), 'bel');

    /* ── 왼쪽: 지금 어느 게임인가 · 규칙 ─────────────────────────────
       게임 이름이 글자였을 때는 "여기가 어디인지" 만 말하고 끝이었다. 다른 게임으로
       가려면 로비를 거쳐야 했는데, 폰에서 그건 두 번 나갔다 들어오는 길이다.
       이름 자체를 눌러 바꾸게 한다 — 이미 화면에서 가장 눈에 띄는 글자이고,
       "지금 여기" 와 "다른 데로" 는 원래 같은 자리에 있는 것이 자연스럽다. */
    var left = document.createElement('div');
    left.className = 'ig-left';

    var active = document.querySelector('.game-switch .gs-pill.active');
    var sel = document.createElement('button');
    sel.type = 'button';
    sel.className = 'ig-btn ig-gamesel';
    sel.setAttribute('aria-haspopup', 'true');
    sel.setAttribute('aria-expanded', 'false');
    var nm = document.createElement('span');
    nm.className = 'ig-name';
    nm.textContent = active ? active.textContent.trim() : '';
    sel.appendChild(nm);
    var car = document.createElement('span');
    car.className = 'ig-caret';
    car.setAttribute('aria-hidden', 'true');
    sel.appendChild(car);
    sel.addEventListener('click', function(e){
      e.stopPropagation();
      var p = gamesPop();
      /* 닫는 일은 closeGames() 한 곳이 맡는다. 예전에는 여기서 .on 을 먼저 토글해
         떼어 버리고 closeGames() 를 불렀는데, 그 함수는 "이미 닫혀 있으면 되감을 것도
         없다"고 판단해 그대로 돌아갔다 — 접히는 움직임이 영영 안 돌았다. */
      if (p.classList.contains('on')) { closeGames(); return; }
      p.classList.remove('folding');        // 접히다 만 것이 남아 있으면 걷는다
      p.classList.add('on');
      sel.setAttribute('aria-expanded', 'true');
    });
    left.appendChild(sel);
    if (help) { help.classList.add('ig-help'); left.appendChild(help); }
    bar.appendChild(left);

    /* ── 오른쪽: 아이콘 둘 · 잔액 ───────────────────────────────────
       글자 없는 아이콘만 둔다. 라벨을 붙이면 360px 에서 줄이 넘친다.
       잔액은 맨 끝에 못 박는다 — 자릿수가 자라는 유일한 값이라 끝에 있어야 다른
       것을 밀지 않는다(가운데 두었을 때 실제로 아이콘을 밀어냈다). */
    var right = document.createElement('div');
    right.className = 'ig-right';

    var chat = document.createElement('button');
    chat.type = 'button';
    chat.className = 'ig-btn ig-chat';
    chat.setAttribute('aria-label', '채팅');
    chat.innerHTML = IG.ICON.chat;
    /* 떠 있는 한 줄 채팅을 켜고 끈다. 채팅창은 그 줄을 눌러서 연다.
       한때 가로에서만 «채팅창 열기» 로 갈라 두었다 — 그 화면은 줄을 통째로 감추고
       있어서 켤 대상이 없었기 때문이다. 이제 가로에도 줄이 떠 있으므로 갈릴 이유가
       없다. 같은 단추가 화면에 따라 다른 일을 하지 않는 편이 낫다. */
    chat.addEventListener('click', function(){
      var C = window.casinoChat;
      if (C && C.toggleBar) C.toggleBar();
    });
    right.appendChild(chat);

    if (bel) { bel.classList.add('ig-bel'); right.appendChild(bel); }
    if (vol) { vol.classList.add('ig-vol'); right.appendChild(vol); }
    if (prof) right.appendChild(prof);
    bar.appendChild(right);

    document.body.appendChild(bar);
  }

  function tearDown(){
    if (!bar) return;
    closeGames();
    var p = document.querySelector('.ig-games'); if (p) p.remove();
    giveBack(document.querySelector('.ig-back'), 'lobby');
    giveBack(document.querySelector('.ig-bar .profwrap'), 'prof');
    giveBack(document.querySelector('.ig-bel'), 'bel');
    giveBack(document.querySelector('.ig-vol'), 'vol');
    giveBack(document.querySelector('.ig-help'), 'help');
    var back = document.querySelector('.ig-back');
    if (back) back.classList.remove('ig-back');
    var bel = document.querySelector('.ig-bel');
    if (bel) bel.classList.remove('ig-bel');
    var vol = document.querySelector('.ig-vol');
    if (vol) vol.classList.remove('ig-vol');
    var help = document.querySelector('.ig-help');
    if (help) help.classList.remove('ig-help');
    bar.parentNode && bar.parentNode.removeChild(bar);
    bar = null;
  }

  /* 팝오버 바깥을 누르면 닫는다. 가림막을 따로 두지 않는 이유는 상단바 바로 아래에
     붙는 작은 목록이라 화면을 덮을 일이 없고, 가림막을 쓰면 서랍·설정 시트와 같은
     노드를 놓고 서로 내리기를 다투기 때문이다(그 셋이 각각 다른 IIFE 에 있다). */
  document.addEventListener('click', function(e){
    var p = document.querySelector('.ig-games');
    if (!p || !p.classList.contains('on')) return;
    if (e.target.closest && (e.target.closest('.ig-games') || e.target.closest('.ig-gamesel'))) return;
    closeGames();
  });
  window.addEventListener('orientationchange', closeGames);

  var mode = null;
  function apply(){
    if (!IG.on()) {
      root.classList.remove('ingame', 'ig-port', 'ig-land');
      tearDown();
      mode = null;
      return;
    }
    var m = IG.port() ? 'port' : 'land';
    /* 방향이 바뀌면 상단바를 다시 짓는다 — 뒤로가기를 가로는 꺼내 쓰고 세로는
       새로 만들기 때문에, 그대로 두면 세로에서 하단 탭바의 [로비] 칸이 빈 채로 남는다 */
    if (mode && mode !== m) tearDown();
    mode = m;
    build(m);
    root.classList.add('ingame');
    /* 세로 전용 게임인지 여기서 표시한다 — CSS 가 두 방향을 갈라 쓴다 */
    root.classList.toggle('ig-port', m === 'port');
    root.classList.toggle('ig-land', m === 'land');
  }

  function start(){
    IG.lock();
    apply();
    IG.subscribe(apply);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

/* MAX 단추는 여기 있었다. 지금은 마크업(data-max)과 app.js 의 casinoBet 이 맡는다 —
   여기서 폰에서만 만들어 붙이던 탓에 PC 에는 없었고, 같은 조작부가 화면 크기에 따라
   다른 단추를 갖고 있었다. 잔액을 읽는 규칙도 그쪽에 하나로 모았다. */
/* ── 인게임 전용 격자 ─────────────────────────────────────────────────
   여기까지는 데스크톱 레이아웃 위에 규칙을 덮어써 왔다. 16-ingame.css 가 809줄 ·
   341개 규칙이 됐고, 하나를 고치면 다른 하나가 어긋나는 일이 반복됐다 —
   칩 줄을 걷으니 인풋이 폭 0 이 되고, 인풋을 살리니 MAX 가 옆 칸을 덮는 식이었다.
   덮어쓰기가 쌓이면 서로 간섭하는 것이 당연하다.

   그래서 이 화면만은 구조를 새로 짠다. 서버 HTML 은 여전히 그대로다 —
   여기서 격자를 만들고 이미 있는 칸(판·조작부·참가자)을 그 안에 옮겨 담을 뿐이다.
   세로로 돌리면 원래 자리로 되돌린다.

     ig-body(격자 12칸)
       ig-cell ig-board  판
       ig-cell ig-bet    조작부
       ig-cell ig-side   참가인원·랭킹

   칸 수는 게임마다 다르다 — 사다리는 세로로 긴 판이라 5:4:3, 지뢰찾기는 정사각
   격자라 6:6(참가자 없음), 나머지는 판이 넓어야 해서 판이 아래를 쓴다. */
(function(){
  var IG = window.__IG;
  var body = null;
  var home = [];      // [노드, 원래 부모, 원래 다음 형제]

  /* 판단은 __IG 한 곳에 있다 — 여기서 또 만들면 두 벌이 되어 언젠가 어긋난다 */
  function shellKind(){ return IG.kind(); }

  function take(node, cell){
    if (!node) return;
    home.push([node, node.parentNode, node.nextSibling]);
    cell.appendChild(node);
  }

  function build(){
    if (body) return;
    var main = document.querySelector('.game-main');
    var shell = document.querySelector('.game-shell');
    if (!main || !shell) return;
    var kind = shellKind();

    var board = main.firstElementChild;
    var bet = main.lastElementChild !== board ? main.lastElementChild : null;
    var side = document.querySelector('.game-side');

    body = document.createElement('div');
    body.className = 'ig-body ig-' + kind;

    var cBoard = document.createElement('div'); cBoard.className = 'ig-cell ig-board';
    var cBet = document.createElement('div'); cBet.className = 'ig-cell ig-bet';
    var cSide = document.createElement('div'); cSide.className = 'ig-cell ig-side';
    body.appendChild(cBoard); body.appendChild(cBet); body.appendChild(cSide);

    take(board, cBoard);
    take(bet, cBet);
    take(side, cSide);

    home.push([body, null, null]);       // 정리할 때 지울 것
    (document.querySelector('main') || document.body).appendChild(body);
    document.documentElement.classList.add('ig-grid');
  }

  function tearDown(){
    if (!body) return;
    /* 넣은 역순으로 되돌린다 — 앞의 것을 먼저 되돌리면 다음 형제가 이미 옮겨져 있다 */
    for (var i = home.length - 1; i >= 0; i--) {
      var n = home[i][0], p = home[i][1], nx = home[i][2];
      if (!p) { n.parentNode && n.parentNode.removeChild(n); continue; }
      p.insertBefore(n, nx);
    }
    home = [];
    body = null;
    document.documentElement.classList.remove('ig-grid');
  }

  /* 한 게임씩 옮긴다. 여기 적힌 게임만 격자를 쓰고, 나머지는 예전 배치를 그대로 쓴다 —
     일곱 개를 한꺼번에 바꾸면 어디가 왜 깨졌는지 가릴 수 없다. 하나를 끝내고 확인한
     뒤에 다음을 더한다.

     방향까지 함께 적는다. 격자를 쓴다는 것은 그 방향에 맞는 배치 규칙이 CSS 에
     있다는 뜻인데, 그 규칙은 방향마다 따로 쓰기 때문이다 — 지뢰찾기는 세로 배치만
     지어 두었고, 가로에서 격자를 켜면 세 칸이 폭을 균등하게 나눠 판이 68px 로
     찌그러졌다(점검이 잡았다). 가로 지뢰찾기는 어차피 방향 잠금 대상이라 예전
     배치로 두는 것이 맞다. */
  var MOVED = { ladder: 'both', mines: 'port' };

  function apply(){
    var want = MOVED[shellKind()];
    var fits = want === 'both' || (want === 'port' && IG.port()) || (want === 'land' && IG.land());
    if (IG.on() && fits) build(); else tearDown();
  }

  function start(){
    apply();
    IG.subscribe(apply);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

/* ── 인게임 격자의 마무리: 타이머를 헤더로, 참가인원을 서랍으로 ──────────
   타이머는 판 위에 떠 있었다. 판을 가리지 않으려고 절대 위치로 띄웠는데, 그러면
   사다리 그림과 겹치는 자리를 계속 피해 다녀야 한다. 헤더에는 그 자리가 이미 있다 —
   회차와 남은 시간은 "지금 무슨 판인가" 라서 게임 이름 옆이 제자리다.

   참가인원·랭킹은 세 번째 칸을 통째로 쓰고 있었다. 폰을 두 손으로 잡으면 조작부가
   화면 한가운데로 밀려 엄지가 안 닿는다 — 칸이 셋이면 가운데가 조작부다. 그래서
   참가인원은 상단바 👥 로 여는 서랍으로 빼고, 화면은 판(왼쪽) · 조작부(오른쪽) 둘로
   나눈다. 조작부가 오른쪽 끝에 붙어야 오른손 엄지가 닿는다. */
(function(){
  var IG = window.__IG;

  function movedGrid(){ return document.querySelector('.ig-body'); }

  /* 타이머를 상단바로 옮긴다. 원래 자리를 적어 두고 세로로 돌리면 되돌린다.

     옮긴 노드를 클래스로 다시 찾으면 안 된다. 세로로 돌아올 때 IIFE 는 등록 순서대로
     도는데, 맨 위 상단바 IIFE 가 먼저 .ig-bar 를 통째로 removeChild 한다 — 그 안에
     들어가 있던 시계까지 같이 떨어져 나간다. 그 다음에 여기가 querySelector 로 찾으면
     이미 문서에 없어서 null 이고, 그대로 return 해서 시계가 영영 안 돌아왔다.
     (사다리 카운트다운이 가로 한 번 갔다 오면 사라지던 것이 이것이다. 에러는 안 났다.
      사다리 코드는 잡아 둔 변수에 textContent 만 쓰므로 떨어져 나간 노드에 조용히 쓴다.)

     그래서 노드 자체를 들고 있는다. 떨어져 나간 뒤라도 clockHome.parent(보드)는
     문서에 살아 있으므로 — 그리드 IIFE 가 우리보다 먼저 제자리로 돌려놓는다 —
     그 자리에 다시 꽂으면 된다. */
  var clockHome = null, clockEl = null;
  /* parent 의 직접 자식 중 sel 을 «담고 있는» 것을 돌려준다.
     상단바는 게임 이름 드롭다운이나 오른쪽 묶음처럼 한 겹 더 감싸는 상자를 갖고 있어서,
     querySelector 로 찾은 요소가 상단바의 직접 자식이 아닌 경우가 흔하다. 그 요소를
     그대로 insertBefore 의 기준으로 쓰면 NotFoundError 가 나고, 그 예외가 apply() 를
     끊어 뒤 줄들이 실행되지 않는다(가로에서 참가인원 단추가 그렇게 사라져 있었다). */
  function childHolding(parent, sel){
    var el = parent.querySelector(sel);
    while (el && el.parentNode !== parent) el = el.parentNode;
    return el;
  }
  function moveClock(){
    var bar = document.querySelector('.ig-bar');
    var st = document.querySelector('.ig-timer');
    if (!bar || !st) return;
    if (st.parentNode === bar) return;
    clockHome = { parent: st.parentNode, next: st.nextSibling };
    clockEl = st;
    st.classList.add('ig-clock');
    var name = childHolding(bar, '.ig-name');
    bar.insertBefore(st, name ? name.nextSibling : bar.firstChild);
  }
  function restoreClock(){
    var st = clockEl || document.querySelector('.ig-clock');
    if (!st || !clockHome) return;
    st.classList.remove('ig-clock');
    putBack(st, clockHome.parent, clockHome.next);
    clockHome = null; clockEl = null;
  }

  /* 채팅 탭은 두지 않는다. 상단바에 이미 💬 가 있어서 같은 창을 두 군데서 열게 되고,
     좁은 칸에 탭만 셋으로 늘어 참가인원·랭킹이 좁아졌다. 여는 자리는 하나면 된다.

     ── 참가인원 서랍
     칸에서 빼내 오른쪽에서 밀려 나오게 한다. 열고 닫는 단추는 상단바에 둔다.
     닫기는 서랍 밖 아무 데나 눌러도 되게 가림막을 깐다 — 좁은 화면에서 X 를
     정확히 누르게 하면 두 번 만에 닫힌다. */
  /* 원래 자리로 되돌린다. "바로 뒤 형제" 를 기억해 두었는데 그 형제가 그새 지워질 수
     있다 — 예를 들어 세로에서 가로로 돌 때 라이브 뱃지를 먼저 걷으면, 규칙 단추가
     기억하던 뒤 형제가 바로 그 뱃지다. 그러면 insertBefore 가 NotFoundError 를 던지고
     그 뒤의 일(시계 옮기기·👥 붙이기)이 통째로 안 돈다. 실제로 그렇게 멈춰 있었다.
     형제가 아직 그 부모의 자식일 때만 그 앞에 넣고, 아니면 끝에 붙인다. */
  function putBack(node, parent, next){
    if (!node || !parent) return;
    /* 기억해 둔 부모가 이미 문서에서 떨어져 나갔으면 되돌리지 않는다. 거기에 넣으면
       화면에서 사라진다 — 실제로 그랬다. 세로에서 ⚙️ 로 접을 때 원래 부모로 적어 둔
       것이 그때의 상단바인데, 가로로 돌면 상단바를 통째로 새로 짓는다. 그 사이
       상단바 쪽 코드가 음량·규칙을 새 상단바에 이미 옮겨 놓았으므로 그냥 두면 된다. */
    if (!parent.isConnected) return;
    parent.insertBefore(node, (next && next.parentNode === parent) ? next : null);
  }

  function drawer(){ return document.querySelector('.ig-side'); }
  /* 가림막은 «서랍과 같은 부모» 에 둔다. body 에 붙이면 서랍보다 위에 그려진다.

     왜 그런가: main 에 view-transition-name(od-main)이 걸려 있다. 이름이 붙은
     요소는 쌓임 맥락이 되므로, main 안에 있는 서랍의 z-index 는 main «안에서만»
     겨룬다. main 은 position:static 이라 흐름 순서대로 일찍 그려지고, body 에 붙은
     가림막(z:55)은 main 의 자손 전부보다 뒤에 그려진다 — 서랍을 9999 로 올려도
     그대로였다(실측).

     그래서 두 가지가 함께 깨졌다: 시트가 가림막에 덮여 어두워 보였고, 시트 안을
     누르면 «탭이 아니라 가림막» 이 눌려 시트가 닫혔다(실측: 랭킹 탭 탭 → 열림 false,
     활성 탭 그대로). 같은 부모에 두면 z-index 가 제대로 겨뤄 55 < 60 이 된다.

     서랍이 아직 없으면 body 에 둔다 — 그 상태에서는 덮을 것도 없다. */
  function scrim(){
    var s = document.querySelector('.ig-scrim');
    if (!s) {
      s = document.createElement('div');
      s.className = 'ig-scrim';
      s.addEventListener('click', closeDrawer);
    }
    var d = drawer();
    var host = (d && d.parentNode) || document.body;
    if (s.parentNode !== host) {
      if (d && d.parentNode === host) host.insertBefore(s, d); else host.appendChild(s);
    }
    return s;
  }
  /* 참가자 서랍과 채팅 창은 둘 다 아래에서 올라와 같은 자리를 덮는다. 같이 떠 있으면
     뒤엣것은 보이지 않으면서 화면만 잠그므로, 하나가 열리면 다른 하나는 접힌다.
     서로를 직접 부르지는 않는다 — 채팅은 app.js 것이고 서랍은 여기 것이라, 아는
     것은 창구(casinoChat)와 알림(casino:chat)뿐이다. */
  function openDrawer(){
    var d = drawer(); if (!d) return;
    if (window.casinoChat && window.casinoChat.close) window.casinoChat.close();
    d.classList.add('ig-open');
    scrim().classList.add('on');
    /* 랭킹은 탭이 열려 있을 때만 30초마다 받는다 — 열자마자 한 번 더 받아,
       닫아 둔 사이에 밀린 값을 보여 주지 않는다(창구는 views.ts 의 rankJs 가 낸다) */
    try { if (window.__spRankOpen) window.__spRankOpen(); } catch(e){}
    var b = document.querySelector('.ig-people');
    if (b) b.setAttribute('aria-expanded', 'true');
  }
  document.addEventListener('casino:chat', function(e){
    if (e && e.detail && e.detail.open) closeDrawer();
  });
  function closeDrawer(){
    var d = drawer(); if (d) d.classList.remove('ig-open');
    var s = document.querySelector('.ig-scrim'); if (s) s.classList.remove('on');
    var b = document.querySelector('.ig-people');
    if (b) b.setAttribute('aria-expanded', 'false');
  }
  function addPeopleBtn(){
    var bar = document.querySelector('.ig-bar');
    if (!bar || !drawer() || bar.querySelector('.ig-people')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ig-btn ig-people';
    b.setAttribute('aria-label', '참가인원');
    b.setAttribute('aria-expanded', 'false');
    b.innerHTML = IG.ICON.people;
    b.addEventListener('click', function(){
      var d = drawer();
      if (d && d.classList.contains('ig-open')) closeDrawer(); else openDrawer();
    });
    /* 💬 왼쪽에 둔다 — 사람 · 말 순서가 읽기 좋다.
       💬 도 상단바의 직접 자식이 아닐 수 있다(오른쪽 묶음 안에 있다) — 담고 있는
       자식을 기준으로 삼는다. 못 찾으면 맨 뒤에 붙인다(없는 것보다 낫다). */
    var chatChild = childHolding(bar, '.ig-chat');
    if (chatChild) bar.insertBefore(b, chatChild); else bar.appendChild(b);
  }
  /* 사람 아이콘만 걷는다. 가림막은 여기서 지우면 안 된다 — 세로에서는 이 함수가
     1초마다 돌기 때문에, 시트를 열고 1초가 지나면 뒤가 도로 밝아졌다(실측: 0.4초에
     opacity 1, 1.6초에 사라짐). 가림막은 껍데기를 벗을 때만 치운다. */
  function removePeopleBtn(){
    var b = document.querySelector('.ig-people'); if (b) b.remove();
  }
  function removeScrim(){
    var s = document.querySelector('.ig-scrim'); if (s) s.remove();
  }

  /* 가로 서랍에는 닫기 단추를 둔다. 옆에서 나오는 판을 옆으로 쓸어 닫는 것은 세로만큼
     자연스럽지 않고, 여는 사람 아이콘도 상단바에 그대로 보인다. */
  function addSheetClose(){
    var d = drawer();
    if (!d || d.querySelector('.ig-sheet-x')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ig-sheet-x';
    b.setAttribute('aria-label', '닫기');
    b.innerHTML = IG.ICON.close;
    b.addEventListener('click', closeDrawer);
    d.appendChild(b);
  }
  function removeSheetClose(){
    var b = document.querySelector('.ig-sheet-x'); if (b) b.remove();
  }

  /* ── 쓸어내려 닫기 ────────────────────────────────────────────
     세로 시트는 손잡이 막대를 달아 "끌어내릴 수 있다" 고 말해 놓고 정작 안 됐다.
     아래에서 올라온 판은 아래로 쓸어 닫는 것이 폰의 기본 문법이다.

     ── 목록 스크롤과 안 싸우게
     시트 안에는 참가자 목록이 있고 그것도 세로로 움직인다. 둘을 같은 손짓으로 하면
     하나는 반드시 어긋난다. 그래서 목록이 맨 위에 있을 때만 시트를 끈다 — 목록을
     내려 보다가 위로 다 올라오면 그때부터 시트가 따라 내려온다. 폰의 시트들이
     대체로 이렇게 동작한다.

     끄는 동안에는 transition 을 꺼서 손가락을 그대로 따라가게 하고, 놓을 때
     되돌린다. 임계는 높이의 28% 와 110px 중 작은 값 — 짧은 시트에서 끝까지
     내려야 닫히면 답답하고, 긴 시트에서 조금만 움직여도 닫히면 실수로 닫힌다. */
  function addSwipeClose(){
    var d = drawer();
    if (!d || d.__igSwipe) return;
    d.__igSwipe = true;
    var startY = 0, dy = 0, dragging = false, h = 0;

    function scrolledPane(t){
      var p = t && t.closest ? t.closest('.sp-pane') : null;
      return !!(p && p.scrollTop > 0);
    }
    d.addEventListener('touchstart', function(e){
      if (!IG.port() || !d.classList.contains('ig-open')) return;
      if (e.touches.length !== 1 || scrolledPane(e.target)) return;
      startY = e.touches[0].clientY; dy = 0; dragging = true;
      h = d.getBoundingClientRect().height;
      d.style.transition = 'none';
    }, { passive: true });

    d.addEventListener('touchmove', function(e){
      if (!dragging) return;
      dy = e.touches[0].clientY - startY;
      if (dy < 0) dy = 0;               // 위로는 안 끌린다 — 시트는 이미 다 올라와 있다
      if (dy > 4) e.preventDefault();   // 여기서부터는 목록이 아니라 시트를 끄는 중이다
      d.style.transform = 'translateY(' + dy + 'px)';
    }, { passive: false });

    function end(){
      if (!dragging) return;
      dragging = false;
      d.style.transition = '';
      d.style.transform = '';
      if (dy > Math.min(110, h * 0.28)) closeDrawer();
      dy = 0;
    }
    d.addEventListener('touchend', end);
    d.addEventListener('touchcancel', end);
  }

  /* ── 세로 상단바의 라이브 뱃지 — 👥 3명 · 45K
     값을 새로 계산하지 않는다. 참가자 수와 판돈은 이미 패널 머리(#lBetCount·#lPot)에
     적혀 있고 그것을 그대로 비춘다 — 같은 값을 두 곳에서 따로 세면 언젠가 어긋난다.
     좁은 상단바라 자릿수가 늘면 게임 이름을 밀어내므로 천 단위부터 줄여 쓴다. */
  function shorten(n){
    if (!isFinite(n)) return '0';
    var a = Math.abs(n);
    /* 포인트는 언제나 내림이다 — 올림하면 없는 포인트가 있는 것처럼 보인다 */
    if (a >= 1e8) return Math.floor(n / 1e8) + '억';
    if (a >= 1e4) return Math.floor(n / 1e4) + '만';
    if (a >= 1e3) return Math.floor(n / 1e3) + 'K';
    return String(Math.floor(n));
  }
  /* ── 라이브 베팅 띠 (판과 조작부 사이) ──────────────────────────
     처음에는 상단바 가운데에 뱃지로 뒀는데, 상단바는 폭이 고정이고 인원·금액은
     자라는 값이다. "👥 128명 · 1억2345만P" 가 되면 게임 이름을 밀어내고 결국
     넘친다 — 좁은 곳에 자라는 값을 두면 언젠가 터진다. 판 아래 한 줄 띠는
     화면 폭 전체를 쓰므로 자릿수가 늘어도 자리가 있다.

     값은 새로 세지 않는다. 패널 머리(#lBetCount·#lPot)에 이미 적혀 있는 것을
     비춘다 — 같은 값을 두 곳에서 따로 세면 언젠가 어긋난다. */
  /* 지뢰찾기 격자를 자리에 맞춘다.

     격자는 5×5 정사각형이고, 타일이 제 비율을 지키므로 높이가 폭을 따라간다.
     그래서 자리에 넣으려면 폭을 "남는 폭과 남는 높이 중 작은 쪽" 으로 정해야 하는데,
     그 값은 CSS 로 쓸 수가 없다(container query 없이는). 실제로 폭만 보고 키웠더니
     360×640 에서 마지막 줄이 25px 잘렸고, 판 칸이 overflow:hidden 이라 소리 없이
     사라졌다.

     여기서 재서 정한다. apply 는 1초마다 돌고 방향이 바뀔 때도 돌므로 화면이
     달라지면 따라온다. 값이 그대로면 style 을 건드리지 않는다 — 매초 레이아웃을
     다시 계산하게 만들 이유가 없다. */
  function fitMinesGrid(){
    var grid = document.querySelector('html.ig-port .ig-board .mines-grid');
    if (!grid) return;
    var stage = grid.closest('.board-stage') || grid.parentNode;
    var cell = grid.closest('.ig-cell.ig-board');
    var body = grid.closest('.ig-body');
    var bet = body && body.querySelector('.ig-cell.ig-bet');
    if (!stage || !cell || !body) return;

    var px = function(el, a, b2){
      var c = window.getComputedStyle(el);
      return (parseFloat(c[a]) || 0) + (parseFloat(c[b2]) || 0);
    };

    /* 쓸 수 있는 폭도 **본문**에서 잰다. 아래에서 칸 폭을 우리가 정하기 때문에,
       칸에서 재면 그 값이 다시 입력으로 돌아와 매 초 조금씩 줄어든다. */
    var w = body.clientWidth - px(body, 'paddingLeft', 'paddingRight')
          - px(cell, 'paddingLeft', 'paddingRight')
          - px(stage, 'paddingLeft', 'paddingRight');

    /* 쓸 수 있는 높이는 **본문**에서 잰다. 판 칸에서 재면 안 된다 — 아래에서 그 칸의
       높이를 우리가 정하기 때문에, 그 값이 다시 입력으로 돌아와 매 초 조금씩 줄어든다.
       본문 높이와 조작부 높이는 우리가 안 건드리므로 기준으로 삼을 수 있다. */
    var gap = parseFloat(window.getComputedStyle(body).rowGap || window.getComputedStyle(body).gap) || 0;
    /* 판 위아래에 붙은 띠(필드 통계 · 시즌 랭킹)도 높이를 쓴다. 예전에는 조작부만
       뺐는데, 띠가 둘 생기고 나서는 그만큼 격자가 크게 잡혀 짧은 폰에서 넘친다. */
    var bars = 0;
    [].forEach.call(body.querySelectorAll('.ig-statbar, .ig-rankbar'), function(el){
      bars += el.offsetHeight + gap;
    });
    var h = body.clientHeight - px(body, 'paddingTop', 'paddingBottom')
          - (bet ? bet.offsetHeight : 0) - (bet ? gap : 0) - bars
          - px(cell, 'paddingTop', 'paddingBottom') - px(stage, 'paddingTop', 'paddingBottom');

    var side = Math.floor(Math.min(w, h));
    if (!(side > 0)) return;
    /* 상한. 예전에는 340px 이었다 — "너무 커지면 다섯 칸이 한 손에 안 들어와 엄지가
       화면을 가로지른다". 그런데 412px 폰에서 그 값이면 격자 위아래로 100px 씩이
       비어 화면이 휑해진다(제보). 380 으로 올린다: 폭으로 쓸 수 있는 것이 372px
       이므로 실제로는 폭이 상한이 되고, 타일이 62 → 68px 가 된다. 더 큰 폰에서는
       380 에서 멈춰 엄지가 가로지르지 않는다. */
    if (side > 380) side = 380;

    var want = side + 'px';
    if (grid.style.width !== want) { grid.style.width = want; grid.style.height = want; }
    /* 판 칸을 격자에 맞춘다 — 가로도, 세로도.

       늘어난 채로 두면 격자 위아래로 130px 이 비어 "가로는 꽉 차고 세로는 휑한"
       상자가 됐다. 세로만 맞추면 이번에는 반대가 된다: 화면이 짧아 높이가 먼저
       모자라면 격자가 작아지는데 카드는 폭을 다 쓰고 있어 좌우로 51px 씩 빈다.
       카드가 격자를 감싸면 어느 쪽이 기준이 되든 테두리가 격자에서 같은 거리에 있다.

       남는 자리는 칸 밖으로 나가고 본문이 가운데로 모은다(CSS 의 justify-content). */
    var padW = px(cell, 'paddingLeft', 'paddingRight') + px(stage, 'paddingLeft', 'paddingRight');
    var padH = px(cell, 'paddingTop', 'paddingBottom') + px(stage, 'paddingTop', 'paddingBottom');
    var wantH = (side + padH) + 'px';
    var wantW = (side + padW) + 'px';
    if (cell.style.height !== wantH) { cell.style.height = wantH; cell.style.flex = '0 0 auto'; }
    if (cell.style.width !== wantW) { cell.style.width = wantW; cell.style.margin = '0 auto'; }
  }
  function clearMinesGrid(){
    var grid = document.querySelector('.mines-grid');
    if (!grid) return;
    if (grid.style.width) { grid.style.width = ''; grid.style.height = ''; }
    var cell = grid.closest('.ig-cell.ig-board');
    if (cell && cell.style.height) {
      cell.style.height = ''; cell.style.flex = '';
      cell.style.width = ''; cell.style.margin = '';
    }
  }

  function addLiveBar(){
    var body = movedGrid(), bet = document.querySelector('.ig-cell.ig-bet');
    if (!body || !bet || body.querySelector('.ig-livebar')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ig-livebar';
    b.setAttribute('aria-label', '참가자 명단 보기');
    b.innerHTML = '<span class="ig-lb-ico">' + IG.ICON.people + '</span>'
      + '<span class="ig-lb-l"></span><span class="ig-lb-r"></span>';
    b.addEventListener('click', function(){
      var d = drawer();
      if (d && d.classList.contains('ig-open')) closeDrawer(); else openDrawer();
    });
    body.insertBefore(b, bet);
    syncLiveBar();
  }
  function num(el){
    if (!el) return 0;
    var m = String(el.textContent).match(/(\d[\d,]*)/);
    return m ? Number(m[1].replace(/,/g, '')) : 0;
  }
  function syncLiveBar(){
    var b = document.querySelector('.ig-livebar');
    if (!b) return;
    var n = num(document.getElementById('lBetCount'));
    var p = num(document.getElementById('lPot'));
    var l = b.querySelector('.ig-lb-l'), r = b.querySelector('.ig-lb-r');
    var lt = '실시간 참가자 ' + n + '명';
    /* 자릿수가 커지면 축약한다 — 띠는 넓지만 무한하지는 않다 */
    var rt = '총 베팅 ' + (p >= 1e7 ? shorten(p) : p.toLocaleString('ko-KR')) + 'P';
    if (l.textContent !== lt) l.textContent = lt;
    if (r.textContent !== rt) r.textContent = rt;
  }
  /* ── 필드 통계 띠 (지뢰찾기 세로 · 판 위) ──────────────────────────
     상단바와 5x5 판 사이가 비어 있었다(실측 412x915: 상단바 아래끝 40, 판 위끝 154
     — 114px). 격자는 340px 에서 크기를 멈추므로(fitMinesGrid, 다섯 칸이 한 손에
     들어와야 한다) 그 자리는 격자를 키워서는 안 채워진다.

     그 자리에 이 판을 읽는 데 필요한 값을 둔다. 사다리의 출목표 띠와 같은 자리다.
       안전 20 / 20   지뢰 5개   다음 성공 1.28x
     세 값의 출처는 mines.ts 하나다(window.__MINES_STAT__). DOM 글자를 긁으면
     "배당 1.00x" 같은 표시용 반올림 값을 되돌려 읽게 되고, 그러면 같은 판을 두
     자리가 조금씩 다르게 말한다.

     "다음 성공" 은 지금 배당이 아니라 «한 칸 더 열면» 되는 배당이다. 지금 배당은
     아래 조작부가 이미 말하고 있고(캐시아웃 옆), 이 게임에서 손이 멈추는 이유는
     "한 번 더 열면 얼마가 되나" 이므로 그 값을 위에 둔다. */
  /* 띠는 mines.ts 가 판 상자 안에 그려 두었다(#mStat). 여기서는 그것을 판 «밖» 으로
     꺼내 격자의 첫 줄로 세운다 — 세로에서는 상단바 바로 아래가 그 자리다.
     새로 만들지 않는다: 만들면 PC 것과 폰 것이 두 벌이 되고, 값을 채우는 코드도
     두 곳이 된다(그래서 한동안 PC 에는 띠가 아예 없었다).
     돌아갈 자리는 기억해 둔다 — 가로로 돌리거나 판을 벗을 때 되돌린다. */
  var statHome = null;
  function addStatBar(){
    var body = movedGrid(), board = document.querySelector('.ig-cell.ig-board');
    var bar = document.getElementById('mStat');
    if (!body || !board || !bar || bar.parentNode === body) return;
    statHome = [bar.parentNode, bar.nextSibling];
    bar.classList.add('ig-statbar');
    body.insertBefore(bar, board);
  }
  /* 값은 mines.ts 가 적는다 — 여기서 또 적으면 같은 칸을 두 곳이 쓴다 */
  function syncStatBar(){ /* 값은 mines.ts 가 적는다 */ }
  function removeStatBar(){
    var bar = document.getElementById('mStat');
    if (!bar || !statHome) return;
    bar.classList.remove('ig-statbar');
    var parent = statHome[0], next = statHome[1];
    statHome = null;
    /* 기억해 둔 부모가 문서에서 떨어져 나갔으면 되돌리지 않는다 — 거기에 넣으면
       화면에서 사라진다(위 restoreSettings 와 같은 이유). */
    if (!parent || !parent.isConnected) return;
    parent.insertBefore(bar, (next && next.parentNode === parent) ? next : null);
  }

  /* ── 시즌 랭킹 띠 (지뢰찾기 세로) ─────────────────────────────────
     지뢰찾기는 혼자 하는 판이라 참가자 띠가 없다. 그런데 세로에서 판과 조작부를
     가운데로 모으면 아래쪽에 120px 남짓이 그냥 빈다(실측 412x915: 조작부 아래끝
     753, 탭바 위끝 875). 그 자리에 시즌 랭킹으로 들어가는 문을 둔다 — 사다리의
     라이브 띠와 같은 모양이라 새 문법을 배울 것이 없고, 여는 것도 같은 시트다.

     오른쪽에는 내 순위를 적는다. 목록에서 내 줄(.sp-rw.me)의 번호를 읽어 오는데,
     그 목록은 지뢰찾기에서 처음부터 열려 있어(sidePanel 이 탭 없이 랭킹만 둔다)
     페이지에 들어오면 곧 채워진다. 아직 모를 때는 "랭킹 보기" 로 둔다 — 없는 값을
     0위로 적으면 거짓말이 된다. */
  function addRankBar(){
    var body = movedGrid(), bet = document.querySelector('.ig-cell.ig-bet');
    if (!body || !bet || body.querySelector('.ig-rankbar')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ig-rankbar';
    b.setAttribute('aria-label', '시즌 랭킹 보기');
    b.innerHTML = '<span class="ig-lb-ico">' + (IG.ICON.trophy || '') + '</span>'
      + '<span class="ig-lb-l">시즌 랭킹</span>'
      + '<span class="ig-lb-r"></span>'
      + '<span class="ig-lb-x">' + (IG.ICON.chev || '') + '</span>';
    b.addEventListener('click', function(){
      var d = drawer();
      if (d && d.classList.contains('ig-open')) closeDrawer(); else openDrawer();
    });
    body.insertBefore(b, bet);
    syncRankBar();
  }
  function syncRankBar(){
    var b = document.querySelector('.ig-rankbar');
    if (!b) return;
    var no = document.querySelector('.sp-rank .sp-rw.me .sp-no');
    var r = b.querySelector('.ig-lb-r');
    var t = no ? ('내 순위 ' + no.textContent.trim() + '위') : '랭킹 보기';
    if (r.textContent !== t) r.textContent = t;
  }
  function removeRankBar(){
    var b = document.querySelector('.ig-rankbar'); if (b) b.remove();
  }
  function removeLiveBar(){
    var b = document.querySelector('.ig-livebar'); if (b) b.remove();
    document.documentElement.style.removeProperty('--ig-chat-top');
  }

  /* 채팅창이 시작할 높이를 알려 준다. 화면을 다 덮으면 판이 안 보여서, 말하는 동안
     공이 어디까지 내려왔는지를 놓친다. 라이브 띠 위쪽에서 시작하면 판은 그대로 남고
     가리는 것은 베팅 조작부뿐이다.

     자리를 CSS 에 숫자로 박지 않는 이유는 조작부 높이가 화면마다 다르기 때문이다 —
     조작부는 제 내용만큼 가져가고 판이 나머지를 받으므로, 412x915 와 360x780 에서
     경계가 다른 자리에 생긴다. 실제로 그려진 자리를 재서 넘긴다. */
  function syncChatTop(){
    var lb = document.querySelector('.ig-livebar');
    if (!lb) return;
    var t = Math.round(lb.getBoundingClientRect().top);
    if (t > 0) document.documentElement.style.setProperty('--ig-chat-top', t + 'px');
  }

  /* ── 타이머 ────────────────────────────────────────────────────
     사다리 코드가 #lCountdown 에 쓰는 문장을 고쳐 쓰지 않는다. 그 노드는 폴링마다
     다시 쓰이므로 우리가 손대면 매초 싸우게 된다. 대신 원본은 감추고, 그 글자를
     읽어서 우리 것을 그린다 — 값의 출처는 하나로 둔다.

     원본이 쓰는 문장은 다섯 가지다:
       '베팅 마감까지 N초' · '결과 공개 중…' · '다음 라운드까지 N초'
       '일시정지 (화면을 클릭하면 재개)' · '서버에 연결하는 중…' */
  /* ── ⚙️ 설정 — 음량과 규칙을 한 자리에 모은다
     412px 상단바에 음량(34) · 규칙(30)까지 늘어놓았더니 규칙 단추가 x=414 로
     화면 밖에 나갔다(실측, 바 폭 412). 둘 다 자주 쓰는 것이 아니라 한 번 정하고
     마는 것이라 접어 둔다.

     새로 만들지 않고 있는 것을 옮긴다 — 음량 슬라이더와 규칙 단추에는 이미 동작이
     걸려 있고, 다시 만들면 그 동작을 여기서 또 짜야 한다. 옮긴 자리는 노드 참조로
     들고 있는다(클래스로 다시 찾으면 상단바가 먼저 지워질 때 놓친다). */
  var setHome = [];
  function settingsSheet(){
    var s = document.querySelector('.ig-set');
    if (s) return s;
    s = document.createElement('div');
    s.className = 'ig-set';
    /* body 에 붙인다 — 상단바 안에 넣으면 상단바가 지워질 때 같이 사라진다 */
    document.body.appendChild(s);
    return s;
  }
  /* 옮기면서 이름을 붙인다. 아이콘만 두면 스피커 그림과 물음표 하나가 남아
     무엇을 누르는 자리인지 알 수 없다. 줄(row)은 우리가 만든 것이라 되돌릴 때
     같이 지우고, 안에 있던 원래 노드만 제자리로 보낸다. */
  function takeInto(el, box, label){
    if (!el) return;
    setHome.push([el, el.parentNode, el.nextSibling]);
    var row = document.createElement('div');
    row.className = 'ig-set-row';
    /* 줄 전체가 하나의 누를 자리다. 규칙은 오른쪽 끝 물음표(30px)만 눌러야 열렸는데,
       폰에서 그건 조준해서 눌러야 하는 크기다. 이름을 눌러도, 가운데 빈 자리를 눌러도
       열려야 한다. div 를 쓰는 이유는 안에 진짜 단추가 들어가기 때문이다 —
       단추 안에 단추는 못 넣는다. 대신 역할과 키보드 조작을 직접 붙인다. */
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    var t = document.createElement('span');
    t.className = 'ig-set-lbl';
    t.textContent = label;
    row.appendChild(t);
    row.appendChild(el);

    function fire(e){
      /* 진짜 조작을 직접 눌렀으면 그대로 둔다 — 여기서 또 부르면 두 번 눌린 것이 되어
         소리가 껐다 켜졌다 하고, 슬라이더는 끌 수도 없게 된다. */
      if (e.target !== row && e.target.closest('button, input, a, select')) return;
      var hit = el.tagName === 'BUTTON' ? el : el.querySelector('button');
      if (hit) hit.click();
    }
    row.addEventListener('click', fire);
    row.addEventListener('keydown', function(e){
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(e); }
    });
    box.appendChild(row);
  }
  /* 세로에 들어서는 즉시 접는다. 누를 때 접으면 그전까지는 상단바에 그대로 남아
     자리를 먹는다 — 실제로 규칙 단추가 x=414 로 화면 밖에 나가 있었다. */
  function foldSettings(){
    /* 방향이 바뀌면 상단바를 통째로 다시 짓는다. 그때 적어 둔 자리는 낡은 상단바를
       가리키므로 그대로 두면 다시 접지도 못하고 되돌리지도 못한다 — 비우고 새로 접는다. */
    if (setHome.length && setHome[0][1] && !setHome[0][1].isConnected) setHome = [];
    if (setHome.length) return;
    var vol = document.querySelector('.ig-vol'), help = document.querySelector('.ig-help');
    if (!vol && !help) return;
    var box = settingsSheet();
    /* 다시 접기 전에 빈 줄을 치운다. 줄(.ig-set-row)은 우리가 만든 껍데기라, 안의
       진짜 노드가 상단바로 돌아가고 나면 빈 껍데기만 남는다. 그대로 두고 새로 접으면
       방향을 바꿀 때마다 한 벌씩 쌓인다 — 실제로 "소리 / 게임 규칙" 이 네 벌이었다.
       안에 진짜 노드가 아직 있는 줄은 건드리지 않는다. */
    [].forEach.call(box.querySelectorAll('.ig-set-row'), function(row){
      if (!row.querySelector('.ig-vol, .ig-help')) row.remove();
    });
    takeInto(vol, box, '소리');
    takeInto(help, box, '게임 규칙');
  }
  function openSettings(){
    foldSettings();
    settingsSheet().classList.add('on');
    scrim().classList.add('on');
  }
  function closeSettings(){
    var box = document.querySelector('.ig-set');
    if (box) box.classList.remove('on');
    var s = document.querySelector('.ig-scrim');
    if (s && !(drawer() && drawer().classList.contains('ig-open'))) s.classList.remove('on');
  }
  /* 세로를 벗어나면 옮겨 온 것들을 원래 자리(상단바)로 돌려놓는다. 넣은 역순으로
     되돌려야 뒤 형제가 아직 제자리에 있다. */
  function restoreSettings(){
    for (var i = setHome.length - 1; i >= 0; i--) {
      var t = setHome[i];
      if (t[1]) putBack(t[0], t[1], t[2]);
    }
    setHome = [];
    var box = document.querySelector('.ig-set'); if (box) box.remove();
    var g = document.querySelector('.ig-gear'); if (g) g.remove();
  }
  function addGearBtn(){
    var bar = document.querySelector('.ig-bar');
    if (!bar || bar.querySelector('.ig-gear')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ig-btn ig-gear';
    b.setAttribute('aria-label', '설정');
    b.innerHTML = IG.ICON.gear;
    b.addEventListener('click', function(){
      var box = document.querySelector('.ig-set');
      if (box && box.classList.contains('on')) closeSettings(); else openSettings();
    });
    bar.appendChild(b);
  }

  function apply(){
    if (!movedGrid() || !IG.on()) {
      restoreClock(); closeDrawer(); closeSettings(); restoreSettings();
      removePeopleBtn(); removeScrim(); removeLiveBar(); removeRankBar(); removeStatBar();
      removeSheetClose();
      clearMinesGrid();
      return;
    }
    if (IG.land()) {
      /* 가로 — 타이머는 상단바로, 참가인원은 사람 아이콘으로.

         ⚙️ 는 없앴다. 그 안에 접어 두던 것이 소리와 규칙 둘뿐이었는데, 둘 다 한 번
         누르면 끝나는 일이라 서랍을 한 겹 더 여는 값이 아니었다 — 이제 상단바에
         그대로 있다(규칙은 왼쪽 게임 이름 옆, 소리는 오른쪽).

         자리는 게임 이름을 눌러 바꾸게 하면서 벌었다. 가로에 있던 [← 로비] 단추가
         목록의 첫 줄로 들어가 사라졌기 때문이다. */
      removeLiveBar(); removeRankBar(); removeStatBar();
      moveClock(); addPeopleBtn(); restoreSettings(); addSheetClose();
      clearMinesGrid();
    } else {
      /* 세로 — 타이머는 판 위에 우리 것으로 다시 그리고, 참가 현황은 판 아래 띠로.
         소리·규칙은 상단바에 그대로 둔다(⚙️ 를 없앴다 — 위 가로 갈래의 설명을 보라). */
      removePeopleBtn();
      restoreClock();
      /* 라이브 띠는 여럿이 같은 판에 거는 게임만 쓴다. 지뢰찾기는 혼자 하는 판이라
         "실시간 참가자 0명 · 총 베팅 0P" 가 언제나 0 이고, 그건 알려 주는 것이
         없으면서 한 줄을 먹는다. 그런 게임에서는 아예 안 붙인다. */
      if (IG.kind() === 'ladder') { addLiveBar(); syncLiveBar(); syncChatTop(); }
      else removeLiveBar();
      /* 지뢰찾기는 참가자 대신 시즌 랭킹으로 들어가는 문을 같은 자리에 둔다 */
      if (IG.kind() === 'mines') { addRankBar(); syncRankBar(); addStatBar(); syncStatBar(); }
      else { removeRankBar(); removeStatBar(); }
      /* 세로는 닫기 단추 대신 쓸어내려 닫는다 */
      removeSheetClose(); addSwipeClose();
      restoreSettings();
      fitMinesGrid();
    }
  }

  function start(){
    apply();
    IG.subscribe(apply);
    /* 조작부와 패널은 상태가 바뀌면 다시 그려진다 — 그때 붙인 것이 사라지므로 확인한다 */
    setInterval(apply, 1000);
    /* 타이머와 참가 현황은 더 자주 맞춘다. 1초마다 맞추면 원본이 바뀐 뒤 최대 1초를
       늦게 따라가서, 남은 시간이 한 박자씩 밀려 보인다. */
    setInterval(function(){
      if (movedGrid() && IG.port()) { syncLiveBar(); syncRankBar(); syncStatBar(); syncChatTop(); }
    }, 250);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

/* ── 지난 결과를 상단 전체 폭 띠로 ────────────────────────────────────
   사다리 칸(5/12 ≈ 290px)에 두 줄로 넣었더니 여덟 개만 보이고 나머지가 잘렸다.
   지난 흐름은 판 하나에 매인 정보가 아니라 화면 전체의 맥락이고, 예측의 근거라
   자주 본다. 가로 915px 을 다 쓰면 한 줄에 스물여섯 개가 들어간다.

   격자 위, 상단바 아래에 띠로 둔다. 예산에서 34px 을 쓰고 나머지를 격자가 받는다. */
(function(){
  var IG = window.__IG;
  var strip = null, histHome = null;

  function apply(){
    var grid = document.querySelector('.ig-body');
    var on = grid && IG.on();
    var hist = document.querySelector('.bead');

    if (!on) {
      if (histHome && hist) { histHome.parent.insertBefore(hist, histHome.next); histHome = null; }
      if (strip) { strip.remove(); strip = null; }
      return;
    }
    if (strip || !hist) return;

    strip = document.createElement('div');
    strip.className = 'ig-hist';
    histHome = { parent: hist.parentNode, next: hist.nextSibling };
    strip.appendChild(hist);
    grid.parentNode.insertBefore(strip, grid);
  }

  function start(){
    apply();
    IG.subscribe(apply);
    setInterval(apply, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
