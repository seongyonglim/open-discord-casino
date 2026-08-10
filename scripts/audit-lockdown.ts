/* 시즌 마감 락다운 감사.
 *
 * 이 장치가 막으려는 사고는 하나다: 마감 순간에 열려 있던 판이 다음 시즌에 정산되면서
 * 지난 시즌 돈으로 산 배당이 새 시즌 잔액에 얹히는 것. 그래서 두 가지를 특히 확실히 한다.
 *   · 마감 5분 전부터 새 판이 열리지 않는다
 *   · 그 순간 열려 있던 판은 하나도 남지 않는다 (그리고 한 푼도 삼키지 않는다)
 *
 * "한 푼도 삼키지 않는다"가 특히 중요하다. 강제 정산은 사람이 누른 것이 아니라 서버가
 * 대신 끝낸 것이므로, 돈이 사라지면 아무도 그 사실을 알아채지 못한다.
 */
if (!process.env.DB_PATH) {
  const os = require('node:os'), path = require('node:path'), fsx = require('node:fs');
  process.env.DB_PATH = fsx.mkdtempSync(path.join(os.tmpdir(), 'casino-audit-'));
}

import { getDb } from '../src/db/schema';
import * as Q from '../src/db/queries';
import * as SS from '../src/db/season-schedule';
import * as LK from '../src/web/lockdown';
import { calcMultiplier } from '../src/web/games/mines';

const db = getDb();
let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
function section(s: string): void { console.log('\n' + s); }

const now = (): number => Math.floor(Date.now() / 1000);
const bal = (id: string): number => Q.getWebUser(id)!.balance;

function wipe(): void {
  db.exec(`DELETE FROM game_rounds; DELETE FROM ladder_bets; DELETE FROM ladder_rounds;
           DELETE FROM crash_bets; DELETE FROM crash_rounds;
           DELETE FROM poker_bets; DELETE FROM poker_rounds;
           DELETE FROM baccarat_bets; DELETE FROM baccarat_rounds;
           DELETE FROM blackjack_hands; DELETE FROM blackjack_rounds;
           DELETE FROM points_ledger; DELETE FROM users; DELETE FROM game_stats;`);
}
function mkUser(id: string, start: number): void {
  Q.upsertUser(id, id, null);
  if (start) Q.adjustBalance(id, start, 'audit:seed');
}
/** 잔액 = 원장 누적합. 이 서비스의 경제 규칙이고, 강제 정산도 예외가 아니다. */
function ledgerOk(label: string): void {
  const bad = db.prepare(`
    SELECT u.id, u.balance, COALESCE(SUM(p.delta), 0) AS s
      FROM users u LEFT JOIN points_ledger p ON p.user_id = u.id
     GROUP BY u.id HAVING u.balance != COALESCE(SUM(p.delta), 0)`).all() as unknown[];
  ck(`${label} — 잔액 = 원장 누적합`, bad.length === 0, JSON.stringify(bad));
}

/* 공용 라운드 한 판을 만들고 그 위에 미정산 베팅을 심는다.
   실제 게임 흐름을 태우지 않는 이유: 라운드가 제 힘으로 정산되기를 기다려야 하고
   (몇 초에서 몇십 초) 그러면 이 검사가 시간에 의존한다. 여기서 보려는 것은
   "미정산 줄이 남아 있을 때 락다운이 그걸 어떻게 처리하나"뿐이다. */
function seedBet(table: string, userId: string, amount: number): void {
  if (table === 'ladder_bets') {
    db.prepare(`INSERT INTO ladder_rounds (phase, betting_ends_at) VALUES ('betting', ?)`).run(now() + 60);
    const rid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    db.prepare(`INSERT INTO ladder_bets (round_id, user_id, username, start_guess, amount)
                VALUES (?, ?, ?, 'L', ?)`).run(rid, userId, userId, amount);
  } else if (table === 'crash_bets') {
    db.prepare(`INSERT INTO crash_rounds (phase, betting_ends_at, crash_point) VALUES ('betting', ?, 2)`)
      .run(now() + 60);
    const rid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    db.prepare(`INSERT INTO crash_bets (round_id, user_id, username, amount) VALUES (?, ?, ?, ?)`)
      .run(rid, userId, userId, amount);
  } else if (table === 'poker_bets') {
    db.prepare(`INSERT INTO poker_rounds (phase, betting_ends_at, hole_json, board_json, odds_json)
                VALUES ('betting', ?, '[]', '[]', '{}')`).run(now() + 60);
    const rid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    db.prepare(`INSERT INTO poker_bets (round_id, user_id, username, market, amount, odds)
                VALUES (?, ?, ?, 'master', ?, 2)`).run(rid, userId, userId, amount);
  } else if (table === 'baccarat_bets') {
    db.prepare(`INSERT INTO baccarat_rounds (phase, betting_ends_at, cards_json)
                VALUES ('betting', ?, '[]')`).run(now() + 60);
    const rid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    db.prepare(`INSERT INTO baccarat_bets (round_id, user_id, username, market, amount, odds)
                VALUES (?, ?, ?, 'player', ?, 2)`).run(rid, userId, userId, amount);
  } else {
    db.prepare(`INSERT INTO blackjack_rounds (phase, betting_ends_at, shoe_json) VALUES ('betting', ?, '[]')`)
      .run(now() + 60);
    const rid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    db.prepare(`INSERT INTO blackjack_hands (round_id, user_id, username, seat, bet, cards_json, status)
                VALUES (?, ?, ?, 0, ?, '[]', 'playing')`).run(rid, userId, userId, amount);
  }
  // 베팅은 잔액에서 빠진 상태여야 한다 — 실제 게임이 그렇게 하고, 환불은 그 반대다
  Q.adjustBalance(userId, -amount, 'audit:bet');
}

function main(): void {
  /* ── 1. 상태 판정 ────────────────────────────────────────────── */
  section('[1] 언제부터 락다운인가');
  {
    SS.clearSeasonSchedule();
    ck('예약이 없으면 락다운도 없다', !SS.seasonLockdown().active);
    ck('예약이 없으면 남은 시간도 0', SS.seasonLockdown().secondsLeft === 0);

    ck('5분이다 (요청서에 적힌 그대로)', SS.LOCKDOWN_SEC === 300, String(SS.LOCKDOWN_SEC));
    const T = 2_000_000_000;
    SS.saveSeasonSchedule({ closeAt: T, nextName: '다음', seed: 0 });
    /* 경계를 한 초 단위로 본다. 여기가 어긋나면 5분이 4분 59초나 5분 1초가 된다. */
    ck('5분 1초 전에는 아직 아니다', !SS.seasonLockdown(T - 301).active);
    ck('정확히 5분 전부터다', SS.seasonLockdown(T - 300).active);
    ck('그 뒤로도 계속 락다운', SS.seasonLockdown(T - 1).active);
    ck('마감 시각에도 락다운', SS.seasonLockdown(T).active);
    ck('남은 시간이 맞다', SS.seasonLockdown(T - 90).secondsLeft === 90,
      String(SS.seasonLockdown(T - 90).secondsLeft));
    ck('마감을 지나면 남은 시간은 0', SS.seasonLockdown(T + 10).secondsLeft === 0);

    /* 마감이 지나면 ensureSeasonClosed 가 예약을 지운다 → 락다운도 저절로 풀린다.
       푸는 코드를 따로 두지 않았으므로 이게 참이어야 한다. */
    wipe();
    mkUser('lk1', 5_000);
    SS.saveSeasonSchedule({ closeAt: now() - 1, nextName: '시즌 1', seed: 0 });
    ck('검사 전제: 지금은 락다운', SS.seasonLockdown().active);
    SS.ensureSeasonClosed();
    ck('시즌이 넘어가면 락다운이 풀린다', !SS.seasonLockdown().active);
    ck('예약도 지워졌다', SS.getSeasonSchedule().closeAt === null);
  }

  /* ── 2. 무엇을 막는가 ────────────────────────────────────────── */
  section('[2] 막는 주소와 여는 주소');
  {
    /* 돈을 새로 거는 요청만 막는다. */
    for (const p of [
      '/api/games/mines/start', '/api/games/mines/reveal',
      '/api/games/ladder/bet', '/api/games/crash/bet', '/api/games/poker/bet',
      '/api/games/baccarat/bet', '/api/games/blackjack/bet', '/api/games/blackjack/action',
      '/api/games/holdem/register', '/api/games/holdem/sitin',
    ]) ck(`막는다: ${p}`, LK.lockedPath(p));

    /* 이미 건 돈을 빼는 길과 화면을 그리는 길은 열어 둔다 — 막으면 지키려던 것과
       반대가 된다(건 돈을 뺄 수 없고, 안내 배너도 못 본다). */
    for (const p of [
      '/api/games/mines/cashout',
      '/api/games/ladder/state', '/api/games/ladder/cancel',
      '/api/games/crash/state', '/api/games/crash/cancel', '/api/games/crash/cashout',
      '/api/games/poker/state', '/api/games/poker/clear',
      '/api/games/baccarat/state', '/api/games/baccarat/clear',
      '/api/games/blackjack/state', '/api/games/blackjack/clear',
      '/api/games/holdem/state', '/api/games/holdem/unregister', '/api/games/holdem/records',
      '/api/notifications', '/api/leaderboard', '/',
    ]) ck(`연다: ${p}`, !LK.lockedPath(p));

    /* 진행 중인 대회의 action 을 막으면 모두가 시간 초과로 자동 폴드된다 —
       대회는 강제 정산 대상이 아니라서 막는 쪽이 더 나쁘다. */
    ck('진행 중인 홀덤 핸드는 막지 않는다', !LK.lockedPath('/api/games/holdem/action'));
  }

  /* ── 3. 지뢰찾기 강제 캐시아웃 ───────────────────────────────── */
  section('[3] 지뢰찾기 — 지금 누른 것과 같은 금액이 들어온다');
  {
    wipe();
    mkUser('m1', 100_000);
    const BET = 10_000;
    /* 지뢰 3개 판에서 다섯 칸을 열어 둔 상태. 열 칸과 지뢰가 겹치지 않게 놓는다. */
    const r = Q.placeBet('m1', 'mines', BET, {
      mineCount: 3, minePositions: [22, 23, 24], revealed: [0, 1, 2, 3, 4],
    });
    ck('검사 전제: 판이 열렸다', r.ok);
    const before = bal('m1');
    const expected = Math.floor(BET * calcMultiplier(3, 5));

    const swept = LK.settleOpenStakes();
    ck('한 판을 정산했다', swept.mines === 1, JSON.stringify(swept));
    ck('지금 배당으로 캐시아웃됐다', bal('m1') === before + expected,
      `${bal('m1')} vs ${before + expected} (기대 배당 ${calcMultiplier(3, 5).toFixed(4)})`);
    ck('열린 판이 남지 않았다', Q.lockedStake('m1') === 0, String(Q.lockedStake('m1')));
    ck('판이 settled 로 닫혔다',
      (db.prepare(`SELECT COUNT(*) AS n FROM game_rounds WHERE status = 'active'`)
        .get() as { n: number }).n === 0);
    ck('판수에도 들어갔다 (실제로 한 판이었다)',
      (db.prepare(`SELECT rounds AS n FROM game_stats WHERE user_id='m1' AND game='mines'`)
        .get() as { n: number } | undefined)?.n === 1);
    ledgerOk('지뢰찾기 강제 캐시아웃 후');

    /* 두 번 돌려도 다시 주지 않는다 — 요청마다 도는 함수라 이게 가장 중요하다. */
    const after = bal('m1');
    LK.settleOpenStakes();
    LK.settleOpenStakes();
    ck('여러 번 돌려도 한 번만 준다', bal('m1') === after, `${bal('m1')} vs ${after}`);

    /* 칸을 하나도 안 연 판은 배당이 정확히 1.00 — 원금 그대로 돌려준다.
       그리고 판수에 넣지 않는다(아무 일도 일어나지 않은 판이다). */
    wipe();
    mkUser('m2', 50_000);
    Q.placeBet('m2', 'mines', 7_000, { mineCount: 5, minePositions: [20, 21, 22, 23, 24], revealed: [] });
    const b2 = bal('m2');
    LK.settleOpenStakes();
    ck('0칸이면 원금 전액 환불', bal('m2') === b2 + 7_000, `${bal('m2')} vs ${b2 + 7_000}`);
    ck('0칸 판은 판수에 안 넣는다',
      (db.prepare(`SELECT COUNT(*) AS n FROM game_stats WHERE user_id='m2'`)
        .get() as { n: number }).n === 0);
    ledgerOk('0칸 환불 후');

    /* 상태가 깨진 판도 돈을 삼키지 않는다 — 읽을 수 없다고 판돈을 먹는 것이 최악이다. */
    wipe();
    mkUser('m3', 50_000);
    Q.placeBet('m3', 'mines', 3_000, { mineCount: 1, minePositions: [24], revealed: [] });
    db.prepare(`UPDATE game_rounds SET state_json = '{{{' WHERE user_id = 'm3'`).run();
    const b3 = bal('m3');
    LK.settleOpenStakes();
    ck('상태가 깨진 판도 원금은 돌려준다', bal('m3') === b3 + 3_000, `${bal('m3')} vs ${b3 + 3_000}`);
    ledgerOk('깨진 판 환불 후');
  }

  /* ── 4. 나머지 게임 환불 ─────────────────────────────────────── */
  section('[4] 공용 라운드 — 원금을 그대로 돌려준다');
  {
    const TABLES = ['ladder_bets', 'crash_bets', 'poker_bets', 'baccarat_bets', 'blackjack_hands'];
    for (const t of TABLES) {
      wipe();
      mkUser('u1', 20_000);
      seedBet(t, 'u1', 5_000);
      ck(`검사 전제: ${t} 에 묶인 돈이 있다`, Q.lockedStake('u1') === 5_000,
        String(Q.lockedStake('u1')));
      const b = bal('u1');
      const swept = LK.settleOpenStakes();
      ck(`${t} 환불됨`, bal('u1') === b + 5_000, `${bal('u1')} vs ${b + 5_000}`);
      ck(`${t} 환불 건수가 1`, swept.refunded === 1, JSON.stringify(swept));
      ck(`${t} 묶인 돈이 0`, Q.lockedStake('u1') === 0, String(Q.lockedStake('u1')));
      // 두 번 돌려도 다시 주지 않는다
      const after = bal('u1');
      LK.settleOpenStakes();
      ck(`${t} 두 번 돌려도 한 번만`, bal('u1') === after);
      ledgerOk(`${t} 환불 후`);
    }

    /* 여섯 자리가 한꺼번에 열려 있어도 전부 정리된다. */
    wipe();
    mkUser('all', 200_000);
    Q.placeBet('all', 'mines', 1_000, { mineCount: 1, minePositions: [24], revealed: [] });
    for (const t of TABLES) seedBet(t, 'all', 2_000);
    ck('검사 전제: 여섯 자리가 다 열려 있다', Q.lockedStake('all') === 1_000 + 5 * 2_000,
      String(Q.lockedStake('all')));
    const b = bal('all');
    LK.settleOpenStakes();
    ck('한 번에 다 정리된다', Q.lockedStake('all') === 0, String(Q.lockedStake('all')));
    ck('돈이 한 푼도 사라지지 않았다', bal('all') === b + 1_000 + 5 * 2_000,
      `${bal('all')} vs ${b + 1_000 + 5 * 2_000}`);
    ledgerOk('전부 정리 후');
  }

  /* ── 5. 목록이 갈라지지 않는가 ───────────────────────────────── */
  section('[5] "묶인 돈이 있는 자리" 목록이 세 곳에서 같은가');
  {
    /* 새 게임이 붙으면 세 곳을 함께 고쳐야 한다: lockedStake(지원금 판정) ·
       claimRelief(같은 조건) · settleOpenStakes(강제 정산). 하나만 빠지면 그 게임의
       판돈이 시즌을 넘어간다 — 눈에 안 보이는 종류의 누락이라 검사로 못 박는다. */
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const core = readFileSync('src/db/queries/core.ts', 'utf8') as string;
    const lock = readFileSync('src/web/lockdown.ts', 'utf8') as string;
    const TABLES = ['game_rounds', 'ladder_bets', 'crash_bets', 'poker_bets',
      'baccarat_bets', 'blackjack_hands'];
    const stake = core.slice(core.indexOf('export function lockedStake'),
      core.indexOf('export function claimRelief'));
    for (const t of TABLES) {
      ck(`${t} — 지원금 판정에 있다`, stake.includes(t));
      ck(`${t} — 강제 정산에도 있다`, lock.includes(t));
    }
    /* 반대 방향도 본다: 강제 정산이 보는 자리가 지원금 판정에 없으면, 그 게임을 하는
       동안 파산 지원금을 받을 수 있게 된다. */
    for (const m of lock.matchAll(/refundBets\('(\w+)'/g)) {
      ck(`${m[1]} — 지원금 판정에도 있다`, stake.includes(m[1]), m[1]);
    }
  }

  /* ── 6. 요청 경로에 실제로 걸리는가 ─────────────────────────── */
  section('[6] 실제 요청 — 403 과 안내 배너');
  {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const srv = readFileSync('src/web/server.ts', 'utf8') as string;
    /* 게임마다 검사를 넣으면 새 게임이 붙는 날 빠진다 — 라우팅 한 곳에서 거른다. */
    ck('라우팅에서 한 번에 거른다', /lock\.active && lockedPath\(path\)/.test(srv));
    ck('403 으로 거절한다', /sendJson\(res, 403, \{[\s\S]{0,120}LOCKDOWN_MSG/.test(srv));
    ck('응답에 남은 시간을 함께 준다', /lockdown: \{ active: true, secondsLeft/.test(srv));
    /* 시즌이 방금 넘어갔으면 예약이 지워져 락다운도 풀려야 한다 — 순서가 그것을 정한다. */
    ck('시즌 마감 판정 다음에 온다',
      srv.indexOf('ensureSeasonClosed();') < srv.indexOf('ensureLockdown()'));

    const dc = readFileSync('src/discord/interactions.ts', 'utf8') as string;
    /* 지금 받은 포인트는 몇 분 뒤 초기화로 사라진다 — 받게 두면 "받았는데 없어졌다"가 된다. */
    ck('출석·지원금 버튼도 막는다', /seasonLockdown\(\)[\s\S]{0,200}LOCKDOWN_MSG/.test(dc));
    ck('두 버튼을 가르기 전에 막는다',
      dc.indexOf('const lock = seasonLockdown()') < dc.indexOf("customId === 'relief_claim'"));

    const app = readFileSync('src/web/assets/app.js', 'utf8') as string;
    ck('화면이 403 을 토스트로 올린다', /r\.status === 403[\s\S]{0,300}casinoNotify\.toast/.test(app));
    ck('막힌 그 자리에서 배너를 만든다', /showLockBar\(d\.lockdown\.secondsLeft\)/.test(app));
    ck('남은 시간을 화면이 센다', /lockTimer = setInterval\(lockTick, 1000\)/.test(app));
    ck('0 이 되면 새로 고친다', /location\.reload\(\)/.test(app));

    const vw = readFileSync('src/web/views.ts', 'utf8') as string;
    const css1 = readFileSync('src/web/assets/css/01-base.css', 'utf8') as string;
    const css13 = readFileSync('src/web/assets/css/13-achieve.css', 'utf8') as string;
    /* 배너는 헤더 안, 로고 줄보다 위에 있어야 한다. 헤더 밖에서 sticky 로 두면 둘이 같은
       자리(top:0)를 다투고, 스크롤한 순간 배너가 헤더를 덮는다 — 실제로 그랬다.
       파일은 CRLF 다 — \n 만 쓰면 이 검사가 늘 실패한다(이 저장소에서 반복되는 함정이다). */
    ck('배너가 헤더 안에 있다', /<header>\r?\n  \$\{lockBanner\(\)\}/.test(vw));
    ck('배너가 스스로 sticky 가 아니다', !/\.lockbar\{[^}]*position:sticky/.test(css1));
    /* 토스트가 헤더에 가려지면 안 된다. z-index 200 이던 때 헤더(300)가 덮어서 반쯤
       잘려 보였고, 제보를 받고 고쳤다 — 헤더보다 앞이고, 시작 위치는 헤더 높이에서 온다. */
    ck('토스트가 헤더보다 앞에 있다', /\.toast-stack \{[^}]*z-index: 4\d\d/.test(css13),
      (css13.match(/\.toast-stack \{[^}]*\}/) ?? [''])[0]);
    ck('토스트 위치가 헤더 높이에서 온다',
      /top: var\(--toast-top/.test(css13) && /--toast-top/.test(app)
      && /getBoundingClientRect\(\)\.bottom/.test(app));
    ck('락다운이 아니면 아무것도 안 그린다', /if \(!lock\.active\) return '';/.test(vw));
    ck('배너 스타일이 있다', css1.includes('.lockbar{'));
  }

  /* ── 7. 배너가 실제로 그려지는가 ─────────────────────────────── */
  section('[7] 배너 — 락다운일 때만');
  {
    const { layout } = require('../src/web/views') as typeof import('../src/web/views');
    SS.clearSeasonSchedule();
    const off = layout('t', 'lobby', '<p>x</p>');
    ck('평소에는 배너가 없다', !off.includes('lockbar'), '');

    SS.saveSeasonSchedule({ closeAt: now() + 120, nextName: 'n', seed: 0 });
    const on = layout('t', 'lobby', '<p>x</p>');
    ck('락다운이면 배너가 뜬다', on.includes('id="lockBar"'));
    ck('배너가 남은 시간을 담는다', /data-left="1[12]\d"/.test(on),
      (on.match(/data-left="\d+"/) ?? [''])[0]);
    ck('안내 문구가 들어 있다', on.includes('시즌 마감 정산 중'));
    /* 헤더 안에서 로고 줄보다 위에 있어야 한다 — 아래에 있으면 스크롤에 묻힌다. */
    ck('로고 줄보다 위에 있다',
      on.indexOf('lockbar') > on.indexOf('<header>')
      && on.indexOf('lockbar') < on.indexOf('class="brand"'));
    SS.clearSeasonSchedule();
  }

  console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main();
