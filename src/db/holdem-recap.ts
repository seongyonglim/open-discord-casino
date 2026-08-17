/* 지난 대회 요약.
 *
 * 예정된 대회가 없을 때 로비를 빈칸으로 두지 않기 위한 것이다. 대회가 저절로 열리지
 * 않게 되면서 "아무것도 없는 날"이 생겼는데, 그때 화면에 아무 말도 없으면 서비스가
 * 죽은 것처럼 보인다. 마지막 판이 어땠는지를 보여 주면 최소한 살아 있는 자리가 된다.
 *
 * 읽기만 한다. 여기서 무엇도 만들거나 고치지 않는다.
 */
import { one, all } from './queries';

export interface RecapPlace {
  userId: string;
  username: string;
  avatar: string | null;
  place: number;
  prize: number;
}

export interface Recap {
  id: number;
  title: string;
  dateStr: string;
  finishedAt: number;
  entries: number;
  prizeTotal: number;
  /** 1~3위. 참가자가 적으면 그만큼만 담긴다. */
  top: RecapPlace[];
  /** 우승을 확정한 마지막 판의 족보. 폴드로 끝났으면 null — 없는 것을 지어내지 않는다. */
  winningHand: string | null;
}

/** 가장 최근에 끝난 대회. 취소된 판은 세지 않는다 — 보여줄 결과가 없다. */
export function recentRecap(): Recap | null {
  const t = one<{ id: number; title: string; date_str: string; finished_at: number }>(
    `SELECT id, title, date_str, finished_at FROM holdem_tournaments
      WHERE finished_at IS NOT NULL AND cancelled_at IS NULL
      ORDER BY finished_at DESC LIMIT 1`);
  if (!t) return null;

  /* 받아 간 돈은 순위 상금 + 바운티다. 예전에는 prize 만 셌는데, 미스터리 바운티는
     바운티 몫이 100% 라 순위 상금이 0 이다 — 7명이 20,000P 씩 걸고 친 대회가
     "총 상금 0P"로, 우승자가 "0P"로 나왔다. 화면이 거짓말을 한 셈이다. */
  const rows = all<{ user_id: string; username: string; finish_place: number; prize: number; avatar: string | null }>(
    `SELECT e.user_id, e.username, e.finish_place,
            (e.prize + e.bounty_paid) AS prize, u.avatar
       FROM holdem_entries e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.tournament_id = ? AND e.finish_place IS NOT NULL
      ORDER BY e.finish_place ASC`, t.id);
  if (rows.length === 0) return null;

  const total = one<{ n: number }>(
    `SELECT COALESCE(SUM(prize + bounty_paid), 0) AS n
       FROM holdem_entries WHERE tournament_id = ?`, t.id)!.n;

  return {
    id: t.id,
    title: t.title,
    dateStr: t.date_str,
    finishedAt: t.finished_at,
    entries: rows.length,
    prizeTotal: total,
    top: rows.slice(0, 3).map(r => ({
      userId: r.user_id, username: r.username, avatar: r.avatar,
      place: r.finish_place, prize: r.prize,
    })),
    winningHand: winningHandOf(t.id, rows[0].user_id),
  };
}

/**
 * 우승자가 마지막 판을 무엇으로 이겼는지.
 *
 * 결과는 판이 끝날 때 result_json 에 박혀 있다(potAwards 의 hand). 여기서 다시
 * 계산하지 않는 이유는 그때 본 결과와 지금 계산한 결과가 갈라질 수 있어서다.
 * 마지막 판이 폴드로 끝났으면 족보가 없다 — 그때는 null 이 맞는 답이다.
 */
function winningHandOf(tournamentId: number, championId: string): string | null {
  const seat = one<{ seat: number }>(
    `SELECT s.seat FROM holdem_seats s
       JOIN holdem_tables tb ON tb.id = s.table_id
      WHERE tb.tournament_id = ? AND s.user_id = ? LIMIT 1`, tournamentId, championId);
  if (!seat) return null;

  const hand = one<{ result_json: string | null }>(
    `SELECT h.result_json FROM holdem_hands h
       JOIN holdem_tables tb ON tb.id = h.table_id
      WHERE tb.tournament_id = ? AND h.ended_at IS NOT NULL
      ORDER BY h.ended_at DESC, h.hand_no DESC LIMIT 1`, tournamentId);
  if (!hand?.result_json) return null;

  try {
    const r = JSON.parse(hand.result_json) as {
      potAwards?: { winners?: { seat: number }[]; hand?: string }[];
    };
    for (const pa of r.potAwards ?? []) {
      if ((pa.winners ?? []).some(w => w.seat === seat.seat) && pa.hand) return pa.hand;
    }
  } catch {
    /* 예전 판의 결과 모양이 지금과 다를 수 있다. 요약 한 줄 때문에 로비가 죽으면 안 된다. */
    return null;
  }
  return null;
}
