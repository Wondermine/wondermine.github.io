/* Serves files unpacked from a ZIP bundle so a game's external assets
   (xml, images, other swfs, audio) resolve with normal relative URLs.
   index.html stores them in Cache Storage under <scope>vfs/<id>/<path>.

   Games also love hardcoded URLs ("/assets/a.png", "http://old-host.com/x/a.png").
   Those are answered from the bundle too, by matching the end of the path
   (a.png, then x/a.png ...), and anything that can't be found is reported
   so it shows up in Settings. */
const CACHE = 'swf-vfs';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };
// Never touch what Ruffle itself needs (its wasm and scripts come from a CDN).
const SKIP_HOST = /(^|\.)(unpkg\.com|jsdelivr\.net)$/i;
const SKIP_EXT = /\.(wasm|js|mjs|css|map|woff2?)$/i;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.mode === 'navigate') return;
  const url = new URL(req.url);
  const base = new URL(self.registration.scope).pathname;
  if (url.origin === location.origin) {
    if (url.pathname.startsWith(base + 'vfs/')) return e.respondWith(serve(url, e));
    if (url.pathname.startsWith(base)) return;             // the player's own files
    return e.respondWith(foreign(req, url, e));            // root-absolute path a game asked for
  }
  if (SKIP_HOST.test(url.hostname) || SKIP_EXT.test(url.pathname)) return;
  e.respondWith(foreign(req, url, e));                     // hardcoded remote URL
});

// Tell the page which file the game wanted but we don't have (shown in Settings).
async function report(e, what) {
  try {
    const c = e.clientId ? await self.clients.get(e.clientId) : null;
    const targets = c ? [c] : await self.clients.matchAll({ type: 'window' });
    targets.forEach(t => t.postMessage({ type: 'miss', path: what }));
  } catch (_) {}
}

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
  await report(e, safeDecode(url.pathname).replace(/^.*\/vfs\/[^/]+\//, ''));
  return new Response('Not found', { status: 404 });
}

// Best match = the cached file whose path shares the most trailing segments with the request.
async function bestTail(cache, pathname) {
  const want = safeDecode(pathname).toLowerCase().split('/').filter(Boolean);
  if (!want.length) return null;
  let best = null, bestN = 0;
  for (const req of await cache.keys()) {
    const have = safeDecode(new URL(req.url).pathname).toLowerCase().split('/').filter(Boolean);
    let n = 0;
    while (n < want.length && n < have.length && want[want.length - 1 - n] === have[have.length - 1 - n]) n++;
    if (n > bestN) { bestN = n; best = req; }
  }
  return bestN ? cache.match(best) : null;
}

async function foreign(req, url, e) {
  try {
    const hit = await bestTail(await caches.open(CACHE), url.pathname);
    if (hit) return hit;
  } catch (_) {}
  const label = url.origin === location.origin ? safeDecode(url.pathname) : url.href;
  try {
    const res = await fetch(req);
    if (res.type !== 'opaque' && !res.ok) report(e, label);
    return res;
  } catch (_) {
    report(e, label);
    return Response.error();
  }
}
