/* Serves files unpacked from a ZIP bundle so a game's external assets
   (xml, images, other swfs, audio) resolve with normal relative URLs.
   index.html stores them in Cache Storage under <scope>vfs/<id>/<path>. */
const CACHE = 'swf-vfs';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  const base = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(base + 'vfs/')) return;
  e.respondWith(serve(url, e));
});

async function serve(url, e) {
  const cache = await caches.open(CACHE);
  let res = await cache.match(url.origin + url.pathname);
  if (!res) {
    // Flash content is often authored on case-insensitive systems: match loosely.
    const want = safeDecode(url.pathname).toLowerCase();
    for (const req of await cache.keys()) {
      if (safeDecode(new URL(req.url).pathname).toLowerCase() === want) {
        res = await cache.match(req);
        break;
      }
    }
  }
  if (!res) {
    // Last resort: same file name anywhere in this bundle (flat picks, odd folder layouts).
    const m = url.pathname.match(/^(.*\/vfs\/[^/]+\/)/);
    const name = safeDecode(url.pathname).toLowerCase().split('/').pop();
    if (m) {
      const prefix = safeDecode(m[1]).toLowerCase();
      for (const req of await cache.keys()) {
        const p = safeDecode(new URL(req.url).pathname).toLowerCase();
        if (p.startsWith(prefix) && p.split('/').pop() === name) { res = await cache.match(req); break; }
      }
    }
  }
  if (res) return res;
  // Tell the page which file the game wanted but we don't have (shown in Settings).
  try {
    const rel = safeDecode(url.pathname).replace(/^.*\/vfs\/[^/]+\//, '');
    const c = e.clientId ? await self.clients.get(e.clientId) : null;
    const targets = c ? [c] : await self.clients.matchAll({ type: 'window' });
    targets.forEach(t => t.postMessage({ type: 'miss', path: rel }));
  } catch (_) {}
  return new Response('Not found', { status: 404 });
}
