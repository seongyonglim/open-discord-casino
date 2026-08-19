/* 지금 어느 게임을 보고 있는가 — 실시간 접속자 집계.
 *
 * ── 왜 공짜인가
 * 새로 만드는 요청이 하나도 없다. 게임 화면은 이미 1초마다 /api/games/<게임>/state 를
 * 부르고 있고, 그 요청은 전부 세션을 지나 서버에 도착한다 — "누가 · 어느 게임을 ·
 * 언제" 가 이미 오고 있으므로 세기만 하면 된다.
 *
 * ── 왜 DB 에 안 쓰는가
 * "지금 누가 있나" 는 재시작하면 잃어도 되는 값이다. 몇 초 안에 폴링으로 다시 채워진다.
 * 반대로 DB 에 넣으면 초당 접속자 수만큼 디스크 쓰기가 생긴다 — 얻는 것 없이 SQLite 에
 * 부하를 얹는 셈이다. 머신이 하나라 이 프로세스의 메모리가 곧 전체 진실이기도 하다.
 *
 * ── 왜 "베팅한 사람" 이 아니라 "보고 있는 사람" 인가
 * 베팅 인원은 라운드 사이마다 0 이 된다. 사다리는 한 판이 끝나고 다음 베팅이 열리기
 * 전까지, 그래프는 상승 구간 동안 신규 베팅이 없다. 그때마다 로비가 "0명" 이 되면
 * 살아 있는 방이 죽은 것처럼 보인다 — 라이브를 보여주려다 정반대가 된다.
 *
 * 그리고 폴링 자체가 꽤 정확한 신호다. 게임 화면은 탭이 숨겨지면(document.hidden)
 * 폴링을 멈추므로, 요청이 온다는 것은 "탭이 보이는 사람" 이라는 뜻이다.
 *
 * 다만 홀덤은 유휴 정지가 없다. 다른 게임은 3분 동안 아무 조작이 없으면 멈추지만,
 * 포커 테이블에서는 아무것도 안 누르고 남의 차례를 보고 있는 것이 정상 상태라
 * 그 규칙을 걸 수가 없다 — 걸면 판이 굴러가는 것을 못 본다. 그래서 홀덤 화면을
 * 열어 둔 채 자리를 비우면 20초 TTL 안에서 계속 "보고 있는 사람" 으로 세어진다.
 * 라이브 뱃지가 실제보다 조금 후하게 나올 수 있다는 뜻이고, 그건 감수한다.
 */

/** 이 시간 안에 폴링이 있었으면 "지금 있다" 로 센다.
 *  폴링이 1초라 20배의 여유다 — 잠깐 끊기거나 탭 전환으로 한두 번 빠져도 사라지지 않고,
 *  창을 닫으면 20초 안에 조용히 빠진다. */
export const PRESENCE_TTL_MS = 20_000;

/** userId → { game, lastSeen }. 사용자당 한 줄이라 같은 사람이 두 게임을 열어 두면
 *  마지막에 본 게임 하나로만 센다 — 한 사람이 두 명으로 세어지면 그건 접속자 수가 아니다. */
const seen = new Map<string, { game: string; at: number }>();

/** 폴링이 왔다. 게임 상태 API 가 부른다. */
export function touchPresence(userId: string, game: string, now = Date.now()): void {
  if (!userId || !game) return;
  seen.set(userId, { game, at: now });
}

/** 만료된 줄을 버린다. 세는 김에 같이 하므로 따로 타이머를 두지 않는다 —
 *  타이머는 아무도 안 볼 때도 계속 도는데, 아무도 안 보면 셀 일도 없다. */
function sweep(now: number): void {
  for (const [id, v] of seen) {
    if (now - v.at > PRESENCE_TTL_MS) seen.delete(id);
  }
}

/**
 * 게임별 현재 인원.
 *
 * 0 인 게임은 아예 넣지 않는다. 화면이 "0명" 을 그리지 않게 하려는 것인데, 그 판단을
 * 화면에 맡기면 언젠가 한 곳에서 빠진다 — 없는 열쇠는 그릴 수가 없다.
 */
export function activeCounts(now = Date.now()): Record<string, number> {
  sweep(now);
  const out: Record<string, number> = {};
  for (const v of seen.values()) out[v.game] = (out[v.game] ?? 0) + 1;

  /* ── 개발용 가짜 인원 ──────────────────────────────────────────
     혼자 띄워 보면 언제나 1명이라 뱃지가 어떻게 보이는지 확인할 수가 없다.
     MOCK_PRESENCE 를 켜면 몇 게임에 사람이 있는 것처럼 보인다.

     환경변수가 없으면 이 블록은 통째로 지나간다 — 운영에는 그 변수가 없고, 켤 이유도
     없다. 코드에 조건 없이 섞어 두면 언젠가 운영에서 켜진다는 것이 이 방식의 요점이다.
     실제 인원이 있으면 그쪽이 이긴다: 가짜가 진짜를 덮으면 확인이 아니라 착각이 된다. */
  const mock = process.env.MOCK_PRESENCE;
  if (mock) {
    const fake: Record<string, number> = { baccarat: 3, graph: 7 };
    for (const [g, n] of Object.entries(fake)) out[g] = Math.max(out[g] ?? 0, n);
  }
  return out;
}

/** 전체 인원(게임을 가리지 않고). 로비 요약에 쓴다. */
export function activeTotal(now = Date.now()): number {
  sweep(now);
  return seen.size;
}

/** 시험용 — 감사가 상태를 비우고 시작할 수 있어야 한다. */
export function resetPresence(): void {
  seen.clear();
}
