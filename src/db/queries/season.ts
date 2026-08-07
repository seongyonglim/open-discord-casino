/* 시즌 질의.
 *
 * 시즌 점수는 "종료 시점 잔액"이다. 그래서 진행 중인 시즌과 닫힌 시즌은 보는 곳이 다르다 —
 * 진행 중이면 users.balance 를 실시간으로 보고, 닫힌 시즌은 season_results 에 찍어 둔
 * 성적표를 본다. 닫는 순간을 놓치면 그 점수는 영영 알 수 없다. 다음 시즌이 시작되면서
 * 잔액이 초기화되기 때문이다.
 *
 * 게임별 전적(승률·판수·순수익)은 season_stats 에서 온다. 시즌이 넘어가면 행이 없으니
 * 저절로 0 에서 시작한다 — 지우는 것이 아니라 열쇠에 시즌이 들어 있는 구조다.
 *
 * 의존은 한 방향이다: season → core. currentSeasonId 가 core 에 있는 이유가 그것이다.
 */
import { one, all, run, tx, currentSeasonId, adjustBalance } from './core';

export interface SeasonRow {
  id: number; number: number; name: string; reward: string;
  started_at: number; ends_at: number | null; closed_at: number | null;
}

export function listSeasons(): SeasonRow[] {
  currentSeasonId();                      // 하나도 없으면 시즌 0 을 열고 시작한다
  return all<SeasonRow>(`SELECT * FROM seasons ORDER BY number DESC`);
}

export function getSeason(id: number): SeasonRow | undefined {
  return one<SeasonRow>(`SELECT * FROM seasons WHERE id = ?`, id);
}

export function currentSeason(): SeasonRow {
  return one<SeasonRow>(`SELECT * FROM seasons WHERE id = ?`, currentSeasonId())!;
}

/**
 * 그 시즌에 실제로 사람이 플레이한 게임 목록.
 *
 * 화면의 카테고리 탭이 이걸로 만들어진다 — 고정 목록을 박아 두면 새 게임이 붙을 때마다
 * 화면을 고쳐야 하고, 아직 없던 게임의 빈 탭이 지난 시즌에도 나온다.
 * 판수가 많은 순으로 준다. 탭 순서가 곧 그 시즌에 무엇이 주로 돌았는지가 된다.
 */
export function seasonGames(seasonId: number): { game: string; rounds: number; players: number }[] {
  return all<{ game: string; rounds: number; players: number }>(
    `SELECT game, SUM(rounds) AS rounds, COUNT(DISTINCT user_id) AS players
       FROM season_stats WHERE season_id = ? AND rounds > 0
      GROUP BY game ORDER BY rounds DESC, game ASC`, seasonId);
}

/* ── 홀덤 ─────────────────────────────────────────────────────────
   홀덤은 다른 게임과 성격이 다르다. 판마다 돈을 걸고 되받는 게 아니라 하루 한 번 열리는
   대회이고, 참가비가 없다(프리롤). 그래서 승률·순수익이라는 지표가 성립하지 않는다 —
   의미가 있는 것은 몇 번 나갔고, 몇 번 이겼고, 상금을 얼마 받았는가다.

   집계도 season_stats 를 쓰지 않는다. 대회 결과는 이미 holdem_entries 에 등수와 상금으로
   남아 있고, 대회에는 끝난 시각이 있다. 그러니 시즌 구간으로 자르기만 하면 된다 —
   옮겨 담을 필요가 없고, 지난 시즌·지난 대회가 저절로 제자리에 들어간다. */

/** 그 시즌 구간에서 끝난 대회. 취소된 대회는 finished_at 이 없어 저절로 빠진다. */
function holdemWindow(s: SeasonRow): string {
  void s;
  return `t.finished_at IS NOT NULL AND t.finished_at >= ?
          AND (? IS NULL OR t.finished_at < ?)`;
}

export interface SeasonHoldemRow {
  userId: string; username: string; avatar: string | null;
  entries: number; wins: number; itm: number; prize: number; rank: number;
}

export function seasonHoldemRanking(seasonId: number, limit = 100): SeasonHoldemRow[] {
  const s = getSeason(seasonId);
  if (!s) return [];
  const rows = all<Omit<SeasonHoldemRow, 'rank'>>(
    `SELECT e.user_id AS userId, u.username, u.avatar,
            COUNT(*) AS entries,
            SUM(CASE WHEN e.finish_place = 1 THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN e.prize > 0 THEN 1 ELSE 0 END) AS itm,
            COALESCE(SUM(e.prize), 0) AS prize
       FROM holdem_entries e
       JOIN holdem_tournaments t ON t.id = e.tournament_id
       JOIN users u ON u.id = e.user_id
      WHERE ${holdemWindow(s)}
      GROUP BY e.user_id
      ORDER BY prize DESC, wins DESC, entries DESC, e.user_id ASC
      LIMIT ?`, s.started_at, s.closed_at, s.closed_at, limit);
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

/** 그 시즌에 끝난 대회가 하나라도 있는가 — 홀덤 카테고리를 띄울지 정한다. */
export function seasonHoldemCount(seasonId: number): number {
  const s = getSeason(seasonId);
  if (!s) return 0;
  return one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM holdem_tournaments t WHERE ${holdemWindow(s)}`,
    s.started_at, s.closed_at, s.closed_at)!.n;
}

/** 홀덤에서의 내 자리. 상금 순이라 나보다 상금이 많은 사람 수로 등수를 센다. */
export function myHoldemRank(seasonId: number, userId: string):
  { rank: number; total: number; score: number; entries: number; wins: number; itm: number } | null {
  const rows = seasonHoldemRanking(seasonId, 100000);
  const i = rows.findIndex(r => r.userId === userId);
  if (i < 0) return null;
  const r = rows[i];
  return { rank: r.rank, total: rows.length, score: r.prize,
    entries: r.entries, wins: r.wins, itm: r.itm };
}

/** 그 시즌에 한 판이라도 한 사람 수. 통합 랭킹·성적표와 같은 기준이다. */
export function seasonPlayers(seasonId: number): number {
  return one<{ n: number }>(
    `SELECT COUNT(DISTINCT user_id) AS n FROM season_stats WHERE season_id = ? AND rounds > 0`,
    seasonId)!.n;
}

export interface SeasonRankRow {
  userId: string; username: string; avatar: string | null;
  score: number;                 // 통합 랭킹의 점수 = 잔액
  rank: number;
}

/** 통합 랭킹. 진행 중이면 실시간 잔액, 닫힌 시즌이면 찍어 둔 성적표. */
export function seasonOverall(seasonId: number, limit = 100): SeasonRankRow[] {
  const s = getSeason(seasonId);
  if (!s) return [];
  if (s.closed_at != null) {
    return all<SeasonRankRow>(
      `SELECT r.user_id AS userId, u.username, u.avatar, r.balance AS score, r.rank
         FROM season_results r JOIN users u ON u.id = r.user_id
        WHERE r.season_id = ? ORDER BY r.rank ASC LIMIT ?`, seasonId, limit);
  }
  /* 진행 중인 시즌은 "그 시즌에 한 판이라도 한 사람"만 센다. 가입만 하고 안 논 사람이
     시작 잔액 그대로 순위표 위쪽에 앉아 있으면 순위가 아무 뜻이 없다. */
  const rows = all<{ userId: string; username: string; avatar: string | null; score: number }>(
    `SELECT u.id AS userId, u.username, u.avatar, u.balance AS score
       FROM users u
      WHERE EXISTS (SELECT 1 FROM season_stats s
                     WHERE s.season_id = ? AND s.user_id = u.id AND s.rounds > 0)
      ORDER BY u.balance DESC, u.id ASC LIMIT ?`, seasonId, limit);
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

export interface SeasonGameRankRow {
  userId: string; username: string; avatar: string | null;
  rounds: number; rated: number; wins: number; pushes: number; profit: number;
  rank: number;
}

/** 게임별 랭킹 — 순수익 순. 승률은 화면에서 rated 를 분모로 계산한다. */
export function seasonGameRanking(seasonId: number, game: string, limit = 100): SeasonGameRankRow[] {
  const rows = all<Omit<SeasonGameRankRow, 'rank'>>(
    `SELECT s.user_id AS userId, u.username, u.avatar,
            s.rounds, s.rated, s.wins, s.pushes, s.profit
       FROM season_stats s JOIN users u ON u.id = s.user_id
      WHERE s.season_id = ? AND s.game = ? AND s.rounds > 0
      ORDER BY s.profit DESC, s.rounds DESC, s.user_id ASC LIMIT ?`, seasonId, game, limit);
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

/** 내 자리. 목록 밖으로 밀려나도 아래 고정바에 보여 주기 위한 것이다. */
export function mySeasonRank(seasonId: number, userId: string, game: string | null):
  { rank: number; total: number; score: number; rounds?: number; rated?: number; wins?: number; pushes?: number } | null {
  const s = getSeason(seasonId);
  if (!s) return null;

  if (game) {
    const mine = one<{ profit: number; rounds: number; rated: number; wins: number; pushes: number }>(
      `SELECT profit, rounds, rated, wins, pushes FROM season_stats
        WHERE season_id = ? AND user_id = ? AND game = ?`, seasonId, userId, game);
    if (!mine || mine.rounds <= 0) return null;
    const above = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM season_stats
        WHERE season_id = ? AND game = ? AND rounds > 0 AND profit > ?`,
      seasonId, game, mine.profit)!;
    const total = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM season_stats WHERE season_id = ? AND game = ? AND rounds > 0`,
      seasonId, game)!;
    return { rank: above.n + 1, total: total.n, score: mine.profit,
      rounds: mine.rounds, rated: mine.rated, wins: mine.wins, pushes: mine.pushes };
  }

  if (s.closed_at != null) {
    const r = one<{ rank: number; balance: number }>(
      `SELECT rank, balance FROM season_results WHERE season_id = ? AND user_id = ?`,
      seasonId, userId);
    if (!r) return null;
    const total = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM season_results WHERE season_id = ?`, seasonId)!;
    return { rank: r.rank, total: total.n, score: r.balance };
  }
  const me = one<{ balance: number }>(`SELECT balance FROM users WHERE id = ?`, userId);
  if (!me) return null;
  const played = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM season_stats WHERE season_id = ? AND user_id = ? AND rounds > 0`,
    seasonId, userId)!;
  if (played.n === 0) return null;
  const above = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM users u
      WHERE u.balance > ? AND EXISTS (SELECT 1 FROM season_stats s
        WHERE s.season_id = ? AND s.user_id = u.id AND s.rounds > 0)`, me.balance, seasonId)!;
  const total = one<{ n: number }>(
    `SELECT COUNT(DISTINCT user_id) AS n FROM season_stats WHERE season_id = ? AND rounds > 0`,
    seasonId)!;
  return { rank: above.n + 1, total: total.n, score: me.balance };
}

/**
 * 첫 시즌에 통산 기록을 옮겨 담는다.
 *
 * 시즌 표를 만들기 전의 판은 season_stats 에 없다 — 집계가 그때부터 시작하기 때문이다.
 * 그래서 시즌 0 을 열면 랭킹이 비어 보인다. 그런데 시즌 0 의 범위는 "지금까지 전부"이므로
 * 통산 기록(game_stats)이 곧 시즌 0 의 기록이다. 그대로 옮기면 된다.
 *
 * 덮어쓰기라 여러 번 눌러도 결과가 같다. bumpGameStats 가 두 장부에 함께 쓰므로
 * 옮긴 뒤에 들어온 판도 game_stats 에 들어 있고, 다시 옮기면 그 합이 그대로 나온다 —
 * 더하기가 아니라 맞추기라서 중복으로 불어나지 않는다.
 *
 * 첫 시즌에만 허용한다. 시즌이 한 번이라도 닫힌 뒤에는 통산 기록이 여러 시즌에 걸쳐
 * 있어서, 그걸 특정 시즌에 통째로 부으면 그 시즌 기록이 거짓이 된다.
 */
export function backfillFirstSeason():
  { ok: true; rows: number } | { ok: false; error: 'not_first_season' | 'no_open_season' } {
  return tx(() => {
    if (one<{ n: number }>(`SELECT COUNT(*) AS n FROM seasons WHERE closed_at IS NOT NULL`)!.n > 0) {
      return { ok: false as const, error: 'not_first_season' as const };
    }
    const s = one<SeasonRow>(
      `SELECT * FROM seasons WHERE closed_at IS NULL ORDER BY number ASC LIMIT 1`);
    if (!s) return { ok: false as const, error: 'no_open_season' as const };
    run(
      `INSERT INTO season_stats (season_id, user_id, game, rounds, rated, wins, pushes,
         staked, returned, profit, updated_at)
       SELECT ?, user_id, game, rounds, rated, wins, pushes, staked, returned, profit, updated_at
         FROM game_stats WHERE rounds > 0
       ON CONFLICT(season_id, user_id, game) DO UPDATE SET
         rounds = excluded.rounds, rated = excluded.rated, wins = excluded.wins,
         pushes = excluded.pushes, staked = excluded.staked, returned = excluded.returned,
         profit = excluded.profit, updated_at = excluded.updated_at`, s.id);
    /* 시작 시각을 기록이 실제로 시작된 시점까지 당긴다.
       이걸 안 하면 첫 시즌이 자기 약속을 어긴다 — 게임 전적은 시점과 무관하게 전부
       담으면서, 홀덤만 finished_at 이 시즌 구간 안이어야 세기 때문이다. 시즌 행이
       만들어진 시각이 곧 시작이라, 그 전에 끝난 대회는 통째로 빠졌다(실제로 그랬다:
       대회가 끝난 지 13시간 뒤에 시즌을 열었더니 홀덤 탭이 아예 안 떴다).

       첫 시즌에서만 한다 — 위에서 이미 "닫힌 시즌이 없다"를 확인했다. 두 번째
       시즌부터는 앞 시즌이 끝난 시각이 곧 시작이고, 그 경계를 뒤로 물리면 같은
       기록이 두 시즌에 들어간다. */
    const first = one<{ at: number | null }>(
      `SELECT MIN(at) AS at FROM (
         SELECT MIN(created_at) AS at FROM points_ledger
         UNION ALL SELECT MIN(finished_at) FROM holdem_tournaments WHERE finished_at IS NOT NULL
         UNION ALL SELECT MIN(created_at) FROM users)`)?.at ?? null;
    if (first != null && first < s.started_at) {
      run(`UPDATE seasons SET started_at = ? WHERE id = ?`, first, s.id);
    }
    return { ok: true as const,
      rows: one<{ n: number }>(`SELECT COUNT(*) AS n FROM season_stats WHERE season_id = ?`, s.id)!.n };
  });
}

/** 진행 중인 시즌의 안내 문구와 예정 종료 시각을 고친다. 점수·집계에는 손대지 않는다. */
export function updateSeason(id: number, o: { name?: string; reward?: string; endsAt?: number | null }): boolean {
  const s = getSeason(id);
  if (!s || s.closed_at != null) return false;      // 닫힌 시즌의 기록은 고치지 않는다
  run(`UPDATE seasons SET name = ?, reward = ?, ends_at = ? WHERE id = ?`,
    o.name ?? s.name, o.reward ?? s.reward,
    o.endsAt === undefined ? s.ends_at : o.endsAt, id);
  return true;
}

/**
 * 시즌을 닫고 다음 시즌을 연다.
 *
 * 순서가 중요하다. 점수를 먼저 찍고 나서 잔액을 초기화한다 — 반대로 하면 그 시즌의
 * 점수가 사라진다. 초기화는 adjustBalance 로 한다. 잔액을 직접 UPDATE 하면
 * "잔액 = 원장 누적합"이 깨지고, 그 불변식은 감사가 매번 검사한다.
 *
 * 게임별 전적은 지우지 않는다. season_stats 의 열쇠에 시즌이 들어 있어서 다음 시즌은
 * 행이 없는 상태로 시작한다 — 지난 시즌 기록은 그대로 남아 언제든 다시 볼 수 있다.
 */
export function closeSeason(opts: { seed: number; nextName?: string; nextReward?: string }):
  { ok: true; closed: number; ranked: number; nextNumber: number } | { ok: false; error: 'no_open_season' } {
  return tx(() => {
    const s = one<SeasonRow>(
      `SELECT * FROM seasons WHERE closed_at IS NULL ORDER BY number DESC LIMIT 1`);
    if (!s) return { ok: false as const, error: 'no_open_season' as const };
    const now = Math.floor(Date.now() / 1000);
    const seed = Math.max(0, Math.floor(opts.seed));

    /* 성적표는 "그 시즌에 한 판이라도 한 사람"만 담는다 — 통합 랭킹과 같은 기준이라야
       화면에서 보던 순위와 성적표가 어긋나지 않는다. */
    const players = all<{ id: string; balance: number }>(
      `SELECT u.id, u.balance FROM users u
        WHERE EXISTS (SELECT 1 FROM season_stats s
                       WHERE s.season_id = ? AND s.user_id = u.id AND s.rounds > 0)
        ORDER BY u.balance DESC, u.id ASC`, s.id);
    players.forEach((p, i) => {
      run(`INSERT INTO season_results (season_id, user_id, balance, rank) VALUES (?, ?, ?, ?)
           ON CONFLICT(season_id, user_id) DO UPDATE SET balance = excluded.balance, rank = excluded.rank`,
        s.id, p.id, p.balance, i + 1);
    });

    // 잔액 초기화 — 전원을 같은 시작점으로. 원장에 남겨야 불변식이 유지된다.
    const everyone = all<{ id: string; balance: number }>(`SELECT id, balance FROM users`);
    for (const u of everyone) {
      const delta = seed - u.balance;
      if (delta !== 0) adjustBalance(u.id, delta, 'season:reset:' + s.number);
    }

    /* 지원금 쿨다운을 함께 푼다.
       새 시즌은 0 에서 시작하는데, claimRelief 는 잔액이 정확히 0 일 때만 나가고
       쿨다운이 2시간이다. 시즌 종료 직전에 지원금을 받은 사람은 새 시즌이 열려도
       최대 2시간 동안 0 원에 묶여 아무것도 못 한다 — 시작선이 사람마다 달라진다.
       (출석 연속일수는 건드리지 않는다. 그건 시즌 점수가 아니라 개인 습관 기록이고,
       초기화하면 랭킹 리셋이 아니라 벌칙처럼 느껴진다.) */
    run(`UPDATE users SET last_relief_at = NULL`);

    run(`UPDATE seasons SET closed_at = ? WHERE id = ?`, now, s.id);
    const nextNumber = s.number + 1;
    run(`INSERT INTO seasons (number, name, reward, started_at) VALUES (?, ?, ?, ?)`,
      nextNumber, opts.nextName ?? '', opts.nextReward ?? '', now);
    return { ok: true as const, closed: s.number, ranked: players.length, nextNumber };
  });
}
