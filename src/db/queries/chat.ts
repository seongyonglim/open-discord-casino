/* 채팅 질의.

   db/queries.ts 가 커져서 도메인별로 나눴다. 의존은 한 방향이다: 게임별 모듈 → core.

   ── 왜 폴링을 늘리지 않는가
   이 서비스의 모든 화면은 이미 1초마다 /state 를 부른다. 채팅용 폴을 하나 더 달면
   요청 수가 정확히 두 배가 된다. 그래서 상태 응답에는 «마지막 메시지 id» 하나만 얹고
   (chatMax, 18바이트), 화면은 그 값이 자기가 가진 것보다 클 때만 이 모듈을 부른다.
   아무도 말하지 않으면 요청이 한 건도 늘지 않는다.

   ── 왜 소켓이 아닌가
   이 서비스에는 서버 타이머가 없다. 상태는 요청이 올 때 전진하고(홀덤 lazy advancement),
   머신은 512MB 한 대다. 상주 연결을 쌓으면 배포 모델 자체가 바뀐다. 폴링 채널로 충분하고
   지연은 최대 1초다 — 대화에는 그 정도면 즉시로 읽힌다. */
import { one, all, run, tx } from './core';

/** 한 줄 최대 길이. 넘치면 자르지 않고 거절한다 — 잘린 말은 안 한 것만 못하다. */
export const CHAT_MAX_LEN = 100;
/** 보관하는 줄 수. 화면은 최근 것만 보여주고, 오래된 줄은 아무도 읽지 않는다. */
export const CHAT_KEEP = 200;
/** 한 번에 내려주는 최대 줄 수(처음 열었을 때). */
export const CHAT_PAGE = 40;
/* 도배 문지기. 두 겹이다 — 연타(간격)와 몰아치기(창)를 각각 막는다.

   처음에는 0.7초 간격 · 5초에 3줄이었다. 그런데 이 방은 열댓 명이 쓰는 곳이고,
   짧은 말을 연달아 던지는 것이 대화의 정상적인 모양이다("ㅋㅋ" "진짜?" "gg") —
   그 셋을 치면 네 번째에서 막혔다. 도배를 막자고 대화를 막고 있었다.
   5초에 10줄로 연다. 간격은 그 10줄이 실제로 들어갈 수 있는 값이어야 한다 —
   0.7초로 두면 5초 안에 일곱 줄밖에 못 넣어서 창을 넓힌 의미가 없다.

   간격을 아예 없애지 않는 이유는 도배가 아니라 사고다: 보내기를 두 번 눌렀거나
   클라이언트가 루프에 빠졌을 때 같은 줄이 두 번 들어가는 것을 막는다. */
export const CHAT_MIN_GAP_MS = 400;
export const CHAT_BURST = 10;
export const CHAT_BURST_MS = 5_000;

export interface ChatRow {
  id: number; user_id: string; username: string; body: string;
  where_at: string | null; created_ms: number;
}

export type ChatError = 'empty' | 'too_long' | 'too_fast' | 'muted' | 'no_user';

/** 마지막 메시지 id. 상태 응답이 매번 이 값과 아래 chatMod 를 싣는다. */
export function chatMax(): number {
  return one<{ n: number }>(`SELECT COALESCE(MAX(id), 0) AS n FROM chat_messages`)!.n;
}

/* 가려진 줄 수. "숨김이 일어났다"를 알리는 유일한 신호다.

   이게 없어서 실제로 새어 나갔다: 운영자가 줄을 가려도 MAX(id) 는 그대로라 다른 사람
   화면은 재요청조차 하지 않았고, 이미 그려 둔 줄은 그 자리에 그대로 남았다. 가린 사람은
   화면이 새로고침돼서 사라진 것처럼 보였고, 남들에게는 계속 보였다.

   숨김과 되돌리기 둘 다에서 값이 움직이므로 방향은 볼 필요가 없다 — 화면은 값이
   달라졌다는 것만 알면 목록을 처음부터 다시 받는다. 보관이 200줄이라 세는 비용도
   무시할 만하고, 어차피 이 값은 상태 응답에 이미 실려 나가는 chatMax 옆자리다. */
export function chatMod(): number {
  return one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM chat_messages WHERE hidden = 1`)!.n;
}

/**
 * since 이후의 줄. 화면이 가진 마지막 id 를 그대로 넘긴다.
 *
 * since 가 0 이면 처음 여는 것이라 최근 CHAT_PAGE 줄을 준다. 그 뒤로는 새 줄만 오므로
 * 대개 한두 줄이다 — 같은 대화를 매번 다시 내려보내지 않는다.
 */
export function chatSince(since: number): ChatRow[] {
  if (!Number.isFinite(since) || since <= 0) {
    /* 최신 40줄을 뽑아 다시 오름차순으로 돌린다. 곧바로 오름차순으로 뽑으면
       보관 전체(200줄)의 앞머리가 나온다 — 화면이 원하는 것은 끝쪽이다. */
    return all<ChatRow>(
      `SELECT * FROM (
         SELECT id, user_id, username, body, where_at, created_ms
           FROM chat_messages WHERE hidden = 0 ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`, CHAT_PAGE);
  }
  return all<ChatRow>(
    `SELECT id, user_id, username, body, where_at, created_ms
       FROM chat_messages WHERE hidden = 0 AND id > ? ORDER BY id ASC LIMIT ?`,
    Math.floor(since), CHAT_PAGE);
}

/** 지금 재갈이 물려 있나. 남은 초를 돌려준다(0이면 말할 수 있다). */
export function chatMuteLeft(userId: string, now = Math.floor(Date.now() / 1000)): number {
  const u = one<{ chat_muted_until: number | null }>(
    `SELECT chat_muted_until FROM users WHERE id = ?`, userId);
  if (!u?.chat_muted_until) return 0;
  return Math.max(0, u.chat_muted_until - now);
}

/* 눈에 안 보이는 글자를 걷어낸다 — 제어문자로 줄을 밀거나 폭 없는 공백으로 빈 줄을
   만드는 것이 가장 먼저 오는 장난이다. 줄바꿈도 공백 하나로 눕힌다(한 줄짜리 화면이다).

   문자 클래스에 그 글자들을 직접 적지 않는다. 소스에 눈에 안 보이는 글자가 들어가면
   다음에 읽는 사람이 여기에 무엇이 있는지 알 수 없고, 편집기가 조용히 지워도 모른다.
   코드포인트로 판단한다. */
function scrub(raw: string): string {
  let out = '';
  for (const ch of String(raw ?? '')) {
    const c = ch.codePointAt(0) ?? 0;
    const bad = c < 0x20                       // 제어문자
      || c === 0x7f                            // DEL
      || (c >= 0x200b && c <= 0x200f)          // 폭 없는 공백 · 방향 지정
      || c === 0x2028 || c === 0x2029          // 줄·문단 구분자
      || c === 0xfeff;                         // BOM
    out += bad ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * 한 줄 보낸다.
 *
 * 문지기는 전부 여기 있다. 화면에도 같은 검사가 있지만 그건 편의고, 마지막 문은 여기다 —
 * 개발자 도구로 곧장 POST 하는 경로가 언제나 열려 있다.
 */
export function postChat(userId: string, body: string, whereAt: string | null):
{ ok: true; id: number } | { ok: false; error: ChatError; leftMs?: number } {
  const text = scrub(body);
  if (!text) return { ok: false, error: 'empty' };
  /* 글자 수는 코드 포인트로 센다. 이모지 하나가 UTF-16 에서 둘로 세어지면
     "100자"가 사람이 보는 100자와 달라진다. */
  if ([...text].length > CHAT_MAX_LEN) return { ok: false, error: 'too_long' };

  return tx(() => {
    const u = one<{ username: string }>(`SELECT username FROM users WHERE id = ?`, userId);
    if (!u) return { ok: false as const, error: 'no_user' as const };
    const left = chatMuteLeft(userId);
    if (left > 0) return { ok: false as const, error: 'muted' as const, leftMs: left * 1000 };

    /* 도배 검사는 트랜잭션 안에서 한다. 밖에서 재면 동시에 들어온 두 요청이 둘 다
       "지금 괜찮다"를 보고 둘 다 통과한다 — 연타 매크로가 정확히 그 모양이다. */
    const nowMs = Date.now();
    const recent = all<{ created_ms: number }>(
      `SELECT created_ms FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
      userId, CHAT_BURST);
    if (recent.length && nowMs - recent[0].created_ms < CHAT_MIN_GAP_MS) {
      return { ok: false as const, error: 'too_fast' as const,
        leftMs: CHAT_MIN_GAP_MS - (nowMs - recent[0].created_ms) };
    }
    if (recent.length >= CHAT_BURST && nowMs - recent[CHAT_BURST - 1].created_ms < CHAT_BURST_MS) {
      return { ok: false as const, error: 'too_fast' as const,
        leftMs: CHAT_BURST_MS - (nowMs - recent[CHAT_BURST - 1].created_ms) };
    }

    run(`INSERT INTO chat_messages (user_id, username, body, where_at, created_ms)
         VALUES (?, ?, ?, ?, ?)`, userId, u.username, text, whereAt || null, nowMs);
    const id = one<{ id: number }>(`SELECT last_insert_rowid() AS id`)!.id;
    /* 넣을 때마다 오래된 줄을 지운다 — 서버 타이머가 없어서 "나중에" 를 걸 데가 없다.
       id 로 자른다: 시각으로 자르면 조용한 날에 대화가 통째로 사라진다. */
    run(`DELETE FROM chat_messages WHERE id <= ?`, id - CHAT_KEEP);
    return { ok: true as const, id };
  });
}

/* ── 운영자 ─────────────────────────────────────────────────────────
   지우기와 재갈. 둘 다 되돌릴 수 있어야 한다 — 실수로 누른 것이 영구가 되면
   그 버튼은 무서워서 못 쓴다. */

/** 한 줄 감춘다(되돌리려면 hidden=false). 실제로 지우지 않는 이유는 표 주석을 보라. */
export function setChatHidden(id: number, hidden: boolean): void {
  run(`UPDATE chat_messages SET hidden = ? WHERE id = ?`, hidden ? 1 : 0, Math.floor(id));
}

/** 재갈을 물리거나(초) 푼다(0). */
export function setChatMute(userId: string, sec: number): void {
  const until = sec > 0 ? Math.floor(Date.now() / 1000) + Math.floor(sec) : null;
  run(`UPDATE users SET chat_muted_until = ? WHERE id = ?`, until, userId);
}

/** 운영자 화면용 — 감춘 줄까지 함께 준다. */
export function chatRecentAll(limit = 60): (ChatRow & { hidden: number })[] {
  return all<ChatRow & { hidden: number }>(
    `SELECT id, user_id, username, body, where_at, created_ms, hidden
       FROM chat_messages ORDER BY id DESC LIMIT ?`, limit);
}
