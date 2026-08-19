/* 크롬에게 직접 묻는다: 이 사이트를 앱으로 설치할 수 있나.
 *
 * ── 왜 audit-pwa 와 따로 두는가
 * audit-pwa 는 우리가 정한 규칙을 지키는지 본다. 이 스크립트는 크롬이 자기 기준으로
 * 판정하게 한다. 둘은 다른 질문이고, 크롬 기준은 우리가 못 정한다 — 버전이 오르면
 * 조건이 바뀔 수도 있다. 그래서 감사 체인에는 안 넣는다: 크롬이 깔려 있어야 하고,
 * 크롬 업데이트 때문에 감사가 빨개지면 감사를 못 믿게 된다.
 *
 * ── 왜 beforeinstallprompt 로 안 보는가
 * 그 이벤트는 임베드된 브라우저에서는 안 뜰 수 있다. 안 떴다고 설치가 안 되는 것이
 * 아니므로 판단 근거가 못 된다. CDP 의 Page.getInstallabilityErrors 는 크롬이 스스로
 * 매긴 결과라 "왜 안 되는지"까지 말해 준다.
 *
 * 쓰는 법:
 *   npx tsx scripts/check-installable.ts                 (로컬 8300)
 *   npx tsx scripts/check-installable.ts https://odcasino.kro.kr/
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

if (!CHROME) {
  console.error('크롬이나 엣지가 없다 — 이 확인은 건너뛴다 (audit-pwa 는 그대로 돈다)');
  process.exit(0);
}

const TARGET = process.argv[2] ?? 'http://localhost:8300/';
const PORT = Number(process.env.CDP_PORT ?? 9333);
const prof = mkdtempSync(join(tmpdir(), 'casino-cdp-'));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let child: ChildProcess | null = null;

async function main(): Promise<void> {
  child = execFile(CHROME!, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check',
    'about:blank',
  ]);

  let ver: any = null;
  for (let i = 0; i < 40 && !ver; i++) {
    await sleep(250);
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { /* 아직 */ }
  }
  if (!ver) throw new Error('크롬 디버깅 포트가 안 열렸다');
  console.log(`\n${ver.Browser} 로 확인한다 → ${TARGET}\n`);

  const tab: any = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(TARGET)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error('디버깅 소켓이 안 열렸다'));
  });

  let id = 0;
  const waiting = new Map<number, (m: any) => void>();
  const seen: string[] = [];
  ws.onmessage = (e: MessageEvent) => {
    const m = JSON.parse(String(e.data));
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); }
    else if (m.method) seen.push(m.method);
  };
  const send = (method: string, params: object = {}): Promise<any> => new Promise(res => {
    const n = ++id; waiting.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  await send('Page.enable');
  await send('Page.navigate', { url: TARGET });
  for (let i = 0; i < 40 && !seen.includes('Page.loadEventFired'); i++) await sleep(300);
  /* 서비스워커가 깔리기를 기다린다 — app.js 가 load 이후에 등록하므로 화면이 뜬
     직후에는 아직 없다. */
  await sleep(4000);

  const man = await send('Page.getAppManifest');
  const inst = await send('Page.getInstallabilityErrors');

  console.log('매니페스트  :', man.result?.url ?? '(못 찾음)');
  const perr: any[] = man.result?.errors ?? [];
  console.log('파싱 오류   :', perr.length === 0 ? '없음' : JSON.stringify(perr));

  const errs: any[] | null =
    inst.result?.installabilityErrors ?? inst.result?.errors ?? null;
  console.log('');
  let bad = perr.length > 0;
  if (errs === null) {
    console.log('설치 판정   : 크롬이 이 명령을 안 받았다 —', JSON.stringify(inst).slice(0, 200));
    bad = true;
  } else if (errs.length === 0) {
    console.log('설치 판정   : 오류 없음 — 설치 가능 ✅');
  } else {
    bad = true;
    console.log('설치 판정   : 아래 이유로 설치할 수 없다 ❌');
    for (const e of errs) console.log('  ✗', e.errorId, JSON.stringify(e.errorArguments ?? []));
  }

  ws.close();
  console.log('');
  process.exitCode = bad ? 1 : 0;
}

main()
  .catch(e => { console.error(e.message); process.exitCode = 1; })
  .finally(async () => {
    child?.kill();
    await sleep(400);
    try { rmSync(prof, { recursive: true, force: true }); } catch { /* 잠겨 있으면 둔다 */ }
  });
