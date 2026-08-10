/* 새 공지를 디스코드 채널에 알린다 (웹훅).
 *
 * 왜 웹훅인가: 봇 토큰으로 보내려면 채널 ID 를 따로 들고 있어야 하고 권한도 맞춰야 한다.
 * 웹훅 URL 하나에는 "어느 채널에 어떤 이름으로 올릴지"가 이미 들어 있어서, 운영자가
 * 디스코드에서 채널을 만들고 URL 만 넣으면 끝난다.
 *
 * 세 가지를 지킨다.
 *
 *  1. 저장을 막지 않는다. 공지는 DB 에 들어간 순간 이미 게시된 것이고, 디스코드 알림은
 *     그 다음 일이다. 웹훅이 죽었다고 공지 등록이 실패하면 운영자는 같은 글을 두 번
 *     올리게 된다(그러면 duplicate 로 거절당하고 무슨 일인지 알 수 없다).
 *     그래서 await 하지 않고 던지지도 않는다 — 실패는 로그로만 남는다.
 *
 *  2. 새 글에만 보낸다. 수정·삭제·숨김에는 보내지 않는다. 오타를 세 번 고치면 채널에
 *     같은 공지가 네 번 올라오는데, 그건 알림이 아니라 잡음이다.
 *     (그래서 이 함수는 createNotice 한 곳에서만 불린다.)
 *
 *  3. URL 이 없으면 조용히 넘어간다. 로컬 개발과 감사에서는 웹훅이 없는 것이 정상이다 —
 *     그때마다 오류가 나면 진짜 오류가 묻힌다. 대신 한 번은 로그를 남겨,
 *     "설정했는데 안 온다"와 "설정을 안 했다"를 구별할 수 있게 한다.
 */
import { env } from '../env';

/** OD CASINO 시그니처 골드. 웹 화면의 --gold 와 같은 값이다. */
const GOLD = 0xd4af37;

const WEBHOOK = (): string => env('DISCORD_ANNOUNCEMENT_WEBHOOK_URL');
const SITE = (): string => (env('CASINO_URL') || 'https://odcasino.kro.kr').replace(/\/+$/, '');

/* 푸터 아이콘. 사이트가 실제로 내보내는 파일을 쓴다 — 헤더의 로고가 /favicon.svg 다.
   public/img/logo.png 처럼 없는 경로를 적으면 푸터에 깨진 이미지가 남는다. */
function logoUrl(): string {
  return `${SITE()}/favicon.svg`;
}

// 작성일시는 KST 로 적는다 — 이 서비스의 모든 시각 기준이다.
function kstStamp(ms: number): string {
  const d = new Date(ms + 9 * 3600 * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export interface AnnouncePayload {
  id: string; kind: string; title: string; summary: string;
}

/** 임베드 본문. 보내는 것과 모양을 만드는 것을 나눠 두면 감사가 모양만 따로 볼 수 있다. */
export function announceEmbed(n: AnnouncePayload, nowMs: number): Record<string, unknown> {
  const url = `${SITE()}/notices/${n.id}`;
  return {
    embeds: [{
      title: `[${n.kind}] ${n.title}`,
      /* 요약이 비어 있을 수 있다(필수 항목이 아니다). 그때는 description 을 아예 빼야
         한다 — 빈 문자열을 넣으면 디스코드가 400 을 준다. */
      ...(n.summary ? { description: n.summary } : {}),
      url,
      color: GOLD,
      fields: [{ name: '작성일시', value: kstStamp(nowMs), inline: true }],
      footer: { text: 'OD CASINO Official Announcement', icon_url: logoUrl() },
    }],
    /* 본문에도 링크를 남긴다. 임베드 제목의 링크는 눌러야 알 수 있어서, 모바일에서는
       공지가 왔다는 것만 보이고 어디로 가야 하는지가 안 보인다. */
    content: `📢 새 공지사항이 올라왔습니다\n${url}`,
    /* 웹훅이 멘션을 만들지 못하게 막는다. 공지 제목에 @everyone 같은 글자가 들어가면
       그대로 전체 멘션이 나가는데, 그건 글 쓴 사람이 의도한 것이 아니다. */
    allowed_mentions: { parse: [] },
  };
}

/**
 * 보낸다. 절대 던지지 않고 기다리게 하지도 않는다 — 부르는 쪽은 이 줄에서 멈추지 않는다.
 */
export function announceNotice(n: AnnouncePayload): void {
  const hook = WEBHOOK();
  if (!hook) {
    console.log('[공지 웹훅] DISCORD_ANNOUNCEMENT_WEBHOOK_URL 이 없어 건너뜀:', n.id);
    return;
  }
  const body = announceEmbed(n, Date.now());
  /* fetch 는 뜨거운 프로미스라 부르는 순간 요청이 나간다. catch 만 붙여 두면
     부르는 쪽은 기다리지 않고, 실패해도 unhandled rejection 이 되지 않는다. */
  void fetch(hook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    /* 웹훅이 응답을 안 주면 이 요청이 영원히 남는다. fly 머신은 요청이 끝나야 잠들 수
       있으므로 상한을 둔다 — 알림 한 건 때문에 머신이 깨어 있을 이유가 없다. */
    signal: AbortSignal.timeout(10_000),
  })
    .then(r => {
      if (r.ok) console.log('[공지 웹훅] 전송 완료:', n.id);
      // 2xx 가 아니면 몸통에 이유가 들어 있다. 그걸 안 찍으면 "왜 안 오는지"를 알 수 없다.
      else r.text().then(t => console.error('[공지 웹훅] 거절됨', r.status, t.slice(0, 300)))
        .catch(() => console.error('[공지 웹훅] 거절됨', r.status));
    })
    .catch((e: unknown) => console.error('[공지 웹훅] 전송 실패:', e));
}
