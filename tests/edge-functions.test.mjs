import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listTrackedApiSourceFiles } from '../scripts/check-edge-function-bundles.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const apiDir = join(root, 'api');
const apiOauthDir = join(apiDir, 'oauth');
const sharedDir = join(root, 'shared');
const scriptsSharedDir = join(root, 'scripts', 'shared');

const trackedApiSources = listTrackedApiSourceFiles(root);

// Both api-wide guards below register one `it()` PER DISCOVERED FILE, so an
// empty discovery makes them emit zero assertions and this suite reports green
// while checking nothing — a `node:` import smuggled into an edge function
// would ship unnoticed. `git ls-files` exits 0 with empty output whenever the
// pathspec matches nothing, so that is reachable; the previous readdirSync
// implementation threw instead. Fail closed, mirroring the checker's own
// zero-entry guard.
describe('tracked api/ discovery', () => {
  it('finds at least one tracked api/ source', () => {
    assert.ok(
      trackedApiSources.length > 0,
      'listTrackedApiSourceFiles returned nothing — the guards below would pass vacuously',
    );
  });
});

// Legacy JS entrypoints at api/ and api/oauth/ have stricter isolation rules.
const allEdgeFunctions = trackedApiSources
  .filter((file) => file.endsWith('.js'))
  .filter((file) => ['api', 'api/oauth'].includes(dirname(file)))
  .map((file) => ({ name: file.slice('api/'.length), path: join(root, file) }));

// All tracked .js and .ts files under api/ are used for node: built-in checks.
// Note: .ts edge functions are intentionally excluded from the
// module-isolation describe below because Vercel bundles them at build time, so
// imports from '../server/' are valid. The node: built-in check still applies
// regardless of depth, since Vercel Edge Runtime rejects node: imports at runtime.
const allApiFiles = trackedApiSources.map((file) => ({
  name: file.slice('api/'.length),
  path: join(root, file),
}));

describe('scripts/shared/ stays in sync with shared/', () => {
  // Historical scope: .json (data) + .cjs (helpers).
  // Explicit additions (must be mirrored): edge-safe modules the cron consumes
  // (e.g. brief-llm-core.js + its .d.ts). Other .js files in shared/ are
  // client-only and intentionally NOT mirrored — grow this list only when a
  // new file is imported from `scripts/`.
  const explicitMirroredFiles = new Set([
    'brief-llm-core.js',
    'brief-llm-core.d.ts',
    'correlation-runtime-mode.js',
    // #6428: publisher-family resolution for corroboration counting, consumed
    // by scripts/_clustering.mjs (Railway rootDirectory=scripts) and by the
    // edge digest. Must stay byte-identical.
    'publisher-families.js',
    'publisher-families.d.ts',
    // U6/U7: pure URL classifier consumed by the brief filter (edge) AND
    // by the audit script under scripts/. Must stay byte-identical.
    'url-classifier.js',
  ]);
  // The attribution manifest is canonical at shared/ and is consumed by
  // repository-rooted build tooling. It is not a scripts-runtime input, so a
  // second committed copy would recreate the shared-file merge hotspot.
  const canonicalOnlyFiles = new Set(['source-attribution-manifest.json']);
  const sharedFiles = readdirSync(sharedDir).filter(
    (f) => !canonicalOnlyFiles.has(f)
      && (f.endsWith('.json') || f.endsWith('.cjs') || explicitMirroredFiles.has(f)),
  );
  for (const file of sharedFiles) {
    it(`scripts/shared/${file} matches shared/${file}`, () => {
      const srcPath = join(scriptsSharedDir, file);
      assert.ok(existsSync(srcPath), `scripts/shared/${file} is missing — run: cp shared/${file} scripts/shared/`);
      const original = readFileSync(join(sharedDir, file), 'utf8');
      const copy = readFileSync(srcPath, 'utf8');
      assert.strictEqual(copy, original, `scripts/shared/${file} is out of sync with shared/${file} — run: cp shared/${file} scripts/shared/`);
    });
  }
});

describe('Edge Function shared helpers resolve', () => {
  it('_rss-allowed-domains.js re-exports shared domain list', async () => {
    const mod = await import(pathToFileURL(join(apiDir, '_rss-allowed-domains.js')).href);
    const domains = mod.default;
    assert.ok(Array.isArray(domains), 'Expected default export to be an array');
    // Content parity, not just a smoke check. api/_rss-allowed-domains.js is a
    // hand-maintained literal mirror of the shared JSON (Vercel edge esbuild
    // cannot import JSON via import attributes, and api/*.js cannot import from
    // ../shared), so this assertion is the only thing stopping it drifting from
    // the source of truth. A domain added to shared/ but missed here 403s in the
    // edge proxy while every other consumer works — the same silent-drift class
    // the scripts/shared/ check above already guards against.
    const shared = JSON.parse(readFileSync(join(sharedDir, 'rss-allowed-domains.json'), 'utf8'));
    assert.deepStrictEqual(
      domains,
      shared,
      'api/_rss-allowed-domains.js is out of sync with shared/rss-allowed-domains.json — ' +
        'update the literal array in api/_rss-allowed-domains.js to match',
    );
  });
});

describe('Edge Function no node: built-ins', () => {
  for (const { name, path } of allApiFiles) {
    it(`${name} does not import node: built-ins (unsupported in Vercel Edge Runtime)`, () => {
      const src = readFileSync(path, 'utf-8');
      const match = src.match(/from\s+['"]node:(\w+)['"]/);
      assert.ok(
        !match,
        `${name}: imports node:${match?.[1]} — Vercel Edge Runtime does not support node: built-in modules. Use an edge-compatible alternative.`,
      );
    });
  }
});

// The legacy api/*.js allowlist that previously lived here was replaced by
// api/api-route-exceptions.json + scripts/enforce-sebuf-api-contract.mjs (see
// docs/adding-endpoints.mdx). The new check covers nested paths and .ts files,
// which this block missed.

describe('reverse-geocode Redis write', () => {
  const geocodePath = join(apiDir, 'reverse-geocode.js');

  it('uses ctx.waitUntil for Redis write (non-blocking, survives isolate teardown)', () => {
    const src = readFileSync(geocodePath, 'utf-8');
    assert.ok(
      src.includes('ctx.waitUntil('),
      'reverse-geocode.js: Redis cache write must use ctx.waitUntil() so the response is not blocked by the write',
    );
    assert.ok(
      !src.includes('await fetch(redisUrl'),
      'reverse-geocode.js: Redis write must not be awaited before returning the response',
    );
  });

  it('bounds the Redis write with AbortSignal.timeout', () => {
    const src = readFileSync(geocodePath, 'utf-8');
    assert.ok(
      src.includes('AbortSignal.timeout'),
      'reverse-geocode.js: Redis write must have AbortSignal.timeout to bound slow writes',
    );
  });
});

describe('oauth/authorize.js consent page safety', () => {
  const authorizePath = join(apiOauthDir, 'authorize.js');

  it('uses _js POST body field (not X-Requested-With header) for XHR detection — avoids CORS preflight', () => {
    const src = readFileSync(authorizePath, 'utf-8');
    assert.ok(
      !src.includes("'X-Requested-With'"),
      'authorize.js: must not send X-Requested-With header in fetch — it triggers CORS preflight which fails in WebView. Use _js POST body field instead.',
    );
    assert.ok(
      src.includes("params.get('_js') === '1'"),
      "authorize.js: must detect JS path via params.get('_js') === '1' from POST body.",
    );
  });

  it('allows null origin for WebView compatibility', () => {
    const src = readFileSync(authorizePath, 'utf-8');
    assert.ok(
      src.includes("origin !== 'null'"),
      "authorize.js: origin check must allow the string 'null' (WebView opaque origin). Without this, Connectors UI gets 403.",
    );
  });

  it('consent form includes _js hidden field set by inline script before FormData', () => {
    const src = readFileSync(authorizePath, 'utf-8');
    assert.ok(
      src.includes('name="_js"'),
      'authorize.js: consent form must include <input name="_js"> for JS-path detection.',
    );
    assert.ok(
      src.includes("jf.value='1'"),
      "authorize.js: inline script must set jf.value='1' before building FormData.",
    );
  });

  it('OPTIONS response includes Access-Control-Allow-Headers', () => {
    const src = readFileSync(authorizePath, 'utf-8');
    assert.ok(
      src.includes('Access-Control-Allow-Headers'),
      'authorize.js: OPTIONS response must include Access-Control-Allow-Headers.',
    );
  });
});

describe('api/slack/oauth/start.ts safety', () => {
  const startPath = join(root, 'api', 'slack', 'oauth', 'start.ts');

  it('uses crypto.getRandomValues for CSRF state (not Math.random)', () => {
    const src = readFileSync(startPath, 'utf-8');
    assert.ok(
      src.includes('crypto.getRandomValues'),
      'start.ts: CSRF state must use crypto.getRandomValues — Math.random is predictable and exploitable',
    );
    assert.ok(
      !src.includes('Math.random'),
      'start.ts: must not use Math.random for state generation',
    );
  });

  it('stores state in Upstash with EX TTL via pipeline (atomic)', () => {
    const src = readFileSync(startPath, 'utf-8');
    assert.ok(
      src.includes("'EX'") || src.includes('"EX"'),
      "start.ts: Upstash state entry must include 'EX' TTL to auto-expire unused tokens",
    );
    assert.ok(
      src.includes('/pipeline'),
      'start.ts: must use Upstash pipeline endpoint for atomic state storage',
    );
  });

  it('uses AbortSignal.timeout on Upstash pipeline fetch', () => {
    const src = readFileSync(startPath, 'utf-8');
    assert.ok(
      src.includes('AbortSignal.timeout'),
      'start.ts: Upstash pipeline fetch must have AbortSignal.timeout to prevent hanging edge isolates',
    );
  });

  it('validates bearer token before generating state', () => {
    const src = readFileSync(startPath, 'utf-8');
    // validateBearerToken must appear before getRandomValues
    const validateIdx = src.indexOf('validateBearerToken');
    const randomIdx = src.indexOf('getRandomValues');
    assert.ok(validateIdx !== -1, 'start.ts: must call validateBearerToken');
    assert.ok(randomIdx !== -1, 'start.ts: must call getRandomValues');
    assert.ok(
      validateIdx < randomIdx,
      'start.ts: validateBearerToken must come before getRandomValues — generate state only for authenticated users',
    );
  });
});

describe('api/slack/oauth/callback.ts safety', () => {
  const callbackPath = join(root, 'api', 'slack', 'oauth', 'callback.ts');

  it("uses '*' as postMessage targetOrigin (works on all WM subdomains and previews)", () => {
    const src = readFileSync(callbackPath, 'utf-8');
    assert.ok(
      src.includes("APP_ORIGIN = '*'"),
      "callback.ts: postMessage targetOrigin must be '*' so it works on tech/finance/happy subdomains and " +
      'preview deployments — a hardcoded origin would silently drop messages on all other origins. ' +
      "Security comes from the e.origin check in the listener, not from targetOrigin.",
    );
  });

  it('HTML-escapes the error param before embedding in response body (no XSS)', () => {
    const src = readFileSync(callbackPath, 'utf-8');
    assert.ok(
      src.includes('escapeHtml(error)'),
      'callback.ts: error param from Slack redirect must be HTML-escaped before embedding in response body — raw interpolation is a reflected XSS vector',
    );
  });

  it('atomically consumes CSRF state from Upstash (prevents concurrent replay)', () => {
    const src = readFileSync(callbackPath, 'utf-8');
    assert.ok(
      src.includes('upstashGetDel'),
      'callback.ts: must use a single atomic upstashGetDel operation to validate and consume state',
    );
    assert.ok(
      src.includes('/getdel/'),
      'callback.ts: state consumption must use Upstash GETDEL, not separate GET and DEL requests',
    );
    assert.ok(
      !src.includes('/get/') && !src.includes('/del/'),
      'callback.ts: split GET/DEL state consumption permits concurrent replay',
    );
  });

  it('uses AbortSignal.timeout on all Upstash fetches', () => {
    const src = readFileSync(callbackPath, 'utf-8');
    // Both upstashGet and upstashDel must have timeouts — count occurrences
    const timeoutCount = (src.match(/AbortSignal\.timeout/g) ?? []).length;
    assert.ok(
      timeoutCount >= 2,
      `callback.ts: all Upstash fetches must have AbortSignal.timeout — found ${timeoutCount}, expected at least 2 (upstashGet + upstashDel)`,
    );
  });

  it('does not redirect main window to Slack (dead-end fallback removed)', () => {
    const src = readFileSync(callbackPath, 'utf-8');
    assert.ok(
      !src.includes('window.location.href'),
      'callback.ts: must not redirect main window to Slack — without window.opener the user lands on a dead-end page. Show an allow-popups error instead.',
    );
  });
});

describe('vercel.json CSP: Slack OAuth callback has unsafe-inline override', () => {
  const vercelJson = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf-8'));

  it('vercel.json has a CSP override for /api/slack/oauth/callback allowing unsafe-inline scripts', () => {
    const rule = vercelJson.headers?.find((r) => r.source === '/api/slack/oauth/callback');
    assert.ok(rule, 'vercel.json: missing header rule for /api/slack/oauth/callback — the callback page serves inline JS (postMessage + window.close) which is blocked by the global CSP');
    const csp = rule.headers?.find((h) => h.key === 'Content-Security-Policy');
    assert.ok(csp, 'vercel.json: /api/slack/oauth/callback rule must include a Content-Security-Policy header');
    assert.ok(
      csp.value.includes("'unsafe-inline'"),
      "vercel.json: /api/slack/oauth/callback CSP must include 'unsafe-inline' in script-src — the callback page uses an inline <script> to call postMessage and window.close()",
    );
  });

  it('/api/slack/oauth/callback CSP override appears after the global CSP rule (must override it)', () => {
    const headers = vercelJson.headers ?? [];
    const globalIdx = headers.findIndex((rule) => rule.headers?.some(
      (header) => header.key === 'X-Frame-Options' && header.value === 'SAMEORIGIN',
    ));
    const callbackIdx = headers.findIndex((r) => r.source === '/api/slack/oauth/callback');
    assert.ok(globalIdx !== -1, 'vercel.json: global CSP rule not found');
    assert.ok(callbackIdx !== -1, 'vercel.json: callback CSP override not found');
    assert.ok(
      callbackIdx > globalIdx,
      'vercel.json: /api/slack/oauth/callback CSP override must appear AFTER the global rule — Vercel applies rules in order and the last match wins',
    );
  });
});

describe('Edge Function module isolation', () => {
  for (const { name, path } of allEdgeFunctions) {
    it(`${name} does not import from ../server/ (Edge Functions cannot resolve cross-directory TS)`, () => {
      const src = readFileSync(path, 'utf-8');
      assert.ok(
        !src.includes("from '../server/"),
        `${name}: imports from ../server/ — Vercel Edge Functions cannot resolve cross-directory TS imports. Inline the code or move to a same-directory .js helper.`,
      );
    });

    it(`${name} does not import from ../src/ (Edge Functions cannot resolve TS aliases)`, () => {
      const src = readFileSync(path, 'utf-8');
      assert.ok(
        !src.includes("from '../src/"),
        `${name}: imports from ../src/ — Vercel Edge Functions cannot resolve @/ aliases or cross-directory TS. Inline the code instead.`,
      );
    });
  }
});

// Scenario endpoints (run / status / templates) were migrated from literal-filename
// edge functions to ScenarioService RPCs in PR #3207 commit 7. See
// tests/scenario-handler.test.mjs for the handler-level coverage that preserves
// the security invariants (405/POST guard via sebuf service-config, scenarioId +
// iso2 validation, JOB_ID_RE path-traversal guard, per-IP 10/min rate limit via
// gateway, queue-depth backpressure, AbortSignal.timeout on Redis pipelines).
