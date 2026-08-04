/**
 * 게임별 랭킹 — 순수 함수.
 *
 * 랭킹은 수익액 내림차순이고, 한 줄에 판수·승률·수익액을 보여준다.
 * 여기 있는 것은 전부 DB나 시각에 의존하지 않는 계산이라 감사에서 직접 검증한다.
 */

/** URL 세그먼트 → game_stats.game 키.
 *
 * 그래프게임만 이름이 셋으로 갈려 있다 — 페이지는 /games/graph, API는
 * /api/games/crash/*, 원장 reason과 집계 키는 graph다. 여기서 매핑을 못 박아
 * 경로를 새로 만들 때 헷갈리지 않게 한다.
 *
 * 홀덤은 넣지 않는다. 프리롤이라 참가비가 없고 상금만 양수로 들어오므로
 * "수익액"이 실력과 무관하게 오른다 — 같은 자에 올릴 수 없는 지표다.
 */
export const RANK_GAMES: Record<string, string> = {
  mines: 'mines',
  ladder: 'ladder',
  crash: 'graph',
  poker: 'poker',
  baccarat: 'baccarat',
  blackjack: 'blackjack',
};

/** 한 번에 내려보내는 최대 줄 수 */
export const RANK_LIMIT_MAX = 200;
export const RANK_LIMIT_DEFAULT = 100;

export function clampLimit(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return RANK_LIMIT_DEFAULT;
  return Math.min(RANK_LIMIT_MAX, n);
}

/**
 * 승률(%) = 돈을 번 판수 / 전체 판수.
 *
 * "돈을 번 판"은 순손익이 양수인 판이다 — 얼마를 벌었는지는 보지 않는다.
 * 본전만 돌아온 판(바카라 타이·블랙잭 푸시)은 승이 아니고, 분모에서 빼지도 않는다.
 *
 * 분모는 승패를 아는 판수(rated)다. 원장에서 백필한 과거 판은 스테이크와 지급을
 * 짝지을 수 없어 승패를 판정할 수 없는데, 그걸 분모에 넣으면 전부 패배로 잡혀
 * 승률이 실제보다 낮게 나온다. 그래서 판수(rounds)와 분모(rated)를 따로 둔다.
 *
 * 표시용 파생값이라 반올림한다(포인트 floor 규칙의 대상이 아니다). 단 양 끝은
 * 거짓말하지 않게 잡아 둔다 — 199승/200판을 "100%"(전승)로, 1승/300판을
 * "0%"(전패)로 보여주면 안 된다.
 */
export function winRatePct(wins: number, denom: number): number | null {
  if (denom <= 0) return null;
  const p = Math.round((wins * 100) / denom);
  if (p === 100 && wins < denom) return 99;
  if (p === 0 && wins > 0) return 1;
  return p;
}
