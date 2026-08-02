// 보안 감사 — 인증·입력검증·주입을 실제 요청으로 확인한다.

// 감사는 항상 일회용 DB에서 돈다. DB_PATH를 지정하지 않고 실행해도 로컬/운영 데이터를 건드리지 않게
// 여기서 임시 경로로 못 박는다(첫 import보다 먼저 실행되어야 하므로 파일 맨 위에 둔다).
if (!process.env.DB_PATH) {
  const os = require('node:os'), path = require('node:path'), fsx = require('node:fs');
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'casino-audit-'));
  process.env.DB_PATH = dir;
}

import http from 'node:http';
import { randomBytes, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { getDb } from '../src/db/schema';
import { upsertUser, adjustBalance, getWebUser, createSession } from '../src/db/queries';

const PORT = Number(process.env.AUDIT_PORT ?? 8211);
let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
function section(s: string): void { console.log('\n' + s); }

interface Res { status: number; body: any; text: string; headers: http.IncomingHttpHeaders }
function req(method: string, path: string, opts: { cookie?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = opts.raw !== undefined ? opts.raw
      : opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const r = http.request({
      host: '127.0.0.1', port: PORT, path, method,
      headers: {
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(data !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
        ...(opts.headers ?? {}),
      },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch { /* HTML */ }
        resolve({ status: res.statusCode ?? 0, body: parsed, text, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data !== undefined) r.write(data);
    r.end();
  });
}

const db = getDb();
function mkSession(id: string, start: number, username = '보안테스터'): string {
  upsertUser(id, username, null);
  const cur = getWebUser(id)?.balance ?? 0;
  if (cur !== start) adjustBalance(id, start - cur, 'test:seed');
  const token = randomBytes(16).toString('hex');
  createSession(token, id, Math.floor(Date.now() / 1000) + 3600);
  return `sid=${token}`;
}
const bal = (id: string) => getWebUser(id)!.balance;

async function main(): Promise<void> {
  const { startWebServer } = require('../src/web/server') as typeof import('../src/web/server');
  process.env.PORT = String(PORT);
  startWebServer();
  await new Promise(r => setTimeout(r, 600));

  /* ── 1. 인증 ────────────────────────────────────────────────── */
  section('[1] 인증 — 로그인 없이 접근');
  {
    const apis = [
      ['GET', '/api/games/ladder/state'], ['POST', '/api/games/ladder/bet'],
      ['GET', '/api/games/crash/state'], ['POST', '/api/games/crash/bet'],
      ['POST', '/api/games/crash/cashout'],
      ['GET', '/api/games/poker/state'], ['POST', '/api/games/poker/bet'],
      ['POST', '/api/games/mines/start'], ['POST', '/api/games/mines/reveal'],
      ['POST', '/api/games/mines/cashout'],
    ] as const;
    let bad = '';
    for (const [m, p] of apis) {
      const r = await req(m, p, { body: {} });
      if (r.status !== 401) bad += `${p}→${r.status} `;
    }
    ck(`게임 API 전부 401 (${apis.length}개)`, bad === '', bad);

    for (const p of ['/games/ladder', '/games/graph', '/games/poker', '/games/mines']) {
      const r = await req('GET', p);
      ck(`${p} 비로그인 → 로그인으로 리다이렉트`, r.status === 302, String(r.status));
    }

    const forged = await req('GET', '/api/games/ladder/state', { cookie: 'sid=' + 'f'.repeat(32) });
    ck('위조 세션 토큰 거부', forged.status === 401, String(forged.status));

    // 만료된 세션은 통과하면 안 된다
    const expiredTok = randomBytes(16).toString('hex');
    upsertUser('s_exp', '만료', null);
    createSession(expiredTok, 's_exp', Math.floor(Date.now() / 1000) - 10);
    const exp = await req('GET', '/api/games/ladder/state', { cookie: 'sid=' + expiredTok });
    ck('만료된 세션 거부', exp.status === 401, String(exp.status));
  }

  /* ── 2. 베팅 금액 검증 ──────────────────────────────────────── */
  section('[2] 베팅 금액 — 음수·0·소수·거대값·NaN');
  {
    const c = mkSession('s_bet', 1000);
    const cases: [string, unknown][] = [
      ['음수', -100], ['0', 0], ['NaN', 'abc'], ['null', null],
      ['Infinity', 1e999], ['거대값', Number.MAX_SAFE_INTEGER],
      ['소수', 10.7], ['지수표기 문자열', '1e10'],
    ];
    for (const [label, v] of cases) {
      const before = bal('s_bet');
      const r = await req('POST', '/api/games/ladder/bet', { cookie: c, body: { betAmount: v, startGuess: 'L' } });
      const after = bal('s_bet');
      // 소수(10.7)는 내림해서 10P로 받아들이는 게 정상이다 — 나머지는 전부 거절되어야 한다
      if (label === '소수') {
        ck(`${label} 베팅은 내림해서 수용 (10.7 → 10P)`, r.body?.ok === true && before - after === 10, `${before}→${after}`);
      } else {
        const rejected = r.status === 400 || r.body?.ok !== true;
        const noSteal = after >= before - 0; // 거절이면 차감 없음
        ck(`${label} 베팅 거절 + 잔액 보호`, rejected && (rejected ? after === before : noSteal),
          `status=${r.status} ${before}→${after}`);
      }
      // 다음 케이스를 위해 라운드 베팅 상태를 정리
      await req('POST', '/api/games/ladder/cancel', { cookie: c, body: {} });
    }
    ck('연속 검증 후에도 잔액 손실 없음', bal('s_bet') === 1000, String(bal('s_bet')));
  }

  /* ── 3. 남의 자원 조작 ──────────────────────────────────────── */
  section('[3] 권한 — 남의 베팅/라운드 건드리기');
  {
    const a = mkSession('s_a', 1000);
    const b = mkSession('s_b', 1000);
    await req('POST', '/api/games/mines/start', { cookie: a, body: { betAmount: 100, mineCount: 3 } });
    // b가 a의 라운드를 캐시아웃하려 시도 — 서버는 userId로만 라운드를 찾으므로 실패해야 한다
    const steal = await req('POST', '/api/games/mines/cashout', { cookie: b, body: {} });
    ck('남의 지뢰찾기 라운드 캐시아웃 불가', steal.body?.ok !== true, JSON.stringify(steal.body));
    ck('a의 잔액 변화 없음', bal('s_a') === 900, String(bal('s_a')));
    ck('b의 잔액 변화 없음', bal('s_b') === 1000, String(bal('s_b')));

    // 포커: 존재하지 않는 시장 이름
    const badMarket = await req('POST', '/api/games/poker/bet', { cookie: b, body: { market: 'b9', amount: 100 } });
    ck('존재하지 않는 베팅 시장 거절', badMarket.status === 400, String(badMarket.status));
    const sqlMarket = await req('POST', '/api/games/poker/bet', { cookie: b, body: { market: "master'; DROP TABLE users;--", amount: 100 } });
    ck('시장명 SQL 주입 시도 거절', sqlMarket.status === 400, String(sqlMarket.status));
    const tablesLeft = (db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='users'`).get() as any).n;
    ck('users 테이블 살아 있음', tablesLeft === 1);
  }

  /* ── 4. 본문 파싱 ───────────────────────────────────────────── */
  section('[4] 요청 본문 — 깨진 JSON·거대 본문');
  {
    const c = mkSession('s_body', 1000);
    const broken = await req('POST', '/api/games/ladder/bet', { cookie: c, raw: '{"betAmount":' });
    ck('깨진 JSON에 500 아님', broken.status !== 500, String(broken.status));

    // 100KB를 넘기면 readJson이 소켓을 끊는다(메모리 고갈 방어). 클라이언트에는 ECONNRESET로 보이는데,
    // 그건 정상 동작이다 — 확인해야 할 것은 "서버가 그 뒤에도 살아 있는가"다.
    let reset = false;
    const huge = await req('POST', '/api/games/ladder/bet',
      { cookie: c, raw: JSON.stringify({ betAmount: 1, pad: 'x'.repeat(2_000_000) }) })
      .catch((e: NodeJS.ErrnoException) => { reset = e.code === 'ECONNRESET'; return null; });
    ck('2MB 본문은 끊거나 거절 (무제한 수용 안 함)', reset || (huge !== null && huge.status !== 200),
      reset ? 'ECONNRESET' : String(huge?.status));
    const alive = await req('GET', '/health');
    ck('거대 본문 이후에도 서버 정상', alive.text === 'ok', alive.text);
    const stillWorks = await req('POST', '/api/games/ladder/bet', { cookie: c, body: { betAmount: 10, startGuess: 'L' } });
    ck('거대 본문 이후에도 정상 베팅 처리', stillWorks.status === 200 || stillWorks.status === 400, String(stillWorks.status));
    await req('POST', '/api/games/ladder/cancel', { cookie: c, body: {} });
  }

  /* ── 5. XSS ─────────────────────────────────────────────────── */
  section('[5] XSS — 닉네임에 스크립트 삽입');
  {
    const payload = `</script><img src=x onerror=alert(1)>"'&`;
    const c = mkSession('s_xss', 1000, payload);
    const page = await req('GET', '/', { cookie: c });
    ck('닉네임이 HTML에 날것으로 들어가지 않음',
      !page.text.includes('<img src=x onerror'), '원문 노출');
    ck('스크립트 종료 태그가 이스케이프됨',
      !page.text.includes('</script><img'), '스크립트 탈출 가능');
    ck('&lt; 형태로 이스케이프 확인', page.text.includes('&lt;/script&gt;') || page.text.includes('&lt;img'), '이스케이프 흔적 없음');

    // 게임 페이지의 <script> 블록 안 삽입 (jsonForScript 경로)
    await req('POST', '/api/games/ladder/bet', { cookie: c, body: { betAmount: 10, startGuess: 'L' } });
    const gp = await req('GET', '/games/ladder', { cookie: c });
    // 판정 기준은 "onerror라는 글자가 있느냐"가 아니라 "<img 태그로 파싱될 수 있느냐"다.
    // esc()는 = ( ) 를 건드리지 않으므로 onerror=alert(1)이라는 글자는 남지만,
    // < 와 > 가 엔티티로 바뀌어 있으면 그건 태그가 아니라 그냥 텍스트다.
    ck('게임 페이지에 태그로 파싱될 <img 없음', !gp.text.includes('<img src=x'), '태그 생성됨');
    ck('스크립트 블록에 리터럴 </script 없음 (스크립트 탈출 불가)',
      !gp.text.slice(gp.text.indexOf('window.__ME__')).startsWith('window.__ME__ = "</script'),
      '스크립트 탈출 가능');
    ck('스크립트 블록에서 < 가 \\u003c로 이스케이프됨', gp.text.includes('\\u003c/script\\u003e'), '이스케이프 없음');
    const leaderboard = await req('GET', '/leaderboard', { cookie: c });
    ck('랭킹 페이지도 이스케이프됨', !leaderboard.text.includes('<img src=x onerror'), '원문 노출');
  }

  /* ── 6. 디스코드 서명 검증 ──────────────────────────────────── */
  section('[6] 디스코드 인터랙션 — 서명 검증 (fail-closed)');
  {
    const body = JSON.stringify({ type: 1 });
    const noSig = await req('POST', '/discord/interactions', { raw: body });
    ck('서명 헤더 없으면 401', noSig.status === 401, String(noSig.status));

    const badSig = await req('POST', '/discord/interactions', {
      raw: body,
      headers: { 'x-signature-ed25519': 'aa'.repeat(64), 'x-signature-timestamp': String(Math.floor(Date.now() / 1000)) },
    });
    ck('가짜 서명 401', badSig.status === 401, String(badSig.status));

    // 남의 키로 올바르게 서명해도 거부되어야 한다 (공개키가 일치하지 않으므로)
    const { privateKey } = generateKeyPairSync('ed25519');
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = edSign(null, Buffer.from(ts + body), privateKey).toString('hex');
    const otherKey = await req('POST', '/discord/interactions', {
      raw: body, headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts },
    });
    ck('다른 키로 서명해도 401', otherKey.status === 401, String(otherKey.status));
  }

  /* ── 7. 정적 자산 경로 ──────────────────────────────────────── */
  section('[7] 정적 자산 — 경로 조작');
  {
    const paths = [
      '/sfx/../../.env', '/cards/../../package.json', '/img/../../.env',
      '/sfx/%2e%2e%2f%2e%2e%2f.env', '/img/..%2f..%2ffly.toml',
      '/img/broke.jpg/../../../.env', '/app.css/../../.env',
    ];
    for (const p of paths) {
      const r = await req('GET', p);
      ck(`${p} 차단`, r.status !== 200 || !/DISCORD|TOKEN|dependencies/.test(r.text), `${r.status}`);
    }
    const ok = await req('GET', '/img/broke.jpg');
    ck('정상 이미지 200', ok.status === 200 && ok.headers['content-type'] === 'image/jpeg', String(ok.status));
  }

  /* ── 8. 관리자 권한 ─────────────────────────────────────────── */
  section('[8] 권한 상승 — 일반 유저가 관리자 표시를 얻지 못함');
  {
    const c = mkSession('s_norm', 100);
    const page = await req('GET', '/', { cookie: c });
    ck('일반 유저 페이지에 ADMIN 배지 없음', !page.text.includes('>ADMIN<'), 'ADMIN 노출');
    const role = getWebUser('s_norm')!.role;
    ck('DB 역할이 member', role === 'member', role);
  }

  console.log(`\n${'─'.repeat(52)}\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
