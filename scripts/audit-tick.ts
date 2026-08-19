/* 서버 전진 감사 — 클라이언트를 하나도 안 붙이고 판이 도는지 본다.
 *
 * 이 검사의 합격 기준은 하나다: 아무도 상태를 조회하지 않는 동안 라운드가 전진하는가.
 * 고치기 전에는 여기서 멈춘다 — 판을 넘기는 것이 요청이었기 때문이다.
 *
 * 실제로 시간을 흘려보내며 본다. 전진 함수를 직접 불러서 확인하면 "부르면 전진한다"만
 * 확인하는 셈이고, 그건 고치기 전에도 참이었다. 여기서 묻는 것은 "아무도 안 불러도
 * 전진하는가"이므로 타이머를 실제로 돌려야 한다.
 *
 * 안전: DB_PATH 를 임시 디렉터리로 못 박는다. 운영 DB 는 열지 않고 웹 서버도 안 띄운다.
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const d of readdirSync(tmpdir())) {
  if (d.startsWith('casino-tick')) rmSync(join(tmpdir(), d), { recursive: true, force: true });
}
process.env.DB_PATH = mkdtempSync(join(tmpdir(), 'casino-tick-'));
delete process.env.TICK;

const { getDb } = require('../src/db/schema') as typeof import('../src/db/schema');
const Q = require('../src/db/queries') as typeof import('../src/db/queries');
const CR = require('../src/db/queries/crash') as typeof import('../src/db/queries/crash');
const T = require('../src/tick') as typeof import('../src/tick');
const db = getDb();

let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

for (const u of ['t1', 't2', 't3']) {
  Q.upsertUser(u, u, null);
  if ((Q.getWebUser(u)?.balance ?? 0) <= 0) Q.adjustBalance(u, 100_000, 'tick:seed');
}

const roundRow = () => db.prepare(
  `SELECT id, phase FROM crash_rounds ORDER BY id DESC LIMIT 1`).get() as
  { id: number; phase: string } | undefined;

async function main(): Promise<void> {
  console.log('[1] 고치기 전 — 아무도 안 보면 판이 서 있다');
  {
    /* 타이머 없이 시간만 흘려보낸다. 이것이 예전 동작이다. */
    ck('아직 라운드가 없다', roundRow() === undefined);
    await sleep(600);
    ck('시간이 지나도 저절로 생기지 않는다', roundRow() === undefined,
      JSON.stringify(roundRow()));
    /* 요청이 오면 그때 생긴다 — 지연 진행이 그대로 남아 있다는 확인이기도 하다. */
    CR.advanceCrashRound({
      makeCrashPoint: () => 2, crashDurationMs: () => 1000, multiplierAt: () => 1 });
    ck('부르면 그때 생긴다 (지연 진행은 그대로다)', roundRow() !== undefined);
    db.prepare(`DELETE FROM crash_rounds`).run();
  }

  console.log('\n[2] 서버 전진 — 아무도 안 봐도 판이 돈다');
  {
    T.startTicks();
    await sleep(700);
    const r1 = roundRow();
    ck('타이머만으로 라운드가 생긴다', r1 !== undefined, '아무도 조회하지 않았다');

    /* 다음 단계로 넘어가는 것까지 본다 — "한 번 만들었다"가 아니라 "계속 돈다"여야 한다.
       라운드가 저절로 끝나기를 기다리지 않는다: 진행 시간이 크래시 지점에 따라 달라져
       기다리는 시간을 정할 수가 없다(그렇게 짰다가 한 번은 통과하고 한 번은 실패했다).
       대신 "이미 지나간 판"을 심어 두고, 타이머가 그것을 치우는지 본다. */
    const nowSec = Math.floor(Date.now() / 1000);

    /* (a) 베팅 시간이 이미 끝난 판 → 베팅에서 벗어나야 한다.
       "진행 중이 되었나"로 보면 안 된다: 진행으로 넘어간 직후 곧바로 터져 done 이 되면
       그 순간을 놓친다(실제로 다섯 번에 한 번 그렇게 실패했다). 여기서 확인하려는 것은
       "아무도 안 봐도 베팅이 닫히는가"이므로 벗어났다는 것만 보면 된다. */
    db.prepare(`UPDATE crash_rounds SET phase='betting', betting_ends_at=?, started_at_ms=NULL
                 WHERE id=?`).run(nowSec - 1, roundRow()!.id);
    let left = false;
    for (let i = 0; i < 20 && !left; i++) {
      await sleep(120);
      left = roundRow()?.phase !== 'betting';
    }
    ck('베팅이 끝난 판을 저절로 닫는다', left, JSON.stringify(roundRow()));

    // (b) 이미 끝나고 공개 시간까지 지난 판 → 새 라운드가 열려야 한다
    const before = roundRow()!.id;
    const CRC = require('../src/db/queries/crash') as typeof import('../src/db/queries/crash');
    db.prepare(`UPDATE crash_rounds SET phase='done', resolved_at=? WHERE id=?`)
      .run(nowSec - CRC.CRASH_REVEAL_SEC - 1, before);
    let opened = false;
    for (let i = 0; i < 20 && !opened; i++) {
      await sleep(120);
      opened = (roundRow()?.id ?? 0) > before;
    }
    ck('끝난 판 다음에 새 라운드를 연다', opened, `id ${before} 에서 멈춰 있다`);
    T.stopTicks();
  }

  console.log('\n[3] 멈추면 예전으로 돌아간다');
  {
    const before = roundRow()?.id ?? 0;
    await sleep(700);
    ck('멈춘 뒤에는 저절로 전진하지 않는다', (roundRow()?.id ?? 0) === before);
    /* 되돌릴 구멍이 실제로 동작하는지 — 배포 후 이상하면 이걸로 끈다. */
    process.env.TICK = 'off';
    T.startTicks();
    await sleep(500);
    ck('TICK=off 면 켜지지 않는다', (roundRow()?.id ?? 0) === before);
    T.stopTicks();
    delete process.env.TICK;
  }

  console.log('\n[4] 요청 경로는 손대지 않았다');
  {
    const src = (p: string) => readFileSync(p, 'utf8');
    /* 이 파일은 대체가 아니라 덧붙임이다. 요청이 전진시키는 경로가 남아 있어야
       타이머가 죽어도 예전 동작이 안전망으로 남는다. */
    ck('그래프 상태 조회가 여전히 전진시킨다',
      /statePayload\(advance\(\)/.test(src('src/web/games/crash.ts')));
    ck('홀덤 상태 조회가 여전히 전진시킨다',
      /advanceHoldem\(\)/.test(src('src/web/games/holdem.ts')));
    /* 규칙은 게임 모듈이 쥔다 — 타이머가 헬퍼를 따로 조립하면 화면이 부르는 전진과
       타이머가 부르는 전진이 갈라진다. */
    const tick = src('src/tick.ts');
    ck('타이머는 게임의 전진 함수만 부른다',
      /advance as advanceCrash/.test(tick) && !/makeCrashPoint/.test(tick));
    ck('네 게임을 모두 돌린다',
      ['crash', 'ladder', 'poker', 'holdem'].every(g => new RegExp(`name: '${g}'`).test(tick)));
    /* 한 번의 전진이 간격보다 오래 걸려도 호출이 쌓이면 안 된다 — 사람이 늘어 DB 가
       느려지는 날에 그 차이가 난다.
       주석은 걷어내고 본다. 왜 setInterval 을 안 쓰는지 적어 둔 설명에 그 단어가
       들어 있어서, 안 걷으면 설명을 지워야 검사가 통과하는 꼴이 된다. */
    const tickCode = tick.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    ck('끝난 뒤 다음을 예약한다 (setInterval 이 아니다)',
      /schedule\(job, back, nextFails\)/.test(tickCode) && !/setInterval/.test(tickCode));
    ck('실패해도 타이머가 죽지 않는다', /catch \(e\) \{[\s\S]{0,200}?nextFails = fails \+ 1;/.test(tick));
    ck('연달아 실패하면 간격을 늘린다', /BACKOFF_AFTER/.test(tick) && /BACKOFF_MAX_MS/.test(tick));
    /* 타이머가 프로세스를 붙들면 종료 신호를 받고도 안 죽는다. */
    ck('타이머가 프로세스를 붙들지 않는다', /t\.unref\?\.\(\)/.test(tick));

    /* 낡은 주석이 남아 있으면 다음에 읽는 사람이 없는 제약을 지키려 한다.
       "7분 뒤 절전"은 auto_stop_machines = "off" 로 바꾼 뒤로 사실이 아니다. */
    ck('절전 전제를 적어 둔 낡은 주석이 없다',
      !/7분 뒤 절전에 들어가므로/.test(src('src/db/holdem.ts')),
      'db/holdem.ts 머리말');
    ck('fly.toml 은 상시 가동이다',
      /auto_stop_machines = "off"/.test(src('fly.toml')));
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
