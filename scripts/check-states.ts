/* 게임을 상태별로 돌려 가며 화면을 검사한다.
 *
 * ── 왜 필요한가
 * check-mobile 은 게임에 들어간 "대기 상태" 만 본다. 그런데 화면이 깨지는 것은 거의 늘
 * 상태가 바뀔 때다 — 베팅을 걸면 [베팅 취소] 가 생기고, 결정 차례가 오면 액션 버튼이
 * 나타난다. 그때마다 조작부가 커지고 판이 밀린다.
 * 실제로 이 검사가 없어서 같은 종류의 고장을 네 번 놓쳤다(블랙잭 액션 · 사다리 취소 ·
 * 바카라 이름 잘림 · 포커 스크롤). 사람이 하나씩 찾아 알려 줘야 했다.
 *
 * ── 무엇을 보는가
 *  1. 스크롤이 생겼는가 (가로·세로)
 *  2. 화면 밖으로 나간 요소가 있는가
 *  3. 글자가 잘렸는가 — 한글이 아래가 잘려 깨져 보이는 것이 이것이다
 *  4. 너무 작은 글자가 있는가 (9px 미만)
 *  5. 눌러야 할 버튼이 화면 안에 있는가
 * 상태마다 그림도 남긴다. 숫자가 통과해도 눈으로 확인할 수 있게.
 *
 * 쓰는 법:  npx tsx scripts/check-states.ts [주소]
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

const BASE = (process.argv[2] ?? 'http://localhost:8300').replace(/\/$/, '');
const OUT = join(process.cwd(), '.states');
const PORT = Number(process.env.CDP_PORT ?? 9391);
const prof = mkdtempSync(join(tmpdir(), 'casino-st-'));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const problems: string[] = [];
function ck(where: string, name: string, ok: boolean, extra = ''): void {
  if (ok) { pass++; return; }
  fail++;
  const line = `  ${where} · ${name}${extra ? ' — ' + extra : ''}`;
  problems.push(line);
  console.log('  FAIL ' + line.trim());
}

/* 화면 안에서 도는 검사식. 잘린 글자를 찾는 것이 요점이다 —
   내용이 상자보다 큰데 넘침을 감춘 요소가 곧 "글자가 잘린" 상태다. */
const PROBE = `(() => {
  const de = document.documentElement;
  const vw = innerWidth, vh = innerHeight;
  const zoomOf = el => { let z = 1, p = el;
    while (p && p !== document.body) { const pz = parseFloat(getComputedStyle(p).zoom);
      if (pz && pz !== 1) z *= pz; p = p.parentElement; } return z; };

  const clipped = [], outside = [], tiny = [];
  for (const el of document.querySelectorAll('body *')) {
    const b = el.getBoundingClientRect();
    if (b.width < 3 || b.height < 3) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.opacity === '0') continue;

    /* 직접 글자를 담은 요소만 본다 */
    let hasText = false;
    for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) hasText = true;

    if (hasText) {
      const z = zoomOf(el);
      const px = parseFloat(cs.fontSize) * z;
      if (px < 9) tiny.push((el.className || el.tagName) + ' ' + px.toFixed(1) + 'px "' + el.textContent.trim().slice(0,10) + '"');
      /* 잘림: 내용이 상자보다 큰데 넘침을 감췄다. 스크롤 칸은 제외한다. */
      const hid = cs.overflowY === 'hidden' || cs.overflow === 'hidden';
      if (hid && el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0) {
        clipped.push((el.className || el.tagName) + ' ' + el.clientHeight + '<' + el.scrollHeight + ' "' + el.textContent.trim().slice(0,10) + '"');
      }
    }

    /* 화면 밖 — 잘라 주는 조상이 있으면 넘어간다 */
    if (b.bottom > vh + 1 || b.right > vw + 1 || b.left < -1) {
      let p = el.parentElement, clip = false;
      while (p && p !== document.body) {
        const o = getComputedStyle(p);
        if (['auto','scroll','hidden','clip'].includes(o.overflowY) ||
            ['auto','scroll','hidden','clip'].includes(o.overflowX)) { clip = true; break; }
        p = p.parentElement;
      }
      if (!clip) outside.push((el.className || el.tagName) + ' ' + Math.round(b.top) + '~' + Math.round(b.bottom));
    }
  }

  /* 눌러야 할 것들이 화면 안에 있는가 */
  const btnOut = [];
  for (const el of document.querySelectorAll('button:not([hidden]), .coin, .chip-btn, .bja, .hta, .market, .gs-pill')) {
    const b = el.getBoundingClientRect();
    if (b.width < 3 || b.height < 3) continue;
    if (b.bottom > vh + 1 || b.top < 0 || b.right > vw + 1) {
      btnOut.push((el.className || el.tagName) + ' ' + Math.round(b.top) + '~' + Math.round(b.bottom));
    }
  }

  return {
    scrollY: de.scrollHeight > vh + 1, scrollX: de.scrollWidth > vw + 1,
    clipped: clipped.slice(0, 4), outside: outside.slice(0, 4),
    tiny: tiny.slice(0, 4), btnOut: btnOut.slice(0, 4),
  };
})()`;

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
  await send('Emulation.setDeviceMetricsOverride', { width: 915, height: 412, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile' });
  const go = async (u: string) => {
    loaded = false; await send('Page.navigate', { url: u });
    for (let i = 0; i < 40 && !loaded; i++) await sleep(200);
    await sleep(1800);
  };
  const evalIn = async (expr: string) =>
    (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))
      .result?.result?.value;
  const shot = async (name: string) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s.result?.data) writeFileSync(join(OUT, name + '.png'), Buffer.from(s.result.data, 'base64'));
  };
  const inspect = async (where: string, name: string) => {
    const m = await evalIn(PROBE);
    await shot(name);
    if (!m) { ck(where, '측정 실패', false); return; }
    ck(where, '세로 스크롤 없음', !m.scrollY);
    ck(where, '가로 스크롤 없음', !m.scrollX);
    ck(where, '글자가 안 잘림', m.clipped.length === 0, m.clipped.join(' / '));
    ck(where, '화면 밖 요소 없음', m.outside.length === 0, m.outside.join(' / '));
    ck(where, '글자가 읽을 수 있는 크기', m.tiny.length === 0, m.tiny.join(' / '));
    ck(where, '버튼이 화면 안에', m.btnOut.length === 0, m.btnOut.join(' / '));
  };

  if (BASE.includes('localhost')) await go(`${BASE}/dev/login`);

  /* 게임마다 상태를 만들어 가며 본다. 조작 방법이 게임마다 다르므로 각자 적는다. */
  const GAMES: { key: string; steps: { name: string; act?: string }[] }[] = [
    { key: 'holdem', steps: [{ name: '대기' }] },
    { key: 'baccarat', steps: [
      { name: '대기' },
      { name: '베팅함', act: `(()=>{const c=document.querySelectorAll('.coin')[1]; if(c)c.click();
          const m=document.querySelector('.market'); if(m)m.click(); return true})()` },
    ] },
    { key: 'blackjack', steps: [
      { name: '대기' },
      { name: '앉음', act: `(()=>{const s=document.querySelector('.bj-seat'); if(s)s.click(); return true})()` },
      { name: '베팅함', act: `(()=>{const c=document.querySelectorAll('.coin')[2]; if(c)c.click();
          const m=document.querySelector('.bj-seat.mine')||document.querySelector('.bj-seat'); if(m)m.click(); return true})()` },
      { name: '결정차례', act: `(async()=>{for(let i=0;i<25;i++){await new Promise(r=>setTimeout(r,900));
          const a=document.querySelector('.bj-actions'); if(a&&!a.hasAttribute('hidden'))return true;} return false})()` },
    ] },
    { key: 'poker', steps: [
      { name: '대기' },
      { name: '베팅함', act: `(()=>{const c=document.querySelectorAll('.coin')[1]; if(c)c.click();
          const m=document.querySelector('.market'); if(m)m.click(); return true})()` },
    ] },
    { key: 'mines', steps: [
      { name: '대기' },
      { name: '베팅함', act: `(()=>{const b=document.querySelector('.btn-primary'); if(b)b.click(); return true})()` },
    ] },
    { key: 'graph', steps: [
      { name: '대기' },
      { name: '베팅함', act: `(()=>{const b=document.querySelector('.btn-primary'); if(b)b.click(); return true})()` },
    ] },
    { key: 'ladder', steps: [
      { name: '대기' },
      { name: '예측함', act: `(()=>{const bs=document.querySelectorAll('.predict-row button, .pred-btn, .field-grid button');
          if(bs[0])bs[0].click(); if(bs[2])bs[2].click(); return true})()` },
      { name: '베팅함', act: `(()=>{const b=document.querySelector('.btn-primary'); if(b)b.click(); return true})()` },
    ] },
  ];

  for (const g of GAMES) {
    await go(`${BASE}/games/${g.key}`);
    for (const st of g.steps) {
      if (st.act) { await evalIn(st.act); await sleep(1600); }
      await inspect(`${g.key}/${st.name}`, `${g.key}-${st.name}`);
    }
  }

  ws.close();
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`통과 ${pass} · 실패 ${fail}`);
  console.log(`그림: ${OUT}`);
  process.exitCode = fail ? 1 : 0;
}

main()
  .catch(e => { console.error(e.message); process.exitCode = 1; })
  .finally(async () => {
    child?.kill(); await sleep(400);
    try { rmSync(prof, { recursive: true, force: true }); } catch { /* 잠겨 있으면 둔다 */ }
  });
