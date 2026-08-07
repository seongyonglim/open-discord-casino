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
  console.log('\n[2] 로비 카드의 수치 = 게임 코드의 값');
  {
    const lobby = (await get('/', cookie)).text;
    const has = (s: string) => lobby.includes(s);

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
    ck('홀덤 카드는 대회 상태를 비춘다',
      /등록은 .*후에 열립니다|등록 중|명 신청|진행 중|오늘 대회|인원 대기|예정 없음|다음 대회/.test(lobby));
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

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`통과 ${pass} · 실패 ${fail}`);
  if (fail) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(e => { console.error(e); process.exit(1); });
