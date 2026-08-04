// SSR HTML 렌더링 (레이아웃 + 공통 헬퍼). 프레임워크 없이 템플릿 문자열만 사용.
// 톤앤매너: 블랙 + 골드 베이스의 절제된 카지노 UI. 초록/빨강은 승패 등 기능적 신호에만 사용.
import { ASSET_V } from './assets';
import { discordIcon } from './icons';

export const LOGO_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
  `<rect x="2" y="2" width="96" height="96" rx="22" fill="#fff"/>` +
  `<circle cx="50" cy="23" r="6.5" fill="#111"/>` +
  `<path d="M50 23 L24 46 M50 23 L76 46" stroke="#111" stroke-width="4.5" stroke-linecap="round"/>` +
  `<rect x="17" y="43" width="66" height="35" rx="7.5" fill="#111"/>` +
  `<text x="50" y="61.5" text-anchor="middle" dominant-baseline="central" ` +
  `font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="20" ` +
  `letter-spacing="-0.5" fill="#fff">OPEN</text>` +
  `</svg>`;

export interface HeaderUser { id: string; username: string; avatar: string | null; role: string; balance: number }
let _reqUser: HeaderUser | null = null;
export function setRequestUser(u: HeaderUser | null): void { _reqUser = u; }

// 게임 선택은 로비에서 하므로 별도 '게임' 탭은 두지 않는다. 게임 플레이 화면은 로비 탭을 활성으로 표시.
export type Tab = 'lobby' | 'leaderboard';

const TABS: { key: Tab; label: string; href: string }[] = [
  { key: 'lobby', label: '로비', href: '/' },
  { key: 'leaderboard', label: '랭킹', href: '/leaderboard' },
];

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// <script> 블록 안에 값을 심을 때 쓴다.
// JSON.stringify는 '<'를 그대로 통과시켜서, 닉네임에 "</script>"가 들어 있으면
// 스크립트가 그 자리에서 끊기고 뒤가 HTML로 실행된다(XSS). 그래서 유니코드로 이스케이프한다.
export function jsonForScript(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}


// 우측 참가자 패널 렌더러 — 사다리/그래프/포커가 같은 마크업을 공유한다.
// (아바타 · 닉네임 · 실시간 보유 포인트 + 게임별 정보). 게임 스크립트 안에 그대로 삽입해서 쓴다.
// 요구 헬퍼: esc(), fmt(), replay() — 세 게임 스크립트에 모두 있다.
export const ROSTER_JS = `
      var __rosterSig=null, __lastBal={};
      function __cssEsc(v){ return String(v).replace(/["\\\\]/g, '\\\\$&'); }
      function rosterRow(uid){ return document.querySelector('.rw[data-uid="' + __cssEsc(uid) + '"]'); }
      function renderRosterRows(el, rows, meId, midHtml){
        var sig = rows.map(function(r){ return r.user_id; }).join(',');
        if (sig !== __rosterSig) {
          __rosterSig = sig;
          el.innerHTML = rows.length ? rows.map(function(r){
            var ini = esc((String(r.username||'?').trim()[0] || '?').toUpperCase());
            var av = r.avatar
              ? '<img class="rw-av" src="' + esc(r.avatar) + '" alt="" referrerpolicy="no-referrer">'
              : '<span class="rw-av">' + ini + '</span>';
            return '<div class="rw' + (r.user_id===meId ? ' me' : '') + '" data-uid="' + esc(r.user_id) + '">' + av +
              '<span class="rw-mid"><span class="rw-name">' + esc(r.username) + '</span>' +
              '<span class="rw-bal" id="rbal-' + esc(r.user_id) + '">' + fmt(r.balance) + '</span></span>' +
              '<span class="rw-bet" id="rbet-' + esc(r.user_id) + '"></span></div>';
          }).join('') : '<div class="empty" style="padding:16px 0">아직 베팅이 없습니다</div>';
        }
        rows.forEach(function(r){
          var b = document.getElementById('rbal-' + r.user_id);
          if (b) {
            var prev = __lastBal[r.user_id];
            if (prev != null && r.balance !== prev) replay(b, r.balance > prev ? 'up' : 'down');
            b.textContent = fmt(r.balance);
          }
          __lastBal[r.user_id] = r.balance;
          var m = document.getElementById('rbet-' + r.user_id);
          if (m) m.innerHTML = midHtml(r);
          var row = rosterRow(r.user_id);
          if (row) row.classList.toggle('won', (r.payout||0) > 0);
        });
      }
`;
/* ── 규칙 도움말 ─────────────────────────────────────────────────────────
   물음표를 누르면 규칙을 띄운다. 게임마다 붙일 수 있게 공용으로 둔다.
   네이티브 <dialog>를 쓰는 이유: Esc 닫기·포커스 가둠·배경 어둡게를 브라우저가 해준다.
   직접 만들면 그 셋을 다 짜야 하고, 그중 포커스 가둠은 빠뜨리기 쉽다. */
export function helpButton(dialogId: string): string {
  return `<button class="helpbtn" type="button" data-help="${esc(dialogId)}" aria-label="규칙 보기" title="규칙 보기">?</button>`;
}

export function helpDialog(dialogId: string, title: string, bodyHtml: string): string {
  return `<dialog class="helpdlg" id="${esc(dialogId)}">
    <div class="help-head">
      <b>${esc(title)}</b>
      <button class="help-x" type="button" data-help-close aria-label="닫기">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="help-body">${bodyHtml}</div>
  </dialog>`;
}

/* ── 우측 패널 탭 (참가인원 / 랭킹) ────────────────────────────────────
   게임마다 우측에 참가자 목록이 있었는데, 여기에 게임별 랭킹을 나란히 둔다.
   지뢰찾기는 참가자라는 개념이 없어 liveHtml이 빈 문자열로 오고, 그때는
   탭바 없이 제목 줄로 그린다 — 누를 게 하나뿐인 탭바는 탭으로 읽히지 않는다.

   전환은 hidden 속성이 아니라 .on 클래스로 한다. pane에 display:flex가
   필요한데, display를 명시하면 hidden 속성이 밀린다(이 프로젝트에서 세 번 겪었다).

   동작은 app.js의 document 위임이 맡는다 — app.js는 <head>에서 실행돼
   DOM이 아직 없으므로 요소에 직접 붙일 수 없다. */
export function sidePanel(prefix: string, liveHtml: string, rankHtml: string): string {
  const rank = `<div class="sp-pane${liveHtml ? '' : ' on'}" id="${esc(prefix)}-rank" role="tabpanel">${rankHtml}</div>`;
  if (!liveHtml) {
    return `<div class="card game-side">
      <div class="side-head"><span>랭킹</span></div>
      ${rank}
    </div>`;
  }
  return `<div class="card game-side">
    <div class="sp-tabs" role="tablist">
      <button class="sp-tab on" type="button" role="tab" aria-selected="true"
        data-sptab="${esc(prefix)}-live">참가인원</button>
      <button class="sp-tab" type="button" role="tab" aria-selected="false"
        data-sptab="${esc(prefix)}-rank">랭킹</button>
    </div>
    <div class="sp-pane on" id="${esc(prefix)}-live" role="tabpanel">${liveHtml}</div>
    ${rank}
  </div>`;
}

/** 랭킹 pane의 껍데기. 안쪽 줄은 클라이언트가 그린다. */
export function rankPane(prefix: string): string {
  return `<div class="sp-rank" id="${esc(prefix)}RankList">
    <div class="sp-empty">불러오는 중…</div>
  </div>`;
}

/* 랭킹 목록을 그리고 30초마다 갱신하는 공용 클라이언트 코드.
   게임마다 붙여 쓴다. seg는 API 경로 세그먼트(그래프게임은 crash),
   prefix는 sidePanel에 넘긴 것과 같아야 한다.

   sig 캐시를 로스터와 공유하면 두 목록이 서로의 캐시를 무효화해 매 폴링마다
   DOM을 갈아엎고 잔액·칩 애니메이션이 끊긴다 — 그래서 지역 변수를 따로 둔다. */
export function rankJs(prefix: string, seg: string): string {
  return `
      (function(){
        var listEl = document.getElementById('${prefix}RankList');
        if (!listEl) return;
        var rankSig = null, lastAt = 0, timer = null;
        function fmtSigned(n){
          var s = new Intl.NumberFormat('ko-KR').format(Math.abs(n));
          return (n > 0 ? '+' : n < 0 ? '-' : '') + s + 'P';
        }
        function row(r){
          var sub = new Intl.NumberFormat('ko-KR').format(r.rounds) + '판' +
            (r.winPct == null ? '' : ' · ' + r.winPct + '%');
          var cls = r.profit > 0 ? ' pos' : (r.profit < 0 ? ' neg' : '');
          return '<div class="sp-rw' + (r.me ? ' me' : '') + '">' +
            '<span class="sp-no' + (r.rank === 1 ? ' top1' : '') + '">' + r.rank + '</span>' +
            '<span class="sp-mid"><span class="sp-nm">' + escHtml(r.username) + '</span>' +
            '<span class="sp-sub num">' + sub + '</span></span>' +
            '<span class="sp-p delta num' + cls + '">' + fmtSigned(r.profit) + '</span></div>';
        }
        function escHtml(s){
          return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
        }
        function paint(d){
          var all = (d.rows || []).concat(d.mine ? [d.mine] : []);
          var html = all.length ? all.map(row).join('')
            : '<div class="sp-empty">아직 기록이 없습니다</div>';
          if (rankSig === html) return;
          rankSig = html;
          /* listEl이 곧 스크롤 컨테이너다(.sp-rank). innerHTML로 자식을 전부 날리면
             scrollTop이 0으로 클램프돼, 40위쯤 보고 있던 사람이 30초마다 맨 위로 튄다.
             값이 한 명만 바뀌어도 서명이 달라지므로 실제로 자주 일어난다.
             교체 전후로 스크롤 위치를 되돌려 준다. */
          var keep = listEl.scrollTop;
          listEl.innerHTML = html;
          if (keep) listEl.scrollTop = keep;
        }
        function load(){
          lastAt = Date.now();
          fetch('/api/games/${seg}/ranking')
            .then(function(r){ return r.ok ? r.json() : null; })
            .then(function(d){ if (d) paint(d); })
            .catch(function(){ /* 랭킹은 게임 진행과 무관하니 조용히 넘어간다 */ });
        }
        function isOpen(){
          var p = document.getElementById('${prefix}-rank');
          return p && p.classList.contains('on');
        }
        /* 탭이 열려 있을 때만, 창이 보일 때만, 그리고 최근에 조작이 있었을 때만 갱신한다.
           랭킹은 초 단위로 바뀌는 값이 아니라 30초로 충분하다.
           무조작 3분이면 멈추는 것은 이 프로젝트의 다른 폴링과 같은 규약이다 —
           서버에 타이머를 두지 않고 fly.io 머신이 유휴 시 잠들게 하는 설계 때문이다. */
        var IDLE_MS = 3 * 60 * 1000, lastAct = Date.now();
        function markAct(){ lastAct = Date.now(); }
        ['click', 'keydown', 'touchstart'].forEach(function(ev){
          document.addEventListener(ev, markAct, { passive: true });
        });
        document.addEventListener('visibilitychange', function(){
          if (!document.hidden) markAct();
        });
        function tick(){
          if (!isOpen() || document.hidden) return;
          if (Date.now() - lastAct > IDLE_MS) return;      // 손 뗀 지 오래됐다 — 쉬게 둔다
          if (Date.now() - lastAt >= 30000) load();
        }
        timer = setInterval(tick, 5000);
        void timer;
        window.__spRankOpen = function(){ markAct(); if (Date.now() - lastAt >= 3000) load(); };
        if (isOpen()) load();          // 지뢰찾기처럼 처음부터 열려 있는 경우
      })();`;
}

export function pts(n: number): string {
  return new Intl.NumberFormat('ko-KR').format(Math.floor(n)) + 'P';
}

export function signedPts(n: number): string {
  return (n > 0 ? '+' : '') + pts(n);
}

const REASON_LABEL: Record<string, string> = {
  attendance: '출석 체크',
  weekly_streak_bonus: '주간 개근 보너스',
  monthly_streak_bonus: '월간 개근 보너스',
  disaster_relief: '개인회생 지원금',
};

// game_type 내부 식별자(영문) → 화면에 보여줄 한글 게임명. 새 게임 추가할 때마다 여기에 등록.
const GAME_NAME_KO: Record<string, string> = {
  mines: '지뢰찾기',
  ladder: '사다리게임',
  graph: '그래프게임',
  poker: '포커 플립',
  baccarat: '바카라',
  blackjack: '블랙잭',
};

function gameNameKo(gameType: string): string {
  return GAME_NAME_KO[gameType] ?? gameType;
}

export function reasonLabel(reason: string): string {
  if (REASON_LABEL[reason]) return REASON_LABEL[reason];
  const bet = reason.match(/^game:(.+):bet$/);
  if (bet) return `${gameNameKo(bet[1])} 베팅`;
  const result = reason.match(/^game:(.+)$/);
  if (result) return `${gameNameKo(result[1])} 결과`;
  return reason;
}

export function layout(title: string, active: Tab, body: string, bodyClass = ""): string {
  const nav = TABS.map(t =>
    `<a class="tab${t.key === active ? ' active' : ''}" href="${t.href}">${t.label}</a>`
  ).join('');

  const u = _reqUser;
  // 아바타는 디스코드 프로필 사진을 쓰고, 없으면 이름 첫 글자로 대체한다
  const ini = u ? esc((u.username.trim()[0] ?? '?').toUpperCase()) : '';
  const ava = u
    ? (u.avatar ? `<img class="ava" src="${esc(u.avatar)}" alt="" width="24" height="24">` : `<span class="ava">${ini}</span>`)
    : '';
  // 효과음 켜기/끄기 — 프로필 메뉴 안이 아니라 헤더에 그대로 둔다.
  // 소리를 끄는 건 "지금 당장" 하는 동작이라 두 번 눌러 들어가면 이미 늦고,
  // 아이콘 모양이 곧 현재 상태라 메뉴를 열지 않고도 켜졌는지 알 수 있다.
  // 실제 상태 클래스(sfx-off)는 app.js가 <html>에 미리 박아두므로 첫 렌더부터 모양이 맞는다.
  const sfxBtn = `<button class="sfxbtn" id="sfxBtn" type="button" title="효과음 끄기" aria-label="효과음">
      <svg class="on" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/></svg>
      <svg class="off" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m23 9-6 6"/><path d="m17 9 6 6"/></svg>
    </button>`;

  const authBox = u
    ? `<div class="profwrap">
        ${sfxBtn}
        <button class="prof" id="profBtn" type="button" aria-haspopup="true" aria-expanded="false">
          ${ava}<span class="pname">${esc(u.username)}</span>
          ${u.role === 'admin' ? '<span class="adm">ADMIN</span>' : ''}
          <span class="pbal">${esc(pts(u.balance))}</span>
          <svg class="caret" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>
        </button>
        <div class="profmenu" id="profMenu" hidden>
          <a class="pm-item danger" href="/auth/logout">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>로그아웃
          </a>
        </div>
      </div>`
    : `<a class="loginbtn" href="/auth/login">${discordIcon(16)}디스코드 로그인</a>`;

  return `<!DOCTYPE html>
<html lang="ko" class="${esc(bodyClass)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · OD CASINO</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<!-- 브랜드용 Black Han Sans 하나만 받고, 그마저도 렌더를 막지 않게 비동기로 로드한다.
     (media="print"로 받아 두고 onload에서 all로 바꾸는 방식 — 첫 페인트가 폰트를 기다리지 않는다)
     본문·숫자는 OS 글꼴을 쓰므로 이 요청이 늦거나 실패해도 화면은 정상이다.
     예전에는 Noto Sans KR 3종까지 동기 로드해서 CSS 한 개가 340KB였고 그게 렌더를 막았다. -->
<link rel="stylesheet" media="print" onload="this.media='all'"
  href="https://fonts.googleapis.com/css2?family=Black+Han+Sans&display=swap">
<!-- CSS와 공용 스크립트는 모든 페이지에서 완전히 동일하다. 인라인이면 게임을 오갈 때마다
     44KB를 다시 받고 다시 파싱하므로 외부 파일로 빼서 브라우저 캐시에 맡긴다(?v= 로 갱신).
     스크립트를 <head>에 동기로 두는 이유: 게임 스크립트가 실행되는 시점에 window.casinoPoll을 쓴다.
     이 정의를 </body> 끝에 두었을 때는 첫 폴링이 실패해 화면이 1초 늦게 떴다. -->
<link rel="stylesheet" href="/app.css?v=${ASSET_V}">
<script src="/app.js?v=${ASSET_V}"></script>
</head>
<body>
<header>
  <div class="wrap">
    <div class="brand"><img class="logo" src="/favicon.svg" alt="" width="30" height="30">
      <b>OD CASINO</b>${authBox}</div>
    <nav>${nav}</nav>
  </div>
</header>
<main>
${body}
<div class="footer">재미로 즐기는 서버 내부 포인트 게임 · 실제 금전적 가치가 없습니다</div>
</main>
</body>
</html>`;
}
