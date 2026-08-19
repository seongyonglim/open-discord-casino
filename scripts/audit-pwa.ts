/* 앱 설치 감사 — 매니페스트·아이콘·서비스워커.
 *
 * ── 무엇이 걱정인가
 * 서비스워커는 이 프로젝트에서 되돌리기가 가장 어려운 종류의 코드다. 잘못 캐시하면
 * 서버를 고쳐도 그 브라우저에는 낡은 화면이 남는다. 그리고 이 서비스의 화면에는
 * 잔액과 판돈이 박혀 있으므로, 낡은 화면은 "포인트가 사라졌다"로 보인다.
 *
 * 그래서 여기서는 서비스워커를 문자열로 훑지 않는다. 실제로 실행해서 요청을 던져 보고
 * 무엇이 캐시에 들어가는지 본다 — isStatic 에 경로 하나를 잘못 더하면 그 순간 잡힌다.
 *
 * 아이콘도 파일이 있는지만 보지 않는다. PNG 머리를 읽어 실제 크기를 확인한다:
 * 매니페스트에 512 라고 적고 192 를 담아도 화면에서는 안 보이고, 안드로이드 런처에서만
 * 뭉개져 보인다.
 *
 * 안전: DB_PATH 를 임시 디렉터리로 못 박는다.
 */
if (!process.env.DB_PATH) {
  const os = require('node:os'), path = require('node:path'), fsx = require('node:fs');
  process.env.DB_PATH = fsx.mkdtempSync(path.join(os.tmpdir(), 'casino-pwa-'));
}

import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.AUDIT_PORT ?? 8214);
let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}
function section(s: string): void { console.log('\n' + s); }

interface Res { status: number; type: string; cache: string; body: string }
function get(path: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET' }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        type: String(res.headers['content-type'] ?? ''),
        cache: String(res.headers['cache-control'] ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    r.on('error', reject);
    r.end();
  });
}

/* PNG 머리에서 실제 크기를 읽는다. 서명 8바이트 + 길이 4 + 'IHDR' 4 다음이 폭·높이다. */
function pngSize(file: string): { w: number; h: number } | null {
  const b = readFileSync(file);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  if (b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/* ── 서비스워커를 실제로 돌려 본다 ───────────────────────────────────────
   브라우저가 아니라 여기서 돌린다. self·caches·fetch 를 흉내 낸 뒤 워커 원본을
   실행하고, 요청을 던져 무엇이 캐시에 들어가는지 본다. 문자열로 훑으면 규칙이
   맞는지가 아니라 "그렇게 적혀 있는지"만 확인하게 된다. */
interface SwHarness {
  install(): Promise<string[]>;
  /** 요청을 한 번 던진다. 돌려주는 값: 워커가 응답을 가로챘는지와 그 결과. */
  hit(url: string, mode: 'navigate' | 'cors'): Promise<{ handled: boolean; from: string }>;
  cached(): string[];
}

function loadSw(src: string, origin: string): SwHarness {
  const store = new Map<string, string>();   // URL → 어디서 왔는가('net' | 'precache')
  let netFails = false;

  const mkRes = (tag: string) => ({
    ok: true, status: 200, __tag: tag,
    clone() { return mkRes(tag); },
  });
  const cache = {
    add: async (u: string) => { if (netFails) throw new Error('net'); store.set(String(u), 'precache'); },
    put: async (req: any, res: any) => { store.set(typeof req === 'string' ? req : req.url, res.__tag); },
    keys: async () => [...store.keys()].map(url => ({ url })),
  };
  const caches = {
    open: async () => cache,
    keys: async () => ['od-static-test'],
    delete: async () => true,
    match: async (req: any) => {
      const u = typeof req === 'string' ? new URL(req, origin).href : req.url;
      return store.has(u) ? mkRes('cache') : undefined;
    },
  };
  const fetchFn = async (req: any) => {
    if (netFails) throw new Error('오프라인');
    return mkRes('net');
  };

  const listeners: Record<string, Function> = {};
  const self_: any = {
    addEventListener: (k: string, fn: Function) => { listeners[k] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    location: { origin },
    registration: { unregister: async () => true },
  };

  // eslint-disable-next-line no-new-func
  new Function('self', 'caches', 'fetch', 'Response', 'URL', src)(
    self_, caches, fetchFn, class { constructor(_b: any, _i: any) { } } as any, URL);

  return {
    async install() {
      const waits: Promise<any>[] = [];
      listeners.install?.({ waitUntil: (p: Promise<any>) => waits.push(p) });
      await Promise.all(waits);
      return [...store.keys()];
    },
    async hit(url, mode) {
      const abs = new URL(url, origin).href;
      let taken: Promise<any> | null = null;
      listeners.fetch?.({
        request: { url: abs, method: 'GET', mode },
        respondWith: (p: Promise<any>) => { taken = p; },
      });
      if (!taken) return { handled: false, from: '통과' };
      const r = await (taken as Promise<any>);
      return { handled: true, from: r?.__tag ?? '알수없음' };
    },
    cached: () => [...store.keys()],
  };
}

async function main(): Promise<void> {
  const { startWebServer } = require('../src/web/server') as typeof import('../src/web/server');
  process.env.PORT = String(PORT);
  startWebServer();
  await new Promise(r => setTimeout(r, 600));

  section('[1] 매니페스트');
  const mres = await get('/manifest.webmanifest');
  ck('200 으로 나온다', mres.status === 200, String(mres.status));
  ck('매니페스트 MIME 이다', mres.type.startsWith('application/manifest+json'), mres.type);
  let m: any = null;
  try { m = JSON.parse(mres.body); } catch { /* 아래에서 잡힌다 */ }
  ck('JSON 으로 읽힌다', m !== null);
  if (m) {
    /* 크롬이 설치 가능 여부를 판정할 때 보는 값들이다. 하나라도 빠지면 설치 배너가
       안 뜨고, TWA 로 APK 를 만들 때도 Bubblewrap 이 거부한다. */
    ck('이름이 있다', typeof m.name === 'string' && m.name.length > 0, m.name);
    ck('시작 화면이 있다', typeof m.start_url === 'string' && m.start_url.startsWith('/'), m.start_url);
    ck('scope 가 뿌리다', m.scope === '/', m.scope);
    ck('앱처럼 뜬다 (standalone)', m.display === 'standalone', m.display);
    ck('배경색·테마색이 있다',
      typeof m.background_color === 'string' && typeof m.theme_color === 'string');
    const sizes = (m.icons ?? []).map((i: any) => `${i.sizes}/${i.purpose}`);
    ck('192 아이콘이 있다', sizes.includes('192x192/any'), sizes.join(' '));
    ck('512 아이콘이 있다', sizes.includes('512x512/any'), sizes.join(' '));
    /* 없으면 안드로이드 런처가 흰 배경을 잘라내 검은 테가 생긴다 — 화면에서는 안 보이고
       폰에 깔고 나서야 드러나는 종류의 문제다. */
    ck('마스커블 아이콘이 있다', sizes.includes('512x512/maskable'), sizes.join(' '));
  }

  section('[2] 아이콘 — 적힌 크기와 실제 크기가 같은가');
  {
    const want: [string, number][] = [
      ['icon-192.png', 192], ['icon-512.png', 512],
      ['icon-maskable-512.png', 512], ['apple-touch-icon.png', 180],
    ];
    for (const [name, size] of want) {
      const p = join(process.cwd(), 'public', 'icon', name);
      if (!existsSync(p)) { ck(`${name} 이 있다`, false, '없음 — npx tsx scripts/bake-icons.ts'); continue; }
      const d = pngSize(p);
      ck(`${name} 이 ${size}×${size} 다`, d?.w === size && d?.h === size,
        d ? `${d.w}×${d.h}` : 'PNG 가 아니다');
      /* 빈 그림이 담기면 몇 백 바이트로 나온다. 크기만 맞고 내용이 없는 경우를 거른다. */
      ck(`${name} 이 비어 있지 않다`, statSync(p).size > 1000, `${statSync(p).size}B`);
      const r = await get(`/icon/${name}`);
      ck(`${name} 이 서빙된다`, r.status === 200 && r.type === 'image/png', `${r.status} ${r.type}`);
    }
    /* 목록에 없는 파일은 나가면 안 된다 — public/icon 이 통째로 열려 있으면 안 된다. */
    const bad = await get('/icon/../../package.json');
    ck('허용 목록 밖 파일은 안 나간다', bad.status === 404, String(bad.status));
  }

  section('[3] 서비스워커 라우트');
  const sres = await get('/sw.js');
  ck('200 으로 나온다', sres.status === 200, String(sres.status));
  ck('자바스크립트 MIME 이다', sres.type.startsWith('text/javascript'), sres.type);
  /* 여기에 캐시를 걸면 브라우저가 새 워커를 확인하러 왔을 때 낡은 파일을 받는다 —
     되돌리기(SW=off)가 안 먹는다. */
  ck('캐시하지 않는다', sres.cache.includes('no-cache'), sres.cache);
  ck('자산 버전이 채워졌다', !sres.body.includes('__ASSET_V__'));
  const ores = await get('/offline');
  ck('오프라인 화면이 있다', ores.status === 200 && ores.body.includes('연결이 끊겼습니다'));
  /* 이 화면만은 캐시에 남는다. 사람 정보가 들어가면 그 사람 것이 남는다. */
  ck('오프라인 화면에 사람 정보가 없다',
    !/잔액|포인트|__MEID__|balance/.test(ores.body));

  section('[4] 서비스워커를 실제로 돌려 본다');
  {
    const origin = `http://127.0.0.1:${PORT}`;
    const sw = loadSw(sres.body, origin);
    const pre = await sw.install();
    ck('설치가 끝난다', pre.length > 0, `${pre.length}개`);
    ck('미리 받는 목록에 오프라인 화면이 있다', pre.some(u => u.endsWith('/offline')));

    /* 여기가 이 감사의 핵심이다. 페이지와 API 는 워커가 손대면 안 된다 —
       가로채지 않아야(handled=false) 브라우저가 평소대로 처리한다. */
    for (const p of ['/', '/lobby', '/leaderboard', '/notices', '/achievements',
      '/games/holdem', '/games/crash', '/admin']) {
      const r = await sw.hit(p, 'cors');
      ck(`페이지를 캐시하지 않는다 ${p}`, !r.handled, r.from);
    }
    for (const p of ['/api/games/crash/state', '/api/chat?after=0', '/api/achievements',
      '/auth/login', '/auth/callback?code=x']) {
      const r = await sw.hit(p, 'cors');
      ck(`API·인증을 캐시하지 않는다 ${p}`, !r.handled, r.from);
    }

    /* 안 바뀌는 것만 가로챈다. 첫 요청은 네트워크로 가고 두 번째는 캐시에서 나와야
       재전송이 없어진다 — 그 순서가 곧 "받아 두고 다시 안 받는다"이다. */
    for (const p of ['/cards/AS.svg', '/sfx/chip.mp3', '/icon/icon-192.png', '/favicon.svg']) {
      const first = await sw.hit(p, 'cors');
      const second = await sw.hit(p, 'cors');
      ck(`정적 자산은 받아 두고 다시 안 받는다 ${p}`,
        first.handled && first.from === 'net' && second.from === 'cache',
        `${first.from} → ${second.from}`);
    }

    /* 화면 이동은 언제나 네트워크다. 캐시에서 페이지를 꺼내 주면 지난 잔액이 뜬다. */
    const nav = await sw.hit('/games/holdem', 'navigate');
    ck('화면 이동은 네트워크로 간다', nav.handled && nav.from === 'net', nav.from);
    const after = sw.cached();
    ck('이동한 페이지가 캐시에 안 남는다',
      !after.some(u => /\/games\/|\/leaderboard|\/notices/.test(u)),
      after.filter(u => /\/games\/|\/leaderboard/.test(u)).join(' '));
  }

  section('[5] 되돌리기 — SW=off');
  {
    process.env.SW = 'off';
    const off = await get('/sw.js');
    delete process.env.SW;
    ck('SW=off 면 다른 조각이 나간다', off.body.includes('SW=off'), off.body.slice(0, 40));
    /* 스스로 물러나야 한다. 이 두 줄이 없으면 이미 깔린 워커가 그대로 남아,
       서버를 되돌려도 그 브라우저는 안 낫는다. */
    ck('스스로 등록을 지운다', off.body.includes('unregister'));
    ck('캐시도 비운다', off.body.includes('caches.delete'));
    ck('되돌린 뒤에는 원래 워커가 다시 나온다', (await get('/sw.js')).body.includes('od-static-'));
  }

  section('[6] 화면 머리말');
  {
    const page = await get('/');
    ck('매니페스트를 가리킨다', page.body.includes('rel="manifest"'));
    ck('테마색이 있다', /<meta name="theme-color" content="#[0-9a-f]{6}">/.test(page.body));
    ck('iOS 홈 화면 아이콘이 있다', page.body.includes('rel="apple-touch-icon"'));
    /* 매니페스트의 색과 CSS 의 --bg 가 갈라지면 앱을 열 때 흰 띠가 번쩍인다.
       두 곳에 적힌 값이라 갈라질 수 있으므로 여기서 묶어 둔다. */
    const css = readFileSync(
      join(process.cwd(), 'src', 'web', 'assets', 'css', '01-base.css'), 'utf8');
    const bg = css.match(/--bg:\s*(#[0-9a-fA-F]{6})/)?.[1];
    ck('테마색이 CSS 의 --bg 와 같다', !!bg && m?.theme_color === bg,
      `매니페스트 ${m?.theme_color} vs CSS ${bg}`);
  }

  section('[7] 등록 코드');
  {
    const app = readFileSync(join(process.cwd(), 'src', 'web', 'assets', 'app.js'), 'utf8');
    ck('app.js 가 워커를 등록한다', /navigator\.serviceWorker\.register\('\/sw\.js'/.test(app));
    /* 등록이 실패해도 화면은 살아 있어야 한다 — 사설 인증서, 시크릿 창, 회사 정책 등
       워커가 안 깔리는 사정은 여러 가지이고 그중 무엇도 게임을 막을 이유가 아니다. */
    ck('등록 실패를 삼킨다', /register\([^)]*\)[\s\S]{0,80}?\.catch\(/.test(app));
    ck('첫 화면을 기다렸다가 등록한다', /addEventListener\('load'[\s\S]{0,140}?serviceWorker\.register/.test(app));
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`통과 ${pass} · 실패 ${fail}`);
  console.log('크롬 자신의 설치 판정은 따로 본다 — npx tsx scripts/check-installable.ts');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
