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
