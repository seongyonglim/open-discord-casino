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

/* 문자열·주석·정규식 리터럴을 걷어낸다.
   이 코드베이스의 인라인 스크립트는 HTML과 CSS를 문자열로 들고 있어서, 걷어내지 않으면
   그 안의 CSS 함수(calc·var)와 셀렉터(:not)가 전부 JS 호출로 보인다.

   정규식도 반드시 같이 걷어야 한다. 처음에는 "정규식 안의 괄호가 유령 이름을 만들
   확률은 없다"고 보고 놔뒀는데, 문제는 괄호가 아니라 따옴표였다 —
   /["\\]/g 의 " 가 문자열 시작으로 먹히면서 거기서 다음 " 까지가 통째로 지워졌고,
   그 구간에 있던 function 선언들이 사라져 멀쩡한 함수가 유령으로 잡혔다.

   나눗셈과 정규식은 직전 토큰으로 가른다: 값이 올 수 없는 자리(여는 괄호·연산자·
   return 같은 키워드 뒤)에 오는 / 는 정규식이다. */
function stripLits(s: string): string {
  const KW = /(?:^|[^\w$])(return|typeof|case|in|of|delete|void|instanceof|do|else|yield|await|new)$/;
  let out = '';
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < s.length && s[i] !== c) { if (s[i] === '\\') i++; i++; }
      i++; out += '""'; continue;
    }
    if (c === '/') {
      const t = out.replace(/\s+$/, '');
      const isRe = t === '' || KW.test(t) || '(,=:[!&|?{};+-*%~^<'.indexOf(t.slice(-1)) >= 0;
      if (isRe) {
        i++;
        let cls = false;
        while (i < s.length) {
          const d = s[i];
          if (d === '\\') { i += 2; continue; }
          if (d === '\n') break;
          if (d === '[') cls = true;
          else if (d === ']') cls = false;
          else if (d === '/' && !cls) break;
          i++;
        }
        i++;                                              // 닫는 /
        while (i < s.length && /[gimsuyd]/.test(s[i])) i++;   // 플래그
        out += '0'; continue;
      }
    }
    out += c; i++;
  }
  return out;
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
  /* 운영자로 만든다 — 아래 [2b] 가 어드민 화면의 마크업을 읽어야 하기 때문이다.
     운영자가 아니면 /admin 이 404 라 검사할 요소가 통째로 빠지고, 그러면 검사가
     "볼 것이 없어서" 통과한다(실제로 그렇게 통과했다). */
  (require('../src/db/queries') as typeof import('../src/db/queries')).ensureSeedAdmin('a_pages');
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

    /* 부르는 함수가 실제로 있는가.
       파싱 검사로는 못 잡는다 — new Function은 본문을 컴파일만 하고 실행하지 않으므로
       없는 이름을 부르는 코드도 멀쩡히 통과한다. 브라우저에서도 그 줄에 닿기 전까지는
       조용하다. 실제로 함수를 지우면서 호출부 한 줄을 남긴 적이 있는데(showPotLabel),
       그 호출이 setTimeout 콜백 안이라 ReferenceError가 콘솔 밖으로 나오지도 않고
       뒤따르던 WIN 배지 표시가 통째로 죽었다. 칩은 다른 타이머라 그대로 날아갔고,
       그래서 "배지만 안 뜨는" 증상으로 몇 주를 지나갔다.

       선언으로 치는 것: function 이름 · var/let/const · 대입 · 함수 파라미터.
       이만큼만 모아도 남는 것은 진짜로 아무 데도 없는 이름이다. */
    const KNOWN = new Set(('if,for,while,switch,catch,return,typeof,function,new,do,else,' +
      'delete,void,in,of,instanceof,case,throw,await,yield,try,with,' +
      'Math,JSON,Number,String,Boolean,Array,Object,Date,RegExp,Error,Promise,Map,Set,' +
      'Symbol,URL,URLSearchParams,Intl,AbortController,CustomEvent,Event,Audio,Image,' +
      'parseInt,parseFloat,isNaN,isFinite,setTimeout,setInterval,clearTimeout,clearInterval,' +
      'requestAnimationFrame,cancelAnimationFrame,queueMicrotask,structuredClone,fetch,' +
      'encodeURIComponent,decodeURIComponent,encodeURI,decodeURI,escape,unescape,btoa,atob,' +
      'alert,confirm,prompt,eval,console,document,window,navigator,location,history,' +
      'localStorage,sessionStorage,performance,getComputedStyle,matchMedia,scrollTo').split(','));
    let ghosts: string[] = [];
    blocks.forEach(raw => {
      /* 문자열과 주석을 먼저 걷어낸다. 안 걷어내면 CSS가 통째로 호출문으로 보인다 —
         'calc(...)' 'var(--htAv)' ':not([hidden])' 이 전부 "이름 뒤에 여는 괄호"다.
         (실제로 처음 돌렸을 때 calc·var·not·POT이 유령으로 잡혔다.) */
      const b = stripLits(raw);
      const declared = new Set<string>();
      const add = (re: RegExp, g = 1) => {
        for (const m of b.matchAll(re)) if (m[g]) declared.add(m[g]);
      };
      add(/function\s+([A-Za-z_$][\w$]*)/g);
      add(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g);
      add(/,\s*([A-Za-z_$][\w$]*)\s*(?:=|[,;])/g);              // var a = 1, b = 2
      add(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*=[^=]/gm);          // 대입도 선언으로 친다
      for (const m of b.matchAll(/function\s*[\w$]*\s*\(([^)]*)\)/g))
        for (const t of m[1].split(',')) {
          const n = t.trim();
          if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n);
        }
      for (const m of b.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
        const n = m[1];
        if (declared.has(n) || KNOWN.has(n)) continue;
        if (ghosts.indexOf(n) < 0) ghosts.push(n);
      }
    });
    ck(`${p} — 없는 함수를 부르지 않음`, ghosts.length === 0, ghosts.slice(0, 5).join(' '));

    /* 닫는 태그의 슬래시가 이스케이프로 먹힌 흔적.
       파싱 검사로는 절대 못 잡는 종류다 — '<\tbody>'는 완벽하게 유효한 JS 문자열이고
       (\t가 탭 이스케이프다) new Function도 통과한다. 그런데 브라우저에는
       "< body>"라는 글자로 찍힌다. 실제로 '<\/tbody>'를 옮겨 적다가 슬래시를 빠뜨려
       결과 표 아래에 "< body>< able>"이 인쇄된 적이 있고, '<\b>'(백스페이스)로
       </b>가 사라진 적도 있다.
       이 코드베이스는 스크립트 안에서 닫는 태그를 <\/x> 로 쓰는 관례라 오타가 나기 쉽다.

       두 가지를 본다.
         1) '<' 바로 뒤의 제어문자 — 정상 HTML에 나올 이유가 없다.
            \t \n \r 만 보면 안 된다. \b(백스페이스) \f \v 도 모두 유효한 JS 이스케이프라
            같은 사고가 난다.
         2) 렌더된 HTML 어디에든 남아 있는 제어문자 — 위 1)에 안 걸리는 형태
            (예: '<\v/i>')도 결국 본문에 제어문자를 남긴다. 탭·개행은 정상이므로 뺀다. */
    const ctrl = [...r.text.matchAll(/<[\x00-\x1f]/g)]
      .slice(0, 3)
      .map(m => JSON.stringify(r.text.slice(Math.max(0, m.index! - 24), m.index! + 12)));
    ck(`${p} — 태그 자리에 제어문자 없음`, ctrl.length === 0, ctrl.join(' | '));
    const stray = [...r.text.matchAll(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g)]
      .slice(0, 3)
      .map(m => JSON.stringify(r.text.slice(Math.max(0, m.index! - 24), m.index! + 12)));
    ck(`${p} — 본문에 떠도는 제어문자 없음`, stray.length === 0, stray.join(' | '));
  }

  /* ── [2] 카드에 적힌 수치가 실제 게임 코드와 같은가 ──────────────────
     로비 카드의 한 줄 사실(최대 배당 등)은 pages.ts에 손으로 적혀 있다.
     game/*.ts가 pages.ts를 import하므로(gameSwitcher) 반대 방향 import는 순환이 된다.

     그래서 여기서 게임 모듈을 직접 불러 값을 다시 계산하고, 그 숫자가 렌더된 로비
     화면에 실제로 들어 있는지 본다. 배당 상수를 고치고 카드를 잊으면 이 검사가 깨진다 —
     "카드에 적힌 숫자가 거짓이 되는" 실패는 조용히 지나가면 안 되는 종류다. */
  console.log('\n[2] 규칙 도움말의 수치 = 게임 코드의 값');
  {
    /* 예전에는 로비 카드의 한 줄 사실을 봤다. 그 줄을 걷으면서(여섯 장이 나란히 서면
       규격 줄이 먼저 읽혀 로비가 사양표처럼 보였다) 수치를 게임마다 규칙 도움말로
       옮겼고, 검사도 같이 옮긴다 — 표시하는 자리가 바뀌었을 뿐 "적힌 숫자가 거짓이
       되면 안 된다" 는 그대로다.
       지우지 않는 이유가 그것이다. 표시를 옮겼다고 보증까지 없애면, 배당 상수를 고치고
       문구를 잊는 실패가 다시 조용해진다. */
    const pages: string[] = [];
    for (const g of ['baccarat', 'blackjack', 'poker', 'mines', 'graph', 'ladder']) {
      pages.push((await get(`/games/${g}`, cookie)).text);
    }
    const has = (s: string) => pages.some(t => t.includes(s));

    const B = require('../src/web/games/baccarat') as typeof import('../src/web/games/baccarat');
    const C = require('../src/web/games/crash') as typeof import('../src/web/games/crash');
    const M = require('../src/web/games/mines') as typeof import('../src/web/games/mines');
    const PK = require('../src/services/poker') as typeof import('../src/services/poker');
    const BJ = require('../src/services/blackjack') as typeof import('../src/services/blackjack');
    const BC = require('../src/services/baccarat') as typeof import('../src/services/baccarat');
    const Q = require('../src/db/queries') as typeof import('../src/db/queries');

    // 바카라 — 다섯 시장 중 가장 높은 배당. 지금은 페어지만 코드가 바뀌면 따라간다
    const bo = B.baccaratOdds();
    const baccMax = Math.max(bo.player, bo.banker, bo.tie, bo.ppair, bo.bpair);
    ck('바카라 최대 배당', has(`최대 배당 ${baccMax}배`), `계산=${baccMax}`);
    ck('바카라 덱 수', has(`${BC.DECKS}덱`), `DECKS=${BC.DECKS}`);

    /* 블랙잭 — A + K를 들었을 때의 배수. 카드 인덱스는 rank = c >> 2 이고 A는 12, K는 11이다
       (services/blackjack.ts cardRank). 딜러는 블랙잭이 아니어야 하므로 2 + 3을 준다. */
    const bjMax = BJ.settleHand([48, 44], [0, 4]).multiplier;
    ck('블랙잭 배수', bjMax === 2.5 && has(`블랙잭 ${bjMax}배`), `settleHand=${bjMax}`);

    /* 지뢰찾기는 최대 배당을 카드에 적지 않는다 — 이론상 최대(지뢰 10개에서 15칸 전부)가
       3,236,072배다. 참이지만 확률이 300만분의 1이라 "최대 배당"으로 내놓으면
       복권 문구가 된다. 대신 실제로 고를 수 있는 구조를 적는다. */
    ck('지뢰찾기 칸 수', has(`${M.TILE_COUNT}칸`), `TILE_COUNT=${M.TILE_COUNT}`);
    ck('지뢰찾기 선택 가능한 지뢰 수',
      has(`지뢰 ${M.ALLOWED_MINE_COUNTS.join('·')}개`), M.ALLOWED_MINE_COUNTS.join('·'));

    ck('그래프 최대 배율', has(`최대 배율 ${C.MAX_CRASH.toLocaleString('ko-KR')}배`),
      `MAX_CRASH=${C.MAX_CRASH}`);
    ck('포커 플립 배당 상한', has(`최대 ${PK.MAX_ODDS.toLocaleString('ko-KR')}배`),
      `MAX_ODDS=${PK.MAX_ODDS}`);
    ck('사다리 단일·양쪽 배당',
      has(`단일 ${Q.LADDER_MULTIPLIER}배 · 양쪽 ${Q.LADDER_DOUBLE_MULTIPLIER}배`),
      `${Q.LADDER_MULTIPLIER} / ${Q.LADDER_DOUBLE_MULTIPLIER}`);

    /* 홀덤 카드에는 고정 사실 줄을 두지 않는다 — 그 카드의 설명이 이미 대회 상태에서
       나온 살아 있는 수치(신청 인원·상금 풀)를 담고 있고, 그게 고정값보다 낫다.
       대신 그 살아 있는 수치가 실제로 렌더되는지 확인한다. */
    /* 대회가 없는 것도 정상 상태가 됐다 — 자동 생성을 없앤 뒤로는 운영자가 열어야 생긴다.
       그때는 "예정 없음"이나 다음 대회 안내가 나온다. 어느 쪽이든 사람에게 할 말이
       있어야 한다는 것이 이 검사의 요지다. */
    /* 로비를 여기서 다시 받는다 — 위 검사가 게임 페이지로 옮겨 가면서 lobby 를 안 읽게
       됐다. 이 검사는 여전히 로비를 봐야 한다(홀덤 배너가 대회 상태를 비추는가). */
    const lobbyHtml = (await get('/', cookie)).text;
    ck('홀덤 배너는 대회 상태를 비춘다',
      /등록은 .*후에 열립니다|등록 중|명 신청|진행 중|오늘 대회|인원 대기|예정 없음|다음 대회/.test(lobbyHtml));
  }

  /* 대회가 없을 때의 화면. 이 감사 환경에는 대회가 하나도 없으므로(자동 생성이 없다)
     홀덤 화면은 언제나 이 경로를 그린다 — 그래서 여기서 확인할 수 있다.
     빈 화면이 나오면 서비스가 죽은 것처럼 보이는데, 그건 눈으로 보기 전에는 모른다. */
  /* hidden 속성이 정말 감추는가.
     브라우저 기본 스타일의 [hidden]{display:none} 은 우선순위가 가장 낮다. 그래서
     어떤 요소에 display 를 직접 정해 두면 el.hidden = true 를 해도 화면에서 사라지지
     않는다 — 코드는 감췄다고 믿고, 화면에는 그대로 남는다.

     이 함정을 두 번 밟았다. 참가 방식에 안 맞는 입력 줄이 "0 P"로 남았고(.ad-grid),
     사전 액션의 선택지 넷이 늘 다 보였다(.ht-pre label). 둘 다 아무 에러가 없어서
     el.hidden 만 찍어 보면 true 가 나온다 — 실제로 그렇게 확인하고 넘어갔다.

     그래서 규칙으로 만든다: 코드가 hidden 을 켜는 요소의 클래스에 display 규칙이
     있으면, 같은 클래스의 [hidden] 규칙도 반드시 있어야 한다. */
  console.log('\n[2b] hidden 이 실제로 감추는가 (display 를 직접 정한 요소)');
  {
    const { readFileSync, readdirSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const cssDir = join(process.cwd(), 'src', 'web', 'assets', 'css');
    const css = readdirSync(cssDir).filter(f => f.endsWith('.css'))
      .map(f => readFileSync(join(cssDir, f), 'utf8')).join('\n');

    /* 검사 대상은 "코드가 hidden 을 켜는 요소"다. 그 목록을 손으로 적으면 새 요소가
       늘 때 빠지므로, display 를 직접 정해 둔 클래스를 전부 훑어 [hidden] 짝을 본다. */
    const withDisplay = new Set<string>();
    const tagsWithDisplay = new Set<string>();
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1], body = m[2];
      const dm = body.match(/(?:^|;)\s*display\s*:\s*([a-z-]+)/);
      if (!dm || dm[1] === 'none') continue;
      if (/\[hidden\]/.test(sel)) continue;
      for (const cls of sel.matchAll(/\.([a-zA-Z][\w-]*)/g)) withDisplay.add(cls[1]);
      /* 태그로 잡는 규칙(.ht-pre label 처럼)도 센다 — 클래스가 없는 요소는 이쪽으로만
         잡히고, 놓치면 그 요소는 검사에서 통째로 빠진다.

         조상 클래스까지 함께 기록한다. 태그 이름만 모으면 `.ht-grid > div` 하나 때문에
         모든 div 가 대상이 되어 엉뚱한 곳이 걸린다(실제로 그랬다). "어느 클래스 안의
         어떤 태그인가"로 좁힌다. */
      for (const one of sel.split(',')) {
        const parts = one.trim().split(/[\s>+~]+/).filter(Boolean);
        const last = parts[parts.length - 1] ?? '';
        if (!/^[a-z]+$/.test(last)) continue;
        const anc = parts.slice(0, -1).join(' ').match(/\.([a-zA-Z][\w-]*)/g) ?? [];
        // 조상이 없는 순수 태그 규칙(label{...})은 어디서든 걸리므로 빈 조상으로 기록
        if (anc.length === 0) tagsWithDisplay.add('|' + last);
        else for (const a of anc) tagsWithDisplay.add(a.slice(1) + '|' + last);
      }
    }
    /* 짝이 있는가. 셀렉터 모양이 제각각이라(`.x[hidden]`, `.a .x[hidden]`)
       "그 클래스가 [hidden] 과 같은 셀렉터에 나오는가"로 본다. */
    const hasHiddenRule = (cls: string) =>
      new RegExp(`\\.${cls}\\b[^{,]*\\[hidden\\]|\\[hidden\\][^{,]*\\.${cls}\\b`).test(css)
      || new RegExp(`\\.${cls}\\[hidden\\]`).test(css);

    /* 화면 코드가 실제로 hidden 을 켜는 요소만 본다 — display 를 정한 클래스는 수백 개이고
       그 전부에 [hidden] 규칙을 요구할 이유는 없다. id 로 찾아 켜는 것들을 모은다. */
    const src = ['admin.ts', 'leaderboard.ts', 'pages.ts'].map(f =>
      readFileSync(join(process.cwd(), 'src', 'web', f), 'utf8')).join('\n')
      + readdirSync(join(process.cwd(), 'src', 'web', 'games', 'holdem-client'))
        .map(f => readFileSync(join(process.cwd(), 'src', 'web', 'games', 'holdem-client', f), 'utf8'))
        .join('\n');
    /* 실제로 hidden 을 "대입하는" 요소만 모은다. getElementById 로 찾기만 한 것까지 세면
       감출 생각이 없는 요소에까지 [hidden] 규칙을 요구하게 된다(실제로 그랬다). 두 모양이 있다:
         document.getElementById('x').hidden = ...
         var v = document.getElementById('x');  …  v.hidden = ... */
    const ids = new Set<string>();
    for (const m of src.matchAll(/getElementById\('([a-zA-Z][\w]*)'\)\s*\.hidden\s*=/g)) ids.add(m[1]);
    const varOf = new Map<string, string>();
    for (const m of src.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=\s*document\.getElementById\('([a-zA-Z][\w]*)'\)/g)) {
      varOf.set(m[1], m[2]);
    }
    for (const [v, id] of varOf) {
      if (new RegExp(`\\b${v}\\.hidden\\s*=`).test(src)) ids.add(id);
    }

    const pageHtml = (await get('/admin', cookie)).text + (await get('/leaderboard', cookie)).text
      + (await get('/games/holdem', cookie)).text;
    /* 판정은 클래스가 아니라 "요소" 단위다. 한 요소가 클래스를 여럿 갖고 있으면 그중
       하나만 [hidden] 규칙을 가져도 감춰진다(.hta[hidden] 이 `class="hta back"` 을 덮는다).
       클래스별로 보면 그런 요소가 전부 거짓 경보로 잡힌다 — 실제로 셋이 그랬다. */
    let checked = 0;
    const bad: string[] = [];
    /* 클래스가 없는 요소도 봐야 한다. `.ht-pre label{display:flex}` 처럼 태그로 잡는
       규칙이 있으면 그 요소에도 hidden 이 안 먹는데, 클래스만 보면 통째로 건너뛴다 —
       실제로 사전 액션 선택지 넷이 그렇게 빠져나갔다. */
    const tagHasHidden = (t: string) => new RegExp(`\\b${t}\\[hidden\\]`).test(css);

    for (const id of ids) {
      const m = pageHtml.match(new RegExp(`<([a-z]+)[^>]*\\bid="${id}"[^>]*>`));
      if (!m) continue;                         // 그 화면을 못 읽었다 — 아래 "대상이 있다"가 잡는다
      const tagName = m[1];
      const cls = m[0].match(/class="([^"]+)"/)?.[1] ?? '';
      const list = cls.split(/\s+/).filter(Boolean);
      const byClass = list.some(c => withDisplay.has(c));
      /* 클래스가 없는 요소는 "어느 클래스 안에 있는가"로 판단한다. 마크업에서 이 요소
         바로 앞에 나오는 class 를 조상으로 본다 — 생성된 마크업이라 이 근사로 충분하다. */
      const at = pageHtml.indexOf(m[0]);
      const nearCls = pageHtml.slice(0, at).match(/class="([^"]+)"(?![\s\S]*class=")/)?.[1] ?? '';
      const byTag = list.length === 0 && (
        tagsWithDisplay.has('|' + tagName)
        || nearCls.split(/\s+/).some(a => tagsWithDisplay.has(a + '|' + tagName)));
      if (!byClass && !byTag) continue;         // display 를 직접 정한 규칙이 없다
      checked++;
      const safe = list.some(c => hasHiddenRule(c)) || (byTag && tagHasHidden(tagName));
      if (!safe) bad.push(`#${id}(${cls || '<' + tagName + '>'})`);
    }
    ck('hidden 을 켜는 요소에 [hidden] 규칙이 빠지지 않았다', bad.length === 0,
      bad.length ? bad.join(', ') + ' — display 를 정해 둬서 hidden 이 안 먹는다' : '');
    // 이 검사가 실제로 무언가를 보고 있는지 (대상이 0개면 통과가 무의미하다)
    ck('검사 대상이 실제로 있다', checked > 0, `${checked}개 요소`);

    /* ── id 가 아니라 클래스로 감추는 것들 ─────────────────────────────
       위 검사는 getElementById 로 찾은 요소만 본다. app.js 는 자기가 만든 마크업을
       querySelector('.x') 로 잡아 hidden 을 켜는데, 그러면 위 그물에 걸리지 않는다 —
       채팅 도크의 본체와 안 읽은 배지가 그렇게 빠져나갔다. 둘 다 display 를 정해 둬서
       최소화 버튼이 아무 일도 안 했고, 안 읽은 줄이 없어도 "0" 배지가 늘 붙어 있었다.
       (그때도 el.hidden 은 true 였다. 그래서 속성이 아니라 규칙으로 본다.) */
    const appJs = readFileSync(join(process.cwd(), 'src', 'web', 'assets', 'app.js'), 'utf8');
    const clsIds = new Set<string>();
    // querySelector('.x').hidden = …  /  var v = …querySelector('.x'); … v.hidden = …
    for (const m of appJs.matchAll(/querySelector\('\.([\w-]+)'\)\s*\.hidden\s*=/g)) clsIds.add(m[1]);
    const clsVar = new Map<string, string>();
    for (const m of appJs.matchAll(/(?:var\s+)?([A-Za-z_$][\w$]*)\s*=\s*[\w.]*querySelector\('\.([\w-]+)'\)/g)) {
      clsVar.set(m[1], m[2]);
    }
    for (const [v, cls] of clsVar) {
      if (new RegExp(`\\b${v}\\.hidden\\s*=`).test(appJs)) clsIds.add(cls);
    }
    const clsBad: string[] = [];
    let clsChecked = 0;
    for (const cls of clsIds) {
      if (!withDisplay.has(cls)) continue;      // display 를 정해 둔 규칙이 없으면 안전하다
      clsChecked++;
      if (!hasHiddenRule(cls)) clsBad.push('.' + cls);
    }
    ck('클래스로 감추는 요소에도 [hidden] 규칙이 있다', clsBad.length === 0,
      clsBad.length ? clsBad.join(', ') + ' — display 를 정해 둬서 hidden 이 안 먹는다' : '');
    ck('클래스 쪽 검사 대상도 있다', clsChecked > 0, `${clsChecked}개 클래스`);

    /* ── <i> 는 기본이 이탤릭이다 ──────────────────────────────────
       이 프로젝트는 작은 뱃지·태그·아이콘을 <i> 로 쓴다. 의미상 강조가 아니라 그냥
       작은 조각이라 그런데, 브라우저 기본 스타일이 font-style:italic 이라 글자가
       비스듬하게 나온다. CSS 에 transform 이 하나도 없으니 코드만 봐서는 원인이
       안 보이고, 화면을 봐야만 안다 — 홀덤 말풍선이 실제로 그렇게 나갔다.
       그래서 글자가 들어가는 <i> 의 클래스에는 font-style 을 반드시 적게 한다. */
    const iSrc = appJs
      + readdirSync(join(process.cwd(), 'src', 'web', 'games', 'holdem-client'))
        .map(f => readFileSync(join(process.cwd(), 'src', 'web', 'games', 'holdem-client', f), 'utf8'))
        .join('\n');
    const iBad: string[] = [];
    let iChecked = 0;
    /* 판정은 클래스가 아니라 요소 단위다 — `class="ht-oc more"` 처럼 여럿을 달고 있으면
       그중 하나만 font-style 을 가져도 그 요소는 안 기운다. 클래스별로 보면 곁다리
       클래스가 전부 거짓 경보로 잡힌다(.more 가 실제로 그랬다). */
    const hasFontStyle = (cls: string) =>
      new RegExp(`\\.${cls}\\b[^{]*\\{[^}]*font-style`).test(css);
    for (const m of iSrc.matchAll(/<i class=\\?"([a-zA-Z][\w -]*)\\?"/g)) {
      const list = m[1].split(/\s+/).filter(Boolean);
      if (!list.length) continue;
      iChecked++;
      if (!list.some(hasFontStyle)) iBad.push(m[1]);
    }
    ck('글자가 들어가는 <i> 에 font-style 이 정해져 있다', iBad.length === 0,
      iBad.length ? Array.from(new Set(iBad)).join(', ') + ' — <i> 기본값이 이탤릭이라 기울어 나온다' : '');
    ck('<i> 검사 대상도 있다', iChecked > 0, `${iChecked}개`);
  }

  console.log('\n[3] 대회가 없을 때의 홀덤 화면');
  {
    const ht = (await get('/games/holdem', cookie)).text;
    ck('빈 상태를 그리는 함수가 실려 있다', ht.includes('function renderNoTournament()'));
    ck('대회가 없으면 그 함수로 넘어간다', ht.includes('if (!t) { renderNoTournament(); return; }'));
    ck('안내 문구가 스펙 그대로다', ht.includes('현재 예정된 토너먼트가 없습니다.'));
    ck('다음 안내가 붙는다', ht.includes('다음 공지사항을 확인해 주세요!'));
    ck('지난 대회 카드를 그린다', ht.includes('ht-recap') && ht.includes('지난 대회'));
    ck('다음 대회 배너를 그린다', ht.includes('ht-next') && ht.includes('다음 대회'));
    /* 시각을 문구에 박아 두지 않는다 — 운영자가 정하게 된 뒤로 21:00/22:00 은
       사실이 아니게 됐다. 서버가 준 실제 시각에서 뽑아 쓴다. */
    ck('고정 시각 문구가 남아 있지 않다',
      !ht.includes('등록 21:00 · 시작 22:00') && !ht.includes('KST 21:00'));
    ck('빈 상태 CSS 가 app.css 에 있다',
      (await get('/app.css', cookie)).text.includes('.ht-empty'));
    // 로비(대시보드)도 없는 일정을 지어내지 않는다
    const home = (await get('/', cookie)).text;
    ck('대시보드가 매일 22:00 을 주장하지 않는다', !home.includes('매일 22:00'));
  }

  /* ── 음량 ──────────────────────────────────────────────────────────
     소리를 내는 길이 여럿이라(샘플 재생 · 합성음 · 노이즈) 새 소리를 넣는 날 한 곳만
     빠뜨리면 그 소리만 슬라이더를 무시한다. 그런 실수는 귀로만 드러나므로 검사로 못 박는다:
     destination 에 직접 꽂는 곳은 마스터 노드 하나뿐이어야 한다. */
  console.log('\n[4] 음량 — 모든 소리가 마스터를 지나는가');
  {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const app = readFileSync(join(process.cwd(), 'src', 'web', 'assets', 'app.js'), 'utf8');

    const toDest = [...app.matchAll(/\.connect\(\s*c\.destination\s*\)/g)].length;
    const masterToDest = [...app.matchAll(/masterGain\.connect\(\s*c\.destination\s*\)/g)].length;
    ck('destination 으로 바로 나가는 소리가 없다', toDest === masterToDest && masterToDest === 1,
      `직결 ${toDest} · 마스터 ${masterToDest}`);
    ck('소리들은 master(c) 로 모인다',
      [...app.matchAll(/\.connect\(\s*master\(c\)\s*\)/g)].length >= 4);
    ck('마스터 크기가 저장된 값에서 온다', /masterGain\.gain\.value = masterLevel\(\)/.test(app));
    // 슬라이더를 움직이는 동안 이미 울리는 소리도 따라와야 한다
    ck('움직이는 중에도 반영된다', /setTargetAtTime\(masterLevel\(\)/.test(app));

    /* 음소거와 크기를 따로 기억해야 껐다 켤 때 원래 크기로 돌아온다.
       하나로 합치면 "끄기 = 0" 이 되어 직전 값을 잃는다. */
    ck('음소거와 크기를 따로 저장한다',
      /VOL_KEY = 'od_vol'/.test(app) && /SFX_KEY = 'od_sfx'/.test(app)
      && /localStorage\.setItem\(VOL_KEY/.test(app));
    ck('저장값이 0~1 밖이면 버린다', /stored >= 0 && stored <= 1/.test(app));
    ck('0 으로 내리면 음소거로 본다', /sfxOn = v > 0/.test(app));
    ck('0% 에서 켜면 들리는 크기로 올린다', /sfxOn && vol <= 0\) vol = VOL_HALF/.test(app));
    // 0이면 오디오 컨텍스트를 아예 열지 않는다(음원도 안 받는다)
    ck('꺼져 있으면 컨텍스트를 안 연다', /masterLevel\(\) <= 0\) return null/.test(app));

    const head = (await get('/', cookie)).text;
    ck('머리에 슬라이더가 있다', head.includes('id="sfxRange"') && head.includes('type="range"'));
    ck('0~100 범위다', /id="sfxRange"[^>]*min="0"[^>]*max="100"/.test(head));
    ck('퍼센트를 적는다', head.includes('id="sfxPct"'));
    /* 사람마다 다른 값을 서버가 내려보내면 모든 페이지가 같은 머리를 쓰는 구조에서
       산출물이 사람마다 달라진다(golden). 저장값은 app.js 가 채운다. */
    ck('서버는 늘 같은 값을 내려보낸다', /id="sfxRange"[^>]*value="100"/.test(head));
    ck('아이콘 셋을 다 그려 둔다',
      head.includes('class="i-hi"') && head.includes('class="i-lo"') && head.includes('class="i-off"'));

    const css = (await get('/app.css', cookie)).text;
    ck('큰 소리·작은 소리·음소거가 각각 다른 아이콘이다',
      /html\.sfx-low \.sfxbtn \.i-lo\{display:block\}/.test(css)
      && /html\.sfx-off \.sfxbtn \.i-off\{display:block\}/.test(css));
    /* opacity 만 0 으로 두면 안 보이는 채로 클릭을 먹는다 — 헤더 위에 투명한 판이 덮인다 */
    ck('접힌 슬라이더는 클릭도 안 먹는다', /\.volpop\{[^}]*visibility:hidden/.test(css));
    /* 예전에는 셋을 한 줄에 묶어(:hover, :focus-within, .open) 그 «묶음» 을 정규식으로
       확인했다. 지금은 hover 를 (hover:hover) 안에 넣어 갈라 두었으므로 각각을 본다 —
       손가락에는 hover 가 누른 뒤에도 붙어 있어서, 한 번 연 바가 다시 눌러도 안 닫혔다.
       마우스는 hover 로, 손가락은 .open 으로 편다. 둘 다 있어야 통과다. */
    const flat = css.replace(/\s+/g, ' ');
    ck('마우스와 손가락 둘 다 펼 수 있다',
      /@media \(hover:hover\)\{ ?\.volwrap:hover \.volpop\{[^}]*visibility:visible/.test(flat)
      && /\.volwrap\.open \.volpop\{[^}]*visibility:visible/.test(flat));
    /* 손가락으로 연 바는 손가락으로 닫혀야 한다. 닫을 때 초점을 떼지 않으면 눌린 단추가
       계속 :focus 라, 키보드용 규칙이 방금 닫은 바를 도로 열어 둔다. */
    ck('다시 누르면 닫힌다', /if \(onBtn\) w\.classList\.toggle\('open'\);/.test(app)
      && /if \(b && b\.blur\) b\.blur\(\);/.test(app));
  }

  /* ── 공지 웹훅 ─────────────────────────────────────────────────────
     새 공지가 올라가면 디스코드 채널로 알린다. 여기서 확인할 것은 두 가지다:
     임베드 모양이 규격을 지키는가, 그리고 이 알림이 공지 저장을 절대 방해하지 않는가.
     두 번째가 더 중요하다 — 웹훅이 죽었는데 공지 등록이 실패하면 운영자는 같은 글을
     두 번 올리게 되고, 두 번째는 duplicate 로 거절당해 무슨 일인지 알 수 없다. */
  console.log('\n[5] 공지 웹훅 — 모양과 안전장치');
  {
    const AN = require('../src/discord/announce') as typeof import('../src/discord/announce');
    const N = require('../src/db/notices') as typeof import('../src/db/notices');
    const { readFileSync } = require('node:fs') as typeof import('node:fs');

    // 2026-08-10 09:05 KST
    const at = Date.UTC(2026, 7, 10, 0, 5, 0);
    const e = AN.announceEmbed(
      { id: 'x-1', kind: '업데이트', title: '제목', summary: '한 줄 요약' }, at) as any;
    const em = e.embeds[0];
    ck('제목이 [태그] 제목 이다', em.title === '[업데이트] 제목', String(em.title));
    /* 이 서비스의 제목은 관례상 이미 태그를 달고 있다. 앞에 무조건 붙이면 두 번 붙는다 —
       실제로 `[업데이트] [업데이트] …` 가 채널과 알림함에 나갔다. */
    const dup = AN.announceEmbed(
      { id: 'x-3', kind: '업데이트', title: '[업데이트] 제목', summary: 's' }, at) as any;
    ck('태그가 두 번 붙지 않는다', dup.embeds[0].title === '[업데이트] 제목',
      String(dup.embeds[0].title));
    ck('설명이 요약이다', em.description === '한 줄 요약', String(em.description));
    ck('색이 시그니처 골드다', em.color === 0xd4af37, String(em.color));
    ck('작성일시가 KST 다', em.fields[0].value === '2026-08-10 09:05',
      `${em.fields[0].name}=${em.fields[0].value}`);
    ck('공지 상세로 가는 링크가 있다', String(em.url).endsWith('/notices/x-1'), String(em.url));
    ck('본문에도 같은 링크가 있다', String(e.content).includes('/notices/x-1'));
    ck('푸터가 규격대로다', em.footer.text === 'OD CASINO Official Announcement', em.footer.text);
    /* 푸터 아이콘. 디스코드 임베드는 SVG 를 그리지 않는다 — /favicon.svg 를 넣었다가
       채널에 깨진 그림이 남았다. 그래서 raster 파일이 있을 때만 붙인다. */
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    const hasLogo = existsSync('public/img/logo.png');
    ck('푸터 아이콘은 파일이 있을 때만 붙는다',
      hasLogo ? String(em.footer.icon_url).endsWith('/img/logo.png') : !('icon_url' in em.footer),
      `logo.png ${hasLogo ? '있음' : '없음'} · icon_url=${String(em.footer.icon_url)}`);
    ck('SVG 를 아이콘으로 쓰지 않는다', !String(em.footer.icon_url ?? '').endsWith('.svg'));
    if (hasLogo) {
      /* 파일이 있어도 서버가 내보내지 않으면 디스코드에는 여전히 깨진 그림이 남는다.
         화이트리스트와 MIME 둘 다 필요하다 — png 가 MIME 표에 없으면
         application/octet-stream 으로 나가고, 디스코드는 그걸 이미지로 그리지 않는다
         (404 도 아니고 200 인데 안 보이는 종류의 실패다). */
      const srvSrc = readFileSync('src/web/server.ts', 'utf8') as string;
      ck('로고가 서버 화이트리스트에 있다', /IMG_FILES = new Set\(\[[^\]]*'logo\.png'/.test(srvSrc));
      ck('png MIME 이 있다', /png: 'image\/png'/.test(srvSrc));
      const png = readFileSync('public/img/logo.png');
      ck('로고가 온전한 PNG 다',
        png.slice(0, 8).toString('hex') === '89504e470d0a1a0a'
        && png.slice(-8, -4).toString('ascii') === 'IEND',
        `${png.length}B`);
      ck('로고가 정사각형이다',
        png.readUInt32BE(16) === png.readUInt32BE(20) && png.readUInt32BE(16) >= 128,
        `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
    }
    /* 공지 제목에 @everyone 이 들어가면 그대로 전체 멘션이 나간다 — 글 쓴 사람이
       의도한 것이 아니다. 웹훅이 멘션을 만들지 못하게 막아 둔다. */
    ck('멘션을 만들지 않는다', Array.isArray(e.allowed_mentions?.parse)
      && e.allowed_mentions.parse.length === 0, JSON.stringify(e.allowed_mentions));
    /* 요약은 필수 항목이 아니다. 빈 문자열을 description 에 넣으면 디스코드가 400 을 준다. */
    const noSum = AN.announceEmbed({ id: 'x-2', kind: '점검', title: 'T', summary: '' }, at) as any;
    ck('요약이 없으면 설명을 아예 뺀다', !('description' in noSum.embeds[0]),
      JSON.stringify(noSum.embeds[0].description));

    const src = readFileSync('src/discord/announce.ts', 'utf8') as string;
    ck('URL 이 없으면 건너뛴다',
      /if \(!hook\)[\s\S]{0,200}return \{ ok: false, skipped: true \};/.test(src));
    ck('건너뛴 사실을 로그로 남긴다', src.includes('건너뜀'));
    /* 기다리지 않고 던지지도 않는다. await 를 붙이면 공지 저장이 웹훅 왕복만큼 늦어지고,
       catch 가 없으면 실패가 트랜잭션 밖으로 튀어나간다. */
    /* 공지 저장 쪽에서 부르는 문은 기다리지 않는다. await 를 붙이면 공지 등록이 웹훅
       왕복만큼 늦어지고, 실패가 트랜잭션 밖으로 튀어나간다. */
    ck('기다리지 않는다 (void)', /export function announceNotice[\s\S]{0,200}void sendAnnounce\(/.test(src));
    ck('실패를 삼킨다 (던지지 않는다)', /catch \(e: unknown\)[\s\S]{0,120}return \{ ok: false/.test(src));
    ck('응답 없는 웹훅에 매달리지 않는다', /AbortSignal\.timeout\(/.test(src));
    /* 기다릴 수 있는 모양도 있어야 한다 — 운영 도구는 결과를 봐야 하고, 기다리지 않으면
       스크립트가 요청이 나가기도 전에 끝난다. */
    ck('기다릴 수 있는 문도 있다', /export async function sendAnnounce/.test(src));
    const tool = readFileSync('scripts/announce-notice.ts', 'utf8') as string;
    ck('다시 보내는 도구가 결과를 기다린다', /await sendAnnounce\(/.test(tool));
    /* 그 도구는 알림만 보낸다 — 공지를 지우고 다시 만들면 앱 안 알림이 한 번 더 쌓이고
       목록 순서(sort_at)도 바뀐다. 읽는 함수만 들여오는지를 import 줄에서 본다
       (본문에서 이름을 찾으면 위 주석의 설명 문장에 걸린다 — 실제로 걸렸다). */
    const dbImport = (tool.match(/import \{([^}]*)\} from '\.\.\/src\/db\/notices'/)?.[1] ?? '')
      .split(',').map(s => s.trim()).filter(Boolean);
    /* 쓰기 함수를 들여오지 않는지를 본다. 읽기·문자열 만드는 함수는 늘어날 수 있으므로
       목록을 못 박지 않고, "쓰는 것"만 금지한다. */
    const WRITES = ['createNotice', 'updateNotice', 'toggleNotice', 'deleteNotice', 'seedNoticesOnce'];
    ck('그 도구는 쓰기 함수를 안 들여온다',
      dbImport.length > 0 && !dbImport.some(x => WRITES.includes(x)), dbImport.join(','));
    ck('숨긴 글은 다시 보내지 않는다', /findNotice\(/.test(tool));

    const nsrc = readFileSync('src/db/notices.ts', 'utf8') as string;
    /* 신규 생성에만 붙는다. 수정에 붙으면 오타를 세 번 고칠 때 채널에 네 번 올라온다. */
    const iCreate = nsrc.indexOf('export function createNotice');
    const iUpdate = nsrc.indexOf('export function updateNotice');
    const iCall = nsrc.indexOf('announceNotice({');
    ck('신규 생성에서만 부른다', iCall > iCreate && iCall < iUpdate,
      `create=${iCreate} call=${iCall} update=${iUpdate}`);
    ck('수정·삭제에서는 안 부른다',
      nsrc.slice(iUpdate).indexOf('announceNotice') < 0);
    // 숨김으로 올린 글은 알리지 않는다 — 전체 알림과 같은 기준이어야 한다
    ck('숨긴 글은 알리지 않는다', /if \(n\.active\) \{[\s\S]{0,700}announceNotice\(/.test(nsrc));

    /* 진짜로 저장을 막지 않는가. 웹훅 URL 을 살아 있지 않은 주소로 두고 공지를 만든다 —
       전송은 반드시 실패하고, 그래도 글은 들어가 있어야 한다. */
    const before = process.env.DISCORD_ANNOUNCEMENT_WEBHOOK_URL;
    process.env.DISCORD_ANNOUNCEMENT_WEBHOOK_URL = 'http://127.0.0.1:1/nope';
    const made = N.createNotice({
      id: 'audit-hook-1', date: '2026-08-10', kind: '점검', title: '웹훅 검사',
      summary: '', sections: [{ heading: '본문', paras: ['한 줄'] }], active: true,
    });
    ck('웹훅이 죽어도 공지는 등록된다', made.ok, JSON.stringify(made));
    ck('실제로 표에 들어갔다', !!N.listNoticesAdmin().find(x => x.id === 'audit-hook-1'));
    process.env.DISCORD_ANNOUNCEMENT_WEBHOOK_URL = before;
    // 환경변수 이름이 요청서와 같은가 — 다르면 운영자가 넣어도 아무 일이 안 일어난다
    ck('환경변수 이름이 문서와 같다',
      src.includes('DISCORD_ANNOUNCEMENT_WEBHOOK_URL')
      && readFileSync('.env.example', 'utf8').includes('DISCORD_ANNOUNCEMENT_WEBHOOK_URL'));

    /* 앱 안 알림도 같은 함수를 지나야 한다 — 디스코드만 고치면 알림함에는 여전히
       태그가 두 번 붙는다(그게 실제로 일어난 일이다). */
    ck('태그를 붙이는 곳이 하나다', /taggedTitle\(n\.kind, n\.title\)/.test(nsrc));
    ck('알림 문구를 손으로 잇지 않는다', !/`\[\$\{n\.kind\}\] \$\{n\.title/.test(nsrc));
    ck('이미 태그가 있으면 그대로 쓴다', N.taggedTitle('시즌', '[시즌] 가') === '[시즌] 가');
    ck('없으면 붙인다', N.taggedTitle('시즌', '가') === '[시즌] 가');
    ck('다른 태그로 시작하면 붙인다', N.taggedTitle('시즌', '[신규] 가') === '[시즌] [신규] 가');

    /* 알림함에 이미 들어간 두 번 붙은 줄도 고친다. 만드는 쪽만 고치면 사람들 화면에는
       그대로 남는다 — 스키마를 세우는 자리에서 접두사만 바꾼다. */
    const sch = readFileSync('src/db/schema.ts', 'utf8') as string;
    ck('지난 알림의 중복 태그를 고친다',
      /REPLACE\(message, \?, \?\)[\s\S]{0,120}type = 'ANNOUNCEMENT'/.test(sch));
    ck('그 모양인 줄에만 손댄다', /message LIKE \?/.test(sch));
  }

  /* ── 머신에서 돌리는 스크립트 ──────────────────────────────────────
     .dockerignore 로 이미지에 넣은 스크립트는 운영 머신에서 tsx 로 돌린다. tsx 는 이것을
     cjs 로 바꿔 실행하므로 최상위 await 가 있으면 그 자리에서 죽는다:
       "Top-level await is currently not supported with the cjs output format"
     로컬에서는 안 보이고 운영에서 처음 드러난다(실제로 그렇게 죽었다). 그래서 검사로 만든다.
     async main() 으로 감싸면 된다. */
  console.log('\n[6] 머신에서 돌리는 스크립트 — 최상위 await 금지');
  {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const ignore = readFileSync('.dockerignore', 'utf8') as string;
    const shipped = [...ignore.matchAll(/^!(scripts\/[\w.-]+\.ts)$/gm)].map(m => m[1]);
    ck('이미지에 들어가는 스크립트를 찾았다', shipped.length >= 5, shipped.join(' '));
    for (const f of shipped) {
      /* 주석과 문자열을 걷어내고 본다 — 설명문에 "await" 가 들어 있으면 거짓 경보가 난다.
         함수 안의 await 는 앞에 들여쓰기가 붙으므로, 줄 맨 앞에서 시작하는 것만 본다. */
      const body = (readFileSync(f, 'utf8') as string)
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      ck(`${f} 에 최상위 await 가 없다`,
        !/^await\s/m.test(body) && !/^(?:const|let|var)\s[^=\n]*=\s*await\s/m.test(body));
    }
  }

  /* ── 지뢰찾기 퍼펙트 클리어 ────────────────────────────────────────
     안전 칸을 하나도 남기지 않고 다 열면 그 자리에서 자동 정산된다. 그런데 화면이
     그 결과를 반영하지 않아, 배당·획득 칸이 직전 값(지뢰 24개 판이면 1.00x·0P)에
     멈춰 있었다 — 이 게임에서 가장 큰 순간에 "아무 일도 없었다"고 적혀 있었다. */
  console.log('\n[7] 지뢰찾기 — 퍼펙트 클리어');
  {
    const { readFileSync, readdirSync } = require('node:fs') as typeof import('node:fs');
    const mn = readFileSync('src/web/games/mines.ts', 'utf8') as string;
    const auto = mn.slice(mn.indexOf('res.data.autoCashedOut'), mn.indexOf('} else {', mn.indexOf('res.data.autoCashedOut')));

    ck('자동 정산 자리에서 배당·획득을 갱신한다', /updateStats\(round\)/.test(auto), auto.slice(0, 120));
    /* 예전에는 이 검사가 "베팅액 × 배수" 를 화면에서 다시 곱하라고 요구했다. 그런데
       그 배수는 네 자리로 자른 표시용 값이라, 곱한 결과가 실제로 나가는 금액과
       몇 P 씩 달랐다 — 검사 이름이 말하는 "서버가 준 최종값" 과 정반대다.
       이제 서버가 나갈 금액(potAmount)을 그대로 실어 보내고 화면은 그것만 적는다. */
    ck('갱신에 쓰는 값이 서버가 준 최종값이다',
      /multiEl\.textContent = round\.multiplier/.test(mn) && /round\.potAmount/.test(mn));
    ck('화면이 금액을 스스로 다시 곱하지 않는다',
      !/potEl\.textContent = fmt\(round\.betAmount \* round\.multiplier\)/.test(mn));
    ck('남은 칸의 지뢰를 공개한다', /revealAllMines\(round\)/.test(auto));
    ck('터진 지뢰와 다른 모양이다 (.dud)', /classList\.add\('dud'\)/.test(mn));
    const css4 = readFileSync('src/web/assets/css/04-board.css', 'utf8') as string;
    ck('.dud 스타일이 붉지 않다',
      /\.mines-tile\.dud\{[^}]*background:#17171a/.test(css4),
      (css4.match(/\.mines-tile\.dud\{[^}]*\}/) ?? [''])[0].slice(0, 90));

    ck('네온 카드를 띄운다', /perfectCard\(round\)/.test(auto) && css4.includes('.mn-perfect{'));
    ck('카드에 지뢰 수·배당·획득이 다 있다',
      /지뢰 ' \+ round\.mineCount \+ '개 완파/.test(mn)
      && /최종 배당[\s\S]{0,80}round\.multiplier\.toFixed\(2\)/.test(mn)
      && /획득[\s\S]{0,80}fmt\(round\.payout\)/.test(mn));
    /* 이모지를 쓰지 않는다(요청 사항). OS 마다 모양과 크기가 달라 정렬이 무너지고,
       이 화면의 다른 그림은 전부 선 아이콘이다. */
    const cardMarkup = mn.slice(mn.indexOf("el.className = 'mn-perfect'"), mn.indexOf('stage.appendChild(el)'));
    ck('카드에 이모지가 없다',
      !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(cardMarkup), cardMarkup.slice(0, 80));

    ck('폭죽이 캔버스로 그려진다',
      /confetti\(\)/.test(auto) && /getContext\('2d'\)/.test(mn) && css4.includes('.mn-confetti{'));
    ck('폭죽이 1.5초만 돈다', /var DUR = 1500/.test(mn));
    ck('폭죽이 클릭을 막지 않는다', /\.mn-confetti\{[^}]*pointer-events:none/.test(css4));
    ck('움직임을 줄인 사람에게는 안 띄운다', /prefers-reduced-motion: reduce/.test(mn));
    ck('새 판을 시작하면 카드를 치운다', /querySelector\('\.mn-perfect'\)[\s\S]{0,80}removeChild/.test(mn));

    ck('퍼펙트 전용 음원을 쓴다', /casinoSfx\.minePerfect\(\)/.test(auto));
    const app2 = readFileSync('src/web/assets/app.js', 'utf8') as string;
    ck('그 음원이 선언돼 있다',
      /mineperfect: \['mine-perfect'\]/.test(app2) && /minePerfect: function/.test(app2));
    ck('한 번에 하나만 울린다', /mineperfect: 1/.test(app2));
    ck('지뢰찾기 화면이 그 음원을 받아 둔다', /__SFX_NEED__ = \['minecoin','explode','gain','mineperfect'\]/.test(mn));

    /* ── 음량 표에 빠진 음원이 없는가 ────────────────────────────
       SFX_NORM 은 파일마다 체감 음량을 맞추는 보정값이다. 표에 없으면 보정 없이(1.0)
       나가는데, 그게 실제로 사고였다: clock-warn 이 다른 소리보다 19dB 낮아 게임 소리에
       완전히 묻혀 있었다(남은 시간 5초 경고가 안 들렸다). 새 음원을 넣을 때 표에 적는
       것을 잊지 않도록 파일 목록에서 직접 확인한다. */
    const files = readdirSync('public/sfx').filter(f => /\.(mp3|wav)$/.test(f));
    ck('음원 파일을 찾았다', files.length >= 20, String(files.length));
    for (const f of files) {
      const key = f.replace(/\.(mp3|wav)$/, '');
      ck(`${key} 이 확장자 표에 있다`, new RegExp(`'${key}'\\s*:\\s*'(mp3|wav)'`).test(app2));
      ck(`${key} 이 음량 표에 있다`, new RegExp(`'${key}'\\s*:\\s*[\\d.]+`).test(app2));
      ck(`${key} 이 서버 화이트리스트에 있다`,
        (readFileSync('src/web/server.ts', 'utf8') as string).includes(`'${f}'`));
    }
  }

  /* ── 홀덤 팟 배분 연출 ─────────────────────────────────────────────
     멀티웨이 올인에서 층마다 승자가 다르면 팟을 순서대로 하나씩 보낸다. 그때 이미 보낸
     상자가 다시 집혀, 승자에게 도착한 메인 팟 칩과 금액 배지가 중앙에 되살아나 다음 층과
     붙어 이동했다(제보). .paid 는 opacity:0 일 뿐 DOM 에 남아 있고, 마지막 층이
     "남은 것 전부"를 집을 때 그것까지 가져갔기 때문이다. */
  /* ── 지뢰찾기 규칙 표 ──────────────────────────────────────────────
     "전부 열면 52,598배"가 버그로 읽힌다는 제보를 받았다. 숫자는 정확했지만 확률이 안
     적혀 있어서, 큰 금액이 아무 근거 없이 튀어나온 것처럼 보였다. 배수는 확률의 역수이니
     둘을 나란히 두면 서로를 설명한다. */
  console.log('\n[7b] 지뢰찾기 규칙 표 — 배수와 확률을 함께 적는다');
  {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const mn = readFileSync('src/web/games/mines.ts', 'utf8') as string;
    const page = (await get('/games/mines', cookie)).text;

    /* 숫자를 손으로 적지 않는다 — 하우스 엣지나 판 크기를 고치는 날 규칙만 옛 숫자로
       남는다. 실제로 지뢰 10개 줄은 전부 열기 값이 아예 빠져 있었다. */
    ck('표를 calcMultiplier 로 만든다', /MINE_RULE_ROWS = ALLOWED_MINE_COUNTS\.map/.test(mn));
    ck('배수를 문자열로 박아 두지 않았다',
      !/전부 열면 24\.75배/.test(mn) && !/한 칸 1\.03배/.test(mn));
    /* 확률의 분모를 배수에서 되돌려 구한다 — 조합 함수를 따로 두면 같은 수를 두 방법으로
       계산하게 되고 언젠가 갈라진다. */
    ck('확률을 배수에서 되돌려 구한다', /full \/ \(1 - HOUSE_EDGE\)/.test(mn));

    // 다섯 줄이 다 있고, 각 줄에 배수와 확률이 함께 있다
    for (const [mine, mult, odds] of [
      ['1개', '24.75배', '1/25'],
      ['3개', '2,277배', '1/2,300'],
      ['5개', '52,599배', '1/53,130'],
      ['10개', '3,236,072배', '1/3,268,760'],
      ['24개', '24.75배', '1/25'],
    ]) {
      ck(`지뢰 ${mine} 줄에 배수와 확률이 있다`,
        page.includes(mult) && page.includes(odds), `${mult} · ${odds}`);
    }
    /* 지뢰 10개는 예전에 전부 열기 값이 없었다 — 그 자리가 비어 있으면 표가 고장난 것으로
       보이고, 실제로 그것도 "버그 같다"의 일부였다. */
    ck('지뢰 10개도 전부 열기 값이 있다', page.includes('3,236,072배'));
    ck('도달 가능한 구간도 함께 보여준다', page.includes('10칸'));
    /* 납득을 만드는 문장 — 지뢰 1개와 24개가 같은 배수인 이유. 이 대칭이 "배수는 어려움만
       따라간다"를 한눈에 설명한다. */
    ck('1개와 24개가 같은 배수임을 설명한다',
      page.includes('어려움이 같으면 배수도 같습니다'));
    ck('배수가 확률의 역수라고 적혀 있다', page.includes('성공 확률의 역수'));
  }

  /* ── 홀덤 로비 카드 순서 ───────────────────────────────────────────
     "다음 대회 → 지난 대회 → 지금은 진행 중인 대회가 없습니다" 순서가 이상하다는 제보.
     마지막 카드가 하는 말은 첫 카드가 이미 다 하고 있었고, 그 안의 "위 시각"이 가리키는
     카드가 두 칸 위였다. */
  console.log('\n[7c] 홀덤 로비 — 빈 상태 카드는 예정이 없을 때만');
  {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const lb = readFileSync('src/web/games/holdem-client/lobby.ts', 'utf8') as string;
    ck('예정이 있으면 빈 카드를 안 띄운다', /if \(!up\) \{/.test(lb));
    ck('예정이 없을 때는 맨 위에 세운다', /'<\\\/div>' \+ html;/.test(lb));
    /* "위 시각에" 는 가리킬 카드가 두 칸 위였다 — 문구 자체를 없앴다.
       주석에는 그 옛 문구가 인용돼 있으므로(왜 없앴는지 적어 두었다) 소스 전체가 아니라
       화면에 나가는 문자열 리터럴만 본다. */
    ck('위 시각 안내가 사라졌다', !/'위 시각에 등록이 열립니다\.'/.test(lb));
    ck('진행 중 없음 문구도 사라졌다', !/'지금은 진행 중인 대회가 없습니다\.'/.test(lb));
    // 예정이 없을 때의 문구는 그대로 남아야 한다(그때는 이 카드가 유일한 안내다)
    ck('예정 없음 문구는 남아 있다', lb.includes('현재 예정된 토너먼트가 없습니다'));
  }

  console.log('\n[8] 홀덤 팟 배분 — 보낸 팟은 다시 집지 않는다');
  {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const se = readFileSync('src/web/games/holdem-client/settle.ts', 'utf8') as string;
    const tb = readFileSync('src/web/games/holdem-client/table.ts', 'utf8') as string;

    ck('보낸 상자를 선택에서 뺀다', se.includes(`querySelectorAll('.ht-pg:not(.paid)')`));
    ck('옛 선택자가 남아 있지 않다', !/querySelectorAll\('\.ht-pg'\)/.test(se));
    /* 한 겹 더: 접히는 연출이 끝나면 DOM 에서 지운다 — 남아 있지 않으면 다시 집는 일이
       원리적으로 불가능해진다. */
    ck('접힌 뒤 DOM 에서 지운다',
      /classList\.add\('paid'\)[\s\S]{0,320}removeChild\(b\)/.test(se));
    ck('지우는 시점이 연출 길이와 같다',
      /PILE_FADE_MS = 500/.test(se)
      && /\.ht-pg\.paid\{/.test(readFileSync('src/web/assets/css/09-holdem.css', 'utf8') as string));
    // 마지막 층은 여전히 "아직 안 보낸 것 전부"를 집어야 한다(층 번호가 안 맞는 잔여 더미 정리)
    ck('마지막 층은 남은 것 전부를 집는다', /if \(last\) return true;/.test(se));

    /* Total Pot 은 층마다 줄고 마지막에 정확히 0 이 된다. 서버가 주는 tb.pot 은 판이 끝난
       뒤에도 총액 그대로라, 폴링이 이 값을 덮어쓰면 줄어든 숫자가 곧 총액으로 되살아난다. */
    ck('층마다 팟 표시를 깎는다', /potShown = last \? 0 : Math\.max\(0, potShown - \(pa\.amount \|\| 0\)\)/.test(se));
    ck('마지막 층에서 정확히 0 이 된다', /last \? 0 :/.test(se));
    ck('폴링이 그 값을 덮지 않는다',
      /potShownHand === tb\.handNo \? potShown : tb\.pot/.test(tb));
    ck('판이 바뀌면 서버 값으로 돌아간다', /potShown = 0, potShownHand = null/.test(se));
  }

  console.log('\n[9] 블랙잭 칩 더미 — 지운 칩이 되살아나지 않는다');
  {
    /* 제보된 버그: 동전(10·100·500)을 올리고 Clear Screen 한 뒤 같은 자리에 골드바를
       올리면, 서버 금액은 1000P 인데 화면에는 옛 동전 셋이 다시 나타났다.

       경로 (실측으로 확인):
         1. 동전 셋 → piles[2] = { bet: 610, list: [10,100,500] }
         2. Clear → 그 좌석이 st.seats 에서 빠진다 → 칸(#bjp-2)이 사라지고, syncPile 이
            그 좌석에 대해 아예 돌지 않아 piles[2] 가 옛 기록 그대로 남는다
         3. 골드바 클릭 → dropMyChip 이 칸을 못 찾아(요소가 없다) 조용히 돌아간다
         4. 다음 폴링 → s.bet(1000) > pile.bet(610) 이라 "줄었다" 로 안 잡히고,
            내 좌석이라 그리기를 건너뛴다 → 그 다음 폴링에서 paintPile 이 옛 목록을 복원

       그래서 두 곳을 막는다: 빠진 좌석의 기록을 버리고(원인), 그려진 합이 서버 금액과
       다르면 무조건 다시 그린다(경로 무관 안전망). */
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const ch = readFileSync('src/web/games/blackjack-client/chips.ts', 'utf8') as string;
    const se2 = readFileSync('src/web/games/blackjack-client/seats.ts', 'utf8') as string;
    ck('빠진 좌석의 칩 기록을 버린다', /function dropStalePiles\(seats\)/.test(ch)
      && /for \(var k in piles\) if \(!live\[k\]\) delete piles\[k\]/.test(ch));
    ck('좌석 루프보다 먼저 버린다', /dropStalePiles\(st\.seats \|\| \[\]\);/.test(se2)
      && se2.indexOf('dropStalePiles') < se2.indexOf('syncPile(s, r.id)'));
    /* pile.bet 은 "올렸다고 믿는 금액"이고 pileSum 은 "실제로 화면에 있는 금액"이다.
       둘이 어긋나는 경로가 있었으므로 안전망은 그 «둘» 을 견줘야 한다.
       한때 이 검사가 pileSum 을 서버 금액(s.bet)과 견주도록 못 박고 있었다. 그러면 남이
       «더» 걸 때마다 안전망에 걸린다 — 그려진 합은 아직 옛 금액이고 서버는 새 금액이니
       당연히 다르다. 그래서 칩을 날리는 갈래에 영영 못 갔고, 남의 베팅은 조용히 다시
       그려지기만 했다(실측: 남의 금액 52번 변화, 날아간 칩 0개).
       서버와의 차이는 안전망이 아니라 바로 아래 delta 가 다룰 일이다. */
    ck('그려진 칩의 합으로 판단한다', /function pileSum\(pile\)/.test(ch)
      && /if \(pileSum\(pile\) !== pile\.bet\) return rebuildPile/.test(ch));
    ck('합이 어긋나면 delta 계산보다 먼저 다시 그린다',
      ch.indexOf('pileSum(pile) !== pile.bet') < ch.indexOf('var delta = s.bet - pile.bet'));
    /* 남이 건 것이 지켜보는 동안 새로 나타났으면 날려서 보여 준다.
       대개 라운드마다 한 번에 걸므로 그 자리를 처음 보는 순간이 곧 그 금액이고,
       그때는 delta 갈래가 아니라 rebuildPile 로 온다 — 거기에 이 갈래가 없어서
       남의 베팅은 한 번도 안 날았다. */
    ck('남의 베팅도 날아온다', /var arrived = drewOnce && owner !== MEID/.test(ch)
      && ch.includes('if (arrived) { tossFrom(rosterAvatar(owner), added); betSfx(); }'));
    /* 페이지에 막 들어와 이미 걸려 있던 것은 방금 일어난 일이 아니다 — 그건 그냥 그린다.
       판정 근거는 "자리를 한 바퀴 다 그려 봤나" 여야 한다. 한때 "다른 자리가 이 라운드로
       그려져 있나" 였는데, 그러면 그 라운드에서 가장 먼저 도는 자리는 아직 아무도 안
       그려져 있어 늘 조용히 지나갔다(실측: 다섯 자리가 걸었는데 날아온 자리는 넷). */
    ck('이미 걸려 있던 것은 안 날린다', /var drewOnce = false;/.test(ch)
      && /drewOnce = true;/.test(se2));
    ck('첫 자리도 날아온다 — 자리 순서를 안 본다', !ch.includes('.round === roundId) { watching'));
    /* 날아가는 복제본은 정원(正圓)이어야 한다. 크기를 인라인 width 로만 지정하면 CSS 의
       min-width:21px 이 이겨서 폭만 21px 로 버티고 높이는 줄어든 값이 된다(실측 55×34). */
    for (const g of ['blackjack', 'baccarat', 'poker']) {
      const src = readFileSync('src/web/games/' + g + '-client/chips.ts', 'utf8') as string;
      const flat = src.split(' ').join('');
      ck(g + ' — 날아가는 칩은 min-width 도 덮어쓴다',
        flat.includes('min-width:') && flat.includes('min-height:'));
    }
    /* 복원은 반드시 기록 목록 기준이어야 한다 — 총액을 다시 쪼개면 500 두 개가 1000 한 개로
       합쳐져서 "올린 그대로"가 아니게 된다. 그 규칙은 그대로 남아 있어야 한다. */
    ck('칸이 비었을 때의 복원은 목록 기준이다',
      /if \(el\.childElementCount !== pile\.list\.length\) paintPile\(el, pile\)/.test(ch));
  }

  console.log('\n[10] 홀덤 사이드 팟 — 층을 묶어도 배지와 상자가 어긋나지 않는다');
  {
    /* 정밀 오딧에서 나온 세 결함을 못 박는다. 셋 다 "돈은 정확한데 화면만 틀린" 부류이고,
       무작위 6,000판 실측에서 각각 43.9% · 9.9% · 사이드팟 판 전부에서 나왔다. */
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const se3 = readFileSync('src/web/games/holdem-client/settle.ts', 'utf8') as string;
    const ch3 = readFileSync('src/web/games/holdem-client/chips.ts', 'utf8') as string;

    /* (1) 분할 팟이 걸린 층은 합치지 않는다. 배지는 분할 팟에서 "이 층 총액"을 각 승자에게
       각각 적으므로(한 명이 얼마 받는지 보이게), 두 층을 묶으면 표시 합이 정확히 두 배가
       된다 — 층 [2000,1400] 을 둘이 나눠 이긴 판에서 6,800P 로 찍혔다(실제 팟 3,400P). */
    ck('분할 팟이 걸린 층은 묶지 않는다',
      /prev\.__key === key && pa\.winners\.length === 1/.test(se3));

    /* (2) 묶음의 index 는 최솟값이어야 한다. 서버가 층을 내림차순으로 주므로 첫 원소의
       index 가 가장 크고, payLayer 는 그것을 범위의 시작으로 읽는다 — 그대로 두면 뒤 묶음의
       상자를 미리 집고, 뒤 묶음은 남은 것을 통째로 쓸어 가 같은 칩이 두 번 날았다. */
    ck('묶음 index 를 최솟값으로 남긴다',
      /prev\.index = Math\.min\(prev\.index, pa\.index\);/.test(se3));
    /* (3) 중간 층에서 빈손이면 "남은 게 다 내 것"이 아니다 — 마지막 층에서만 그렇게 본다. */
    ck('빈손 폴백은 마지막 층에서만 쓴다', /if \(!mine\.length && last\) mine = boxes;/.test(se3));
    ck('예전의 무조건 폴백이 남아 있지 않다', !/if \(!mine\.length\) mine = boxes;/.test(se3));

    /* (4) 정산이 시작된 판에서는 중앙 더미를 다시 그리지 않는다. 표시 단위(칩/BB) 토글이
       시그니처를 바꿔 innerHTML 을 통째로 갈아 끼우면서, 이미 보낸 층의 .paid 표시와
       비워 둔 자리가 함께 되살아났다(4층 팟 20,025P 에서 표시 합 24,500P). */
    ck('정산 중에는 중앙 더미를 다시 그리지 않는다',
      /if \(potPaidHand === tb\.handNo\) return;/.test(ch3));
    ck('그 자물쇠가 시그니처 계산보다 앞에 있다',
      ch3.indexOf('potPaidHand === tb.handNo') < ch3.indexOf("var sig = pileLayers(tb)"));
  }

  console.log('\n[11] 연승 과제 문지기 — 7연승을 유지한 채로 막히지 않는다');
  {
    /* 문지기에 "가장 최근 승리 판의 베팅액"을 넘기고 있었다. 정산 자리는 금액과 무관하게
       won=1 을 박으므로, 7연승 뒤 소액으로 한 번 더 이기면 그 값이 기준 아래로 내려가
       과제가 막혔다(실측 streak=7 · rows=0). 오래된 라운드가 정리되면 0 이 되는 경로도 있었다.
       진짜 문은 연승을 쌓는 자리에 있으므로 표시용 상수만 넘긴다. */
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const ld = readFileSync('src/web/games/ladder.ts', 'utf8') as string;
    const bc = readFileSync('src/web/games/baccarat.ts', 'utf8') as string;
    const bcq = readFileSync('src/db/queries/bacc.ts', 'utf8') as string;
    ck('사다리가 기준 상수를 넘긴다',
      /award\(userId, LADDER_STREAK_MIN_BET, \[\['la-right-7'/.test(ld));
    ck('바카라가 기준 상수를 넘긴다',
      /award\(userId, BACC_STREAK_MIN_BET, \[\['bc-player-7'/.test(bc));
    ck('마지막 승리 판 조회를 쓰지 않는다',
      !/lastRightWinBet/.test(ld) && !/lastPlayerWinBet/.test(bc));

    /* 바카라만 소액 '패배'가 연승을 끊고 있었다 — 연승에 넣을 수도 없는 금액인데
       부술 수는 있는 상태였다(500P 패배 → streak 3 → 0. 사다리는 3 을 유지한다).
       소액 continue 가 "안 이겼다 reset" 보다 앞에 와야 한다.
       단 양다리 reset 은 금액 앞에 그대로 둔다 — 소액으로 양쪽에 걸어 끊김을 피하면 안 된다. */
    const iSmall = bcq.indexOf('only.amount < BACC_STREAK_MIN_BET');
    const iLose = bcq.indexOf("o.winner !== 'player'");
    const iBoth = bcq.indexOf("if (!only) { resetStreak");
    ck('소액 검사가 패배 reset 보다 앞에 있다', iSmall > 0 && iLose > 0 && iSmall < iLose,
      `small@${iSmall} lose@${iLose}`);
    ck('양다리 reset 은 소액 검사보다 앞에 있다', iBoth > 0 && iBoth < iSmall,
      `both@${iBoth} small@${iSmall}`);
  }

  console.log('\n[12] 시즌 경계 — 마감과 같은 초에 끝난 대회가 밀리지 않는다');
  {
    /* closeSeason 이 닫는 시각과 다음 시즌 시작을 같은 now 로 쓴다. 창이 «시작 이상 ·
       마감 미만» 이면 마감과 같은 초에 끝난 대회가 닫힌 시즌에서 빠져 다음 시즌으로
       밀렸다(실측: 랭킹 2줄 → 0줄). 상한만 «이하» 로 바꾸면 같은 대회가 두 시즌에
       동시에 들어가므로 하한도 «초과» 로 함께 옮겨야 한다. */
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const sn = readFileSync('src/db/queries/season.ts', 'utf8') as string;
    ck('하한이 «초과» 다', /t\.finished_at > \?/.test(sn) && !/t\.finished_at >= \?/.test(sn));
    ck('상한이 «이하» 다', /t\.finished_at <= \?/.test(sn) && !/t\.finished_at < \?\)/.test(sn));
    /* 성적표를 찍은 뒤에 판정해야 한다 — 주석이 그렇게 말하는데 호출이 앞에 있었다.
       그리고 closed_at 을 세우기 전이어야 위 창 상한이 닫히지 않는다. */
    const iIns = sn.indexOf('INSERT INTO season_results');
    const iSweep = sn.indexOf('awardSeasonSweep(s.id)');
    const iClosed = sn.indexOf('UPDATE seasons SET closed_at');
    ck('성적표를 찍은 뒤에 판정한다', iIns > 0 && iSweep > iIns, `ins@${iIns} sweep@${iSweep}`);
    ck('closed_at 을 세우기 전에 판정한다', iClosed > 0 && iSweep < iClosed,
      `sweep@${iSweep} closed@${iClosed}`);
  }

  console.log('\n[12-b] 랭킹 탭 — 끌 수 있게 하면서 누를 수도 있어야 한다');
  {
    /* 게임이 늘면서 칩 줄이 화면 밖으로 넘쳤고(860px 칸에 983px), 끌어서 넘기게 했다.
       그때 pointerdown 에서 곧바로 포인터를 잡았더니 랭킹 탭이 통째로 안 눌렸다(제보).

       캡처가 걸려 있으면 브라우저가 이어지는 click 을 «잡은 요소»로 쏜다. 탭 리스너는
       e.target.closest('.lb-chip') 으로 어느 칸인지 찾는데 그 값이 컨테이너라 늘 null 이
       된다. 합성 이벤트(chip.click())로 짠 검사는 이 경로를 지나치지 않아 통과했다 —
       그래서 여기서는 "언제 잡는가"를 글자로 못 박는다.

       규칙: 누르는 순간에는 잡지 않는다. 끌기가 실제로 시작된 뒤(4px 초과)에만 잡는다. */
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const lb = readFileSync('src/web/leaderboard.ts', 'utf8');
    const down = lb.slice(lb.indexOf("addEventListener('pointerdown'"),
      lb.indexOf("addEventListener('pointermove'"));
    ck('누르는 순간에는 포인터를 잡지 않는다', !/setPointerCapture/.test(down), down);
    ck('끌기가 시작된 뒤에만 잡는다',
      /if \(moved <= 4\) return;[\s\S]{0,200}?setPointerCapture/.test(lb));
    ck('잡았을 때만 놓는다 (안 잡고 놓으면 예외가 난다)',
      /if \(captured\) \{[\s\S]{0,160}?releasePointerCapture/.test(lb));
    /* 끌고 놓은 것을 클릭으로 세지 않는 문은 그대로 있어야 한다 — 캡처를 늦게 걸어도
       4px 를 갓 넘긴 드래그는 click 이 버튼에 그대로 도착한다. */
    ck('끈 뒤의 클릭은 삼킨다',
      /if \(moved > 4\) \{ e\.stopPropagation\(\); e\.preventDefault\(\); \}/.test(lb));
    ck('탭 리스너는 여전히 closest 로 칸을 찾는다',
      /closest\('\.lb-chip'\)/.test(lb));
    // 넘친 쪽 표시와 세로 휠도 함께 남아 있어야 한다
    ck('끝 흐림이 스크롤 위치를 따라간다',
      /classList\.toggle\('more-l'/.test(lb) && /classList\.toggle\('more-r'/.test(lb));
    ck('세로 휠을 가로로 돌린다', /chipsEl\.scrollLeft \+= e\.deltaY/.test(lb));
  }

  console.log('\n[13] 지뢰찾기도 공통 과제를 본다');
  {
    /* 지뢰찾기에는 폴링하는 상태 엔드포인트가 없다(라우트가 page·start·reveal·cashout
       넷뿐이다). 그래서 여기서 공통 과제를 안 보면 다른 게임을 열 때까지 판정이 미뤄지고,
       롤러코스터는 그 날만 유효하므로 자정을 넘기면 달성이 영구히 사라졌다(실측). */
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const mn = readFileSync('src/web/games/mines.ts', 'utf8') as string;
    ck('자동 정산이 공통 과제를 함께 본다', /\.\.\.withCommon\(userId, got\)/.test(mn));
    ck('캐시아웃도 공통 과제를 본다',
      /\.\.\.withUnlocked\(commonAwards\(userId\)\)/.test(mn));
    ck('"판정할 과제가 없다" 주석이 남아 있지 않다', !/판정할 과제가 없다/.test(mn));
  }

  console.log('\n[13-b] app.css 조각 — 디렉터리에 있는 파일은 전부 실려야 한다');
  {
    const { readFileSync, readdirSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const dir = join(process.cwd(), 'src', 'web', 'assets', 'css');
    const onDisk = readdirSync(dir).filter(f => f.endsWith('.css')).sort();
    const listed = readFileSync(join(dir, 'ORDER.txt'), 'utf8')
      .split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
    /* 빠뜨리면 그 파일은 한 번도 안 실린다 — 화면은 멀쩡히 뜨고 그 규칙만 조용히 없다.
       12-notify.css 가 실제로 그랬고, 시즌 마감 경고 토스트(.toast.warn)가 붉은 테두리
       대신 금색으로 나왔다. 금색은 이 사이트에서 "좋은 것"의 색이라 뜻이 정반대였다. */
    const missing = onDisk.filter(f => !listed.includes(f));
    ck('목록에서 빠진 조각이 없다', missing.length === 0,
      missing.join(', ') + ' — 이 파일의 규칙은 한 번도 안 실린다');
    /* 반대쪽도 본다: 목록에만 있고 파일이 없으면 app.css 조립이 통째로 죽는다. */
    const ghost = listed.filter(f => !onDisk.includes(f));
    ck('없는 파일을 가리키지 않는다', ghost.length === 0, ghost.join(', '));
    ck('검사 대상이 있다', onDisk.length > 5, `${onDisk.length}개`);

    /* 주석 짝이 맞는가 — 한 번 닫은 뒤에 설명을 이어 쓰고 닫는 표시를 또 적는 실수다.
       그러면 그 사이 글이 주석 밖 생 텍스트가 되고, 파서가 거기서 헤매다가 바로 뒤
       규칙까지 삼킨다. 파일은 정상으로 보이고 화면도 뜨는데 그 규칙만 조용히 없다.
       이 프로젝트에서 네 번 겪었다(홀덤 배율이 사라진 것, 사다리 채팅창이 안 움직인 것,
       15·16·18 세 파일에 동시에 남아 있던 것). 눈으로는 안 보이므로 세어서 잡는다. */
    const orphan: string[] = [];
    for (const f of onDisk) {
      const s = readFileSync(join(dir, f), 'utf8');
      let i = 0, inC = false;
      while (i < s.length) {
        if (!inC && s[i] === '/' && s[i + 1] === '*') { inC = true; i += 2; continue; }
        if (inC && s[i] === '*' && s[i + 1] === '/') { inC = false; i += 2; continue; }
        if (!inC && s[i] === '*' && s[i + 1] === '/') {
          orphan.push(`${f}:${s.slice(0, i).split('\n').length}`); i += 2; continue;
        }
        i++;
      }
      if (inC) orphan.push(`${f}: 안 닫힌 주석`);
    }
    ck('주석 밖에 닫는 표시가 남지 않았다', orphan.length === 0,
      orphan.join(', ') + ' — 그 뒤 규칙이 통째로 무시된다');

    /* 중괄호 짝도 센다. 주석과 같은 종류의 사고인데 더 조용하다 — 규칙을 지우면서
       닫는 } 를 하나 흘리면 그 아래 규칙이 전부 앞 규칙의 안쪽으로 빨려 들어가고,
       @media 나 @supports 안이면 파일 끝까지 삼켜진다. 화면은 뜨고 그 규칙만 없다.
       (죽은 .bead-lbl 규칙을 걷다가 실제로 두 줄을 반쪽만 지웠다. 눈으로는 못 봤다.)
       주석과 문자열 안의 괄호는 세지 않는다 — content:'{' 같은 것이 있다. */
    const brace: string[] = [];
    for (const f of onDisk) {
      const bare = readFileSync(join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
      const open = (bare.match(/\{/g) || []).length;
      const close = (bare.match(/\}/g) || []).length;
      if (open !== close) brace.push(`${f}: { ${open} / } ${close}`);
    }
    ck('중괄호 짝이 맞는다', brace.length === 0,
      brace.join(', ') + ' — 짝이 안 맞으면 그 아래 규칙이 통째로 빨려 들어간다');
    // 실제로 그 규칙이 app.css 에 실렸는지까지 본다
    const css = (await get('/app.css', cookie)).text;
    ck('경고 토스트 규칙이 실제로 실린다', /\.toast\.warn/.test(css));

    /* ── 폰 규칙이 데스크톱으로 새지 않는가 ────────────────────────
       "웹 화면은 지금 그대로 둔다"가 이 작업의 전제다. 폰용 조각(15·16)의 규칙이
       하나라도 미디어쿼리 밖에 있으면 그 순간 데스크톱까지 바뀐다 — 그리고 그건
       화면을 열어 보기 전에는 모른다. 여기서 소스를 직접 읽어 못 박는다. */
    for (const f of ['15-mobile.css', '16-ingame.css']) {
      if (!onDisk.includes(f)) continue;
      const src = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const outside: string[] = [];
      let depth = 0, buf = '';
      for (const c of src) {
        if (c === '{') { if (depth === 0 && !/@media/.test(buf)) outside.push(buf.trim().slice(0, 40)); depth++; buf = ''; }
        else if (c === '}') { depth--; buf = ''; }
        else buf += c;
      }
      ck(`${f} 의 규칙이 전부 미디어쿼리 안에 있다`, outside.length === 0,
        outside.join(' | ') + ' — 이 규칙은 데스크톱에도 걸린다');
    }
  }

  console.log('\n[14] 운영자 왼쪽 메뉴 — 메뉴에 있으면 눌러서 열려야 한다');
  {
    const ad = (await get('/admin', cookie)).text;
    /* 화면 전환은 PANES 목록을 본다. 모르는 key 는 조용히 PANES[0] 으로 되돌아가므로,
       메뉴에만 넣고 이 목록을 빠뜨리면 "눌리는데 첫 화면으로 튕긴다"가 된다 —
       채팅 화면을 새로 넣었을 때 실제로 그랬다. 그래서 목록을 손으로 적지 않고
       메뉴에서 뽑아 쓴다. 이 검사는 그 약속이 지켜지는지를 본다. */
    ck('PANES 를 손으로 적지 않는다', !/var PANES = \['/.test(ad), 'PANES 가 하드코딩됐다');
    const panes = /var PANES = (\[[^\]]*\])/.exec(ad);
    const keys: string[] = panes ? JSON.parse(panes[1]) : [];
    ck('PANES 를 읽어 왔다', keys.length > 0, panes?.[1]);
    /* 메뉴 버튼 하나하나가 실제로 그 목록에 있어야 한다. */
    const navKeys = [...ad.matchAll(/class="ad-nav-item" data-pane="(\w+)"/g)].map(m => m[1]);
    ck('메뉴 버튼이 있다', navKeys.length >= 4, navKeys.join(','));
    const orphanNav = navKeys.filter(k => !keys.includes(k));
    ck('메뉴에 있는 화면은 전부 열 수 있다', orphanNav.length === 0,
      orphanNav.join(', ') + ' — 눌러도 첫 화면으로 되돌아간다');
    /* 반대쪽도 본다: 목록에만 있고 그릴 카드가 없으면 빈 화면이 열린다. */
    const cardKeys = [...ad.matchAll(/class="ad-card" data-pane="(\w+)"/g)].map(m => m[1]);
    const empty = keys.filter(k => !cardKeys.includes(k));
    ck('빈 화면으로 가는 메뉴가 없다', empty.length === 0, empty.join(', '));
    // 채팅은 대회 관리에서 빠져나왔다
    ck('채팅이 제 화면을 갖는다', navKeys.includes('chat') && cardKeys.includes('chat'));
    ck('채팅이 대회 관리에 남아 있지 않다',
      !/data-pane="tour">\s*<h2>채팅<\/h2>/.test(ad));
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`통과 ${pass} · 실패 ${fail}`);
  if (fail) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(e => { console.error(e); process.exit(1); });
