import { layout, esc, pts, LOGO_SVG } from './views';
import { bombIcon, ladderIcon, chartIcon, cardsIcon, discordIcon } from './icons';
import type { LeaderboardRow, WebUser } from '../db/queries';
import { NOTICES, type Notice } from './notices';

const GAMES: { key: string; name: string; desc: string; icon: string; ready: boolean }[] = [
  { key: 'mines', name: '지뢰찾기', desc: '지뢰 개수를 고르고 안전한 칸을 열수록 배당이 오릅니다. 원할 때 캐시아웃!', icon: bombIcon, ready: true },
  { key: 'ladder', name: '사다리게임', desc: '출발·도착의 좌우를 예측하세요. 하나만 맞히면 1.95배, 둘 다 맞히면 3.95배.', icon: ladderIcon, ready: true },
  { key: 'graph', name: '그래프게임', desc: '배율이 계속 오릅니다. 터지기 전에 캐시아웃하세요. 늦으면 전액 손실!', icon: chartIcon, ready: true },
  { key: 'poker', name: '포커 플립', desc: '홀덤 두 핸드를 보고 승자와 완성 등급에 베팅. 배당은 공개된 카드로 매번 새로 계산됩니다.', icon: cardsIcon, ready: true },
  { key: 'baccarat', name: '바카라', desc: '플레이어와 뱅커 중 9에 가까운 쪽이 이깁니다. 타이와 페어까지 다섯 갈래에 칩을 올려보세요.', icon: cardsIcon, ready: true },
  { key: 'blackjack', name: '블랙잭', desc: '5석 테이블에서 딜러를 함께 상대합니다. 21을 넘기지 않고 딜러보다 높으면 승리.', icon: cardsIcon, ready: true },
  { key: 'holdem', name: '홀덤 프리롤', desc: '매일 22:00 시작하는 참가비 없는 토너먼트. 노리밋 홀덤으로 겨루고 상위 입상자가 상금을 받습니다.', icon: cardsIcon, ready: true },
];

/* 게임 화면 상단의 게임 전환 바 — 로비를 거치지 않고 바로 다른 게임으로 이동할 수 있게 한다.
   출시된 게임만 노출하고, 현재 플레이 중인 게임은 활성 표시.

   규칙 도움말(?) 버튼도 여기 오른쪽 끝에 붙인다. 처음에는 게임 카드의 오른쪽 위 구석에
   띄웠는데, 게임마다 그 자리에 다른 것이 있어서 실제로 가렸다 — 사다리는 출목표,
   그래프는 최근 배율 기록, 바카라는 범례를 덮었고, 포커·지뢰찾기는 펠트 안에 떠 있었다.
   판 위에는 게임이 쓰는 자리가 아닌 곳이 없다는 게 문제였다.

   이 바는 모든 게임 화면이 공통으로 갖는 "게임 밖" 영역이라 무엇도 가리지 않고,
   일곱 게임에서 항상 같은 자리라 한 번 찾으면 계속 안다. 게임이 늘어도 그대로 간다. */
export function gameSwitcher(currentKey: string, helpDialogId?: string): string {
  const pills = GAMES.filter(g => g.ready).map(g => `
    <a class="gs-pill${g.key === currentKey ? ' active' : ''}" href="/games/${g.key}">
      <span class="gs-ic">${g.icon}</span>${esc(g.name)}
    </a>`).join('');
  const help = helpDialogId
    ? `<button class="helpbtn gs-help" type="button" data-help="${esc(helpDialogId)}"
         aria-label="규칙 보기" title="규칙 보기">?</button>`
    : '';
  return `<div class="game-switch">${pills}${help}</div>`;
}

// 게임 선택 카드 그리드 (로비에서 사용).
// 출시된 게임은 카드 전체가 링크다 — 예전에는 안쪽 '플레이' 버튼만 눌려서, 카드에 마우스를 올리면
// 살짝 떠오르는데도 정작 클릭이 안 돼 "반응이 없다"는 느낌을 줬다.
function gameCards(): string {
  return GAMES.map(g => g.ready ? `
    <a class="game-card ready" href="/games/${g.key}">
      <div class="icon">${g.icon}</div>
      <h3>${esc(g.name)}</h3>
      <p>${esc(g.desc)}</p>
      <span class="btn btn-gold">플레이</span>
    </a>` : `
    <div class="game-card">
      <div class="icon">${g.icon}</div>
      <h3>${esc(g.name)}</h3>
      <p>${esc(g.desc)}</p>
      <span class="soon">출시 예정</span>
    </div>`).join('');
}

export function lobbyPage(user: WebUser | null): string {
  // 로그인 전에는 보여줄 게 없으므로 화면 가운데에 로그인만 크게 놓는다
  // (좁은 카드 안에 작은 버튼을 넣으면 빈 화면에 덩그러니 남아 허전해 보인다).
  if (!user) {
    return layout('로그인', 'lobby', `
      <div class="login-hero">
        <div class="login-mark">${LOGO_SVG}</div>
        <h1 class="login-title">OD <span>CASINO</span></h1>
        <p class="login-sub">매일 출석해서 모은 포인트로 즐기는 오픈디코 전용 카지노</p>
        <a class="login-cta" href="/auth/login">${discordIcon(20)}디스코드로 로그인</a>
        <p class="login-note">오픈디코 서버 멤버만 입장할 수 있습니다</p>
        <div class="login-games">${GAMES.filter(g => g.ready).map(g =>
          `<span class="login-game">${g.icon}${esc(g.name)}</span>`).join('')}</div>
      </div>`, 'login-page');
  }

  const body = `
    <div class="stat-row">
      <div class="stat"><div class="lbl">내 잔액</div><div class="val gold">${esc(pts(user.balance))}</div></div>
      <div class="stat"><div class="lbl">연속 출석</div><div class="val hi">${user.current_streak}일</div></div>
    </div>
    <div class="card">
      <h2>게임 선택</h2>
      <div class="game-grid">${gameCards()}</div>
    </div>
    <div class="card">
      <h2>출석체크</h2>
      <p style="color:var(--muted);font-size:13.5px;margin:0">디스코드 서버의 출석체크 채널에서 버튼을 눌러 매일 포인트를 받으세요. KST 자정이 지나면 다시 누를 수 있습니다.</p>
    </div>`;
  return layout('로비', 'lobby', body);
}

export function leaderboardPage(rows: LeaderboardRow[], meId: string | null): string {
  const body = rows.map((r, i) => `<tr${r.id === meId ? ' style="background:rgba(200,170,110,.07)"' : ''}>
    <td class="rank${i === 0 ? ' top1' : ''}">${i + 1}</td>
    <td>${esc(r.username)}${r.id === meId ? ' <span style="color:var(--gold);font-size:11px">(나)</span>' : ''}</td>
    <td class="num" style="color:var(--gold);font-weight:600">${esc(pts(r.balance))}</td>
    <td class="num">${r.current_streak}일</td>
  </tr>`).join('');

  return layout('랭킹', 'leaderboard', `
    <div class="card">
      <h2>포인트 랭킹 TOP ${rows.length}</h2>
      <table>
        <thead><tr><th>순위</th><th>유저</th><th>잔액</th><th>연속 출석</th></tr></thead>
        <tbody>${body || `<tr><td colspan="4" class="empty">아직 데이터가 없습니다</td></tr>`}</tbody>
      </table>
    </div>`);
}


/* ── 공지사항 ─────────────────────────────────────────────────────────
   게임사 공지 형식을 따른다: 분류 태그 · 제목 · 날짜, 본문은 소제목으로 끊는다.
   글은 코드(web/notices.ts)에 있고 여기서는 그리기만 한다. */

function noticeBody(n: Notice): string {
  return n.sections.map(s => {
    const paras = (s.paras ?? []).map(p => `<p>${p}</p>`).join('');
    const bullets = s.bullets?.length
      ? `<ul>${s.bullets.map(b => `<li>${b}</li>`).join('')}</ul>` : '';
    const table = s.table
      ? `<div class="nt-tw"><table class="nt-table">
           <thead><tr>${s.table.head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
           <tbody>${s.table.rows.map(r =>
             `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
         </table></div>`
      : '';
    return `<section class="nt-sec"><h3>${esc(s.heading)}</h3>${paras}${bullets}${table}</section>`;
  }).join('');
}

export function noticeListPage(): string {
  const rows = NOTICES.map(n => `
    <a class="nt-row" href="/notices/${esc(n.id)}">
      <span class="nt-kind k-${esc(n.kind)}">${esc(n.kind)}</span>
      <span class="nt-mid">
        <span class="nt-title">${esc(n.title)}</span>
        <span class="nt-sum">${esc(n.summary)}</span>
      </span>
      <span class="nt-date num">${esc(n.date)}</span>
    </a>`).join('');

  return layout('공지사항', 'notices', `
    <div class="card">
      <h2>공지사항</h2>
      <p class="nt-lead">업데이트 · 밸런스 조정 · 오류 수정 내역을 안내합니다.</p>
      <div class="nt-list">${rows || `<p class="empty">등록된 공지가 없습니다</p>`}</div>
    </div>`);
}

export function noticeDetailPage(n: Notice): string {
  const idx = NOTICES.findIndex(x => x.id === n.id);
  const prev = idx >= 0 && idx + 1 < NOTICES.length ? NOTICES[idx + 1] : null;   // 더 과거 글
  const next = idx > 0 ? NOTICES[idx - 1] : null;                                 // 더 최신 글
  const nav = [
    next ? `<a class="nt-nav" href="/notices/${esc(next.id)}">← 다음 글 · ${esc(next.title)}</a>` : '',
    prev ? `<a class="nt-nav" href="/notices/${esc(prev.id)}">이전 글 · ${esc(prev.title)} →</a>` : '',
  ].filter(Boolean).join('');

  return layout(n.title, 'notices', `
    <div class="card nt-doc">
      <div class="nt-head">
        <span class="nt-kind k-${esc(n.kind)}">${esc(n.kind)}</span>
        <h2>${esc(n.title)}</h2>
        <span class="nt-date num">${esc(n.date)}</span>
      </div>
      ${noticeBody(n)}
      <div class="nt-foot">
        <a class="btn nt-back" href="/notices">목록으로</a>
        ${nav}
      </div>
    </div>`);
}
