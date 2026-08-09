/* 시즌 종료를 예약한다.
 *
 * 운영자 화면에서도 걸 수 있지만, 이 스크립트는 운영 토큰을 다루지 않고 머신 안에서
 * 그대로 돈다 — 예약 한 번을 위해 토큰을 주고받을 이유가 없다.
 *
 *   AT='2026-08-10T00:00' NAME='시즌 1' SEED=0 \
 *     flyctl ssh console -C "env DB_PATH=/data AT=... npx tsx scripts/schedule-season-close.ts"
 *
 * AT 은 KST 로 읽는다(이 서비스의 시각은 전부 KST 다). 인자 없이 돌리면 지금 걸린
 * 예약을 보여 주기만 하고 아무것도 바꾸지 않는다 — 확인용으로 안전하게 쓸 수 있다.
 */
import { getSeasonSchedule, saveSeasonSchedule, clearSeasonSchedule } from '../src/db/season-schedule';
import { currentSeason } from '../src/db/queries';

const kst = (sec: number): string =>
  new Date((sec + 9 * 3600) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' KST';

function show(label: string): void {
  const s = getSeasonSchedule();
  const cur = currentSeason();
  console.log(`${label}: 현재 시즌 ${cur.number}${cur.name ? ` (${cur.name})` : ''}`);
  console.log(s.closeAt == null
    ? '  예약 없음'
    : `  ${kst(s.closeAt)} 종료 예약 · 시작 잔액 ${s.seed.toLocaleString('ko-KR')}P`
      + ` · 다음 시즌 이름 ${s.nextName || '(없음)'}`);
}

show('지금');

if (process.env.CLEAR === '1') {
  clearSeasonSchedule();
  console.log('\n예약을 지웠습니다.');
  show('결과');
} else if (process.env.AT) {
  /* KST 로 못 박는다. 머신의 시간대는 UTC 라, 시간대를 안 적으면 아홉 시간이 밀린다 —
     자정에 넘기려던 것이 오전 9시가 된다. */
  const at = Math.floor(new Date(process.env.AT + ':00+09:00').getTime() / 1000);
  if (!Number.isFinite(at)) {
    console.error(`시각을 못 읽었습니다: ${process.env.AT} (예: 2026-08-10T00:00)`);
    process.exit(1);
  }
  const seed = Math.floor(Number(process.env.SEED ?? 0));
  const r = saveSeasonSchedule({ closeAt: at, nextName: process.env.NAME ?? '', seed });
  if (!r.ok) { console.error('거절:', r.error); process.exit(1); }
  console.log('\n예약했습니다.');
  show('결과');
} else {
  console.log('\n(AT 을 주면 예약합니다. CLEAR=1 이면 지웁니다. 지금은 아무것도 바꾸지 않았습니다.)');
}
