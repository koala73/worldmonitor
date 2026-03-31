/**
 * Minimal Sentry error reporter for Vercel Edge functions.
 * Uses the Sentry store endpoint directly via fetch (no SDK dependency).
 * DSN is read from VITE_SENTRY_DSN (available in edge runtime as a process env).
 */

let _key = '';
let _storeUrl = '';

(function parseDsn() {
  const dsn = process.env.VITE_SENTRY_DSN ?? '';
  if (!dsn) return;
  try {
    const u = new URL(dsn);
    _key = u.username;
    const projectId = u.pathname.replace(/^\//, '');
    _storeUrl = `${u.protocol}//${u.host}/api/${projectId}/store/`;
  } catch {}
})();

/**
 * @param {unknown} err
 * @param {Record<string, unknown>} [context]
 * @returns {Promise<void>}
 */
export async function captureEdgeException(err, context = {}) {
  if (!_storeUrl || !_key) return;
  const errMsg = err instanceof Error ? err.message : String(err);
  const errType = err instanceof Error ? err.constructor.name : 'Error';
  try {
    const res = await fetch(_storeUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${_key}`,
      },
      body: JSON.stringify({
        event_id: crypto.randomUUID().replace(/-/g, ''),
        timestamp: new Date().toISOString(),
        level: 'error',
        platform: 'javascript',
        environment: process.env.VERCEL_ENV ?? 'production',
        exception: { values: [{ type: errType, value: errMsg }] },
        extra: context,
        tags: { runtime: 'edge' },
      }),
    });
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403
        ? ' — check VITE_SENTRY_DSN and auth key'
        : res.status === 429
          ? ' — rate limited by Sentry'
          : ' — Sentry outage or transient error';
      console.warn(`[sentry-edge] non-2xx response ${res.status}${hint}`);
    }
  } catch (fetchErr) {
    console.warn('[sentry-edge] failed to deliver event:', fetchErr instanceof Error ? fetchErr.message : fetchErr);
  }
}
