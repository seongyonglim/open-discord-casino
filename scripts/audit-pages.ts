// 페이지 감사 — 화면이 렌더되고, 그 안의 클라이언트 스크립트가 문법적으로 성립하는가.
//
// 왜 따로 있나: 각 게임 화면의 클라이언트 로직은 TS 템플릿 리터럴 안에 문자열로 들어 있다.
// 그래서 TS 컴파일러도, 린터도, 서버 감사도 그 안을 문법 검사하지 않는다 —
// 브라우저가 처음 파싱할 때 처음으로 드러난다.
//
// 실제로 서렌더 확인창에서 '…\n'을 썼다가(템플릿 리터럴 안이라 TS가 그 자리에서 진짜
// 개행으로 바꿔 내보냈다) 문자열이 줄 끝에서 닫히지 않아 블랙잭 페이지의 스크립트 전체가
// 파싱 실패했다. 폴링도, 베팅도, 버튼도 하나도 동작하지 않고 화면은
// "테이블을 준비하는 중…"에서 멈춘 채 운영에 배포됐다.
// 서버는 200을 돌려주고 콘솔에도 안 남으니 HTTP 감사로는 절대 안 걸린다.
//
// 이 검사는 라운드를 기다리지 않아 몇 초면 끝난다. 그래서 e2e(1분+) 안에 두지 않고
// 떼어 놓았다 — 화면을 만질 때마다 부담 없이 돌릴 수 있어야 그물 노릇을 한다.

// 감사는 항상 일회용 DB에서 돈다. DB_PATH를 지정하지 않고 실행해도 로컬/운영 데이터를
// 건드리지 않게 여기서 임시 경로로 못 박는다(첫 import보다 먼저 실행되어야 한다).
if (!process.env.DB_PATH) {
  const os = require('node:os'), path = require('node:path'), fsx = require('node:fs');
  process.env.DB_PATH = fsx.mkdtempSync(path.join(os.tmpdir(), 'casino-audit-'));
}

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { upsertUser, adjustBalance, getWebUser, createSession } from '../src/db/queries';

const PORT = Number(process.env.AUDIT_PORT ?? 8214);
let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function get(path: string, cookie: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET', headers: { cookie } }, res => {
      const c: Buffer[] = [];
      res.on('data', d => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });
}

/* 게임 화면은 전부 인라인 스크립트를 갖는다(needsJs). 로비·순위표·공지는 정적이라
   스크립트가 없는 게 정상이므로 "스크립트가 있는가"는 게임 쪽에만 묻는다.
   그래도 페이지는 다 받아본다 — 렌더 중 예외가 나면 여기서 잡힌다.
   그래프 화면의 경로는 /games/graph다(API만 crash라는 옛 이름을 쓴다). */
const PAGES: Array<[string, boolean]> = [
  ['/', false], ['/leaderboard', false], ['/notices', false],
  ['/games/ladder', true], ['/games/graph', true], ['/games/poker', true],
  ['/games/mines', true], ['/games/baccarat', true], ['/games/blackjack', true],
  ['/games/holdem', true],
];

async function main(): Promise<void> {
  const { startWebServer } = require('../src/web/server') as typeof import('../src/web/server');
  process.env.PORT = String(PORT);
  startWebServer();
  await sleep(400);

  upsertUser('a_pages', '페이지감사', null);
  if ((getWebUser('a_pages')?.balance ?? 0) <= 0) adjustBalance('a_pages', 10_000, 'test:seed');
  const token = randomBytes(16).toString('hex');
  createSession(token, 'a_pages', Math.floor(Date.now() / 1000) + 3600);
  const cookie = 'sid=' + token;

  console.log('\n[1] 페이지 렌더 + 인라인 스크립트 문법');
  for (const [p, needsJs] of PAGES) {
    const r = await get(p, cookie);
    ck(`${p} → 200`, r.status === 200, `status=${r.status}`);
    if (r.status !== 200) continue;

    /* src가 없는 <script> 블록만 뽑는다(app.js는 별도 파일이라 브라우저가 따로 파싱한다).
       type="application/json" 같은 데이터 블록은 JS가 아니므로 건너뛴다. */
    const blocks = [...r.text.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
      .filter(m => !/type\s*=\s*["'](?!text\/javascript|module)/i.test(m[1]))
      .map(m => m[2]);
    if (needsJs) ck(`${p} — 인라인 스크립트 존재`, blocks.length > 0, `${blocks.length}개`);

    let bad = '';
    blocks.forEach((b, i) => {
      // 파싱만 한다 — new Function은 본문을 컴파일하고 호출하지 않으므로 코드가 실행되지 않는다
      try { new Function(b); } catch (e) {
        /* 어느 줄인지 같이 찍는다 — 31,000자 스크립트에서 메시지만 보고는 못 찾는다.
           문자열이 줄 안에서 닫히지 않은 줄이 범인일 확률이 높아 그것도 짚어 준다. */
        const susp = b.split('\n')
          .map((l, n) => ({ n: n + 1, l }))
          .filter(x => ((x.l.match(/'/g) ?? []).length % 2 === 1))
          .slice(0, 3)
          .map(x => `${x.n}행: ${x.l.trim().slice(0, 60)}`);
        bad += `블록#${i} ${(e as Error).message}` + (susp.length ? ` / 홑따옴표 안 닫힌 줄 → ${susp.join(' | ')}` : '');
      }
    });
    ck(`${p} — 인라인 스크립트 파싱 성공`, bad === '', bad);
  }

  /* ── [2] 카드에 적힌 수치가 실제 게임 코드와 같은가 ──────────────────
     로비 카드의 한 줄 사실(최대 배당 등)은 pages.ts에 손으로 적혀 있다.
     game/*.ts가 pages.ts를 import하므로(gameSwitcher) 반대 방향 import는 순환이 된다.

     그래서 여기서 게임 모듈을 직접 불러 값을 다시 계산하고, 그 숫자가 렌더된 로비
     화면에 실제로 들어 있는지 본다. 배당 상수를 고치고 카드를 잊으면 이 검사가 깨진다 —
     "카드에 적힌 숫자가 거짓이 되는" 실패는 조용히 지나가면 안 되는 종류다. */
  console.log('\n[2] 로비 카드의 수치 = 게임 코드의 값');
  {
    const lobby = (await get('/', cookie)).text;
    const has = (s: string) => lobby.includes(s);

    const B = require('../src/web/games/baccarat') as typeof import('../src/web/games/baccarat');
    const C = require('../src/web/games/crash') as typeof import('../src/web/games/crash');
    const M = require('../src/web/games/mines') as typeof import('../src/web/games/mines');
    const PK = require('../src/services/poker') as typeof import('../src/services/poker');
    const BJ = require('../src/services/blackjack') as typeof import('../src/services/blackjack');
    const BC = require('../src/services/baccarat') as typeof import('../src/services/baccarat');
    const Q = require('../src/db/queries') as typeof import('../src/db/queries');

    // 바카라 — 다섯 시장 중 가장 높은 배당. 지금은 페어지만 코드가 바뀌면 따라간다
    const bo = B.baccaratOdds();
    const baccMax = Math.max(bo.player, bo.banker, bo.tie, bo.ppair, bo.bpair);
    ck('바카라 최대 배당', has(`최대 배당 ${baccMax}배`), `계산=${baccMax}`);
    ck('바카라 덱 수', has(`${BC.DECKS}덱`), `DECKS=${BC.DECKS}`);

    /* 블랙잭 — A + K를 들었을 때의 배수. 카드 인덱스는 rank = c >> 2 이고 A는 12, K는 11이다
       (services/blackjack.ts cardRank). 딜러는 블랙잭이 아니어야 하므로 2 + 3을 준다. */
    const bjMax = BJ.settleHand([48, 44], [0, 4]).multiplier;
    ck('블랙잭 배수', bjMax === 2.5 && has(`블랙잭 ${bjMax}배`), `settleHand=${bjMax}`);

    /* 지뢰찾기는 최대 배당을 카드에 적지 않는다 — 이론상 최대(지뢰 10개에서 15칸 전부)가
       3,236,072배다. 참이지만 확률이 300만분의 1이라 "최대 배당"으로 내놓으면
       복권 문구가 된다. 대신 실제로 고를 수 있는 구조를 적는다. */
    ck('지뢰찾기 칸 수', has(`${M.TILE_COUNT}칸`), `TILE_COUNT=${M.TILE_COUNT}`);
    ck('지뢰찾기 선택 가능한 지뢰 수',
      has(`지뢰 ${M.ALLOWED_MINE_COUNTS.join('·')}개`), M.ALLOWED_MINE_COUNTS.join('·'));

    ck('그래프 최대 배율', has(`최대 배율 ${C.MAX_CRASH.toLocaleString('ko-KR')}배`),
      `MAX_CRASH=${C.MAX_CRASH}`);
    ck('포커 플립 배당 상한', has(`최대 ${PK.MAX_ODDS.toLocaleString('ko-KR')}배`),
      `MAX_ODDS=${PK.MAX_ODDS}`);
    ck('사다리 단일·양쪽 배당',
      has(`단일 ${Q.LADDER_MULTIPLIER}배 · 양쪽 ${Q.LADDER_DOUBLE_MULTIPLIER}배`),
      `${Q.LADDER_MULTIPLIER} / ${Q.LADDER_DOUBLE_MULTIPLIER}`);

    /* 홀덤 카드에는 고정 사실 줄을 두지 않는다 — 그 카드의 설명이 이미 대회 상태에서
       나온 살아 있는 수치(신청 인원·상금 풀)를 담고 있고, 그게 고정값보다 낫다.
       대신 그 살아 있는 수치가 실제로 렌더되는지 확인한다. */
    ck('홀덤 카드는 대회 상태를 비춘다',
      /등록은 .*후에 열립니다|등록 중|명 신청|진행 중|오늘 대회|인원 대기/.test(lobby));
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`통과 ${pass} · 실패 ${fail}`);
  if (fail) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(e => { console.error(e); process.exit(1); });
