// 위키미디어 공용의 English pattern 트럼프 덱(Dmitry Fomin 作, CC0 = 퍼블릭 도메인)을 내려받아
// public/cards/{랭크}{무늬}.svg 로 저장한다. K/Q/J에는 실제 궁정 카드 삽화가 들어 있다.
// 뒷면(back.svg)은 사이트 톤에 맞춘 자체 디자인을 쓰므로 여기서 건드리지 않는다.
//
// commons.wikimedia.org/wiki/Special:FilePath 는 요청 제한이 빡빡해서 429가 잘 난다.
// 그래서 API로 실제 파일 주소(upload.wikimedia.org, CDN)를 한 번에 받아온 뒤 거기서 내려받는다.
//   실행: npm run cards:fetch   (중간에 끊겨도 다시 돌리면 못 받은 것만 이어받는다)
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SUITS: Record<string, string> = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
const RANKS: Record<string, string> = {
  A: 'ace', K: 'king', Q: 'queen', J: 'jack', T: '10',
  '9': '9', '8': '8', '7': '7', '6': '6', '5': '5', '4': '4', '3': '3', '2': '2',
};
const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'discord-casino/1.0 (private Discord community points game; contact via repo owner)';

const outDir = join(process.cwd(), 'public', 'cards');
mkdirSync(outDir, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// 위키미디어 원본은 Inkscape로 만들어져 그 흔적이 남는다 — 자체 생성본과 구분하는 표식으로 쓴다
const alreadyFetched = (p: string) =>
  existsSync(p) && readFileSync(p, 'utf8').includes('inkscape');

interface Want { code: string; title: string; out: string }

const wanted: Want[] = [];
for (const [rk, rName] of Object.entries(RANKS)) {
  for (const [sk, sName] of Object.entries(SUITS)) {
    const out = join(outDir, `${rk}${sk}.svg`);
    if (alreadyFetched(out)) continue;
    wanted.push({ code: `${rk}${sk}`, title: `File:English pattern ${rName} of ${sName}.svg`, out });
  }
}

// 제목 → 실제 파일 URL. API는 한 번에 50개까지 받아준다.
async function resolveUrls(titles: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let i = 0; i < titles.length; i += 50) {
    const chunk = titles.slice(i, i + 50);
    const url = `${API}?action=query&format=json&prop=imageinfo&iiprop=url&titles=${encodeURIComponent(chunk.join('|'))}`;
    const res = await fetch(url, { headers: { 'user-agent': UA } });
    if (!res.ok) throw new Error(`API 응답 ${res.status}`);
    const json = await res.json() as { query?: { pages?: Record<string, { title: string; imageinfo?: { url: string }[] }> } };
    for (const page of Object.values(json.query?.pages ?? {})) {
      const u = page.imageinfo?.[0]?.url;
      if (u) map.set(page.title, u);
    }
    await sleep(400);
  }
  return map;
}

(async () => {
  if (!wanted.length) { console.log('이미 52장 전부 받아져 있습니다.'); return; }
  console.log(`받을 카드 ${wanted.length}장 — 파일 주소 조회 중...`);
  const urls = await resolveUrls(wanted.map(w => w.title));

  let ok = 0;
  const failed: string[] = [];
  for (const w of wanted) {
    const src = urls.get(w.title);
    if (!src) { failed.push(`${w.code} (주소 못 찾음)`); continue; }

    let saved = false, wait = 800;
    for (let attempt = 0; attempt < 4 && !saved; attempt++) {
      try {
        const res = await fetch(src, { headers: { 'user-agent': UA } });
        if (res.status === 429 || res.status >= 500) { await sleep(wait); wait *= 2; continue; }
        if (!res.ok) { failed.push(`${w.code} (HTTP ${res.status})`); break; }
        const svg = await res.text();
        if (!svg.includes('<svg')) { failed.push(`${w.code} (SVG 아님)`); break; }
        writeFileSync(w.out, svg);
        saved = true; ok++;
      } catch {
        await sleep(wait); wait *= 2;
      }
    }
    if (!saved && !failed.some(f => f.startsWith(`${w.code} `))) failed.push(`${w.code} (재시도 초과)`);
    await sleep(150);
  }

  const total = Object.keys(RANKS).length * Object.keys(SUITS).length;
  const have = wanted.length - failed.length + (total - wanted.length);
  console.log(`받음 ${ok}장 · 보유 ${have}/${total}${failed.length ? ` · 실패 ${failed.length}: ${failed.join(', ')}` : ''}`);
})();
