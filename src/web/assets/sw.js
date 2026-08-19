/* 서비스워커 — 앱으로 설치되기 위한 최소한이자, 정적 자산의 재전송을 없애는 층.
 *
 * ── 무엇을 캐시하지 "않는가" 가 이 파일의 핵심이다
 * 이 서비스의 화면은 전부 서버가 그린 HTML 이고 그 안에 잔액·판돈·남은 시간이 박혀
 * 있다. 페이지나 API 응답을 캐시하면 지난 판의 잔액이 화면에 남는다 — 새로고침해도
 * 안 바뀌고, 사용자는 자기 포인트가 사라졌다고 본다. 되돌리기도 어렵다: 서비스워커가
 * 한 번 잘못 캐시하면 그 브라우저에서는 서버를 고쳐도 낫지 않는다.
 *
 * 그래서 규칙을 단순하게 못 박는다.
 *   · 내용이 안 바뀌는 것만 캐시한다 — 카드 그림, 효과음, 아이콘, ?v= 가 붙은 app.css/js
 *   · 페이지와 API 는 그물에 걸리지 않게 그냥 통과시킨다 (respondWith 를 안 부른다)
 *   · 화면 이동이 네트워크 실패로 죽을 때만 /offline 을 대신 보여준다
 *
 * ── 되돌리는 법
 * SW=off 로 서버를 띄우면 이 파일 대신 스스로를 지우는 조각이 나간다(server.ts).
 * 이미 깔린 워커도 다음 이동 때 그 조각을 받아 캐시를 비우고 물러난다 — 사용자가
 * 아무것도 안 해도 원래대로 돌아간다.
 */
var V = '__ASSET_V__';
var CACHE = 'od-static-' + V;

/* 미리 받아 둘 것. 첫 화면에 반드시 필요한 것만 둔다 — 여기에 많이 넣으면 설치가
   그만큼 늦어지고, 하나라도 404 면 설치 자체가 실패한다. */
var PRECACHE = [
  '/app.css?v=' + V,
  '/app.js?v=' + V,
  '/favicon.svg',
  '/offline',
];

/* 내용이 바뀌지 않는 경로들. 카드와 효과음은 파일 이름이 곧 내용이고, app.css/js 는
   ?v= 가 바뀌면 다른 URL 이 된다. 그래서 캐시에 있으면 그대로 써도 안전하다. */
function isStatic(url) {
  return url.pathname === '/app.css'
    || url.pathname === '/app.js'
    || url.pathname === '/favicon.svg'
    || url.pathname.indexOf('/cards/') === 0
    || url.pathname.indexOf('/sfx/') === 0
    || url.pathname.indexOf('/img/') === 0
    || url.pathname.indexOf('/icon/') === 0;
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      /* 하나가 실패해도 설치는 되게 한다. addAll 은 전부 아니면 전무라, 자산 하나가
         잠깐 502 면 서비스워커가 아예 안 깔린다. */
      .then(function (c) {
        return Promise.all(PRECACHE.map(function (u) {
          return c.add(u).catch(function () { /* 이건 다음 요청 때 다시 받는다 */ });
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      /* 배포하면 V 가 바뀌므로 지난 판의 캐시는 통째로 버린다. 이름으로 지우기 때문에
         무엇이 들어 있었는지 몰라도 남는 것이 없다. */
      return Promise.all(keys.map(function (k) {
        return k !== CACHE ? caches.delete(k) : null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;   // 디스코드 아바타 등 바깥 것은 손대지 않는다

  if (isStatic(url)) {
    /* 캐시 우선. 없으면 받아서 넣어 둔다. 넣기는 실패해도 응답에는 영향이 없어야 한다 —
       저장 공간이 꽉 찬 기기에서 화면이 안 뜨는 일이 생기면 안 된다. */
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
          }
          return res;
        });
      })
    );
    return;
  }

  if (req.mode === 'navigate') {
    /* 화면 이동은 언제나 네트워크로 간다. 끊겼을 때만 안내 화면을 대신 보여준다 —
       캐시해 둔 페이지를 보여주면 지난 잔액이 그대로 뜬다. */
    e.respondWith(
      fetch(req).catch(function () {
        return caches.match('/offline').then(function (hit) {
          return hit || new Response('오프라인입니다', {
            status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        });
      })
    );
    return;
  }

  /* 나머지(API·인증·그 밖) 는 아무것도 하지 않는다. respondWith 를 안 부르면
     브라우저가 평소대로 처리한다 — 서비스워커가 없는 것과 똑같이 동작한다. */
});
