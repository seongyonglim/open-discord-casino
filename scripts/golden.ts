/* 렌더 결과 고정본(golden) — "동작이 1%도 안 바뀌었다"를 바이트로 증명하는 도구.
 *
 * 이 프로젝트의 화면은 템플릿 문자열로 만들어진다. 그래서 리팩토링이 순수했는지를
 * 눈이나 감사가 아니라 산출물 자체로 확인할 수 있다 — 같은 입력에 같은 바이트가 나오면
 * 브라우저가 받는 것이 완전히 같다는 뜻이고, 그건 동작이 같다는 것보다 강한 보장이다.
 *
 *   npx tsx scripts/golden.ts probe   # 실행마다 달라지는 부분을 찾는다 (정규화 범위 정하기)
 *   npx tsx scripts/golden.ts save    # 지금 상태를 고정본으로 저장한다 (리팩토링 전에)
 *   npx tsx scripts/golden.ts check   # 고정본과 비교한다 (리팩토링 후에)
 *
 * 고정본은 .golden/ 에 쌓인다. 커밋하지 않는다 — 리팩토링 한 판을 위한 임시 기준이고,
 * 저장소에 두면 "언제 뜬 기준인지" 모르는 낡은 파일이 남는다.
 *
 * 안전: DB_PATH를 임시 디렉터리로 못 박고 전용 포트를 쓴다. 개발 DB도 운영도 안 건드린다.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const MODE = (process.argv[2] ?? 'check') as 'probe' | 'save' | 'check';
/* probe가 두 요청 사이에 기다리는 시간. 기본을 65초로 둔 이유가 있다 —
   1.1초로 두고 "전부 안정"을 받았는데, 로비의 분 단위 카운트다운이 그 사이에는 안 바뀌어서
   놓쳤다. 도구가 "안전하다"고 잘못 말하는 것이 가장 나쁜 실패다. 분 경계를 반드시 넘긴다.
     GOLDEN_GAP_MS=1100 npx tsx scripts/golden.ts probe   (빠르게 훑을 때) */
const GAP_MS = Number(process.env.GOLDEN_GAP_MS ?? 65_000);
const PORT = 8470;
const OUT = join(process.cwd(), '.golden');

process.env.DB_PATH = mkdtempSync(join(tmpdir(), 'golden-'));
process.env.PORT = String(PORT);

const { upsertUser, adjustBalance, getWebUser, createSession } =
  require('../src/db/queries') as typeof import('../src/db/queries');
const { startWebServer } = require('../src/web/server') as typeof import('../src/web/server');
/* 자산 캐시 버전. public/ 과 src/web/assets/ 의 가장 최근 수정 시각에서 나오므로,
   파일을 하나 나누기만 해도 값이 바뀐다 — 동작이 바뀐 것이 아니라 캐시 무효화용 꼬리표다.
   패턴으로 짐작하지 않고 실제 값을 그대로 가린다. */
const { ASSET_V } = require('../src/web/assets') as typeof import('../src/web/assets');

/* 검사 대상. audit-pages의 목록과 같은 화면들 + 별도 파일로 나가는 정적 자산.
   자산까지 넣는 이유는 CSS·JS 파일을 건드리는 리팩토링도 이 도구로 잡으려는 것이다. */
const PATHS = [
  '/', '/leaderboard', '/notices',
  '/games/ladder', '/games/graph', '/games/poker',
  '/games/mines', '/games/baccarat', '/games/blackjack', '/games/holdem',
  '/app.css', '/app.js',
];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const slug = (p: string) => (p === '/' ? 'root' : p.replace(/^\//, '').replace(/[^\w.-]+/g, '_'));
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function get(path: string, cookie: string): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { cookie } });
  if (r.status !== 200) throw new Error(`${path} → ${r.status}`);
  return await r.text();
}

/* 실행마다 달라지는 값을 지운다. probe 모드가 실제로 무엇이 달라지는지 알려 주므로,
   여기 있는 규칙은 추측이 아니라 관측에서 나온 것이다.
   너무 넓게 지우면 리팩토링이 깨뜨린 차이까지 같이 지워져 도구가 무용해진다 —
   그래서 자리(값이 있던 위치)는 남기고 값만 가린다. */
function normalize(text: string): string {
  return text
    .split(ASSET_V).join('<ASSET_V>')
    // 세션 토큰·nonce 류의 긴 16진수
    .replace(/\b[0-9a-f]{32,}\b/g, '<HEX>')
    // 초/밀리초 단위 epoch (10자리·13자리)
    .replace(/\b1[0-9]{9}(?:[0-9]{3})?\b/g, '<TIME>')
    /* 남은 시간 카운트다운. 로비의 프리롤 카드가 "등록까지 19시간 6분"처럼 적는데
       (pages.ts 의 left/short) 분이 넘어가면 값이 바뀐다 — 1초 간격으로 두 번 받아 보면
       안 걸려서 처음엔 안정으로 보였다. 실제로 이 때문에 도구를 못 믿을 뻔했다.
       숫자만 가리고 "시간·분" 글자는 남긴다 — 형식이 깨지는 리팩토링은 여전히 잡힌다. */
    .replace(/\d+시간 \d+분/g, '<DUR>시간 <DUR>분')
    .replace(/(?<![\d>])\d+분(?! )/g, '<DUR>분');
}

async function main(): Promise<void> {
  startWebServer();
  await sleep(500);

  // 고정된 사용자·세션을 쓴다 — 값이 매번 달라지면 비교할 것이 없다
  upsertUser('golden_user', '고정본감사', null);
  if ((getWebUser('golden_user')?.balance ?? 0) <= 0) {
    adjustBalance('golden_user', 100_000, 'golden:seed');
  }
  const token = 'golden0000000000000000000000token';
  createSession(token, 'golden_user', Math.floor(Date.now() / 1000) + 3600);
  const cookie = 'sid=' + token;

  if (MODE === 'probe') {
    /* 같은 화면을 두 번 받아 스스로 달라지는지 본다. 여기서 걸리는 것이
       정규화가 필요한 부분이다 — 정규화 후에도 남으면 도구를 못 쓴다. */
    console.log(`\n실행마다 달라지는 부분 찾기 (전체 2회 · 사이 ${Math.round(GAP_MS / 1000)}초)\n`);
    // 화면마다 기다리면 12번을 기다린다 — 전체를 한 번 받고 한 번만 기다린다
    const first = new Map<string, string>();
    for (const p of PATHS) first.set(p, normalize(await get(p, cookie)));
    await sleep(GAP_MS);
    let dirty = 0;
    for (const p of PATHS) {
      const a = first.get(p)!;
      const b = normalize(await get(p, cookie));
      if (a === b) { console.log(`  안정  ${p}  (${a.length}자)`); continue; }
      dirty++;
      const la = a.split('\n'), lb = b.split('\n');
      const at = la.findIndex((l, i) => l !== lb[i]);
      console.log(`  변동  ${p}  ${at + 1}번째 줄`);
      console.log(`        1차: ${JSON.stringify((la[at] ?? '').slice(0, 110))}`);
      console.log(`        2차: ${JSON.stringify((lb[at] ?? '').slice(0, 110))}`);
    }
    console.log(dirty === 0
      ? '\n전부 안정 — 바이트 비교를 기준으로 쓸 수 있다.'
      : `\n${dirty}개 화면이 흔들린다 — normalize에 규칙을 더해야 한다.`);
    process.exit(dirty === 0 ? 0 : 1);
  }

  if (MODE === 'save') {
    if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    const lines: string[] = [];
    for (const p of PATHS) {
      const t = normalize(await get(p, cookie));
      writeFileSync(join(OUT, slug(p) + '.txt'), t, 'utf8');
      lines.push(`${sha(t)}  ${t.length}  ${p}`);
      console.log(`  저장  ${p}  ${t.length}자  ${sha(t)}`);
    }
    writeFileSync(join(OUT, 'manifest.txt'), lines.join('\n') + '\n', 'utf8');
    console.log(`\n고정본 ${PATHS.length}개를 .golden/ 에 저장했다.`);
    process.exit(0);
  }

  // check
  if (!existsSync(join(OUT, 'manifest.txt'))) {
    console.log('고정본이 없다 — 먼저 `npx tsx scripts/golden.ts save` 를 리팩토링 전에 실행해야 한다.');
    process.exit(1);
  }
  let same = 0, diff = 0;
  for (const p of PATHS) {
    const now = normalize(await get(p, cookie));
    const file = join(OUT, slug(p) + '.txt');
    const was = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (now === was) { same++; console.log(`  같음  ${p}  ${sha(now)}`); continue; }
    diff++;
    console.log(`  다름  ${p}`);
    console.log(`        고정본 ${was.length}자 ${sha(was)} → 지금 ${now.length}자 ${sha(now)}`);
    // 첫 차이 지점을 문자 단위로 짚는다 — 줄 단위로는 긴 한 줄 안의 차이를 못 본다
    let i = 0;
    while (i < was.length && i < now.length && was[i] === now[i]) i++;
    const around = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 60), i + 60));
    console.log(`        첫 차이 ${i}번째 글자`);
    console.log(`        고정본: ${around(was)}`);
    console.log(`        지금  : ${around(now)}`);
  }
  console.log(`\n같음 ${same} · 다름 ${diff}`);
  process.exit(diff === 0 ? 0 : 1);
}

void main().catch(e => { console.error(e); process.exit(1); });

// 지난 실행이 남긴 임시 DB를 정리한다
process.on('exit', () => {
  try {
    for (const d of readdirSync(tmpdir())) {
      if (d.startsWith('golden-') && join(tmpdir(), d) !== process.env.DB_PATH) {
        rmSync(join(tmpdir(), d), { recursive: true, force: true });
      }
    }
  } catch { /* 못 지워도 상관없다 */ }
});
