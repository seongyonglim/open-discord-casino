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
    ck('마우스와 손가락 둘 다 펼 수 있다',
      /\.volwrap:hover \.volpop[^{]*\.volwrap\.open \.volpop/.test(css.replace(/\s+/g, ' ')));
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
      { id: 'x-1', kind: '패치노트', title: '제목', summary: '한 줄 요약' }, at) as any;
    const em = e.embeds[0];
    ck('제목이 [태그] 제목 이다', em.title === '[패치노트] 제목', String(em.title));
    ck('설명이 요약이다', em.description === '한 줄 요약', String(em.description));
    ck('색이 시그니처 골드다', em.color === 0xd4af37, String(em.color));
    ck('작성일시가 KST 다', em.fields[0].value === '2026-08-10 09:05',
      `${em.fields[0].name}=${em.fields[0].value}`);
    ck('공지 상세로 가는 링크가 있다', String(em.url).endsWith('/notices/x-1'), String(em.url));
    ck('본문에도 같은 링크가 있다', String(e.content).includes('/notices/x-1'));
    ck('푸터가 규격대로다', em.footer.text === 'OD CASINO Official Announcement', em.footer.text);
    /* 푸터 아이콘은 실제로 서비스가 내보내는 파일이어야 한다 — 없는 경로를 적으면
       디스코드에 깨진 이미지가 남는다. public/img/logo.png 는 없다. */
    ck('푸터 아이콘이 실제 파일을 가리킨다', String(em.footer.icon_url).endsWith('/favicon.svg'),
      String(em.footer.icon_url));
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
    const dbImport = tool.match(/import \{([^}]*)\} from '\.\.\/src\/db\/notices'/)?.[1] ?? '';
    ck('그 도구는 읽기만 들여온다',
      dbImport.trim() === 'listNotices, findNotice', dbImport.trim());
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

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`통과 ${pass} · 실패 ${fail}`);
  if (fail) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(e => { console.error(e); process.exit(1); });
