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
(function(){
  var MQ = '(max-width:1024px) and (max-height:560px) and (orientation:landscape)';
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
  function giveBack(el, key){
    var h = home[key];
    if (el && h && h.parent) h.parent.insertBefore(el, h.next);
  }

  function build(){
    if (bar) return;
    bar = document.createElement('div');
    bar.className = 'ig-bar';

    var lobby = take(document.querySelector('header nav a.tab[href="/"]'), 'lobby');
    var prof  = take(document.querySelector('.profwrap'), 'prof');
    var vol   = take(document.querySelector('.volwrap'), 'vol');
    var help  = take(document.querySelector('.game-switch .gs-help'), 'help');

    if (lobby) { lobby.classList.add('ig-back'); bar.appendChild(lobby); }

    /* 게임 이름은 글자만 가져온다. 칩 자체를 옮기면 접었다 펴는 위임이 끊긴다. */
    var active = document.querySelector('.game-switch .gs-pill.active');
    var name = document.createElement('span');
    name.className = 'ig-name';
    name.textContent = active ? active.textContent.trim() : '';
    bar.appendChild(name);

    if (prof) bar.appendChild(prof);

    /* 채팅 단추. app.js 가 창을 여는 함수를 내보내 두었으므로 여기서는 부르기만 한다. */
    var chat = document.createElement('button');
    chat.type = 'button';
    chat.className = 'ig-btn ig-chat';
    chat.setAttribute('aria-label', '채팅');
    chat.textContent = '💬';
    chat.addEventListener('click', function(){
      if (window.casinoChat && window.casinoChat.open) window.casinoChat.open();
    });
    bar.appendChild(chat);

    if (vol) { vol.classList.add('ig-vol'); bar.appendChild(vol); }
    if (help) { help.classList.add('ig-help'); bar.appendChild(help); }

    document.body.appendChild(bar);
  }

  function tearDown(){
    if (!bar) return;
    giveBack(document.querySelector('.ig-back'), 'lobby');
    giveBack(document.querySelector('.ig-bar .profwrap'), 'prof');
    giveBack(document.querySelector('.ig-vol'), 'vol');
    giveBack(document.querySelector('.ig-help'), 'help');
    var back = document.querySelector('.ig-back');
    if (back) back.classList.remove('ig-back');
    var vol = document.querySelector('.ig-vol');
    if (vol) vol.classList.remove('ig-vol');
    var help = document.querySelector('.ig-help');
    if (help) help.classList.remove('ig-help');
    bar.parentNode && bar.parentNode.removeChild(bar);
    bar = null;
  }

  function apply(){
    var on = isGame() && window.matchMedia(MQ).matches;
    if (on) { build(); root.classList.add('ingame'); }
    else { root.classList.remove('ingame'); tearDown(); }
  }

  function start(){
    apply();
    var m = window.matchMedia(MQ);
    if (m.addEventListener) m.addEventListener('change', apply);
    else if (m.addListener) m.addListener(apply);
    window.addEventListener('orientationchange', apply);
    window.addEventListener('resize', apply);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

/* ── MAX 단추 ─────────────────────────────────────────────────────────
   빠른 금액 칩 줄(10·100·1000·1만)을 폰 가로에서 걷어냈다. 그 줄이 판이 쓸 높이를
   통째로 차지하기 때문이다. 대신 인풋 옆에 MAX 를 붙인다 — 가진 만큼 거는 것은
   자주 하는 동작인데, 칩을 여러 번 눌러 맞추던 것을 한 번으로 줄인다.

   서버 HTML 은 여전히 안 바꾼다. 여기서 만들어 붙이고, 세로로 돌리면 걷는다.
   잔액은 헤더에 이미 적혀 있으므로 그 글자에서 숫자만 뽑는다 — 값을 두 곳에서
   따로 계산하면 언젠가 어긋난다. */
(function(){
  var MQ = '(max-width:1024px) and (max-height:560px) and (orientation:landscape)';

  function balance(){
    var el = document.querySelector('.profwrap .num, .profwrap .bal, .profwrap');
    if (!el) return null;
    var m = (el.textContent || '').replace(/,/g, '').match(/(\d+)\s*P/);
    return m ? Number(m[1]) : null;
  }

  function apply(){
    var on = /^\/games\//.test(location.pathname) && window.matchMedia(MQ).matches;
    var row = document.querySelector('.game-controls .bet-row');
    var old = document.querySelector('.ig-max');
    if (!on || !row) { if (old) old.remove(); return; }
    if (old) return;

    var input = row.querySelector('input');
    if (!input) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ig-max';
    b.textContent = 'MAX';
    b.addEventListener('click', function(){
      var v = balance();
      if (v == null) return;
      input.value = String(v);
      /* 화면 쪽 계산(배당·예상 획득)이 input 을 지켜보므로 바뀐 것을 알린다 */
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    row.appendChild(b);
  }

  function start(){
    apply();
    var m = window.matchMedia(MQ);
    if (m.addEventListener) m.addEventListener('change', apply);
    window.addEventListener('orientationchange', apply);
    window.addEventListener('resize', apply);
    /* 조작부는 상태가 바뀌면 다시 그려진다 — 그때 단추가 사라지므로 주기적으로 확인한다.
       폴링이 1초라 그보다 촘촘할 이유가 없다. */
    setInterval(apply, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

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
  var MQ = '(max-width:1024px) and (max-height:560px) and (orientation:landscape)';
  var body = null;
  var home = [];      // [노드, 원래 부모, 원래 다음 형제]

  function shellKind(){
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
     뒤에 다음을 더한다. */
  var MOVED = ['ladder'];

  function apply(){
    var on = /^\/games\//.test(location.pathname)
      && window.matchMedia(MQ).matches
      && MOVED.indexOf(shellKind()) >= 0;
    if (on) build(); else tearDown();
  }

  function start(){
    apply();
    var m = window.matchMedia(MQ);
    if (m.addEventListener) m.addEventListener('change', apply);
    window.addEventListener('orientationchange', apply);
    window.addEventListener('resize', apply);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

/* ── 인게임 격자의 마무리: 타이머를 헤더로, 채팅을 탭으로 ────────────────
   타이머는 판 위에 떠 있었다. 판을 가리지 않으려고 절대 위치로 띄웠는데, 그러면
   사다리 그림과 겹치는 자리를 계속 피해 다녀야 한다. 헤더에는 그 자리가 이미 있다 —
   회차와 남은 시간은 "지금 무슨 판인가" 라서 게임 이름 옆이 제자리다.

   채팅은 오른쪽 칸에 탭으로 넣는다. 지금까지는 상단바의 💬 로 열었는데, 참가자·랭킹과
   같은 성격(옆에서 흐르는 것)이므로 같은 자리에서 고르는 것이 맞다. */
(function(){
  var MQ = '(max-width:1024px) and (max-height:560px) and (orientation:landscape)';

  function movedGrid(){ return document.querySelector('.ig-body'); }

  /* 타이머를 상단바로 옮긴다. 원래 자리를 적어 두고 세로로 돌리면 되돌린다. */
  var clockHome = null;
  function moveClock(){
    var bar = document.querySelector('.ig-bar');
    var st = document.querySelector('.stage-status');
    if (!bar || !st) return;
    if (st.parentNode === bar) return;
    clockHome = { parent: st.parentNode, next: st.nextSibling };
    st.classList.add('ig-clock');
    var name = bar.querySelector('.ig-name');
    bar.insertBefore(st, name ? name.nextSibling : bar.firstChild);
  }
  function restoreClock(){
    var st = document.querySelector('.ig-clock');
    if (!st || !clockHome) return;
    st.classList.remove('ig-clock');
    clockHome.parent.insertBefore(st, clockHome.next);
    clockHome = null;
  }

  /* 채팅 탭. 참가자·랭킹 탭 옆에 하나를 더 만들고, 누르면 채팅창을 연다. */
  function addChatTab(){
    var tabs = document.querySelector('.ig-side .sp-tabs');
    if (!tabs || tabs.querySelector('.ig-chat-tab')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'sp-tab ig-chat-tab';
    b.textContent = '채팅';
    b.addEventListener('click', function(){
      if (window.casinoChat && window.casinoChat.open) window.casinoChat.open();
    });
    tabs.appendChild(b);
  }
  function removeChatTab(){
    var b = document.querySelector('.ig-chat-tab');
    if (b) b.remove();
  }

  function apply(){
    if (movedGrid() && window.matchMedia(MQ).matches) { moveClock(); addChatTab(); }
    else { restoreClock(); removeChatTab(); }
  }

  function start(){
    apply();
    var m = window.matchMedia(MQ);
    if (m.addEventListener) m.addEventListener('change', apply);
    window.addEventListener('orientationchange', apply);
    window.addEventListener('resize', apply);
    /* 조작부와 패널은 상태가 바뀌면 다시 그려진다 — 그때 붙인 것이 사라지므로 확인한다 */
    setInterval(apply, 1000);
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
  var MQ = '(max-width:1024px) and (max-height:560px) and (orientation:landscape)';
  var strip = null, histHome = null;

  function apply(){
    var grid = document.querySelector('.ig-body');
    var on = grid && window.matchMedia(MQ).matches;
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
    var m = window.matchMedia(MQ);
    if (m.addEventListener) m.addEventListener('change', apply);
    window.addEventListener('orientationchange', apply);
    window.addEventListener('resize', apply);
    setInterval(apply, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
