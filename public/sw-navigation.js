/**
 * Navigation handling for the generated service worker.
 *
 * Loaded via the workbox `importScripts` option (runs inside the SW global
 * scope, before the workbox router registers its routes — the config no
 * longer declares a navigation runtimeCaching entry, so nothing else
 * responds to navigations).
 *
 * Why not a NetworkFirst runtime cache: a cached index.html is not coupled to
 * the precache manifest, so `cleanupOutdatedCaches` never clears it. After a
 * deploy the cached HTML references hashed chunks that were purged with the
 * old precache — an offline reload would 404 the bundle and blank the
 * dashboard. Here, navigations go network-first with NO cache write; when the
 * network is unreachable we fall back to the precached /offline.html
 * (registered via `includeAssets`), which is self-contained by design.
 */

/* global self, caches, URL */

const OFFLINE_URL = '/offline.html';
const NAVIGATION_TIMEOUT_MS = 5_000;

function fetchNavigation(request) {
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error('Navigation network timeout'));
    }, NAVIGATION_TIMEOUT_MS);
  });

  return Promise.race([
    fetch(request, { signal: controller.signal }),
    timeout,
  ]).finally(() => clearTimeout(timeoutId));
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Purge navigation caches written by earlier SW versions (the old
    // 'html-navigation' NetworkFirst cache) so a stale shell can never be
    // served after this version activates.
    try {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name === 'html-navigation')
          .map((name) => caches.delete(name)),
      );
    } catch {
      // Best-effort cleanup; never block activation.
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.mode !== 'navigate') return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  // API paths have their own runtime-caching policies; never answer them
  // with the offline shell.
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith((async () => {
    try {
      return await fetchNavigation(request);
    } catch (networkError) {
      const cached = await caches.match(OFFLINE_URL, { ignoreSearch: true });
      if (cached) return cached;
      // No fallback available (precache not populated yet) — surface the
      // network error rather than masking it.
      throw networkError;
    }
  })());
});
