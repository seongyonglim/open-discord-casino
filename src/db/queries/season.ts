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
