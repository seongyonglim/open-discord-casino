/* 게임 응답에 달성 결과를 얹는 공통 배선.
 *
 * 게임마다 팝업을 따로 만들면 어떤 게임은 소리가 나고 어떤 게임은 조용해진다.
 * 그래서 모양을 하나로 못 박는다 — 서버는 응답에 `unlocked` 를 실어 보내고,
 * 화면은 그것을 보면 토스트를 띄운다(app.js 의 casinoNotify.toast).
 *
 * 게임 쪽에서 쓰는 법:
 *   const got = award(userId, bet, [
 *     ['mines-first-clear', () => 모든칸을열었다],
 *     ['mines-big-win',     () => 배당 >= 10],
 *   ]);
 *   return sendJson(res, 200, { ok: true, ...withUnlocked(got) });
 *
 * 조건 함수는 최소 베팅을 통과했고 아직 달성하지 않았을 때만 돈다 — 매 판 무거운
 * 집계를 돌리지 않기 위해서다(db/achievements 의 awardIfBet 이 그 순서를 지킨다).
 */
import { awardIfBet } from '../db/achievements';

export interface UnlockedView { id: string; title: string; description: string }

/**
 * 여러 과제를 한 번에 판정한다. 한 판에 둘이 동시에 달성될 수 있고(첫 승 + 대박),
 * 그때 하나만 알리면 나머지는 조용히 지나간다.
 */
export function award(
  userId: string, bet: number, checks: [string, () => boolean][]
): UnlockedView[] {
  const got: UnlockedView[] = [];
  for (const [id, meets] of checks) {
    /* 하나가 터져도 나머지는 이어서 본다. 과제 판정이 게임을 멈추면 안 된다 —
       베팅과 정산은 이미 끝난 뒤이고, 여기서 던지면 사람은 딴 돈을 못 받는다. */
    try {
      const r = awardIfBet(userId, id, bet, meets);
      if (r.unlocked && r.achievement) {
        got.push({
          id: r.achievement.id,
          title: r.achievement.title,
          description: r.achievement.description,
        });
      }
    } catch (e) {
      console.error('도전과제 판정 오류:', id, e);
    }
  }
  return got;
}

/** 응답에 실을 모양. 달성이 없으면 키 자체를 넣지 않는다 — 화면이 그것만 보면 된다. */
export function withUnlocked(got: UnlockedView[]): { unlocked?: UnlockedView[] } {
  return got.length ? { unlocked: got } : {};
}

/* ── 게임과 무관한 과제 ───────────────────────────────────────────────
   특정 게임의 판이 아니라 "그 사람의 오늘"을 보는 과제가 있다(롤러코스터). 그런 것은
   어느 게임에서 되살아났든 그 자리에서 알려야 하므로, 게임마다 따로 붙이지 않고
   여기 한 곳에 모아 각 게임의 상태 응답에서 함께 부른다.

   매 폴링마다 도는 자리라 값싸야 한다. 순서가 그 값싸기를 만든다:
     1. 잔액이 목표에 못 미치면 원장을 아예 안 본다 (거의 모든 호출이 여기서 끝난다)
     2. 이미 달성했으면 awardIfBet 이 db 한 번으로 걸러 낸다
     3. 그 문을 지난 경우에만 오늘의 원장을 되짚는다

   잔액은 인자로 받지 않고 직접 읽는다. 부르는 쪽마다 그 값을 어떻게 들고 있는지가 달라서
   (어떤 게임은 payload 안에, 어떤 게임은 아예 안 읽는다) 인자로 두면 게임마다 다른 모양이
   된다 — 색인 한 줄 조회라 폴링에 얹어도 무게가 없다. */
const ROLLER_LOW = 1_000;
const ROLLER_HIGH = 100_000;

export function commonAwards(userId: string): UnlockedView[] {
  const { getWebUser, rollerCoasterToday } = require('../db/queries') as typeof import('../db/queries');
  if ((getWebUser(userId)?.balance ?? 0) < ROLLER_HIGH) return [];
  return award(userId, 0, [
    ['roller-coaster', () => rollerCoasterToday(userId, ROLLER_LOW, ROLLER_HIGH)],
  ]);
}

/** 게임별 달성 + 공통 달성을 한 번에 응답 모양으로. 게임의 상태 응답이 이걸 쓴다. */
export function withCommon(userId: string, got: UnlockedView[]): { unlocked?: UnlockedView[] } {
  return withUnlocked([...got, ...commonAwards(userId)]);
}
