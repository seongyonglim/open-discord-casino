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

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`통과 ${pass} · 실패 ${fail}`);
  if (fail) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(e => { console.error(e); process.exit(1); });
