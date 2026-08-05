import { layout, esc, pts, LOGO_SVG } from './views';
import {
  bombIcon, ladderIcon, chartIcon, discordIcon,
  flipIcon, baccaratIcon, blackjackIcon, trophyIcon,
} from './icons';
import type { LeaderboardRow, WebUser } from '../db/queries';
import { NOTICES, type Notice } from './notices';

/* 로비의 게임 목록.
   ── 아이콘
   포커 플립·바카라·블랙잭·홀덤이 전부 같은 cardsIcon을 쓰고 있었다. 목록에서 넷이
   같은 그림이라 "카드게임 묶음"으로만 읽히고 서로 구분이 안 됐다. 게임마다 뜻이 통하는
   상징을 하나씩 준다.

   ── 설명 대신 지표
   예전에는 카드마다 두세 줄짜리 문장을 넣었다. 게임을 고르는 동안 읽히지 않는 분량이고,
   이미 아는 사람에게는 자리만 차지한다. 지금은 "이 게임이 어떤 게임인지"를 가르는 지표
   두세 개만 놓는다 — 자세한 규칙은 게임 화면의 ? 도움말이 받는다.
   지표 숫자는 도움말과 같은 근거(코드 상수)에서 온다.

   ── 분류
   카드게임과 미니게임은 성격이 다르다(테이블에 앉는가 / 혼자 빠르게 도는가).
   홀덤 프리롤은 하루 한 번 열리는 대회라 둘 중 어디에도 안 들어간다.
   섹션을 나눠 두면 게임이 늘어도 목록이 무너지지 않는다. */
type GameGroup = 'table' | 'mini' | 'event';
interface GameDef {
  key: string; name: string; icon: string; group: GameGroup;
  /** 카드에 보여줄 지표 두세 개 — 문장이 아니라 값이어야 한다 */
  facts: string[];
  /** 버튼 문구. 게임마다 하는 일이 다르므로 "플레이"로 뭉뚱그리지 않는다 */
  cta: string;
  /** 시간·성격 배지 (없으면 표시하지 않는다) */
  badge?: string;
  ready: boolean;
}

const GAMES: GameDef[] = [
  { key: 'holdem', name: '홀덤 프리롤', icon: trophyIcon, group: 'event',
    facts: ['참가비 없음', '노리밋 홀덤', '상위 입상 시 상금'], cta: '참가 신청',
    badge: '매일 22:00', ready: true },

  { key: 'baccarat', name: '바카라', icon: baccaratIcon, group: 'table',
    facts: ['5가지 베팅', '1덱', '타이 약 9%'], cta: '입장하기', ready: true },
  { key: 'blackjack', name: '블랙잭', icon: blackjackIcon, group: 'table',
    facts: ['5석 · 딜러전', '블랙잭 3:2', '더블 · 서렌더'], cta: '자리 잡기', ready: true },
  { key: 'poker', name: '포커 플립', icon: flipIcon, group: 'table',
    facts: ['두 핸드 대결', '배당 매판 계산', '족보 시장'], cta: '베팅하기', ready: true },

  { key: 'mines', name: '지뢰찾기', icon: bombIcon, group: 'mini',
    facts: ['난이도 5단계', '최대 5만 배', '언제든 캐시아웃'], cta: '도전하기', ready: true },
  { key: 'graph', name: '그래프게임', icon: chartIcon, group: 'mini',
    facts: ['최대 10,000배', '자동 캐시아웃', '한 판 20초'], cta: '베팅하기', ready: true },
  { key: 'ladder', name: '사다리게임', icon: ladderIcon, group: 'mini',
    facts: ['1.95배 / 3.95배', '한 판 15초', '출발 · 홀짝'], cta: '예측하기', ready: true },
];

const GROUP_TITLE: Record<GameGroup, string> = {
  event: '이벤트',
  table: '테이블 게임',
  mini: '미니 게임',
};

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

/* 게임 선택 카드.
   카드 전체가 링크다 — 예전에는 안쪽 '플레이' 버튼만 눌려서, 카드에 마우스를 올리면
   살짝 떠오르는데도 정작 클릭이 안 돼 "반응이 없다"는 느낌을 줬다.

   버튼 문구는 게임마다 다르다. 전부 "플레이"였는데, 홀덤은 바로 플레이가 아니라
   대회에 신청하는 것이고 바카라·블랙잭은 테이블에 들어가는 것이라 하는 일이 서로 다르다.
   문구가 다르면 누르기 전에 무슨 일이 일어날지 알 수 있다. */
function gameCard(g: GameDef): string {
  const facts = g.facts.map(f => `<li>${esc(f)}</li>`).join('');
  const badge = g.badge ? `<span class="gc-badge">${esc(g.badge)}</span>` : '';
  if (!g.ready) {
    return `<div class="game-card">
      <div class="gc-top"><div class="icon">${g.icon}</div>${badge}</div>
      <h3>${esc(g.name)}</h3>
      <ul class="gc-facts">${facts}</ul>
      <span class="soon">출시 예정</span>
    </div>`;
  }
  return `<a class="game-card ready" href="/games/${g.key}">
    <div class="gc-top"><div class="icon">${g.icon}</div>${badge}</div>
    <h3>${esc(g.name)}</h3>
    <ul class="gc-facts">${facts}</ul>
    <span class="btn btn-gold">${esc(g.cta)}</span>
  </a>`;
}

/* 섹션으로 나눠 그린다. 한 격자에 일곱 개를 늘어놓으면 둘째 줄이 반만 차서 미완성처럼
   보이고, 게임이 늘수록 "무엇을 고를지" 판단할 근거가 사라진다. */
function gameSections(): string {
  const order: GameGroup[] = ['event', 'table', 'mini'];
  return order.map(gr => {
    const list = GAMES.filter(g => g.group === gr);
    if (!list.length) return '';
    return `<div class="card">
      <h2>${esc(GROUP_TITLE[gr])}</h2>
      <div class="game-grid">${list.map(gameCard).join('')}</div>
    </div>`;
  }).join('');
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

  /* 연속 출석 0일은 초록으로 쓰지 않는다.
     초록(--win)은 "좋은 상태"를 뜻하는 색인데 0일은 아직 시작하지 않은 상태다.
     하루라도 쌓였을 때부터 초록이 되어야 색이 정보를 전달한다. */
  const streakCls = user.current_streak > 0 ? 'val hi' : 'val';
  const body = `
    <div class="stat-row">
      <div class="stat"><div class="lbl">내 잔액</div><div class="val gold">${esc(pts(user.balance))}</div></div>
      <div class="stat"><div class="lbl">연속 출석</div><div class="${streakCls}">${user.current_streak}일</div></div>
    </div>
    ${gameSections()}
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
