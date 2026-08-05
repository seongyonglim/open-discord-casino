import { layout, esc, pts, LOGO_SVG } from './views';
import {
  bombIcon, ladderIcon, chartIcon, discordIcon,
  flipIcon, baccaratIcon, blackjackIcon, trophyIcon,
} from './icons';
import type { LeaderboardRow, WebUser } from '../db/queries';
import { recentHoldemWinners, type HoldemStatus } from '../db/holdem';
import * as T from '../services/tournament';
import { NOTICES, type Notice } from './notices';

/* 로비의 게임 목록.
   ── 아이콘
   포커 플립·바카라·블랙잭·홀덤이 전부 같은 cardsIcon을 쓰고 있었다. 목록에서 넷이
   같은 그림이라 "카드게임 묶음"으로만 읽히고 서로 구분이 안 됐다. 게임마다 뜻이 통하는
   상징을 하나씩 준다.

   ── 설명
   한 줄로 줄였다. 예전 두세 줄은 고르는 동안 다 읽히지 않았고, 그렇다고 지표만
   나열하니(한때 그렇게 해봤다) 안내문이 아니라 사양표처럼 차가워졌다.
   말투는 그대로 두고 길이만 줄인다 — 자세한 규칙은 게임 화면의 ? 도움말이 받는다.

   ── 분류
   카드게임과 미니게임은 성격이 다르다(테이블에 앉는가 / 혼자 빠르게 도는가).
   홀덤 프리롤은 하루 한 번 열리는 대회라 둘 중 어디에도 안 들어간다.
   섹션을 나눠 두면 게임이 늘어도 목록이 무너지지 않는다. */
type GameGroup = 'table' | 'mini' | 'event';
interface GameDef {
  key: string; name: string; icon: string; group: GameGroup;
  /** 한 줄 소개 */
  desc: string;
  /** 버튼 문구. 게임마다 하는 일이 다르므로 "플레이"로 뭉뚱그리지 않는다 */
  cta: string;
  /** 시간·성격 배지 (없으면 표시하지 않는다) */
  badge?: string;
  ready: boolean;
}

const GAMES: GameDef[] = [
  { key: 'holdem', name: '홀덤 프리롤', icon: trophyIcon, group: 'event',
    desc: '참가비 없이 모여서 겨루는 토너먼트. 상위 입상자가 상금을 나눠 갖습니다.',
    cta: '참가 신청', badge: '매일 22:00', ready: true },

  { key: 'baccarat', name: '바카라', icon: baccaratIcon, group: 'table',
    desc: '플레이어와 뱅커 중 9에 가까운 쪽이 이깁니다. 타이와 페어에도 걸 수 있어요.',
    cta: '입장하기', ready: true },
  { key: 'blackjack', name: '블랙잭', icon: blackjackIcon, group: 'table',
    desc: '5석 테이블에서 딜러를 함께 상대합니다. 21을 넘기지 않고 이기면 승리!',
    cta: '자리 잡기', ready: true },
  { key: 'poker', name: '포커 플립', icon: flipIcon, group: 'table',
    desc: '두 핸드가 맞붙습니다. 승자와 완성될 족보에 칩을 올려보세요.',
    cta: '베팅하기', ready: true },

  { key: 'mines', name: '지뢰찾기', icon: bombIcon, group: 'mini',
    desc: '지뢰를 피해 칸을 열수록 배당이 오릅니다. 원할 때 캐시아웃!',
    cta: '도전하기', ready: true },
  { key: 'graph', name: '그래프게임', icon: chartIcon, group: 'mini',
    desc: '배율이 계속 오릅니다. 터지기 전에 빠져나오세요. 늦으면 전액 손실!',
    cta: '베팅하기', ready: true },
  { key: 'ladder', name: '사다리게임', icon: ladderIcon, group: 'mini',
    desc: '출발과 도착을 예측하세요. 하나만 맞혀도 1.95배, 둘 다 맞히면 3.95배.',
    cta: '예측하기', ready: true },
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
function gameCard(g: GameDef, override?: { badge?: string; desc?: string; cta?: string; hot?: boolean }): string {
  const o = override ?? {};
  const badgeText = o.badge ?? g.badge;
  const badge = badgeText ? `<span class="gc-badge">${esc(badgeText)}</span>` : '';
  const inner = `<div class="gc-top"><div class="icon">${g.icon}</div>${badge}</div>
    <h3>${esc(g.name)}</h3>
    <p>${esc(o.desc ?? g.desc)}</p>`;
  if (!g.ready) {
    return `<div class="game-card">${inner}<span class="soon">출시 예정</span></div>`;
  }
  return `<a class="game-card ready${o.hot ? ' live' : ''}" href="/games/${g.key}">${inner}
    <span class="btn btn-gold">${esc(o.cta ?? g.cta)}</span>
  </a>`;
}

/* ── 프리롤 카드는 대회 상태를 그대로 비춘다 ────────────────────────────
   "매일 22:00"이라는 고정 배지만 붙여 두면 하루 23시간 동안 아무 정보가 없다.
   등록이 열렸는지, 지금 몇 명인지, 이미 끝났는지가 로비에서 보여야 한다.

   상태 판정은 advanceHoldem 하나에만 둔다 — 로비에서 따로 계산하면 로비 표시와
   실제 대회가 갈라진다. 이 함수는 그 결과를 문구로 옮기기만 한다.

   등록 중일 때만 카드를 강조한다(hot). 상시로 크게 띄우면 하루 대부분의 시간에
   거짓 긴박감을 만들고, 그런 배지는 한 번 들키면 나머지도 안 믿게 된다. */
function freerollOverride(st: HoldemStatus): { badge?: string; desc?: string; cta?: string; hot?: boolean } {
  const t = st.tournament;
  const n = st.registered;
  const pool = T.prizePool(n, t.prize_multiplier);
  const now = Math.floor(Date.now() / 1000);
  const left = (at: number) => {
    const s = Math.max(0, at - now);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
  };

  switch (st.status) {
    case 'REGISTRATION_OPEN':
      return {
        badge: `등록 중 · ${left(st.schedule.scheduledStartAt)} 후 시작`,
        desc: n > 0
          ? `${n}명 신청 · 상금 풀 ${pool.toLocaleString('ko-KR')}P. 지금 신청할 수 있습니다.`
          : '참가 신청이 열렸습니다. 최소 3명이 모이면 시작합니다.',
        cta: st.tournament.id ? '참가 신청' : '참가 신청',
        hot: true,
      };
    case 'WAITING_MIN_PLAYERS':
      return {
        badge: '인원 대기 중',
        desc: `${n}명 신청 — 최소 ${T.MIN_PLAYERS}명이 모이면 시작합니다. 아직 들어올 수 있어요.`,
        cta: '참가 신청', hot: true,
      };
    case 'RUNNING':
      return {
        badge: '진행 중',
        desc: `${n}명이 참가한 대회가 돌고 있습니다. 늦은 등록이나 관전으로 들어가세요.`,
        cta: '테이블 보기', hot: true,
      };
    case 'FINISHED':
      return {
        badge: '오늘 종료',
        desc: '오늘 대회는 끝났습니다. 결과는 안에서 확인할 수 있어요.',
        cta: '결과 보기',
      };
    case 'CANCELLED':
      return {
        badge: '취소',
        desc: `최소 인원(${T.MIN_PLAYERS}명)이 모이지 않아 오늘 대회는 취소됐습니다.`,
        cta: '자세히 보기',
      };
    default:
      return {
        badge: '매일 22:00',
        desc: `등록은 ${left(st.schedule.regOpenAt)} 후에 열립니다. 참가비 없이 상금만 걸린 대회예요.`,
        cta: '자세히 보기',
      };
  }
}

/* ── 최근 소식 ─────────────────────────────────────────────────────────
   로비가 "내가 없는 동안 무슨 일이 있었는지"를 전혀 알려주지 않았다.
   소규모 커뮤니티에서 다시 들어오는 이유는 대체로 그것이다.
   보여줄 게 하나도 없으면 이 칸 자체를 그리지 않는다 — 빈 상자가 더 허전하다. */
function newsSection(): string {
  const items: string[] = [];

  for (const w of recentHoldemWinners(1)) {
    items.push(`<li><span class="nw-k">프리롤</span>
      <span class="nw-v"><b>${esc(w.username)}</b> 우승
      ${w.prize > 0 ? `· ${w.prize.toLocaleString('ko-KR')}P` : ''}
      <span class="dim">(${esc(w.dateStr)} · ${w.players}명)</span></span></li>`);
  }

  /* "최근 큰 승리"를 넣었다가 뺐다.
     원장에서 뽑을 수 있는 값은 정산으로 받아간 금액이고, 그 판에 얼마를 걸었는지는
     짝지을 수 없다(원장 행에 라운드 번호가 없다). 그래서 그래프에서 30,000P를 걸고
     1.03배에 뺀 사람이 "+31,080P"로 찍혔다 — 실제 이익은 1,080P다.
     무엇을 뜻하는지 알 수 없는 숫자를 크게 보여주는 건 아예 없는 것보다 나쁘다.

     순이익을 제대로 내려면 게임별 라운드 표(ladder_bets·crash_bets·... 각각 amount와
     payout이 있다)를 여섯 개 합쳐야 한다. 그럴 가치가 있다고 판단되면 그때 만든다. */

  const notice = NOTICES[0];
  if (notice) {
    items.push(`<li><span class="nw-k">공지</span>
      <span class="nw-v"><a href="/notices/${esc(notice.id)}">${esc(notice.title)}</a></span></li>`);
  }

  if (!items.length) return '';
  return `<div class="card">
    <h2>최근 소식</h2>
    <ul class="news">${items.join('')}</ul>
  </div>`;
}

/* 섹션으로 나눠 그린다. 한 격자에 일곱 개를 늘어놓으면 둘째 줄이 반만 차서 미완성처럼
   보이고, 게임이 늘수록 "무엇을 고를지" 판단할 근거가 사라진다. */
function gameSections(ht: HoldemStatus | null): string {
  const order: GameGroup[] = ['event', 'table', 'mini'];
  const htOverride = ht ? freerollOverride(ht) : undefined;
  return order.map(gr => {
    const list = GAMES.filter(g => g.group === gr);
    if (!list.length) return '';
    const cards = list.map(g =>
      g.key === 'holdem' ? gameCard(g, htOverride) : gameCard(g)).join('');
    return `<div class="card">
      <h2>${esc(GROUP_TITLE[gr])}</h2>
      <div class="game-grid">${cards}</div>
    </div>`;
  }).join('');
}

export function lobbyPage(user: WebUser | null, ht: HoldemStatus | null = null): string {
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
    ${gameSections(ht)}
    ${newsSection()}
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
