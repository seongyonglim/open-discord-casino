/* 화면을 상태별로 찍어 둔다 — 검사가 아니라 눈으로 보기 위한 도구.
 *
 * check-states 는 통과·실패만 말하고 그림은 곁다리로 남긴다. 그런데 "이게 앱 화면으로
 * 괜찮은가" 는 숫자로 안 나온다. 방향과 상태를 정해 놓고 그 조합을 한 번에 찍는다.
 *
 *   npx tsx scripts/shot.ts                 # 세로 (기본)
 *   npx tsx scripts/shot.ts 가로
 *   npx tsx scripts/shot.ts 세로 http://localhost:8300
 */
import { execFile, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  '/usr/bin/google-chrome',
].find(p => { try { return existsSync(p); } catch { return false; } });
if (!CHROME) { console.error('크롬이 없다'); process.exit(0); }

const 방향 = (process.argv[2] ?? '세로');
const BASE = (process.argv[3] ?? 'http://localhost:8300').replace(/\/$/, '');
const [W, H] = 방향 === '가로' ? [915, 412] : [412, 915];
const OUT = join(process.cwd(), '.states', 방향);
const PORT = Number(process.env.CDP_PORT ?? 9393);
const prof = mkdtempSync(join(tmpdir(), 'casino-shot-'));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/* 찍을 상태. act 는 화면 안에서 도는 코드고, 없으면 들어간 그대로 찍는다. */
const STATES: { name: string; act?: string }[] = [
  { name: '1-기본' },
  { name: '2-예측선택', act: `(()=>{const b=document.querySelectorAll('.predict-row button');
      if(b[0])b[0].click(); if(b[2])b[2].click(); return 1})()` },
  { name: '3-설정', act: `(()=>{const g=document.querySelector('.ig-gear')||document.querySelector('.ig-people');
      if(g)g.click(); return 1})()` },
  { name: '4-참가인원', act: `(()=>{const s=document.querySelector('.ig-set');
      if(s&&s.classList.contains('on')){const g=document.querySelector('.ig-gear'); if(g)g.click();}
      const b=document.querySelector('.ig-livebar')||document.querySelector('.ig-people');
      if(b)b.click(); return 1})()` },
  { name: '5-채팅', act: `(()=>{const d=document.querySelector('.chat-dock');
      const sc=document.querySelector('.ig-scrim'); if(sc)sc.click();
      const c=document.querySelector('.ig-chat');
      if(c&&!(d&&d.classList.contains('on'))) c.click(); return 1})()` },
];

let child: ChildProcess | null = null;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  child = execFile(CHROME!, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${prof}`, '--no-first-run', '--hide-scrollbars', 'about:blank',
  ]);
  let ver: any = null;
  for (let i = 0; i < 40 && !ver; i++) {
    await sleep(250);
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { /* 아직 */ }
  }
  if (!ver) throw new Error('크롬이 안 떴다');

  const tab: any = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('소켓')); });
  let id = 0; const waiting = new Map<number, (m: any) => void>(); let loaded = false;
  ws.onmessage = (e: MessageEvent) => {
    const m = JSON.parse(String(e.data));
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); }
    else if (m.method === 'Page.loadEventFired') loaded = true;
  };
  const send = (method: string, params: object = {}): Promise<any> => new Promise(res => {
    const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
  });

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',
    { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile' });

  const go = async (u: string) => {
    loaded = false; await send('Page.navigate', { url: u });
    for (let i = 0; i < 40 && !loaded; i++) await sleep(200);
    await sleep(1900);
  };
  const evalIn = async (e: string) =>
    (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))
      .result?.result?.value;

  await go(`${BASE}/dev/login`);
  await go(`${BASE}/games/ladder`);

  /* 껍데기가 그 방향으로 실제로 켜졌는지 먼저 본다 — 안 켜졌으면 찍어도 헛것이다 */
  const mode = await evalIn(`document.documentElement.className.match(/ig-(port|land)/)?.[1] ?? 'off'`);
  console.log(`${W}x${H} · 껍데기 ig-${mode}`);

  for (const st of STATES) {
    if (st.act) { await evalIn(st.act); await sleep(1500); }
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s.result?.data) {
      writeFileSync(join(OUT, st.name + '.png'), Buffer.from(s.result.data, 'base64'));
      console.log('  ' + st.name);
    }
  }
  ws.close();
  console.log('그림: ' + OUT);
}

main()
  .catch(e => { console.error(e.message); process.exitCode = 1; })
  .finally(async () => {
    child?.kill(); await sleep(400);
    try { rmSync(prof, { recursive: true, force: true }); } catch { /* 잠겨 있으면 둔다 */ }
  });
