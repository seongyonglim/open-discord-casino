// 배포 전 점검 (npm run smoke)
//
// 실서버와 같은 조건으로 서버를 새로 띄워서 "배포하면 깨질 것"들만 빠르게 확인한다.
// - 임시 디렉터리에 새 DB를 만들므로 개발용 data.db를 건드리지 않는다.
// - FLY_APP_NAME 을 넣어 fly 위에서 도는 상태를 재현한다 (임시 로그인이 닫혀 있는지 확인용).
// - 시크릿을 비워서, 디스코드 설정 전에 배포해도 서버가 죽지 않는지 확인한다.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';

const PORT = 8199;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dirname, '..');

let pass = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }

// fetch(undici)는 accept-encoding을 제멋대로 붙이고 응답을 자동 해제해버려서
// "실제로 몇 바이트가 선로에 나갔는지"를 볼 수 없다. 요금 측정이 목적이므로 원시 http를 쓴다.
function req(path: string, opts: { headers?: Record<string, string>; method?: string; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const r = http.request(`${BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers: { host: `127.0.0.1:${PORT}`, ...(opts.headers ?? {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks),
      }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

const get = (path: string, headers: Record<string, string> = {}) => req(path, { headers });
const getGz = (path: string) => req(path, { headers: { 'accept-encoding': 'gzip' } });

// 압축 여부를 보고 알아서 원본으로 되돌린다
function decoded(r: Reply): Buffer {
  return r.headers['content-encoding'] === 'gzip' ? gunzipSync(r.body) : r.body;
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'casino-smoke-'));
  console.log(`임시 DB: ${dataDir}\n`);

  const child = spawn(process.execPath, ['--experimental-sqlite', '--require', 'tsx/cjs', 'src/index.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: dataDir,
      FLY_APP_NAME: 'discord-casino-bot',   // fly 위에서 도는 상태 재현
      PREVIEW_LOGIN: '1',                   // 켜져 있어도 실서버에선 닫혀야 한다
      // 시크릿을 전부 비운다 (fly secrets 설정 전 배포 상황)
      DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '',
      DISCORD_OAUTH_REDIRECT_URI: '', DISCORD_GUILD_ID: '',
      DISCORD_PUBLIC_KEY: '', DISCORD_TOKEN: '',
    },
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });

  const started = Date.now();
  for (let i = 0; i < 100; i++) {
    try { await get('/health'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  const boot = Date.now() - started;

  try {
    console.log('[1] 기동 · 헬스체크');
    check('서버 프로세스 생존', child.exitCode === null, `exitCode=${child.exitCode}\n${log}`);
    const health = await get('/health');
    check('/health → 200 ok', health.status === 200 && health.body.toString() === 'ok');
    console.log(`        기동 소요 ${boot}ms (폴링 간격 100ms 오차 포함)`);

    console.log('\n[2] 시크릿 없이도 서버가 살아 있는지');
    const lobby = await get('/');
    check('로비 → 200', lobby.status === 200, `status=${lobby.status}`);
    const login = await get('/auth/login');
    check('/auth/login → 503 안내 (크래시 아님)', login.status === 503, `status=${login.status}`);
    check('안내 화면 charset 지정 (한글 안 깨짐)',
      String(login.headers['content-type'] ?? '').includes('charset=utf-8'));

    console.log('\n[3] 실서버 보안 잠금');
    const dev = await get('/dev/login');
    check('PREVIEW_LOGIN=1 이어도 /dev/login → 404', dev.status === 404, `status=${dev.status}`);
    for (const g of ['poker', 'ladder', 'graph', 'mines']) {
      const r = await get(`/games/${g}`);
      check(`비로그인 /games/${g} → 로그인으로 리다이렉트`,
        r.status === 302 && r.headers['location'] === '/auth/login', `status=${r.status}`);
    }
    for (const g of ['poker', 'ladder', 'crash']) {
      const r = await get(`/api/games/${g}/state`);
      check(`비로그인 /api/games/${g}/state → 401`, r.status === 401, `status=${r.status}`);
    }
    const sig = await req('/discord/interactions', { method: 'POST', body: '{"type":1}' });
    check('서명 없는 인터랙션 → 401 (fail-closed)', sig.status === 401, `status=${sig.status}`);

    console.log('\n[4] 응답 압축 (이그레스 요금에 직결)');
    const rawHome = await get('/');
    const gzHome = await getGz('/');
    check('HTML gzip 적용', gzHome.headers['content-encoding'] === 'gzip');
    check('HTML 압축 후 절반 이하', gzHome.body.length < rawHome.body.length / 2,
      `${rawHome.body.length} → ${gzHome.body.length}`);
    check('압축 응답에 Vary: Accept-Encoding',
      String(gzHome.headers['vary'] ?? '').toLowerCase().includes('accept-encoding'));
    check('gzip을 못 받는 클라이언트에는 무압축으로',
      rawHome.status === 200 && rawHome.headers['content-encoding'] === undefined,
      `encoding=${rawHome.headers['content-encoding']}`);
    check('압축 해제 결과가 무압축 응답과 동일', Buffer.compare(decoded(gzHome), rawHome.body) === 0);
    console.log(`        로비 ${rawHome.body.length}B → ${gzHome.body.length}B`);

    console.log('\n[5] 전역 CSS·JS (캐시되는 외부 파일)');
    for (const [route, mime] of [['/app.css', 'text/css'], ['/app.js', 'text/javascript']]) {
      const r = await getGz(route);
      check(`${route} → 200 (${r.body.length}B gzip)`, r.status === 200, `status=${r.status}`);
      check(`${route} content-type ${mime}`, String(r.headers['content-type'] ?? '').includes(mime));
      check(`${route} 장기 캐시 헤더`, String(r.headers['cache-control'] ?? '').includes('max-age=604800'));
    }
    const appJs = decoded(await getGz('/app.js')).toString('utf8');
    check('app.js에 폴링 헬퍼 포함', appJs.includes('casinoPoll'));
    check('app.js의 자산 버전 자리표시자가 치환됨', !appJs.includes('__ASSET_V__'));
    // 게임 스크립트가 실행 시점에 casinoPoll을 쓰므로 app.js가 <head>에서 먼저 와야 한다
    const pokerHtml = decoded(await getGz('/games/poker')).toString('utf8');
    check('게임 페이지가 로그인 없으면 리다이렉트(본문 없음)', pokerHtml.length === 0 || !pokerHtml.includes('casinoPoll('));

    console.log('\n[6] 정적 자산 (압축 경유 후 바이트 일치)');
    for (const f of readdirSync(join(ROOT, 'public', 'sfx'))) {
      const r = await getGz(`/sfx/${f}`);
      const orig = readFileSync(join(ROOT, 'public', 'sfx', f));
      const gz = r.headers['content-encoding'] === 'gzip';
      check(`/sfx/${f} ${gz ? `압축 ${orig.length}→${r.body.length}B` : '무압축(이득 없음)'}`,
        Buffer.compare(decoded(r), orig) === 0);
    }
    const cardFiles = readdirSync(join(ROOT, 'public', 'cards'));
    // 앞면 52장 + 뒷면 2종(남색·마룬)
    check(`카드 54장 존재 (실제 ${cardFiles.length}장)`, cardFiles.length === 54);
    let cardOk = 0;
    for (const f of cardFiles) {
      const r = await getGz(`/cards/${f}`);
      if (Buffer.compare(decoded(r), readFileSync(join(ROOT, 'public', 'cards', f))) === 0) cardOk++;
    }
    check(`카드 SVG 전량 무결 (${cardOk}/${cardFiles.length})`, cardOk === cardFiles.length);

    console.log('\n[7] 경로 조작 차단');
    for (const p of ['/sfx/../../.env', '/cards/../../package.json', '/sfx/%2e%2e%2f.env', '/cards/..%2f..%2fpackage.json']) {
      const r = await get(p);
      check(`${p} → 200 아님`, r.status !== 200, `status=${r.status}`);
    }

    console.log('\n[8] DB 자동 생성');
    check('빈 볼륨에 data.db 생성', readdirSync(dataDir).includes('data.db'),
      readdirSync(dataDir).join(','));

    /* 게임끼리 CSS 클래스 이름이 겹치는지.
       app.css는 게임 전부가 한 파일을 공유하므로, 나중에 정의한 쪽이 앞의 것을 조용히 덮는다.
       바카라 구슬판에 .bead/.bead-row를 썼다가 이미 같은 이름을 쓰던 사다리 출목표가
       원형 19px 배지로 뭉개져 카드 밖으로 튀어나온 적이 있다 — 화면을 열어보기 전에는 모른다.
       미디어 쿼리 안의 재정의는 정상적인 반응형 패턴이므로 최상위 규칙만 본다. */
    console.log('\n[9] CSS 클래스 중복 정의');
    {
      const raw = readFileSync(join(process.cwd(), 'src', 'web', 'assets', 'app.css'), 'utf8');
      /* 주석을 먼저 없앤다. 이게 없으면 아래 셀렉터 정규식의 [^{}@]+? 가 주석까지
         함께 빨아들여, 주석 바로 뒤에 오는 규칙이 "주석+셀렉터"가 되어 단일 클래스
         판정을 통과하지 못하고 조용히 건너뛰어진다. 이 코드베이스는 규칙 앞에 주석을
         붙이는 게 지배적 스타일이라 실측으로 대상의 26%(69건)를 놓치고 있었고,
         그 사이에 실제 중복 두 건(.bj-seats · .ht-who)이 숨어 있었다. */
      const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
      // 미디어 쿼리 블록을 통째로 들어낸 뒤 남은 최상위 규칙만 센다
      const topLevel = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
      const seen = new Map<string, number>();
      for (const m of topLevel.matchAll(/(^|\})\s*([^{}@]+?)\s*\{/g)) {
        for (const sel of m[2].split(',')) {
          const s = sel.trim();
          // 단일 클래스 선택자만 (.a.b, .a .b 같은 조합은 의도적 재정의인 경우가 많다)
          if (!/^\.[a-z][a-z0-9-]*$/i.test(s)) continue;
          seen.set(s, (seen.get(s) ?? 0) + 1);
        }
      }
      const dup = [...seen].filter(([, n]) => n > 1).map(([s, n]) => `${s}×${n}`);
      check('같은 클래스를 최상위에서 두 번 정의하지 않음', dup.length === 0, dup.join(' '));
    }

    /* 딜링 연출이 자기 마지막 장을 잘라먹는지.
       카드마다 복제본을 날리는 구조인데, 마지막 장의 콜백에서 showAllCards()를 부르면
       그 순간 아직 날고 있던 복제본까지 걷어내서 끝의 두 장이 제자리에 툭 생겨난다.
       포커 플립·바카라에서 실제로 그랬고, 화면을 눈으로 봐도 "왜 끊기지" 정도로만 보였다.
       연출을 닫는 일은 마지막 장이 도착한 뒤(별도 타이머)에만 해야 한다. */
    console.log('\n[10] 딜링 연출 — 마지막 장 잘림');
    for (const g of ['poker', 'baccarat']) {
      const src = readFileSync(join(process.cwd(), 'src', 'web', 'games', `${g}.ts`), 'utf8');
      const loop = src.match(/slots\.forEach\(function\(s, n\)\{[\s\S]*?\}, SHUFFLE_MS \+ n \* STEP\)\);/);
      check(`${g} — 카드별 콜백이 연출을 닫지 않음`,
        loop != null && !loop[0].includes('showAllCards'),
        loop ? '콜백 안에 showAllCards 호출이 있다' : '딜링 루프를 못 찾음');
    }
  } finally {
    child.kill();
    await new Promise(r => setTimeout(r, 300));
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 잠긴 파일은 OS가 정리 */ }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`통과 ${pass} · 실패 ${failures.length}`);
  if (failures.length) {
    console.log('\n실패 항목:');
    failures.forEach(f => console.log(`  · ${f}`));
    process.exitCode = 1;
  } else {
    console.log('배포 전 점검 통과.');
  }
}

main();
