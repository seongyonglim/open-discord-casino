import { layout, esc, pts } from './views';
import { bombIcon, ladderIcon, chartIcon, cardsIcon } from './icons';
import type { LeaderboardRow, WebUser } from '../db/queries';

const GAMES: { key: string; name: string; desc: string; icon: string; ready: boolean }[] = [
  { key: 'mines', name: '지뢰찾기', desc: '지뢰 개수를 고르고 안전한 칸을 열수록 배당이 오릅니다. 원할 때 캐시아웃!', icon: bombIcon, ready: true },
  { key: 'ladder', name: '사다리게임', desc: '출발·도착의 좌우를 예측하세요. 하나만 맞히면 1.95배, 둘 다 맞히면 3.95배.', icon: ladderIcon, ready: true },
  { key: 'graph', name: '그래프게임', desc: '배율이 계속 오릅니다. 터지기 전에 캐시아웃하세요. 늦으면 전액 손실!', icon: chartIcon, ready: true },
  { key: 'poker', name: '포커 플립', desc: '홀덤 두 핸드를 보고 승자와 완성 등급에 베팅. 배당은 공개된 카드로 매번 새로 계산됩니다.', icon: cardsIcon, ready: true },
  { key: 'baccarat', name: '바카라', desc: '뱅커/플레이어/타이 중 승자를 맞춰보세요.', icon: cardsIcon, ready: false },
  { key: 'blackjack', name: '블랙잭', desc: '21에 가깝게, 딜러를 이기세요.', icon: cardsIcon, ready: false },
];

// 게임 화면 상단의 게임 전환 바 — 로비를 거치지 않고 바로 다른 게임으로 이동할 수 있게 한다.
// 출시된 게임만 노출하고, 현재 플레이 중인 게임은 활성 표시.
export function gameSwitcher(currentKey: string): string {
  const pills = GAMES.filter(g => g.ready).map(g => `
    <a class="gs-pill${g.key === currentKey ? ' active' : ''}" href="/games/${g.key}">
      <span class="gs-ic">${g.icon}</span>${esc(g.name)}
    </a>`).join('');
  return `<div class="game-switch">${pills}</div>`;
}

// 게임 선택 카드 그리드 (로비에서 사용)
function gameCards(): string {
  return GAMES.map(g => `
    <div class="game-card">
      <div class="icon">${g.icon}</div>
      <h3>${esc(g.name)}</h3>
      <p>${esc(g.desc)}</p>
      ${g.ready ? `<a class="btn btn-gold" href="/games/${g.key}">플레이</a>` : `<span class="soon">출시 예정</span>`}
    </div>`).join('');
}

export function lobbyPage(user: WebUser | null): string {
  if (!user) {
    return layout('로비', 'lobby', `
      <div class="card" style="text-align:center;padding:48px 20px">
        <h2 style="margin-bottom:8px;font-size:18px;color:var(--txt)">디스코드로 로그인하고 시작하세요</h2>
        <p style="color:var(--muted);margin:0 0 18px">매일 출석해서 모은 포인트로 카지노 게임을 즐길 수 있습니다.</p>
        <a class="btn btn-gold" href="/auth/login">디스코드 로그인</a>
      </div>`);
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

