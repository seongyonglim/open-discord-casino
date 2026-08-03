// 트럼프 카드 52장 + 뒷면을 SVG 파일로 미리 생성한다 (public/cards/).
// 폰트에 의존하는 ♠♥♦♣ 문자 대신 무늬를 전부 도형으로 그려서, 어떤 환경에서도 같게 보이게 한다.
//   실행: npm run cards
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// 위키미디어 CC0 덱(English pattern)과 같은 2:3 비율로 맞춘다 — 앞면과 뒷면이 섞여도 크기가 어긋나지 않게
const W = 360, H = 540;
const S = W / 250;                    // 예전 250×350 기준으로 잡아둔 수치를 그대로 쓰기 위한 배율
const RED = '#c8102e', BLACK = '#1b1b1f';

const SUITS = ['s', 'h', 'd', 'c'] as const;
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
type Suit = typeof SUITS[number];

const isRed = (s: Suit) => s === 'h' || s === 'd';
const rankLabel = (r: string) => (r === 'T' ? '10' : r);

// 무늬 도형 — 모두 100×100 좌표계 안에 그린다.
// 스페이드·클로버는 몸통이 아래를 다 덮으면 기둥이 안 보이므로, 몸통을 위쪽에 두고
// 기둥이 드러날 자리를 남긴다.
function suitShape(suit: Suit, color: string): string {
  // 스페이드·클로버의 기둥은 길고 뾰족한 삼각형이 아니라 짧고 뭉툭한 받침 모양이어야
  // 실제 카드 무늬처럼 보인다. 몸통이 넓고 기둥이 짧은 비율.
  const stem = `M50 64 C50 77 46 85 35 93 L65 93 C54 85 50 77 50 64 Z`;
  switch (suit) {
    case 'h':
      return `<path d="M50 92 C22 70 8 54 8 36 C8 22 18 12 31 12 C40 12 47 17 50 24 ` +
        `C53 17 60 12 69 12 C82 12 92 22 92 36 C92 54 78 70 50 92 Z" fill="${color}"/>`;
    case 'd':
      return `<path d="M50 5 L86 50 L50 95 L14 50 Z" fill="${color}"/>`;
    case 's':
      // 위는 뾰족하고 어깨는 넓고 둥글게 — 몸통이 폭을 거의 다 쓴다
      return `<path d="M50 6 C50 6 10 36 10 58 C10 71 20 79 32 79 C39 79 45 75 50 69 ` +
        `C55 75 61 79 68 79 C80 79 90 71 90 58 C90 36 50 6 50 6 Z" fill="${color}"/>` +
        `<path d="${stem}" fill="${color}"/>`;
    case 'c':
      // 세 원을 넉넉히 겹치게 두고 가운데를 삼각형으로 메워야 하나의 덩어리로 보인다.
      // (원이 서로 닿기만 하면 이음새가 잘록해져 흩어진 것처럼 보인다)
      return `<path d="M50 27 L27 58 L73 58 Z" fill="${color}"/>` +
        `<circle cx="50" cy="27" r="22" fill="${color}"/>` +
        `<circle cx="27" cy="58" r="22" fill="${color}"/>` +
        `<circle cx="73" cy="58" r="22" fill="${color}"/>` +
        `<path d="${stem}" fill="${color}"/>`;
  }
}

// 무늬를 (cx, cy) 중심에 size 크기로, flip이면 180° 뒤집어 배치
function pip(suit: Suit, color: string, cx: number, cy: number, size: number, flip = false): string {
  const k = size / 100;
  const t = `translate(${cx - size / 2} ${cy - size / 2}) scale(${k})`;
  const inner = flip ? `<g transform="rotate(180 50 50)">${suitShape(suit, color)}</g>` : suitShape(suit, color);
  return `<g transform="${t}">${inner}</g>`;
}

// 숫자 카드의 표준 핍 배치 — [x비율, y비율] (y > 0.5 는 자동으로 뒤집는다)
const LAYOUTS: Record<string, [number, number][]> = {
  '2': [[0.5, 0.20], [0.5, 0.80]],
  '3': [[0.5, 0.20], [0.5, 0.50], [0.5, 0.80]],
  '4': [[0.31, 0.20], [0.69, 0.20], [0.31, 0.80], [0.69, 0.80]],
  '5': [[0.31, 0.20], [0.69, 0.20], [0.5, 0.50], [0.31, 0.80], [0.69, 0.80]],
  '6': [[0.31, 0.20], [0.69, 0.20], [0.31, 0.50], [0.69, 0.50], [0.31, 0.80], [0.69, 0.80]],
  '7': [[0.31, 0.20], [0.69, 0.20], [0.5, 0.35], [0.31, 0.50], [0.69, 0.50], [0.31, 0.80], [0.69, 0.80]],
  '8': [[0.31, 0.20], [0.69, 0.20], [0.5, 0.35], [0.31, 0.50], [0.69, 0.50], [0.5, 0.65], [0.31, 0.80], [0.69, 0.80]],
  '9': [[0.31, 0.18], [0.69, 0.18], [0.31, 0.39], [0.69, 0.39], [0.5, 0.50], [0.31, 0.61], [0.69, 0.61], [0.31, 0.82], [0.69, 0.82]],
  'T': [[0.31, 0.18], [0.69, 0.18], [0.5, 0.29], [0.31, 0.39], [0.69, 0.39], [0.31, 0.61], [0.69, 0.61], [0.5, 0.71], [0.31, 0.82], [0.69, 0.82]],
};

// 좌상단 인덱스 — 랭크 + 바로 아래 작은 무늬.
// 게임 화면에서는 카드가 아주 작게 보이므로 핍을 여러 개 흩뿌리는 정통 배치 대신
// "큰 랭크 + 큰 무늬 하나"로 단순하게 간다. 한눈에 읽히는 쪽이 우선.
function cornerIndex(rank: string, suit: Suit, color: string): string {
  const label = rankLabel(rank);
  // Georgia는 올드스타일 숫자(3·4·7·9는 베이스라인 아래로, 6·8은 위로)라서 랭크마다 크기가
  // 제각각으로 보인다. 높이가 일정한 라이닝 숫자를 쓰는 Times 계열로 고정하고,
  // 폰트 대체까지 대비해 lnum(라이닝)·tnum(고정폭)을 함께 지정한다.
  const FONT = `font-family="'Times New Roman',Times,'Liberation Serif',serif" ` +
    `font-feature-settings="'lnum' 1,'tnum' 1" font-variant-numeric="lining-nums tabular-nums"`;
  // '10'만 두 글자라 가로로 길어지므로, 크기는 그대로 두고 폭만 좁힌다
  const fit = label === '10' ? ` textLength="112" lengthAdjust="spacingAndGlyphs"` : '';
  return `<text x="${76}" y="${132}" text-anchor="middle" ${FONT}` +
    ` font-size="116" font-weight="700" fill="${color}"${fit}>${label}</text>` +
    pip(suit, color, 76, 208, 88);
}

// 모든 랭크가 같은 구성 — 좌상단 랭크·작은 무늬, 그 아래 중앙에 큰 무늬 하나
function cardSvg(rank: string, suit: Suit): string {
  const color = isRed(suit) ? RED : BLACK;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<defs><linearGradient id="f" x1="0" y1="0" x2="0.4" y2="1">` +
    `<stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eeeef1"/></linearGradient></defs>` +
    `<rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" rx="${18 * S}" fill="url(#f)" stroke="#c9c9d0" stroke-width="3"/>` +
    pip(suit, color, W / 2, 372, 216) +
    cornerIndex(rank, suit, color) +
    `</svg>`;
}

/* 뒷면 두 종류.
   기본(남색)은 블랙잭·바카라·포커 플립이 쓰고, 홀덤 테이블은 마룬(back-red)을 쓴다 —
   초록 펠트 위에서 남색은 가라앉아 보이고, 실제 포커룸도 붉은 계열을 쓴다. */
function backSvg(theme: 'navy' | 'red' = 'navy'): string {
  const c = theme === 'red'
    ? { g0: '#7a2230', g1: '#41101a', edge: '#94303c', hub: '#41101a' }
    : { g0: '#2a3a63', g1: '#141b30', edge: '#3a4a76', hub: '#141b30' };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<defs>` +
    `<linearGradient id="b" x1="0" y1="0" x2="0.5" y2="1">` +
    `<stop offset="0" stop-color="${c.g0}"/><stop offset="1" stop-color="${c.g1}"/></linearGradient>` +
    `<pattern id="lat" width="22" height="22" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<path d="M0 0 H22 M0 11 H22" stroke="#d4af37" stroke-width="1.6" opacity=".30"/>` +
    `<path d="M0 0 V22 M11 0 V22" stroke="#d4af37" stroke-width="1.6" opacity=".30"/>` +
    `</pattern></defs>` +
    `<rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" rx="${18 * S}" fill="url(#b)" stroke="${c.edge}" stroke-width="3"/>` +
    `<rect x="${14 * S}" y="${14 * S}" width="${W - 28 * S}" height="${H - 28 * S}" rx="${12 * S}" fill="url(#lat)"/>` +
    `<rect x="${14 * S}" y="${14 * S}" width="${W - 28 * S}" height="${H - 28 * S}" rx="${12 * S}" fill="none" stroke="#d4af37" stroke-width="2.5" opacity=".65"/>` +
    `<circle cx="${W / 2}" cy="${H / 2}" r="${42 * S}" fill="${c.hub}" stroke="#d4af37" stroke-width="2.5" opacity=".9"/>` +
    pip('s', '#d4af37', W / 2, H / 2, 46 * S) +
    `</svg>`;
}

const outDir = join(process.cwd(), 'public', 'cards');
mkdirSync(outDir, { recursive: true });

// 위키미디어 CC0 정품 삽화(npm run cards:fetch로 받은 것)가 이미 있으면 덮어쓰지 않는다.
// 이 스크립트는 뒷면 생성 + 못 받은 카드의 대체용으로 동작한다.
const isFetched = (p: string) => existsSync(p) && readFileSync(p, 'utf8').includes('inkscape');

let made = 0, kept = 0;
for (const suit of SUITS) {
  for (const rank of RANKS) {
    const p = join(outDir, `${rank}${suit}.svg`);
    if (isFetched(p)) { kept++; continue; }
    writeFileSync(p, cardSvg(rank, suit));
    made++;
  }
}
writeFileSync(join(outDir, 'back.svg'), backSvg('navy'));
writeFileSync(join(outDir, 'back-red.svg'), backSvg('red'));
console.log(`뒷면 2장 생성(남색·마룬). 앞면: 자체 생성 ${made}장, 받아둔 원본 유지 ${kept}장 (${outDir})`);
