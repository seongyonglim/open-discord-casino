/* 앱으로 설치되기 위한 것들 — 매니페스트, 오프라인 안내 화면, 서비스워커 되돌리기.
 *
 * ── 왜 필요한가
 * 안드로이드 APK(TWA)는 웹 화면을 크롬으로 그대로 띄우는 껍데기다. 그 껍데기가
 * 성립하려면 이 사이트가 "설치할 수 있는 웹앱"이어야 하고, 그 조건이 매니페스트와
 * 서비스워커다. 지금 당장은 폰 브라우저에서 홈 화면에 추가할 수 있게 되는 것이 전부지만,
 * 이것이 없으면 Bubblewrap 이 APK 를 만들지 못한다.
 *
 * ── 색
 * theme_color 는 안드로이드가 상태 표시줄에 칠하는 색이고, background_color 는 앱이
 * 뜨는 동안(화면이 그려지기 전) 잠깐 보이는 바탕이다. 둘 다 CSS 의 --bg 와 맞춘다 —
 * 다르면 앱을 열 때 흰 화면이 한 번 번쩍인다.
 */
import { ASSET_V } from './assets';

/* css/01-base.css 의 --bg · --gold 와 같은 값이다. 여기서 다시 적는 이유는 매니페스트가
   JSON 이라 CSS 변수를 못 읽기 때문이다 — 값이 갈라지지 않는지는 audit-pwa 가 본다. */
export const THEME_BG = '#050506';
export const THEME_GOLD = '#d4af37';

/* 세로 고정을 걸지 않는다. 로비·랭킹·공지는 세로가 낫고 게임 화면만 가로가 나은데,
   매니페스트의 orientation 은 앱 전체에 걸린다 — 화면마다 다르게 하려면 게임 페이지에서
   screen.orientation.lock 을 부르는 쪽이라 여기서는 열어 둔다. */
export function manifest(): string {
  return JSON.stringify({
    name: 'OD CASINO',
    short_name: 'OD CASINO',
    description: '오픈 디스코드 포인트 카지노',
    /* 설치된 앱에서 열리는 첫 화면. ?src=pwa 를 붙여 두면 나중에 "앱으로 들어온 사람"을
       가려낼 수 있고, 브라우저에서 연 것과 별개의 시작점으로도 취급된다. */
    start_url: '/?src=pwa',
    scope: '/',
    display: 'standalone',
    background_color: THEME_BG,
    theme_color: THEME_BG,
    lang: 'ko',
    dir: 'ltr',
    categories: ['games', 'entertainment'],
    icons: [
      { src: `/icon/icon-192.png?v=${ASSET_V}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `/icon/icon-512.png?v=${ASSET_V}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      /* 안드로이드 런처는 아이콘을 원·둥근 사각 등으로 잘라낸다. 이 한 장이 없으면
         흰 배경이 잘려 나가 검은 테가 생긴다 (scripts/bake-icons.ts 가 굽는다). */
      { src: `/icon/icon-maskable-512.png?v=${ASSET_V}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    /* 홈 화면 아이콘을 길게 눌렀을 때 나오는 바로가기. 로비를 거치지 않고 바로 들어간다. */
    shortcuts: [
      { name: '홀덤 토너먼트', url: '/games/holdem' },
      { name: '랭킹', url: '/leaderboard' },
    ],
  }, null, 2);
}

/* 네트워크가 끊겼을 때 서비스워커가 대신 보여주는 화면.
   사람 정보를 한 글자도 담지 않는다 — 이 화면만은 캐시에 남기 때문이다. */
export function offlinePage(): string {
  return `<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>연결 끊김 · OD CASINO</title>
<style>
  html,body{margin:0;height:100%;background:${THEME_BG};color:#8b8b92;
    font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
    display:flex;align-items:center;justify-content:center;text-align:center}
  .b{padding:24px}
  h1{margin:0 0 10px;font-size:19px;color:#e8e8ea;font-weight:600}
  p{margin:0 0 20px;font-size:14px;line-height:1.6}
  button{background:none;border:1px solid ${THEME_GOLD};color:${THEME_GOLD};
    border-radius:8px;padding:9px 20px;font-size:14px;cursor:pointer}
</style></head>
<body><div class="b">
  <h1>연결이 끊겼습니다</h1>
  <p>인터넷이 돌아오면 다시 들어올 수 있습니다.<br>진행 중이던 판은 서버에 그대로 있습니다.</p>
  <button onclick="location.reload()">다시 시도</button>
</div></body></html>`;
}

/* 되돌리기 — SW=off 로 띄우면 서비스워커 자리에 이 조각이 나간다.
   이미 깔린 워커도 브라우저가 주기적으로 sw.js 를 다시 받아 보므로, 그때 이것을 받고
   스스로 물러난다. 사용자가 캐시를 지우거나 앱을 다시 깔 필요가 없다.
   이런 문이 없으면 서비스워커는 되돌리기가 가장 어려운 종류의 배포가 된다 — 서버를
   고쳐도 그 브라우저에는 낡은 워커가 남는다. */
export const SW_UNINSTALL = `/* SW=off — 스스로 물러난다 */
self.addEventListener('install', function (e) { e.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.registration.unregister(); })
      .then(function () { return self.clients.matchAll({ type: 'window' }); })
      .then(function (cs) { cs.forEach(function (c) { c.navigate(c.url); }); })
  );
});
`;

/** 서비스워커를 끌지 여부. 배포 후 이상하면 fly secrets 로 SW=off 를 넣는다. */
export function swOff(): boolean {
  return process.env.SW === 'off';
}
