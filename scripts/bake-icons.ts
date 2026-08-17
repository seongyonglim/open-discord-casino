/* 로고 SVG 를 앱 아이콘 PNG 로 굽는다.
 *
 * ── 왜 도구로 남기는가
 * logo.png 를 구울 때는 도구를 안 남겼다("한 번 굽고 끝나는 일이라 도구를 두면 그게
 * 더 부담이다" — server.ts 주석). 그 판단이 여기서는 뒤집힌다. 이제 굽는 것이 네 장이고,
 * 그중 마스커블은 안전 영역(안쪽 80% 원) 안에 그림이 들어가야 한다는 기하 조건이 붙는다.
 * 손으로 맞추면 다음에 로고를 고칠 때 그 조건을 다시 계산해야 하고, 틀려도 화면에서는
 * 안 보인다 — 안드로이드 런처가 원형으로 자를 때만 드러난다.
 *
 * ── 왜 PNG 인가
 * 크롬은 매니페스트 아이콘으로 SVG 도 받는다. 하지만 이 아이콘의 목적지는 결국
 * Play Store 용 TWA 이고, Bubblewrap 은 런처 아이콘을 PNG 에서 만든다.
 *
 * ── 마스커블
 * 안드로이드 런처는 아이콘을 제 마음대로 자른다(원·둥근 사각·물방울). 그래서 바깥
 * 20% 는 잘려 나간다고 보고 그 안쪽에만 그림을 둔다. 로고의 흰 배경을 화면 끝까지
 * 채우고 그림만 줄이는 방식이다 — 안 그러면 흰 모서리가 잘려 검은 테가 생긴다.
 *
 * 쓰는 법:  npx tsx scripts/bake-icons.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOGO_SVG } from '../src/web/views';

const CHROME = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(p => { try { return existsSync(p); } catch { return false; } });

if (!CHROME) {
  console.error('크롬이나 엣지를 못 찾았다 — 아이콘을 구우려면 둘 중 하나가 필요하다');
  process.exit(1);
}

const OUT = join(process.cwd(), 'public', 'icon');
mkdirSync(OUT, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'casino-icon-'));

/** 한 장 굽는다. inset 은 그림을 화면 대비 얼마로 줄일지(1 이면 꽉 참). */
function bake(name: string, size: number, inset: number, bg: string): void {
  /* 로고 자체가 흰 둥근 사각이라 일반 아이콘은 배경을 투명하게 두고 그대로 담는다.
     마스커블만 배경을 흰색으로 꽉 채우고 그림을 줄인다. */
  const pad = Math.round(size * (1 - inset) / 2);
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:${bg}}
    .b{position:absolute;left:${pad}px;top:${pad}px;width:${size - pad * 2}px;height:${size - pad * 2}px}
    svg{width:100%;height:100%;display:block}
  </style><div class="b">${LOGO_SVG}</div>`;
  const page = join(work, `${name}.html`);
  writeFileSync(page, html, 'utf8');

  const out = join(OUT, `${name}.png`);
  execFileSync(CHROME!, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    /* 이미 떠 있는 크롬과 프로필이 겹치면 새 창만 열고 그냥 끝난다 — 스크린샷이 안 나온다 */
    `--user-data-dir=${join(work, 'profile')}`,
    /* 투명 배경. 이 값을 안 주면 흰 바탕이 깔려 둥근 모서리가 사각형이 된다 */
    '--default-background-color=00000000',
    `--screenshot=${out}`, `--window-size=${size},${size}`,
    `file:///${page.replace(/\\/g, '/')}`,
  ], { stdio: 'pipe' });

  if (!existsSync(out)) { console.error(`  ${name}.png 이 안 나왔다`); process.exit(1); }
  console.log(`  ${name}.png  ${size}×${size}  ${(statSync(out).size / 1024).toFixed(1)}KB`);
}

console.log('\n아이콘을 굽는다 →', OUT, '\n');
/* 192·512 는 크롬이 설치 가능 여부를 판정할 때 보는 두 크기다.
   180 은 iOS 홈 화면(apple-touch-icon) — 마스커블 개념이 없어 그림 그대로 쓴다. */
bake('icon-192', 192, 1, 'transparent');
bake('icon-512', 512, 1, 'transparent');
bake('apple-touch-icon', 180, 1, 'transparent');
/* 안전 영역은 안쪽 80% 다. 0.72 로 두어 조금 더 여유를 준다 — 물방울 모양처럼
   모서리를 깊게 파는 런처가 있어서 딱 80% 로 맞추면 가장자리가 스친다. */
bake('icon-maskable-512', 512, 0.72, '#ffffff');

rmSync(work, { recursive: true, force: true });
console.log('\n끝났다.\n');
