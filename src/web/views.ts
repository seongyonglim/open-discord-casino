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
  const authBox = u
    ? `<div class="profwrap">
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
