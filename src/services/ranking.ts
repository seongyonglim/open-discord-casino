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
 * 승률(%) — 분모에서 푸시를 뺀다.
 *
 * 푸시(순손익 0)는 승도 패도 아니다. 승으로 세면 승률이 부풀고(바카라 타이·
 * 블랙잭 푸시는 흔하다), 분모에 남겨두면 승률 상한이 눌려 게임 간 비교가 왜곡된다.
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
