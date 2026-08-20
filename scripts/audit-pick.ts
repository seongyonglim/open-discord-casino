/* 바뀐 파일이 닿는 감사만 고른다.
 *
 * 감사 전체는 7분이 넘는다. 그중 셋(tourney 145초 · e2e 107초 · holdem-db 50초)이
 * 302초를 쓰는데, 화면 색을 고칠 때도 그 셋이 매번 돌았다. 고쳐야 할 것을 못 잡는
 * 검사는 시간만 먹는 것이 아니라, 다음번에 "어차피 오래 걸리니 건너뛰자"는 판단을
 * 부른다 — 그러면 잡을 수 있었던 것까지 놓친다.
 *
 * 고르는 방법은 추측이 아니라 의존 관계다. 감사 스크립트가 실제로 읽는 파일
 * (readFileSync 의 경로 문자열)과 import 로 끌어오는 모듈을 따라가 닫힘집합을 만들고,
 * 바뀐 파일이 그 안에 있으면 그 감사를 돌린다.
 *
 *   npx tsx scripts/audit-pick.ts             바뀐 파일(작업 트리 + main 과의 차이)
 *   npx tsx scripts/audit-pick.ts --list      무엇을 왜 고르는지만 보고 안 돌린다
 *   npx tsx scripts/audit-pick.ts a.ts b.css  파일을 직접 준다
 *   npx tsx scripts/audit-pick.ts --all       전부 돌린다(배포 전)
 *
 * 확신이 안 서면 --all 을 쓴다. 이 도구는 "덜 돌리는" 것이 목적이지
 * "안 돌리는" 것이 목적이 아니다.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, posix } from 'node:path';

const ROOT = process.cwd();
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/* ── 감사 이름 → 스크립트 ─────────────────────────────────────────────
   package.json 의 audit 체인에서 그대로 읽는다. 체인에 감사를 하나 더하면
   여기도 저절로 따라온다 — 두 곳을 손으로 맞추면 언젠가 어긋난다. */
function chain(): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as
    { scripts: Record<string, string> };
  const seen: string[] = [];
  const walk = (name: string) => {
    const cmd = pkg.scripts[name];
    if (!cmd) return;
    for (const part of cmd.split('&&').map(s => s.trim())) {
      const sub = /^npm run ([\w:-]+)$/.exec(part);
      if (sub) { walk(sub[1]); continue; }
      const file = /scripts\/([\w-]+)\.ts/.exec(part);
      if (file && !seen.includes(name)) seen.push(name);
    }
  };
  walk('audit');
  return seen;
}
function scriptOf(name: string): string | null {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as
    { scripts: Record<string, string> };
  const m = /scripts\/([\w-]+\.ts)/.exec(pkg.scripts[name] || '');
  return m ? 'scripts/' + m[1] : null;
}

/* ── 한 파일이 끌어오는 것들 ──────────────────────────────────────────
   import/require 의 상대 경로와, 코드 안에 적힌 'src/…' 경로 문자열 둘 다 본다.
   뒤엣것이 중요하다 — 감사 다수가 CSS 와 클라이언트 JS 를 readFileSync 로 읽는데,
   그건 import 그래프에 안 나타난다. */
const CACHE = new Map<string, string[]>();
function deps(file: string): string[] {
  const hit = CACHE.get(file);
  if (hit) return hit;
  let src = '';
  try { src = readFileSync(join(ROOT, file), 'utf8'); } catch { CACHE.set(file, []); return []; }
  const out = new Set<string>();

  const dir = posix.dirname(norm(file));
  const rel = /(?:from\s+|require\()\s*['"](\.[^'"]+)['"]/g;
  for (let m = rel.exec(src); m; m = rel.exec(src)) {
    const base = norm(posix.normalize(posix.join(dir, m[1])));
    for (const cand of [base, base + '.ts', base + '.js', base + '/index.ts']) {
      if (existsSync(join(ROOT, cand)) && statSync(join(ROOT, cand)).isFile()) { out.add(cand); break; }
    }
  }
  const lit = /['"`](src\/[\w./-]+\.(?:ts|js|css|json|svg|html))['"`]/g;
  for (let m = lit.exec(src); m; m = lit.exec(src)) {
    if (existsSync(join(ROOT, m[1]))) out.add(norm(m[1]));
  }
  /* 경로를 조각내 쓰는 것도 잡는다 — audit-pwa 가
     join(process.cwd(), 'src', 'web', 'assets', 'app.js') 로 쓴다.
     한 덩어리 문자열만 찾다가 이걸 놓쳤다(실측). */
  /* 안쪽 괄호를 먼저 지운다 — join(process.cwd(), 'src', …) 에서 정규식이
     process.cwd() 의 닫는 괄호에 걸려 뒤의 조각들을 통째로 못 봤다(실측). */
  const flat = src.replace(/(?:process\.cwd|__dirname|import\.meta\.dirname)\(?\)?/g, '_');
  const seg = /join\(([^)]*)\)/g;
  for (let m = seg.exec(flat); m; m = seg.exec(flat)) {
    const parts = [...m[1].matchAll(/['"`]([\w.-]+)['"`]/g)].map(x => x[1]);
    if (parts.length < 2) continue;
    for (let i = 0; i < parts.length; i++) {
      const p = norm(parts.slice(i).join('/'));
      if (p.startsWith('src/') && existsSync(join(ROOT, p))) { out.add(p); break; }
    }
  }
  const list = [...out];
  CACHE.set(file, list);
  return list;
}

/* 서버가 «내보내는» 것을 받아 보는 감사가 있다(smoke 가 /app.js 를 받아 본다).
   그건 import 그래프에도 경로 문자열에도 안 나타난다.

   여기서 "서버를 끌어오면 자산 전부를 본다"고 잡으면 너무 넓다 — 서버를 띄우기만 하고
   자산은 안 보는 감사(e2e 107초 · concurrency 49초)까지 딸려 와서, 채팅 CSS 한 줄에
   3분이 붙는다. 좁게 잡는다: 감사가 자산 «주소»를 코드에 적었을 때만 그 주소가
   내보내는 파일을 딸려 온 것으로 본다. */
function assetsUnder(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    const p = dir + '/' + e;
    if (statSync(join(ROOT, p)).isDirectory()) assetsUnder(p, acc);
    else acc.push(norm(p));
  }
  return acc;
}
/* 주소 → 그 주소가 내보내는 원본. /app.css 는 ORDER.txt 가 정하는 CSS 조각 전부라
   조각 하나하나를 세지 않고 css 폴더 전체로 본다(조각을 새로 넣어도 안 새어 나간다). */
const ROUTES: Record<string, string[]> = {
  '/app.js': ['src/web/assets/app.js', 'src/web/assets/ingame.js'],
  '/app.css': assetsUnder('src/web/assets/css'),
  '/sw.js': ['src/web/assets/sw.js'],
};
function closure(entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const stack = [entry];
  while (stack.length) {
    for (const d of deps(stack.pop()!)) if (!seen.has(d)) { seen.add(d); stack.push(d); }
  }
  /* 감사 스크립트 자신이 자산 주소를 적었을 때만 그 주소의 원본을 딸려 온다 */
  let own = '';
  try { own = readFileSync(join(ROOT, entry), 'utf8'); } catch { /* 없으면 그만 */ }
  for (const route of Object.keys(ROUTES)) {
    if (own.includes("'" + route + "'") || own.includes('"' + route + '"')) {
      for (const f of ROUTES[route]) if (existsSync(join(ROOT, f))) seen.add(norm(f));
    }
  }
  return seen;
}

/* ── 무엇이 바뀌었나 ──────────────────────────────────────────────── */
function changed(): string[] {
  const out = new Set<string>();
  const run = (args: string[]) => {
    try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }); }
    catch { return ''; }
  };
  for (const line of (run(['status', '--porcelain']) + '\n' +
                      run(['diff', '--name-only', 'main...HEAD'])).split('\n')) {
    const p = line.replace(/^..\s+/, '').trim();
    if (p) out.add(norm(p));
  }
  return [...out].filter(p => p && existsSync(join(ROOT, p)));
}

/* ── 고르기 ──────────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const all = args.includes('--all');
const given = args.filter(a => !a.startsWith('--')).map(norm);
const files = given.length ? given : changed();

const names = chain();
const picked: { name: string; why: string }[] = [];
for (const name of names) {
  const entry = scriptOf(name);
  if (!entry) continue;
  if (all) { picked.push({ name, why: '--all' }); continue; }
  const c = closure(entry);
  /* 감사 스크립트 자신이 바뀌었어도 돌린다 — 검사를 고쳤으면 그 검사를 봐야 한다. */
  const hit = files.find(f => c.has(f));
  if (hit) picked.push({ name, why: hit });
}

console.log(`바뀐 파일 ${files.length}개`);
for (const f of files.slice(0, 20)) console.log('  ' + f);
if (files.length > 20) console.log(`  … 외 ${files.length - 20}개`);
console.log(`\n고른 감사 ${picked.length}/${names.length}개`);
for (const p of picked) console.log(`  ${p.name.padEnd(20)} ← ${p.why}`);
const skipped = names.filter(n => !picked.some(p => p.name === n));
if (skipped.length) console.log('\n건너뜀: ' + skipped.join(', '));

if (listOnly) process.exit(0);
if (!picked.length) { console.log('\n돌릴 감사가 없다.'); process.exit(0); }

let failed = 0;
for (const p of picked) {
  console.log(`\n──────── ${p.name} ────────`);
  try {
    execFileSync('npm', ['run', p.name], { cwd: ROOT, stdio: 'inherit', shell: true });
  } catch { failed++; }
}
console.log(`\n감사 ${picked.length}개 중 실패 ${failed}개`);
process.exit(failed ? 1 : 0);
