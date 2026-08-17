/* 채팅 HTTP 경계.
 *
 * 읽기와 쓰기 둘뿐이다. 폴링은 새로 만들지 않는다 — 게임 화면은 이미 도는 /state 응답에
 * 실린 chatMax 를 보고, 그 값이 자기가 가진 것보다 클 때만 여기 읽기를 부른다.
 * 그래서 아무도 말하지 않으면 이 파일로 오는 요청이 한 건도 없다.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendJson } from './http';
import {
  chatSince, postChat, chatMuteLeft, chatMod, CHAT_MAX_LEN, CHAT_MIN_GAP_MS,
  currentSeason, seasonOverall,
  type WebUser,
} from '../db/queries';

/** 화면에 그대로 나갈 문구. 서버가 정한다 — 같은 규칙을 두 곳에 적으면 언젠가 갈라진다. */
const MSG: Record<string, string> = {
  empty: '보낼 말이 없습니다',
  too_long: `${CHAT_MAX_LEN}자까지 쓸 수 있습니다`,
  too_fast: '조금 천천히 보내주세요',
  muted: '지금은 채팅이 제한되어 있습니다',
  no_user: '로그인이 필요합니다',
};

/* ── 말한 사람의 순위 ──────────────────────────────────────────────────
   랭킹 페이지의 통합 탭과 같은 순위다(시즌 잔액 순). 게임별 순위가 아니라 이것을 쓰는
   이유는, 채팅은 어느 화면에서나 한 줄로 흐르는데 게임별 순위는 그 게임을 한 사람에게만
   있어서 대부분의 줄에 붙일 것이 없기 때문이다.

   읽을 때 계산한다. 보낼 때 찍어 두면 순위가 그 줄에 박제되어, 한참 뒤에 화면을 열어도
   옛 순위가 남는다. 여기서는 매번 지금 순위로 그린다 — 사람이 열댓 명이라 질의 한 번이면
   끝나고, 이 경로는 새 줄이 있을 때만 불린다(아무도 말하지 않으면 요청 자체가 없다). */
function rankMap(): Map<string, number> {
  const m = new Map<string, number>();
  try {
    /* 상한을 넉넉히 둔다. 기본값(100)을 그대로 쓰면 사람이 늘었을 때 101위부터
       조용히 순위가 사라진다 — "없다"와 "안 줬다"를 화면에서 구별할 수 없다. */
    for (const r of seasonOverall(currentSeason().id, 1000)) m.set(r.userId, r.rank);
  } catch { /* 시즌을 못 읽어도 대화는 흘러야 한다 — 순위 없이 그린다 */ }
  return m;
}

/** GET /api/chat?since=N — N 이후의 줄. 0이면 최근 것부터 준다. */
export function handleChatRead(
  _req: IncomingMessage, res: ServerResponse, url: URL, me: WebUser
): void {
  const since = Math.floor(Number(url.searchParams.get('since') ?? 0));
  const rows = chatSince(Number.isFinite(since) ? since : 0);
  const rank = rankMap();
  /* user_id 를 함께 준다 — 화면이 "내 줄"을 다르게 그리는 데 쓴다.
     그 밖의 것은 내려보내지 않는다: 잔액도, 역할도 대화에 필요 없다.
     순위는 숫자 하나뿐이다 — 잔액을 주면 랭킹 페이지에 없는 정보가 채팅으로 샌다. */
  sendJson(res, 200, {
    ok: true,
    /* 가려진 줄 수. 화면은 이 값이 달라지면 목록을 처음부터 다시 받는다 —
       가린 줄을 되돌려 받을 방법이 달리 없기 때문이다(since 뒤의 새 줄만 오므로).
       느린 폴로 도는 화면(로비·랭킹)도 이 값만 보고 알아챈다. */
    mod: chatMod(),
    messages: rows.map(r => ({
      id: r.id, userId: r.user_id, name: r.username, body: r.body,
      at: r.created_ms, where: r.where_at, rank: rank.get(r.user_id),
    })),
    /* 내가 지금 말할 수 있나. 재갈이 물린 사람에게 입력창을 열어 두면 보내 봐야
       거절당하는 것을 그때 알게 된다. */
    muteLeftMs: chatMuteLeft(me.id) * 1000,
  });
}

/** POST /api/chat — 한 줄 보낸다. */
export async function handleChatPost(
  req: IncomingMessage, res: ServerResponse, me: WebUser
): Promise<void> {
  const b = await readJson(req) as { body?: unknown; where?: unknown } | null;
  /* 어느 화면에서 말했는지. 화면이 알려 주는 값이라 믿지 않는다 — 아는 이름만 받고
     나머지는 버린다(로비로 본다). 여기로 아무 문자열이나 들어오면 그대로 남의 화면에
     찍힌다. */
  const KNOWN = ['holdem', 'baccarat', 'blackjack', 'crash', 'ladder', 'poker', 'mines'];
  const whereRaw = typeof b?.where === 'string' ? b.where : '';
  const where = KNOWN.includes(whereRaw) ? whereRaw : null;

  const r = postChat(me.id, String(b?.body ?? ''), where);
  if (!r.ok) {
    return sendJson(res, r.error === 'no_user' ? 401 : 400, {
      error: MSG[r.error] ?? '보낼 수 없습니다',
      leftMs: r.leftMs ?? 0,
      /* 연타 간격은 화면이 버튼을 잠그는 데 쓴다. 서버 값을 그대로 주어 두 곳의
         숫자가 갈라지지 않게 한다. */
      minGapMs: CHAT_MIN_GAP_MS,
    });
  }
  return sendJson(res, 200, { ok: true, id: r.id });
}
