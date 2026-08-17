/* 폰 화면 점검 — 게임마다 "한 화면에 다 들어가는가"를 잰다.
 *
 * ── 왜 도구로 만드는가
 * 게임 일곱 개를 세로·가로로 보면 열네 장이다. 눈으로 보면 놓친다 — 실제로 홀덤 좌석의
 * 겹침을 잘못 읽어 없는 문제를 보고한 적이 있고, 반대로 가로에서 테이블이 잘리는 것을
 * 스크린샷을 찍고 나서야 알았다. 숫자로 재면 둘 다 안 생긴다.
 *
 * ── 무엇을 합격으로 보는가
 * 1. 가로로 넘치지 않는다 — 폰에서 좌우로 밀리는 화면은 그 자체로 고장이다.
 * 2. 게임과 조작부가 첫 화면에 다 들어간다. .game-main 은 판(펠트·보드)과 조작부를
 *    함께 담는 칸이라, 그 아래끝이 하단 탭바 위에 있으면 "스크롤 없이 게임이 된다"가 된다.
 * 3. 하단 탭바가 화면 바닥에 정확히 붙어 있다.
 *
 * ── 왜 감사 체인에 안 넣는가
 * 크롬이 있어야 하고 실제 레이아웃 엔진이 필요하다. 크롬 업데이트로 몇 픽셀이 달라져
 * 감사가 빨개지면 감사 전체를 못 믿게 된다. check-installable 과 같은 이유다.
 *
 * 쓰는 법:  npx tsx scripts/check-mobile.ts            (로컬 8300)
 *          npx tsx scripts/check-mobile.ts https://odcasino.kro.kr
 */
import { execFile, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(p => { try { return existsSync(p); } catch { return false; } });

if (!CHROME) { console.error('크롬이 없다 — 이 점검은 건너뛴다'); process.exit(0); }

const BASE = (process.argv[2] ?? 'http://localhost:8300').replace(/\/$/, '');
const PORT = Number(process.env.CDP_PORT ?? 9347);
const prof = mkdtempSync(join(tmpdir(), 'casino-mob-'));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/* 갤럭시 S23 기준. 폭이 가장 좁은 축에 드는 기기라, 여기서 들어가면 대부분 들어간다. */
const SIZES = [
  { name: '세로', w: 412, h: 915 },
  { name: '가로', w: 915, h: 412 },
];
const GAMES = ['holdem', 'baccarat', 'blackjack', 'poker', 'mines', 'graph', 'ladder'];
const PLAIN = ['/', '/leaderboard', '/achievements', '/notices'];

let pass = 0, fail = 0;
function ck(name: string, ok: boolean, extra = ''): void {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

let child: ChildProcess | null = null;

/* 화면 안에서 돌 검사식. 문자열로 넘겨 Runtime.evaluate 로 실행한다. */
const PROBE = `(() => {
  const r = el => el ? el.getBoundingClientRect() : null;
  const nav = r(document.querySelector('header nav'));
  const main = r(document.querySelector('.game-main'));
  const de = document.documentElement;
  /* 가로로 넘치는 요소를 찾는다.
     잘라 주는 조상이 있으면 넘어간다. 스크롤 칸(랭킹표) 안에서 미는 것은 의도된
     것이고, overflow:hidden 안쪽은 애초에 화면에 안 나온다 — 블랙잭의 딜러 앞
     반원선(.bj-arc)이 그렇다. 폭이 132%라 상자만 보면 화면을 넘지만 테이블이
     잘라내므로 보이지 않는다. hidden 을 안 세었더니 그것을 고장으로 잡았다. */
  const CLIP = ['auto', 'scroll', 'hidden', 'clip'];
  const over = [];
  for (const el of document.querySelectorAll('body *')) {
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) continue;
    if (b.right <= innerWidth + 1 && b.left >= -1) continue;
    let p = el.parentElement, inScroller = false;
    while (p && p !== document.body) {
      if (CLIP.includes(getComputedStyle(p).overflowX)) { inScroller = true; break; }
      p = p.parentElement;
    }
    if (inScroller) continue;
    over.push((el.className || el.tagName) + ' ' + Math.round(b.left) + '~' + Math.round(b.right));
    if (over.length > 3) break;
  }
  /* 판이 찌그러졌는지. 높이만 재면 "판을 폭 100px 짜리 막대로 눌러 놓고" 도 통과한다 —
     실제로 가로 배치를 넣었을 때 flex 가 홀덤 테이블을 그렇게 만들었고, 높이 검사는
     통과했다. 그림을 보고서야 알았다. 그래서 폭도 같이 본다. */
  const el = document.querySelector('.game-main');
  const board = el && el.firstElementChild;
  const bb = board ? board.getBoundingClientRect() : null;
  /* 조작부도 같이 본다. 판만 지켰더니 지뢰찾기 조작부가 185px 로 눌려 안의 글자들이
     서로 겹쳤다 — 판 검사는 초록이었다. 눌린 칸은 scrollWidth 가 실제 폭보다 크다. */
  const ctl = el && el.lastElementChild !== board ? el.lastElementChild : null;
  const cb = ctl ? ctl.getBoundingClientRect() : null;
  return {
    /* 로그인 여부. 게임 화면은 로그인해야 열리므로, 안 한 채로 재면 모든 항목이
       "없음"으로 나와 전부 실패처럼 보인다 — 운영 주소로 돌렸다가 42개가 빨갛게
       나왔는데 전부 이 이유였다. 고장이 아니라 잴 수 없는 상태다. */
    loggedIn: !!window.__MEID__,
    vw: innerWidth, vh: innerHeight,
    scrollW: de.scrollWidth,
    navBottom: nav ? Math.round(nav.bottom) : null,
    navTop: nav ? Math.round(nav.top) : null,
    mainBottom: main ? Math.round(main.bottom) : null,
    mainTop: main ? Math.round(main.top) : null,
    boardW: bb ? Math.round(bb.width) : null,
    boardH: bb ? Math.round(bb.height) : null,
    ctlW: cb ? Math.round(cb.width) : null,
    ctlNeed: ctl ? Math.round(ctl.scrollWidth) : null,
    over,
  };
})()`;

async function main(): Promise<void> {
  child = execFile(CHROME!, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', 'about:blank',
  ]);

  let ver: any = null;
  for (let i = 0; i < 40 && !ver; i++) {
    await sleep(250);
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { /* 아직 */ }
  }
  if (!ver) throw new Error('크롬 디버깅 포트가 안 열렸다');

  const tab: any = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('소켓 실패')); });

  let id = 0;
  const waiting = new Map<number, (m: any) => void>();
  let loaded = false;
  ws.onmessage = (e: MessageEvent) => {
    const m = JSON.parse(String(e.data));
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); }
    else if (m.method === 'Page.loadEventFired') loaded = true;
  };
  const send = (method: string, params: object = {}): Promise<any> => new Promise(res => {
    const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
  });

  await send('Page.enable');
  await send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36'
      + ' (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
  });

  const go = async (url: string): Promise<void> => {
    loaded = false;
    await send('Page.navigate', { url });
    for (let i = 0; i < 40 && !loaded; i++) await sleep(200);
    await sleep(1800);   // 폴링이 첫 상태를 받아 판을 그릴 때까지
  };
  const probe = async (): Promise<any> =>
    (await send('Runtime.evaluate', { expression: PROBE, returnByValue: true })).result?.result?.value;

  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
  if (BASE.includes('localhost')) await go(`${BASE}/dev/login`);

  /* 로그인이 없으면 게임 화면 자체가 안 열린다. 그 상태로 재면 "판이 없다"가 일곱 게임
     × 두 방향으로 쏟아져 고장처럼 보인다 — 운영 주소로 돌렸다가 실제로 그랬다.
     잴 수 없는 것과 틀린 것은 다르므로 여기서 갈라 말하고 끝낸다.
     운영에서 재려면 그 브라우저에 로그인 세션이 있어야 한다(디스코드 OAuth 라
     이 스크립트가 대신 할 수 없다) — 로컬 미리보기로 재는 것이 정상 경로다. */
  await go(`${BASE}/games/holdem`);
  const first = await probe();
  if (!first?.loggedIn) {
    console.log(`\n로그인이 없어 게임 화면을 열 수 없다 — 잴 것이 없다.`);
    console.log(`  ${BASE} 은 디스코드 로그인이 필요하다.`);
    console.log(`  로컬 미리보기(casino-real, 8300)로 돌리면 /dev/login 으로 들어가 잰다.\n`);
    ws.close();
    return;
  }

  for (const size of SIZES) {
    console.log(`\n[${size.name}] ${size.w}×${size.h}`);
    await send('Emulation.setDeviceMetricsOverride', {
      width: size.w, height: size.h, deviceScaleFactor: 2, mobile: true,
    });

    for (const g of GAMES) {
      await go(`${BASE}/games/${g}`);
      const m = await probe();
      if (!m) { ck(`${g} — 측정 실패`, false); continue; }
      ck(`${g} 가로로 안 넘친다`, m.scrollW <= m.vw + 1 && m.over.length === 0,
        `scrollW ${m.scrollW} > ${m.vw}` + (m.over.length ? ' · ' + m.over.join(' / ') : ''));
      ck(`${g} 탭바가 화면 바닥에`, m.navBottom !== null && Math.abs(m.navBottom - m.vh) <= 2,
        `${m.navBottom} vs ${m.vh}`);
      /* 판과 조작부가 한 화면에. 이것이 "게임이 스크롤 없이 되는가"다. */
      ck(`${g} 판+조작부가 한 화면에`, m.mainBottom !== null && m.navTop !== null && m.mainBottom <= m.navTop,
        m.mainBottom !== null ? `${m.mainBottom - (m.navTop ?? 0)}px 넘침 (판 ${m.mainTop}~${m.mainBottom} · 탭바 ${m.navTop})` : '.game-main 없음');
      /* 눌러서 맞춘 것이 아닌지. 화면 폭의 3할도 안 되는 판은 게임이 아니라 막대다. */
      const 최소폭 = Math.round(m.vw * 0.3);
      ck(`${g} 판이 찌그러지지 않았다`, m.boardW !== null && m.boardW >= 최소폭,
        `판 폭 ${m.boardW}px < ${최소폭}px`);
      /* 조작부도 같이 본다. 눌린 칸은 안의 내용이 들어갈 자리를 못 얻어 겹친다 —
         scrollWidth 가 실제 폭보다 크면 그 상태다. */
      if (m.ctlW !== null) {
        ck(`${g} 조작부가 눌리지 않았다`, m.ctlW >= 280 && m.ctlNeed <= m.ctlW + 2,
          `폭 ${m.ctlW}px · 필요 ${m.ctlNeed}px`);
      }
    }

    for (const p of PLAIN) {
      await go(BASE + p);
      const m = await probe();
      if (!m) { ck(`${p} — 측정 실패`, false); continue; }
      ck(`${p} 가로로 안 넘친다`, m.scrollW <= m.vw + 1 && m.over.length === 0,
        `scrollW ${m.scrollW} > ${m.vw}` + (m.over.length ? ' · ' + m.over.join(' / ') : ''));
    }
  }

  ws.close();
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`통과 ${pass} · 실패 ${fail}`);
  process.exitCode = fail ? 1 : 0;
}

main()
  .catch(e => { console.error(e.message); process.exitCode = 1; })
  .finally(async () => {
    child?.kill();
    await sleep(400);
    try { rmSync(prof, { recursive: true, force: true }); } catch { /* 잠겨 있으면 둔다 */ }
  });
