/**
 * Minimal Sentry error reporter for Vercel Node-runtime API functions.
 *
 * Mirror of `_sentry-edge.js` for the ~17% of api/ files that don't
 * declare `runtime: 'edge'`. Same fetch-based approach (no SDK), same
 * `captureSilentError(err, { tags?, extra? })` signature, same Sentry
 * project (`VITE_SENTRY_DSN` — already public in the frontend bundle).
 *
 * Two helpers exist instead of one runtime-detected helper because each
 * api/ file declares its runtime statically; importing the matching
 * helper makes the runtime tag in Sentry events accurate without a
 * runtime check on every call. The only difference vs the edge variant
 * is the `runtime: 'node'` tag.
 */

let _key = '';
let _envelopeUrl = '';

(function parseDsn() {
  const dsn = process.env.VITE_SENTRY_DSN ?? '';
  if (!dsn) return;
  try {
    const u = new URL(dsn);
    _key = u.username;
    const projectId = u.pathname.replace(/^\//, '');
    _envelopeUrl = `${u.protocol}//${u.host}/api/${projectId}/envelope/`;
  } catch {
    // Malformed DSN — silently disable; never throw from a logger.
  }
})();

function buildEnvelope(err, ctx) {
  const errMsg = err instanceof Error ? err.message : String(err);
  const errType = err instanceof Error ? err.constructor.name : 'Error';
  const stack = err instanceof Error && err.stack ? err.stack : undefined;
  const eventId = crypto.randomUUID().replace(/-/g, '');
  const timestamp = new Date().toISOString();

  const event = {
    event_id: eventId,
    timestamp,
    level: 'error',
    platform: 'node',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'production',
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    exception: {
      values: [
        {
          type: errType,
          value: errMsg,
          ...(stack ? { stacktrace: { frames: parseStack(stack) } } : {}),
        },
      ],
    },
    tags: { surface: 'api', runtime: 'node', ...(ctx?.tags ?? {}) },
    extra: ctx?.extra,
  };

  const header = JSON.stringify({ event_id: eventId, sent_at: timestamp });
  const itemHeader = JSON.stringify({ type: 'event' });
  const itemPayload = JSON.stringify(event);
  return `${header}\n${itemHeader}\n${itemPayload}\n`;
}

function parseStack(stack) {
  const lines = stack.split('\n').slice(1, 30);
  const frames = [];
  for (const line of lines) {
    const m = line.match(/at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
    if (!m) continue;
    frames.push({
      function: m[1] || '<anonymous>',
      filename: m[2],
      lineno: Number(m[3]),
      colno: Number(m[4]),
    });
  }
  return frames.reverse();
}

async function deliver(body) {
  if (!_envelopeUrl || !_key) return;
  try {
    const res = await fetch(_envelopeUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${_key}`,
      },
      body,
    });
    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? ' — check VITE_SENTRY_DSN and auth key'
          : res.status === 429
            ? ' — rate limited by Sentry'
            : ' — Sentry outage or transient error';
      console.warn(`[sentry-node] non-2xx response ${res.status}${hint}`);
    }
  } catch (fetchErr) {
    console.warn(
      '[sentry-node] failed to deliver event:',
      fetchErr instanceof Error ? fetchErr.message : fetchErr,
    );
  }
}

/**
 * Report a caught error to Sentry without crashing the request.
 *
 * Same shape as the edge variant. See `_sentry-edge.js` for full docs.
 *
 * @param {unknown} err
 * @param {{ tags?: Record<string, string|number|boolean>, extra?: Record<string, unknown> }} [ctx]
 * @returns {Promise<void>}
 */
export async function captureSilentError(err, ctx) {
  if (!_envelopeUrl || !_key) return;
  await deliver(buildEnvelope(err, ctx));
}
