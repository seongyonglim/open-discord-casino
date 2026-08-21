/* 남이 걸 때 칩이 «정말» 날아오는가 — 눈이 아니라 숫자로 잰다.
 *
 * ── 왜 도구로 만드는가
 * 이 연출은 세 번 고쳤는데 세 번 다 "고쳤다" 고 보고한 뒤에 안 돌고 있었다.
 *   1. 안전망이 남의 증가를 삼켜서 칩을 날리는 갈래에 못 갔다
 *   2. 봇은 한 번에 걸어서 delta 갈래가 아니라 rebuildPile 로만 왔다(거기엔 갈래가 없었다)
 *   3. 미리보기 서버가 SSR 모듈을 캐시해서 고친 코드가 아예 안 나가고 있었다
 * 셋 다 «화면을 봐도 모르는» 고장이다. 안 날아오는 것과 남이 안 걸고 있는 것이
 * 화면에서는 똑같이 보이기 때문이다. 그래서 날아간 칩의 «개수와 모양» 을 직접 센다.
 *
 * ── 무엇을 합격으로 보는가
 * 1. 남이 거는 동안 날아간 칩이 하나라도 있다 (0개면 연출이 죽은 것이다)
 * 2. 동전은 정사각이다 — 복제본이 한 축으로 눌려 타원으로 날아간 적이 있다(55x34)
 * 3. 실제로 «이동» 한다 — 출발 오프셋(--fx/--fy)이 0이면 제자리에서 나타난 것이다
 *
 * ── 왜 감사 체인에 안 넣는가
 * 크롬과 봇이 같이 돌아야 하고 시간이 든다. check-mobile 과 같은 이유다.
 *
 * 쓰는 법:
 *   1) 미리보기 서버를 띄운다 (8300). src/web 을 고쳤으면 «반드시 재시작» 한다 —
 *      SSR 모듈이 캐시되어 고친 코드가 안 나간다.
 *   2) 봇을 띄운다. DB_PATH 를 «미리보기 서버와 같은 곳» 으로 맞춰야 한다:
 *
 *        DB_PATH=%TMP%/casino-preview BOT_BASE=http://localhost:8300  *          BOT_GAME=baccarat npm run bots
 *
 *      (_preview.tmp.ts 가 DB_PATH 를 os.tmpdir()/casino-preview 로 못 박는다.
 *       안 맞추면 봇은 자기 DB 에서 5,000,000P 를 갖고 시작하지만 서버 쪽 계정은
 *       빈털터리라 모든 베팅이 "잔액이 부족합니다" 로 튕긴다 — 봇 로그에는 «라운드
 *       참가» 만 찍히고 화면에는 아무 일도 안 일어나서, 연출이 죽은 것처럼 보인다.)
 *   3) npx tsx scripts/check-chips.ts baccarat
 *
 *   npx tsx scripts/check-chips.ts                 # 세 게임 다 (봇도 게임마다 갈아 줘야 한다)
 *   CHIP_SEC=90 npx tsx scripts/check-chips.ts poker
 *   CHIP_SIZE=가로 npx tsx scripts/check-chips.ts blackjack
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

const BASE = (process.env.CHIP_BASE ?? 'http://localhost:8300').replace(/\/$/, '');
const PORT = Number(process.env.CDP_PORT ?? 9351);
const SECONDS = Number(process.env.CHIP_SEC ?? 75);
const ONLY = process.argv.slice(2).filter(a => !a.startsWith('-'));
const GAMES = ONLY.length ? ONLY : ['baccarat', 'poker', 'blackjack'];
const SIZES = [
  { name: '세로', w: 412, h: 915 },
  { name: '가로', w: 915, h: 412 },
].filter(s => !process.env.CHIP_SIZE || s.name === process.env.CHIP_SIZE);

const prof = mkdtempSync(join(tmpdir(), 'casino-chip-'));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function ck(name: string, ok: boolean, extra = ''): void {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

/* 감시자. 문서가 만들어지기 «전» 에 심는다 — 게임 스크립트가 첫 폴을 받아 칩을 올리는
   순간을 놓치면, 안 날아온 것과 못 본 것을 구별할 수 없다. */
const WATCH = `(function(){
  window.__chip = { toss: 0, fly: 0, drop: 0, squashed: [], still: 0, shapes: {}, owners: {},
    /* 더미에 «올라간» 칩도 같이 센다. 이게 있어야 "안 날았다" 의 원인이 갈린다:
       pending 이 0 이면 애초에 날리는 갈래로 안 갔다는 뜻이고(다시 그리기 경로),
       pending 은 있는데 toss 가 0 이면 출발점을 못 찾아 돌아선 것이다. */
    pileAdd: 0, pilePending: 0, where: [] };
  function look(n){
    if (n.nodeType !== 1 || !n.classList || !n.classList.contains('pchip')) return;
    if (!n.closest || !n.closest('.chip-fly-layer')) {
      var wc = window.__chip;
      wc.pileAdd++;
      if (n.classList.contains('pending')) wc.pilePending++;
      if (wc.where.length < 3) {
        var p = n.parentElement;
        wc.where.push((p ? (p.id || p.className || p.tagName) : '(부모없음)') + ' | ' + n.className);
      }
      return;
    }
    var w = window.__chip;
    var kind = n.classList.contains('toss') ? 'toss'
      : n.classList.contains('fly') ? 'fly'
      : n.classList.contains('drop') ? 'drop' : null;
    if (!kind) return;
    w[kind]++;
    if (kind !== 'toss') return;
    var cs = getComputedStyle(n);
    var bw = Math.round(parseFloat(cs.width) * 10) / 10;
    var bh = Math.round(parseFloat(cs.height) * 10) / 10;
    w.shapes[bw + 'x' + bh] = (w.shapes[bw + 'x' + bh] || 0) + 1;
    /* 동전만 본다 — 막대칩(c-bar)은 원래 직사각형이다 */
    if (n.className.indexOf('c-coin') >= 0 && Math.abs(bw - bh) > 0.6) {
      if (w.squashed.length < 4) w.squashed.push(n.className + ' ' + bw + 'x' + bh);
    }
    /* 정말 «날아» 왔는가. 출발 오프셋이 0이면 제자리에서 나타난 것이다. */
    var fx = parseFloat(n.style.getPropertyValue('--fx')) || 0;
    var fy = parseFloat(n.style.getPropertyValue('--fy')) || 0;
    if (Math.abs(fx) < 2 && Math.abs(fy) < 2) w.still++;
    var o = n.getAttribute('data-owner') || '(없음)';
    w.owners[o] = (w.owners[o] || 0) + 1;
  }
  /* 붙은 «가지» 도 들여다본다. 처음엔 붙은 노드 자체만 봤는데, 칩이 상자 innerHTML
     한 덩어리로 갈리면 붙은 노드는 상자이고 칩은 그 안에 있다 — 그래서 화면에 칩이
     열여섯 개 있는데도 "올라간 칩 0개" 로 읽혔다. 도구가 못 보는 것과 안 일어난 것은
     다르고, 그 둘을 섞으면 엉뚱한 곳을 파게 된다. */
  function scan(n){
    if (n.nodeType !== 1) return;
    look(n);
    if (!n.querySelectorAll) return;
    var kids = n.querySelectorAll('.pchip');
    for (var i = 0; i < kids.length; i++) look(kids[i]);
  }
  new MutationObserver(function(recs){
    for (var i = 0; i < recs.length; i++) {
      var a = recs[i].addedNodes;
      for (var j = 0; j < a.length; j++) scan(a[j]);
    }
  /* 뿌리는 document 로 잡는다. documentElement 로 잡았더니 아무것도 안 세어졌다 —
     이 조각은 문서가 «만들어지기 전» 에 돌기 때문에 그 순간 documentElement 는 아직
     null 이고, observe(null) 은 던진다. 그러면 위의 __chip 만 만들어진 채 감시자는
     없는 상태가 되어, 화면에 칩이 열일곱 개 올라와도 "0개" 로 보고된다.
     던진 자리가 감시자 설치라서 아무 신호도 안 남는다 — 그게 제일 나빴다. */
  }).observe(document, { childList: true, subtree: true });
})()`;

/* 화면에 남이 실제로 걸고 있는가. 이걸 같이 재야 "0개" 를 해석할 수 있다 —
   아무도 안 걸었으면 0개는 정상이고, 걸었는데 0개면 연출이 죽은 것이다. */
const OTHERS = `(function(){
  /* 문서가 아직 없을 수 있다 — 그때는 "못 쟀다"(null)로 돌려주고 부르는 쪽이 다시 묻는다.
     한때 여기서 document.body.innerText 를 바로 읽어 첫 프로브가 던졌다. */
  if (!document.body) return null;
  var me = window.__MEID__ || '';
  var rows = document.querySelectorAll('.rw');
  var others = 0;
  for (var i = 0; i < rows.length; i++) {
    if ((rows[i].getAttribute('data-uid') || '') !== me) others++;
  }
  var chips = document.querySelectorAll('.pchip:not(.toss):not(.fly):not(.drop)');
  var mine = 0;
  for (var k = 0; k < chips.length; k++) {
    if ((chips[k].getAttribute('data-owner') || '') === me) mine++;
  }
  return { me: me, others: others, chips: chips.length, mineChips: mine,
    paused: /일시정지/.test(document.body.innerText) };
})()`;

async function main(): Promise<void> {
  const child: ChildProcess = execFile(CHROME!, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', 'about:blank',
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
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res(); ws.onerror = () => rej(new Error('소켓 실패'));
  });

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
  const evaluate = async (expr: string): Promise<any> => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.result?.exceptionDetails) {
      const d = r.result.exceptionDetails;
      throw new Error('화면 안 검사식이 던졌다: '
        + (d.exception?.description || d.text || JSON.stringify(d)).split('\n')[0]);
    }
    return r.result?.result?.value;
  };

  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH });

  const go = async (url: string): Promise<void> => {
    loaded = false;
    await send('Page.navigate', { url });
    for (let i = 0; i < 50 && !loaded; i++) await sleep(200);
    await sleep(1500);
  };

  /* 화면을 «진짜» 만진다. 게임 화면은 3분 무조작이면 폴링을 멈추므로(일시정지),
     오래 재려면 살아 있다는 신호를 줘야 한다. JS 로 만든 이벤트로는 안 된다 —
     한 번은 먹은 것처럼 보였다가 다시 멈췄고, 그래서 "확인 못 했다" 로 끝났다.
     CDP 의 Input 은 브라우저가 실제 입력으로 넣어 주므로 확실하다.

     누르는 것은 «자리 없는» 신호여야 한다. 처음엔 화면 맨 아래 가운데를 눌렀는데,
     세로에서 거기는 하단 탭바다 — 그 한 번의 클릭으로 로비로 나가 버려서, 그 뒤
     75초 동안 "남 0명 · 칩 0개" 를 재고 "세로는 아무 일도 안 일어난다" 로 읽었다.
     깨어 있다는 신호에 쓰는 입력이 화면을 바꾸면 안 된다. Shift 는 어느 화면에서도
     아무 일도 안 하면서 keydown 만 남긴다. */
  const nudge = async (): Promise<void> => {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: 'Shift', code: 'ShiftLeft',
        windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
    }
  };

  await send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36'
      + ' (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
  });
  await send('Emulation.setDeviceMetricsOverride',
    { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
  if (BASE.includes('localhost')) await go(`${BASE}/dev/login`);

  for (const size of SIZES) {
    await send('Emulation.setDeviceMetricsOverride',
      { width: size.w, height: size.h, deviceScaleFactor: 2, mobile: true });

    for (const game of GAMES) {
      console.log(`\n[${game} · ${size.name} ${size.w}x${size.h}]`);
      await go(`${BASE}/games/${game}`);
      /* 첫 상태가 올 때까지 몇 번 묻는다 — 폴링이 첫 응답을 받아 참가자 줄을 그리기
         전에는 "남이 없다" 로 보인다. */
      let first = null;
      for (let i = 0; i < 12 && !first?.me; i++) { await sleep(700); first = await evaluate(OTHERS); }
      if (!first?.me) {
        console.log('  로그인이 없어 게임 화면을 열 수 없다 — 잴 것이 없다.');
        continue;
      }

      await nudge();

      let seen = { others: 0, chips: 0 };
      const until = Date.now() + SECONDS * 1000;
      while (Date.now() < until) {
        await sleep(5000);
        await nudge();                        // 일시정지 방지
        const o = await evaluate(OTHERS);
        if (o) {
          seen.others = Math.max(seen.others, o.others);
          seen.chips = Math.max(seen.chips, o.chips);
        }
      }
      const w = await evaluate('window.__chip');
      const others = Math.max(0, seen.others);

      console.log(`  남 ${others}명 · 화면의 칩 최대 ${seen.chips}개`
        + ` · 더미에 올라간 칩 ${w.pileAdd}개(그중 날릴 예정 ${w.pilePending}개)`
        + ` · 날아온 칩 ${w.toss}개 · 회수 ${w.fly}개`);
      if (w.where.length) console.log('  올라간 자리: ' + w.where.join(' / '));
      if (Object.keys(w.shapes).length) {
        console.log('  날아온 칩 크기: ' + Object.entries(w.shapes)
          .map(([k, v]) => `${k}×${v}`).join(', '));
      }

      if (!others) {
        console.log('  남이 아무도 안 걸었다 — 봇을 띄우고 다시 재야 한다.');
        ck(`${game}/${size.name} 남이 있다`, false, '참가자가 나 혼자다');
        continue;
      }
      ck(`${game}/${size.name} 남의 칩이 날아온다`, w.toss > 0, `날아온 칩 0개`);
      ck(`${game}/${size.name} 동전이 정사각이다`, w.squashed.length === 0,
        w.squashed.join(' / '));
      ck(`${game}/${size.name} 제자리 등장이 아니다`, w.toss === 0 || w.still === 0,
        `출발 오프셋 0인 칩 ${w.still}개`);
    }
  }

  ws.close();
  child.kill();
  console.log(`\n${'─'.repeat(40)}\n통과 ${pass} · 실패 ${fail}`);
  try { rmSync(prof, { recursive: true, force: true }); } catch { /* 임시 프로필 */ }
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
