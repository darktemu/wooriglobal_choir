/* 찬양대 연습노트 서비스 워커
 * - 앱 파일(같은 도메인): 네트워크 우선, 실패하면 캐시 → 항상 최신, 오프라인에서도 열림
 * - 글꼴·라이브러리(CDN): 캐시 우선
 * - Supabase API·음원·유튜브: 캐시하지 않음
 * 배포 내용을 크게 바꿨다면 VERSION 숫자를 올려 주세요.
 */
var VERSION = "v1";
var SHELL = "choir-shell-" + VERSION;
var RUNTIME = "choir-runtime-" + VERSION;
var SHELL_FILES = [
  "/", "/index.html", "/styles.css", "/app.js", "/config.js", "/data.json",
  "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"
];
var CDN_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(SHELL_FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== SHELL && k !== RUNTIME; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res.ok) { var copy = res.clone(); caches.open(SHELL).then(function (c) { c.put(req, copy); }); }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || (req.mode === "navigate" ? caches.match("/index.html") : Response.error());
        });
      })
    );
    return;
  }

  if (CDN_HOSTS.indexOf(url.hostname) >= 0) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) {
          if (res.ok || res.type === "opaque") { var copy = res.clone(); caches.open(RUNTIME).then(function (c) { c.put(req, copy); }); }
          return res;
        });
      })
    );
  }
  // 그 밖의 요청(Supabase, 음원, 유튜브)은 브라우저 기본 동작
});
