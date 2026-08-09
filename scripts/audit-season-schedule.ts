/* 시즌 종료 예약 감사.
 *
 * 이 장치는 "전원의 잔액을 초기화한다"를 사람 손 없이 실행한다. 한 번 잘못 돌면
 * 되돌릴 방법이 없으므로(원장에 초기화가 이미 기록된다), 두 가지를 특히 확실히 한다.
 *   · 예약 시각 전에는 절대 안 돈다
 *   · 지난 뒤에는 딱 한 번만 돈다 (요청마다 부르는 함수다)
 */
if (!process.env.DB_PATH) {
  const os = require('node:os'), path = require('node:path'), fsx = require('node:fs');
  process.env.DB_PATH = fsx.mkdtempSync(path.join(os.tmpdir(), 'casino-audit-'));
}

import { getDb } from '../src/db/schema';
import * as Q from '../src/db/queries';
import * as S from '../src/db/queries/season';
import * as SS from '../src/db/season-schedule';
import { rewardsForSeason } from '../src/services/rewards';

const db = getDb();
let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
function section(s: string): void { console.log('\n' + s); }

const now = (): number => Math.floor(Date.now() / 1000);
function reset(): void {
  db.exec(`DELETE FROM seasons; DELETE FROM season_stats; DELETE FROM season_results;
           DELETE FROM holdem_settings; DELETE FROM game_stats;`);
  db.prepare(`INSERT INTO seasons (number, name, reward, started_at) VALUES (0, '오픈베타', '', ?)`)
    .run(now() - 86400);
}
function mkUser(id: string, bal: number): void {
  Q.upsertUser(id, id, null);
  const cur = Q.getWebUser(id)?.balance ?? 0;
  if (cur !== bal) Q.adjustBalance(id, bal - cur, 'audit:seed');
  // 시즌 성적표는 "한 판이라도 한 사람"만 담는다 — 안 놀면 순위에 안 들어간다
  Q.bumpGameStats(id, 'graph', 100, 200);
}

function main(): void {
  /* ── 1. 예약이 없을 때 ──────────────────────────────────────── */
  section('[1] 예약 없음 — 아무 일도 없어야 한다');
  {
    reset();
    mkUser('s1', 12_345);
    ck('기본은 예약 없음', SS.getSeasonSchedule().closeAt === null);
    for (let i = 0; i < 5; i++) SS.ensureSeasonClosed();
    ck('시즌이 그대로다', Q.currentSeasonNumber() === 0, String(Q.currentSeasonNumber()));
    ck('잔액도 그대로다', Q.getWebUser('s1')!.balance === 12_345,
      String(Q.getWebUser('s1')!.balance));
  }

  /* ── 2. 예약 시각 전 ────────────────────────────────────────── */
  section('[2] 아직 시각이 안 됐으면 안 넘긴다');
  {
    reset();
    mkUser('s2', 9_000);
    SS.saveSeasonSchedule({ closeAt: now() + 3600, nextName: '시즌 1', seed: 0 });
    for (let i = 0; i < 10; i++) SS.ensureSeasonClosed();
    ck('시즌 0 그대로', Q.currentSeasonNumber() === 0, String(Q.currentSeasonNumber()));
    ck('잔액 그대로', Q.getWebUser('s2')!.balance === 9_000);
    ck('예약도 그대로 남아 있다', SS.getSeasonSchedule().closeAt !== null);
    // 1초 전까지도 안 넘어간다 — 경계에서 미리 넘어가면 공지한 시각과 어긋난다
    const at = SS.getSeasonSchedule().closeAt!;
    SS.ensureSeasonClosed(at - 1);
    ck('1초 전에도 안 넘긴다', Q.currentSeasonNumber() === 0);
  }

  /* ── 3. 시각이 지나면 ───────────────────────────────────────── */
  section('[3] 시각이 지나면 넘긴다 — 딱 한 번만');
  {
    reset();
    mkUser('a', 30_000); mkUser('b', 20_000); mkUser('c', 10_000);
    const at = now() + 60;
    SS.saveSeasonSchedule({ closeAt: at, nextName: '시즌 1', seed: 0 });

    SS.ensureSeasonClosed(at);           // 정확히 그 시각이면 넘어간다
    ck('시즌 1이 열렸다', Q.currentSeasonNumber() === 1, String(Q.currentSeasonNumber()));
    ck('새 시즌 이름이 붙었다', S.currentSeason().name === '시즌 1', S.currentSeason().name);    ck('전원 잔액이 0', ['a', 'b', 'c'].every(u => Q.getWebUser(u)!.balance === 0),
      ['a', 'b', 'c'].map(u => Q.getWebUser(u)!.balance).join(','));

    /* 여기가 제일 중요하다. 이 함수는 요청마다 불리므로, 예약을 안 지우면 요청 몇 번에
       시즌이 연달아 넘어가고 그때마다 전원의 잔액이 초기화된다. */
    SS.clearSeasonSchedule.name;         // (이름만 참조 — 아래는 실제 동작을 본다)
    for (let i = 0; i < 20; i++) SS.ensureSeasonClosed(at + 1000);
    ck('여러 번 불러도 시즌 1 그대로', Q.currentSeasonNumber() === 1,
      String(Q.currentSeasonNumber()));
    ck('시즌 표에 두 줄뿐', (db.prepare(`SELECT COUNT(*) AS n FROM seasons`)
      .get() as { n: number }).n === 2);
    ck('예약이 지워졌다', SS.getSeasonSchedule().closeAt === null);

    /* 시즌 0 성적표가 남아야 한다 — 공지에 "시즌 0을 선택해 계속 확인"이라고 적었다.
       종료 시점의 보유 포인트가 그대로 있어야 그 약속이 지켜진다. */
    const s0 = S.listSeasons().find(x => x.number === 0)!;
    const rows = S.seasonOverall(s0.id, 100);
    ck('시즌 0 순위가 남아 있다', rows.length === 3, String(rows.length));
    ck('1위는 종료 시점 포인트로 기록됐다',
      rows[0].userId === 'a' && rows[0].score === 30_000, JSON.stringify(rows[0]));
    ck('잔액이 0으로 바뀐 뒤에도 성적표는 안 흔들린다', rows[2].score === 10_000);
  }

  /* ── 4. 보상 금액 ───────────────────────────────────────────── */
  section('[4] 시즌 1 보상이 실제로 오르는가');
  {
    reset();
    mkUser('r1', 100);
    const before = rewardsForSeason(0), after = rewardsForSeason(1);
    ck('검사 전제: 시즌 1 보상이 더 크다', after.daily > before.daily,
      `${before.daily} → ${after.daily}`);

    /* 상금 배수는 템플릿에 저장돼 있으면 그 값이 시즌 기본값을 이긴다. 시즌이 올라도
       그대로면 "프리롤 5배"라고 공지해 놓고 옛 금액으로 열린다 — 그 상황을 만든다. */
    db.prepare(`INSERT INTO holdem_settings (key, value) VALUES ('weekdayMultiplier', ?)`)
      .run(String(before.freerollPerHead));
    db.prepare(`INSERT INTO holdem_settings (key, value) VALUES ('weekendMultiplier', ?)`)
      .run(String(before.freerollPerHeadWeekend));

    const at = now();
    SS.saveSeasonSchedule({ closeAt: at, nextName: '시즌 1', seed: 0 });
    SS.ensureSeasonClosed(at);

    ck('출석 보상이 시즌 1 값이다', Q.currentSeasonNumber() === 1
      && rewardsForSeason(Q.currentSeasonNumber()).daily === after.daily);
    const val = (k: string): number => Number((db.prepare(
      `SELECT value FROM holdem_settings WHERE key = ?`).get(k) as { value: string }).value);
    ck('평일 프리롤 배수가 올라갔다', val('weekdayMultiplier') === after.freerollPerHead,
      `${val('weekdayMultiplier')} (기대 ${after.freerollPerHead})`);
    ck('주말 프리롤 배수도 올라갔다', val('weekendMultiplier') === after.freerollPerHeadWeekend,
      String(val('weekendMultiplier')));

    /* 새 기본값보다 높게 잡아 둔 값은 건드리지 않는다 — 운영자가 일부러 더 준 것이고,
       시즌이 바뀌었다고 깎을 이유가 없다. */
    reset();
    mkUser('r2', 100);
    const high = after.freerollPerHead * 3;
    db.prepare(`INSERT INTO holdem_settings (key, value) VALUES ('weekdayMultiplier', ?)`)
      .run(String(high));
    SS.saveSeasonSchedule({ closeAt: now(), nextName: '', seed: 0 });
    SS.ensureSeasonClosed(now());
    ck('더 높게 잡아 둔 값은 안 깎는다', val('weekdayMultiplier') === high,
      String(val('weekdayMultiplier')));
  }

  /* ── 5. 시작 잔액 ───────────────────────────────────────────── */
  section('[5] 시작 잔액 — 원장이 어긋나지 않는가');
  {
    reset();
    mkUser('z1', 7_777);
    SS.saveSeasonSchedule({ closeAt: now(), nextName: '', seed: 5_000 });
    SS.ensureSeasonClosed(now());
    ck('시드만큼 들고 시작한다', Q.getWebUser('z1')!.balance === 5_000,
      String(Q.getWebUser('z1')!.balance));
    /* 초기화도 원장을 거쳐야 한다. 잔액 = 원장 누적합이 이 서비스의 유일한 불변식이고,
       여기서 잔액을 직접 고치면 그것이 깨진다. */
    const sum = (db.prepare(
      `SELECT COALESCE(SUM(delta),0) AS n FROM points_ledger WHERE user_id = 'z1'`)
      .get() as { n: number }).n;
    ck('잔액 = 원장 누적합', sum === 5_000, String(sum));
  }

  /* ── 6. 잘못된 값 ───────────────────────────────────────────── */
  section('[6] 예약 저장 — 잘못된 값 거절');
  {
    reset();
    ck('음수 시드 거절',
      !SS.saveSeasonSchedule({ closeAt: now(), nextName: '', seed: -1 }).ok);
    ck('소수 시드 거절',
      !SS.saveSeasonSchedule({ closeAt: now(), nextName: '', seed: 1.5 }).ok);
    ck('0 시각 거절',
      !SS.saveSeasonSchedule({ closeAt: 0, nextName: '', seed: 0 }).ok);
    ck('거절된 뒤에는 예약이 없다', SS.getSeasonSchedule().closeAt === null);
    ck('정상 저장은 통과',
      SS.saveSeasonSchedule({ closeAt: now() + 10, nextName: '시즌 1', seed: 0 }).ok);
    ck('저장한 값이 그대로 읽힌다', SS.getSeasonSchedule().nextName === '시즌 1');
    SS.clearSeasonSchedule();
    ck('지우면 예약이 없다', SS.getSeasonSchedule().closeAt === null);
  }

  /* ── 7. 랭킹 배너의 종료일 ──────────────────────────────────── */
  section('[7] 랭킹 배너 — 예약이 걸리면 종료일이 뜬다');
  {
    const LB = require('../src/web/leaderboard') as typeof import('../src/web/leaderboard');
    reset();
    mkUser('s7', 1_000);

    ck('예약이 없으면 종료일도 없다',
      LB.buildRankPayload(null, 'overall', null).season.closeAt === null);

    /* 8월 10일 00:00 KST 에 닫는 예약. 시즌이 마지막으로 살아 있는 날은 9일이다. */
    const closeAt = Math.floor(Date.UTC(2026, 7, 9, 15, 0, 0) / 1000);   // = KST 8/10 00:00
    SS.saveSeasonSchedule({ closeAt, nextName: '시즌 1', seed: 0 });
    const p = LB.buildRankPayload(null, 'overall', null);
    ck('예약 시각이 화면 자료에 실린다', p.season.closeAt === closeAt, String(p.season.closeAt));
    /* 화면이 쓰는 계산(endYmd)을 그대로 옮겨 와 날짜를 재 본다. 자정에 예약을 걸면
       하루 뒤 날짜가 뜨는 실수가 여기서 걸린다.

       종료 시각은 예약된 순간이 아니라 "그 뒤 첫 요청이 들어온 순간"으로 찍힌다(서버에
       타이머가 없다). 시즌 0 은 6초 늦게 찍혔고, 그래서 1초만 빼는 방식은 통하지 않는다 —
       자정 직후에 닫힌 시즌은 그 자정을 진짜 종료로 봐야 한다. */
    const LAZY_SLACK = 300;
    const endYmd = (sec: number): string => {
      const into = ((sec + 9 * 3600) % 86400 + 86400) % 86400;
      const d = new Date(((into < LAZY_SLACK ? sec - into - 1 : sec - 1) + 9 * 3600) * 1000);
      return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`;
    };
    ck('예약 화면에 적히는 날짜는 8월 9일', endYmd(p.season.closeAt!) === '8월 9일',
      endYmd(p.season.closeAt!));
    /* 실제로 찍히는 값은 예약보다 몇 초 늦다. 그래도 같은 날짜가 나와야 한다. */
    ck('6초 늦게 찍혀도 8월 9일', endYmd(closeAt + 6) === '8월 9일', endYmd(closeAt + 6));
    ck('4분 59초까지는 8월 9일', endYmd(closeAt + 299) === '8월 9일', endYmd(closeAt + 299));
    /* 자정과 무관한 시각에 끝난 시즌은 늦게 찍힐 이유가 없다 — 그날로 적는다. */
    ck('낮에 끝난 시즌은 그날로 적는다',
      endYmd(closeAt + 14 * 3600) === '8월 10일', endYmd(closeAt + 14 * 3600));

    /* 예약은 "지금 열려 있는 시즌"을 닫는 것이다. 이미 닫힌 시즌 화면에 붙이면
       다음 시즌 예약을 그 시즌의 종료일인 양 적게 된다. */
    const seasonId = LB.buildRankPayload(null, 'overall', null).season.id;
    S.closeSeason({ seed: 0, nextName: '시즌 1' });
    ck('닫힌 시즌 화면에는 안 붙는다',
      LB.buildRankPayload(seasonId, 'overall', null).season.closeAt === null);

    /* 화면 코드도 그 자리에 있는가 — 자료만 실려 오고 그리는 쪽이 없으면 여전히 "미정"이다.
       끝난 시즌도 같은 계산을 지나야 한다: 시즌 0 은 이미 닫혔고, closedAt 을 그대로
       적으면 8월 10일이 된다. */
    const src = require('node:fs').readFileSync('src/web/leaderboard.ts', 'utf8') as string;
    ck('배너가 예약된 종료일을 그린다', /s\.closeAt != null[\s\S]{0,200}endYmd\(s\.closeAt\)/.test(src));
    ck('끝난 시즌도 같은 계산을 쓴다', /s\.closedAt != null[\s\S]{0,160}endYmd\(s\.closedAt\)/.test(src));
    ck('화면의 여유 시간도 5분이다', /LAZY_SLACK = 300/.test(src));
    ck('예약이 없을 때만 미정이다', src.includes('미정'));
    SS.clearSeasonSchedule();
  }

  console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main();
