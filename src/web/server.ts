// 카지노 웹 서버 (Node 내장 http, 의존성 없음). 디스코드 Gateway 연결 없이 이 프로세스 하나로 동작.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { lobbyPage, noticeListPage, noticeDetailPage } from './pages';
import { leaderboardPage, handleRankApi } from './leaderboard';
import { achievementsPage, handleAchievements, handleUnlockers } from './achievements';
import {
  handleNotifications, handleNotificationsReadAll, handleNotificationRead,
  handleNotificationsDismissAll,
} from './notifications-api';
import { findNotice, seedNoticesOnce } from '../db/notices';
import { setRequestUser, LOGO_SVG } from './views';
import {
  adminPage, isAdmin, adminTokenOk,
  handleAdminUsers, handleAdminLedger, handleAdminPoints, handleAdminPurge, handleAdminTestTournament,
  handleAdminSeasonUpdate, handleAdminSeasonClose, handleAdminSeasonBackfill, handleAdminSeasonSchedule,
  handleAdminConfig, handleAdminConfigReset, handleAdminTournamentCreate, handleAdminTournamentRevoke,
  handleAdminRecurrence, handleAdminTournamentAbort,
  handleAdminNoticeCreate, handleAdminNoticeUpdate, handleAdminNoticeToggle, handleAdminNoticeDelete,
} from './admin';
import { handleLogin, handleCallback, handleLogout, currentUser, handlePreviewLogin, handleGo } from './auth';
import { getLeaderboard, touchActive } from '../db/queries';
import { adminResetRunningTournament } from '../db/holdem';
import { env } from '../env';
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
  handleUnregister as htUnregister, handleRecords as htRecords,
} from './games/holdem';
// 로비의 프리롤 카드가 대회 상태를 비추는 데 쓴다 (상태 판정은 이 함수에만 있다)
import { advanceHoldem } from '../db/holdem';
import { ensureSeasonClosed } from '../db/season-schedule';
import { ensureLockdown, lockedPath, LOCKDOWN_MSG } from './lockdown';
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
  // 우승·해금 음원은 아직 파일이 없다 — 넣는 순간 서빙되도록 목록에만 올려 둔다
  'tournament-win.mp3', 'achievement-unlock.mp3',
  /* 홀덤 액션 음성. 칩 소리를 대체하는 게 아니라 그 위에 겹쳐 낸다 —
     칩 소리는 "돈이 나갔다", 이건 "무슨 행동을 했다"로 역할이 다르다.
     체크는 칩이 나가지 않으므로 이 소리만 난다. */
  'act-allin.mp3', 'act-bet.mp3', 'act-call.mp3', 'act-check.mp3', 'act-raise.mp3',
  'act-fold.mp3',
  /* 폴드할 때 카드가 미끄러지는 소리. act-fold(음성) 위에 겹쳐 낸다 —
     음성은 "무슨 행동을 했다", 이건 카드가 실제로 밀려나는 그 순간의 소리다. */
  'fold-slide.mp3',
  /* 내 차례가 열린 순간. 시계 경고(clock-warn)와 달리 차례의 주인에게만 들린다 —
     남의 차례까지 울리면 알림이 아니라 소음이 된다. */
  'my-turn.mp3',
  /* 팟 획득 — 칩이 승자에게 밀려가는 소리(chips-to-winner) 위에 겹쳐 낸다.
     칩 소리는 "돈이 움직였다", 이건 "네가(또는 저 사람이) 이겼다"다. */
  'win-pot.mp3',
  // 제한 시간 5초 미만 경고. 시계 링이 붉어지는 순간에 한 번만 울린다
  'clock-warn.mp3',
  /* 올인 — 판을 통째로 거는 순간에만 깔린다(콜이 우연히 올인이 된 경우는 제외).
     act-allin 음성이 "올인"이라고 말하고, 이건 그 순간의 분위기를 담당한다. */
  'allin-bgm.mp3',
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
/* path 가 배열이면 그 순서로 이어 붙인다.
   스타일시트는 2,500줄이라 한 파일로는 읽을 수 없어 역할별로 나눴다(assets/css/).
   순서가 곧 동작이다 — CSS 는 뒤에 오는 규칙이 이기므로, 조각 순서를 바꾸면 화면이 바뀐다.
   그래서 순서는 assets/css/ORDER.txt 한 곳에만 적고 여기서 그대로 읽는다.
   이어 붙인 결과가 나누기 전과 한 글자도 다르지 않은지는 scripts/golden.ts 가 확인한다. */
const APP_FILES: Record<string, { path: string | string[]; mime: string }> = {
  '/app.css': { path: cssParts(), mime: 'text/css; charset=utf-8' },
  '/app.js': { path: 'app.js', mime: 'text/javascript; charset=utf-8' },
};

/* 돌려주는 경로는 src/web/assets/ 를 기준으로 한 상대 경로다 — serveAppFile 이 그 앞을
   붙이기 때문이다. 여기서도 'assets' 를 붙였다가 경로가 두 겹이 되어 500이 났었다. */
function cssParts(): string[] {
  return readFileSync(join(process.cwd(), 'src', 'web', 'assets', 'css', 'ORDER.txt'), 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '' && !l.startsWith('#'))
    .map(f => join('css', f));
}
const appCache = new Map<string, CachedAsset>();
/* 로컬 미리보기에서는 캐시하지 않는다.
   프로세스 수명 동안 캐시하면 스타일 한 줄을 고칠 때마다 서버를 다시 띄워야 한다 —
   시뮬레이션이 돌고 있으면 대회가 처음부터 다시 시작되므로, 화면을 확인하려던 그
   상황을 다시 만들 수 없다. 배포 환경(FLY_APP_NAME)에서는 그대로 캐시한다. */
const APP_CACHE_ON = !!process.env.FLY_APP_NAME || process.env.PREVIEW_LOGIN !== '1';

function serveAppFile(route: string, res: http.ServerResponse): void {
  const meta = APP_FILES[route];
  let hit = APP_CACHE_ON ? appCache.get(route) : undefined;
  if (!hit) {
    // app.js 안의 효과음 URL이 자산 버전을 필요로 하므로 여기서 치환한다
    const parts = Array.isArray(meta.path) ? meta.path : [meta.path];
    const text = parts
      .map(p => readFileSync(join(process.cwd(), 'src', 'web', 'assets', p), 'utf8'))
      /* 조각 사이에 줄바꿈 하나를 넣는다 — 조각은 마지막 줄의 줄바꿈을 갖고 있지 않다.
         나눌 때 원본을 줄 단위로 잘랐으므로, 같은 자리에 같은 줄바꿈을 되돌려 놓아야
         원본과 바이트가 같아진다. */
      .join('\n')
      .split('__ASSET_V__').join(ASSET_V);
    const raw = Buffer.from(text, 'utf8');
    hit = { raw, gz: gzipSync(raw, { level: 9 }) };
    if (APP_CACHE_ON) appCache.set(route, hit);
  }
  const useGz = acceptsGzip(res);
  sendBody(res, 200, meta.mime, useGz ? hit.gz! : hit.raw,
    { 'cache-control': APP_CACHE_ON ? 'public, max-age=604800' : 'no-store' },
    useGz ? 'gzip' : 'identity');
}

function send(res: http.ServerResponse, status: number, html: string): void {
  sendBody(res, status, 'text/html; charset=utf-8', html);
}

/* 권한이 없다고 분명히 말한다. 로그인한 사람에게만 보이는 화면이라 경로의 존재를
   숨길 이유가 없다 — 숨기면 운영자가 오타를 냈을 때 무엇이 잘못됐는지 알 수 없다. */
function forbiddenPage(): string {
  return '<!doctype html><meta charset="utf-8"><body style="background:#050506;color:#8b8b92;'
    + 'font-family:sans-serif;text-align:center;padding:80px">'
    + '운영자만 볼 수 있는 화면입니다 · <a style="color:#d4af37" href="/">로비로</a></body>';
}

function notFound(res: http.ServerResponse): void {
  send(res, 404, '<!doctype html><meta charset="utf-8"><body style="background:#050506;color:#8b8b92;font-family:sans-serif;text-align:center;padding:80px">페이지를 찾을 수 없습니다 · <a style="color:#d4af37" href="/">로비로</a></body>');
}

export function startWebServer(): void {
  const port = Number(process.env.PORT ?? 8080);
  /* 빈 DB 로 처음 뜨면 코드에 있던 공지를 한 번 심는다. 이미 글이 있으면 아무것도 안 한다 —
     운영자가 지운 글이 서버를 다시 띄울 때마다 되살아나면 지우기가 지우기가 아니게 된다. */
  seedNoticesOnce();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = decodeURIComponent(url.pathname);
      markEncoding(req, res);

      if (path === '/health') { res.writeHead(200); res.end('ok'); return; }

      /* 예약해 둔 시각이 지났으면 시즌을 넘긴다. 서버 타이머가 없으므로(fly 가 유휴 시
         프로세스를 재운다) 이런 일은 전부 요청이 들어올 때 따라잡는다 — 반복 개최와
         같은 방식이다. 예약이 없으면 설정 한 번 읽고 끝난다.
         /health 뒤에 두는 이유: 헬스 체크가 시즌을 넘기게 하지는 않는다. */
      ensureSeasonClosed();
      /* 마감 직전이면 열려 있는 판을 정산한다. 예약이 없으면 상태 계산 한 번으로 끝난다.
         ensureSeasonClosed 바로 뒤에 두는 이유: 방금 시즌이 넘어갔으면 예약이 지워져
         락다운도 함께 풀려야 하고, 그 순서로만 그렇게 된다. */
      const lock = ensureLockdown();
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

            /* 로비의 프리롤 카드가 대회 상태를 비추려면 상태가 필요하다. advanceHoldem을 쓴다 —
         상태 판정을 로비에서 따로 계산하면 로비 표시와 실제 대회가 갈라진다.
         지연 진행 구조라 이 호출이 밀린 일을 처리하기도 한다(그게 원래 설계다). */
      if (path === '/' || path === '/lobby') {
        return send(res, 200, lobbyPage(me, me ? advanceHoldem() : null));
      }
      if (path === '/leaderboard') return send(res, 200, leaderboardPage(me));

      /* 도전과제. 로그인 없이도 목록은 보인다 — 무엇을 할 수 있는 곳인지 알아야
         들어올 마음이 생긴다. 달성 표시만 비어 있게 나온다. */
      if (path === '/achievements') return send(res, 200, achievementsPage(me));
      if (path === '/api/achievements' && req.method === 'GET') {
        return await handleAchievements(req, res, me?.id ?? null);
      }
      if (path === '/api/achievements/unlockers' && req.method === 'GET') {
        return await handleUnlockers(req, res, url, me?.id ?? null);
      }

      /* 알림 — 전부 본인 것만 다룬다. 로그인 없이는 볼 것도 읽을 것도 없다. */
      if (path === '/api/notifications' && req.method === 'GET') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await handleNotifications(req, res, me.id);
      }
      if (path === '/api/notifications/read-all' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await handleNotificationsReadAll(req, res, me.id);
      }
      if (path === '/api/notifications/dismiss-all' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await handleNotificationsDismissAll(req, res, me.id);
      }
      if (path === '/api/notifications/read' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await handleNotificationRead(req, res, me.id);
      }
      if (path === '/api/leaderboard' && req.method === 'GET') return await handleRankApi(req, res, url, me);

      /* 운영자 화면. 보기는 admin 역할만, 바꾸는 동작은 admin + ADMIN_TOKEN 두 겹이다.
         로그인 안 한 사람에게는 이 경로의 존재를 알리지 않는다 — 다른 화면과 같이
         로그인으로 보낸다. 로그인했지만 권한이 없으면 403 으로 분명히 막는다. */
      if (path === '/admin') {
        if (!me) { res.writeHead(302, { location: '/auth/login' }); res.end(); return; }
        if (!isAdmin(me)) return send(res, 403, forbiddenPage());
        return send(res, 200, adminPage(me));
      }
      if (path.startsWith('/api/admin/')) {
        // 존재를 알리지 않는다 — 권한이 없으면 없는 경로처럼 굴게 한다
        if (!isAdmin(me)) return sendJson(res, 404, { error: 'not found' });
        if (path === '/api/admin/users' && req.method === 'GET') {
          return await handleAdminUsers(req, res, url.searchParams.get('q') ?? '');
        }
        /* 원장은 읽기만 한다 — 유저 검색과 같은 잠금(admin 세션)까지만 지난다.
           운영 토큰은 "바꾸는 동작"의 잠금이고, 여기서는 아무것도 바꾸지 않는다. */
        if (path === '/api/admin/ledger' && req.method === 'GET') {
          return await handleAdminLedger(req, res, url.searchParams.get('id') ?? '');
        }
        // 여기부터는 바꾸는 동작 — 두 번째 잠금을 지난 요청만 받는다
        if (!adminTokenOk(req)) return sendJson(res, 403, { error: '운영 토큰이 맞지 않습니다' });
        if (path === '/api/admin/points' && req.method === 'POST') return await handleAdminPoints(req, res);
        if (path === '/api/admin/tournament/purge' && req.method === 'POST') return await handleAdminPurge(req, res);
        if (path === '/api/admin/season/update' && req.method === 'POST') return await handleAdminSeasonUpdate(req, res);
        if (path === '/api/admin/season/close' && req.method === 'POST') return await handleAdminSeasonClose(req, res);
        if (path === '/api/admin/season/schedule' && req.method === 'POST') return await handleAdminSeasonSchedule(req, res);
        if (path === '/api/admin/season/backfill' && req.method === 'POST') return await handleAdminSeasonBackfill(req, res);
        if (path === '/api/admin/config' && req.method === 'POST') return await handleAdminConfig(req, res);
        if (path === '/api/admin/recurrence' && req.method === 'POST') return await handleAdminRecurrence(req, res);
        if (path === '/api/admin/config/reset' && req.method === 'POST') return await handleAdminConfigReset(req, res);
        if (path === '/api/admin/notice/create' && req.method === 'POST') return await handleAdminNoticeCreate(req, res);
        if (path === '/api/admin/notice/update' && req.method === 'POST') return await handleAdminNoticeUpdate(req, res);
        if (path === '/api/admin/notice/toggle' && req.method === 'POST') return await handleAdminNoticeToggle(req, res);
        if (path === '/api/admin/notice/delete' && req.method === 'POST') return await handleAdminNoticeDelete(req, res);
        if (path === '/api/admin/tournament/create' && req.method === 'POST') return await handleAdminTournamentCreate(req, res);
        if (path === '/api/admin/tournament/revoke' && req.method === 'POST') return await handleAdminTournamentRevoke(req, res);
        if (path === '/api/admin/tournament/abort' && req.method === 'POST') return await handleAdminTournamentAbort(req, res);
        if (path === '/api/admin/tournament/test' && req.method === 'POST') {
          return await handleAdminTestTournament(req, res);
        }
        return sendJson(res, 404, { error: 'not found' });
      }

      /* 공지사항 — 글은 DB(notices)에 있고 운영자 화면에서 고친다. 목록과 개별 글. */
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

      /* 시즌 마감 5분 전부터 새 베팅을 막는다.
         게임마다 막으면 여덟 곳에 같은 검사를 넣어야 하고, 새 게임이 붙는 날 빠진다.
         주소 목록 하나로 여기서 한 번에 거른다 — 무엇을 막고 무엇을 여는지도 그 목록에
         적혀 있다(web/lockdown 의 LOCKED_PATHS).

         응답에 lockdown 을 함께 실어 보낸다. 화면은 그것을 보고 안내 배너를 띄운다 —
         이미 화면을 열어 둔 사람은 새로 그려지지 않으므로, 막힌 그 순간이 알려 줄
         유일한 기회다. */
      if (lock.active && lockedPath(path)) {
        return sendJson(res, 403, {
          error: LOCKDOWN_MSG,
          lockdown: { active: true, secondsLeft: lock.secondsLeft },
        });
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
      if (path === '/api/games/holdem/unregister' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await htUnregister(req, res, me.id);
      }
      if (path === '/api/games/holdem/action' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await htAction(req, res, me.id);
      }
      if (path === '/api/games/holdem/sitin' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await htSitIn(req, res, me.id);
      }
      if (path === '/api/games/holdem/records' && req.method === 'GET') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await htRecords(req, res, me.id);
      }
      if (path === '/api/games/holdem/show' && req.method === 'POST') {
        if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
        return await htShow(req, res, me.id);
      }
      /* 진행 중인 대회를 "방금 시작한 상태"로 되감는다. 관리자만.
         서버가 죽거나 심하게 느려서 판이 제대로 굴러가지 못한 날을 구제하는 용도다 —
         취소하고 새로 열면 모인 사람이 흩어지므로, 사람은 두고 판만 되감는다.

         두 겹으로 잠근다: 로그인한 admin 이면서, 시크릿 ADMIN_TOKEN 과 맞는 헤더를
         함께 보내야 한다. 실수로 눌러서 남의 대회를 되감는 일이 없어야 하고,
         세션 하나가 새더라도 그것만으로는 못 쓰게 한다.
         ADMIN_TOKEN 이 비어 있으면 아예 막는다 — 빈 값과 빈 헤더가 우연히 같아지는
         경로를 남기지 않는다. */
      if (path === '/api/admin/holdem/reset' && req.method === 'POST') {
        const token = env('ADMIN_TOKEN');
        const given = String(req.headers['x-admin-token'] ?? '');
        if (!me || me.role !== 'admin') return sendJson(res, 404, { error: 'not found' });
        if (!token || given !== token) return sendJson(res, 403, { error: '토큰이 필요합니다' });
        return sendJson(res, 200, adminResetRunningTournament());
      }

      notFound(res);
    } catch (e) {
      console.error('웹 요청 처리 오류:', e);
      /* 응답이 이미 나갔으면 500 을 덧씌울 수 없다. res.writeHead 가
         ERR_HTTP_HEADERS_SENT 로 던지는데, 그 던짐이 이 catch 안에서 나므로 어디에도
         안 잡히고 async 핸들러의 미처리 거부가 된다 — 노드 기본값에서 그건 프로세스가
         죽는다는 뜻이다. 요청 하나의 오류로 접속자 전원이 끊긴다.
         이미 시작된 응답은 끊는 수밖에 없다(클라이언트는 다음 폴링에서 회복한다). */
      if (res.headersSent) { res.destroy(); return; }
      try {
        send(res, 500, '<!doctype html><meta charset="utf-8"><body style="background:#050506;color:#8b8b92;font-family:sans-serif;text-align:center;padding:80px">일시적인 오류가 발생했습니다</body>');
      } catch (e2) {
        console.error('오류 응답도 실패:', e2);
        res.destroy();
      }
    }
  });

  server.listen(port, () => console.log(`웹 서버 실행: http://0.0.0.0:${port}`));
  server.on('error', (err) => console.error('웹 서버 오류:', err));
}
