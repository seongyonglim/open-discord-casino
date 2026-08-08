/* 도전과제.
 *
 * 과제는 코드가 아니라 데이터다. achievements 표에 줄을 하나 넣으면 화면에 바로 뜨고,
 * 화면은 어떤 과제가 있는지 전혀 모른다 — 분류(game_type)로 묶어 늘어놓을 뿐이다.
 * 그래서 새 과제를 붙일 때 고칠 곳은 "언제 달성인가"를 판정하는 자리 하나뿐이다.
 *
 * 달성 기록(user_achievements)은 시즌이 바뀌어도 지우지 않는다. 잔액은 모두 같은
 * 자리에서 다시 시작하지만 "무엇을 해냈는가"는 계정에 남는 기록이다.
 */
import { one, all, run, tx } from './queries';
import { notifyUser } from './notifications';

/* 분류. 'ALL' 은 게임을 가리지 않는 과제(출석·누적 등)이고 탭에서는 [공통]에 들어간다 —
   [전체] 탭은 필터가 아니라 "전부 보기"라 따로 둔다.
   나머지는 게임 하나씩이고, 이름은 로비의 게임 키와 같은 뜻으로 쓴다. */
export const GAME_TYPES = [
  'ALL', 'HOLDEM', 'BACCARAT', 'BLACKJACK', 'POKER', 'MINES', 'CRASH', 'LADDER',
] as const;
export type GameType = typeof GAME_TYPES[number];

/* 탭. 게임마다 하나씩, 이름과 순서는 로비의 게임 목록을 그대로 따른다 —
   같은 게임을 로비에서는 "그래프게임", 여기서는 "그래프"라고 부르면 같은 것인지
   확인해야 한다. 예전에는 뒤쪽 셋을 [기타]로 묶었는데, 자기 게임의 과제를 찾는 사람에게
   [기타]는 "여기 있는지 없는지 눌러 봐야 아는 칸"이다.

   탭이 아홉이라 한 줄에 안 들어가지만 가로로 넘겨 볼 수 있게 해 뒀다(.ac-tabs).
   과제가 없는 탭은 빈 화면이 되는데, 그건 "아직 없다"는 사실을 그대로 보여주는 것이라
   묶어서 감추는 것보다 낫다. */
export const ACH_TABS: { key: string; label: string; types: GameType[] }[] = [
  { key: 'all', label: '전체', types: [] },   // 빈 배열 = 거르지 않는다
  { key: 'holdem', label: '♠️ 홀덤 프리롤', types: ['HOLDEM'] },
  { key: 'baccarat', label: '🀄 바카라', types: ['BACCARAT'] },
  { key: 'blackjack', label: '🃏 블랙잭', types: ['BLACKJACK'] },
  { key: 'poker', label: '🎴 포커 플립', types: ['POKER'] },
  { key: 'mines', label: '💣 지뢰찾기', types: ['MINES'] },
  { key: 'crash', label: '📈 그래프게임', types: ['CRASH'] },
  { key: 'ladder', label: '🪜 사다리게임', types: ['LADDER'] },
  /* 게임을 가리지 않는 과제(출석·누적 등)가 갈 곳. [전체]는 "전부 보기"라 필터가
     아니므로 여기가 따로 있어야 한다 — 이름을 "전체"로 두면 첫 탭과 헷갈린다. */
  { key: 'common', label: '🎰 공통', types: ['ALL'] },
];

/** 판정이 도는 최소 베팅액. 과제마다 따로 정할 수 있고, 안 정하면 이 값이다. */
export const DEFAULT_MIN_BET = 100;

export interface AchievementRow {
  id: string; game_type: string; title: string; description: string;
  icon_url: string | null; is_hidden: number; min_bet: number;
  sort_at: number; active: number;
}

/** 화면이 쓰는 한 줄 — 과제 정보 + 이 사람의 달성 여부. */
export interface AchievementView {
  id: string; gameType: string; title: string; description: string;
  iconUrl: string | null; hidden: boolean; minBet: number;
  unlocked: boolean; unlockedAt: number | null;
  /** 몇 명이 해냈나. 감춘 과제는 -1 (아직 알려 줄 수 없다는 뜻) */
  unlockedBy: number;
}

export function listAchievements(): AchievementRow[] {
  return all<AchievementRow>(
    `SELECT * FROM achievements WHERE active = 1 ORDER BY sort_at ASC, id ASC`);
}

/**
 * 한 사람의 도전과제 목록.
 *
 * 감춘 과제(is_hidden)의 이름과 설명은 **여기서** 지운다. 화면에서 가리는 것으로는
 * 안 된다 — 응답에 들어 있으면 개발자 도구로 그대로 읽히고, 그러면 감춰진 것이 아니다.
 */
export function achievementsFor(userId: string | null): AchievementView[] {
  const mine = new Map<string, number>();
  if (userId) {
    for (const r of all<{ achievement_id: string; unlocked_at: number }>(
      `SELECT achievement_id, unlocked_at FROM user_achievements
        WHERE user_id = ? AND is_unlocked = 1`, userId)) {
      mine.set(r.achievement_id, r.unlocked_at);
    }
  }
  const counts = unlockCounts();
  return listAchievements().map(a => {
    const at = mine.get(a.id);
    const unlocked = at != null;
    const secret = a.is_hidden === 1 && !unlocked;
    return {
      /* 감춘 과제는 인원도 숨긴다. "3명 달성"이 붙어 있으면 그것만으로 가능한
         조건이라는 사실이 새어 나가고, 0명이면 아무도 못 했다는 것까지 알려 준다. */
      unlockedBy: secret ? -1 : (counts.get(a.id) ?? 0),
      id: a.id,
      gameType: a.game_type,
      title: secret ? '???' : a.title,
      description: secret ? '알 수 없는 기행이나 불운이 찾아오면 해금됩니다.' : a.description,
      iconUrl: secret ? null : a.icon_url,
      hidden: a.is_hidden === 1,
      minBet: a.min_bet,
      unlocked,
      unlockedAt: at ?? null,
    };
  });
}

export interface AchievementProgress { total: number; unlocked: number; percent: number }

export function achievementProgress(views: AchievementView[]): AchievementProgress {
  const total = views.length;
  const unlocked = views.filter(v => v.unlocked).length;
  /* 내림한다. 11/12 를 92%로 올려 100%로 보이게 하면 다 한 사람과 구분이 안 된다.
     (포인트와 같은 규칙 — 올려서 좋을 것이 없다.) */
  return { total, unlocked, percent: total > 0 ? Math.floor((unlocked * 100) / total) : 0 };
}

/**
 * 달성 처리. 이미 달성했으면 아무 일도 없다(unlocked=false 를 돌려준다).
 *
 * 알림도 여기서 만든다 — 부르는 쪽마다 따로 만들면 어떤 경로는 알림이 빠지고,
 * 그러면 "달성했는데 아무 말도 없었다"가 된다. 한곳에 묶어 둔다.
 */
export function unlockAchievement(userId: string, achievementId: string):
  { unlocked: boolean; achievement?: AchievementRow } {
  return tx(() => {
    const a = one<AchievementRow>(
      `SELECT * FROM achievements WHERE id = ? AND active = 1`, achievementId);
    if (!a) return { unlocked: false };
    run(`INSERT INTO user_achievements (user_id, achievement_id, is_unlocked, unlocked_at)
         VALUES (?, ?, 1, unixepoch())
         ON CONFLICT(user_id, achievement_id) DO NOTHING`, userId, achievementId);
    // 실제로 새로 들어간 줄만 달성이다 — 두 번째 호출은 아무것도 바꾸지 않는다
    if (one<{ n: number }>(`SELECT changes() AS n`)!.n !== 1) return { unlocked: false };
    notifyUser(userId, 'ACHIEVEMENT', '도전과제 달성!', a.title, '/achievements');
    return { unlocked: true, achievement: a };
  });
}

/**
 * 베팅 조건 미들웨어.
 *
 * 단판 베팅이 과제의 min_bet 에 못 미치면 판정을 돌리지 않는다. 1P씩 수천 번 돌려
 * 과제를 긁어내는 것을 막기 위한 것이고, 기준은 과제마다 다를 수 있어서 표에서 읽는다.
 *
 * 게임 쪽에서는 이 함수만 부른다:
 *   awardIfBet(userId, 'holdem-first-win', bet, () => wonThisHand)
 * 조건 계산(뒤의 함수)은 최소 베팅을 통과했을 때만 돈다 — 매 판 무거운 집계를 돌리지
 * 않기 위해서다.
 */
export function awardIfBet(
  userId: string, achievementId: string, bet: number, meets: () => boolean
): { unlocked: boolean; achievement?: AchievementRow } {
  const a = one<AchievementRow>(
    `SELECT * FROM achievements WHERE id = ? AND active = 1`, achievementId);
  if (!a) return { unlocked: false };
  const min = Number.isFinite(a.min_bet) ? a.min_bet : DEFAULT_MIN_BET;
  if (!Number.isFinite(bet) || Math.floor(bet) < min) return { unlocked: false };
  // 이미 있는 것을 다시 판정하지 않는다 — meets() 가 무거울 수 있다
  if (hasAchievement(userId, achievementId)) return { unlocked: false };
  if (!meets()) return { unlocked: false };
  return unlockAchievement(userId, achievementId);
}

/* ── 달성자 ───────────────────────────────────────────────────────────
   "이건 나만 못 했나"에 답하는 자리다. 혼자 보는 목록이면 잠긴 칸은 그냥 회색이지만,
   옆에 세 사람의 얼굴이 붙어 있으면 그건 해볼 만한 것이 된다.

   감춘 과제의 달성자는 내주지 않는다 — 아무도 못 한 과제와 누군가 해낸 과제는 다르고,
   그 차이만으로도 "무엇이 있는지"가 새어 나간다(달성자가 있다 = 가능한 조건이다).
   본인이 달성했으면 이미 내용을 아는 사람이므로 그때는 보여 준다. */
export interface Unlocker { userId: string; username: string; avatar: string | null; at: number }

export function unlockersOf(achievementId: string, limit = 12): Unlocker[] {
  return all<Unlocker>(
    `SELECT u.id AS userId, u.username, u.avatar, a.unlocked_at AS at
       FROM user_achievements a JOIN users u ON u.id = a.user_id
      WHERE a.achievement_id = ? AND a.is_unlocked = 1
      ORDER BY a.unlocked_at ASC, u.id ASC
      LIMIT ?`, achievementId, Math.min(60, Math.max(1, limit)));
}

export function unlockCount(achievementId: string): number {
  return one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM user_achievements
      WHERE achievement_id = ? AND is_unlocked = 1`, achievementId)!.n;
}

/** 이 과제를 몇 명이 했나 — 목록 화면이 카드마다 한 줄씩 쓰므로 한 번에 받아 온다. */
export function unlockCounts(): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of all<{ id: string; n: number }>(
    `SELECT achievement_id AS id, COUNT(*) AS n FROM user_achievements
      WHERE is_unlocked = 1 GROUP BY achievement_id`)) {
    m.set(r.id, r.n);
  }
  return m;
}

/** 전체 인원 — "12명 중 3명"의 분모. 한 판이라도 한 사람만 센다(가입만 한 계정 제외). */
export function activePlayerCount(): number {
  return one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM users WHERE last_active > 0`)!.n;
}

export function hasAchievement(userId: string, achievementId: string): boolean {
  return one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM user_achievements
      WHERE user_id = ? AND achievement_id = ? AND is_unlocked = 1`,
    userId, achievementId)!.n > 0;
}

/* ── 운영 ─────────────────────────────────────────────────────────── */

export type AchievementError = 'bad_id' | 'bad_title' | 'bad_game_type' | 'bad_min_bet' | 'exists';

export function upsertAchievement(a: {
  id: string; gameType: string; title: string; description?: string;
  iconUrl?: string | null; isHidden?: boolean; minBet?: number; sortAt?: number; active?: boolean;
}): { ok: true } | { ok: false; error: AchievementError } {
  const id = a.id.trim();
  /* 주소에도 쓰일 수 있는 값이라 모양을 좁게 잡는다 — 공지 아이디와 같은 규칙이다. */
  if (!/^[a-z0-9-]{2,60}$/.test(id)) return { ok: false, error: 'bad_id' };
  if (!a.title.trim()) return { ok: false, error: 'bad_title' };
  if (!(GAME_TYPES as readonly string[]).includes(a.gameType)) return { ok: false, error: 'bad_game_type' };
  const minBet = Math.floor(Number(a.minBet ?? DEFAULT_MIN_BET));
  if (!Number.isFinite(minBet) || minBet < 0) return { ok: false, error: 'bad_min_bet' };
  run(`INSERT INTO achievements (id, game_type, title, description, icon_url, is_hidden, min_bet, sort_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         game_type = excluded.game_type, title = excluded.title,
         description = excluded.description, icon_url = excluded.icon_url,
         is_hidden = excluded.is_hidden, min_bet = excluded.min_bet,
         sort_at = excluded.sort_at, active = excluded.active`,
    id, a.gameType, a.title.trim(), (a.description ?? '').trim(),
    a.iconUrl?.trim() || null, a.isHidden ? 1 : 0, minBet,
    Math.floor(Number(a.sortAt ?? 0)) || 0, a.active === false ? 0 : 1);
  return { ok: true };
}
