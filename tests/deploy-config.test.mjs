import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const vercelConfig = JSON.parse(readFileSync(resolve(__dirname, '../vercel.json'), 'utf-8'));
const viteConfigSource = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf-8');

const getCacheHeaderValue = (sourcePath) => {
  const rule = vercelConfig.headers.find((entry) => entry.source === sourcePath);
  const header = rule?.headers?.find((item) => item.key.toLowerCase() === 'cache-control');
  return header?.value ?? null;
};

describe('deploy/cache configuration guardrails', () => {
  it('disables caching for HTML entry routes on Vercel', () => {
    const spaNoCache = getCacheHeaderValue('/((?!api|mcp|oauth|assets|blog|docs|favico|map-styles|data|textures|pro|sw\\.js|workbox-[a-f0-9]+\\.js|manifest\\.webmanifest|offline\\.html|robots\\.txt|sitemap\\.xml|llms\\.txt|llms-full\\.txt|openapi\\.yaml|\\.well-known|wm-widget-sandbox\\.html).*)');
    assert.equal(spaNoCache, 'no-cache, no-store, must-revalidate');
  });

  it('keeps immutable caching for hashed static assets', () => {
    assert.equal(
      getCacheHeaderValue('/assets/(.*)'),
      'public, max-age=31536000, immutable'
    );
  });

  it('keeps PWA precache glob free of HTML files', () => {
    assert.match(
      viteConfigSource,
      /globPatterns:\s*\['\*\*\/\*\.\{js,css,ico,png,svg,woff2\}'\]/
    );
    assert.doesNotMatch(viteConfigSource, /globPatterns:\s*\['\*\*\/\*\.\{js,css,html/);
  });

  it('explicitly disables navigateFallback when HTML is not precached', () => {
    assert.match(viteConfigSource, /navigateFallback:\s*null/);
    assert.doesNotMatch(viteConfigSource, /navigateFallbackDenylist:\s*\[/);
  });

  it('uses network-only runtime caching for navigation requests', () => {
    assert.match(viteConfigSource, /request\.mode === 'navigate'/);
    assert.match(viteConfigSource, /handler:\s*'NetworkOnly'/);
  });

  it('contains variant-specific metadata fields used by html replacement and manifest', () => {
    const variantMetaSource = readFileSync(resolve(__dirname, '../src/config/variant-meta.ts'), 'utf-8');
    assert.match(variantMetaSource, /shortName:\s*'/);
    assert.match(variantMetaSource, /subject:\s*'/);
    assert.match(variantMetaSource, /classification:\s*'/);
    assert.match(variantMetaSource, /categories:\s*\[/);
    assert.match(
      viteConfigSource,
      /\.replace\(\/<meta name="subject" content="\.\*\?" \\\/>\/,\s*`<meta name="subject"/
    );
    assert.match(
      viteConfigSource,
      /\.replace\(\/<meta name="classification" content="\.\*\?" \\\/>\/,\s*`<meta name="classification"/
    );
  });
});

const getSecurityHeaders = () => {
  const rule = vercelConfig.headers.find((entry) => entry.source === '/((?!docs).*)');
  return rule?.headers ?? [];
};

const getHeaderValue = (key) => {
  const headers = getSecurityHeaders();
  const header = headers.find((h) => h.key.toLowerCase() === key.toLowerCase());
  return header?.value ?? null;
};

describe('security header guardrails', () => {
  it('includes all 5 required security headers on catch-all route', () => {
    const required = [
      'X-Content-Type-Options',
      'Strict-Transport-Security',
      'Referrer-Policy',
      'Permissions-Policy',
      'Content-Security-Policy',
    ];
    const headerKeys = getSecurityHeaders().map((h) => h.key);
    for (const name of required) {
      assert.ok(headerKeys.includes(name), `Missing security header: ${name}`);
    }
  });

  it('Permissions-Policy disables all expected browser APIs', () => {
    const policy = getHeaderValue('Permissions-Policy');
    const expectedDisabled = [
      'camera=()',
      'microphone=()',
      'accelerometer=()',
      'bluetooth=()',
      'display-capture=()',
      'gyroscope=()',
      'hid=()',
      'idle-detection=()',
      'magnetometer=()',
      'midi=()',
      'payment=(self "https://checkout.dodopayments.com" "https://test.checkout.dodopayments.com" "https://pay.google.com" "https://hooks.stripe.com" "https://js.stripe.com")',
      'screen-wake-lock=()',
      'serial=()',
      'usb=()',
      'xr-spatial-tracking=("https://challenges.cloudflare.com")',
    ];
    for (const directive of expectedDisabled) {
      assert.ok(policy.includes(directive), `Permissions-Policy missing: ${directive}`);
    }
  });

  it('Permissions-Policy delegates media APIs to allowed origins', () => {
    const policy = getHeaderValue('Permissions-Policy');
    // autoplay and encrypted-media delegate to self + YouTube
    for (const api of ['autoplay', 'encrypted-media']) {
      assert.match(
        policy,
        new RegExp(`${api}=\\(self "https://www\\.youtube\\.com" "https://www\\.youtube-nocookie\\.com"\\)`),
        `Permissions-Policy should delegate ${api} to YouTube origins`
      );
    }
    // geolocation delegates to self (used by user-location.ts)
    assert.ok(
      policy.includes('geolocation=(self)'),
      'Permissions-Policy should delegate geolocation to self'
    );
    // picture-in-picture delegates to self + YouTube + Turnstile
    assert.match(
      policy,
      /picture-in-picture=\(self "https:\/\/www\.youtube\.com" "https:\/\/www\.youtube-nocookie\.com" "https:\/\/challenges\.cloudflare\.com"\)/,
      'Permissions-Policy should delegate picture-in-picture to YouTube + Turnstile origins'
    );
  });

  it('CSP connect-src does not allow unencrypted WebSocket (ws:)', () => {
    const csp = getHeaderValue('Content-Security-Policy');
    const connectSrc = csp.match(/connect-src\s+([^;]+)/)?.[1] ?? '';
    assert.ok(!connectSrc.includes(' ws:'), 'CSP connect-src must not contain ws: (unencrypted WebSocket)');
    assert.ok(connectSrc.includes('wss:'), 'CSP connect-src should keep wss: for secure WebSocket');
  });

  it('CSP connect-src https: scheme is consistent between header and meta tag', () => {
    const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');
    const headerCsp = getHeaderValue('Content-Security-Policy');
    const metaMatch = indexHtml.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i);
    assert.ok(metaMatch, 'index.html must have a CSP meta tag');

    const headerConnectSrc = headerCsp.match(/connect-src\s+([^;]+)/)?.[1] ?? '';
    const metaConnectSrc = metaMatch[1].match(/connect-src\s+([^;]+)/)?.[1] ?? '';

    const headerHasHttps = /\bhttps:\b/.test(headerConnectSrc);
    const metaHasHttps = /\bhttps:\b/.test(metaConnectSrc);

    // The CSP violation listener suppresses HTTPS connect-src violations when the meta tag
    // contains https: in connect-src. If the header is tightened without the meta tag,
    // real violations would be silently suppressed. Both must stay in sync.
    assert.equal(headerHasHttps, metaHasHttps,
      `connect-src https: scheme mismatch: header=${headerHasHttps}, meta=${metaHasHttps}. ` +
      'If removing https: from connect-src, update the CSP violation listener in main.ts too.');
  });

  it('CSP connect-src does not contain localhost in production', () => {
    const csp = getHeaderValue('Content-Security-Policy');
    const connectSrc = csp.match(/connect-src\s+([^;]+)/)?.[1] ?? '';
    assert.ok(!connectSrc.includes('http://localhost'), 'CSP connect-src must not contain http://localhost in production');
  });

  it('CSP script-src includes wasm-unsafe-eval for WebAssembly support', () => {
    const csp = getHeaderValue('Content-Security-Policy');
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    assert.ok(scriptSrc.includes("'wasm-unsafe-eval'"), 'CSP script-src must include wasm-unsafe-eval for WASM support');
    assert.ok(scriptSrc.includes("'self'"), 'CSP script-src must include self');
  });

  it('CSP script-src includes Clerk origin for auth UI', () => {
    const csp = getHeaderValue('Content-Security-Policy');
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    assert.ok(
      scriptSrc.includes('clerk.accounts.dev') || scriptSrc.includes('clerk.worldmonitor.app'),
      'CSP script-src must include Clerk origin for auth UI to load'
    );
  });

  it('CSP frame-src includes Clerk origin for auth modals', () => {
    const csp = getHeaderValue('Content-Security-Policy');
    const frameSrc = csp.match(/frame-src\s+([^;]+)/)?.[1] ?? '';
    assert.ok(
      frameSrc.includes('clerk.accounts.dev') || frameSrc.includes('clerk.worldmonitor.app'),
      'CSP frame-src must include Clerk origin for sign-in modal'
    );
  });

  it('CSP script-src hashes are in sync between vercel.json header and index.html meta tag', () => {
    const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');
    const headerCsp = getHeaderValue('Content-Security-Policy');
    const metaMatch = indexHtml.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i);
    assert.ok(metaMatch, 'index.html must have a CSP meta tag');
    const metaCsp = metaMatch[1];

    const extractHashes = (csp) => {
      const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
      return new Set(scriptSrc.match(/'sha256-[A-Za-z0-9+/=]+'/g) ?? []);
    };

    const headerHashes = extractHashes(headerCsp);
    const metaHashes = extractHashes(metaCsp);

    const onlyHeader = [...headerHashes].filter(h => !metaHashes.has(h));
    const onlyMeta = [...metaHashes].filter(h => !headerHashes.has(h));

    assert.deepEqual(onlyHeader, [],
      `script-src hashes in vercel.json but missing from index.html: ${onlyHeader.join(', ')}. ` +
      'Dual CSP enforces both; mismatched hashes block scripts.');
    assert.deepEqual(onlyMeta, [],
      `script-src hashes in index.html but missing from vercel.json: ${onlyMeta.join(', ')}. ` +
      'Dual CSP enforces both; mismatched hashes block scripts.');
  });

  it('security.txt exists in public/.well-known/', () => {
    const secTxt = readFileSync(resolve(__dirname, '../public/.well-known/security.txt'), 'utf-8');
    assert.match(secTxt, /^Contact:/m, 'security.txt must have a Contact field');
    assert.match(secTxt, /^Expires:/m, 'security.txt must have an Expires field');
  });
});

// Per-route CSP override for the hosted brief magazine. The renderer
// emits an inline <script> (swipe/arrow/wheel/touch nav IIFE) whose
// hash is NOT on the global script-src allowlist, so the catch-all
// CSP silently blocks it. This rule relaxes script-src to
// 'unsafe-inline' for /api/brief/* only. All Redis-sourced content
// flows through escapeHtml() in brief-render.js before interpolation,
// so unsafe-inline doesn't open an XSS surface.
const getBriefSecurityHeaders = () => {
  const rule = vercelConfig.headers.find((entry) => entry.source === '/api/brief/(.*)');
  return rule?.headers ?? [];
};

const getBriefCspValue = () => {
  const headers = getBriefSecurityHeaders();
  const header = headers.find((h) => h.key.toLowerCase() === 'content-security-policy');
  return header?.value ?? null;
};

describe('brief magazine CSP override', () => {
  it('rule exists for /api/brief/(.*) with a Content-Security-Policy header', () => {
    const csp = getBriefCspValue();
    assert.ok(csp, 'Missing per-route CSP override for /api/brief/(.*) — the magazine nav IIFE will be blocked');
  });

  it('script-src includes unsafe-inline so the nav IIFE can execute', () => {
    const csp = getBriefCspValue();
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    assert.ok(
      scriptSrc.includes("'unsafe-inline'"),
      "brief CSP script-src must include 'unsafe-inline' — without it swipe/arrow nav is silently blocked",
    );
  });

  it('connect-src allows Cloudflare Insights analytics beacon to POST', () => {
    const csp = getBriefCspValue();
    const connectSrc = csp.match(/connect-src\s+([^;]+)/)?.[1] ?? '';
    assert.ok(
      connectSrc.includes('https://cloudflareinsights.com'),
      'brief CSP connect-src must allow cloudflareinsights.com so the CF beacon can POST to /cdn-cgi/rum',
    );
  });

  it('keeps tight defaults for non-script directives', () => {
    const csp = getBriefCspValue();
    for (const directive of [
      "default-src 'self'",
      "object-src 'none'",
      "form-action 'none'",
      "base-uri 'self'",
    ]) {
      assert.ok(csp.includes(directive), `brief CSP missing tight directive: ${directive}`);
    }
  });
});

// Agent readiness: RFC 9727 API catalog at /.well-known/api-catalog and
// the build-time copy of the OpenAPI spec from docs/api/ into public/.
// These guardrails protect against:
//   (1) the status endpoint href drifting away from /api/health (the
//       real JSON endpoint; the apex /health serves the SPA HTML);
//   (2) variant build scripts dropping the `npm run build:openapi`
//       prefix and silently shipping web bundles without the spec;
//   (3) the openapi source under docs/ being deleted without a
//       matching removal of the build step.
describe('agent readiness: api-catalog + openapi build', () => {
  const apiCatalog = JSON.parse(
    readFileSync(resolve(__dirname, '../public/.well-known/api-catalog'), 'utf-8')
  );
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));

  it('api anchor is first and points at the api host root', () => {
    assert.equal(apiCatalog.linkset[0].anchor, 'https://api.worldmonitor.app/');
  });

  it('status href points at /api/health (SPA lives at /health — would 200 HTML and look healthy)', () => {
    const statusHref = apiCatalog.linkset[0].status[0].href;
    assert.ok(
      statusHref.startsWith('https://api.worldmonitor.app'),
      `status href must be on api.worldmonitor.app, got: ${statusHref}`
    );
    assert.ok(
      statusHref.endsWith('/api/health'),
      `status href must end with /api/health (real JSON endpoint), got: ${statusHref}`
    );
  });

  it('service-desc points at /openapi.yaml with the OpenAPI media type', () => {
    const serviceDesc = apiCatalog.linkset[0]['service-desc'][0];
    assert.ok(
      serviceDesc.href.endsWith('/openapi.yaml'),
      `service-desc href must end with /openapi.yaml, got: ${serviceDesc.href}`
    );
    assert.equal(serviceDesc.type, 'application/vnd.oai.openapi');
  });

  it('has a second anchor for the MCP server-card', () => {
    const mcpEntry = apiCatalog.linkset.find((entry) => entry.anchor === 'https://worldmonitor.app/mcp');
    assert.ok(mcpEntry, 'linkset must contain an anchor for https://worldmonitor.app/mcp');
    const mcpServiceDesc = mcpEntry['service-desc']?.[0];
    assert.ok(mcpServiceDesc, 'mcp anchor must have a service-desc entry');
    assert.ok(
      mcpServiceDesc.href.endsWith('/.well-known/mcp/server-card.json'),
      `mcp service-desc href must end with /.well-known/mcp/server-card.json, got: ${mcpServiceDesc.href}`
    );
  });

  it('exposes a build:openapi script that copies docs/api → public/openapi.yaml', () => {
    const buildOpenapi = pkg.scripts['build:openapi'];
    assert.ok(buildOpenapi, 'package.json must define scripts["build:openapi"]');
    assert.ok(
      buildOpenapi.includes('docs/api/worldmonitor.openapi.yaml'),
      `build:openapi must reference docs/api/worldmonitor.openapi.yaml, got: ${buildOpenapi}`
    );
    assert.ok(
      buildOpenapi.includes('public/openapi.yaml'),
      `build:openapi must write to public/openapi.yaml, got: ${buildOpenapi}`
    );
  });

  it('every web-variant build chains npm run build:openapi', () => {
    // build:desktop and build:pro are intentionally excluded — Tauri
    // sidecar builds and the standalone pro-test workspace don't ship
    // the OpenAPI spec.
    const webVariants = ['build:full', 'build:tech', 'build:finance', 'build:happy', 'build:commodity'];
    for (const variant of webVariants) {
      const script = pkg.scripts[variant];
      assert.ok(script, `package.json must define scripts["${variant}"]`);
      assert.ok(
        script.includes('npm run build:openapi'),
        `scripts["${variant}"] must chain "npm run build:openapi" so the web bundle ships the spec; got: ${script}`
      );
    }
  });

  it('keeps a prebuild hook so the default `npm run build` path also copies the spec', () => {
    assert.ok(pkg.scripts.prebuild, 'package.json must define scripts["prebuild"] (default build path uses it)');
  });

  it('openapi source exists at docs/api/worldmonitor.openapi.yaml', () => {
    // Catches the class of regression where someone cleans generated
    // artifacts and forgets to regenerate before committing — the
    // prebuild step would then fail silently at deploy time.
    const openapiPath = resolve(__dirname, '../docs/api/worldmonitor.openapi.yaml');
    assert.ok(
      existsSync(openapiPath),
      `docs/api/worldmonitor.openapi.yaml must exist — without it, build:openapi fails at deploy time`
    );
  });
});

// The MCP endpoint and OAuth protected-resource metadata must be
// self-consistent per host. The static file that used to live at
// public/.well-known/oauth-protected-resource was replaced with a
// dynamic edge function at api/oauth-protected-resource.ts that
// derives `resource` and `authorization_servers` from the request
// Host header, so every origin (apex / www / api) sees same-origin
// metadata regardless of which host the scanner entered from.
// Scanners like isitagentready.com (and Cloudflare's reference at
// mcp.cloudflare.com) enforce that `authorization_servers[*]` share
// origin with `resource` — this construction guarantees that.
describe('agent readiness: MCP/OAuth origin alignment', () => {
  it('oauth-protected-resource handler returns origin-matching metadata per host', async () => {
    // Runtime test (not source-regex): dynamically import the edge handler
    // and invoke it against synthetic Host headers to prove the response
    // is actually same-origin per host, with correct Vary + Content-Type.
    const mod = await import('../api/oauth-protected-resource.ts');
    const handler = mod.default;
    assert.equal(typeof handler, 'function', 'handler must be the default export');

    const hosts = ['worldmonitor.app', 'www.worldmonitor.app', 'api.worldmonitor.app'];
    for (const host of hosts) {
      const req = new Request(`https://${host}/.well-known/oauth-protected-resource`, {
        headers: { host },
      });
      const res = await handler(req);
      assert.equal(res.status, 200, `status 200 for ${host}`);
      assert.equal(res.headers.get('content-type'), 'application/json', `JSON for ${host}`);
      assert.equal(res.headers.get('vary'), 'Host', `Vary: Host for ${host}`);
      const json = await res.json();
      assert.equal(json.resource, `https://${host}`, `resource matches ${host}`);
      assert.deepEqual(json.authorization_servers, [`https://${host}`], `auth_servers match ${host}`);
      assert.deepEqual(json.bearer_methods_supported, ['header']);
      assert.deepEqual(json.scopes_supported, ['mcp']);
    }
  });

  it('MCP server card authentication.resource is a valid https URL on a known host', () => {
    const mcpCard = JSON.parse(
      readFileSync(resolve(__dirname, '../public/.well-known/mcp/server-card.json'), 'utf-8')
    );
    const u = new URL(mcpCard.authentication.resource);
    assert.equal(u.protocol, 'https:');
    assert.ok(
      ['worldmonitor.app', 'www.worldmonitor.app', 'api.worldmonitor.app'].includes(u.host),
      `unexpected host: ${u.host}`
    );
  });

  it('api/mcp.ts resource_metadata is host-derived, not hardcoded', () => {
    const source = readFileSync(resolve(__dirname, '../api/mcp.ts'), 'utf-8');
    // Must NOT contain a hardcoded apex or api URL for resource_metadata —
    // that regressed once (PR #3351 review: apex pointer emitted from
    // api.worldmonitor.app/mcp 401s) and the grep-only test didn't catch it.
    assert.ok(
      !/resource_metadata="https:\/\/(?:api\.)?worldmonitor\.app\/\.well-known\//.test(source),
      'api/mcp.ts must not hardcode resource_metadata URL — derive from request host'
    );
    // Must contain a template-literal construction that uses a host variable.
    assert.match(
      source,
      /resource_metadata="\$\{[A-Za-z_][A-Za-z0-9_]*\}"|`[^`]*resource_metadata="\$\{[^}]+\}"/,
      'api/mcp.ts must construct resource_metadata from a host-derived variable'
    );
    // Must actually read the request host header somewhere in the file.
    assert.match(
      source,
      /request\.headers\.get\(['"]host['"]\)|req\.headers\.get\(['"]host['"]\)/i,
      'api/mcp.ts should read the request host header'
    );
  });

  it('vercel.json rewrites /.well-known/oauth-protected-resource to the edge fn', () => {
    const rewrite = vercelConfig.rewrites.find(
      (r) => r.source === '/.well-known/oauth-protected-resource'
    );
    assert.ok(rewrite, 'expected a rewrite for /.well-known/oauth-protected-resource');
    assert.equal(rewrite.destination, '/api/oauth-protected-resource');
  });
});

// PR history: #3204 / #3206 forced the resvg linux-x64-gnu native
// binding into the carousel function via vercel.json
// `functions.includeFiles`. That entire workaround became unnecessary
// once the route moved to @vercel/og on Edge runtime (see
// api/brief/carousel/...), which bundles satori + resvg-wasm with
// Vercel-native support. The `functions` block was removed.
//
// If any future route ever needs a Vercel `functions` config, keep
// in mind: the keys are micromatch globs, NOT literal paths.
// `[userId]` is a character class (match one of u/s/e/r/I/d), not a
// dynamic segment placeholder. Use `api/foo/**` for routes with
// dynamic brackets. See skill `vercel-native-binding-peer-dep-missing`
// for the full story.
describe('vercel.json functions config (none expected after carousel moved to edge)', () => {
  it('does not define any `functions` block (carousel now uses @vercel/og on edge)', () => {
    assert.equal(
      vercelConfig.functions,
      undefined,
      'No routes currently require a functions config. If adding one, ' +
        'remember Vercel treats the key as a micromatch glob — ' +
        '`[userId]` will silently match one of {u,s,e,r,I,d} and your ' +
        'rule will apply to nothing. See skill ' +
        'vercel-native-binding-peer-dep-missing for the gotcha.',
    );
  });
});
