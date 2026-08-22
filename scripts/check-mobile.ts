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
 * 3. 하단 탭바는 «게임이 아닌» 화면에서만 화면 바닥에 붙어 있다.
 *    게임 화면에서는 아예 없어야 한다 — 베팅 단추 바로 아래에 탭이 붙어 있으면
 *    엄지가 게임 대신 다른 화면을 누른다.
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
  /* 판과 조작부를 찾는다. 인게임 격자로 옮긴 게임은 .game-main 이 비어 있고 내용이
     .ig-board / .ig-bet 안에 있다 — 옛 자리만 보면 "판이 없다"로 잘못 읽는다. */
  const grid = document.querySelector('.ig-body');
  const el = grid || document.querySelector('.game-main');
  const board = grid ? grid.querySelector('.ig-board') : (el && el.firstElementChild);
  const bb = board ? board.getBoundingClientRect() : null;
  /* 조작부도 같이 본다. 판만 지켰더니 지뢰찾기 조작부가 185px 로 눌려 안의 글자들이
     서로 겹쳤다 — 판 검사는 초록이었다. 눌린 칸은 scrollWidth 가 실제 폭보다 크다. */
  const ctl = grid ? grid.querySelector('.ig-bet')
    : (el && el.lastElementChild !== board ? el.lastElementChild : null);
  const cb = ctl ? ctl.getBoundingClientRect() : null;
  return {
    /* 로그인 여부. 게임 화면은 로그인해야 열리므로, 안 한 채로 재면 모든 항목이
       "없음"으로 나와 전부 실패처럼 보인다 — 운영 주소로 돌렸다가 42개가 빨갛게
       나왔는데 전부 이 이유였다. 고장이 아니라 잴 수 없는 상태다. */
    loggedIn: !!window.__MEID__,
    /* 대회가 아직 안 열린 상태(등록 중)에서는 홀덤 테이블이 만들어져 있어도 비어
       있어 0x0 이다. 그때 판을 재면 \"판이 0px\" 이 되는데, 그건 화면이 깨진 것이
       아니라 아직 판이 없는 것이다 — 로비 카드가 대신 떠 있다. 로그인 안 한 화면을
       \"잴 수 없음\" 으로 두는 것과 같은 이유로 구분한다. */
    preTable: !!document.querySelector('.ht-card'),
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
    /* ── 조작부가 «판» 이 아닌 화면 ────────────────────────────────
       그래프게임 가로는 상승 구간에 조작부를 접고 단추 하나만 띄운다. 그 순간
       할 수 있는 일이 «지금 빼는가» 하나뿐이라, 280px 짜리 판을 두면 곡선만 가린다.
       그래서 아래 "조작부가 눌리지 않았다" 는 이 화면에서 잴 것을 바꾼다 —
       판의 폭이 아니라 그 단추가 엄지에 닿는 크기인가를 본다.

       점검을 느슨하게 하는 것이 아니다. 재는 대상을 화면 구조에 맞게 고르는 것이고,
       고르지 않으면 «설계대로 접힌 것» 을 고장으로 읽는다(실제로 그렇게 읽었다). */
    floatAction: (() => {
      const b = ctl ? ctl.querySelector('.game-action') : null;
      if (!b) return null;
      const cs = getComputedStyle(b);
      if (cs.position !== 'absolute' && cs.position !== 'fixed') return null;
      if (cs.display === 'none' || cs.visibility === 'hidden') return null;
      const r = b.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height),
               right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom) };
    })(),
    /* 조작부가 접혀 있고 지금 누를 것도 없는 구간인가.
       그래프게임 가로의 상승 구간이 그렇다 — 베팅은 마감됐고, 걸어 둔 것이 없으면
       캐시아웃도 없다. 그때 칸은 0×0 으로 접힌다(일부러 그렇게 만들었다: 20×14 짜리
       빈 상자가 곡선 위에 남는 것을 없애려고).
       "판이 280px 은 되어야 한다" 를 그 순간에 물으면 설계를 고장으로 읽는다.
       홀덤의 대회 전(preTable)과 같은 성질이다 — 고장이 아니라 «잴 것이 없는» 상태다. */
    /* ── 랭킹 줄 ──────────────────────────────────────────────────
       양식을 하나로 맞췄다: 순위 · 이름 · 손익 세 값이 한 줄에, 줄 높이는 여유 있게.
       그 «여유» 가 실제로 그려지는지를 본다 — .sp-rank 가 세로 flex 라, 줄이 flex:none
       이 아니면 줄 수가 많을 때 전부 균등하게 눌린다. 폰 가로에서 25px 이 12.6px 로
       짜부라진 적이 있고, CSS 의 padding 만 읽으면 그것을 못 본다(계산에는 반영되어
       있었다). 그려진 높이를 재는 것만이 그 실패를 잡는다.
       이름이 굶는 것도 같이 본다 — 손익 열의 min-width 가 이름 자리를 먹으면
       이름이 두 글자에서 잘린다(실측: 55px 필요한데 28px 을 받았다). */
    /* ── 타이머가 초를 «읽었는가» ─────────────────────────────────
       인게임 타이머(.ig-timer)는 게임이 쓴 글자에서 숫자를 정규식으로 뽑아 쓴다.
       그래서 게임 쪽 문구를 조금 고치면 조용히 못 읽게 된다 — 실제로 사다리 문구를
       "베팅 마감까지 N초" 에서 "베팅 마감 N초" 로 줄였을 때 그 일이 났다. 겉보기에는
       글자가 그대로 떠 있어서 아무 문제가 없어 보이는데, 두 자리 고정이 풀리고
       3초 이하 경고(ig-t-hot)가 영영 안 켜진다.
       그러니 «원본에 N초가 있으면 타이머도 숫자를 갖고 있어야 한다» 를 본다. */
    timerNum: (() => {
      const t = document.querySelector('.ig-timer');
      if (!t || getComputedStyle(t).display === 'none') return null;
      const num = t.querySelector('.ig-t-num');
      // 원본은 게임이 쓰는 노드다 — 지금 화면에 있는 카운트다운 글자를 찾는다
      const src = document.querySelector('.stage-status, .bacc-status, .bj-status, .poker-status');
      const raw = src ? String(src.textContent || '').trim() : '';
      const wants = /\d+초/.test(raw);
      return { raw, wants, got: num ? String(num.textContent || '').trim() : '' };
    })(),
    rankRow: (() => {
      const rw = document.querySelector('.sp-rank .sp-rw');
      if (!rw) return null;
      const r = rw.getBoundingClientRect();
      if (r.height === 0) return null;
      const kids = [...rw.children].map(c => String(c.className).split(' ')[0]);
      const nm = rw.querySelector('.sp-nm');
      const nr = nm ? nm.getBoundingClientRect() : null;
      return {
        h: Math.round(r.height * 10) / 10,
        kids,
        nameW: nr ? Math.round(nr.width) : 0,
        nameNeed: nm ? nm.scrollWidth : 0,
      };
    })(),
    ctlCollapsed: (() => {
      if (!ctl || !cb) return false;
      if (getComputedStyle(ctl).position !== 'absolute') return false;
      if (cb.width >= 8 || cb.height >= 8) return false;
      const acts = [...ctl.querySelectorAll('.game-action')];
      return acts.every(b => getComputedStyle(b).display === 'none');
    })(),
    over,
    /* ── 인게임 풀스크린 ─────────────────────────────────────────
       가로에서 게임 화면은 스크롤이 없어야 한다. 웹 껍데기(헤더·탭바·게임 전환)가
       높이를 먹으면 판이 줄거나 화면이 밀린다. 아래 셋으로 그것을 본다. */
    scrollH: de.scrollHeight,
    ingame: document.documentElement.classList.contains('ingame'),
    /* 겉(상단바·채팅)은 일곱 게임이 다 쓰고, 속(본문을 한 화면에 맞춰 다시 짠 격자)은
       지어 둔 게임만 쓴다. 아래 검사들은 그 둘을 갈라 봐야 한다 — 안 그러면 "줄여
       넣은 판" 을 전제한 항목이 줄인 적 없는 게임에 걸린다. */
    grid: document.documentElement.classList.contains('ig-grid'),
    barH: (function(){ var b = document.querySelector('.ig-bar');
      return b ? Math.round(b.getBoundingClientRect().height) : null; })(),
    /* 상단바 단추가 실제로 «눌리는가». 보이는 것과 눌리는 것은 다르다 — 안 보이는
       상자가 위에 겹쳐 있으면 그림은 멀쩡한데 클릭만 먹힌다.
       실제로 그랬다: 로비 머리를 40px 로 맞추려고 header > .wrap 에 min-height 를
       줬더니, 판에서는 header 가 height:0 인데도 그 상자가 40px 로 남아 상단바를 덮어
       여섯 단추가 전부 죽었다. 눈으로도 검사로도 안 잡혔다 — 그래서 여기서 «그 자리를
       눌렀을 때 무엇이 잡히는가» 를 직접 묻는다. */
    barDead: (function(){
      var bar = document.querySelector('.ig-bar');
      if (!bar) return null;
      var dead = [];
      var sel = ['.ig-gamesel', '.ig-help', '.ig-chat', '.belbtn', '.sfxbtn', '.prof', '.ig-back'];
      for (var i = 0; i < sel.length; i++) {
        var e = bar.querySelector(sel[i]);
        if (!e) continue;
        var b = e.getBoundingClientRect();
        if (b.width < 4 || b.height < 4) continue;
        var hit = document.elementFromPoint(
          Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2));
        if (!hit || !(hit === e || e.contains(hit) || hit.contains(e))) {
          dead.push(sel[i] + '→' + (hit ? hit.tagName + '.' + String(hit.className).split(' ')[0] : '없음'));
        }
      }
      return dead;
    })(),
    navShown: !!(nav && nav.height > 0),
    /* 판이 화면을 얼마나 쓰는가. 남는 높이를 확보해 놓고도 판이 작으면 의미가 없다. */
    boardFill: bb ? Math.round(bb.height / innerHeight * 100) : null,
    /* 화면에 실제로 찍히는 글자 크기. zoom 을 걸면 적힌 크기와 보이는 크기가 달라진다 —
       10.5px 로 적힌 닉네임이 배율 0.44 에서 4.6px 로 나왔고, 그동안의 검사는 전부
       초록이었다. 판을 줄여 "들어가게" 만들어 놓고 읽을 수 없게 한 것이다.
       여기서는 조상들의 zoom 을 전부 곱해 보이는 크기를 구한다. */
    tinyText: (function(){
      if (!el) return null;
      var worst = 999, sample = '';
      var nodes = el.querySelectorAll('*');
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!n.textContent || !n.textContent.trim()) continue;
        var r = n.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        /* 글자를 직접 담은 요소만 본다 — 감싸는 상자까지 세면 같은 글자를 여러 번 센다 */
        var direct = false;
        for (var k = 0; k < n.childNodes.length; k++) {
          if (n.childNodes[k].nodeType === 3 && n.childNodes[k].nodeValue.trim()) direct = true;
        }
        if (!direct) continue;
        var z = 1, p = n;
        while (p && p !== document.body) {
          var pz = parseFloat(getComputedStyle(p).zoom);
          if (pz && pz !== 1) z *= pz;
          p = p.parentElement;
        }
        var px = parseFloat(getComputedStyle(n).fontSize) * z;
        if (px < worst) { worst = px; sample = (n.className || n.tagName) + ' "'
          + n.textContent.trim().slice(0, 10) + '"'; }
      }
      return worst === 999 ? null : { px: Math.round(worst * 10) / 10, sample: sample };
    })(),
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
  /* ── 화면에서 터진 예외 ──────────────────────────────────────────
     구문이 맞아도 실행이 죽을 수 있다. 실제로 그런 일이 있었다: 조각을 자르다
     닫는 줄 하나가 고아로 남아 바깥 IIFE 를 일찍 닫았고, 그 뒤의 코드가 전역에서
     돌면서 "betInput is not defined" 로 터졌다 — 구문 검사는 통과했고, 그래프게임
     화면이 통째로 멈춘 채로 배포됐다.
     그래서 «열었을 때 조용한가» 를 함께 본다. 이 검사가 있으면 그때 잡혔다. */
  let thrown: string[] = [];
  ws.onmessage = (e: MessageEvent) => {
    const m = JSON.parse(String(e.data));
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); }
    else if (m.method === 'Page.loadEventFired') loaded = true;
    else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params?.exceptionDetails;
      const t = d?.exception?.description || d?.text || '알 수 없는 예외';
      thrown.push(String(t).split('\n')[0].slice(0, 120));
    }
  };
  const send = (method: string, params: object = {}): Promise<any> => new Promise(res => {
    const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');      // 화면에서 터진 예외를 받아 보려면 켜야 한다
  await send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36'
      + ' (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
  });

  const go = async (url: string): Promise<void> => {
    loaded = false;
    thrown = [];
    await send('Page.navigate', { url });
    for (let i = 0; i < 40 && !loaded; i++) await sleep(200);
    await sleep(1800);   // 폴링이 첫 상태를 받아 판을 그릴 때까지
  };
  const probe = async (): Promise<any> => {
    /* 랭킹 목록을 재려면 그 탭이 열려 있어야 한다. 기본으로 열려 있는 것은 참가인원이라
       그냥 재면 목록의 높이가 0 이고, 랭킹 항목이 조용히 «잴 수 없음» 으로 넘어간다 —
       검사가 아무것도 안 보면서 통과한다. 그래서 재기 전에 한 번 눌러 준다.
       누를 것이 없는 화면(로비 등)에서는 아무 일도 하지 않는다. */
    await send('Runtime.evaluate', {
      expression: `(() => { var t = [].slice.call(document.querySelectorAll('.sp-tab'))
        .filter(function(x){ return /랭킹/.test(x.textContent); })[0];
        if (t) t.click(); return !!t; })()`,
      returnByValue: true,
    });
    await sleep(700);   // 목록을 받아 그릴 시간
    const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    /* 화면 안에서 던진 예외는 조용히 undefined 로 돌아온다 — 그러면 "로그인이 없다"로
       잘못 읽힌다(실제로 그렇게 헤맸다). 던졌으면 그 자리에서 말한다. */
    if (r.result?.exceptionDetails) {
      const e = r.result.exceptionDetails;
      throw new Error('화면 안 검사식이 던졌다: '
        + (e.exception?.description || e.text || JSON.stringify(e)).split('\n')[0]);
    }
    return r.result?.result?.value;
  };

  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
  if (BASE.includes('localhost')) await go(`${BASE}/dev/login`);

  /* 로그인이 없으면 게임 화면 자체가 안 열린다. 그 상태로 재면 "판이 없다"가 일곱 게임
     × 두 방향으로 쏟아져 고장처럼 보인다 — 운영 주소로 돌렸다가 실제로 그랬다.
     잴 수 없는 것과 틀린 것은 다르므로 여기서 갈라 말하고 끝낸다.
     운영에서 재려면 그 브라우저에 로그인 세션이 있어야 한다(디스코드 OAuth 라
     이 스크립트가 대신 할 수 없다) — 로컬 미리보기로 재는 것이 정상 경로다. */
  await go(`${BASE}/games/holdem`);
  const first = await probe();
  if (process.env.MOB_DEBUG) console.log('첫 프로브:', JSON.stringify(first).slice(0, 400));
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
      /* 열었을 때 조용한가. 구문이 맞아도 실행이 죽으면 화면은 멈춘 채로 남는다 —
         그래프게임이 실제로 그렇게 배포됐다(위 ws.onmessage 주석). */
      ck(`${g} 화면에서 터진 예외가 없다`, thrown.length === 0, thrown.join(' · '));
      ck(`${g} 가로로 안 넘친다`, m.scrollW <= m.vw + 1 && m.over.length === 0,
        `scrollW ${m.scrollW} > ${m.vw}` + (m.over.length ? ' · ' + m.over.join(' / ') : ''));

      /* 가로는 게임 일곱 개 모두 껍데기를 벗는다 — 안 켜지면 그 자체로 실패다.
         세로는 게임마다 다르다(사다리·지뢰찾기만 세로가 주력). 그래서 아래 검사는
         "가로냐" 가 아니라 "껍데기가 켜졌냐" 로 갈라야 한다. 방향으로 갈랐더니
         세로 사다리가 "탭바가 화면 바닥에" 로 걸렸다 — 인게임에서는 그 탭바를
         일부러 걷는데도. */
      if (size.name === '가로') ck(`${g} 인게임 껍데기가 켜진다`, m.ingame === true);

      if (m.ingame) {
        /* ── 인게임 풀스크린 ───────────────────────────────────────
           게임 화면은 웹 껍데기를 벗고 판에 화면을 다 내준다.
           스크롤이 생기면 그 자체로 실패다 — 폰에서 판이 밀린다. */
        /* 격자를 지어 둔 게임만 이 약속을 한다. 겉만 맞춘 게임은 제 배치대로
           스크롤하는 것이 정상이고, 그것까지 실패로 세면 "안 만든 것" 과 "고장난 것" 이
           같은 색으로 보인다. */
        if (m.grid) ck(`${g} 세로로도 안 밀린다 (스크롤 없음)`, m.scrollH <= m.vh + 1,
          `scrollH ${m.scrollH} > ${m.vh}`);
        else if (size.name !== '가로') console.log(`  --   ${g} 스크롤 — 세로 격자를 아직 안 지었다`);
        /* 게임 화면에서는 탭바가 «없어야» 한다. 한동안 세로에서는 살려 두었는데,
           판 아래 베팅 단추 바로 밑에 탭 넷이 붙어 있어서 엄지가 "베팅" 을 누르려다
           "랭킹" 으로 나가는 일이 생긴다 — 화면 바닥은 게임의 것이어야 한다.
           로비로 돌아가는 길은 상단바의 게임 목록 첫 줄에 있다. */
        ck(`${g} 하단 탭바가 없다`, m.navShown === false);
        ck(`${g} 상단바가 얇다 (≤44px)`, m.barH !== null && m.barH <= 44,
          m.barH === null ? '.ig-bar 없음' : `${m.barH}px`);
        /* 보이는 것으로는 모자란다 — 그 자리를 눌렀을 때 그 단추가 잡혀야 한다. */
        ck(`${g} 상단바 단추가 눌린다`, (m.barDead ?? []).length === 0,
          (m.barDead ?? []).join(' · ') + ' — 안 보이는 상자가 위를 덮고 있다');
        /* 자리를 비워 놓고 판이 그대로면 아무것도 얻은 게 없다. */
        /* 40% 로 둔다. 처음에 45% 로 잡았는데 사다리가 42% 에서 걸렸다 — 그 판은
           출발 둘과 도착 둘, 선 두 개가 전부라 넓은 면적이 필요하지 않다. 기준이
           현실보다 앞서면 맞추려고 다른 것을 망가뜨리게 된다(조작부를 더 눌렀을 것이다). */
        /* 대회 전에는 판이 아직 없다 — 위와 같은 이유로 이 항목도 건너뛴다 */
        if (m.preTable) console.log(`  --   ${g} 판 비율 — 대회 전이라 잴 수 없음`);
        else if (!m.grid && size.name !== '가로') console.log(`  --   ${g} 판 비율 — 세로 격자를 아직 안 지었다`);
        else ck(`${g} 판이 화면 높이의 40% 이상`, (m.boardFill ?? 0) >= 40, `${m.boardFill}%`);
        /* 그리고 읽을 수 있어야 한다. 판을 줄여 "들어가게" 만들어 놓고 글자를 4.6px 로
           만들면 들어간 것이 아니다 — 그동안 이 항목이 없어서 전부 통과했다.
           9px 은 폰에서 겨우 읽히는 하한이다.
           이 항목의 전제도 "줄여 넣었다" 이므로 격자를 지은 것에만 건다. 겉만 맞춘
           게임의 작은 글자는 이 작업이 만든 것이 아니라 원래 그 페이지의 것이다. */
        if (m.grid || size.name === '가로')
          ck(`${g} 글자가 읽을 수 있는 크기`, (m.tinyText?.px ?? 99) >= 9,
            m.tinyText ? `가장 작은 글자 ${m.tinyText.px}px — ${m.tinyText.sample}` : '못 잼');
        /* 타이머가 게임 문구에서 초를 읽어 냈는가. 원본에 초가 없는 구간(정산 중 등)은
           잴 것이 없으므로 넘어간다. */
        if (m.timerNum && m.timerNum.wants) {
          ck(`${g} 타이머가 초를 읽었다`, /\d/.test(m.timerNum.got),
            `원본 "${m.timerNum.raw}" → 타이머 숫자 "${m.timerNum.got}" (문구가 바뀌어 정규식이 못 읽는다)`);
        }
        /* 랭킹 줄 — 양식이 한 벌로 유지되는가. 열려 있는 탭이 참가인원이면 목록이
           비어 있어 잴 수 없다(그때 rankRow 가 null 이다) — 없는 것은 넘어간다. */
        if (m.rankRow) {
          const r = m.rankRow;
          ck(`${g} 랭킹 줄이 눌리지 않았다`, r.h >= 20, `줄 높이 ${r.h}px (20px 이상이어야 한다)`);
          ck(`${g} 랭킹 줄이 세 값이다`, r.kids.length === 3
            && r.kids[0] === 'sp-no' && r.kids[1] === 'sp-nm' && r.kids[2] === 'sp-p',
            `자식 ${r.kids.join('·')} (순위·이름·손익 셋이어야 한다)`);
          /* 이름이 필요 폭의 절반도 못 받으면 두 글자에서 잘린다 — 손익 열이
             자리를 먹고 있다는 뜻이다. 긴 이름이 말줄임되는 것 자체는 정상이다. */
          ck(`${g} 랭킹 이름 자리가 굶지 않았다`, r.nameNeed === 0 || r.nameW >= r.nameNeed * 0.5,
            `이름 폭 ${r.nameW}px · 필요 ${r.nameNeed}px`);
        }
      } else {
        ck(`${g} 탭바가 화면 바닥에`, m.navBottom !== null && Math.abs(m.navBottom - m.vh) <= 2,
          `${m.navBottom} vs ${m.vh}`);
      }
      /* 판과 조작부가 한 화면에. 이것이 "게임이 스크롤 없이 되는가"다.
         인게임에서는 탭바가 없으므로 화면 바닥을 기준으로 본다. */
      /* 탭바가 남아 있으면 그 위가 바닥이다 — 세로 인게임이 그렇다 */
      const 바닥 = m.ingame && m.navShown === false ? m.vh : m.navTop;
      ck(`${g} 판+조작부가 한 화면에`, m.mainBottom !== null && 바닥 !== null && m.mainBottom <= 바닥,
        m.mainBottom !== null ? `${m.mainBottom - (바닥 ?? 0)}px 넘침 (판 ${m.mainTop}~${m.mainBottom} · 바닥 ${바닥})` : '.game-main 없음');
      /* 눌러서 맞춘 것이 아닌지. 화면 폭의 3할도 안 되는 판은 게임이 아니라 막대다. */
      const 최소폭 = Math.round(m.vw * 0.3);
      /* 대회 전(등록 중)에는 홀덤 테이블이 비어 있어 0x0 이다 — 깨진 것이 아니라
         아직 판이 없는 것이다. 그 상태는 재지 않고 넘어간다. */
      if (m.preTable) {
        console.log(`  --   ${g} 판/조작부 — 대회 전이라 잴 수 없음`);
      } else {
      ck(`${g} 판이 찌그러지지 않았다`, m.boardW !== null && m.boardW >= 최소폭,
        `판 폭 ${m.boardW}px < ${최소폭}px`);
      /* 조작부도 같이 본다. 눌린 칸은 안의 내용이 들어갈 자리를 못 얻어 겹친다 —
         scrollWidth 가 실제 폭보다 크면 그 상태다.

         단, 조작부가 «떠 있는 단추 하나» 로 접힌 화면은 다르게 잰다(위 floatAction).
         그때는 판이 없는 것이 설계이므로 폭 280 을 요구하면 설계를 고장으로 읽는다.
         대신 그 단추가 엄지에 닿는지를 본다 — 44px 은 손가락 하나의 크기다. */
      if (m.floatAction) {
        const f = m.floatAction;
        ck(`${g} 떠 있는 조작 단추가 엄지에 닿는다`,
          f.w >= 88 && f.h >= 44 && f.right >= 4 && f.bottom >= 4,
          `${f.w}x${f.h} · 오른쪽 ${f.right} · 아래 ${f.bottom}`);
      } else if (m.ctlCollapsed) {
        /* 예전에는 이 갈래가 아무것도 안 재고 «--» 한 줄만 찍었다. 그래서 두 가지가
           나빴다. 하나는 실행마다 검사 개수가 184/185 로 오간 것 — 어느 쪽이 맞는
           숫자인지 알 수 없으니 개수가 줄어도 «줄었다» 를 못 알아본다. 둘은 접힘이
           «설계» 가 아니라 «고장» 이어도 조용히 지나간 것이다.

           그러니 접힘 자체를 검사로 만든다. 이 접힘을 만든 이유가 «20x14 짜리 빈
           상자가 곡선 위에 남는 것을 없애려고» 였으므로, 물어야 할 것은 하나다 —
           정말로 자리를 안 차지하는가. 안에 든 것이 자리를 요구하면(scrollWidth)
           접힌 것이 아니라 «눌린» 것이다. */
        ck(`${g} 접힌 조작부가 빈 상자를 남기지 않았다`,
          m.ctlW !== null && m.ctlW < 8 && m.ctlNeed <= 8,
          `폭 ${m.ctlW}px · 안쪽이 요구하는 폭 ${m.ctlNeed}px`);
      } else if (m.ctlW !== null) {
        ck(`${g} 조작부가 눌리지 않았다`, m.ctlW >= 280 && m.ctlNeed <= m.ctlW + 2,
          `폭 ${m.ctlW}px · 필요 ${m.ctlNeed}px`);
      }
      }
    }

    for (const p of PLAIN) {
      await go(BASE + p);
      const m = await probe();
      if (!m) { ck(`${p} — 측정 실패`, false); continue; }
      ck(`${p} 화면에서 터진 예외가 없다`, thrown.length === 0, thrown.join(' · '));
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
