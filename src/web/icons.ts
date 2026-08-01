// 카드/게임 아이콘 (이모지 대신 currentColor 기반 라인 아이콘 — OS별 이모지 렌더링 차이·화질 문제 회피)
const wrap = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const bombIcon = wrap(
  '<circle cx="12" cy="14.5" r="6.5"/>' +
  '<path d="M12 8 L14.2 5.2"/>' +
  '<path d="M14.2 5.2 L17.4 6.1"/>' +
  '<path d="M14.2 5.2 L13.6 2.4"/>' +
  '<circle cx="9.3" cy="12.2" r="1.1" fill="currentColor" stroke="none" opacity=".7"/>'
);

// 안전 칸에 표시하는 금화 — "돈을 벌었다"는 느낌을 주려고 보석 대신 채워진 동전으로 그린다.
// 타일이 작게 렌더되므로 안쪽 무늬는 획이 뭉개지지 않는 굵은 C 하나만 넣는다
// (가느다란 선 여러 개를 겹치면 작은 크기에서 형태가 사라진다).
export const coinIcon =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">` +
  '<circle cx="12" cy="12" r="8.6" fill="currentColor" opacity=".2"/>' +
  '<circle cx="12" cy="12" r="8.6"/>' +
  '<path d="M15.1 8.9 A4.3 4.3 0 1 0 15.1 15.1" stroke-width="2.6"/>' +
  `</svg>`;

export const ladderIcon = wrap(
  '<path d="M8 2 L8 22 M16 2 L16 22 M8 6.5 L16 6.5 M8 11 L16 11 M8 15.5 L16 15.5 M8 20 L16 20"/>'
);

export const chartIcon = wrap(
  '<path d="M3 16 L9 9 L13 13 L21 4"/><path d="M21 4 L21 9.5 M21 4 L15.5 4"/>'
);

export const cardsIcon = wrap(
  '<rect x="3.5" y="7" width="11" height="15" rx="2" transform="rotate(-9 9 14.5)"/>' +
  '<rect x="8.5" y="4.5" width="11" height="15" rx="2"/>'
);

// 미확인 타일에 은은하게 표시할 마크 (빈 칸이 아니라 "뒤집을 수 있는 카드"처럼 보이도록)
export const mysteryMark = wrap('<path d="M9 9a3 3 0 1 1 4 2.8c-.8.5-1 1-1 2.2" stroke-width="2"/><circle cx="12" cy="17.3" r=".4" fill="currentColor" stroke="none"/>');

// 디스코드 브랜드 마크 (헤더 로그인 버튼 · 로그인 화면 공용).
// size로 크기를 바꿔 쓴다 — 같은 패스를 두 곳에 복사해두면 한쪽만 고치는 사고가 난다.
export function discordIcon(size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">` +
    '<path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>';
}
