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
