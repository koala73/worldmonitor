/**
 * Shared envelope builder + delivery for the Vercel api/ Sentry helpers.
 *
 * `_sentry-edge.js` and `_sentry-node.js` were near-duplicates differing
 * only in the `runtime` / `platform` tag and a console-prefix string.
 * This module owns the envelope format, the stack-frame parser, and the
 * fire-and-forget fetch — the runtime-specific helpers are now thin
 * factories that bind those three knobs and re-export
 * `captureSilentError`.
 *
 * Any future change to the Sentry envelope format, the ingestion path,
 * the stack parser, or the keepalive/timeout policy lives here only.
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

// Best-effort stack-frame parse. Sentry accepts the raw `stack` string
// in `extra` if frames aren't parsed, but parsed frames render in the
// dashboard with file/line/function — much more useful for triage.
function parseStack(stack) {
  const lines = stack.split('\n').slice(1, 30); // skip the "Error: msg" header line
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
  // Sentry expects oldest frame first
  return frames.reverse();
}

/**
 * @param {unknown} err
 * @param {{ tags?: Record<string, string|number|boolean>, extra?: Record<string, unknown> }} [ctx]
 * @param {{ runtime: 'edge' | 'node', platform: 'javascript' | 'node' }} runtimeCfg
 */
function buildEnvelope(err, ctx, runtimeCfg) {
  const errMsg = err instanceof Error ? err.message : String(err);
  const errType = err instanceof Error ? err.constructor.name : 'Error';
  const stack = err instanceof Error && err.stack ? err.stack : undefined;
  const eventId = crypto.randomUUID().replace(/-/g, '');
  const timestamp = new Date().toISOString();

  const event = {
    event_id: eventId,
    timestamp,
    level: 'error',
    platform: runtimeCfg.platform,
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
    tags: { surface: 'api', runtime: runtimeCfg.runtime, ...(ctx?.tags ?? {}) },
    extra: ctx?.extra,
  };

  // Envelope format: header line, item header line, item payload line.
  const header = JSON.stringify({ event_id: eventId, sent_at: timestamp });
  const itemHeader = JSON.stringify({ type: 'event' });
  const itemPayload = JSON.stringify(event);
  return `${header}\n${itemHeader}\n${itemPayload}\n`;
}

async function deliver(body, logPrefix) {
  if (!_envelopeUrl || !_key) return;
  try {
    // `keepalive: true` is critical for Vercel edge runtime: when a
    // handler returns a Response, the V8 isolate can be torn down
    // before unawaited promises finish. `keepalive` lets the underlying
    // request survive isolate teardown so callers without access to
    // ctx (nested helpers, local tests) still deliver events.
    // Defence-in-depth: callers WITH ctx pass it via `opts.ctx` and
    // `makeCaptureSilentError` registers the promise via
    // `ctx.waitUntil` — see below.
    const res = await fetch(_envelopeUrl, {
      method: 'POST',
      keepalive: true,
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
      console.warn(`${logPrefix} non-2xx response ${res.status}${hint}`);
    }
  } catch (fetchErr) {
    console.warn(
      `${logPrefix} failed to deliver event:`,
      fetchErr instanceof Error ? fetchErr.message : fetchErr,
    );
  }
}

/**
 * Build a `captureSilentError(err, opts)` function bound to a runtime
 * (edge or node). The caller is the runtime-specific helper file.
 *
 * Opts:
 *   - `tags`  filterable Sentry tags
 *   - `extra` non-indexed event payload
 *   - `ctx`   the Vercel handler context (optional). When present, the
 *             helper calls `ctx.waitUntil(...)` so the V8 isolate stays
 *             alive long enough to dispatch the envelope fetch. When
 *             absent (local tests, sidecar, non-Vercel invocations),
 *             the call falls back to fire-and-forget — the
 *             `keepalive: true` flag on the underlying fetch is the
 *             safety net for in-flight delivery, and `.catch(() => {})`
 *             silences the unhandled-rejection diagnostic that would
 *             otherwise poison Node's test runner.
 *
 * The function returns the underlying Promise either way, so callers
 * that need to await delivery (e.g., a deeply nested helper running
 * inside an existing waitUntil chain) can still do so.
 */
export function makeCaptureSilentError({ runtime, platform, logPrefix }) {
  const runtimeCfg = { runtime, platform };
  return function captureSilentError(err, opts) {
    if (!_envelopeUrl || !_key) return Promise.resolve();
    const promise = deliver(buildEnvelope(err, opts, runtimeCfg), logPrefix);
    if (opts?.ctx && typeof opts.ctx.waitUntil === 'function') {
      opts.ctx.waitUntil(promise);
    } else {
      // Defuse unhandled rejection — `deliver` already swallows errors
      // internally, but belt-and-suspenders for environments where
      // `process.on('unhandledRejection')` is fatal (Node test runner).
      promise.catch(() => {});
    }
    return promise;
  };
}
