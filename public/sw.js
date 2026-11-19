// P-Schedule 서비스 워커: 앱 설치(홈 화면·안드로이드 앱)와 알림(웹 푸시)
// 화면·데이터는 늘 서버에서 새로 받음 (캐시는 인터넷이 끊겼을 때 첫 화면만)
const CACHE = "ps-shell-v1";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/favicon.svg", "/icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// 같은 사이트의 화면 파일만: 먼저 서버에서 받고, 안 되면 저장해 둔 것으로 (API 는 건드리지 않음)
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok && SHELL.includes(url.pathname)) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {}); }
      return r;
    }).catch(() => caches.match(e.request).then((m) => m || (e.request.mode === "navigate" ? caches.match("/") : Response.error())))
  );
});
// 알림 받기: 서버가 보낸 { title, body, url, tag }
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "P-Schedule", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "P-Schedule", {
    body: d.body || "", tag: d.tag || undefined, renotify: !!d.tag, data: { url: d.url || "/" },
    icon: "/icons/icon-192.png", badge: "/icons/badge-96.png", lang: "ko"
  }));
});
// 알림을 누르면 열려 있는 창으로 가서 그 화면을 열고, 없으면 새로 엶
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "/", location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if (new URL(c.url).origin === location.origin) { c.focus(); return c.navigate ? c.navigate(target) : null; }
    return self.clients.openWindow(target);
  }));
});
