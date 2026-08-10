/* 이미 올라간 공지의 디스코드 알림을 다시 보낸다.
 *
 * 왜 필요한가: 웹훅은 공지를 **새로 만들 때만** 나간다(수정할 때마다 나가면 오타를 세 번
 * 고치면 채널에 네 번 올라온다). 그래서 웹훅 URL 을 나중에 붙이면, 그 전에 올라간 공지는
 * 채널에 가지 않은 채로 남는다.
 *
 * 공지를 지우고 다시 만들어도 알림은 가지만 그러면 두 가지가 망가진다:
 *   · 앱 안 알림(notifyAll)이 한 번 더 쌓여 이미 읽은 사람에게 새 공지처럼 다시 뜬다
 *   · sort_at 이 새로 잡혀 공지 목록 순서가 바뀐다
 * 알림만 다시 보내는 것이 맞다 — 이 스크립트가 하는 일이 그것뿐이다. DB 는 건드리지 않는다.
 *
 * 실행:
 *   npx tsx scripts/announce-notice.ts <공지 id>
 *   flyctl ssh console -C "env DB_PATH=/data npx tsx scripts/announce-notice.ts <공지 id>"
 *
 * id 를 빼면 지금 올라와 있는 공지 목록을 보여준다.
 */
import { listNotices, findNotice } from '../src/db/notices';
import { sendAnnounce } from '../src/discord/announce';

const id = (process.argv[2] ?? '').trim();

if (!id) {
  console.log('공지 id 를 주어야 한다. 지금 올라와 있는 공지:\n');
  for (const n of listNotices()) console.log(`  ${n.id}\n    ${n.title}`);
  console.log('\n예: npx tsx scripts/announce-notice.ts ' + (listNotices()[0]?.id ?? '<id>'));
  process.exit(1);
}

/* 숨긴 글은 findNotice 가 돌려주지 않는다 — 그게 맞다. 아직 보여줄 준비가 안 된 글을
   채널에 알리면 그 글을 찾아온 사람에게 404 가 뜬다. */
const n = findNotice(id);
if (!n) {
  console.error(`'${id}' 를 찾을 수 없다 (없는 id 이거나 숨긴 글이다).`);
  process.exit(1);
}

console.log(`보낸다: [${n.kind}] ${n.title}`);
const r = await sendAnnounce({ id: n.id, kind: n.kind, title: n.title, summary: n.summary });
if (r.ok) {
  console.log('완료. 채널을 확인해 보라.');
} else if (r.skipped) {
  console.error('웹훅 URL 이 설정되지 않았다 — DISCORD_ANNOUNCEMENT_WEBHOOK_URL 을 먼저 넣어라.');
  process.exit(1);
} else {
  console.error('실패:', r.error);
  process.exit(1);
}
