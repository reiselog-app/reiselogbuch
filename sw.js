const CACHE="reiselog-v1";
const CORE=["./","index.html","app.css","app.js","manifest.webmanifest","icons/icon-192.png","icons/apple-touch-icon.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE&&k!=="reiselog-ext").map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{
  const req=e.request;if(req.method!=="GET")return;
  const url=new URL(req.url);
  if(url.hostname==="nominatim.openstreetmap.org")return; // Ortsnamen immer frisch
  if(url.origin===location.origin){
    // eigene Dateien: erst Netz (für Updates), sonst Cache
    e.respondWith(fetch(req).then(r=>{const c=r.clone();caches.open(CACHE).then(x=>x.put(req,c));return r}).catch(()=>caches.match(req).then(r=>r||caches.match("index.html"))));
  } else {
    // Schriften und Texterkennung: einmal laden, dann offline aus dem Cache
    e.respondWith(caches.open("reiselog-ext").then(c=>c.match(req).then(hit=>hit||fetch(req).then(r=>{if(r.ok||r.type==="opaque")c.put(req,r.clone());return r}))));
  }
});
