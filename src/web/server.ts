// 카지노 웹 서버 (Node 내장 http, 의존성 없음). 디스코드 Gateway 연결 없이 이 프로세스 하나로 동작.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { lobbyPage, leaderboardPage, noticeListPage, noticeDetailPage } from './pages';
import { findNotice } from './notices';
import { setRequestUser, LOGO_SVG } from './views';
import { handleLogin, handleCallback, handleLogout, currentUser, handlePreviewLogin, handleGo } from './auth';
import { getLeaderboard, touchActive } from '../db/queries';
import { handleInteractions } from '../discord/interactions';
import { sendJson, sendBody, markEncoding, acceptsGzip } from './http';
import { ASSET_V } from './assets';
import { minesPage, handleStart as minesStart, handleReveal as minesReveal, handleCashout as minesCashout } from './games/mines';
import { ladderPage, handleState as ladderState, handleBet as ladderBet, handleCancel as ladderCancel } from './games/ladder';
import {
  crashPage, handleState as crashState, handleBet as crashBet,
  handleCancel as crashCancel, handleCashout as crashCashout,
} from './games/crash';
import {
  pokerPage, handleState as pokerState, handleBet as pokerBet, handleClear as pokerClear,
} from './games/poker';
import {
  baccaratPage, handleState as baccState, handleBet as baccBet, handleClear as baccClear,
} from './games/baccarat';
import {
  blackjackPage, handleState as bjState, handleBet as bjBet,
  handleClear as bjClear, handleAction as bjAction,
} from './games/blackjack';
import {
  holdemPage, handleState as htState, handleRegister as htRegister,
  handleAction as htAction, handleSitIn as htSitIn, handleShow as htShow,
} from './games/holdem';
import { rankingGameOf, handleRanking } from './ranking';

// 정적 자산 서빙 — 효과음(Kenney Casino Audio, CC0)과 카드 SVG(scripts/gen-cards.ts로 생성).
// 경로 조작을 막기 위해 파일명을 화이트리스트로만 받고, 읽은 내용은 메모리에 캐시한다.
const SFX_FILES = new Set([
  'coin-insert.wav',              // 칩 올리기 (포커 플립)
  'coin-gain.mp3',                // 적중 회수 (포커 플립 · 지뢰찾기)
  'card-shuffle.wav',             // 새 라운드 셔플 (포커 플립)
  'card-deal.mp3',                // 카드 한 장씩 배분 (포커 플립)
  'card-flip.mp3',                // 카드 공개 (포커 플립)
  'win-fanfare.wav',              // 승리 팡파레 (그래프게임 · 사다리게임 공용)
  'mine-coin.mp3', 'explode.mp3', // 지뢰찾기 — 안전 칸 금화 / 폭발
  // 홀덤은 포인트가 아니라 토너먼트 칩을 다루므로 "동전 넣는" 소리가 아니라
  // 칩을 테이블에 내려놓는 소리를 쓴다. 두 종류를 무작위로 번갈아 낸다.
  'chip-bet.mp3', 'chip-bet2.mp3', 'chips-to-winner.mp3',
  // 우승 음원은 아직 파일이 없다 — 넣는 순간 서빙되도록 목록에만 올려 둔다
  'tournament-win.mp3',
]);
const MIME: Record<string, string> = {
  ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', jpg: 'image/jpeg',
  svg: 'image/svg+xml; charset=utf-8',
};
// 디스코드 임베드에서 불러가는 이미지. 디스코드 CDN에 올리는 대신 여기서 서빙한다
// (봇이 파일을 첨부하면 메시지를 지우고 다시 올릴 때마다 업로드가 반복된다).
const IMG_FILES = new Set(['broke.jpg']);
// 뒷면 두 종류 — back(남색)은 블랙잭·바카라·포커 플립, back-red(마룬)은 홀덤 테이블이 쓴다
const CARD_FILES = new Set<string>(['back.svg', 'back-red.svg']);
for (const s of ['s', 'h', 'd', 'c']) {
  for (const r of ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']) {
    CARD_FILES.add(`${r}${s}.svg`);
  }
}
// 원본과 gzip본을 함께 캐시한다. 자산은 내용이 바뀌지 않으니 압축은 프로세스당 한 번만 하면 된다.
// (효과음 wav가 무압축 PCM이라 gzip으로 32~47%까지 줄어든다 — 첫 방문 전송량의 대부분이 여기다)
interface CachedAsset { raw: Buffer; gz: Buffer | null }
const assetCache = new Map<string, CachedAsset>();

function serveAsset(dir: 'sfx' | 'cards' | 'img', name: string, res: http.ServerResponse): void {
  const allowed = dir === 'sfx' ? SFX_FILES : dir === 'img' ? IMG_FILES : CARD_FILES;
  if (!allowed.has(name)) { res.writeHead(404); res.end(); return; }
  const mime = MIME[name.split('.').pop() ?? ''] ?? 'application/octet-stream';
  const key = `${dir}/${name}`;
  let hit = assetCache.get(key);
  if (!hit) {
    let raw: Buffer;
    try {
      raw = readFileSync(join(process.cwd(), 'public', dir, name));
    } catch {
      res.writeHead(404); res.end(); return;
    }
    // 압축해서 10% 이상 줄어들 때만 gzip본을 보관한다 (mp3처럼 이미 압축된 건 원본이 낫다)
    const gz = gzipSync(raw, { level: 9 });
    hit = { raw, gz: gz.length < raw.length * 0.9 ? gz : null };
    assetCache.set(key, hit);
  }
  // gz본이 없으면 압축이 무의미한 파일이므로 sendBody가 다시 압축하지 않도록 identity로 못 박는다
  const useGz = hit.gz !== null && acceptsGzip(res);
  sendBody(res, 200, mime, useGz ? hit.gz! : hit.raw,
    { 'cache-control': 'public, max-age=604800' }, useGz ? 'gzip' : 'identity');
}

// 전역 스타일시트와 공용 스크립트. 모든 페이지가 같은 내용을 쓰므로 인라인 대신 여기서 서빙해
// 브라우저 캐시에 맡긴다(게임을 오갈 때마다 44KB를 다시 받고 파싱하던 비용이 사라진다).
// 내용은 프로세스 수명 동안 바뀌지 않으니 gzip까지 한 번만 해두고 재사용한다.
const APP_FILES: Record<string, { path: string; mime: string }> = {
  '/app.css': { path: 'app.css', mime: 'text/css; charset=utf-8' },
  '/app.js': { path: 'app.js', mime: 'text/javascript; charset=utf-8' },
};
const appCache = new Map<string, CachedAsset>();

function serveAppFile(route: string, res: http.ServerResponse): void {
  const meta = APP_FILES[route];
  let hit = appCache.get(route);
  if (!hit) {
    // app.js 안의 효과음 URL이 자산 버전을 필요로 하므로 여기서 치환한다
    const text = readFileSync(join(process.cwd(), 'src', 'web', 'assets', meta.path), 'utf8')
      .split('__ASSET_V__').join(ASSET_V);
    const raw = Buffer.from(text, 'utf8');
    hit = { raw, gz: gzipSync(raw, { level: 9 }) };
    appCache.set(route, hit);
  }
  const useGz = acceptsGzip(res);
  sendBody(res, 200, meta.mime, useGz ? hit.gz! : hit.raw,
    { 'cache-control': 'public, max-age=604800' }, useGz ? 'gzip' : 'identity');
}

function send(res: http.ServerResponse, status: number, html: string): void {
  sendBody(res, status, 'text/html; charset=utf-8', html);
}

function notFound(res: http.ServerResponse): void {
  send(res, 404, '<!doctype html><meta charset="utf-8"><body style="background:#050506;color:#8b8b92;font-family:sans-serif;text-align:center;padding:80px">페이지를 찾을 수 없습니다 · <a style="color:#d4af37" href="/">로비로</a></body>');
}

export function startWebServer(): void {
  const port = Number(process.env.PORT ?? 8080);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = decodeURIComponent(url.pathname);
      markEncoding(req, res);

      if (path === '/health') { res.writeHead(200); res.end('ok'); return; }
      if (APP_FILES[path]) return serveAppFile(path, res);
      if (path.startsWith('/sfx/')) return serveAsset('sfx', path.slice(5), res);
      if (path.startsWith('/cards/')) return serveAsset('cards', path.slice(7), res);
      if (path.startsWith('/img/')) return serveAsset('img', path.slice(5), res);
      if (path === '/favicon.svg') {
        sendBody(res, 200, 'image/svg+xml; charset=utf-8', LOGO_SVG,
          { 'cache-control': 'public, max-age=86400' });
        return;
      }

      // 디스코드 Interactions 웹훅 (버튼/슬래시커맨드) — Gateway 없이 이 라우트로만 상호작용을 받는다
      if (path === '/discord/interactions' && req.method === 'POST') {
        return await handleInteractions(req, res);
      }

      // 인증 라우트
      if (path === '/dev/login') return handlePreviewLogin(req, res);
      if (path === '/go') return handleGo(req, res);
      if (path === '/auth/login') return handleLogin(req, res);
      if (path === '/auth/callback') return await handleCallback(req, res, url);
      if (path === '/auth/logout') return handleLogout(req, res);

      // 페이지 렌더 직전 로그인 컨텍스트 설정 (SSR 동기 렌더라 안전)
      const me = currentUser(req, res);
      setRequestUser(me);
      if (me) touchActive(me.id, Date.now());

      if (path === '/' || path === '/lobby') return send(res, 200, lobbyPage(me));
      if (path === '/leaderboard') return send(res, 200, leaderboardPage(getLeaderboard(10), me?.id ?? null));

      /* 공지사항 — 글은 코드(web/notices.ts)에 있다. 목록과 개별 글. */
      if (path === '/notices') return send(res, 200, noticeListPage());
      if (path.startsWith('/notices/')) {
        const found = findNotice(decodeURIComponent(path.slice('/notices/'.length)));
        if (!found) { notFound(res); return; }
        return send(res, 200, noticeDetailPage(found));
      }

      /* 게임별 랭킹 — 여섯 게임이 같은 모양이라 한 곳에서 받는다.
         홀덤은 RANK_GAMES에 없으므로 여기서 걸리지 않고 404가 된다(의도한 것이다). */
      {
        const rankGame = rankingGameOf(path);
        if (rankGame && req.method === 'GET') {
          if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
          return handleRanking(req, res, rankGame, me.id);
        }
      }

      if (path === '/games/mines') {
        if (!me) { res.writeHead(302, { location: '/auth/login' }); res.end(); return; }
        return send(res, 200, minesPage(me));
      }
      if (path === '/api/games/mines/start' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await minesStart(req, res, me.id);
      }
      if (path === '/api/games/mines/reveal' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await minesReveal(req, res, me.id);
      }
      if (path === '/api/games/mines/cashout' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await minesCashout(req, res, me.id);
      }

      if (path === '/games/ladder') {
        if (!me) { res.writeHead(302, { location: '/auth/login' }); res.end(); return; }
        return send(res, 200, ladderPage(me));
      }
      if (path === '/api/games/ladder/state' && req.method === 'GET') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await ladderState(req, res, me.id);
      }
      if (path === '/api/games/ladder/bet' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await ladderBet(req, res, me.id, me.username);
      }
      if (path === '/api/games/ladder/cancel' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await ladderCancel(req, res, me.id);
      }

      if (path === '/games/graph') {
        if (!me) { res.writeHead(302, { location: '/auth/login' }); res.end(); return; }
        return send(res, 200, crashPage(me));
      }
      if (path === '/api/games/crash/state' && req.method === 'GET') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await crashState(req, res, me.id);
      }
      if (path === '/api/games/crash/bet' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await crashBet(req, res, me.id, me.username);
      }
      if (path === '/api/games/crash/cancel' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await crashCancel(req, res, me.id);
      }
      if (path === '/api/games/crash/cashout' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await crashCashout(req, res, me.id);
      }

      if (path === '/games/poker') {
        if (!me) { res.writeHead(302, { location: '/auth/login' }); res.end(); return; }
        return send(res, 200, pokerPage(me));
      }
      if (path === '/api/games/poker/state' && req.method === 'GET') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await pokerState(req, res, me.id);
      }
      if (path === '/api/games/poker/bet' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await pokerBet(req, res, me.id, me.username);
      }
      if (path === '/api/games/poker/clear' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await pokerClear(req, res, me.id);
      }

      if (path === '/games/baccarat') {
        if (!me) { res.writeHead(302, { location: '/auth/login' }); res.end(); return; }
        return send(res, 200, baccaratPage(me));
      }
      if (path === '/api/games/baccarat/state' && req.method === 'GET') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await baccState(req, res, me.id);
      }
      if (path === '/api/games/baccarat/bet' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await baccBet(req, res, me.id, me.username);
      }
      if (path === '/api/games/baccarat/clear' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await baccClear(req, res, me.id);
      }

      if (path === '/games/blackjack') {
        if (!me) { res.writeHead(302, { location: '/auth/login' }); res.end(); return; }
        return send(res, 200, blackjackPage(me));
      }
      if (path === '/api/games/blackjack/state' && req.method === 'GET') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await bjState(req, res, me.id);
      }
      if (path === '/api/games/blackjack/bet' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await bjBet(req, res, me.id, me.username);
      }
      if (path === '/api/games/blackjack/clear' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await bjClear(req, res, me.id);
      }
      if (path === '/api/games/blackjack/action' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await bjAction(req, res, me.id);
      }

      if (path === '/games/holdem') {
        if (!me) { res.writeHead(302, { location: '/auth/login' }); res.end(); return; }
        return send(res, 200, holdemPage(me));
      }
      if (path === '/api/games/holdem/state' && req.method === 'GET') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await htState(req, res, me.id);
      }
      if (path === '/api/games/holdem/register' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await htRegister(req, res, me.id, me.username);
      }
      if (path === '/api/games/holdem/action' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await htAction(req, res, me.id);
      }
      if (path === '/api/games/holdem/sitin' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await htSitIn(req, res, me.id);
      }
      if (path === '/api/games/holdem/show' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await htShow(req, res, me.id);
      }

      notFound(res);
    } catch (e) {
      console.error('웹 요청 처리 오류:', e);
      send(res, 500, '<!doctype html><meta charset="utf-8"><body style="background:#050506;color:#8b8b92;font-family:sans-serif;text-align:center;padding:80px">일시적인 오류가 발생했습니다</body>');
    }
  });

  server.listen(port, () => console.log(`웹 서버 실행: http://0.0.0.0:${port}`));
  server.on('error', (err) => console.error('웹 서버 오류:', err));
}
