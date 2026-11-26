/**
 * Keeps the Playwright dev server (`VITE_E2E=1 WM_E2E_OFFLINE=1 vite`) off the
 * network.
 *
 * The e2e server runs the real dev API handlers in its own process. A spec's
 * page.route only sees browser requests, so without this guard the handlers
 * fetched live RSS, Redis and upstream APIs, and live data (such as a
 * breaking-news banner over the controls under test) decided whether specs
 * passed (#11185).
 *
 * Loopback stays open, so a local `.env.local` that points Redis or the relay
 * at localhost still feeds local runs; CI has no such services.
 */

// URL.hostname keeps IPv6 brackets, so `[::1]` is the only IPv6 loopback form.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function isLoopbackUrl(url: string): boolean {
  const host = hostOf(url);
  return host !== null && LOOPBACK_HOSTS.has(host);
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Replace `target.fetch` with one that rejects every non-loopback request the
 * way a network failure does, so handlers take their ordinary offline path.
 * Returns a function that restores the original.
 */
export function installE2eOutboundFetchGuard(
  target: { fetch: typeof fetch } = globalThis,
  warn: (message: string) => void = console.warn,
): () => void {
  const original = target.fetch;
  const warned = new Set<string>();
  target.fetch = ((input, init) => {
    const url = requestUrl(input);
    if (isLoopbackUrl(url)) {
      // Native fetch follows redirects without calling this guard again, so a
      // loopback server could bounce the request to an external host. Turn
      // any redirect it would follow into a network error instead.
      const mode = init?.redirect ?? (input instanceof Request ? input.redirect : 'follow');
      return mode === 'follow' ? original(input, { ...init, redirect: 'error' }) : original(input, init);
    }
    const host = hostOf(url) ?? url;
    if (!warned.has(host)) {
      warned.add(host);
      warn(`[e2e-network-guard] blocked outbound request to ${host}`);
    }
    return Promise.reject(new TypeError(`fetch failed: the e2e dev server blocks outbound requests (${host})`));
  }) as typeof fetch;
  return () => {
    target.fetch = original;
  };
}

type ProxyEntry = string | { target?: unknown; bypass?: unknown };

/**
 * When `enabled`, close every dev proxy rule that forwards to a non-loopback host: Vite
 * answers a `bypass` that returns false with a 404 (HTTP) or a refused
 * upgrade (WebSocket).
 */
export function closeExternalProxyRules<T extends Record<string, ProxyEntry>>(enabled: boolean, proxy: T): T {
  if (!enabled) return proxy;
  const closed: Record<string, ProxyEntry> = {};
  for (const [context, entry] of Object.entries(proxy)) {
    const options = typeof entry === 'string' ? { target: entry } : entry;
    const target = typeof options.target === 'string' ? options.target : String(options.target ?? '');
    closed[context] = isLoopbackUrl(target) ? entry : { ...options, bypass: () => false };
  }
  return closed as T;
}
