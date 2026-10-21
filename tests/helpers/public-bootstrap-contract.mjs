// The response contract for a `&public=1` bootstrap URL, in one place so the
// handler-level guard and the deployed-URL guard cannot drift.
//
// api/bootstrap-auth.test.mjs proves api/bootstrap.js returns this shape by
// calling handler() directly. That is necessary and not sufficient: three CORS
// surfaces sit in front of api.worldmonitor.app, and the Cloudflare Worker
// stamps its own headers onto the bytes users actually receive — including a
// path (KV serving, #7292) that never reaches the handler at all. #7308 was
// exactly that gap: the handler test was green while production served the
// credentialed shape on a public URL. So the same assertions also run against a
// deployed URL in tests/cors-preflight-live.test.mjs.

/**
 * The public shape: ACAO `*`, no Allow-Credentials, not keyed by Origin, and
 * Timing-Allow-Origin for the bootstrap transfer RUM (#7047).
 *
 * `Vary` is asserted as "does not name Origin" rather than "absent" because
 * Cloudflare appends `accept-encoding` for compression keying on the deployed
 * path. Origin-keying is the load-bearing half — it is what turns one shared
 * entry per URL into one per origin, and what lets a preview or embed origin
 * pin an echoed ACAO onto a cached response. Callers that own the response
 * outright (the handler test) additionally pin `Vary: null`.
 *
 * @param {{ assert: typeof import('node:assert').strict, resp: Response, label?: string }} args
 */
export function assertPublicBootstrapCorsHeaders({ assert, resp, label = 'public bootstrap' }) {
  assert.equal(
    resp.headers.get('access-control-allow-origin'), '*',
    `${label}: ACAO must be '*' — an echoed origin re-keys a caller-invariant payload`,
  );
  assert.equal(
    resp.headers.get('access-control-allow-credentials'), null,
    `${label}: Allow-Credentials must be absent on an unauthenticated public payload`,
  );
  const varyNames = (resp.headers.get('vary') || '')
    .split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
  assert.equal(
    varyNames.includes('origin'), false,
    `${label}: Vary must not name Origin; got '${resp.headers.get('vary')}'`,
  );
  assert.equal(
    resp.headers.get('timing-allow-origin'), '*',
    `${label}: Timing-Allow-Origin must stay '*' for the bootstrap transfer RUM (#7047)`,
  );
}

/**
 * The shared-cache declaration for a `&public=1` URL served by the Vercel
 * origin. Tier responses intentionally keep `public`/`s-maxage` OUT of
 * Cache-Control (Cloudflare, in front of api.worldmonitor.app, ignores
 * `Vary: Origin` and would mispin an echoed ACAO) and shield via
 * CDN-Cache-Control instead, so that is the header this reads.
 *
 * @param {{ assert: typeof import('node:assert').strict, resp: Response, label?: string }} args
 */
export function assertPublicBootstrapSharedCacheHeaders({ assert, resp, label = 'public bootstrap' }) {
  const cdn = resp.headers.get('cdn-cache-control');
  assert.ok(cdn, `${label}: CDN-Cache-Control must declare the shared lifetime`);
  assert.match(cdn, /\b(public|s-maxage)\b/i, `${label}: CDN-Cache-Control must be shared-cacheable; got '${cdn}'`);
}
