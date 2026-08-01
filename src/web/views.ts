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
  const ini = u ? esc((u.username.trim()[0] ?? '?').toUpperCase()) : '';
  const authBox = u
    ? `<div class="prof">
        <span class="chip"></span>
        <span class="pname">${esc(u.username)}</span>
        <span class="pbal">${esc(pts(u.balance))}</span>
        <a class="logout" href="/auth/logout" title="로그아웃">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>
        </a>
      </div>`
    : `<a class="loginbtn" href="/auth/login">${discordIcon(16)}디스코드 로그인</a>`;

  return `<!DOCTYPE html>
<html lang="ko" class="${esc(bodyClass)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · OPEN 카지노</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<!-- 브랜드용 Black Han Sans 하나만 받고, 그마저도 렌더를 막지 않게 비동기로 로드한다.
     (media="print"로 받아 두고 onload에서 all로 바꾸는 방식 — 첫 페인트가 폰트를 기다리지 않는다)
     본문·숫자는 OS 글꼴을 쓰므로 이 요청이 늦거나 실패해도 화면은 정상이다.
     예전에는 Noto Sans KR 3종까지 동기 로드해서 CSS 한 개가 340KB였고 그게 렌더를 막았다. -->
<link rel="stylesheet" media="print" onload="this.media='all'"
  href="https://fonts.googleapis.com/css2?family=Black+Han+Sans&display=swap">
<style>
  :root{
    --bg:#050506; --panel:#121214; --panel2:#19191c; --line:#2a2a2e;
    --txt:#ececee; --muted:#8b8b92;
    --gold:#d4af37; --gold-hi:#f0d67a; --gold-dim:rgba(212,175,55,.35);
    --win:#2ecc71; --lose:#e5484d;
    --side-l:#4a90e2; --side-r:#e5484d;
    /* 본문·숫자는 OS에 이미 있는 글꼴만 쓴다. 웹폰트로 Noto Sans KR(400/500/700)을 받던 때는
       구글 폰트 CSS 하나가 340KB(서브셋 조각 216개, 합계 4MB)였고 그게 렌더를 막아
       페이지 본문(gzip 15KB)보다 20배 무거웠다. 브랜드용 Black Han Sans만 비동기로 받는다. */
    --display:"Black Han Sans","Malgun Gothic","Apple SD Gothic Neo",sans-serif;
    --mono:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,"Noto Sans Mono",monospace;
  }
  *{box-sizing:border-box}
  *{scrollbar-width:thin;scrollbar-color:#333338 transparent}
  *::-webkit-scrollbar{width:10px;height:10px}
  *::-webkit-scrollbar-track{background:transparent}
  *::-webkit-scrollbar-thumb{background:#2c2c31;border-radius:8px;border:2px solid transparent;background-clip:content-box}
  body{margin:0;background:var(--bg);color:var(--txt);
    background-image:radial-gradient(1000px 460px at 50% -60px, rgba(212,175,55,.10) 0%, rgba(212,175,55,0) 60%);
    font-family:"Malgun Gothic","Apple SD Gothic Neo",-apple-system,"Segoe UI",Roboto,"Noto Sans CJK KR",sans-serif;
    font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
  .num,.mono{font-family:var(--mono);font-feature-settings:"tnum"}
  a{color:inherit;text-decoration:none}
  header{position:sticky;top:0;z-index:300;background:rgba(5,5,6,.92);
    backdrop-filter:blur(8px);border-bottom:1px solid var(--line);
    box-shadow:0 1px 0 var(--gold-dim), 0 8px 24px rgba(0,0,0,.4)}
  .wrap{max-width:1000px;margin:0 auto;padding:0 16px}
  .brand{display:flex;align-items:center;gap:10px;padding:16px 0 10px}
  .brand .logo{border-radius:8px;display:block;box-shadow:0 2px 8px rgba(0,0,0,.5)}
  .brand b{font-family:var(--display);font-weight:400;font-size:22px;color:var(--gold);letter-spacing:.5px;
    display:flex;align-items:center;gap:8px}
  .brand b .suit{color:var(--gold-dim);font-size:15px}
  header nav{display:flex;gap:4px;padding-bottom:12px}
  .tab{font-family:var(--display);font-weight:400;font-size:14px;color:var(--muted);padding:8px 14px;
    border-radius:8px 8px 0 0;border-bottom:2px solid transparent;letter-spacing:.3px}
  .tab:hover{color:var(--txt)}
  .tab.active{color:var(--gold);border-bottom-color:var(--gold)}
  .prof{margin-left:auto;display:inline-flex;align-items:center;gap:9px;background:var(--panel2);
    border:1px solid var(--line);border-radius:10px;padding:6px 8px 6px 7px}
  .prof .chip{width:18px;height:18px;border-radius:50%;flex:none;
    background:radial-gradient(circle at 35% 30%, var(--gold-hi), var(--gold) 60%, #8a6d1f 100%);
    box-shadow:inset 0 0 0 2px rgba(0,0,0,.35), 0 0 0 1px rgba(212,175,55,.4)}
  .prof .pname{font-size:13px;font-weight:700;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .prof .pbal{font-family:var(--mono);font-size:13px;color:var(--gold);font-weight:600}
  .prof .logout{color:var(--muted);display:flex}
  .prof .logout:hover{color:var(--lose)}
  .loginbtn{margin-left:auto;display:inline-flex;align-items:center;gap:7px;background:#5865f2;color:#fff;
    font-size:13px;font-weight:700;line-height:1;padding:8px 13px;border-radius:10px;white-space:nowrap}
  .loginbtn:hover{background:#4752e0}
  main{max-width:1000px;margin:0 auto;padding:16px 16px 40px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;
    box-shadow:inset 0 1px 0 rgba(212,175,55,.14)}
  .card + .card{margin-top:16px}
  .card h2{margin:0 0 14px;font-family:var(--display);font-weight:400;font-size:17px;color:var(--gold);
    letter-spacing:.3px;display:flex;align-items:center;gap:8px}
  .stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px}
  .stat{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  .stat .lbl{font-size:12px;color:var(--muted);font-weight:600}
  .stat .val{font-family:var(--mono);font-size:22px;font-weight:600;margin-top:4px}
  .stat .val.gold{color:var(--gold)}
  .stat .val.hi{color:var(--win)}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th{text-align:left;color:var(--muted);font-weight:700;font-size:12px;text-transform:uppercase;
    letter-spacing:.3px;padding:8px 10px;border-bottom:1px solid var(--line)}
  td{padding:10px;border-bottom:1px solid var(--line)}
  tr:last-child td{border-bottom:none}
  .rank{font-family:var(--mono);color:var(--muted);width:36px}
  .rank.top1{color:var(--gold);font-weight:700}
  .delta.pos{color:var(--win)}
  .delta.neg{color:var(--lose)}
  .empty{color:var(--muted);font-size:13.5px;text-align:center;padding:24px 0}
  .btn{display:inline-flex;align-items:center;gap:6px;background:var(--panel2);border:1px solid var(--line);
    border-radius:10px;padding:10px 16px;font-size:13.5px;font-weight:700;color:var(--txt);cursor:pointer;
    transition:transform .08s,border-color .12s,color .12s}
  .btn:hover{border-color:var(--gold);color:var(--gold)}
  .btn:active:not(:disabled){transform:scale(.95)}
  .btn:disabled{opacity:.4;cursor:default;border-color:var(--line);color:var(--muted)}
  .btn-gold{background:linear-gradient(180deg,var(--gold-hi),var(--gold));border-color:var(--gold);color:#211a04;
    box-shadow:0 2px 10px rgba(212,175,55,.25)}
  .btn-gold:hover{background:linear-gradient(180deg,#f7e199,var(--gold-hi));color:#211a04;border-color:var(--gold-hi)}
  .btn-gold:disabled{background:var(--panel2);box-shadow:none}
  .notice{display:flex;align-items:center;gap:9px;font-size:13px;font-weight:600;border-radius:11px;
    padding:11px 14px;margin-bottom:14px}
  .notice.ok{background:rgba(46,204,113,.1);border:1px solid rgba(46,204,113,.35);color:#5fdc8b}
  .notice.err{background:rgba(229,72,77,.1);border:1px solid rgba(229,72,77,.35);color:#f0868a}
  .game-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}
  .game-card{background:var(--panel2);border:1px solid var(--line);border-radius:14px;padding:18px;
    display:flex;flex-direction:column;gap:6px;box-shadow:inset 0 1px 0 rgba(212,175,55,.1);
    transition:border-color .15s,transform .15s,background .15s,box-shadow .15s}
  /* 출시된 게임은 카드 전체가 링크다. 반응을 확실히 보이게 테두리·배경·그림자를 함께 바꾼다 —
     예전에는 2px 떠오르고 테두리만 옅게 밝아져서 마우스를 올려도 반응을 알아채기 어려웠다 */
  .game-card.ready{cursor:pointer}
  .game-card.ready:hover{border-color:var(--gold);background:#1f1f23;transform:translateY(-3px);
    box-shadow:0 10px 26px rgba(0,0,0,.5),inset 0 1px 0 rgba(212,175,55,.22)}
  .game-card.ready:active{transform:translateY(-1px)}
  .game-card.ready:hover .btn{background:var(--gold-hi);border-color:var(--gold-hi)}
  .game-card.ready:hover .icon{color:var(--gold-hi)}
  .game-card .icon{width:30px;height:30px;color:var(--gold)}
  .game-card .icon svg{width:100%;height:100%}
  .game-card h3{margin:2px 0 0;font-family:var(--display);font-weight:400;font-size:17px;letter-spacing:.3px}
  /* 설명이 남는 공간을 모두 차지하게 해서, 설명 길이가 달라도 버튼은 항상 카드 맨 아래에 정렬된다 */
  .game-card p{margin:0 0 4px;color:var(--muted);font-size:13px;flex:1}
  .game-card .btn{justify-content:center}
  .game-card .soon{display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;
    color:var(--muted);border:1px dashed #3a3a40;border-radius:10px;padding:10px 0}
  .footer{margin-top:32px;text-align:center;color:var(--muted);font-size:12px}

  @keyframes tilePop{0%{transform:scale(.5);opacity:0}55%{transform:scale(1.16)}100%{transform:scale(1);opacity:1}}
  @keyframes gridShake{10%,90%{transform:translateX(-1px)}20%,80%{transform:translateX(3px)}
    30%,50%,70%{transform:translateX(-6px)}40%,60%{transform:translateX(6px)}}
  @keyframes statBump{0%{text-shadow:0 0 0 rgba(212,175,55,0)}35%{text-shadow:0 0 16px currentColor}100%{text-shadow:0 0 0 rgba(212,175,55,0)}}
  @keyframes goldFlash{0%{box-shadow:0 0 0 0 rgba(212,175,55,.55)}100%{box-shadow:0 0 0 22px rgba(212,175,55,0)}}
  @keyframes nodePulse{0%{r:16}45%{r:21}100%{r:16}}

  /* 게임 전환 바 (게임 화면 상단) */
  .game-switch{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .gs-pill{display:inline-flex;align-items:center;gap:7px;background:var(--panel);border:1px solid var(--line);
    border-radius:10px;padding:8px 14px;font-size:13px;font-weight:700;color:var(--muted);
    transition:border-color .12s,color .12s}
  .gs-pill:hover{border-color:var(--gold-dim);color:var(--txt)}
  .gs-pill.active{border-color:var(--gold);color:var(--gold);background:rgba(212,175,55,.08)}
  .gs-ic{width:16px;height:16px;display:flex;flex:none}
  .gs-ic svg{width:100%;height:100%}

  /* 게임 공통 레이아웃 (베팅 패널 + 게임판) */
  .game-layout{display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap}
  .game-panel{width:230px;flex:none;display:flex;flex-direction:column;gap:12px}
  .game-panel .field label{display:block;font-size:12px;color:var(--muted);font-weight:600;margin-bottom:6px}
  .game-panel .bet-row{display:flex;gap:6px}
  .game-panel .bet-row input{flex:1;min-width:0}
  .game-panel .stat{padding:12px 14px}
  .game-board{flex:1;min-width:280px;display:flex;justify-content:center}
  .game-input{background:#0d0d0f;border:1px solid var(--line);border-radius:8px;color:var(--txt);
    padding:9px 11px;font-family:inherit;font-size:13.5px;outline:none}
  .game-input:focus{border-color:var(--gold)}
  .game-input:disabled{opacity:.5}
  .chip-btn{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:0 10px;height:38px;
    font-size:12px;font-weight:700;color:var(--muted);cursor:pointer;transition:transform .08s,border-color .12s,color .12s}
  .chip-btn:hover{border-color:var(--gold);color:var(--gold)}
  .chip-btn:active{transform:scale(.93)}
  .chip-btn:disabled{opacity:.35;cursor:default;transform:none;border-color:var(--line);color:var(--muted)}
  /* 게임판을 작게 유지해 베팅 컨트롤이 스크롤 없이 한 화면에 들어오게 한다 */
  .mines-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:7px;max-width:290px;width:100%}
  @media (max-width:640px){.game-panel{width:100%}.game-board{min-width:0}}

  /* 지뢰찾기 */
  .mines-grid.shake{animation:gridShake .4s}
  .mines-tile{aspect-ratio:1;border-radius:10px;background:var(--panel2);border:1px solid var(--line);
    cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;
    transition:border-color .12s,background .12s,transform .1s}
  .mines-tile svg{width:52%;height:52%}
  .mines-tile .mark{color:var(--gold-dim);width:30%;height:30%}
  .mines-tile:hover:not(:disabled){border-color:var(--gold);background:#1f1a10;transform:translateY(-1px)}
  .mines-tile:active:not(:disabled){transform:scale(.93)}
  .mines-tile:disabled{cursor:default}
  /* 안전 칸은 금화 — 초록 보석보다 "돈을 벌었다"는 신호가 직관적이다 */
  .mines-tile.safe{background:rgba(212,175,55,.14);border-color:var(--gold);color:var(--gold-hi);
    animation:tilePop .3s cubic-bezier(.34,1.56,.64,1)}
  .mines-tile.mine{background:rgba(229,72,77,.16);border-color:var(--lose);color:var(--lose);
    animation:tilePop .3s cubic-bezier(.34,1.56,.64,1)}

  /* 사다리게임 */
  .ladder-board{width:100%;display:flex;justify-content:center}
  .ladder-svg{max-width:100%}
  .ladder-svg.shake{animation:gridShake .4s}
  .ladder-line{stroke:var(--line);stroke-width:2}
  .ladder-rung{stroke:var(--gold-dim);stroke-width:3;stroke-linecap:round}
  .ladder-node{fill:var(--panel2);stroke-width:1.5;transition:fill .2s,stroke-width .2s}
  .ladder-node.side-l{stroke:var(--side-l)}
  .ladder-node.side-r{stroke:var(--side-r)}
  .ladder-node.parity-odd{stroke:var(--gold)}
  .ladder-node.parity-even{stroke:#c77dff}
  .ladder-node.side-l.hit{fill:rgba(74,144,226,.9);stroke-width:3;animation:nodePulse .5s ease-out}
  .ladder-node.side-r.hit{fill:rgba(229,72,77,.9);stroke-width:3;animation:nodePulse .5s ease-out}
  .ladder-node.parity-odd.hit{fill:rgba(212,175,55,.9);stroke-width:3;animation:nodePulse .5s ease-out}
  .ladder-node.parity-even.hit{fill:rgba(199,125,255,.85);stroke-width:3;animation:nodePulse .5s ease-out}
  .ladder-label{font-size:12px;font-weight:700;pointer-events:none;user-select:none}
  .ladder-label.side-l{fill:var(--side-l)}
  .ladder-label.side-r{fill:var(--side-r)}
  .ladder-label.parity-odd{fill:var(--gold)}
  .ladder-label.parity-even{fill:#c77dff}
  .ladder-cap{fill:var(--muted);font-size:11px;font-weight:700;letter-spacing:2px;
    pointer-events:none;user-select:none}
  .ladder-trail{stroke:var(--gold);stroke-width:4;stroke-linecap:round;opacity:.55}
  .ladder-token{fill:var(--gold);stroke:#000;stroke-width:1;transition:cx .28s ease,cy .28s ease;
    filter:drop-shadow(0 0 5px rgba(212,175,55,.8))}
  .ladder-token.win{fill:var(--win)}
  .ladder-token.lose{fill:var(--lose)}
  .side-l-text{color:var(--side-l);font-weight:700}
  .side-r-text{color:var(--side-r);font-weight:700}

  /* 보드 무대 위에 겹쳐 표시하는 상태 배지 (카운트다운 등). 게임판 요소와 겹치지 않게 우측 상단에 둔다. */
  .stage-status{position:absolute;top:10px;right:10px;font-family:var(--mono);font-size:12px;
    color:var(--muted);background:rgba(20,20,24,.85);border:1px solid var(--line);
    border-radius:8px;padding:5px 10px;pointer-events:none}
  .predict-row{display:flex;gap:6px;align-items:center}
  .predict-lbl{width:34px;flex:none;font-size:12px;color:var(--muted);font-weight:600}
  .toggle-row{display:flex;gap:6px}
  .toggle-btn{flex:1;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px 0;
    font-size:13px;font-weight:700;color:var(--muted);cursor:pointer;transition:all .12s}
  .toggle-btn:hover{border-color:var(--gold);color:var(--gold)}
  .toggle-btn.side-l.active{background:var(--side-l);border-color:var(--side-l);color:#fff}
  .toggle-btn.side-r.active{background:var(--side-r);border-color:var(--side-r);color:#fff}
  .toggle-btn:disabled{opacity:.4;cursor:default}

  /* 사다리 출목표 — 출발/도착 2행으로 나눠 각 칸에 좌·우를 글자로 표기 (칩이 작아 비어 보이던 문제 해결) */
  .bead{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
  .bead-row{display:flex;align-items:center;gap:5px;overflow-x:auto;scrollbar-width:none}
  .bead-row::-webkit-scrollbar{display:none}
  .bead-lbl{width:30px;flex:none;font-size:11px;font-weight:700;color:var(--muted)}
  .bead-cell{width:24px;height:24px;flex:none;border-radius:6px;display:flex;align-items:center;
    justify-content:center;font-size:11px;font-weight:700;border:1px solid var(--line)}
  .bead-cell.l{background:rgba(74,144,226,.18);border-color:rgba(74,144,226,.5);color:var(--side-l)}
  .bead-cell.r{background:rgba(229,72,77,.18);border-color:rgba(229,72,77,.5);color:var(--side-r)}
  /* 홀짝은 좌우(파랑/빨강)와 구분되도록 골드/보라 계열로 */
  .bead-cell.odd{background:rgba(212,175,55,.18);border-color:var(--gold-dim);color:var(--gold)}
  .bead-cell.even{background:rgba(199,125,255,.16);border-color:rgba(199,125,255,.45);color:#c77dff}
  /* 홀/짝 글자색은 출목표 셀과 같게 — 홀은 골드, 짝은 보라 */
  .parity-text{font-weight:700}
  .parity-text.odd{color:var(--gold)}
  .parity-text.even{color:#c77dff}
  .toggle-btn.parity-odd:hover,.toggle-btn.parity-even:hover{border-color:var(--gold);color:var(--gold)}
  .toggle-btn.parity-odd.active{background:var(--gold);border-color:var(--gold);color:#211a04}
  .toggle-btn.parity-even.active{background:#c77dff;border-color:#c77dff;color:#1e0a2e}

  .bet-feed{max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:2px}

  /* 게임 화면 공통 셸 — [히스토리 → 보드] + 하단 베팅 컨트롤, 우측 사이드 패널 (모든 게임 동일 구조) */
  .game-shell{display:flex;gap:16px;align-items:flex-start}
  .game-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:12px}
  .game-side{width:290px;flex:none;padding:0;overflow:hidden}
  /* 사이드 패널이 없는 1인 게임(지뢰찾기)은 가운데 정렬로 폭을 제한해 허전해 보이지 않게 한다 */
  .game-shell.solo{max-width:620px;margin:0 auto}
  @media (max-width:900px){.game-shell{flex-direction:column}.game-side{width:100%}}

  .hist-row{display:flex;gap:5px;overflow-x:auto;padding-bottom:5px;margin-bottom:10px;
    scrollbar-width:none}
  .hist-row::-webkit-scrollbar{display:none}
  .ch-chip{flex:none;font-family:var(--mono);font-size:11.5px;font-weight:600;padding:3px 7px;
    border-radius:6px;border:1px solid var(--line);white-space:nowrap}
  .ch-chip.low{color:#7f8794;background:rgba(127,135,148,.1)}
  .ch-chip.mid{color:var(--gold);background:rgba(212,175,55,.1);border-color:var(--gold-dim)}
  .ch-chip.high{color:#c77dff;background:rgba(199,125,255,.12);border-color:rgba(199,125,255,.4)}
  .ch-chip.bust{color:var(--lose);background:rgba(229,72,77,.12);border-color:rgba(229,72,77,.4)}

  /* 보드 무대 (게임판이 놓이는 어두운 영역) — 크래시/사다리 공용 */
  .board-stage{position:relative;width:100%;background:#0c0c0e;border:1px solid var(--line);
    border-radius:12px;overflow:hidden;display:flex;align-items:center;justify-content:center;
    min-height:216px;padding:10px 0}
  .crash-stage{position:relative;width:100%;background:#0c0c0e;border:1px solid var(--line);
    border-radius:12px;overflow:hidden}
  .crash-stage.crashed{border-color:rgba(229,72,77,.45)}
  .crash-graph{display:block;width:100%;height:auto}
  .cg-line{stroke:#1e1e22;stroke-width:1}
  .cg-lbl{fill:#6f6f77;font-size:11px;font-family:var(--mono)}
  .crash-curve{fill:none;stroke:var(--win);stroke-width:3;stroke-linejoin:round;stroke-linecap:round}
  .crash-area{fill:rgba(46,204,113,.13);stroke:none}
  .crash-stage.crashed .crash-curve{stroke:var(--lose)}
  .crash-stage.crashed .crash-area{fill:rgba(229,72,77,.13)}
  .crash-center{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2;
    text-align:center;pointer-events:none}
  .crash-label{display:none;font-size:12px;font-weight:800;letter-spacing:2px;color:var(--lose);margin-bottom:2px}
  .crash-betlabel{display:none;font-size:13px;font-weight:700;color:var(--muted);margin-bottom:2px}
  .crash-multi{font-family:var(--mono);font-size:52px;font-weight:600;color:var(--txt);line-height:1.1;
    text-shadow:0 2px 14px rgba(0,0,0,.85)}
  .crash-multi.running{color:var(--win)}
  .crash-multi.betting{color:var(--win)}
  .crash-multi.crashed{color:var(--lose);animation:statBump .4s ease}
  .crash-tip{fill:var(--win)}
  .crash-stage.crashed .crash-tip{fill:var(--lose)}
  .crash-status{font-family:var(--mono);font-size:12px;color:var(--muted);margin-top:4px}
  @media (max-width:640px){.crash-multi{font-size:38px}}

  .game-controls{display:flex;flex-direction:column;gap:11px}
  .mode-tabs{display:flex;gap:8px}
  .mode-tab{flex:1;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:11px 0;
    font-size:13.5px;font-weight:700;color:var(--muted);cursor:pointer;transition:all .12s}
  .mode-tab:hover:not(:disabled){color:var(--txt)}
  .mode-tab.active{background:#0d0d0f;border-color:var(--gold);color:var(--gold)}
  .mode-tab:disabled{opacity:.5;cursor:default}
  .field-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media (max-width:640px){.field-grid{grid-template-columns:1fr}}
  .field-grid .field label{display:block;font-size:12px;color:var(--muted);font-weight:600;margin-bottom:6px}
  .field-grid .bet-row{display:flex;gap:6px}
  .field-grid .bet-row input{flex:1;min-width:0}
  .quick-row{display:flex;gap:6px;margin-top:6px}
  .chip-btn.wide{flex:1;padding:0}
  .btn-primary{background:var(--win);border-color:var(--win);color:#06240f;font-size:15px;padding:14px 0}
  .btn-primary:hover{background:#42d886;border-color:#42d886;color:#06240f}
  .btn-primary:disabled{background:var(--panel2);border-color:var(--line);color:var(--muted)}
  .game-action{width:100%;justify-content:center}
  /* 배당·예상획득을 큰 카드 대신 한 줄로 압축 (베팅 버튼이 스크롤 없이 보이도록) */
  .payout-line{display:flex;justify-content:space-between;gap:12px;background:var(--panel2);
    border:1px solid var(--line);border-radius:10px;padding:10px 14px;font-size:12.5px;color:var(--muted)}
  .payout-line b{font-family:var(--mono);font-size:15px;font-weight:600;margin-left:6px}
  .payout-line .gold{color:var(--gold)}
  .payout-line .hi{color:var(--win)}
  .game-msg{color:var(--muted);font-size:13.5px;margin:0;min-height:20px}

  .side-head{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;
    border-bottom:1px solid var(--line);font-size:13px;font-weight:700}
  .side-head .num{font-family:var(--mono);color:var(--gold)}
  .cash-out{color:var(--win);font-weight:700}
  .cash-pending{color:var(--muted)}
  .cash-bust{color:var(--lose)}

  /* 포커 플립 */
  .poker-table{background:radial-gradient(120% 100% at 50% 0%, #143024 0%, #0c1a14 70%);
    border:1px solid var(--line);border-radius:14px;padding:18px 16px;margin-bottom:10px}
  .poker-seats{display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center}
  .seat{text-align:center;min-width:104px}
  .seat-name{font-size:11.5px;font-weight:800;letter-spacing:1.2px;margin-bottom:8px}
  .seat-name.master{color:#5fb0ff}
  .seat-name.shark{color:#ff8f6b}
  .seat-cat{font-size:11.5px;color:var(--muted);margin-top:9px;min-height:16px}
  .seat-cat.win{color:var(--win);font-weight:700}
  .hand,.board{display:flex;gap:7px;justify-content:center}
  .board-wrap{text-align:center}
  .poker-status{font-family:var(--mono);font-size:12.5px;color:var(--muted);margin-bottom:11px}
  /* 카드 그림은 미리 만들어 둔 SVG(public/cards)를 그대로 쓴다 — 크기와 상관없이 선명하다 */
  .pcard{display:block;width:48px;height:72px;border-radius:6px;flex:none;
    box-shadow:0 3px 8px rgba(0,0,0,.5);animation:cardFlip .32s cubic-bezier(.3,.8,.35,1)}
  /* 뒷면은 back.svg 이미지지만, 이미지가 아직 안 왔거나 실패해도 투명하게 비지 않도록
     back.svg와 같은 남색 그라디언트를 배경으로 깔아 둔다.
     border 대신 background만 쓴다 — box-sizing:border-box라 border를 주면 이미지가 2px 줄어
     앞면 카드와 크기가 미묘하게 달라진다. */
  .pcard.back{animation:none;background:linear-gradient(160deg,#2a3a63,#141b30)}
  @keyframes cardFlip{
    from{transform:rotateY(-88deg) scale(.92);opacity:.25}
    to{transform:none;opacity:1}
  }
  /* 새 라운드 딜링 — 딜러 자리(테이블 상단 중앙)에서 각 자리로 날아와 놓인다 */
  @keyframes cardDealIn{
    from{transform:translate(var(--dfx),var(--dfy)) rotate(-12deg) scale(.8);opacity:0}
    30%{opacity:1}
    to{transform:none;opacity:1}
  }
  .pcard.deal-in{animation:cardDealIn .3s cubic-bezier(.3,.85,.35,1) forwards}
  @media (max-width:640px){
    .poker-table{padding:16px 10px}
    .poker-seats{grid-template-columns:auto 1fr auto;gap:8px}
    .seat{min-width:78px}
    .hand,.board{gap:4px}
    .pcard{width:34px;height:51px;border-radius:5px}
  }

  .market-grid{display:flex;flex-direction:column;gap:9px}
  .market-row{display:grid;grid-template-columns:repeat(2,1fr);gap:9px}
  .market-row.bucket-row{grid-template-columns:repeat(5,1fr)}
  @media (max-width:760px){.market-row.bucket-row{grid-template-columns:repeat(2,1fr)}}
  .market{position:relative;background:#12281d;border:1px solid #1f4230;border-radius:11px;
    padding:0 0 8px;cursor:pointer;text-align:center;transition:border-color .12s,transform .08s;
    display:flex;flex-direction:column;overflow:hidden}
  .market:hover:not(.disabled){border-color:var(--gold);transform:translateY(-1px)}
  .market:active:not(.disabled){transform:scale(.985)}
  .market.disabled{opacity:.5;cursor:default}
  /* 상단 띠 — 왼쪽에 이 시장에 걸린 총액, 오른쪽에 배당 */
  .m-top{display:flex;align-items:center;justify-content:space-between;gap:6px;
    padding:4px 7px;background:rgba(0,0,0,.34);border-bottom:1px solid rgba(255,255,255,.06)}
  .m-total{font-family:var(--mono);font-size:11px;font-weight:700;color:#cfe3d6;
    background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.1);border-radius:5px;
    padding:0 5px;min-width:34px;text-align:center}
  .m-top .m-odds{font-family:var(--mono);font-size:19px;font-weight:600;color:var(--gold);line-height:1.15}
  .market-row.bucket-row .m-top .m-odds{font-size:16.5px}
  /* 중앙 코인 더미 — 칩이 쌓일 자리. 세로로 넉넉해야 칩이 여러 줄 쌓여도 잘리지 않는다 */
  .m-pile{position:relative;height:78px;flex:none}
  .market-row.bucket-row .m-pile{height:66px}
  .m-body{padding:6px 8px 0;display:flex;flex-direction:column;gap:6px;flex:1;justify-content:flex-end}
  .market .m-label{font-size:12px;color:#cfe3d6;line-height:1.25;font-weight:600}
  .market-row.bucket-row .m-label{font-size:11px;color:#a9c4b5;font-weight:500}
  .market .m-sub{font-size:10.5px;color:#7f9a8b}
  .m-dots{display:flex;gap:3px;justify-content:center}
  .m-dots .dot{width:8px;height:8px;border-radius:50%;background:#20362a;
    border:1px solid rgba(255,255,255,.1)}
  .m-dots .dot.hit{background:radial-gradient(circle at 35% 30%,#ff7b7b,#d0202a);
    border-color:#ff9a9a;box-shadow:0 0 5px rgba(229,72,77,.75)}
  .m-drought{font-family:var(--mono);font-size:10px;color:var(--gold-dim)}
  .market.m-master{background:#12233a;border-color:#22406b}
  .market.m-shark{background:#33201a;border-color:#5e3527}
  .market.hit{border-color:var(--win);box-shadow:0 0 0 1px var(--win) inset}
  .market.miss{opacity:.42}

  /* 칩 스프라이트 — 동전은 찌그러지지 않은 정원(正圓), 골드바는 그보다 확실히 크게.
     (width/height를 같은 값으로 고정하고 min-width를 명시해, 버튼 쪽 .coin 규칙 같은 게
      섞여 들어와도 타원으로 눌리지 않게 한다) */
  .pchip{position:absolute;display:flex;align-items:center;justify-content:center;
    font-family:var(--mono);font-weight:700;color:#4a3608;
    text-shadow:0 1px 0 rgba(255,255,255,.4);pointer-events:none;flex:none}
  .pchip.c-coin{width:21px;height:21px;min-width:21px;margin-left:-10.5px;border-radius:50%;font-size:8px;
    background:radial-gradient(circle at 36% 28%,#fff6d8 0%,#f0cf74 42%,#c79a2c 78%,#9a7420 100%);
    border:1px solid #f7dd96;
    box-shadow:0 2px 3px rgba(0,0,0,.5),inset 0 0 0 2px rgba(255,255,255,.22),inset 0 -2px 2px rgba(120,88,20,.35)}
  .pchip.c-bar{width:40px;height:24px;min-width:40px;margin-left:-20px;border-radius:4px;font-size:11px;
    background:linear-gradient(165deg,#fff4c8 0%,#f2d074 36%,#c99b2c 72%,#8f6a18 100%);
    border:1px solid #ffe9a0;
    box-shadow:0 3px 0 #7a5c14,0 5px 6px rgba(0,0,0,.55),inset 0 1.5px 0 rgba(255,255,255,.55)}
  .pchip.mine.c-coin{box-shadow:0 2px 0 #8a6a1e,0 3px 4px rgba(0,0,0,.5),0 0 0 1.5px var(--gold),0 0 8px rgba(212,175,55,.7)}
  .pchip.mine.c-bar{box-shadow:0 3px 0 #7a5c14,0 5px 6px rgba(0,0,0,.55),0 0 0 1.5px var(--gold),0 0 9px rgba(212,175,55,.7)}
  /* 다른 사람 칩 — 아래에서 스윽 올라온다 */
  @keyframes chipDrop{
    from{transform:translate(0,30px) scale(.55);opacity:0}
    60%{opacity:1}
    to{transform:none;opacity:1}
  }
  .pchip.drop{animation:chipDrop .3s cubic-bezier(.22,.9,.3,1.25)}
  /* 내가 누른 칩 — 눌린 코인 버튼 자리에서 출발해 상자 안으로 밀려 들어온다.
     상자에 overflow:hidden이 걸려 있어 상자 밖 구간이 잘려 보이지 않으므로,
     회수 연출과 마찬가지로 화면 전체 레이어에 복제본을 띄워 날린다.
     날아가는 동안 원본은 pending으로 숨겨 두고, 도착하면 드러낸다 */
  @keyframes chipToss{
    from{transform:translate(var(--fx),var(--fy)) scale(var(--fs));opacity:.85}
    30%{opacity:1}
    to{transform:none;opacity:1}
  }
  .pchip.pending{opacity:0}
  .pchip.toss{animation:chipToss .36s cubic-bezier(.25,.8,.3,1.02) forwards}
  /* 적중 시 — 이긴 상자의 칩들이 화면 아래 중앙으로 빨려 들어간다.
     상자에 overflow:hidden이 걸려 있어 원본은 밖으로 못 나가므로,
     화면 전체를 덮는 레이어에 복제본을 띄워 날린다 */
  /* 포커 플립만 참가자 패널이 붙어서 폭이 더 필요하다 — 보드 폭을 지키기 위해 이 화면만 넓게 쓴다 */
  .poker-wide main{max-width:1320px}
  .poker-wide header .wrap{max-width:1320px}

  /* 참가자 패널 — 디스코드 아바타 · 닉네임 · 보유 포인트. 칩이 여기서 출발하고 여기로 돌아온다 */
  .roster{display:flex;flex-direction:column;gap:6px;max-height:520px;overflow-y:auto}
  .rw{display:flex;align-items:center;gap:9px;padding:7px 8px;border-radius:9px;
    background:var(--panel2);border:1px solid var(--line);transition:border-color .15s}
  .rw.me{border-color:var(--gold-dim);background:rgba(212,175,55,.06)}
  .rw.won{border-color:var(--win)}
  .rw-av{width:34px;height:34px;border-radius:50%;flex:none;object-fit:cover;
    background:var(--panel);border:1px solid var(--line);display:flex;align-items:center;
    justify-content:center;font-weight:700;font-size:14px;color:var(--gold);overflow:hidden}
  /* 닉네임과 보유 포인트를 위아래로 분리 — 한 줄에 붙어 있으면 읽기 어렵다 */
  .rw-mid{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
  .rw-name{display:block;font-size:13px;font-weight:600;line-height:1.15;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rw-bal{display:block;font-family:var(--mono);font-size:12px;color:var(--gold);line-height:1.15}
  .rw-bet{display:flex;flex-direction:column;align-items:flex-end;gap:3px;
    font-family:var(--mono);font-size:12px;color:var(--muted);text-align:right;flex:none}
  .rw-bet .pos{color:var(--win);font-weight:700}
  /* 게임별 정보(사다리 예측 / 크래시 캐시아웃 배율)와 베팅액을 위아래로 */
  .rw-tag{font-size:12px;line-height:1.15}
  .rw-amt{font-size:11.5px;line-height:1.15}
  .rw-bal.up{animation:balUp .5s ease}
  .rw-bal.down{animation:balDown .5s ease}
  @keyframes balUp{0%{transform:scale(1)}30%{transform:scale(1.18);color:var(--win)}100%{transform:scale(1)}}
  @keyframes balDown{0%{transform:scale(1)}30%{transform:scale(.9);color:var(--lose)}100%{transform:scale(1)}}

  .chip-fly-layer{position:fixed;inset:0;pointer-events:none;z-index:500}
  @keyframes chipFly{
    0%{transform:none;opacity:1}
    18%{transform:translate(0,-10px) scale(1.12);opacity:1}
    70%{opacity:1}
    100%{transform:translate(var(--tx),var(--ty)) scale(.5);opacity:0}
  }
  .pchip.fly{animation:chipFly .66s cubic-bezier(.45,.02,.3,1) forwards}

  /* 칩과 Clear Screen을 한 줄에 둔다 (.game-controls는 네 게임이 공유하는 세로 배치라
     포커에서만 가로로 뒤집는다). 칩은 남는 폭에 고르게 퍼지고 오른쪽에 Clear 자리만 남긴다.
     안내 문구는 넣지 않는다 — 떴다 사라질 때마다 칩 위치가 밀린다. */
  .poker-controls{flex-direction:row;align-items:center;gap:14px;padding:12px 16px}
  .poker-controls .coin-row{flex:1 1 auto}
  .poker-controls .btn{flex:none}
  /* 폭이 좁으면 칩 6개 + 버튼이 한 줄에 안 들어가므로 접히게 둔다 */
  @media (max-width:720px){
    .poker-controls{flex-wrap:wrap}
    .poker-controls .game-msg{order:3;flex-basis:100%;text-align:left}
  }

  /* 세로가 짧은 화면(720p 노트북 등)에서만 한 단계 축소 — 베팅 버튼이 접히지 않도록.
     넓은 화면에서는 위의 큰 사이즈를 그대로 쓴다 */
  @media (max-height:820px){
    .card{padding:11px}
    .poker-controls{padding:9px 13px;gap:10px}
    .poker-table{padding:9px 14px}
    .pcard{width:42px;height:63px}
    .pcard .pr{font-size:17px}
    .pcard .ps{font-size:15px}
    .hist-row{padding-bottom:3px;margin-bottom:7px}
    .market-grid,.market-row{gap:7px}
    .market{padding-bottom:5px}
    .m-top{padding:2px 6px}
    .m-top .m-odds{font-size:17px}
    .market-row.bucket-row .m-top .m-odds{font-size:15px}
    .m-pile{height:40px}
    .market-row.bucket-row .m-pile{height:36px}
    .m-body{padding-top:2px;gap:2px}
    .coin{height:36px}
    .coin .face{font-size:11px}
    .coin.kind-coin .face{width:34px;height:34px}
    .coin.kind-bar .face{width:44px;height:24px}
  }

  .coin-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  /* 하위 3단은 동전, 상위 2단은 골드바 — 실물 칩을 집어 올리는 느낌 */
  .coin{flex:1;min-width:56px;height:46px;border:none;background:none;padding:0;cursor:pointer;
    display:flex;align-items:center;justify-content:center;transition:transform .1s}
  .coin:hover{transform:translateY(-2px)}
  .coin:active{transform:scale(.94)}
  .coin .face{display:flex;align-items:center;justify-content:center;
    font-family:var(--mono);font-weight:700;font-size:12.5px;color:#4a3608;
    text-shadow:0 1px 0 rgba(255,255,255,.4);filter:saturate(.35) brightness(.62);transition:filter .12s}
  .coin.active .face{filter:none}
  .coin.kind-coin .face{width:42px;height:42px;border-radius:50%;
    background:radial-gradient(circle at 34% 28%,#ffe9a3 0%,#e6bd52 45%,#a9812a 100%);
    border:2.5px solid #f5d98a;box-shadow:0 2px 5px rgba(0,0,0,.55),inset 0 0 0 3px rgba(255,255,255,.18)}
  .coin.kind-bar .face{width:52px;height:30px;border-radius:4px;
    background:linear-gradient(160deg,#fff0b8 0%,#f0cd66 38%,#c99b2c 70%,#8f6a18 100%);
    border:1.5px solid #ffe9a0;box-shadow:0 3px 6px rgba(0,0,0,.6),inset 0 1.5px 0 rgba(255,255,255,.5)}
  .coin.active .face{box-shadow:0 2px 6px rgba(0,0,0,.55),0 0 0 3px var(--gold),0 0 14px rgba(212,175,55,.55)}

  /* ── 로그인 화면 ─────────────────────────────────────────────
     로그인 전에는 보여줄 콘텐츠가 없어서, 카드 하나를 위에 붙여두면 아래가 텅 빈다.
     화면 높이를 다 써서 가운데에 세로로 세운다. login-page 클래스가 붙은 페이지에서만 적용. */
  .login-page main{display:flex;align-items:center;justify-content:center;
    min-height:calc(100vh - 190px);padding-top:0}
  .login-page .tabs{display:none}          /* 로그인 전에는 탭 이동이 의미가 없다 */
  .login-page .loginbtn{display:none}      /* 화면 가운데 버튼과 중복이라 헤더 쪽은 감춘다 */
  .login-hero{text-align:center;max-width:460px;width:100%}
  .login-mark{width:64px;height:64px;margin:0 auto 18px;display:flex;align-items:center;justify-content:center;
    background:var(--panel);border:1px solid var(--line);border-radius:18px;
    box-shadow:0 10px 30px rgba(0,0,0,.55)}
  .login-mark svg{width:38px;height:38px}
  .login-title{font-family:'Black Han Sans',sans-serif;font-weight:400;
    font-size:40px;line-height:1.15;letter-spacing:.5px;margin:0 0 10px;color:var(--gold)}
  .login-title span{color:var(--txt)}
  .login-sub{color:var(--muted);font-size:14px;line-height:1.6;margin:0 0 26px}
  /* 디스코드 브랜드 색(blurple) — 어느 서비스로 로그인하는지 한눈에 보이게 */
  .login-cta{display:inline-flex;align-items:center;justify-content:center;gap:10px;
    width:100%;max-width:300px;padding:15px 22px;border-radius:12px;
    background:#5865f2;color:#fff;font-weight:700;font-size:15.5px;text-decoration:none;
    box-shadow:0 8px 22px rgba(88,101,242,.34);transition:transform .12s,background .12s,box-shadow .12s}
  .login-cta:hover{background:#4752e0;transform:translateY(-2px);box-shadow:0 12px 28px rgba(88,101,242,.44)}
  .login-cta:active{transform:translateY(0) scale(.99)}
  .login-note{color:var(--muted);font-size:12.5px;margin:14px 0 0}
  .login-games{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:30px}
  .login-game{display:inline-flex;align-items:center;gap:6px;
    padding:7px 12px;border:1px solid var(--line);border-radius:999px;
    background:var(--panel);color:var(--muted);font-size:12.5px}
  .login-game svg{width:14px;height:14px;color:var(--gold)}
  @media (max-width:640px){
    .login-title{font-size:32px}
    .login-page main{min-height:calc(100vh - 160px)}
  }

  .bump{animation:statBump .3s ease}
  .gold-flash{animation:goldFlash .6s ease-out}
</style>
</head>
<body>
<header>
  <div class="wrap">
    <div class="brand"><img class="logo" src="/favicon.svg" alt="" width="30" height="30">
      <b><span class="suit">♠</span>OPEN 카지노<span class="suit">♦</span></b>${authBox}</div>
    <nav>${nav}</nav>
  </div>
</header>
<main>
${body}
<div class="footer">재미로 즐기는 서버 내부 포인트 게임 · 실제 금전적 가치가 없습니다</div>
</main>
<script>
/* 승리 효과음 — 외부 음원 파일 없이 Web Audio로 합성한 짧고 조용한 2음 차임.
   브라우저 자동재생 정책 때문에 첫 사용자 조작 시점에 오디오 컨텍스트를 미리 열어두고(unlock),
   이후 타이머로 공개되는 결과(사다리 등)에서도 소리가 나도록 한다. 실패하면 조용히 무시. */
(function(){
  var ctx = null;
  function ac(){
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch(e) { return null; }
    }
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch(e){} }
    return ctx;
  }
  function tone(c, freq, at, dur, peak, type){
    var o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(c.destination);
    o.start(at); o.stop(at + dur + 0.02);
  }
  // 짧은 노이즈 버스트를 저역 필터로 눌러 "퍽" 하는 가벼운 폭발음을 만든다 (시끄럽지 않게 짧게 감쇠)
  function boomAt(c, at, level, pitch){
    var dur = 0.32;
    var buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.2);
    }
    var src = c.createBufferSource(); src.buffer = buf;
    var lp = c.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900 * (pitch || 1), at);
    lp.frequency.exponentialRampToValueAtTime(140, at + dur);
    var g = c.createGain();
    g.gain.setValueAtTime(Math.max(0.005, level), at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(lp); lp.connect(g); g.connect(c.destination);
    src.start(at); src.stop(at + dur);
  }
  // 실제 녹음 샘플 (Kenney Casino Audio, CC0). 합성음보다 훨씬 자연스러워서 이쪽을 우선 쓰고,
  // 로딩 실패하거나 아직 안 받아졌으면 아래 합성음으로 대체한다.
  var sfxBuf = {};
  var SFX_EXT = { 'coin-insert':'wav', 'card-shuffle':'wav', 'win-fanfare':'wav',
                  'card-flip':'mp3', 'card-deal':'mp3',
                  'coin-gain':'mp3', 'mine-coin':'mp3', 'explode':'mp3' };
  // 원본이 길어서 그대로 쓰면 연달아 울릴 때 겹쳐 뭉개지는 음원은 최대 길이를 정해 잘라 쓴다
  var SFX_MAX = { 'explode': 0.4, 'mine-coin': 0.6, 'card-flip': 0.5, 'card-deal': 0.35 };

  // 음원 앞뒤의 무음을 잘라낸다.
  // 앞 무음이 남아 있으면 눌러도 소리가 그만큼 늦게 나서 반응이 굼떠 보이고,
  // 뒤 무음은 동시 재생 수만 잡아먹는다. 끝은 짧게 페이드해 뚝 끊기는 소리를 막는다.
  function trimSilence(c, buf, maxSec){
    var ch = buf.numberOfChannels, len = buf.length, k, i;
    var peak = 0;
    for (k = 0; k < ch; k++) {
      var d = buf.getChannelData(k);
      for (i = 0; i < len; i++) { var v = d[i] < 0 ? -d[i] : d[i]; if (v > peak) peak = v; }
    }
    if (!peak) return buf;
    var thr = peak * 0.02, start = len, end = 0;
    for (k = 0; k < ch; k++) {
      var s = buf.getChannelData(k);
      for (i = 0; i < len; i++) { if ((s[i] < 0 ? -s[i] : s[i]) > thr) { if (i < start) start = i; break; } }
      for (i = len - 1; i >= 0; i--) { if ((s[i] < 0 ? -s[i] : s[i]) > thr) { if (i > end) end = i; break; } }
    }
    if (start >= end) return buf;
    var sr = buf.sampleRate;
    start = Math.max(0, start - Math.round(sr * 0.005));   // 시작 직전 아주 살짝 여유
    end = Math.min(len - 1, end + Math.round(sr * 0.04));  // 여운은 조금 남긴다
    // 길이 상한이 있으면 앞부분만 남기고 잘라낸다 (연달아 재생될 소리는 짧아야 겹쳐도 안 뭉개진다)
    if (maxSec) end = Math.min(end, start + Math.round(sr * maxSec) - 1);
    var n = end - start + 1;
    if (n >= len && !maxSec) return buf;

    var out = c.createBuffer(ch, n, sr);
    // 상한 때문에 중간을 잘랐으면 페이드를 길게 줘 뚝 끊기지 않게 한다
    var fade = Math.min(Math.round(sr * (maxSec ? 0.08 : 0.02)), n);
    for (k = 0; k < ch; k++) {
      var o = out.getChannelData(k);
      o.set(buf.getChannelData(k).subarray(start, end + 1));
      for (i = 0; i < fade; i++) o[n - fade + i] *= 1 - i / fade;
    }
    return out;
  }

  function loadSfx(name){
    if (sfxBuf[name] !== undefined) return;
    var c = ac(); if (!c) return;
    sfxBuf[name] = null; // 로딩 중
    fetch('/sfx/' + name + '.' + (SFX_EXT[name] || 'ogg') + '?v=${ASSET_V}')
      .then(function(r){ return r.ok ? r.arrayBuffer() : Promise.reject(); })
      .then(function(b){ return c.decodeAudioData(b); })
      .then(function(buf){ sfxBuf[name] = trimSilence(c, buf, SFX_MAX[name]); })
      .catch(function(){ sfxBuf[name] = false; });
  }
  // 칩을 올리는 동작은 단위와 상관없이 같은 "동전 넣는" 소리로 통일한다.
  // (소리가 두 종류로 갈리면 같은 동작인데 다른 효과음처럼 들린다)
  var SFX_SETS = {
    coin: ['coin-insert'],      // 칩 올리기
    gain: ['coin-gain'],        // 포커 회수 · 지뢰찾기 캐시아웃
    fanfare: ['win-fanfare'],   // 그래프·사다리 승리 (게임마다 승리음이 다르다)
    minecoin: ['mine-coin'],
    explode: ['explode'],
    shuffle: ['card-shuffle'],  // 새 라운드 셔플
    deal: ['card-deal'],        // 카드 한 장 배분
    card: ['card-flip'],        // 보드 카드 공개
  };
  // 페이지가 쓰지도 않는 음원까지 받으면 WAV가 커서 낭비가 크다.
  // 각 게임 페이지가 window.__SFX_NEED__ 로 필요한 종류만 선언한다 (없으면 전부).
  function preloadSfx(){
    var need = window.__SFX_NEED__;
    var keys = (need && need.length) ? need : Object.keys(SFX_SETS);
    keys.forEach(function(k){ (SFX_SETS[k] || []).forEach(loadSfx); });
  }
  // 같은 소리만 반복되면 기계적으로 들려서 변형 중 하나를 무작위로 고른다.
  // 칩을 연타하면 1초 넘는 소리가 겹겹이 쌓여 지저분해지므로, 종류별로 동시에 울리는
  // 개수를 제한하고 넘치면 가장 오래된 것부터 끊는다.
  // 지뢰 연쇄 폭발은 90ms 간격으로 최대 5번 울리므로 그만큼 동시 재생을 허용한다
  var VOICES = { explode: 5 };
  var DEFAULT_VOICES = 3;
  var playing = {};
  function playSample(set, gain){
    var c = ac(); if (!c) return false;
    var names = SFX_SETS[set] || [];
    var ready = names.filter(function(n){ return sfxBuf[n]; });
    if (!ready.length) { names.forEach(loadSfx); return false; }

    var cap = VOICES[set] || DEFAULT_VOICES;
    var live = playing[set] = (playing[set] || []).filter(function(s){ return !s.__done; });
    while (live.length >= cap) {
      var old = live.shift();
      try { old.stop(); } catch(e){}
    }

    var buf = sfxBuf[ready[Math.floor(Math.random() * ready.length)]];
    var src = c.createBufferSource(); src.buffer = buf;
    var g = c.createGain(); g.gain.value = gain;
    src.connect(g); g.connect(c.destination);
    src.onended = function(){ src.__done = true; };
    src.start();
    live.push(src);
    return true;
  }

  // 아주 짧은 고역 노이즈 — 금속끼리 부딪히는 "짤랑"의 알갱이 부분
  function clinkAt(c, at, level){
    var dur = 0.09;
    var buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 5);
    }
    var src = c.createBufferSource(); src.buffer = buf;
    var hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2600;
    var g = c.createGain();
    g.gain.setValueAtTime(level, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(hp); hp.connect(g); g.connect(c.destination);
    src.start(at); src.stop(at + dur);
  }
  window.casinoSfx = {
    // 적중/캐시아웃 — 게임마다 승리음이 다르다.
    // kind: 'fanfare'(그래프·사다리) | 그 외(포커·지뢰찾기의 코인 회수음)
    win: function(kind){
      if (playSample(kind === 'fanfare' ? 'fanfare' : 'gain', 0.6)) return;
      var c = ac(); if (!c) return;
      var t = c.currentTime;
      var notes = [1046.5, 1318.5, 1568.0, 2093.0]; // C6 E6 G6 C7
      notes.forEach(function(f, i){
        tone(c, f, t + i*0.055, 0.16, 0.075 - i*0.008, 'triangle');
      });
      tone(c, 2637.0, t + 0.24, 0.30, 0.035, 'sine'); // 끝에 살짝 남는 반짝임(E7)
    },
    // 안전 칸 오픈 — 아주 짧고 가벼운 "톡"
    // 안전 칸 오픈 — 금화 획득 소리. 없으면 짧고 가벼운 "톡"
    safe: function(){
      if (playSample('minecoin', 0.55)) return;
      var c = ac(); if (!c) return;
      tone(c, 1046.5, c.currentTime, 0.075, 0.05, 'triangle'); // C6
    },
    // 낙첨 — 조용히 내려가는 2음 (승리음과 반대 방향)
    lose: function(){
      var c = ac(); if (!c) return;
      var t = c.currentTime;
      tone(c, 392.0, t, 0.14, 0.055, 'triangle');        // G4
      tone(c, 293.7, t + 0.09, 0.24, 0.045, 'triangle'); // D4
    },
    // 지뢰 — 가벼운 폭발음 (level/pitch로 연쇄 폭발의 잔향 표현)
    // 지뢰 — 실제 폭발음(앞 0.55초만 잘라 씀). 연쇄 폭발은 level로 점점 작게 울린다.
    boom: function(level, pitch){
      var g = level == null ? 0.16 : level;
      if (playSample('explode', Math.min(1, g * 3.2))) return;
      var c = ac(); if (!c) return;
      boomAt(c, c.currentTime, g, pitch);
    },
    // 칩 올리기 — 동전 넣는 소리 (동전·골드바 공통)
    chip: function(){
      if (playSample('coin', 0.6)) return;
      var c = ac(); if (!c) return;   // 샘플이 아직 안 받아졌을 때만 쓰는 대체음
      var t = c.currentTime;
      clinkAt(c, t, 0.05);
      tone(c, 3136.0, t + 0.005, 0.10, 0.030, 'triangle'); // G7
      tone(c, 4186.0, t + 0.020, 0.08, 0.019, 'triangle'); // C8
      tone(c, 2349.0, t + 0.034, 0.13, 0.015, 'sine');     // D7 — 살짝 남는 여운
    },
    // 카드 공개 — 뒤집는 소리
    card: function(){
      if (playSample('card', 0.5)) return;
      var c = ac(); if (!c) return;
      clinkAt(c, c.currentTime, 0.028);
    },
    // 새 라운드 시작 — 카드 섞는 소리
    shuffle: function(){ playSample('shuffle', 0.5); },
    // 카드를 한 장 나눠줄 때
    deal: function(){ playSample('deal', 0.55); }
  };
  document.addEventListener('pointerdown', function(){ ac(); preloadSfx(); }, { once: true });
  window.addEventListener('load', function(){ setTimeout(preloadSfx, 400); });
})();
</script>
</body>
</html>`;
}
