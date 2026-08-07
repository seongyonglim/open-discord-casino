/* 운영용 관리 질의.
 *
 * 여기 있는 것은 전부 "사람이 눌러서 데이터를 바꾸는" 동작이다. 그래서 규칙을 하나 둔다 —
 * 위험한 조건은 화면이 아니라 이 파일이 막는다. 화면에서만 막으면 API 를 직접 부르는
 * 순간 뚫리고, 무엇보다 운영자가 실수했을 때 마지막으로 걸러 주는 곳이 없다.
 *
 * 경제 불변식: 잔액 = points_ledger 누적합. 감사가 이것을 검사한다.
 * 그래서 포인트를 만지는 일은 반드시 adjustBalance 를 거친다(원장을 함께 쓴다).
 */
import { one, all, run, tx, adjustBalance } from './queries';
import * as T from '../services/tournament';

/* ── 대회 ─────────────────────────────────────────────────────────── */

export interface AdminTournamentRow {
  id: number; date_str: string; title: string;
  started_at: number | null; finished_at: number | null; cancelled_at: number | null;
  prize_multiplier: number;
  entries: number;
  /** 실제로 지급된 상금 합계. 0이면 이 대회는 경제에 아무 흔적도 남기지 않았다. */
  paid: number;
}

export function listTournaments(limit = 30): AdminTournamentRow[] {
  return all<AdminTournamentRow>(
    `SELECT t.*,
            (SELECT COUNT(*) FROM holdem_entries e WHERE e.tournament_id = t.id) AS entries,
            (SELECT COALESCE(SUM(e.prize), 0) FROM holdem_entries e WHERE e.tournament_id = t.id) AS paid
       FROM holdem_tournaments t
      ORDER BY t.id DESC LIMIT ?`, limit);
}

export type PurgeError = 'not_found' | 'paid' | 'running';

/**
 * 대회 기록을 통째로 지운다 — 테스트로 돌린 판을 없던 일로 만들기 위한 것이다.
 *
 * 상금이 한 푼이라도 나간 대회는 거절한다. 상금은 points_ledger 에 이미 발행돼 있고
 * 잔액은 그 누적합과 같아야 하는데, 대회 행만 지우면 원장에 근거 없는 포인트가 남는다.
 * 되돌리려면 역방향 원장을 써야 하고 그건 "지우기"가 아니라 별개의 회수 작업이다.
 *
 * 상금 0 인 대회(prize_multiplier = 0 으로 연 테스트 판)는 원장을 한 번도 건드리지
 * 않았으므로 — 홀덤이 원장에 쓰는 곳은 상금 지급 한 곳뿐이고, 그 앞에서 pool <= 0 이면
 * 곧바로 돌아간다 — 관련 행을 전부 지워도 경제가 어긋나지 않는다.
 *
 * 진행 중인 대회도 거절한다. 사람이 앉아 카드를 보고 있는 판을 지우면 화면이 무너진다.
 */
export function purgeTournament(id: number): { ok: true; removed: number } | { ok: false; error: PurgeError } {
  return tx(() => {
    const t = one<{ id: number; started_at: number | null; finished_at: number | null; cancelled_at: number | null }>(
      `SELECT id, started_at, finished_at, cancelled_at FROM holdem_tournaments WHERE id = ?`, id);
    if (!t) return { ok: false as const, error: 'not_found' as const };
    if (t.started_at != null && t.finished_at == null && t.cancelled_at == null) {
      return { ok: false as const, error: 'running' as const };
    }
    const paid = one<{ n: number }>(
      `SELECT COALESCE(SUM(prize), 0) AS n FROM holdem_entries WHERE tournament_id = ?`, id)!;
    if (paid.n > 0) return { ok: false as const, error: 'paid' as const };

    /* 지우는 순서는 자식부터다. 외래키 제약을 걸어 두지 않은 스키마라 순서를 틀려도
       에러가 안 나고 고아 행만 남는다 — 그게 더 나쁘다. */
    const tables = all<{ id: number }>(`SELECT id FROM holdem_tables WHERE tournament_id = ?`, id);
    let removed = 0;
    for (const tb of tables) {
      const hands = all<{ id: number }>(`SELECT id FROM holdem_hands WHERE table_id = ?`, tb.id);
      for (const h of hands) {
        run(`DELETE FROM holdem_hand_seats WHERE hand_id = ?`, h.id);
        removed++;
      }
      run(`DELETE FROM holdem_hands WHERE table_id = ?`, tb.id);
      run(`DELETE FROM holdem_seats WHERE table_id = ?`, tb.id);
    }
    run(`DELETE FROM holdem_tables WHERE tournament_id = ?`, id);
    run(`DELETE FROM holdem_entries WHERE tournament_id = ?`, id);
    run(`DELETE FROM holdem_tournaments WHERE id = ?`, id);
    return { ok: true as const, removed };
  });
}

/**
 * 오늘 자리에 테스트 대회를 연다 — 상금 배수를 0 으로 두어 포인트가 나가지 않게 한다.
 *
 * 왜 오늘 자리를 쓰나: 스키마가 date_str 에 유니크 인덱스를 걸어 "하루에 하나"를 강제한다.
 * 그래서 별도의 테스트 대회를 나란히 만들 수 없다. 오늘 행을 테스트용으로 쓰고, 끝나면
 * purgeTournament 로 지우면 된다 — 지운 뒤 첫 요청에서 ensureTournament 가 올바른 일정과
 * 배수로 오늘 행을 다시 만든다.
 *
 * 이 제약이 불편하다면 고칠 곳은 여기가 아니라 그 유니크 인덱스다(다중 대회 전환).
 */
export function openTestTournament(): { ok: true; id: number } | { ok: false; error: 'running' } {
  return tx(() => {
    const now = Math.floor(Date.now() / 1000);
    const live = one<{ id: number }>(
      `SELECT id FROM holdem_tournaments
        WHERE started_at IS NOT NULL AND finished_at IS NULL AND cancelled_at IS NULL`);
    if (live) return { ok: false as const, error: 'running' as const };

    const today = T.scheduleForDate(T.kstDateStr(now * 1000));
    const row = one<{ id: number }>(`SELECT id FROM holdem_tournaments WHERE date_str = ?`, today.dateStr);
    if (row) {
      run(`UPDATE holdem_tournaments
              SET title = ?, prize_multiplier = 0, reg_open_at = ?, scheduled_start_at = ?,
                  grace_ends_at = ?, started_at = NULL, finished_at = NULL, cancelled_at = NULL
            WHERE id = ?`,
        '테스트 대회 (상금 없음)', now - 60, now, now + 3600, row.id);
      return { ok: true as const, id: row.id };
    }
    run(`INSERT INTO holdem_tournaments
           (date_str, title, reg_open_at, scheduled_start_at, grace_ends_at, prize_multiplier)
         VALUES (?, ?, ?, ?, ?, 0)`,
      today.dateStr, '테스트 대회 (상금 없음)', now - 60, now, now + 3600);
    return { ok: true as const, id: one<{ id: number }>(`SELECT last_insert_rowid() AS id`)!.id };
  });
}

/* ── 사용자 · 포인트 ──────────────────────────────────────────────── */

export interface AdminUserRow {
  id: string; username: string; avatar: string | null;
  balance: number; role: string | null; last_active: number | null;
}

/** 이름이나 아이디로 찾는다. 빈 검색어는 최근 활동 순으로 보여 준다. */
export function searchUsers(q: string, limit = 20): AdminUserRow[] {
  const term = q.trim();
  if (term === '') {
    return all<AdminUserRow>(
      `SELECT id, username, avatar, balance, role, last_active FROM users
        ORDER BY last_active DESC, balance DESC LIMIT ?`, limit);
  }
  const like = '%' + term.replace(/[%_\\]/g, m => '\\' + m) + '%';
  return all<AdminUserRow>(
    `SELECT id, username, avatar, balance, role, last_active FROM users
      WHERE username LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\'
      ORDER BY balance DESC LIMIT ?`, like, like, limit);
}

export type GrantError = 'no_user' | 'bad_amount' | 'would_go_negative';

/**
 * 포인트를 주거나 뺀다. 반드시 adjustBalance 를 거친다 — 원장을 함께 써야 하기 때문이다.
 * 잔액을 음수로 만드는 차감은 막는다. 음수 잔액은 게임 어디에서도 상정하지 않은 상태다.
 */
export function grantPoints(userId: string, delta: number, memo: string):
  { ok: true; balance: number } | { ok: false; error: GrantError } {
  const amount = Math.floor(Number(delta));
  if (!Number.isFinite(amount) || amount === 0) return { ok: false, error: 'bad_amount' };
  return tx(() => {
    const u = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId);
    if (!u) return { ok: false as const, error: 'no_user' as const };
    if (u.balance + amount < 0) return { ok: false as const, error: 'would_go_negative' as const };
    const reason = 'admin:' + (memo.trim().slice(0, 40) || 'manual');
    return { ok: true as const, balance: adjustBalance(userId, amount, reason) };
  });
}
