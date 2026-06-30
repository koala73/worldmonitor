import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const vercelConfig = JSON.parse(readFileSync(resolve(__dirname, '../vercel.json'), 'utf-8'));
const viteConfigSource = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf-8');
const proViteConfigSource = readFileSync(resolve(__dirname, '../pro-test/vite.config.ts'), 'utf-8');
const mainSource = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');
const zodCspSource = readFileSync(resolve(__dirname, '../src/bootstrap/zod-csp.ts'), 'utf-8');
const proIndexCssSource = readFileSync(resolve(__dirname, '../pro-test/src/index.css'), 'utf-8');
const middlewareSource = readFileSync(resolve(__dirname, '../middleware.ts'), 'utf-8');
const dockerfileSource = readFileSync(resolve(__dirname, '../Dockerfile'), 'utf-8');
const dockerNginxSource = readFileSync(resolve(__dirname, '../docker/nginx.conf'), 'utf-8');
const frontendDockerfileSource = readFileSync(resolve(__dirname, '../docker/Dockerfile'), 'utf-8');
const SPA_HTML_CACHE_SOURCE = '/((?!api|mcp|oauth|assets|blog|docs|embed|embed\\.html|favico|map-styles|data|textures|pro|sw\\.js|workbox-[a-f0-9]+\\.js|manifest\\.webmanifest|offline\\.html|robots\\.txt|sitemap\\.xml|llms\\.txt|llms-full\\.txt|openapi\\.yaml|\\.well-known|wm-widget-sandbox\\.html|mcp-grant\\.html|mcp-grant).*)';
const GLOBAL_SECURITY_HEADER_SOURCE = '/((?!docs|embed|embed\\.html).*)';
const APP_ROOT_HOST_PATTERN = '^(?:(?:www|tech|finance|commodity|happy|energy)\\.)?worldmonitor\\.app$';
const GLOBAL_CSP_INLINE_SCRIPT_HTML_FILES = [
  'index.html',
  'settings.html',
  'live-channels.html',
  'mcp-grant.html',
  'public/offline.html',
  'public/pro/index.html',
  'public/pro/welcome.html',
];
const GLOBAL_CSP_EXTERNAL_SCRIPT_HTML_FILES = [
  'index.html',
  'settings.html',
  'live-channels.html',
  'mcp-grant.html',
  'public/pro/index.html',
  'public/pro/welcome.html',
];
const STATIC_SCRIPT_NONCE = 'wm-static-bootstrap';

const getCacheHeaderValue = (sourcePath) => {
  const rule = vercelConfig.headers.find((entry) => entry.source === sourcePath);
  const header = rule?.headers?.find((item) => item.key.toLowerCase() === 'cache-control');
  return header?.value ?? null;
};

const getHeadersForSource = (sourcePath) => {
  return vercelConfig.headers.find((entry) => entry.source === sourcePath)?.headers ?? [];
};

const getHeaderValueForSource = (sourcePath, key) => {
  const headers = getHeadersForSource(sourcePath);
  const header = headers.find((h) => h.key.toLowerCase() === key.toLowerCase());
  return header?.value ?? null;
};

const getCspDirectiveTokens = (csp, directive) => {
  const directiveSource = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${directive} `));
  const tokens = directiveSource?.slice(directive.length).trim().split(/\s+/).filter(Boolean) ?? [];
  return [...new Set(tokens)].sort();
};

const getInlineScriptHashTokens = (htmlSource) => {
  return [...htmlSource.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((body) => body.trim().length > 0)
    .map((body) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`);
};

const hasCspMeta = (htmlSource) => /<meta\b[^>]+http-equiv=["']Content-Security-Policy["']/i.test(htmlSource);

const getExternalScriptTags = (htmlSource) => {
  return [...htmlSource.matchAll(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>/gi)]
    .map((match) => match[0]);
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getVariantHosts = () => {
  const variantMetaSource = readFileSync(resolve(__dirname, '../src/config/variant-meta.ts'), 'utf-8');
  return [...variantMetaSource.matchAll(/url:\s*'https:\/\/([^/']+)\//g)]
    .map((match) => match[1])
    .sort();
};

const getVariantUrls = () => {
  const variantMetaSource = readFileSync(resolve(__dirname, '../src/config/variant-meta.ts'), 'utf-8');
  return Object.fromEntries(
    [...variantMetaSource.matchAll(/\n\s{2}([a-z]+):\s*\{[\s\S]*?url:\s*'([^']+)'/g)]
      .map((match) => [match[1], match[2]])
  );
};

describe('deploy/cache configuration guardrails', () => {
  it('requires revalidation for HTML entry routes on Vercel without disabling bfcache', () => {
    // /mcp-grant added to the negative-lookahead by plan 2026-05-10-001 U3 — apex
    // Pro-MCP consent page must opt out of the SPA catch-all rewrite (it is its
    // own HTML entry registered in vite.config.ts rollupOptions.input).
    //
    // The exclusion uses literal alternation (`mcp-grant\\.html|mcp-grant`)
    // rather than a non-capturing group with `?` quantifier — Vercel's
    // path-to-regexp source-pattern parser rejects `(?:...)` in `source` fields
    // (deploy-fail PR #3646 round-2 review).
    //
    // The header uses `private, no-cache, must-revalidate` rather than the
    // previous `no-cache, no-store, must-revalidate` (PR #4004 / issue #3993).
    // `no-store` fully disabled Chrome's bfcache (Lighthouse flagged 7 failure
    // reasons rooted in this header). `no-cache` without `no-store` still
    // revalidates on every navigation but lets bfcache restore on back/forward.
    // `private` keeps shared caches (CDN, corporate proxies) from holding
    // personalized HTML.
    const spaNoCache = getCacheHeaderValue(SPA_HTML_CACHE_SOURCE);
    assert.equal(spaNoCache, 'private, no-cache, must-revalidate');
    assert.ok(!spaNoCache.includes('no-store'), 'HTML must not set no-store — it disables bfcache');
  });

  it('disables caching for the apex /mcp-grant Pro-MCP consent page (both URL forms)', () => {
    // The Pro-MCP consent page is its own HTML entry. Both /mcp-grant (the
    // pretty URL, rewritten to /mcp-grant.html by vercel.json:12) and
    // /mcp-grant.html (the bundle path) must carry no-store. Vercel needs
    // explicit per-source rules — `(?:\\.html)?` quantifiers aren't supported.
    assert.equal(
      getCacheHeaderValue('/mcp-grant'),
      'no-cache, no-store, must-revalidate'
    );
    assert.equal(
      getCacheHeaderValue('/mcp-grant.html'),
      'no-cache, no-store, must-revalidate'
    );
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

  it('keeps the lazy Clerk SDK out of the PWA precache', () => {
    assert.match(viteConfigSource, /globIgnores:\s*\[[^\]]*'\*\*\/clerk-\*\.js'[^\]]*\]/s);
    assert.match(
      viteConfigSource,
      /if\s*\(\s*id\.includes\('\/@clerk\/clerk-js\/'\)\s*\)\s*\{[^{}]*\breturn 'clerk';\s*\}/
    );
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

const DASHBOARD_HTML_DESTINATION = '/dashboard.html';

// Root marketing landing page — a second HTML entry in the pro-test bundle
// (vite rollupOptions.input), served from public/pro/welcome.html on the full
// site and app variant roots. Variant dashboards live at /dashboard so the root
// welcome route is consistent across worldmonitor.app, finance.worldmonitor.app,
// tech.worldmonitor.app, commodity.worldmonitor.app, happy.worldmonitor.app, and
// energy.worldmonitor.app.
// The dashboard source template remains index.html, but the web build renames
// its output to dashboard.html so Vercel's filesystem cannot shadow the /
// rewrite. /welcome and /index.html redirect to root so crawlers and humans do
// not see duplicate landing URLs.
describe('welcome landing page routing', () => {
  const getRootRewrite = () => vercelConfig.rewrites.find((r) => r.source === '/');
  const getSpaCatchAllRewrite = () => vercelConfig.rewrites.find((r) =>
    r.destination === DASHBOARD_HTML_DESTINATION && r.source.startsWith('/((?!')
  );
  const rootDestinationForHost = (host) => {
    const rewrite = getRootRewrite();
    assert.ok(rewrite, 'expected a rewrite for /');
    const hostCondition = rewrite.has?.find((condition) => condition.type === 'host');
    if (!hostCondition || new RegExp(hostCondition.value).test(host)) return rewrite.destination;
    return getSpaCatchAllRewrite()?.destination ?? null;
  };

  it('declares / as the app-root welcome rewrite after moving dashboard HTML off root index', () => {
    const rewrite = vercelConfig.rewrites.find((r) => r.source === '/');
    assert.ok(rewrite, 'expected a rewrite for /');
    assert.equal(rewrite.destination, '/pro/welcome.html');
    assert.deepEqual(rewrite.has, [
      { type: 'host', value: APP_ROOT_HOST_PATTERN },
    ]);
  });

  it('routes app roots to welcome and leaves non-app roots on the dashboard catch-all', () => {
    assert.equal(rootDestinationForHost('worldmonitor.app'), '/pro/welcome.html');
    assert.equal(rootDestinationForHost('www.worldmonitor.app'), '/pro/welcome.html');
    assert.equal(rootDestinationForHost('worldmonitor.app.evil.example'), DASHBOARD_HTML_DESTINATION);

    const variantHosts = getVariantHosts().filter((host) => host !== 'www.worldmonitor.app');
    for (const host of variantHosts) {
      assert.equal(
        rootDestinationForHost(host),
        '/pro/welcome.html',
        `${host}/ must serve the welcome page; the variant dashboard route is /dashboard`
      );
    }
  });

  it('keeps variant canonicals aligned with the /dashboard routing strategy', () => {
    const variantUrls = getVariantUrls();
    assert.equal(variantUrls.full, 'https://www.worldmonitor.app/dashboard');

    const nonFullUrls = Object.entries(variantUrls).filter(([variant]) => variant !== 'full');
    assert.ok(nonFullUrls.length >= 5, 'expected non-full variant metadata entries');
    for (const [variant, url] of nonFullUrls) {
      assert.equal(
        new URL(url).pathname,
        '/dashboard',
        `${variant} canonical must point at /dashboard while the root serves welcome`
      );
    }
  });

  it('keeps variant crawler-stub canonicals aligned with variant metadata', () => {
    const variantUrls = getVariantUrls();
    const nonFullUrls = Object.entries(variantUrls).filter(([variant]) => variant !== 'full');

    for (const [variant, url] of nonFullUrls) {
      assert.match(
        middlewareSource,
        new RegExp(`\\b${variant}:\\s*\\{[\\s\\S]*?url:\\s*'${escapeRegExp(url)}'`),
        `${variant} crawler-stub OG/canonical URL must match variant-meta.ts`
      );
    }

    for (const variant of ['full', 'tech', 'finance', 'commodity', 'happy']) {
      assert.ok(
        middlewareSource.includes(`href="${variantUrls[variant]}"`),
        `AI crawler body must link ${variant} to its dashboard canonical`
      );
    }
  });

  it('redirects legacy root map-state deep links to /dashboard before welcome routing', () => {
    assert.match(
      middlewareSource,
      /LEGACY_DASHBOARD_ROOT_QUERY_KEYS = \['lat', 'lon', 'zoom', 'view', 'timeRange', 'layers'\]/,
      'middleware must list dashboard URL-state params that bypass the root welcome page',
    );
    assert.match(
      middlewareSource,
      /path === '\/' && hasLegacyDashboardRootState\(url\.searchParams\)/,
      'middleware must detect legacy dashboard state on root requests',
    );
    assert.match(
      middlewareSource,
      /dashboardUrl\.pathname = '\/dashboard'/,
      'middleware must move legacy dashboard-state root links to /dashboard',
    );
    assert.match(
      middlewareSource,
      /Response\.redirect\(dashboardUrl\.toString\(\), 308\)/,
      'middleware must redirect, preserving the original query string',
    );
  });

  it('rewrites /dashboard to the existing SPA shell', () => {
    const rewrite = vercelConfig.rewrites.find((r) => r.source === '/dashboard');
    assert.ok(rewrite, 'expected a rewrite for /dashboard');
    assert.equal(rewrite.destination, DASHBOARD_HTML_DESTINATION);
  });

  it('does not point any rewrite at root index.html', () => {
    const indexRewrites = vercelConfig.rewrites.filter((r) => r.destination === '/index.html');
    assert.deepEqual(
      indexRewrites,
      [],
      'dashboard rewrites must target dashboard.html so Vercel filesystem precedence cannot serve a root index.html at /'
    );
  });

  it('renames the web dashboard HTML output away from root index.html', () => {
    assert.match(viteConfigSource, /function dashboardHtmlOutputPlugin\(\)/);
    assert.match(viteConfigSource, /enforce:\s*'post'/);
    assert.match(viteConfigSource, /Object\.entries\(bundle\)\.find/);
    assert.match(viteConfigSource, /output\.fileName === 'index\.html'/);
    assert.match(viteConfigSource, /delete bundle\[bundleKey\]/);
    assert.match(viteConfigSource, /dashboardHtml\.fileName = 'dashboard\.html'/);
    assert.match(viteConfigSource, /!isDesktopBuild && dashboardHtmlOutputPlugin\(\)/);
  });

  it('does not keep stale welcome exclusions in the SPA catch-all rewrite', () => {
    const catchAll = vercelConfig.rewrites.find((r) =>
      r.destination === DASHBOARD_HTML_DESTINATION && r.source.startsWith('/((?!')
    );
    assert.ok(catchAll, 'expected the SPA catch-all rewrite');
    assert.ok(
      !catchAll.source.includes('|welcome|'),
      'legacy /welcome redirect must not leave welcome excluded from the SPA catch-all rewrite'
    );
  });

  it('redirects legacy /welcome to / permanently', () => {
    const redirect = vercelConfig.redirects.find((r) => r.source === '/welcome');
    assert.ok(redirect, 'expected a redirect for /welcome');
    assert.equal(redirect.destination, '/');
    assert.equal(redirect.permanent, true);
  });

  it('redirects direct /index.html requests to / permanently', () => {
    const redirect = vercelConfig.redirects.find((r) => r.source === '/index.html');
    assert.ok(redirect, 'expected a redirect for /index.html');
    assert.equal(redirect.destination, '/');
    assert.equal(redirect.permanent, true);
  });

  it('requires revalidation for /dashboard HTML without disabling bfcache', () => {
    const dashboardCache = getCacheHeaderValue('/dashboard');
    assert.equal(dashboardCache, 'private, no-cache, must-revalidate');
    assert.ok(!dashboardCache.includes('no-store'), 'HTML must not set no-store — it disables bfcache');
  });

  it('requires revalidation for root welcome HTML without disabling bfcache', () => {
    const welcomeCache = getCacheHeaderValue('/');
    assert.equal(welcomeCache, 'private, no-cache, must-revalidate');
    assert.ok(!welcomeCache.includes('no-store'), 'HTML must not set no-store — it disables bfcache');
  });

  it('requires revalidation for direct dashboard.html without disabling bfcache', () => {
    const dashboardCache = getCacheHeaderValue('/dashboard.html');
    assert.equal(dashboardCache, 'private, no-cache, must-revalidate');
    assert.ok(!dashboardCache.includes('no-store'), 'HTML must not set no-store — it disables bfcache');
  });

  it('starts installed PWAs on /dashboard, not the public welcome page', () => {
    assert.match(viteConfigSource, /start_url:\s*'\/dashboard'/);
  });

  it('sitemap lists dashboard routes and does not list legacy /welcome', () => {
    const sitemap = readFileSync(resolve(__dirname, '../public/sitemap.xml'), 'utf-8');
    assert.ok(
      sitemap.includes('<loc>https://www.worldmonitor.app/dashboard</loc>'),
      'public/sitemap.xml must list https://www.worldmonitor.app/dashboard'
    );
    for (const host of ['tech', 'finance', 'commodity', 'happy', 'energy']) {
      assert.ok(
        sitemap.includes(`<loc>https://${host}.worldmonitor.app/dashboard</loc>`),
        `public/sitemap.xml must list https://${host}.worldmonitor.app/dashboard`
      );
    }
    assert.ok(
      !sitemap.includes('<loc>https://www.worldmonitor.app/welcome</loc>'),
      'public/sitemap.xml must not list legacy https://www.worldmonitor.app/welcome'
    );
  });

  it('pins welcome and dashboard SEO canonicals to their new routes', () => {
    const welcomeHtml = readFileSync(resolve(__dirname, '../pro-test/welcome.html'), 'utf-8');
    const generatedWelcomeHtml = readFileSync(resolve(__dirname, '../public/pro/welcome.html'), 'utf-8');
    const dashboardHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');
    assert.ok(
      welcomeHtml.includes('<link rel="canonical" href="https://www.worldmonitor.app/" />'),
      'welcome source must canonicalize to root'
    );
    assert.ok(
      !welcomeHtml.includes('https://www.worldmonitor.app/welcome'),
      'welcome source must not emit legacy /welcome SEO URLs'
    );
    assert.ok(
      generatedWelcomeHtml.includes('<link rel="canonical" href="https://www.worldmonitor.app/" />'),
      'generated welcome HTML must canonicalize to root'
    );
    assert.ok(
      !generatedWelcomeHtml.includes('https://www.worldmonitor.app/welcome'),
      'generated welcome HTML must not emit legacy /welcome SEO URLs'
    );
    assert.ok(
      generatedWelcomeHtml.includes('https://www.worldmonitor.app/dashboard'),
      'generated welcome HTML must launch the dashboard at /dashboard'
    );
    assert.ok(
      dashboardHtml.includes('<link rel="canonical" href="https://www.worldmonitor.app/dashboard" />'),
      'dashboard shell must canonicalize to /dashboard'
    );
  });

  it('keeps welcome dashboard launch CTAs off the root welcome route', () => {
    const welcomeMomentsSource = readFileSync(resolve(__dirname, '../pro-test/src/welcome/Moments.tsx'), 'utf-8');
    const generatedWelcomeHtml = readFileSync(resolve(__dirname, '../public/pro/welcome.html'), 'utf-8');
    const welcomeAssetPath = generatedWelcomeHtml.match(/src="\/pro\/(assets\/welcome-[^"]+\.js)"/)?.[1];
    assert.ok(welcomeAssetPath, 'generated welcome HTML must reference a hashed welcome JS entry');

    const generatedWelcomeAsset = readFileSync(resolve(__dirname, '../public/pro', welcomeAssetPath), 'utf-8');
    const rootWelcomeLaunchLink = /href\s*[:=]\s*["'`]\/\?ref=welcome-/;
    const variantRootWelcomeLaunchLink = /https:\/\/(?:tech|finance|commodity|happy|energy)\.worldmonitor\.app\/\?ref=welcome-/;
    assert.doesNotMatch(
      welcomeMomentsSource,
      rootWelcomeLaunchLink,
      'welcome source must not route launch CTAs back to the root welcome page'
    );
    assert.doesNotMatch(
      welcomeMomentsSource,
      variantRootWelcomeLaunchLink,
      'welcome source must not route variant launch CTAs back to variant root welcome pages'
    );
    assert.doesNotMatch(
      generatedWelcomeAsset,
      rootWelcomeLaunchLink,
      'generated welcome JS must not route launch CTAs back to the root welcome page'
    );
    assert.doesNotMatch(
      generatedWelcomeAsset,
      variantRootWelcomeLaunchLink,
      'generated welcome JS must not route variant launch CTAs back to variant root welcome pages'
    );
  });

  it('redirects signed-in welcome visitors to /dashboard client-side without loading the Clerk SDK', () => {
    const welcomeApp = readFileSync(resolve(__dirname, '../pro-test/src/WelcomeApp.tsx'), 'utf-8');
    // The 3MB Clerk SDK must NOT be on the welcome critical path (issue #4428):
    // the redirect is decided from the live __session JWT alone.
    assert.ok(!welcomeApp.includes("import('./services/clerk')"));
    assert.ok(!welcomeApp.includes("import('./services/checkout')"));
    assert.ok(welcomeApp.includes('maybeRedirectWelcomeVisitor(document.cookie, window.location)'));
  });
});

describe('deploy/API CORS guardrails', () => {
  it('does not define static CORS headers for /api routes in vercel.json', () => {
    const corsHeaderKeys = new Set([
      'access-control-allow-origin',
      'access-control-allow-methods',
      'access-control-allow-headers',
      'access-control-allow-credentials',
    ]);
    const apiCorsRules = vercelConfig.headers
      .filter((entry) => entry.source.startsWith('/api'))
      .filter((entry) => entry.headers?.some((header) => corsHeaderKeys.has(header.key.toLowerCase())))
      .map((entry) => entry.source);

    assert.deepEqual(
      apiCorsRules,
      [],
      'API CORS must be emitted by handlers so credentialed requests get origin-specific ACAO plus ACAC=true.'
    );
  });
});

describe('docker runtime dependency guardrails', () => {
  const runtimePackage = JSON.parse(readFileSync(resolve(__dirname, '../docker/runtime-package.json'), 'utf-8'));
  const runtimeLock = JSON.parse(readFileSync(resolve(__dirname, '../docker/runtime-package-lock.json'), 'utf-8'));

  it('installs runtime node_modules from a minimal dependency stage', () => {
    assert.match(dockerfileSource, /FROM node:22-alpine AS runtime-deps/);
    assert.match(dockerfileSource, /npm ci --omit=dev --omit=optional --ignore-scripts/);
    assert.match(dockerfileSource, /COPY --from=runtime-deps \/app\/node_modules \.\/node_modules/);
    assert.doesNotMatch(dockerfileSource, /npm prune --omit=dev/);
    assert.doesNotMatch(dockerfileSource, /COPY --from=builder \/app\/node_modules \.\/node_modules/);
  });

  it('keeps raw JS handler packages without copying the full app dependency graph', () => {
    assert.deepEqual(Object.keys(runtimePackage.dependencies).sort(), [
      '@upstash/ratelimit',
      '@upstash/redis',
      'convex',
    ]);
    assert.deepEqual(
      Object.keys(runtimeLock.packages[''].dependencies).sort(),
      Object.keys(runtimePackage.dependencies).sort()
    );

    const lockPackageNames = Object.keys(runtimeLock.packages);
    for (const omitted of ['node_modules/@xenova/transformers', 'node_modules/onnxruntime-web', 'node_modules/playwright']) {
      assert.ok(!lockPackageNames.includes(omitted), `${omitted} should not be in Docker runtime deps`);
    }
  });
});

const getSecurityHeaders = () => {
  const rule = vercelConfig.headers.find((entry) => entry.source === GLOBAL_SECURITY_HEADER_SOURCE);
  return rule?.headers ?? [];
};

const getHeaderValue = (key) => {
  const headers = getSecurityHeaders();
  const header = headers.find((h) => h.key.toLowerCase() === key.toLowerCase());
  return header?.value ?? null;
};

const getNginxHeaderValueFrom = (file, key) => {
  const nginxConf = readFileSync(resolve(__dirname, `../${file}`), 'utf-8');
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = nginxConf
    .split('\n')
    .find((candidate) => new RegExp(`^add_header\\s+${escapedKey}\\s+"`, 'i').test(candidate));
  const match = line?.match(/^add_header\s+\S+\s+"(.*)"\s+always;$/i);
  return match?.[1].replace(/\\"/g, '"') ?? null;
};

const getNginxHeaderValue = (key) => getNginxHeaderValueFrom('docker/nginx-security-headers.conf', key);

describe('security header guardrails', () => {
  it('includes required security headers on catch-all route', () => {
    const required = [
      'X-Content-Type-Options',
      'Strict-Transport-Security',
      'Referrer-Policy',
      'Reporting-Endpoints',
      'Cross-Origin-Opener-Policy-Report-Only',
      'Cross-Origin-Embedder-Policy-Report-Only',
      'Permissions-Policy',
      'Content-Security-Policy',
    ];
    const headerKeys = getSecurityHeaders().map((h) => h.key);
    for (const name of required) {
      assert.ok(headerKeys.includes(name), `Missing security header: ${name}`);
    }
  });

  it('keeps COOP/COEP in report-only mode during rollout', () => {
    // Relative URL so the apex + every variant subdomain (tech/finance/
    // commodity/happy, all on the same Vercel deployment) reports
    // same-origin. An absolute apex URL would force cross-origin POSTs
    // on subdomain hosts with stripped credentials and inconsistent
    // browser sampling.
    assert.equal(
      getHeaderValue('Reporting-Endpoints'),
      'wm-coop-coep="/api/security/report"',
    );
    assert.equal(
      getHeaderValue('Cross-Origin-Opener-Policy-Report-Only'),
      'same-origin; report-to="wm-coop-coep"',
    );
    assert.equal(
      getHeaderValue('Cross-Origin-Embedder-Policy-Report-Only'),
      'require-corp; report-to="wm-coop-coep"',
    );
    assert.equal(getHeaderValue('Cross-Origin-Opener-Policy'), null);
    assert.equal(getHeaderValue('Cross-Origin-Embedder-Policy'), null);
  });

  it('keeps self-hosted nginx security headers aligned for COOP/COEP reporting', () => {
    const nginxHeaders = readFileSync(
      resolve(__dirname, '../docker/nginx-security-headers.conf'),
      'utf-8',
    );
    assert.match(
      nginxHeaders,
      /add_header Reporting-Endpoints "wm-coop-coep=\\"\/api\/security\/report\\"" always;/,
    );
    assert.match(
      nginxHeaders,
      /add_header Cross-Origin-Opener-Policy-Report-Only "same-origin; report-to=\\"wm-coop-coep\\"" always;/,
    );
    assert.match(
      nginxHeaders,
      /add_header Cross-Origin-Embedder-Policy-Report-Only "require-corp; report-to=\\"wm-coop-coep\\"" always;/,
    );
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

  it('Permissions-Policy explicitly opts embedded documents into unload handlers', () => {
    const policy = getHeaderValue('Permissions-Policy');
    assert.ok(
      policy.includes('unload=(*)'),
      'Permissions-Policy should explicitly allow embedded unload handlers to avoid third-party iframe console violations'
    );
  });

  it('Permissions-Policy is in sync between vercel.json header and docker/nginx-security-headers.conf', () => {
    assert.equal(
      getNginxHeaderValue('Permissions-Policy'),
      getHeaderValue('Permissions-Policy'),
      'Self-hosted docker users must have the same Permissions-Policy as Vercel.'
    );
  });

  it('CSP connect-src does not allow unencrypted WebSocket (ws:)', () => {
    const csp = getHeaderValue('Content-Security-Policy');
    const connectSrc = csp.match(/connect-src\s+([^;]+)/)?.[1] ?? '';
    assert.ok(!connectSrc.includes(' ws:'), 'CSP connect-src must not contain ws: (unencrypted WebSocket)');
    assert.ok(connectSrc.includes('wss:'), 'CSP connect-src should keep wss: for secure WebSocket');
  });

  it('dashboard CSP is header-only and keeps https: for runtime fetch/media', () => {
    const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');
    const headerCsp = getHeaderValue('Content-Security-Policy');
    assert.equal(hasCspMeta(indexHtml), false, 'index.html must not ship a CSP meta tag');

    const headerConnectSrc = headerCsp.match(/connect-src\s+([^;]+)/)?.[1] ?? '';
    const headerMediaSrc = headerCsp.match(/media-src\s+([^;]+)/)?.[1] ?? '';

    assert.ok(headerConnectSrc.split(/\s+/).includes('https:'), 'header connect-src must keep https: for runtime APIs and CSP filtering');
    assert.ok(headerMediaSrc.split(/\s+/).includes('https:'), 'header media-src must keep https: for live media and CSP filtering');
  });

  it('CSP connect-src does not contain localhost in production', () => {
    const csp = getHeaderValue('Content-Security-Policy');
    const connectSrc = csp.match(/connect-src\s+([^;]+)/)?.[1] ?? '';
    assert.ok(!connectSrc.includes('http://localhost'), 'CSP connect-src must not contain http://localhost in production');
  });

  it('dashboard CSP font and style sources are first-party across deploy surfaces', () => {
    const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');
    const headerCsp = getHeaderValue('Content-Security-Policy');
    assert.equal(hasCspMeta(indexHtml), false, 'index.html must not ship a CSP meta tag');
    const nginxCsp = getNginxHeaderValue('Content-Security-Policy');
    assert.ok(nginxCsp, 'nginx-security-headers.conf must have a Content-Security-Policy header');

    const surfaces = [
      ['vercel', headerCsp],
      ['docker/nginx', nginxCsp],
    ];

    for (const directive of ['style-src', 'font-src']) {
      const baseline = getCspDirectiveTokens(headerCsp, directive);
      for (const [label, csp] of surfaces) {
        const tokens = getCspDirectiveTokens(csp, directive);
        assert.deepEqual(
          tokens,
          baseline,
          `${directive} tokens in ${label} must match vercel.json: ${tokens.join(', ')}`
        );
        assert.ok(!tokens.includes('https:'), `${label} ${directive} must not allow all HTTPS origins`);
        assert.ok(
          !tokens.some((token) => token.includes('fonts.googleapis.com') || token.includes('fonts.gstatic.com')),
          `${label} ${directive} must not allow Google Fonts after the dashboard self-hosts fonts`
        );
      }
    }
  });

  it('CSP script-src includes wasm-unsafe-eval for WebAssembly support', () => {
    const csp = getHeaderValue('Content-Security-Policy');
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    assert.ok(scriptSrc.includes("'wasm-unsafe-eval'"), 'CSP script-src must include wasm-unsafe-eval for WASM support');
    assert.ok(scriptSrc.includes("'self'"), 'CSP script-src must include self');
  });

  it('CSP script-src hashes exactly match inline scripts served under the global CSP', () => {
    const csp = getHeaderValue('Content-Security-Policy');
    const scriptHashTokens = getCspDirectiveTokens(csp, 'script-src')
      .filter((token) => token.startsWith("'sha256-"));
    const inlineHashTokens = [...new Set(GLOBAL_CSP_INLINE_SCRIPT_HTML_FILES.flatMap((file) => {
      const html = readFileSync(resolve(__dirname, '..', file), 'utf-8');
      return getInlineScriptHashTokens(html);
    }))].sort();

    assert.ok(inlineHashTokens.length > 0, 'expected inline scripts under the global CSP');
    assert.deepEqual(
      scriptHashTokens,
      inlineHashTokens,
      'CSP script-src hashes must be the exact set required by deployed HTML files: ' +
        GLOBAL_CSP_INLINE_SCRIPT_HTML_FILES.join(', ')
    );
  });

  it('Pro landing CSS stays first-party under the global CSP', () => {
    assert.doesNotMatch(
      proIndexCssSource,
      /@import\s+url\(['"]?https:|fonts\.googleapis\.com|fonts\.gstatic\.com/,
      'Pro CSS must not import remote fonts blocked by the global CSP'
    );
  });

  it('CSP script-src uses strict-dynamic with nonce/hash trust, not script host allowlists', () => {
    const csp = getHeaderValue('Content-Security-Policy');
    const tokens = getCspDirectiveTokens(csp, 'script-src');
    assert.ok(
      tokens.includes("'strict-dynamic'"),
      'CSP script-src must include strict-dynamic so trusted bootstrap scripts can load secondary scripts'
    );
    assert.ok(
      tokens.includes(`'nonce-${STATIC_SCRIPT_NONCE}'`),
      'CSP script-src must include the static entry-script nonce used by parser-inserted HTML entries'
    );
    assert.ok(
      tokens.some((token) => token.startsWith("'sha256-")),
      'CSP script-src must include hashes for inline bootstrap scripts'
    );
    assert.deepEqual(
      tokens.filter((token) => /^https?:/.test(token) || token.includes('*.')),
      [],
      'CSP script-src must not rely on script host allowlists'
    );
  });

  it('disables Zod parser JIT because production script-src forbids unsafe-eval', () => {
    const csp = getHeaderValue('Content-Security-Policy');
    const tokens = getCspDirectiveTokens(csp, 'script-src');
    assert.ok(!tokens.includes("'unsafe-eval'"), 'production script-src must not allow unsafe-eval');
    assert.match(
      mainSource,
      /import '\.\/bootstrap\/zod-csp';/,
      'main.ts must apply the Zod CSP bootstrap before the app graph'
    );
    assert.match(
      zodCspSource,
      /configureZod\(\{\s*jitless:\s*true\s*\}\)/,
      'Zod must stay on the non-JIT parser path under the hardened CSP'
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

  it('docker/nginx CSP frame-src includes Clerk origin for auth modals', () => {
    // Parity with the Vercel/index.html frame-src above. The sign-in modal itself
    // renders in-DOM (no clerk-origin iframe today), so this is defense-in-depth
    // for self-hosted deploys should Clerk reintroduce a handshake iframe — and it
    // keeps the docker surface from silently drifting from the hosted one.
    const nginxCsp = getNginxHeaderValue('Content-Security-Policy');
    assert.ok(nginxCsp, 'nginx-security-headers.conf must have a Content-Security-Policy header');
    const frameSrc = nginxCsp.match(/frame-src\s+([^;]+)/)?.[1] ?? '';
    assert.ok(
      frameSrc.includes('clerk.accounts.dev') || frameSrc.includes('clerk.worldmonitor.app'),
      'docker/nginx CSP frame-src must include Clerk origin for the self-hosted sign-in modal'
    );
  });

  it('CSP frame directives include every variant hostname', () => {
    const variantHosts = getVariantHosts();
    const headerCsp = getHeaderValue('Content-Security-Policy');
    const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');
    assert.equal(hasCspMeta(indexHtml), false, 'index.html must not ship a CSP meta tag');
    const nginxCsp = getNginxHeaderValue('Content-Security-Policy');
    assert.ok(nginxCsp, 'nginx-security-headers.conf must have a Content-Security-Policy header');

    const surfaces = [
      ['vercel frame-src', getCspDirectiveTokens(headerCsp, 'frame-src')],
      ['vercel frame-ancestors', getCspDirectiveTokens(headerCsp, 'frame-ancestors')],
      ['nginx frame-src', getCspDirectiveTokens(nginxCsp, 'frame-src')],
      ['nginx frame-ancestors', getCspDirectiveTokens(nginxCsp, 'frame-ancestors')],
    ];

    for (const [label, tokens] of surfaces) {
      const missing = variantHosts.filter((host) => !tokens.includes(`https://${host}`));
      assert.deepEqual(
        missing,
        [],
        `${label} is missing variant host(s): ${missing.join(', ')}`
      );
    }
  });

  it('HTML entry script tags carry the nonce trusted by the header CSP', () => {
    const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');
    const headerCsp = getHeaderValue('Content-Security-Policy');
    assert.equal(hasCspMeta(indexHtml), false, 'index.html must not ship a CSP meta tag');
    assert.ok(
      getCspDirectiveTokens(headerCsp, 'script-src').includes(`'nonce-${STATIC_SCRIPT_NONCE}'`),
      'header script-src must trust the static entry-script nonce'
    );
    assert.match(
      viteConfigSource,
      new RegExp(`cspNonce:\\s*STATIC_SCRIPT_NONCE`),
      'Vite must stamp emitted HTML entry scripts with the nonce trusted by the header CSP'
    );
    assert.match(
      proViteConfigSource,
      new RegExp(`cspNonce:\\s*STATIC_SCRIPT_NONCE`),
      'Pro Vite builds must stamp emitted HTML entry scripts with the nonce trusted by the header CSP'
    );

    for (const file of GLOBAL_CSP_EXTERNAL_SCRIPT_HTML_FILES) {
      const html = readFileSync(resolve(__dirname, '..', file), 'utf-8');
      assert.equal(hasCspMeta(html), false, `${file} must not ship a CSP meta tag`);
      const scriptTags = getExternalScriptTags(html);
      assert.ok(scriptTags.length > 0, `${file} must have at least one external entry script`);
      const missingNonce = scriptTags.filter((tag) => !new RegExp(`\\bnonce=["']${STATIC_SCRIPT_NONCE}["']`).test(tag));
      assert.deepEqual(
        missingNonce,
        [],
        `${file} has parser-inserted external scripts without the CSP nonce`
      );
    }
  });

  it('CSP script-src is in sync between vercel.json header and docker/nginx-security-headers.conf', () => {
    const headerCsp = getHeaderValue('Content-Security-Policy');
    const nginxCsp = getNginxHeaderValue('Content-Security-Policy');
    assert.ok(nginxCsp, 'nginx-security-headers.conf must have a Content-Security-Policy header');

    const headerTokens = getCspDirectiveTokens(headerCsp, 'script-src');
    const nginxTokens = getCspDirectiveTokens(nginxCsp, 'script-src');

    const onlyHeader = headerTokens.filter((token) => !nginxTokens.includes(token));
    const onlyNginx = nginxTokens.filter((token) => !headerTokens.includes(token));

    assert.deepEqual(onlyHeader, [],
      `script-src tokens in vercel.json but missing from nginx-security-headers.conf: ${onlyHeader.join(', ')}. ` +
      'Self-hosted docker users must have the same CSP parity.');
    assert.deepEqual(onlyNginx, [],
      `script-src tokens in nginx-security-headers.conf but missing from vercel.json: ${onlyNginx.join(', ')}. ` +
      'Self-hosted docker users must have the same CSP parity.');

    const nginxScriptSrc = nginxCsp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    assert.ok(!nginxScriptSrc.includes("'unsafe-inline'"), "nginx script-src must not contain 'unsafe-inline' to maintain CSP parity with Vercel.");
  });

  it('CSP payment frame and form directives stay in sync between Vercel and docker/nginx', () => {
    const headerCsp = getHeaderValue('Content-Security-Policy');
    const nginxCsp = getNginxHeaderValue('Content-Security-Policy');
    assert.ok(nginxCsp, 'nginx-security-headers.conf must have a Content-Security-Policy header');

    for (const directive of ['frame-src', 'form-action']) {
      const headerTokens = getCspDirectiveTokens(headerCsp, directive);
      const nginxTokens = getCspDirectiveTokens(nginxCsp, directive);
      const onlyHeader = headerTokens.filter((token) => !nginxTokens.includes(token));
      const onlyNginx = nginxTokens.filter((token) => !headerTokens.includes(token));

      assert.deepEqual(onlyHeader, [],
        `${directive} tokens in vercel.json but missing from nginx-security-headers.conf: ${onlyHeader.join(', ')}. ` +
        'Payment/auth iframe and form targets must stay deploy-surface identical.');
      assert.deepEqual(onlyNginx, [],
        `${directive} tokens in nginx-security-headers.conf but missing from vercel.json: ${onlyNginx.join(', ')}. ` +
        'Payment/auth iframe and form targets must stay deploy-surface identical.');
    }
  });

  it('security.txt exists in public/.well-known/', () => {
    const secTxt = readFileSync(resolve(__dirname, '../public/.well-known/security.txt'), 'utf-8');
    assert.match(secTxt, /^Contact:/m, 'security.txt must have a Contact field');
    assert.match(secTxt, /^Expires:/m, 'security.txt must have an Expires field');
  });
});

describe('embeddable map route guardrails', () => {
  it('registers embed.html as a Vite HTML entry', () => {
    assert.match(viteConfigSource, /embed:\s*resolve\(__dirname,\s*'embed\.html'\)/);
  });

  it('rewrites /embed to the dedicated embed.html entry before the SPA catch-all', () => {
    const rewriteIndex = vercelConfig.rewrites.findIndex((r) => r.source === '/embed');
    const catchAllIndex = vercelConfig.rewrites.findIndex((r) =>
      r.destination === DASHBOARD_HTML_DESTINATION && r.source.startsWith('/((?!')
    );
    assert.ok(rewriteIndex !== -1, 'expected /embed rewrite');
    assert.ok(catchAllIndex !== -1, 'expected SPA catch-all rewrite');
    assert.ok(rewriteIndex < catchAllIndex, '/embed rewrite must appear before the SPA catch-all');
    assert.equal(vercelConfig.rewrites[rewriteIndex].destination, '/embed.html');
  });

  it('excludes /embed and /embed.html from the SPA catch-all rewrite and cache header', () => {
    const catchAll = vercelConfig.rewrites.find((r) =>
      r.destination === DASHBOARD_HTML_DESTINATION && r.source.startsWith('/((?!')
    );
    assert.ok(catchAll.source.includes('|embed|embed\\.html|'), 'SPA catch-all must exclude the public embed entry');
    assert.ok(SPA_HTML_CACHE_SOURCE.includes('|embed|embed\\.html|'), 'HTML cache catch-all must exclude the public embed entry');
    assert.equal(getCacheHeaderValue(SPA_HTML_CACHE_SOURCE), 'private, no-cache, must-revalidate');
  });

  it('keeps the global security header anti-framing rule off the embed entry', () => {
    assert.equal(GLOBAL_SECURITY_HEADER_SOURCE, '/((?!docs|embed|embed\\.html).*)');
    const globalXfo = getHeaderValueForSource(GLOBAL_SECURITY_HEADER_SOURCE, 'X-Frame-Options');
    assert.equal(globalXfo, 'SAMEORIGIN');
  });

  for (const source of ['/embed', '/embed.html']) {
    it(`${source} allows cross-origin iframe embedding without inheriting app XFO`, () => {
      const headers = getHeadersForSource(source);
      assert.ok(headers.length > 0, `${source} must have an explicit header rule`);
      assert.equal(getHeaderValueForSource(source, 'X-Frame-Options'), null);
      assert.equal(getHeaderValueForSource(source, 'Cache-Control'), 'private, no-cache, must-revalidate');
      const csp = getHeaderValueForSource(source, 'Content-Security-Policy');
      assert.ok(csp, `${source} must have a CSP`);
      assert.match(csp, /frame-ancestors \*/);
      assert.match(csp, /script-src 'self'(?:;|$)/);
      assert.doesNotMatch(csp, /clerk|dodopayments|stripe/);
      assert.ok(!getCspDirectiveTokens(csp, 'script-src').includes("'unsafe-inline'"));
    });
  }

  it('keeps Docker embed routes on the locked-down embed security headers', () => {
    const nginxTemplate = readFileSync(resolve(__dirname, '../docker/nginx.conf.template'), 'utf-8');
    assert.match(nginxTemplate, /location = \/embed \{[\s\S]*?include \/etc\/nginx\/embed_security_headers\.conf;/);
    assert.match(nginxTemplate, /location = \/embed\.html \{[\s\S]*?include \/etc\/nginx\/embed_security_headers\.conf;/);
    assert.match(frontendDockerfileSource, /COPY docker\/nginx-embed-security-headers\.conf \/etc\/nginx\/embed_security_headers\.conf/);
    assert.match(dockerNginxSource, /location = \/embed \{[\s\S]*?add_header Permissions-Policy "camera=\(\), microphone=\(\), geolocation=\(\), accelerometer=\(\)/);
    assert.match(dockerNginxSource, /location = \/embed\.html \{[\s\S]*?add_header Permissions-Policy "camera=\(\), microphone=\(\), geolocation=\(\), accelerometer=\(\)/);

    const lockedPolicy = getHeaderValueForSource('/embed', 'Permissions-Policy');
    const dockerLockedPolicy = getNginxHeaderValueFrom('docker/nginx-embed-security-headers.conf', 'Permissions-Policy');
    assert.equal(dockerLockedPolicy, lockedPolicy, 'Docker embed Permissions-Policy must match Vercel embed policy');
    for (const directive of [
      'accelerometer=()',
      'bluetooth=()',
      'gyroscope=()',
      'magnetometer=()',
      'picture-in-picture=()',
      'payment=()',
    ]) {
      assert.ok(dockerLockedPolicy.includes(directive), `Docker embed policy must keep ${directive}`);
    }

    const dockerEmbedCsp = getNginxHeaderValueFrom('docker/nginx-embed-security-headers.conf', 'Content-Security-Policy');
    assert.equal(dockerEmbedCsp, getHeaderValueForSource('/embed', 'Content-Security-Policy'));
  });
});

describe('self-hosted docker nginx SPA entry', () => {
  it('both nginx confs serve dashboard.html as the SPA entry', () => {
    // dashboardHtmlOutputPlugin (vite.config.ts, !isDesktopBuild) renames the
    // built SPA entry index.html -> dashboard.html for every web build, so dist/
    // ships no index.html. BOTH self-hosted images must point the `index`
    // directive and the SPA fallback at dashboard.html, or `/` 403s:
    //   root Dockerfile   -> docker/nginx.conf          (docker-compose stack)
    //   docker/Dockerfile -> docker/nginx.conf.template (published ghcr image)
    for (const conf of ['docker/nginx.conf', 'docker/nginx.conf.template']) {
      const src = readFileSync(resolve(__dirname, `../${conf}`), 'utf-8');
      assert.match(src, /^\s*index dashboard\.html;/m, `${conf}: index directive must be dashboard.html`);
      assert.match(src, /try_files \$uri \$uri\/ \/dashboard\.html;/, `${conf}: SPA fallback must serve /dashboard.html`);
      assert.doesNotMatch(src, /try_files \$uri \$uri\/ \/index\.html;/, `${conf}: must not keep the broken /index.html SPA fallback`);
    }
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
    // After the structural split (refactor PR), the host-derivation
    // (`requestHost = req.headers.get('host') ?? ...`) lives in
    // api/mcp/handler.ts and the template-literal that emits
    // `resource_metadata="${url}"` lives in api/mcp/auth.ts (the
    // `wwwAuthHeader` helper). Concatenate both so the three sub-greps
    // below still see the same byte surface they did pre-split.
    const source = readFileSync(resolve(__dirname, '../api/mcp/handler.ts'), 'utf-8')
      + '\n'
      + readFileSync(resolve(__dirname, '../api/mcp/auth.ts'), 'utf-8');
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

// Agent readiness: RFC 8288 Link response headers on the homepage and
// dashboard entry.
// Scanners like isitagentready.com fetch GET / and expect a Link
// header advertising every well-known resource. Each rel is either
// an IANA-registered token (api-catalog, service-desc, service-doc,
// status) or the full IANA URI form (RFC 9728 OAuth rels). The MCP
// card rel carries anchor="/mcp" because the server card describes
// the /mcp endpoint, not the document URL being fetched.
describe('agent readiness: homepage Link headers', () => {
  const vercel = JSON.parse(readFileSync(resolve(__dirname, '../vercel.json'), 'utf-8'));

  for (const source of ['/', '/dashboard', '/dashboard.html']) {
    it(`${source} emits a Link header`, () => {
      const entry = vercel.headers.find((h) => h.source === source);
      assert.ok(entry, `expected a headers entry for ${source}`);
      const linkHeader = entry.headers.find((h) => h.key === 'Link');
      assert.ok(linkHeader, `expected a Link header on ${source}`);

      // Must advertise each required rel at least once
      const requiredRels = [
        'rel="api-catalog"',
        'rel="service-desc"',
        'rel="service-doc"',
        'rel="status"',
        'rel="http://www.iana.org/assignments/relation/oauth-protected-resource"',
        'rel="http://www.iana.org/assignments/relation/oauth-authorization-server"',
        'rel="mcp-server-card"',
        'rel="agent-skills-index"',
      ];
      for (const rel of requiredRels) {
        assert.ok(
          linkHeader.value.includes(rel),
          `Link header missing ${rel}`
        );
      }

      // MCP card rel must carry anchor="/mcp" (server card describes /mcp, not homepage)
      assert.match(
        linkHeader.value,
        /<\/\.well-known\/mcp\/server-card\.json>[^,]*anchor="\/mcp"/,
        'mcp-server-card rel must carry anchor="/mcp"'
      );

      // Target URIs must be root-relative (start with /, not http://)
      const targetMatches = [...linkHeader.value.matchAll(/<([^>]+)>/g)];
      assert.strictEqual(
        targetMatches.length,
        requiredRels.length,
        `expected exactly ${requiredRels.length} link targets, got ${targetMatches.length}`
      );
      for (const [, target] of targetMatches) {
        assert.ok(
          target.startsWith('/'),
          `link target must be root-relative, got ${target}`
        );
      }
    });
  }

  // /dashboard and /dashboard.html serve the same document; their Link headers
  // must stay in lockstep. Hardcoded duplication in vercel.json otherwise
  // silently drifts — this guard catches the drift at CI time.
  it('/dashboard and /dashboard.html Link headers are identical', () => {
    const dashboard = vercel.headers.find((h) => h.source === '/dashboard').headers.find((h) => h.key === 'Link');
    const dashboardHtml = vercel.headers.find((h) => h.source === '/dashboard.html').headers.find((h) => h.key === 'Link');
    assert.strictEqual(dashboard.value, dashboardHtml.value);
  });
});
