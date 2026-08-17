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
import { rewardsForSeason } from '../../services/rewards';

export interface SeasonRow {
  id: number; number: number; name: string;
  started_at: number; ends_at: number | null; closed_at: number | null;
}
/* seasons.reward 열은 더 이상 읽지도 쓰지도 않는다. 랭킹 화면에 자유 문구 한 줄을
   띄우는 자리였는데, 보상은 공지로 알리는 것이라 같은 말이 두 곳에 있으면 어긋난다.
   열은 남겨 둔다 — 지우면 예전 코드로 되돌렸을 때 INSERT 가 깨진다. 기본값이 ''이라
   빼고 넣어도 문제가 없다. */

export function listSeasons(): SeasonRow[] {
  currentSeasonId();                      // 하나도 없으면 시즌 0 을 열고 시작한다
  return all<SeasonRow>(`SELECT * FROM seasons ORDER BY number DESC`);
}

/* ── 누가 이번 시즌의 참가자인가 ──────────────────────────────────────
   예전 기준은 "한 판이라도 한 사람"이었다. 그런데 출석만 하고 아직 안 건 사람도 이
   카지노의 참가자다 — 그 사람 화면에는 자기 이름이 순위표 어디에도 없었다.
   그래서 기준을 "이번 시즌에 포인트가 오간 적이 있는가"로 넓힌다. 출석·파산 지원금·
   주간 보너스·관리자 지급·게임이 전부 여기 들어온다.

   시즌 초기화 줄(season:reset:*)은 반드시 뺀다. 그 줄은 시즌이 열릴 때 전원에게 한 번씩
   찍히므로, 세면 가입만 하고 한 번도 안 들어온 사람까지 전부 순위표에 올라온다 —
   그러면 시작 잔액 그대로인 사람들이 위쪽에 앉아 순위가 아무 뜻이 없어진다.

   u 는 바깥 질의의 users 별칭이다. 이 조각을 쓰는 질의는 users 를 u 로 열어야 한다.
   묶는 값은 두 개: 시즌 시작 시각, 끝 시각(진행 중이면 아주 먼 미래). */
const ACTIVE_IN_SEASON = `EXISTS (
      SELECT 1 FROM points_ledger p
       WHERE p.user_id = u.id AND p.created_at >= ? AND p.created_at < ?
         AND p.reason NOT LIKE 'season:reset:%')`;
const FAR_FUTURE = 9_999_999_999;
const seasonWindow = (s: SeasonRow): [number, number] => [s.started_at, s.closed_at ?? FAR_FUTURE];

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

/**
 * 그 시즌 구간에서 끝난 대회. 취소된 대회는 finished_at 이 없어 저절로 빠진다.
 *
 * 첫 시즌에는 아래쪽 경계를 두지 않는다. 시즌 행이 만들어진 시각이 곧 시작인데, 서비스는
 * 그보다 먼저 돌고 있었으므로 그 전에 끝난 대회가 시즌 밖으로 밀려난다 — 실제로 그랬다.
 * 대회가 끝난 지 13시간 뒤에 시즌을 열었더니 랭킹에 홀덤 탭이 아예 안 떴고, 아무 에러도
 * 없이 그냥 없는 카테고리가 됐다.
 *
 * 첫 시즌보다 앞선 시즌은 없으므로, 그 전의 기록을 가져갈 다른 주인도 없다. 같은 대회가
 * 두 시즌에 들어갈 일이 없다는 뜻이다. 둘째 시즌부터는 앞 시즌이 끝난 시각이 곧 시작이고
 * 그 경계는 반드시 지켜야 한다.
 */
/* 경계를 «시작 초과 · 마감 이하» 로 둔다.
   예전에는 «시작 이상 · 마감 미만» 이었다. closeSeason 이 닫는 시각과 다음 시즌의 시작
   시각을 같은 now 로 쓰기 때문에, 마감과 **같은 초**에 끝난 대회가 닫힌 시즌에서는 빠지고
   다음 시즌으로 밀렸다(실측: 랭킹 2줄 → 0줄, 그 대회가 유일했으면 홀덤 탭이 통째로
   사라진다). 그 대회를 근거로 all-first-1 은 이미 지급된 상태라 판정과 표시가 어긋난다.

   상한만 «이하» 로 바꾸면 안 된다 — closed_at == 다음 시즌 started_at 이라 같은 대회가
   두 시즌에 동시에 들어간다(실측 시즌 = [1, 2]). 하한을 «초과» 로 함께 옮겨야 한 시즌에만
   속한다. 첫 시즌은 하한이 없으므로(isFirstSeason) 영향이 없고, 진행 중 시즌은
   closed_at 이 NULL 이라 상한이 걸리지 않아 그대로다. */
/* ── 대회의 장르 ────────────────────────────────────────────────────
   같은 홀덤이지만 "무엇으로 버느냐"가 다른 두 게임이다. 하나의 표에 섞으면 한쪽이
   통째로 0 으로 잡힌다 — 실제로 그랬다:

     8/16 미스터리 바운티(7인 · 인당 20,000P · 바운티 100%)에서 우승자가 72,800P,
     2위가 53,200P 를 가져갔는데 랭킹에는 둘 다 «상금 0P» 로 찍혀 최하위권에 앉았다.
     그 대회는 순위 상금이 0 이고 돈이 전부 bounty_paid 로 나가는데, 집계가
     SUM(e.prize) 만 보고 있었기 때문이다. 입상 횟수(ITM)도 prize > 0 으로 세서
     참가자 전원이 0 이 됐다.

   그래서 장르를 갈라 각각의 표를 만들고, 표마다 그 장르에서 실제로 번 돈을 센다.
   일반 대회에서 바운티 칸은 언제나 0 이므로 합계에 넣어도 결과는 같지만, 넣지 않는다 —
   "이 표는 순위 상금 표"라는 말이 SQL 에도 그대로 적혀 있어야 나중에 읽는 사람이
   두 표의 차이를 코드에서 확인할 수 있다. */
export type HoldemGenre = 'CLASSIC' | 'BOUNTY';
const GENRE_MODE: Record<HoldemGenre, string> = {
  CLASSIC: `t.mode = 'CLASSIC'`,
  /* 바운티 헌터와 미스터리 바운티는 한 표에 둔다. 잡아서 버는 게임이라는 점이 같고,
     둘을 또 가르면 대회 수가 적어 표가 각각 한두 줄짜리가 된다. */
  BOUNTY: `t.mode IN ('PKO_BOUNTY', 'MYSTERY_BOUNTY')`,
};
/** 그 장르에서 «번 돈». 일반은 순위 상금뿐이고, 바운티는 순위 상금 + 받은 바운티다. */
const GENRE_TOOK: Record<HoldemGenre, string> = {
  CLASSIC: `e.prize`,
  /* bounty_won 이 아니라 bounty_paid 다. 앞은 진행 중 누계(확보했다는 표시)이고
     실제로 지갑에 들어간 금액은 뒤쪽이다 — 대회가 중단되면 앞은 남고 뒤는 0 이다. */
  BOUNTY: `(e.prize + e.bounty_paid)`,
};

function holdemWindow(s: SeasonRow, genre?: HoldemGenre): string {
  const lower = isFirstSeason(s) ? `(? IS NOT NULL OR 1)` : `t.finished_at > ?`;
  /* 장르 조건은 값을 바인딩하지 않고 문자열로 붙인다 — 위의 상수 표에서만 오는 값이라
     바깥에서 들어올 길이 없고, 바인딩을 섞으면 이 함수를 쓰는 네 곳의 인자 순서가
     전부 달라진다. */
  const mode = genre ? ` AND ${GENRE_MODE[genre]}` : '';
  return `t.finished_at IS NOT NULL AND ${lower}
          AND (? IS NULL OR t.finished_at <= ?)${mode}`;
}

/** 이 시즌보다 앞선 시즌이 있는가. 없으면 그 전의 기록은 전부 이 시즌 몫이다. */
function isFirstSeason(s: SeasonRow): boolean {
  return one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM seasons WHERE number < ?`, s.number)!.n === 0;
}

export interface SeasonHoldemRow {
  userId: string; username: string; avatar: string | null;
  entries: number; wins: number; itm: number; prize: number; rank: number;
}

export function seasonHoldemRanking(
  seasonId: number, genre: HoldemGenre, limit = 100
): SeasonHoldemRow[] {
  const s = getSeason(seasonId);
  if (!s) return [];
  const took = GENRE_TOOK[genre];
  const rows = all<Omit<SeasonHoldemRow, 'rank'>>(
    `SELECT e.user_id AS userId, u.username, u.avatar,
            COUNT(*) AS entries,
            SUM(CASE WHEN e.finish_place = 1 THEN 1 ELSE 0 END) AS wins,
            /* 입상(ITM)도 그 장르에서 번 돈으로 센다. prize > 0 으로 세면 바운티
               100% 대회는 참가자 전원이 0 이 된다 — 실제로 그랬다. */
            SUM(CASE WHEN ${took} > 0 THEN 1 ELSE 0 END) AS itm,
            COALESCE(SUM(${took}), 0) AS prize
       FROM holdem_entries e
       JOIN holdem_tournaments t ON t.id = e.tournament_id
       JOIN users u ON u.id = e.user_id
      WHERE ${holdemWindow(s, genre)}
      GROUP BY e.user_id
      ORDER BY prize DESC, wins DESC, entries DESC, e.user_id ASC
      LIMIT ?`, s.started_at, s.closed_at, s.closed_at, limit);
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

/** 그 시즌에 끝난 대회가 하나라도 있는가 — 홀덤 카테고리를 띄울지 정한다. */
export function seasonHoldemCount(seasonId: number, genre?: HoldemGenre): number {
  const s = getSeason(seasonId);
  if (!s) return 0;
  return one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM holdem_tournaments t WHERE ${holdemWindow(s, genre)}`,
    s.started_at, s.closed_at, s.closed_at)!.n;
}

/**
 * 그 시즌 대회에 한 번이라도 나온 사람 수.
 *
 * 탭 옆의 작은 숫자가 이 값이다 — 다른 게임은 "몇 명이 했나"를 띄우는데 홀덤만 0을
 * 넣어 두어 배지가 아예 안 붙었다. 대회 수가 아니라 사람 수여야 다른 탭과 뜻이 같다.
 */
export function seasonHoldemPlayers(seasonId: number, genre?: HoldemGenre): number {
  const s = getSeason(seasonId);
  if (!s) return 0;
  return one<{ n: number }>(
    `SELECT COUNT(DISTINCT e.user_id) AS n
       FROM holdem_entries e JOIN holdem_tournaments t ON t.id = e.tournament_id
      WHERE ${holdemWindow(s, genre)}`,
    s.started_at, s.closed_at, s.closed_at)!.n;
}

/** 홀덤에서의 내 자리. 상금 순이라 나보다 상금이 많은 사람 수로 등수를 센다. */
export function myHoldemRank(seasonId: number, userId: string, genre: HoldemGenre):
  { rank: number; total: number; score: number; entries: number; wins: number; itm: number } | null {
  const rows = seasonHoldemRanking(seasonId, genre, 100000);
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
  const rows = all<{ userId: string; username: string; avatar: string | null; score: number }>(
    `SELECT u.id AS userId, u.username, u.avatar, u.balance AS score
       FROM users u
      WHERE ${ACTIVE_IN_SEASON}
      ORDER BY u.balance DESC, u.id ASC LIMIT ?`, ...seasonWindow(s), limit);
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

export interface SeasonGameRankRow {
  userId: string; username: string; avatar: string | null;
  rounds: number; rated: number; wins: number; pushes: number; profit: number;
  rank: number;
}

/** 게임별 랭킹 — 순수익 순. 승률은 화면에서 rated 를 분모로 계산한다.
 *
 *  여기는 통합 랭킹과 기준이 다르다: 그 게임을 한 판이라도 한 사람만 오른다.
 *  통합 랭킹이 "이번 시즌의 참가자"를 보여주는 자리라면, 게임 탭은 "그 게임을 한
 *  사람들의 성적"이다 — 안 한 사람을 0판으로 채우면 그 게임을 실제로 한 사람이
 *  0판 줄에 파묻힌다. */
export function seasonGameRanking(seasonId: number, game: string, limit = 100): SeasonGameRankRow[] {
  const rows = all<Omit<SeasonGameRankRow, 'rank'>>(
    `SELECT s.user_id AS userId, u.username, u.avatar,
            s.rounds, s.rated, s.wins, s.pushes, s.profit
       FROM season_stats s JOIN users u ON u.id = s.user_id
      WHERE s.season_id = ? AND s.game = ? AND s.rounds > 0
      ORDER BY s.profit DESC, s.rounds DESC, s.user_id ASC LIMIT ?`, seasonId, game, limit);
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

/* ── 나 혼자만 1등 ────────────────────────────────────────────────────
   "전 종목 1위로 시즌을 끝낸다". 카테고리 목록을 여기 적지 않고 RANK_GAMES(services/ranking)
   에서 읽는다 — 게임이 늘면 그 표에 한 줄이 들어가고, 이 과제의 조건도 함께 넓어진다.
   요청 사항이 "향후 추가되는 게임도 나중에 포함"이었고, 목록을 두 곳에 두면 그때 한쪽만
   늘어난다. 홀덤은 RANK_GAMES 에 없다(프리롤이라 순수익 지표를 쓸 수 없어서다) —
   대신 대회 순위가 따로 있어 여기서 한 줄 더 붙인다.

   판정은 엄격하다: 한 종목이라도 그 시즌에 아무도 안 했으면 1위가 없으므로 아무도 못 딴다.
   "전 종목"이 조건이니 그것이 맞는 결과다 — 한 종목만 열린 시즌에 그 1위가 이 과제를
   가져가면 이름이 거짓말이 된다. */
function awardSeasonSweep(seasonId: number): void {
  try {
    const { RANK_GAMES } = require('../../services/ranking') as typeof import('../../services/ranking');
    const { unlockAchievement } = require('../achievements') as typeof import('../achievements');
    const tops = new Set<string>();
    for (const game of new Set(Object.values(RANK_GAMES))) {
      const top = seasonGameRanking(seasonId, game, 1)[0];
      if (!top) return;                       // 아무도 안 한 종목이 있다 — 전 종목이 아니다
      tops.add(top.userId);
      if (tops.size > 1) return;              // 이미 갈렸다
    }
    /* 홀덤 토너먼트는 대상에서 뺀다.
       한때 넣었다 — 화면에 탭이 둘(클래식 · 바운티)이니 "전 종목"도 둘 다여야 한다는
       이유였다. 그런데 대회는 하루 한 판이고 사람이 열댓 명이라, 미니게임 다섯 종목을
       전부 1위로 잡고도 그날 대회에서 한 번 미끄러지면 시즌 내내 못 따라잡는다.
       달성이 실력이 아니라 그날 운에 걸리면 그건 목표가 아니라 벽이다.
       지금은 상시로 도는 종목들만 본다 — RANK_GAMES 가 그 목록이다. */
    if (tops.size !== 1) return;
    unlockAchievement([...tops][0], 'all-first-1');
  } catch (e) {
    /* 판정이 던져도 시즌 마감은 끝나야 한다. 여기서 트랜잭션이 롤백되면 성적표도, 잔액
       초기화도 안 되고, 예약은 남아 다음 요청에서 또 시도한다 — 훨씬 나쁜 실패다. */
    console.error('나 혼자만 1등 판정 오류:', e);
  }
}

/** 내 자리. 목록 밖으로 밀려나도 아래 고정바에 보여 주기 위한 것이다. */
export function mySeasonRank(seasonId: number, userId: string, game: string | null):
  { rank: number; total: number; score: number; rounds?: number; rated?: number; wins?: number; pushes?: number } | null {
  const s = getSeason(seasonId);
  if (!s) return null;

  /* 아래 고정바는 그 탭의 목록과 같은 사람들을 세어야 한다. 기준이 목록과 다르면
     목록에는 있는데 "내 자리"만 안 보이거나 등수가 어긋난다. 그래서 게임 탭은
     "한 판이라도 한 사람", 통합은 "이번 시즌 참가자"로 각각 맞춘다. */
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
  const [from, to] = seasonWindow(s);

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
  /* 목록에 없는 사람에게 등수를 주면 안 된다 — 가입만 하고 아무 일도 없던 사람에게
     "32명 중 5위"가 뜨는데 정작 목록에는 자기 이름이 없다. */
  const active = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM users u WHERE u.id = ? AND ${ACTIVE_IN_SEASON}`,
    userId, from, to)!.n > 0;
  if (!active) return null;
  const above = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM users u WHERE u.balance > ? AND ${ACTIVE_IN_SEASON}`,
    me.balance, from, to)!;
  const total = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM users u WHERE ${ACTIVE_IN_SEASON}`, from, to)!;
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
export function updateSeason(id: number, o: { name?: string; endsAt?: number | null }): boolean {
  const s = getSeason(id);
  if (!s || s.closed_at != null) return false;      // 닫힌 시즌의 기록은 고치지 않는다
  run(`UPDATE seasons SET name = ?, ends_at = ? WHERE id = ?`,
    o.name ?? s.name, o.endsAt === undefined ? s.ends_at : o.endsAt, id);
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
export function closeSeason(opts: { seed: number; nextName?: string }):
  { ok: true; closed: number; ranked: number; nextNumber: number } | { ok: false; error: 'no_open_season' } {
  return tx(() => {
    const s = one<SeasonRow>(
      `SELECT * FROM seasons WHERE closed_at IS NULL ORDER BY number DESC LIMIT 1`);
    if (!s) return { ok: false as const, error: 'no_open_season' as const };
    const now = Math.floor(Date.now() / 1000);
    const seed = Math.max(0, Math.floor(opts.seed));

    /* 성적표는 통합 랭킹과 같은 사람들을 담아야 한다 — 기준이 다르면 시즌이 닫히는
       그 순간 화면에서 보던 사람이 성적표에서 사라진다. 그래서 여기도 ACTIVE_IN_SEASON 이다.

       끝을 now 로 자르지 않는다. 원장의 시각은 초 단위라, 닫히는 그 초에 들어온 판이
       "미래"로 밀려 통째로 빠진다(감사에서 실제로 전원이 빠졌다). 초기화 줄은 아직
       찍히지도 않았고, 찍혀도 reason 으로 걸러진다 — 위를 열어 둬도 새어 들어올 것이 없다. */
    const players = all<{ id: string; balance: number }>(
      `SELECT u.id, u.balance FROM users u
        WHERE ${ACTIVE_IN_SEASON}
        ORDER BY u.balance DESC, u.id ASC`, s.started_at, FAR_FUTURE);
    players.forEach((p, i) => {
      run(`INSERT INTO season_results (season_id, user_id, balance, rank) VALUES (?, ?, ?, ?)
           ON CONFLICT(season_id, user_id) DO UPDATE SET balance = excluded.balance, rank = excluded.rank`,
        s.id, p.id, p.balance, i + 1);
    });
    /* ── 도전과제: 나 혼자만 1등 ─────────────────────────────────────
       이 시즌의 모든 게임 카테고리에서 같은 사람이 1위인가. 시즌이 닫히는 이 순간에만
       판정할 수 있다 — 그 뒤에는 전적이 0에서 다시 시작하므로 되짚을 방법이 없다.

       자리가 중요하다. 성적표(season_results)를 **찍은 다음**, 잔액을 초기화하기 **전에**,
       그리고 closed_at 을 세우기 **전에** 본다.
         · 성적표 뒤 — 예전에는 이 호출이 INSERT 앞에 있어서 주석이 말하는 것과 순서가
           반대였다. 지금 판정은 season_stats·holdem_entries 만 보므로 결과는 같지만,
           이 주석을 믿고 "성적표에서 1위를 읽는" 판정을 나중에 붙이면 빈 표를 보고
           아무도 못 받는다.
         · 초기화 전 — 잔액을 근거로 쓰는 판정이 붙어도 시즌 값을 본다.
         · closed_at 전 — 세운 뒤에 부르면 홀덤 창 상한(holdemWindow)이 닫히면서 마감과
           같은 초에 끝난 대회가 집계에서 빠진다. */
    awardSeasonSweep(s.id);

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

       출석 연속일수도 함께 되돌린다. 시즌이 바뀌면 도전과제를 뺀 모든 기록이 0 에서
       다시 시작한다는 것이 이 서비스의 규칙이고, 연속일수만 남으면 그 규칙에 예외가
       하나 생긴다 — 어느 것이 남고 어느 것이 지워지는지를 사람이 외워야 한다.
       마지막 출석 날짜도 함께 지운다: 연속일수만 0 으로 두면 그날 이미 출석한 사람이
       새 시즌 첫날을 건너뛰게 되어, 시작선이 또 사람마다 달라진다. */
    run(`UPDATE users SET last_relief_at = NULL, current_streak = 0, last_checkin_date = NULL`);

    run(`UPDATE seasons SET closed_at = ? WHERE id = ?`, now, s.id);
    const nextNumber = s.number + 1;
    run(`INSERT INTO seasons (number, name, started_at) VALUES (?, ?, ?)`,
      nextNumber, opts.nextName ?? '', now);

    /* 프리롤 상금을 새 시즌 기본값까지 끌어올린다.
       상금 배수는 운영자가 템플릿에 저장해 두면 그 값이 시즌 기본값을 이긴다(그게 옳다 —
       명시한 값을 코드가 조용히 덮으면 안 된다). 그런데 시즌이 오르면 그 규칙 때문에
       공지한 금액과 실제가 어긋난다: 시즌 1 프리롤을 5배로 올린다고 알려 놓고 저장된
       옛 값으로 열리는 것이다. multiplierBehindSeason 이 화면에 띄워 주던 그 상황이고,
       사람이 잊으면 첫 대회가 그대로 나간다.

       올리기만 한다. 새 기본값보다 높게 잡아 둔 값은 건드리지 않는다 — 그건 운영자가
       일부러 더 준 것이고, 시즌이 바뀌었다고 깎을 이유가 없다. */
    const r = rewardsForSeason(nextNumber);
    for (const [key, want] of [
      ['weekdayMultiplier', r.freerollPerHead],
      ['weekendMultiplier', r.freerollPerHeadWeekend],
    ] as const) {
      const cur = one<{ value: string }>(`SELECT value FROM holdem_settings WHERE key = ?`, key);
      if (cur == null) continue;                  // 저장된 값이 없으면 기본값이 그대로 쓰인다
      const n = Number(cur.value);
      if (Number.isFinite(n) && n < want) {
        run(`UPDATE holdem_settings SET value = ?, updated_at = unixepoch() WHERE key = ?`,
          String(want), key);
      }
    }
    return { ok: true as const, closed: s.number, ranked: players.length, nextNumber };
  });
}
