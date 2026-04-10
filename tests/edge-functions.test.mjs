import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const apiDir = join(root, 'api');
const apiOauthDir = join(root, 'api', 'oauth');
const sharedDir = join(root, 'shared');
const scriptsSharedDir = join(root, 'scripts', 'shared');

// All .js files in api/ except underscore-prefixed helpers (_cors.js, _api-key.js)
const edgeFunctions = readdirSync(apiDir)
  .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
  .map((f) => ({ name: f, path: join(apiDir, f) }));

// Also include api/oauth/ subdir edge functions
const oauthEdgeFunctions = readdirSync(apiOauthDir)
  .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
  .map((f) => ({ name: `oauth/${f}`, path: join(apiOauthDir, f) }));

const allEdgeFunctions = [...edgeFunctions, ...oauthEdgeFunctions];

// ALL .js AND .ts files in api/ root — used for node: built-in checks.
// Note: .ts edge functions (e.g. widget-agent.ts) are intentionally excluded from the
// module-isolation describe below because Vercel bundles them at build time, so
// imports from '../server/' are valid. The node: built-in check still applies.
const allApiFiles = [
  ...readdirSync(apiDir)
    .filter((f) => (f.endsWith('.js') || f.endsWith('.ts')) && !f.startsWith('_'))
    .map((f) => ({ name: f, path: join(apiDir, f) })),
  ...oauthEdgeFunctions,
];

describe('scripts/shared/ stays in sync with shared/', () => {
  const sharedFiles = readdirSync(sharedDir).filter((f) => f.endsWith('.json') || f.endsWith('.cjs'));
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
    const mod = await import(join(apiDir, '_rss-allowed-domains.js'));
    const domains = mod.default;
    assert.ok(Array.isArray(domains), 'Expected default export to be an array');
    assert.ok(domains.length > 200, `Expected 200+ domains, got ${domains.length}`);
    assert.ok(domains.includes('feeds.bbci.co.uk'), 'Expected BBC feed domain in list');
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

describe('Legacy api/*.js endpoint allowlist', () => {
  const ALLOWED_LEGACY_ENDPOINTS = new Set([
    'ais-snapshot.js',
    'bootstrap.js',
    'cache-purge.js',
    'contact.js',
    'download.js',
    'fwdstart.js',
    'geo.js',
    'gpsjam.js',
    'health.js',
    'military-flights.js',
    'og-story.js',
    'opensky.js',
    'oref-alerts.js',
    'polymarket.js',
    'product-catalog.js',
    'register-interest.js',
    'reverse-geocode.js',
    'mcp-proxy.js',
    'rss-proxy.js',
    'satellites.js',
    'seed-health.js',
    'story.js',
    'telegram-feed.js',
    'sanctions-entity-search.js',
    'version.js',
  ]);

  const currentEndpoints = readdirSync(apiDir).filter(
    (f) => f.endsWith('.js') && !f.startsWith('_'),
  );

  for (const file of currentEndpoints) {
    it(`${file} is in the legacy endpoint allowlist`, () => {
      assert.ok(
        ALLOWED_LEGACY_ENDPOINTS.has(file),
        `${file} is a new api/*.js endpoint not in the allowlist. ` +
          'New data endpoints must use the sebuf protobuf RPC pattern ' +
          '(proto definition → buf generate → handler in server/worldmonitor/{domain}/v1/ → wired in handler.ts). ' +
          'If this is a non-data ops endpoint, add it to ALLOWED_LEGACY_ENDPOINTS in tests/edge-functions.test.mjs.',
      );
    });
  }

  it('allowlist has no stale entries (all listed files exist)', () => {
    for (const file of ALLOWED_LEGACY_ENDPOINTS) {
      assert.ok(
        existsSync(join(apiDir, file)),
        `${file} is in ALLOWED_LEGACY_ENDPOINTS but does not exist in api/ — remove it from the allowlist.`,
      );
    }
  });
});

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

  it('consumes CSRF state from Upstash after validation (prevents replay)', () => {
    const src = readFileSync(callbackPath, 'utf-8');
    const getIdx = src.indexOf('upstashGet');
    const delIdx = src.indexOf('upstashDel');
    assert.ok(getIdx !== -1, 'callback.ts: must call upstashGet to validate state');
    assert.ok(delIdx !== -1, 'callback.ts: must call upstashDel to consume state after validation');
    assert.ok(
      getIdx < delIdx,
      'callback.ts: must validate state (upstashGet) before consuming it (upstashDel)',
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
    const globalIdx = headers.findIndex((r) => r.source === '/((?!docs).*)');
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

describe('Scenario run endpoint (api/scenario/v1/run.ts)', () => {
  const runPath = join(root, 'api', 'scenario', 'v1', 'run.ts');

  it('exports edge config with runtime: edge', () => {
    const src = readFileSync(runPath, 'utf-8');
    assert.ok(
      src.includes("runtime: 'edge'") || src.includes('runtime: "edge"'),
      'run.ts: must export config with runtime: edge',
    );
  });

  it('has a default export handler function', () => {
    const src = readFileSync(runPath, 'utf-8');
    assert.ok(
      src.includes('export default') && src.includes('function handler'),
      'run.ts: must have a default export handler function',
    );
  });

  it('returns 405 for non-POST requests', () => {
    const src = readFileSync(runPath, 'utf-8');
    assert.ok(
      src.includes('405'),
      'run.ts: must return 405 for non-POST requests',
    );
    assert.ok(
      src.includes("!== 'POST'") || src.includes('!== "POST"'),
      'run.ts: must check for POST method and reject other methods with 405',
    );
  });

  it('validates scenarioId is required', () => {
    const src = readFileSync(runPath, 'utf-8');
    assert.ok(
      src.includes('scenarioId'),
      'run.ts: must validate scenarioId field',
    );
    assert.ok(
      src.includes('400'),
      'run.ts: must return 400 for invalid/missing scenarioId',
    );
  });

  it('uses per-user rate limiting', () => {
    const src = readFileSync(runPath, 'utf-8');
    assert.ok(
      src.includes('rate') && src.includes('429'),
      'run.ts: must implement rate limiting with 429 response',
    );
  });

  it('uses AbortSignal.timeout on Redis fetch', () => {
    const src = readFileSync(runPath, 'utf-8');
    assert.ok(
      src.includes('AbortSignal.timeout'),
      'run.ts: all Redis fetches must have AbortSignal.timeout to prevent hanging edge isolates',
    );
  });
});

describe('Scenario status endpoint (api/scenario/v1/status.ts)', () => {
  const statusPath = join(root, 'api', 'scenario', 'v1', 'status.ts');

  it('exports edge config with runtime: edge', () => {
    const src = readFileSync(statusPath, 'utf-8');
    assert.ok(
      src.includes("runtime: 'edge'") || src.includes('runtime: "edge"'),
      'status.ts: must export config with runtime: edge',
    );
  });

  it('returns 400 for missing or invalid jobId', () => {
    const src = readFileSync(statusPath, 'utf-8');
    assert.ok(
      src.includes('400'),
      'status.ts: must return 400 for missing or invalid jobId',
    );
    assert.ok(
      src.includes('jobId'),
      'status.ts: must validate jobId query parameter',
    );
  });

  it('validates jobId format to guard against path traversal', () => {
    const src = readFileSync(statusPath, 'utf-8');
    assert.ok(
      src.includes('JOB_ID_RE') || src.includes('/^scenario:'),
      'status.ts: must validate jobId against a regex to prevent path traversal attacks (e.g. ../../etc/passwd)',
    );
  });

  it('uses AbortSignal.timeout on Redis fetch', () => {
    const src = readFileSync(statusPath, 'utf-8');
    assert.ok(
      src.includes('AbortSignal.timeout'),
      'status.ts: Redis fetch must have AbortSignal.timeout to prevent hanging edge isolates',
    );
  });
});
