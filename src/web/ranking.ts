/**
 * 게임별 랭킹 API — GET /api/games/{seg}/ranking?limit=N
 *
 * 게임 상태 폴링(statePayload)에 싣지 않고 따로 뺐다. 그래프게임은 상승 중
 * 250ms로 폴링하고 나머지도 1초 주기인데, 랭킹은 초 단위로 바뀌는 값이 아니다.
 * 이 프로젝트는 전송 바이트를 요금으로 보기 때문에 주기 응답을 불리지 않는다.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getGameRanking, getMyGameRank } from '../db/queries';
import { RANK_GAMES, clampLimit, winRatePct } from '../services/ranking';
import { sendJson } from './http';

/** 경로가 랭킹 요청이면 game_stats 키를 돌려준다. 아니면 null.
 *
 * 반드시 hasOwnProperty로 확인한다. 그냥 RANK_GAMES[seg]로 읽으면 Object.prototype의
 * 상속 키가 걸려 든다 — 정규식 [a-z]+를 통과하는 것이 셋 있다(constructor, toString,
 * valueOf). 그러면 game 자리에 함수가 들어가 SQL 파라미터로 넘어가 500이 난다. */
export function rankingGameOf(path: string): string | null {
  const m = /^\/api\/games\/([a-z]+)\/ranking$/.exec(path);
  if (!m) return null;
  if (!Object.prototype.hasOwnProperty.call(RANK_GAMES, m[1])) return null;
  const g = RANK_GAMES[m[1]];
  return typeof g === 'string' ? g : null;
}

export function handleRanking(
  req: IncomingMessage, res: ServerResponse, game: string, userId: string
): void {
  const q = new URL(req.url ?? '/', 'http://x');
  const limit = clampLimit(q.searchParams.get('limit') ?? undefined);
  const rows = getGameRanking(game, limit);

  /* 내려보내는 것은 화면에 쓰는 것만이다. wins·pushes·staked·returned는 빼고,
     balance는 절대 넣지 않는다 — 랭킹은 전체 유저를 대상으로 하므로
     그 라운드 참가자만 보여주는 참가인원 목록과 성격이 다르다. */
  const view = rows.map((r, i) => ({
    rank: i + 1,
    userId: r.user_id,
    username: r.username,
    rounds: r.rounds,
    winPct: winRatePct(r.wins, r.rated),
    profit: r.profit,
    me: r.user_id === userId,
  }));

  /* 상위 목록에 내가 없으면 내 줄만 따로 붙인다. 로그인해야만 볼 수 있는
     서비스에서 자기 순위를 못 보는 게 더 어색하다. PK 조회라 비용이 없다. */
  let mine: (typeof view)[number] | null = null;
  if (!view.some(v => v.me)) {
    const m = getMyGameRank(game, userId);
    if (m) {
      mine = {
        rank: m.rank, userId: m.user_id, username: m.username, rounds: m.rounds,
        winPct: winRatePct(m.wins, m.rated), profit: m.profit, me: true,
      };
    }
  }
  return sendJson(res, 200, { rows: view, mine, limit });
}
