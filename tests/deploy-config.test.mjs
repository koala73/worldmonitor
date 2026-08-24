import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync as originalReadFileSync, existsSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
function readFileSync(path, options) {
  const content = originalReadFileSync(path, options);
  if (typeof content === 'string') {
    return content.replace(/\r\n/g, '\n');
  }
  return content;
}
import { fileURLToPath } from 'node:url';
import { guardProBuiltOutput, shouldSkipProBuiltOutput, withoutUnbuiltProPaths } from './_lib/pro-built-output.mjs';
import {
  CONTENT_CORPUS_PREFIXES,
  discoverContentCorpusPages,
} from '../scripts/discover-content-corpus-pages.mjs';
import { guardBuiltOutput, shouldSkipBuiltOutput } from './_lib/built-output-guard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));
const vercelConfig = JSON.parse(readFileSync(resolve(__dirname, '../vercel.json'), 'utf-8'));
const viteConfigSource = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf-8');
const proViteConfigSource = readFileSync(resolve(__dirname, '../pro-test/vite.config.ts'), 'utf-8');
const playwrightConfigSource = readFileSync(resolve(__dirname, '../playwright.config.ts'), 'utf-8');
const embedE2eSource = readFileSync(resolve(__dirname, '../e2e/embed.spec.ts'), 'utf-8');
const webMcpE2eSource = readFileSync(resolve(__dirname, '../e2e/webmcp.spec.ts'), 'utf-8');
const testWorkflowSource = readFileSync(resolve(__dirname, '../.github/workflows/test.yml'), 'utf-8');
const sitemapSource = readFileSync(resolve(__dirname, '../public/sitemap.xml'), 'utf-8');
const robotsSource = readFileSync(resolve(__dirname, '../public/robots.www.txt'), 'utf-8');
const mainSource = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');
const zodCspSource = readFileSync(resolve(__dirname, '../src/bootstrap/zod-csp.ts'), 'utf-8');
const proIndexCssSource = readFileSync(resolve(__dirname, '../pro-test/src/index.css'), 'utf-8');
const middlewareSource = readFileSync(resolve(__dirname, '../middleware.ts'), 'utf-8');
const dockerfileSource = readFileSync(resolve(__dirname, '../Dockerfile'), 'utf-8');
const dockerNginxSource = readFileSync(resolve(__dirname, '../docker/nginx.conf'), 'utf-8');
const frontendDockerfileSource = readFileSync(resolve(__dirname, '../docker/Dockerfile'), 'utf-8');
const dockerignoreSource = readFileSync(resolve(__dirname, '../.dockerignore'), 'utf-8');
const vercelIgnoreSource = readFileSync(resolve(__dirname, '../scripts/vercel-ignore.sh'), 'utf-8');
const variantDashboardSource = readFileSync(resolve(__dirname, '../src/config/variant-dashboard-html.ts'), 'utf-8');
const SPA_HTML_CACHE_SOURCE = '/((?!api|mcp|a2a|ask|oauth|assets|blog|docs|countries|chokepoints|crises|tools|research|reference|changelog|sources|use-cases|src|tmp|server|embed|embed\\.html|favico|map-styles|data|textures|pro|sw\\.js|workbox-[a-f0-9]+\\.js|manifest\\.webmanifest|offline\\.html|robots\\.txt|robots\\.www\\.txt|robots\\.variant\\.txt|robots\\.api\\.txt|sitemap\\.xml|schemamap\\.xml|sandbox|llms\\.txt|llms-full\\.txt|llms\\*\\.txt|openapi\\.yaml|openapi\\.json|auth\\.md|pricing\\.md|support\\.md|ai-search\\.md|agents\\.md|developers\\.md|developers/llms\\.txt|mcp-server\\.md|openapi\\.md|sdks\\.md|agent\\.txt|\\.well-known|wm-widget-sandbox\\.html|mcp-grant\\.html|mcp-grant|.*\\.md$).*)';
const GLOBAL_SECURITY_HEADER_SOURCE = '/((?!docs|embed|embed\\.html|wm-widget-sandbox\\.html).*)';
const APP_ROOT_HOST_PATTERN = '^(?:(?:www|tech|finance|commodity|happy|energy)\\.)?worldmonitor\\.app$';
const WEBMCP_PRODUCTION_HOST_PATTERN = '^(?:www|tech|finance|commodity|happy|energy)\\.worldmonitor\\.app$';
const WEBMCP_PRODUCTION_HOSTS = [
  'www.worldmonitor.app',
  'tech.worldmonitor.app',
  'finance.worldmonitor.app',
  'commodity.worldmonitor.app',
  'happy.worldmonitor.app',
  'energy.worldmonitor.app',
];
const WEBMCP_TRIAL_EXPIRY = 1_794_873_600;
const WEBMCP_TOKEN_RENEWAL_BUFFER_SECONDS = 14 * 24 * 60 * 60;
const WEBMCP_TOKEN_SHA256_BY_HOST = {
  'www.worldmonitor.app': '97b1029dd642731a33c2c6696f21358afe3f1e3bebf87079be26ba5891d950ce',
  'tech.worldmonitor.app': 'd230e2454012d19baebd987709beeefbd985b0e0f62aa080b220da80a6e6b31d',
  'finance.worldmonitor.app': 'e1f3483bd6cfae1ace66dc041c9f8584233c45e9e0c335394f6cf9bdfe9af489',
  'commodity.worldmonitor.app': '0e0bde1d1b87976889126b2f3ddcfd06df78cc3c13598e80e0a3a45701d2c0b6',
  'happy.worldmonitor.app': '72c2026ac2266553d9007ef0615ab46c0ca080002b86b11fc1e71cadb37f23f8',
  'energy.worldmonitor.app': '0f2fec8b51e7f29db5f12bcaaeb859d1f1d1c71156648d57d28e1bc86954d0d4',
};
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
const WEBMCP_PLAYWRIGHT_ENV_KEYS = [
  'WM_REQUIRE_WEBMCP',
  'WM_WEBMCP_PRODUCTION',
  'WM_WEBMCP_PRODUCTION_URL',
  'WM_WEBMCP_DEPLOYED_SHA',
  'WM_WEBMCP_CHROME_CHANNEL',
  'WM_WEBMCP_CHROME_EXECUTABLE_PATH',
];

function probePlaywrightWebMcpEnvironment(overrides = {}) {
  const env = { ...process.env, NODE_NO_WARNINGS: '1' };
  for (const key of WEBMCP_PLAYWRIGHT_ENV_KEYS) delete env[key];
  Object.assign(env, overrides);

  const probe = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      [
        "const { default: config } = await import('./playwright.config.ts');",
        "const chromium = config.projects?.find(({ name }) => name === 'chromium');",
        'console.log(JSON.stringify({',
        '  baseURL: config.use?.baseURL ?? null,',
        '  hasWebServer: Boolean(config.webServer),',
        '  launchArgs: chromium?.use?.launchOptions?.args ?? [],',
        '  testMatch: config.testMatch ?? null,',
        '}));',
      ].join('\n'),
    ],
    {
      cwd: resolve(__dirname, '..'),
      encoding: 'utf8',
      env,
    },
  );
  assert.ifError(probe.error);
  return probe;
}

const getCacheHeaderValue = (sourcePath) => {
  let value = null;
  for (const rule of vercelConfig.headers.filter((entry) => entry.source === sourcePath)) {
    const header = rule.headers?.find((item) => item.key.toLowerCase() === 'cache-control');
    if (header) value = header.value;
  }
  return value;
};

const getHeadersForSource = (sourcePath) => {
  return vercelConfig.headers
    .filter((entry) => entry.source === sourcePath)
    .flatMap((entry) => entry.headers ?? []);
};

// Convert a vercel.json `source` (the path-to-regexp subset used in this file)
// into a RegExp: literal segments, inline regex groups `(...)` kept raw,
// `:name(regex)` custom matchers, and `:name*` catch-all params. Lets tests
// evaluate which rules match a concrete URL instead of only asserting on a
// rule in isolation.
const sourceToRegExp = (source) => {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') {
      let depth = 0;
      let j = i;
      for (; j < source.length; j++) {
        if (source[j] === '(') depth++;
        else if (source[j] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      out += source.slice(i, j + 1);
      i = j;
    } else if (ch === ':') {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;
      if (source[j] === '(') {
        // `:name(regex)` custom matcher — drop the name, keep the group.
        let depth = 0;
        let k = j;
        for (; k < source.length; k++) {
          if (source[k] === '(') depth++;
          else if (source[k] === ')') {
            depth--;
            if (depth === 0) break;
          }
        }
        out += source.slice(j, k + 1);
        i = k;
      } else if (source[j] === '*') {
        out = out.replace(/\/$/, '');
        out += '(?:/.*)?';
        i = j;
      } else {
        out += '[^/]+';
        i = j - 1;
      }
    } else {
      out += /[.*+?^${}|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    }
  }
  return new RegExp(`^${out}$`);
};

const conditionMatchesRequest = (condition, { host, query = {} }) => {
  if (condition.type === 'host') return new RegExp(condition.value).test(host);
  if (condition.type === 'query') {
    const actual = query[condition.key];
    if (actual === undefined) return false;
    return condition.value === undefined || new RegExp(`^(?:${condition.value})$`).test(actual);
  }
  return false;
};

const firstRedirectFor = ({ host, path, query = {} }) => {
  for (const rule of vercelConfig.redirects) {
    if (!sourceToRegExp(rule.source).test(path)) continue;
    if (!(rule.has ?? []).every((condition) => conditionMatchesRequest(condition, { host, query }))) continue;
    if ((rule.missing ?? []).some((condition) => conditionMatchesRequest(condition, { host, query }))) continue;
    return rule;
  }
  return null;
};

const firstRewriteFor = ({ host, path, query = {} }) => {
  for (const rule of vercelConfig.rewrites) {
    if (!sourceToRegExp(rule.source).test(path)) continue;
    if (!(rule.has ?? []).every((condition) => conditionMatchesRequest(condition, { host, query }))) continue;
    if ((rule.missing ?? []).some((condition) => conditionMatchesRequest(condition, { host, query }))) continue;
    return rule;
  }
  return null;
};

const headerRuleMatchesRequest = (rule, { path, host, query = {} }) => {
  if (!sourceToRegExp(rule.source).test(path)) return false;
  const conditionMatches = (condition) => {
    if (condition.type === 'host') return new RegExp(condition.value).test(host);
    if (condition.type === 'query') {
      const actual = query[condition.key];
      if (actual === undefined) return false;
      return condition.value === undefined || new RegExp(`^(?:${condition.value})$`).test(actual);
    }
    return false;
  };
  return (rule.has ?? []).every(conditionMatches) && !(rule.missing ?? []).some(conditionMatches);
};

// Vercel applies every matching `headers` entry in file order; when several
// set the same header key, the LAST matching rule wins.
const effectiveCacheControl = (path) => {
  let value = null;
  for (const entry of vercelConfig.headers) {
    if (!sourceToRegExp(entry.source).test(path)) continue;
    const header = entry.headers?.find((h) => h.key.toLowerCase() === 'cache-control');
    if (header) value = header.value;
  }
  return value;
};

const getHeaderValueForSource = (sourcePath, key) => {
  const headers = getHeadersForSource(sourcePath);
  const header = headers.find((h) => h.key.toLowerCase() === key.toLowerCase());
  return header?.value ?? null;
};

const decodeOriginTrialTokenPayload = (token) => {
  assert.match(token, /^[A-Za-z0-9+/]+={0,2}$/, 'Origin-trial token must be canonical base64');
  assert.equal(token.length % 4, 0, 'Origin-trial token base64 must have complete quanta');
  const bytes = Buffer.from(token, 'base64');
  assert.equal(bytes.toString('base64'), token, 'Origin-trial token must round-trip without ignored bytes');
  assert.equal(bytes[0], 2, 'WebMCP origin-trial tokens must use the expected token version');
  assert.ok(bytes.length >= 69, 'Origin-trial token must contain its signature and payload length');
  const payloadLength = bytes.readUInt32BE(65);
  assert.equal(
    bytes.length,
    69 + payloadLength,
    'Origin-trial token payload length must cover the complete token without trailing bytes',
  );
  return JSON.parse(bytes.subarray(69).toString('utf8'));
};

const getCspDirectiveTokens = (csp, directive) => {
  const directiveSource = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${directive} `));
  const tokens = directiveSource?.slice(directive.length).trim().split(/\s+/).filter(Boolean) ?? [];
  return [...new Set(tokens)].sort();
};

// frame-src is a BOUNDED allowlist, not a closed host list: it legitimately
// carries vendor wildcard subdomains. Pin them, so a NEW wildcard or any
// scheme-wide source is flagged while the known ones stay quiet.
const KNOWN_FRAME_WILDCARDS = [
  'https://*.clerk.accounts.dev',
  'https://*.vercel.app',
  'https://*.dodopayments.com',
  'https://*.hs.dodopayments.com',
  'https://*.custom.hs.dodopayments.com',
];
const OPEN_CSP_SOURCES = ['*', 'https:', 'http:', 'data:', 'blob:'];
// Exported-by-hoisting so the guard's own negative test can drive it directly
// rather than asserting through the real config, which cannot show a widening.
const findOpenFrameSources = (tokens) => tokens.filter((token) => {
  if (KNOWN_FRAME_WILDCARDS.includes(token)) return false;
  // Tokens keep their scheme (`https://*.vercel.app`), so the wildcard test has
  // to run on the host part or it matches nothing at all.
  const host = token.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  return OPEN_CSP_SOURCES.includes(token) || host === '*' || host.startsWith('*.');
});

const hasTrustedStaticNonce = (attributes) => (
  new RegExp(`\\bnonce=["']${STATIC_SCRIPT_NONCE}["']`).test(attributes)
);

const getInlineScriptHashTokens = (htmlSource) => {
  return [...htmlSource.matchAll(/<script\b(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !hasTrustedStaticNonce(match[1]))
    .map((match) => match[2])
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


describe('crawlable content corpus deployment contracts', () => {
  const staticCorpusPaths = [
    '/countries/ukraine/',
    '/chokepoints/suez-canal/',
    '/research/strait-of-hormuz-transit-report-2026-07/',
    '/crises/ukraine-war/',
    '/tools/natural-hazard-pulse/',
    '/reference/changelog/page/2/',
  ];

  // #6575: the negative-lookahead SPA catch-all is gone. The dashboard
  // document is only served by the explicit /dashboard rewrites plus the
  // enumerated client-side History routes (/stocks, /stocks/:symbol, /story).
  const getSpaFallbackRewrites = () => vercelConfig.rewrites.filter((r) =>
    r.destination === DASHBOARD_HTML_DESTINATION && r.source !== '/dashboard'
  );

  const writeFixturePage = (publicDir, relativePath, head = '') => {
    const target = join(publicDir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '<!doctype html><html><head>' + head + '</head><body>fixture</body></html>');
  };

  it('pins the deploy build command in vercel.json to a script that builds /pro', () => {
    // vercel.json overrides the dashboard's Build Command, which is where this
    // used to live -- invisible to the repo and changeable without a diff. Since
    // #6898 stopped committing public/pro/, a dashboard edit away from a
    // build:pro-chaining script no longer ships a STALE /pro, it ships no /pro:
    // a 404 on www, and the dashboard SPA shell at 200 in the root Docker image.
    //
    // Deliberately resolved through package.json rather than string-matched
    // against 'npm run build:full'. The property that matters is "the deploy
    // builds /pro before Vite copies public/ into dist/", so pointing
    // buildCommand at any other script (build:tech, a bare `vite build`) has to
    // fail here -- a literal comparison would pass anything spelled right and
    // prove nothing about what that script does.
    const buildCommand = vercelConfig.buildCommand;
    assert.equal(
      typeof buildCommand,
      'string',
      'vercel.json must pin buildCommand so the deploy contract lives in the repo, not the dashboard',
    );

    const scriptName = buildCommand.match(/^npm run ([\w:-]+)$/)?.[1];
    assert.ok(
      scriptName,
      `vercel.json buildCommand must be a plain "npm run <script>" this test can resolve, got: ${buildCommand}`,
    );

    const script = packageJson.scripts[scriptName];
    assert.ok(script, `vercel.json buildCommand names scripts["${scriptName}"], which does not exist`);
    assert.ok(
      script.includes('npm run build:pro'),
      `the deploy build command (${buildCommand}) must chain build:pro — public/pro/ is gitignored, so nothing else produces /pro`,
    );
    assert.ok(
      script.indexOf('npm run build:pro') < script.indexOf('vite build'),
      `the deploy build command (${buildCommand}) must build /pro before Vite copies public/ into dist/`,
    );
  });

  it('runs content corpus sitemap integration after generated blog pages but before Vite builds', () => {
    assert.equal(
      packageJson.scripts['build:crawlable-corpus'],
      'node --import tsx scripts/build-crawlable-corpus.mjs'
    );
    assert.equal(
      packageJson.scripts['build:sitemap'],
      'node scripts/build-sitemap.mjs'
    );

    for (const scriptName of ['build', 'build:full']) {
      const script = packageJson.scripts[scriptName];
      assert.ok(script.includes('npm run build:blog'), scriptName + ' must build the Astro blog first');
      assert.ok(script.includes('npm run build:crawlable-corpus'), scriptName + ' must build the static corpus');
      assert.ok(script.includes('npm run build:sitemap'), scriptName + ' must run root sitemap generation');
      assert.ok(
        script.indexOf('npm run build:blog') < script.indexOf('npm run build:crawlable-corpus'),
        scriptName + ' must build /blog first so existing /blog/glossary remains delegated to the blog sitemap'
      );
      assert.ok(
        script.indexOf('npm run build:crawlable-corpus') < script.indexOf('npm run build:sitemap'),
        scriptName + ' must scan the corpus only after the page generator runs'
      );
      assert.ok(
        script.indexOf('npm run build:sitemap') < script.indexOf('vite build'),
        scriptName + ' must update public/sitemap.xml before Vite copies public/ into dist/'
      );
      // public/pro/ is a BUILD PRODUCT, not committed bytes (#6898). Vercel's
      // build command is `npm run build:full`, so if that chain stops running
      // build:pro the deploy ships a dist/ with no /pro at all -- a 404 on the
      // pricing page rather than the stale-bundle class this replaced.
      assert.ok(
        script.includes('npm run build:pro'),
        scriptName + ' must build pro-test -- public/pro/ is gitignored, so nothing else produces /pro'
      );
      // The ordering checks above only prove the STRING is chained. Without this,
      // build:pro could be rewritten to a no-op and every assertion here stays
      // green while the deploy quietly stops producing /pro. Accept either
      // `cd pro-test && npm run build` or `npm --prefix pro-test run build`.
      assert.match(
        packageJson.scripts['build:pro'],
        /(?:cd pro-test\b[\s\S]*npm run build\b|npm --prefix pro-test run build\b)/,
        'build:pro must actually run pro-test\'s build, not just exist as a chained name'
      );
      assert.ok(
        script.indexOf('npm run build:pro') < script.indexOf('vite build'),
        scriptName + ' must build /pro before Vite copies public/ into dist/'
      );
    }

    for (const [name, source] of [
      ['Dockerfile', dockerfileSource],
      ['docker/Dockerfile', frontendDockerfileSource],
    ]) {
      assert.ok(source.includes('npm run build:crawlable-corpus'), name + ' must build the static corpus');
      assert.ok(source.includes('npm run build:sitemap'), name + ' must generate the root sitemap');
      assert.ok(
        source.indexOf('npm run build:crawlable-corpus') < source.indexOf('npm run build:sitemap'),
        name + ' must scan the sitemap only after corpus pages exist'
      );
      assert.ok(
        source.indexOf('npm run build:sitemap') < source.indexOf('npx vite build'),
        name + ' must update public/sitemap.xml before Vite copies public/ into dist/'
      );
      // Unlike /blog (deliberately skipped in the images), docker/nginx.conf.template
      // routes `location ^~ /pro` and `/pro/assets/`, so a self-hosted image that
      // never builds pro-test serves a 404 behind a live route.
      assert.ok(
        source.includes('npm run build:pro'),
        name + ' must build pro-test -- nginx.conf.template routes /pro and public/pro/ is gitignored'
      );
      assert.ok(
        source.indexOf('npm run build:pro') < source.indexOf('npx vite build'),
        name + ' must build /pro before Vite copies public/ into dist/'
      );
      assert.ok(
        source.indexOf('node scripts/generate-inventory-facts.mjs') < source.indexOf('npx vite build'),
        name + ' must generate ignored inventory assets in a clean build context before Vite runs',
      );
    }
    assert.ok(
      dockerfileSource.indexOf('node scripts/generate-inventory-facts.mjs') < dockerfileSource.indexOf('node docker/build-handlers.mjs'),
      'the self-host image must generate the Edge inventory module before handler bundling',
    );
    assert.match(frontendDockerfileSource, /RUN test -s dist\/product-facts\.json/);
    assert.ok(!packageJson.scripts['build:full'].includes('npm run build:blog &&'), 'build:full must not regenerate inventory facts inside build:blog');
  });

  it('builds Vercel when corpus source files change', () => {
    assert.ok(vercelIgnoreSource.includes("'CHANGELOG.md'"));
    assert.ok(vercelIgnoreSource.includes("'docs/snapshots/'"));
    for (const path of [
      'docs/docs.json',
      'scripts/build-use-cases.mjs',
      'scripts/crawlable-sources-page.mjs',
      'scripts/source-origin.mjs',
      'scripts/source-origin.d.mts',
      'scripts/generate-inventory-facts.mjs',
      'scripts/docs-stats.mjs',
      'scripts/source-attribution.mjs',
    ]) {
      assert.equal(vercelIgnoreSource.split(`'${path}'`).length - 1, 2, `${path} must trigger main and preview builds`);
    }
  });

  it('builds Vercel on main and preview for generated web-input changes', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'wm-vercel-ignore-'));
    try {
      const fixtureEnv = { ...process.env };
      for (const key of ['GIT_COMMON_DIR', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_WORK_TREE']) {
        delete fixtureEnv[key];
      }
      const git = (...args) => execFileSync('git', args, { cwd: fixture, env: fixtureEnv, encoding: 'utf8' });

      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      writeFileSync(join(fixture, 'README.md'), 'base\n');
      git('add', 'README.md');
      git('commit', '-qm', 'base');

      for (const path of [
        'docs/docs.json',
        'scripts/build-use-cases.mjs',
        'scripts/crawlable-sources-page.mjs',
        'scripts/source-origin.mjs',
        'scripts/source-origin.d.mts',
        'scripts/generate-inventory-facts.mjs',
        'scripts/docs-stats.mjs',
        'scripts/source-attribution.mjs',
      ]) {
        const previous = git('rev-parse', 'HEAD').trim();
        mkdirSync(dirname(join(fixture, path)), { recursive: true });
        writeFileSync(join(fixture, path), `${path}\n`);
        git('add', path);
        git('commit', '-qm', path);
        assert.throws(
          () => execFileSync('/bin/bash', [resolve(__dirname, '../scripts/vercel-ignore.sh')], {
            cwd: fixture,
            env: { ...fixtureEnv, VERCEL_GIT_COMMIT_REF: 'main', VERCEL_GIT_PREVIOUS_SHA: previous },
          }),
          (error) => error?.status === 1,
          `${path} must request a Vercel build`,
        );
        git('update-ref', 'refs/remotes/origin/main', previous);
        assert.throws(
          () => execFileSync('/bin/bash', [resolve(__dirname, '../scripts/vercel-ignore.sh')], {
            cwd: fixture,
            env: { ...fixtureEnv, VERCEL_GIT_COMMIT_REF: 'feature/source-catalog' },
          }),
          (error) => error?.status === 1,
          `${path} must request a Vercel preview build`,
        );
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('keeps corpus inputs available in Docker build contexts', () => {
    const markdownIgnore = dockerignoreSource.indexOf('*.md');
    const changelogInclude = dockerignoreSource.indexOf('!CHANGELOG.md');
    assert.ok(markdownIgnore >= 0, 'expected the broad markdown ignore rule to be present');
    assert.ok(changelogInclude > markdownIgnore, 'CHANGELOG.md must be re-included after *.md for Docker corpus builds');
  });

  it('keeps local self-hosting credentials out of Docker build contexts', () => {
    const ignoreRules = new Set(
      dockerignoreSource
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
    );

    for (const path of ['docker-compose.override.yml', 'secrets/']) {
      assert.ok(ignoreRules.has(path), `${path} must never enter Docker build contexts or caches`);
    }
  });

  it('serves no SPA fallback for generated corpus paths while keeping real client deep links', () => {
    // #6575: unknown paths must fall through to the filesystem (404), so the
    // only dashboard-serving rewrites left are the explicit client History
    // routes. Corpus HTML keeps resolving as raw static files.
    const fallbacks = getSpaFallbackRewrites();
    assert.deepEqual(
      fallbacks.map((r) => r.source).sort(),
      ['/stocks', '/stocks/:symbol', '/story'],
      'the SPA fallback inventory must stay enumerable — every entry is a real client-side route'
    );

    for (const path of [...staticCorpusPaths, '/blog/glossary/country-instability-index/']) {
      const matched = fallbacks.find((r) => sourceToRegExp(r.source).test(path));
      assert.equal(
        matched,
        undefined,
        path + ' must resolve as raw static HTML, not /dashboard.html'
      );
    }

    assert.equal(firstRewriteFor({ host: 'www.worldmonitor.app', path: '/stocks' })?.destination, DASHBOARD_HTML_DESTINATION);
    assert.equal(firstRewriteFor({ host: 'www.worldmonitor.app', path: '/stocks/AAPL' })?.destination, DASHBOARD_HTML_DESTINATION);
    assert.equal(firstRewriteFor({ host: 'www.worldmonitor.app', path: '/story' })?.destination, DASHBOARD_HTML_DESTINATION);
    assert.equal(firstRewriteFor({ host: 'www.worldmonitor.app', path: '/stocks/foo/bar' }), null);
    assert.equal(firstRedirectFor({ host: 'www.worldmonitor.app', path: '/story/' })?.destination, '/story');
    assert.equal(firstRedirectFor({ host: 'www.worldmonitor.app', path: '/dashboard/' })?.destination, '/dashboard');
    // Unknown garbage used to soft-404 the dashboard through the catch-all.
    assert.equal(firstRewriteFor({ host: 'www.worldmonitor.app', path: '/this-is-not-a-page' }), null);
    assert.equal(firstRewriteFor({ host: 'www.worldmonitor.app', path: '/security' }), null);
  });

  it('serves static corpus HTML with public revalidating cache headers', () => {
    for (const prefix of CONTENT_CORPUS_PREFIXES) {
      const expected = 'public, max-age=3600, must-revalidate';
      assert.equal(getCacheHeaderValue('/' + prefix), expected, '/' + prefix + ' must have a cache policy');
      assert.equal(getCacheHeaderValue('/' + prefix + '/:path*'), expected, '/' + prefix + '/:path* must have a cache policy');
      assert.equal(effectiveCacheControl('/' + prefix + '/example/'), expected, '/' + prefix + '/example/ must not inherit SPA HTML cache headers');
    }
  });

  it('keeps robots.txt advertising root, blog, and Mintlify docs sitemaps', () => {
    assert.match(robotsSource, /^Sitemap: https:\/\/www\.worldmonitor\.app\/sitemap\.xml$/m);
    assert.match(robotsSource, /^Sitemap: https:\/\/www\.worldmonitor\.app\/blog\/sitemap-index\.xml$/m);
    assert.match(robotsSource, /^Sitemap: https:\/\/www\.worldmonitor\.app\/docs\/sitemap\.xml$/m);
  });

  it('keeps the root sitemap generated while delegating blog and docs inventories', () => {
    assert.ok(sitemapSource.includes('Generated by npm run build:sitemap. Do not edit by hand.'));
    assert.ok(!sitemapSource.includes('https://www.worldmonitor.app/blog/'));
    assert.ok(!sitemapSource.includes('https://www.worldmonitor.app/docs/'));
    assert.ok(!sitemapSource.includes('<changefreq>'));
    assert.ok(!sitemapSource.includes('<priority>'));
  });

  it('discovers canonical generated corpus pages and validates changelog pagination links', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'wm-content-corpus-'));
    const publicDir = join(tempRoot, 'public');
    try {
      writeFixturePage(
        publicDir,
        'countries/ukraine/index.html',
        '<link rel="canonical" href="https://www.worldmonitor.app/countries/ukraine/" /><meta name="lastmod" content="2026-07-08" />'
      );
      writeFixturePage(
        publicDir,
        'chokepoints/suez-canal/index.html',
        '<link rel="canonical" href="https://www.worldmonitor.app/chokepoints/suez-canal/" />'
      );
      writeFixturePage(
        publicDir,
        'crises/ukraine-war/index.html',
        '<link rel="canonical" href="https://www.worldmonitor.app/crises/ukraine-war/" />'
      );
      writeFixturePage(
        publicDir,
        'tools/natural-hazard-pulse/index.html',
        '<link rel="canonical" href="https://www.worldmonitor.app/tools/natural-hazard-pulse/" />'
      );
      writeFixturePage(
        publicDir,
        'reference/changelog/page/1/index.html',
        '<link rel="canonical" href="https://www.worldmonitor.app/reference/changelog/page/1/" /><link rel="next" href="https://www.worldmonitor.app/reference/changelog/page/2/" />'
      );
      writeFixturePage(
        publicDir,
        'reference/changelog/page/2/index.html',
        '<link rel="canonical" href="https://www.worldmonitor.app/reference/changelog/page/2/" /><link rel="prev" href="https://www.worldmonitor.app/reference/changelog/page/1/" />'
      );

      const pages = discoverContentCorpusPages({ publicDir });
      const locations = pages.map((page) => page.loc).sort();
      assert.deepEqual(locations, [
        'https://www.worldmonitor.app/reference/changelog/page/1/',
        'https://www.worldmonitor.app/reference/changelog/page/2/',
        'https://www.worldmonitor.app/chokepoints/suez-canal/',
        'https://www.worldmonitor.app/crises/ukraine-war/',
        'https://www.worldmonitor.app/countries/ukraine/',
        'https://www.worldmonitor.app/tools/natural-hazard-pulse/',
      ].sort());

      writeFixturePage(
        publicDir,
        'reference/changelog/page/3/index.html',
        '<link rel="canonical" href="https://www.worldmonitor.app/reference/changelog/page/3/" />'
      );
      assert.throws(
        () => discoverContentCorpusPages({ publicDir }),
        /missing rel="(?:prev|next)" pagination link/
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

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

  it('serves /pro hashed assets immutable — broader /pro rules must not override', () => {
    // /pro/:path* also matches /pro/assets/*; because the last matching rule
    // wins per header key, the immutable /pro/assets rule has to be ordered
    // AFTER the /pro catch-alls or every hashed chunk (including the ~3MB
    // Clerk bundle) is re-downloaded on each repeat visit.
    assert.equal(
      effectiveCacheControl('/pro/assets/clerk-abc123.js'),
      'public, max-age=31536000, immutable'
    );
    assert.equal(
      effectiveCacheControl('/pro/assets/worldmonitor-7-mar-2026-abc.jpg'),
      'public, max-age=31536000, immutable'
    );
    // HTML entries under /pro keep revalidating.
    assert.equal(effectiveCacheControl('/pro'), 'private, no-cache, must-revalidate');
    assert.equal(effectiveCacheControl('/pro/welcome.html'), 'private, no-cache, must-revalidate');
    // Main-app hashed assets stay immutable end-to-end too.
    assert.equal(
      effectiveCacheControl('/assets/index-abc.js'),
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

  it('keeps off-page public assets out of the PWA precache', () => {
    const assertGlobIgnore = (pattern) => {
      assert.match(
        viteConfigSource,
        new RegExp(`globIgnores:\\s*\\[[\\s\\S]*'${escapeRegExp(pattern)}'[\\s\\S]*\\]`)
      );
    };

    assert.match(viteConfigSource, /includeManifestIcons:\s*false/);
    assert.doesNotMatch(
      viteConfigSource,
      /globIgnores:[\s\S]*'assets\/\*\*'/
    );
    assertGlobIgnore('pro/**');
    assertGlobIgnore('favico/**');
    assertGlobIgnore('textures/**');
    assertGlobIgnore('**/*.woff2');
    // #4891: blog OG covers exist only in prod builds (blog generated at
    // deploy), so a local dist/sw.js never exposes the regression — guard the
    // config directly. Without this ignore, every first dashboard visit
    // precached ~40 blog PNGs (~700KB) through the service worker.
    assertGlobIgnore('blog/**');
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

  it('delegates navigation requests to the SW script with an offline fallback', () => {
    // Navigations are handled by public/sw-navigation.js: network-first with
    // NO cache write (a cached index.html outlives its hashed chunks across
    // deploys -> blank offline reloads), falling back to the precached
    // offline.html when the network is unreachable.
    assert.match(viteConfigSource, /importScripts:\s*\[[^\]]*'\/sw-navigation\.js'/);
    assert.doesNotMatch(viteConfigSource, /html-navigation/);
    const navScript = readFileSync(resolve(__dirname, '../public/sw-navigation.js'), 'utf-8');
    assert.match(navScript, /request\.mode !== 'navigate'/);
    assert.match(navScript, /OFFLINE_URL = '\/offline\.html'/);
    assert.match(navScript, /caches\.match\(OFFLINE_URL/);
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
// Both affiliate param names, in URL position. Mirrors REFERRAL_PARAM_NAMES in
// src/services/referral-capture.ts — a CTA spelled with either one is captured
// as an affiliate code and forwarded to Dodo.
const AFFILIATE_PARAM_IN_URL = /[?&](?:ref|wm_referral)=/;
// Dashboard-bound CTA queries, in the two shapes the welcome sections use: the
// DASHBOARD_PATH template literal and an absolute variant-host URL.
const DASHBOARD_CTA_QUERY = /(?:\$\{DASHBOARD_PATH\}|worldmonitor\.app\/dashboard)\?([^`'"\s]*)/g;

function readWelcomeSources() {
  const welcomeDir = resolve(__dirname, '../pro-test/src/welcome');
  const files = readdirSync(welcomeDir).filter((file) => file.endsWith('.tsx'));
  assert.ok(files.length > 0, 'expected welcome section sources to scan');
  return files.map((file) => [file, readFileSync(resolve(welcomeDir, file), 'utf-8')]);
}

function readGeneratedWelcomeAsset(generatedWelcomeHtml) {
  const welcomeAssetPath = generatedWelcomeHtml.match(/src="\/pro\/(assets\/welcome-[^"]+\.js)"/)?.[1];
  assert.ok(welcomeAssetPath, 'generated welcome HTML must reference a hashed welcome JS entry');
  return readFileSync(resolve(__dirname, '../public/pro', welcomeAssetPath), 'utf-8');
}

describe('welcome landing page routing', () => {
  // Cases below read the prerendered public/pro/ pages, built by
  // `npm run build:pro` rather than committed (#6898): they skip in an
  // unbuilt checkout and this fails the suite when CI says it built them.
  guardProBuiltOutput();
  // A `/` rewrite gated on a query condition (e.g. /?mode=agent →
  // /agent-view.json) never matches a plain navigation, so the app-root
  // welcome rewrite is the first `/` rule WITHOUT a query condition.
  const getRootRewrite = () =>
    vercelConfig.rewrites.find(
      (r) => r.source === '/' && !(r.has ?? []).some((condition) => condition.type === 'query')
    );
  // #6575: with the SPA catch-all removed, a host that matches no `/` rule
  // falls through to the filesystem — there is no public/index.* (#4825), so
  // the result is a real 404, not the dashboard document.
  const rootDestinationForHost = (host) => {
    const rewrite = getRootRewrite();
    assert.ok(rewrite, 'expected a rewrite for /');
    const hostCondition = rewrite.has?.find((condition) => condition.type === 'host');
    if (!hostCondition || new RegExp(hostCondition.value).test(host)) return rewrite.destination;
    return null;
  };

  it('declares / as the app-root welcome rewrite after moving dashboard HTML off root index', () => {
    const rewrite = getRootRewrite();
    assert.ok(rewrite, 'expected a rewrite for /');
    assert.equal(rewrite.destination, '/pro/welcome.html');
    assert.deepEqual(rewrite.has, [
      { type: 'host', value: '^(?:www\\.)?worldmonitor\\.app$' },
    ]);
  });

  // #4825: public/index.md became Vercel's DIRECTORY INDEX for `/` — filesystem
  // resolution beats the `/` → /pro/welcome.html rewrite, so the apex homepage
  // served raw text/markdown to browsers. No `index.*` file may exist in public/;
  // the markdown homepage twin lives at public/home.md and keeps its scored URL
  // through the /index.md rewrite below.
  it('keeps public/ free of index.* files so filesystem resolution cannot hijack the / rewrite', () => {
    const publicDir = resolve(__dirname, '../public');
    const offenders = readdirSync(publicDir).filter((f) => /^index\./i.test(f));
    assert.deepEqual(offenders, [], `public/${offenders[0] ?? ''} would shadow the / welcome rewrite as a directory index`);
  });

  it('serves the markdown homepage twin at /index.md via rewrite to the non-index home.md', () => {
    assert.ok(existsSync(resolve(__dirname, '../public/home.md')), 'expected public/home.md (markdown homepage twin)');
    const rewrite = vercelConfig.rewrites.find((r) => r.source === '/index.md');
    assert.ok(rewrite, 'expected a rewrite for /index.md');
    assert.equal(rewrite.destination, '/home.md');
    // #6575: the SPA catch-all this ordering guarded is gone; /index.md only
    // needs its own explicit rewrite to win over filesystem resolution.
    assert.equal(vercelConfig.rewrites.filter((r) => r.source === '/index.md').length, 1);
  });

  it('routes app roots to welcome; unknown-host and variant roots never soft-404 the dashboard', () => {
    assert.equal(rootDestinationForHost('worldmonitor.app'), '/pro/welcome.html');
    assert.equal(rootDestinationForHost('www.worldmonitor.app'), '/pro/welcome.html');
    // #6575: a host outside the product family gets a real 404 at /.
    assert.equal(rootDestinationForHost('worldmonitor.app.evil.example'), null);

    const variantHosts = getVariantHosts().filter((host) => host !== 'www.worldmonitor.app');
    for (const host of variantHosts) {
      const redirect = firstRedirectFor({ host, path: '/' });
      assert.equal(redirect?.destination, '/dashboard', `${host}/ must 308 to /dashboard in production`);
      assert.equal(rootDestinationForHost(host), null, `${host}/ must not also match the www welcome rewrite`);
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

    assert.ok(
      middlewareSource.includes(`href="${variantUrls.full}"`),
      'AI crawler body must link the full dashboard canonical',
    );
    assert.match(
      middlewareSource,
      /const AI_CRAWLER_VARIANT_LINKS = Object\.values\(VARIANT_HOST_MAP\)/,
      'AI crawler body links must be derived from the canonical variant host map',
    );
    assert.match(
      middlewareSource,
      /const og = VARIANT_OG\[variant\]/,
      'AI crawler body link labels and URLs must come from variant metadata',
    );
    assert.match(
      middlewareSource,
      /escHtml\(og\.url\)/,
      'AI crawler body link URLs must stay HTML-escaped',
    );
    assert.match(
      middlewareSource,
      /escHtml\(og\.name\)/,
      'AI crawler body link labels must stay HTML-escaped',
    );
    assert.ok(
      middlewareSource.includes('${AI_CRAWLER_VARIANT_LINKS}'),
      'AI crawler body must render the generated variant links',
    );
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
    // Host-conditioned variant rules (#4996) sit in front; the fallback for
    // every other host is the un-conditioned rule.
    const rewrite = vercelConfig.rewrites.find((r) => r.source === '/dashboard' && !r.has);
    assert.ok(rewrite, 'expected an un-conditioned rewrite for /dashboard');
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
    // Assert the build's OUTPUT, not the plugin's internals. Vercel's
    // filesystem precedence serves a root index.html at / ahead of every
    // rewrite above, so what matters is that the web build emits
    // dashboard.html and leaves no index.html behind — however the plugin
    // happens to accomplish it.
    const distDir = resolve(__dirname, '../dist');
    const dashboardHtml = join(distDir, 'dashboard.html');
    if (shouldSkipBuiltOutput(dashboardHtml)) return;
    guardBuiltOutput(dashboardHtml);

    assert.ok(existsSync(dashboardHtml), 'web build must emit dist/dashboard.html');
    assert.ok(
      !existsSync(join(distDir, 'index.html')),
      'web build must not leave a root dist/index.html — Vercel would serve it at / ahead of the dashboard rewrite',
    );
  });

  it('does not reintroduce a negative-lookahead SPA catch-all rewrite', () => {
    const catchAll = vercelConfig.rewrites.find((r) =>
      r.destination === DASHBOARD_HTML_DESTINATION && r.source.startsWith('/((?!')
    );
    assert.equal(
      catchAll,
      undefined,
      'unknown paths must 404 instead of soft-404ing the dashboard (#6575); the fallback inventory is /dashboard, /stocks, /stocks/:symbol, /story only'
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

  it('redirects the human pricing route to the canonical pricing section before SPA routing', () => {
    const redirect = vercelConfig.redirects.find((r) => r.source === '/pricing');
    assert.ok(redirect, 'expected a redirect for /pricing');
    assert.equal(redirect.destination, '/pro#pricing');
    assert.equal(redirect.permanent, true);

    assert.equal(
      vercelConfig.redirects.some((r) => r.source === '/pricing.md'),
      false,
      'the machine-readable pricing contract must remain a static asset',
    );
    assert.equal(
      vercelConfig.redirects.some((r) => r.source === '/api/product-catalog'),
      false,
      'the live product catalog endpoint must remain unchanged',
    );
    assert.equal(
      vercelConfig.rewrites.some((r) => r.source === '/pricing'),
      false,
      '/pricing must be handled in the redirects phase before the SPA rewrites phase',
    );
  });

  it('redirects bare corpus roots to canonical generated pages', () => {
    const changelog = vercelConfig.redirects.find((r) => r.source === '/changelog');
    assert.ok(changelog, 'expected a redirect for /changelog');
    assert.equal(changelog.destination, '/reference/changelog/');
    assert.equal(changelog.permanent, true);

    const reference = vercelConfig.redirects.find((r) => r.source === '/reference');
    assert.ok(reference, 'expected a redirect for /reference');
    assert.equal(reference.destination, '/reference/changelog/');
    assert.equal(reference.permanent, false);
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

  it('pins welcome and dashboard SEO canonicals to their new routes', { skip: shouldSkipProBuiltOutput() }, () => {
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

  it('keeps welcome dashboard launch CTAs off the root welcome route', { skip: shouldSkipProBuiltOutput() }, () => {
    const welcomeSources = readWelcomeSources();
    const generatedWelcomeHtml = readFileSync(resolve(__dirname, '../public/pro/welcome.html'), 'utf-8');
    const generatedWelcomeAsset = readGeneratedWelcomeAsset(generatedWelcomeHtml);

    // Param-agnostic on purpose: these once keyed off `?ref=welcome-`, and
    // when #6493 moved the CTAs to `?utm_source=` both regexes quietly stopped
    // matching anything, leaving the guard green over code it no longer
    // described. What is actually forbidden is a query-carrying link to a ROOT
    // route (`/?…`), which lands back on the welcome page instead of the
    // dashboard — whatever the query happens to be called. The established
    // `/?mode=agent` discovery route is intentionally served ahead of the
    // welcome rewrite and is not a dashboard launch CTA. The exemption only
    // covers a literal that ENDS at its closing quote: a quote followed by
    // `+` is a runtime concatenation (`href:"/?mode=agent"+x` in the minified
    // asset), whose final URL is no longer exactly `/?mode=agent` and would
    // fall through Vercel's exact-value mode=agent rewrite back onto the
    // welcome page — so it stays forbidden.
    const rootWelcomeLaunchLink = /href\s*[:=]\s*["'`]\/\?(?!mode=agent["'`](?!\s*\+))/;
    const variantRootWelcomeLaunchLink = /https:\/\/(?:tech|finance|commodity|happy|energy)\.worldmonitor\.app\/\?/;
    assert.doesNotMatch(
      'href="/?mode=agent"',
      rootWelcomeLaunchLink,
      'the exact agent-view discovery URL must remain allowed'
    );
    assert.match(
      'href="/?utm_source=welcome"',
      rootWelcomeLaunchLink,
      'the guard must detect ordinary query-carrying root URLs'
    );
    assert.match(
      'href="/?mode=agent&utm_source=welcome"',
      rootWelcomeLaunchLink,
      'the agent-view exception must not hide a query-carrying launch URL'
    );
    assert.doesNotMatch(
      'href:"/?mode=agent",',
      rootWelcomeLaunchLink,
      'the minified-asset form of the exact agent-view URL must remain allowed'
    );
    assert.match(
      'href:"/?mode=agent"+e',
      rootWelcomeLaunchLink,
      'a concatenation-built agent URL is not the exact discovery URL and must stay forbidden'
    );
    for (const [file, source] of welcomeSources) {
      assert.doesNotMatch(
        source,
        rootWelcomeLaunchLink,
        `${file}: welcome source must not route launch CTAs back to the root welcome page`
      );
      assert.doesNotMatch(
        source,
        variantRootWelcomeLaunchLink,
        `${file}: welcome source must not route variant launch CTAs back to variant root welcome pages`
      );
    }
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

  it('tags welcome dashboard CTAs with utm params, never an affiliate referral param', { skip: shouldSkipProBuiltOutput() }, () => {
    // `ref=` and `wm_referral=` on a dashboard URL are read by
    // src/services/referral-capture.ts as an AFFILIATE code: persisted for 7
    // days and forwarded to Dodo as `affonso_referral`. Internal welcome CTAs
    // tagged that way credit "welcome-nav" for organic purchases (#6493), so
    // the source tag must be a utm_* param — which Umami reports natively and
    // referral-capture ignores. Both param names are banned: wm_referral is
    // read FIRST, so a CTA spelled that way is the identical bug.
    const welcomeSources = readWelcomeSources();

    let taggedCtas = 0;
    for (const [file, source] of welcomeSources) {
      assert.doesNotMatch(
        source,
        AFFILIATE_PARAM_IN_URL,
        `${file}: welcome CTAs must never use an affiliate referral param (see REFERRAL_PARAM_NAMES in referral-capture.ts)`
      );
      for (const [, query] of source.matchAll(DASHBOARD_CTA_QUERY)) {
        assert.match(
          query,
          /(?:^|&)utm_source=welcome(?:&|$)/,
          `${file}: dashboard CTA "?${query}" must carry utm_source=welcome`
        );
        taggedCtas += 1;
      }
    }
    // Exact, not a floor: a floor with slack lets a CTA drop out of the scan
    // (moved behind a helper, or re-pointed off /dashboard) while still
    // reading as covered. Bump this deliberately when a CTA is added.
    assert.equal(taggedCtas, 12, `expected all 12 welcome dashboard CTAs to be scanned, saw ${taggedCtas}`);

    const generatedWelcomeHtml = readFileSync(resolve(__dirname, '../public/pro/welcome.html'), 'utf-8');
    assert.doesNotMatch(
      readGeneratedWelcomeAsset(generatedWelcomeHtml),
      AFFILIATE_PARAM_IN_URL,
      'generated welcome JS still ships affiliate referral CTAs — rebuild pro-test (npm run build:pro)'
    );
    assert.doesNotMatch(
      // React serializes `&` as `&amp;` in attribute values, so a second-position
      // param reads `&amp;ref=` in the prerendered HTML and would slip past a
      // bare `[?&]` character class.
      generatedWelcomeHtml.replace(/&amp;/g, '&'),
      AFFILIATE_PARAM_IN_URL,
      'prerendered welcome HTML still ships affiliate referral CTAs — rebuild pro-test (npm run build:pro)'
    );
  });

  it('keeps every critical-CSS anchor rule bound to an anchor the prerender actually emits', { skip: shouldSkipProBuiltOutput() }, () => {
    // The inline critical CSS styles the above-the-fold CTAs by attribute
    // selector before Tailwind loads. Those selectors key off values that live
    // in the components (an href query, an aria-label), so renaming one there
    // silently kills the rule and the CTA renders unstyled on first paint.
    const prerenderSource = readFileSync(resolve(__dirname, '../pro-test/prerender.mjs'), 'utf-8')
      // Comments in this file discuss selectors (including ones that no longer
      // exist); scanning them would fail the guard over prose.
      .replace(/^[ \t]*\/\/.*$/gm, '');
    const generatedWelcomeHtml = readFileSync(resolve(__dirname, '../public/pro/welcome.html'), 'utf-8');

    // Region-scoped: a `main a[...]` rule is dead if only a <nav> anchor
    // matches it, so each selector is checked against anchors from its own
    // region rather than the whole document.
    const anchorsByRegion = new Map(['main', 'nav'].map((region) => {
      const markup = generatedWelcomeHtml.match(new RegExp(`<${region}\\b[\\s\\S]*?</${region}>`))?.[0] ?? '';
      return [region, markup.match(/<a\b[^>]*>/g) ?? []];
    }));
    for (const [region, anchors] of anchorsByRegion) {
      assert.ok(anchors.length > 0, `prerendered welcome HTML must contain <${region}> anchors`);
    }

    // `[~|^$*]?` covers every CSS attribute operator, so a rule rewritten with
    // one we do not model fails loudly below instead of dropping out of the
    // scanned set.
    // `nav` matches with or without the header marker so an un-scoped rule is
    // still scanned here; the required list below is what fails on it.
    const selectors = [...prerenderSource.matchAll(/(main|nav(?:\[data-wm-nav\])?) a\[([a-zA-Z-]+)([~|^$*]?)="([^"]+)"\]/g)];
    const scanned = new Set(selectors.map(([, region, attribute, operator, value]) => `${region} a[${attribute}${operator}="${value}"]`));
    // Named, not counted: a floor equal to the post-deletion count is green
    // when the rule it exists to protect is deleted outright.
    for (const required of [
      'main a[data-umami-event-target="welcome-hero"]',
      'main a[href*="moments"]',
      'nav[data-wm-nav] a[aria-label*="Launch"]',
    ]) {
      assert.ok(scanned.has(required), `critical CSS must still style the welcome CTA via ${required}`);
    }

    for (const [, region, attribute, operator, value] of selectors) {
      assert.ok(
        operator === '' || operator === '*',
        `critical CSS selector a[${attribute}${operator}="${value}"] uses an attribute operator this guard does not model — teach it the operator or it silently stops checking that rule`
      );
      // `nav[data-wm-nav]` is the header nav's marker (see prerender.mjs); the
      // anchor pool is keyed by the landmark element, so map it back. Asserted
      // rather than defaulted: an unknown region silently reports every rule in
      // it as dead, which reads as a broken CTA instead of a broken guard.
      const anchorRegion = region.startsWith('nav') ? 'nav' : region;
      assert.ok(
        anchorsByRegion.has(anchorRegion),
        `critical CSS region "${region}" has no anchor pool — teach this guard the region or it stops checking every rule inside it`
      );
      const matched = anchorsByRegion.get(anchorRegion).some((tag) => {
        const actual = tag.match(new RegExp(`\\b${attribute}="([^"]*)"`))?.[1];
        if (actual === undefined) return false;
        return operator === '*' ? actual.includes(value) : actual === value;
      });
      assert.ok(
        matched,
        `critical CSS selector ${region} a[${attribute}${operator}="${value}"] matches no prerendered <${region}> anchor — the rule is dead and its CTA paints unstyled`
      );
    }
  });

  it('scopes every nav critical-CSS rule to the primary header nav, not to every <nav> on the page', { skip: shouldSkipProBuiltOutput() }, async () => {
    // The inline critical CSS is UNLAYERED, so a bare `nav` type selector beats
    // every Tailwind utility on EVERY nav landmark the page renders — including
    // ones added later, in the footer, by someone who never opened this file.
    // The legal footer nav (#6982) landed under `nav{position:fixed;top:0;
    // z-index:50}` and painted itself across the header, over the Launch CTA.
    const { Window } = await import('happy-dom');
    const prerenderSource = readFileSync(resolve(__dirname, '../pro-test/prerender.mjs'), 'utf-8')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    const criticalCssArray = prerenderSource.match(/const CRITICAL_CSS = \[([\s\S]*?)\n\]\.join\(''\);/)?.[1];
    assert.ok(criticalCssArray, 'could not find the CRITICAL_CSS array in prerender.mjs — teach this guard its new shape');
    const criticalCss = [...criticalCssArray.matchAll(/'((?:[^'\\]|\\.)*)'/g)]
      .map(([, literal]) => literal.replace(/\\'/g, "'"))
      .join('');

    // Leaf rules only: an `@media (...)` prelude can never complete this match
    // (its body opens another `{`), so a media block contributes the rules
    // inside it and nothing else.
    const navSelectors = [...criticalCss.matchAll(/([^{}]+)\{[^{}]*\}/g)]
      .flatMap(([, selectorList]) => selectorList.split(',').map((one) => one.trim()))
      .filter((selector) => /^nav\b/.test(selector));

    // Only the nav landmarks are parsed: every selector above is rooted at
    // `nav`, so nothing outside one can match, and parsing the whole 130KB
    // prerendered page instead costs ~10s of suite time. <nav> does not nest,
    // so the non-greedy sweep takes each landmark whole.
    const navMarkup = readFileSync(resolve(__dirname, '../public/pro/welcome.html'), 'utf-8')
      .match(/<nav\b[\s\S]*?<\/nav>/g) ?? [];
    assert.ok(
      navMarkup.length > 1,
      'positive control: the prerendered welcome page must render a second <nav> (the legal footer row) or the containment check below proves nothing'
    );
    const window = new Window({
      url: 'https://www.worldmonitor.app/',
      settings: {
        disableJavaScriptEvaluation: true,
        disableJavaScriptFileLoading: true,
        disableCSSFileLoading: true,
      },
    });
    window.document.write(`<!doctype html><html><body>${navMarkup.join('')}</body></html>`);
    const { document } = window;

    // Two positive controls, because "nothing over-matched" is green on a page
    // that renders one nav, and green again if the rules were deleted outright.
    const headerPin = navSelectors.filter((selector) => criticalCss.includes(`${selector}{position:fixed`));
    assert.equal(
      headerPin.length,
      1,
      `positive control: exactly one nav critical-CSS rule must still pin the header before Tailwind loads (found ${headerPin.length})`
    );
    const pinned = [...document.querySelectorAll(headerPin[0])];
    assert.equal(
      pinned.length,
      1,
      `critical CSS "${headerPin[0]}" pins ${pinned.length} elements — it must pin the header nav and nothing else`
    );
    const header = pinned[0];

    // A `nav`-rooted selector can only reach a nav landmark or its descendants,
    // so the other landmarks and their subtrees are the complete population at
    // risk — and testing that population beats re-querying the whole document
    // once per selector, which costs seconds per query at this page size.
    const outsideHeader = [...document.querySelectorAll('nav')]
      .filter((nav) => nav !== header && !header.contains(nav))
      .flatMap((nav) => [nav, ...nav.querySelectorAll('*')]);

    for (const selector of navSelectors) {
      for (const element of outsideHeader) {
        assert.ok(
          !element.matches(selector),
          `critical CSS selector "${selector}" also matches <${element.tagName.toLowerCase()} `
          + `${element.getAttribute('aria-label') ?? element.className}> outside the header nav — `
          + 'these rules are unlayered, so scope them to the header marker instead of the bare `nav` element'
        );
      }
    }

    await window.happyDOM.close();
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
      .filter((entry) => !entry.source.endsWith('.md'))
      .filter((entry) => entry.headers?.some((header) => corsHeaderKeys.has(header.key.toLowerCase())))
      .map((entry) => entry.source);

    assert.deepEqual(
      apiCorsRules,
      [],
      'JSON API CORS must be emitted by handlers so credentialed requests get origin-specific ACAO plus ACAC=true. Static /api/*.md twins are public agent documents and may set ACAO * in vercel.json.'
    );
  });
});

describe('docker runtime dependency guardrails', () => {
  const runtimePackage = JSON.parse(readFileSync(resolve(__dirname, '../docker/runtime-package.json'), 'utf-8'));
  const runtimeLock = JSON.parse(readFileSync(resolve(__dirname, '../docker/runtime-package-lock.json'), 'utf-8'));

  it('installs runtime node_modules from a minimal dependency stage', () => {
    assert.match(dockerfileSource, /^FROM\s+node:\d+-alpine@sha256:[a-f0-9]{64}\s+AS\s+runtime-deps$/m);
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
  const match = line?.match(/^add_header\s+\S+\s+"(.*)"\s+always;(?:\s*#.*)?$/i);
  return match?.[1].replace(/\\"/g, '"') ?? null;
};

const getNginxHeaderValue = (key) => getNginxHeaderValueFrom('docker/nginx-security-headers.conf', key);

describe('security header guardrails', () => {
  // Cases below read the prerendered public/pro/ pages, built by
  // `npm run build:pro` rather than committed (#6898): they skip in an
  // unbuilt checkout and this fails the suite when CI says it built them.
  guardProBuiltOutput();
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

  it('Permissions-Policy exposes WebMCP tools only to same-origin agents', () => {
    const policy = getHeaderValue('Permissions-Policy');
    assert.ok(
      policy.includes('tools=(self)'),
      'Dashboard/homepage Permissions-Policy must keep WebMCP same-origin',
    );
    assert.doesNotMatch(policy, /tools=\(\*\)/, 'WebMCP tools must never be exposed to every origin');
  });

  it('mirrors WebMCP origin isolation and embed denial in local development without enrolling localhost', () => {
    const pluginSource = viteConfigSource.match(
      /function webMcpDevSecurityHeadersPlugin\(\): Plugin \{[\s\S]*?\n\}/,
    )?.[0] ?? '';
    assert.ok(pluginSource, 'Vite must define the local WebMCP security-header plugin');
    assert.match(pluginSource, /res\.setHeader\('Origin-Agent-Cluster', '\?1'\)/);
    assert.match(pluginSource, /isEmbedDocument \? 'tools=\(\)' : 'tools=\(self\)'/);
    assert.doesNotMatch(pluginSource, /Origin-Trial/, 'localhost must use Chrome testing mode, not a trial token');
    assert.match(viteConfigSource, /\n\s+webMcpDevSecurityHeadersPlugin\(\),/);
    assert.match(proViteConfigSource, /'Origin-Agent-Cluster': '\?1'/);
    assert.match(proViteConfigSource, /'Permissions-Policy': 'tools=\(self\)'/);
    assert.doesNotMatch(
      proViteConfigSource,
      /Origin-Trial/,
      'the local homepage must use Chrome testing mode, not a trial token',
    );
  });

  it('keeps local suites local unless the complete production-smoke environment is present', () => {
    const deployedSha = 'a'.repeat(40);
    const matrix = [
      {
        name: 'ordinary suite',
        env: {},
        expected: {
          baseURL: 'http://127.0.0.1:4173',
          hasWebServer: true,
          testingFlag: false,
          testMatch: null,
        },
      },
      {
        name: 'strict local WebMCP suite',
        env: { WM_REQUIRE_WEBMCP: '1' },
        expected: {
          baseURL: 'http://127.0.0.1:4173',
          hasWebServer: true,
          testingFlag: true,
          testMatch: null,
        },
      },
      {
        name: 'strict local WebMCP evidence with a deployed SHA',
        env: {
          WM_REQUIRE_WEBMCP: '1',
          WM_WEBMCP_DEPLOYED_SHA: deployedSha,
        },
        expected: {
          baseURL: 'http://127.0.0.1:4173',
          hasWebServer: true,
          testingFlag: true,
          testMatch: null,
        },
      },
      {
        name: 'bounded production smoke',
        env: {
          WM_REQUIRE_WEBMCP: '1',
          WM_WEBMCP_PRODUCTION: '1',
          WM_WEBMCP_PRODUCTION_URL: 'https://www.worldmonitor.app',
          WM_WEBMCP_DEPLOYED_SHA: deployedSha,
        },
        expected: {
          baseURL: 'https://www.worldmonitor.app',
          hasWebServer: false,
          testingFlag: false,
          testMatch: '**/webmcp.spec.ts',
        },
      },
    ];

    for (const entry of matrix) {
      const probe = probePlaywrightWebMcpEnvironment(entry.env);
      assert.equal(
        probe.status,
        0,
        `${entry.name} should load playwright.config.ts:\n${probe.stderr}`,
      );
      const resolved = JSON.parse(probe.stdout.trim());
      assert.equal(resolved.baseURL, entry.expected.baseURL, `${entry.name} baseURL`);
      assert.equal(resolved.hasWebServer, entry.expected.hasWebServer, `${entry.name} webServer`);
      assert.equal(resolved.testMatch, entry.expected.testMatch, `${entry.name} testMatch`);
      assert.equal(
        resolved.launchArgs.includes('--enable-features=WebMCPTesting'),
        entry.expected.testingFlag,
        `${entry.name} testing flag`,
      );
    }
  });

  it('rejects every incomplete or inconsistent WebMCP evidence environment', () => {
    const deployedSha = 'b'.repeat(40);
    const matrix = [
      {
        name: 'URL without production mode',
        env: { WM_WEBMCP_PRODUCTION_URL: 'https://www.worldmonitor.app' },
        error: /WM_WEBMCP_PRODUCTION_URL requires WM_WEBMCP_PRODUCTION=1/,
      },
      {
        name: 'local SHA without strict WebMCP mode',
        env: { WM_WEBMCP_DEPLOYED_SHA: deployedSha },
        error: /WM_WEBMCP_DEPLOYED_SHA requires WM_REQUIRE_WEBMCP=1 outside production mode/,
      },
      {
        name: 'explicit local mode with a remote URL',
        env: {
          WM_WEBMCP_PRODUCTION: '0',
          WM_WEBMCP_PRODUCTION_URL: 'https://www.worldmonitor.app',
        },
        error: /WM_WEBMCP_PRODUCTION_URL requires WM_WEBMCP_PRODUCTION=1/,
      },
      {
        name: 'strict local mode with a malformed deployed SHA',
        env: {
          WM_REQUIRE_WEBMCP: '1',
          WM_WEBMCP_DEPLOYED_SHA: 'not-a-sha',
        },
        error: /WM_WEBMCP_DEPLOYED_SHA must record an exact 40-character hexadecimal SHA/,
      },
      {
        name: 'strict local mode with an empty deployed SHA',
        env: {
          WM_REQUIRE_WEBMCP: '1',
          WM_WEBMCP_DEPLOYED_SHA: '',
        },
        error: /WM_WEBMCP_DEPLOYED_SHA must record an exact 40-character hexadecimal SHA/,
      },
      {
        name: 'strict local mode with a whitespace-only deployed SHA',
        env: {
          WM_REQUIRE_WEBMCP: '1',
          WM_WEBMCP_DEPLOYED_SHA: '   ',
        },
        error: /WM_WEBMCP_DEPLOYED_SHA must record an exact 40-character hexadecimal SHA/,
      },
      {
        name: 'production mode without strict WebMCP mode',
        env: {
          WM_WEBMCP_PRODUCTION: '1',
          WM_WEBMCP_PRODUCTION_URL: 'https://www.worldmonitor.app',
          WM_WEBMCP_DEPLOYED_SHA: deployedSha,
        },
        error: /WM_WEBMCP_PRODUCTION=1 requires WM_REQUIRE_WEBMCP=1/,
      },
      {
        name: 'production mode without a URL',
        env: {
          WM_REQUIRE_WEBMCP: '1',
          WM_WEBMCP_PRODUCTION: '1',
          WM_WEBMCP_DEPLOYED_SHA: deployedSha,
        },
        error: /WM_WEBMCP_PRODUCTION_URL must be https:\/\/www\.worldmonitor\.app/,
      },
      {
        name: 'production mode with a different URL',
        env: {
          WM_REQUIRE_WEBMCP: '1',
          WM_WEBMCP_PRODUCTION: '1',
          WM_WEBMCP_PRODUCTION_URL: 'https://tech.worldmonitor.app',
          WM_WEBMCP_DEPLOYED_SHA: deployedSha,
        },
        error: /WM_WEBMCP_PRODUCTION_URL must be https:\/\/www\.worldmonitor\.app/,
      },
      {
        name: 'production mode without a deployed SHA',
        env: {
          WM_REQUIRE_WEBMCP: '1',
          WM_WEBMCP_PRODUCTION: '1',
          WM_WEBMCP_PRODUCTION_URL: 'https://www.worldmonitor.app',
        },
        error: /WM_WEBMCP_DEPLOYED_SHA must record the exact 40-character SHA/,
      },
      {
        name: 'production mode with a malformed deployed SHA',
        env: {
          WM_REQUIRE_WEBMCP: '1',
          WM_WEBMCP_PRODUCTION: '1',
          WM_WEBMCP_PRODUCTION_URL: 'https://www.worldmonitor.app',
          WM_WEBMCP_DEPLOYED_SHA: 'not-a-sha',
        },
        error: /WM_WEBMCP_DEPLOYED_SHA must record the exact 40-character SHA/,
      },
    ];

    for (const entry of matrix) {
      const probe = probePlaywrightWebMcpEnvironment(entry.env);
      assert.notEqual(probe.status, 0, `${entry.name} must fail closed`);
      assert.match(`${probe.stdout}\n${probe.stderr}`, entry.error, entry.name);
    }
  });

  it('runs strict WebMCP invocation and iframe probes in an enabled Chrome milestone', () => {
    const script = packageJson.scripts?.['test:e2e:webmcp'] ?? '';
    const productionScript = packageJson.scripts?.['test:e2e:webmcp:production'] ?? '';
    const variantSmokeJob = testWorkflowSource.match(
      /\n  variant-smoke-full:\n[\s\S]*?(?=\n  [a-z][a-z0-9-]+:\n|$)/,
    )?.[0] ?? '';
    assert.match(script, /WM_REQUIRE_WEBMCP=1/);
    assert.match(script, /e2e\/webmcp\.spec\.ts/);
    assert.match(script, /e2e\/embed\.spec\.ts/);
    assert.match(script, /--project=chromium/);
    assert.match(productionScript, /WM_REQUIRE_WEBMCP=1/);
    assert.match(productionScript, /WM_WEBMCP_PRODUCTION=1/);
    assert.match(productionScript, /e2e\/webmcp\.spec\.ts/);
    assert.match(productionScript, /--headed/);
    assert.ok(variantSmokeJob, 'Test workflow must define the full-variant smoke job');
    assert.match(
      variantSmokeJob,
      /run: npm run test:e2e:webmcp/,
      'PR CI must fail when the strict WebMCP iframe probe fails or is unavailable',
    );
    assert.match(playwrightConfigSource, /process\.env\.WM_REQUIRE_WEBMCP === '1'/);
    assert.match(playwrightConfigSource, /process\.env\.WM_WEBMCP_CHROME_EXECUTABLE_PATH/);
    assert.match(playwrightConfigSource, /channel: webMcpChromeChannel/);
    assert.match(playwrightConfigSource, /executablePath: webMcpChromeExecutablePath/);
    assert.match(playwrightConfigSource, /--enable-features=WebMCPTesting/);
    assert.match(playwrightConfigSource, /requireWebMcp && !webMcpProduction/);
    assert.match(playwrightConfigSource, /https:\/\/www\.worldmonitor\.app/);
    assert.match(playwrightConfigSource, /WM_WEBMCP_DEPLOYED_SHA/);
    assert.match(webMcpE2eSource, /document\.modelContext/);
    assert.match(webMcpE2eSource, /\.getTools\(\)/);
    assert.match(webMcpE2eSource, /provider\.executeTool/);
    assert.match(webMcpE2eSource, /new AbortController\(\)/);
    assert.match(webMcpE2eSource, /page\.on\('pageerror'/);
    assert.match(webMcpE2eSource, /window\.addEventListener\('unhandledrejection'/);
    assert.match(webMcpE2eSource, /lateLeakWindowMs/);
    assert.match(webMcpE2eSource, /headers\['origin-trial'\]/);
    assert.match(embedE2eSource, /WEBMCP_MIN_CHROME_MAJOR = 149/);
    assert.match(embedE2eSource, /WM_REQUIRE_WEBMCP requires Chrome/);
  });

  it('origin-keys only the intended production web origins', () => {
    const rules = vercelConfig.headers.filter((entry) =>
      entry.headers?.some((header) => header.key.toLowerCase() === 'origin-agent-cluster')
    );
    assert.equal(rules.length, 1, 'Expected one reviewable Origin-Agent-Cluster rule');
    const [rule] = rules;
    assert.equal(rule.source, '/(.*)', 'Origin-Agent-Cluster must be consistent across each enrolled origin');
    assert.deepEqual(rule.has, [{ type: 'host', value: WEBMCP_PRODUCTION_HOST_PATTERN }]);
    assert.equal(
      rule.headers.find((header) => header.key.toLowerCase() === 'origin-agent-cluster')?.value,
      '?1',
    );
    assert.ok(!rule.has[0].value.includes('vercel'), 'Preview deployments must not be origin-trial candidates');
    assert.equal(getNginxHeaderValue('Origin-Agent-Cluster'), '?1');
    assert.equal(
      getNginxHeaderValueFrom('docker/nginx-embed-security-headers.conf', 'Origin-Agent-Cluster'),
      '?1',
      'Embedded documents must keep the same origin-keying opt-in while tools=() denies WebMCP',
    );

    const sidecarLocationBlocks = [...dockerNginxSource.matchAll(/^ {4}location [^{]+\{\n([\s\S]*?)^ {4}\}/gm)];
    assert.ok(sidecarLocationBlocks.length > 0, 'docker/nginx.conf must define route locations');
    for (const [locationBlock] of sidecarLocationBlocks) {
      const location = locationBlock.match(/^ {4}location ([^{]+)\{/)?.[1].trim() ?? '<unknown>';
      assert.match(
        locationBlock,
        /add_header Origin-Agent-Cluster "\?1" always;/,
        `docker/nginx.conf ${location} must preserve origin-keying on direct navigations`,
      );
    }

    const nginxTemplate = readFileSync(resolve(__dirname, '../docker/nginx.conf.template'), 'utf-8');
    const frontendLocationBlocks = [...nginxTemplate.matchAll(/^ {4}location [^{]+\{\n([\s\S]*?)^ {4}\}/gm)];
    assert.ok(frontendLocationBlocks.length > 0, 'docker/nginx.conf.template must define route locations');
    for (const [locationBlock] of frontendLocationBlocks) {
      const location = locationBlock.match(/^ {4}location ([^{]+)\{/)?.[1].trim() ?? '<unknown>';
      assert.match(
        locationBlock,
        /include \/etc\/nginx\/(?:embed_)?security_headers\.conf;/,
        `docker/nginx.conf.template ${location} must include an origin-keying header set`,
      );
    }
  });

  it('enrolls only eligible production pages with exact-origin WebMCP trial tokens', () => {
    const rules = vercelConfig.headers.filter((entry) =>
      entry.headers?.some((header) => header.key.toLowerCase() === 'origin-trial')
    );
    assert.equal(rules.length, WEBMCP_PRODUCTION_HOSTS.length * 3);

    for (const host of WEBMCP_PRODUCTION_HOSTS) {
      const hostPattern = '^' + host.replaceAll('.', '\\.') + '$';
      const hostRules = rules.filter((rule) =>
        rule.has?.some((condition) => condition.type === 'host' && condition.value === hostPattern)
      );
      assert.deepEqual(
        hostRules.map((rule) => rule.source).sort(),
        ['/', '/dashboard', '/dashboard.html'],
        host + ' must enroll the homepage, canonical dashboard, and direct dashboard document',
      );
      const rootRule = hostRules.find((rule) => rule.source === '/');
      assert.ok(rootRule, host + ' must define a homepage origin-trial rule');
      assert.deepEqual(
        rootRule.missing,
        [{ type: 'query', key: 'mode', value: 'agent' }],
        host + ' must exclude the /?mode=agent JSON representation from enrollment',
      );
      assert.equal(headerRuleMatchesRequest(rootRule, { path: '/', host }), true);
      assert.equal(headerRuleMatchesRequest(rootRule, { path: '/', host, query: { mode: 'reader' } }), true);
      assert.equal(
        headerRuleMatchesRequest(rootRule, { path: '/', host, query: { mode: 'agent' } }),
        false,
        host + ' must not attach an Origin-Trial token to /?mode=agent',
      );
      assert.equal(
        hostRules.some((rule) => headerRuleMatchesRequest(rule, { path: '/dashboard', host })),
        true,
        host + ' must enroll the canonical dashboard route',
      );
      assert.equal(
        hostRules.some((rule) => headerRuleMatchesRequest(rule, { path: '/dashboard.html', host })),
        true,
        host + ' must enroll the directly navigable dashboard document',
      );
      const tokens = new Set(hostRules.map((rule) =>
        rule.headers.find((header) => header.key.toLowerCase() === 'origin-trial')?.value
      ));
      assert.equal(tokens.size, 1, host + ' must use one token consistently across eligible routes');
      const [token] = tokens;
      assert.ok(token && !token.includes('REPLACE_WITH'), host + ' must not ship a placeholder token');

      const payload = decodeOriginTrialTokenPayload(token);
      assert.deepEqual(
        Object.keys(payload).sort(),
        ['expiry', 'feature', 'origin'],
        host + ' token must not carry subdomain, third-party, or usage-restriction scope',
      );
      assert.equal(payload.origin, 'https://' + host + ':443');
      assert.equal(payload.feature, 'WebMCP');
      assert.equal(payload.expiry, WEBMCP_TRIAL_EXPIRY);
      assert.ok(
        payload.expiry > Math.floor(Date.now() / 1000) + WEBMCP_TOKEN_RENEWAL_BUFFER_SECONDS,
        host + ' WebMCP token expires within 14 days; renew it or remove the completed trial enrollment',
      );
      assert.equal(
        createHash('sha256').update(token).digest('hex'),
        WEBMCP_TOKEN_SHA256_BY_HOST[host],
        host + ' complete signed token must match its independently pinned digest',
      );
    }

    assert.equal(
      new Set(rules.map((rule) =>
        rule.headers.find((header) => header.key.toLowerCase() === 'origin-trial')?.value
      )).size,
      WEBMCP_PRODUCTION_HOSTS.length,
      'Each production origin must have its own exact-origin token',
    );
    assert.ok(
      rules.every((rule) => !rule.has?.some((condition) => condition.value.includes('vercel'))),
      'Preview deployments must not receive WebMCP trial tokens',
    );
    for (const request of [
      { path: '/embed', host: 'www.worldmonitor.app' },
      { path: '/embed.html', host: 'www.worldmonitor.app' },
      { path: '/docs/documentation', host: 'www.worldmonitor.app' },
      { path: '/api/health', host: 'www.worldmonitor.app' },
      { path: '/oauth/authorize', host: 'www.worldmonitor.app' },
      { path: '/dashboard', host: 'worldmonitor.app' },
      { path: '/dashboard', host: 'worldmonitor-git-main-example.vercel.app' },
    ]) {
      assert.equal(
        rules.some((rule) => headerRuleMatchesRequest(rule, request)),
        false,
        request.host + request.path + ' must remain outside the WebMCP origin trial',
      );
    }
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

  it('dashboard CSP font-src admits ZERO cross-origin sources — the CSP filter depends on it', () => {
    // This is the license for the blanket font-src suppression in src/main.ts
    // (`cspFontSrcAllowsCrossOrigin`). That filter drops EVERY cross-origin font
    // block on the reasoning that this policy admits none, so such a block can
    // only be an injected stylesheet. It replaced sixteen host-pinned rules that
    // each re-derived the same premise (WORLDMONITOR-TR rounds 1-9).
    //
    // If the app ever adopts a cross-origin font host, this assertion fails
    // FIRST — before the filter silently starts hiding a real regression. The
    // fix then is to feed the real policy into the filter, not to delete this.
    const surfaces = [
      ['vercel', getHeaderValue('Content-Security-Policy')],
      ['docker/nginx', getNginxHeaderValue('Content-Security-Policy')],
    ];
    for (const [label, csp] of surfaces) {
      const tokens = getCspDirectiveTokens(csp, 'font-src');
      assert.ok(tokens.length > 0, `${label} must declare an explicit font-src`);
      const crossOrigin = tokens.filter(
        (token) => !/^'[^']*'$/.test(token) && !/^(?:data|blob):$/.test(token),
      );
      assert.deepEqual(
        crossOrigin,
        [],
        `${label} font-src must admit no cross-origin source (found: ${crossOrigin.join(', ')}). ` +
          'src/main.ts suppresses all cross-origin font-src violations on the strength of this; ' +
          'adopting a remote font host requires revisiting that filter in the same change.',
      );
    }
  });

  it('CSP script-src includes wasm-unsafe-eval for WebAssembly support', () => {
    const csp = getHeaderValue('Content-Security-Policy');
    const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    assert.ok(scriptSrc.includes("'wasm-unsafe-eval'"), 'CSP script-src must include wasm-unsafe-eval for WASM support');
    assert.ok(scriptSrc.includes("'self'"), 'CSP script-src must include self');
  });

  // Split deliberately (#6898). The exact-set assertion below needs EVERY file
  // in the list, including the two built /pro pages, so it has to be gated. But
  // five of the seven are committed HTML that has nothing to do with /pro, and
  // gating the whole case dropped their CSP coverage in any checkout without a
  // /pro build. This subset half keeps that coverage unconditional: every inline
  // script in a committed file must already be trusted by the header CSP.
  it('CSP script-src trusts every un-nonced inline script in committed HTML', () => {
    const csp = getHeaderValue('Content-Security-Policy');
    const scriptHashTokens = getCspDirectiveTokens(csp, 'script-src')
      .filter((token) => token.startsWith("'sha256-"));
    const committedFiles = GLOBAL_CSP_INLINE_SCRIPT_HTML_FILES
      .filter((file) => !file.startsWith('public/pro/'));
    assert.ok(
      committedFiles.length > 0,
      'committed-HTML population is empty — this guard would pass vacuously',
    );
    const committedHashTokens = [...new Set(committedFiles.flatMap((file) => {
      const html = readFileSync(resolve(__dirname, '..', file), 'utf-8');
      return getInlineScriptHashTokens(html);
    }))].sort();
    assert.ok(committedHashTokens.length > 0, 'expected inline scripts in committed HTML');
    const untrusted = committedHashTokens.filter((token) => !scriptHashTokens.includes(token));
    assert.deepEqual(
      untrusted,
      [],
      'committed HTML ships un-nonced inline scripts the header CSP does not trust: ' +
        committedFiles.join(', ')
    );
  });

  it('CSP script-src hashes exactly match un-nonced inline scripts served under the global CSP', { skip: shouldSkipProBuiltOutput() }, () => {
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
      'CSP script-src hashes must be the exact set required by un-nonced deployed HTML scripts: ' +
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

  // Per-file assertions, so the built /pro pages drop out of the population
  // rather than taking the five committed files down with them (#6898).
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

    const externalScriptFiles = withoutUnbuiltProPaths(GLOBAL_CSP_EXTERNAL_SCRIPT_HTML_FILES);
    assert.ok(
      externalScriptFiles.length > 0,
      'external-script HTML population is empty — this guard would pass vacuously',
    );
    for (const file of externalScriptFiles) {
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

  it('CSP frame-src stays a bounded host allowlist (load-bearing for a Sentry suppression rule)', () => {
    // `shouldSuppressCspViolation` in src/main.ts discards frame-src violation
    // reports for `div.show` on the argument that frame-src enumerates every
    // host we embed, so a host we never reference can only have been injected
    // from outside. That argument holds only while the directive stays a closed
    // allowlist -- adding a scheme-wide or wildcard source would make foreign
    // frames legal, and the suppression would then be hiding a real policy
    // change rather than third-party noise. The existing frame-src tests pin
    // that Clerk is PRESENT and that the deploy surfaces agree; neither would
    // fail on a widening, so this pins the property the suppression depends on.
    for (const [label, csp] of [
      ['vercel.json', getHeaderValue('Content-Security-Policy')],
      ['docker/nginx', getNginxHeaderValue('Content-Security-Policy')],
    ]) {
      assert.ok(csp, `${label} must have a Content-Security-Policy header`);
      const tokens = getCspDirectiveTokens(csp, 'frame-src');
      assert.ok(tokens.length > 0, `${label} must declare an explicit frame-src`);
      const open = findOpenFrameSources(tokens);
      assert.deepEqual(open, [],
        `${label} frame-src must stay a bounded host allowlist; found open source(s): ${open.join(', ')}. ` +
        'The div.show suppression in src/main.ts assumes any non-allowlisted frame is third-party injection.');
    }
  });

  it('the frame-src allowlist guard actually fires on a widening', () => {
    // The first version of this guard tested `token.startsWith('*.')`, which can
    // never match: getCspDirectiveTokens returns tokens WITH their scheme
    // (`https://*.vercel.app`). It therefore passed while dead. Drive the
    // predicate directly against widenings written the way they'd really appear.
    for (const widened of [
      'https://*.evil.com',   // a new vendor wildcard
      'https://*',            // scheme-wide with a wildcard host
      'http://*.evil.com',
      '*',
      'https:',
      '*.evil.com',           // scheme-less
    ]) {
      assert.deepEqual(findOpenFrameSources([widened]), [widened],
        `guard must flag ${widened} as an open frame-src source`);
    }
    // ...and must stay quiet on the bounded sources the policy legitimately has.
    assert.deepEqual(
      findOpenFrameSources(["'self'", 'https://www.worldmonitor.app', ...KNOWN_FRAME_WILDCARDS]),
      []
    );
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

  it('rewrites /embed to the dedicated embed.html entry', () => {
    // #6575: the SPA catch-all this rule used to precede is gone; the explicit
    // /embed rewrite only needs to beat filesystem resolution, which it does.
    const rewrite = vercelConfig.rewrites.find((r) => r.source === '/embed');
    assert.ok(rewrite, 'expected /embed rewrite');
    assert.equal(rewrite.destination, '/embed.html');
  });

  it('keeps /embed and /embed.html off the dashboard document and the SPA cache header', () => {
    // #6575: no dashboard-serving rewrite may match the public embed entry.
    for (const path of ['/embed', '/embed.html']) {
      const shadow = vercelConfig.rewrites.find((r) =>
        r.destination === DASHBOARD_HTML_DESTINATION && sourceToRegExp(r.source).test(path)
      );
      assert.equal(shadow, undefined, path + ' must serve the public embed entry, not the app shell');
    }
    assert.ok(SPA_HTML_CACHE_SOURCE.includes('|embed|embed\\.html|'), 'HTML cache catch-all must keep excluding the public embed entry');
    assert.equal(getCacheHeaderValue(SPA_HTML_CACHE_SOURCE), 'private, no-cache, must-revalidate');
  });

  it('keeps the global security header anti-framing rule off the embed entries', () => {
    // Both /embed (partner iframe) and /wm-widget-sandbox.html (agent widget
    // sandbox) need cross-origin framing + their own dedicated CSP; the
    // global SAMEORIGIN/dashboard-CSP rule must skip both.
    assert.equal(GLOBAL_SECURITY_HEADER_SOURCE, '/((?!docs|embed|embed\\.html|wm-widget-sandbox\\.html).*)');
    const globalXfo = getHeaderValueForSource(GLOBAL_SECURITY_HEADER_SOURCE, 'X-Frame-Options');
    assert.equal(globalXfo, 'SAMEORIGIN');
  });

  it('/wm-widget-sandbox.html keeps its dedicated headers instead of inheriting app XFO/CSP', () => {
    const source = '/wm-widget-sandbox.html';
    assert.equal(
      sourceToRegExp(GLOBAL_SECURITY_HEADER_SOURCE).test(source),
      false,
      `${source} must not match the global security-header rule`,
    );
    assert.equal(getHeaderValueForSource(source, 'X-Frame-Options'), null);
    assert.match(getHeaderValueForSource(source, 'Content-Security-Policy') ?? '', /default-src 'none'/);
  });

  for (const source of ['/embed', '/embed.html']) {
    it(`${source} allows cross-origin iframe embedding without inheriting app XFO`, () => {
      const headers = getHeadersForSource(source);
      assert.ok(headers.length > 0, `${source} must have an explicit header rule`);
      assert.equal(getHeaderValueForSource(source, 'X-Frame-Options'), null);
      assert.equal(getHeaderValueForSource(source, 'Cache-Control'), 'private, no-cache, must-revalidate');
      const csp = getHeaderValueForSource(source, 'Content-Security-Policy');
      const permissionsPolicy = getHeaderValueForSource(source, 'Permissions-Policy');
      assert.ok(csp, `${source} must have a CSP`);
      assert.ok(permissionsPolicy?.includes('tools=()'), `${source} must explicitly deny WebMCP tools`);
      assert.ok(!permissionsPolicy?.includes('tools=(self)'), `${source} must not expose same-origin WebMCP tools`);
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
      'tools=()',
    ]) {
      assert.ok(dockerLockedPolicy.includes(directive), `Docker embed policy must keep ${directive}`);
    }

    const dockerEmbedCsp = getNginxHeaderValueFrom('docker/nginx-embed-security-headers.conf', 'Content-Security-Policy');
    assert.equal(dockerEmbedCsp, getHeaderValueForSource('/embed', 'Content-Security-Policy'));
  });

  it('serves /embed.js as a cross-origin loader without iframe CSP', () => {
    assert.equal(getHeaderValueForSource('/embed.js', 'Access-Control-Allow-Origin'), '*');
    assert.equal(getHeaderValueForSource('/embed.js', 'Cache-Control'), 'public, max-age=3600');
    assert.equal(getHeaderValueForSource('/embed.js', 'Cross-Origin-Resource-Policy'), 'cross-origin');
    assert.equal(getHeaderValueForSource('/embed.js', 'Content-Security-Policy'), null);
    assert.equal(getHeaderValueForSource('/embed.js', 'X-Frame-Options'), null);

    const nginxTemplate = readFileSync(resolve(__dirname, '../docker/nginx.conf.template'), 'utf-8');
    assert.match(nginxTemplate, /location = \/embed\.js \{[\s\S]*?Access-Control-Allow-Origin "\*"/);
    assert.match(dockerNginxSource, /location = \/embed\.js \{[\s\S]*?Access-Control-Allow-Origin "\*"/);
    assert.doesNotMatch(
      dockerNginxSource.match(/location = \/embed\.js \{[\s\S]*?\n    \}/)?.[0] ?? '',
      /frame-ancestors/,
    );
  });

  it('self-hosted docker/nginx.conf SPA fallback ships the full dashboard CSP', () => {
    // Image A (root Dockerfile -> docker/nginx.conf, nginx + Node API under
    // supervisord) inlines headers per location instead of including
    // security_headers.conf. The SPA fallback (location /) must still carry the
    // dashboard CSP, or the containerized dashboard runs CSP-less while /embed
    // stays locked down.
    const canonicalCsp = getNginxHeaderValue('Content-Security-Policy');
    assert.ok(canonicalCsp, 'docker/nginx-security-headers.conf must define a dashboard CSP');

    const block = dockerNginxSource.match(/\n {4}location \/ \{\n([\s\S]*?)\n {4}\}/);
    assert.ok(block, 'docker/nginx.conf must define a location / block');
    const cspLine = block[1]
      .split('\n')
      .find((line) => /add_header Content-Security-Policy "/.test(line));
    assert.ok(cspLine, 'docker/nginx.conf location / must ship a Content-Security-Policy header');
    const value = cspLine.match(/add_header Content-Security-Policy "(.*)" always;/)?.[1];
    assert.ok(value, 'could not extract CSP value from docker/nginx.conf location / Content-Security-Policy line');
    assert.equal(
      value,
      canonicalCsp,
      'docker/nginx.conf location / CSP must match docker/nginx-security-headers.conf (and thus vercel.json)',
    );
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
//       matching removal of the build step;
//   (4) linkset[0] losing its RFC 9727 `item` enumeration (agent
//       crawlers read the catalog anchor's item links to find every API).
describe('agent readiness: api-catalog + openapi build', () => {
  const apiCatalog = JSON.parse(
    readFileSync(resolve(__dirname, '../public/.well-known/api-catalog'), 'utf-8')
  );
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));

  const catalogEntry = apiCatalog.linkset[0];
  const apiEntry = apiCatalog.linkset.find((entry) => entry.anchor === 'https://api.worldmonitor.app/');

  it('linkset[0] is the catalog anchor and enumerates each API via RFC 9727 item links', () => {
    assert.equal(catalogEntry.anchor, 'https://worldmonitor.app/.well-known/api-catalog');
    assert.ok(Array.isArray(catalogEntry.item), 'linkset[0] must carry an "item" array (RFC 9727 §4)');
    assert.ok(catalogEntry.item.length > 0, 'linkset[0].item must enumerate at least one API');
    // Each item MUST resolve to a linkset context object that describes that API.
    const anchors = new Set(apiCatalog.linkset.map((entry) => entry.anchor));
    for (const item of catalogEntry.item) {
      assert.ok(item.href, 'each item entry must carry an href');
      assert.ok(
        anchors.has(item.href),
        `item href ${item.href} must match a linkset context anchor`
      );
    }
    const itemHrefs = catalogEntry.item.map((i) => i.href);
    assert.ok(itemHrefs.includes('https://api.worldmonitor.app/'), 'item list must enumerate the REST API host root');
    assert.ok(itemHrefs.includes('https://worldmonitor.app/mcp'), 'item list must enumerate the MCP server');
    assert.ok(
      itemHrefs.includes('https://www.worldmonitor.app/docs/mcp'),
      'item list must enumerate the docs MCP server (#4958 — it ran unadvertised for weeks)'
    );
  });

  // #4958 — Mintlify serves a working docs MCP server (search/retrieval over
  // the documentation) at /docs/mcp; it existed for weeks with zero
  // advertisement anywhere. Every agent-facing discovery surface must name it
  // so multi-surface MCP coverage is discoverable.
  it('advertises the docs MCP server on every discovery surface', () => {
    const docsMcpUrl = 'https://www.worldmonitor.app/docs/mcp';
    for (const surface of ['llms.txt', 'agents.md', 'api/llms.txt']) {
      const content = readFileSync(resolve(__dirname, `../public/${surface}`), 'utf-8');
      assert.ok(content.includes(docsMcpUrl), `public/${surface} must advertise the docs MCP server`);
    }
  });

  it('the docs MCP anchor describes itself with the first-party server-card (service-desc parity with product MCP)', () => {
    const docsAnchor = apiCatalog.linkset.find((e) => e.anchor === 'https://www.worldmonitor.app/docs/mcp');
    assert.ok(docsAnchor, 'api-catalog must carry a context object anchored at the docs MCP endpoint');
    const desc = docsAnchor['service-desc'] ?? [];
    // Must be the first-party card, NOT Mintlify's card (whose url 404s) — #4964 review.
    assert.ok(
      desc.some((d) => d.href === 'https://www.worldmonitor.app/.well-known/mcp/docs-server-card.json'),
      'docs MCP anchor must advertise the first-party server-card as service-desc'
    );
    assert.ok(
      !desc.some((d) => /\/docs\/\.well-known\/mcp\/server-card\.json/.test(d.href)),
      'docs MCP anchor must NOT advertise Mintlify\'s card (its url points at a dead mintlify.dev endpoint)'
    );
  });

  it('the first-party docs server-card advertises the working /docs/mcp endpoint, not the dead mintlify url', () => {
    // The whole point of #4964's fix: a card-following agent must land on an
    // endpoint that actually initializes. worldmonitor.mintlify.dev/mcp 404s;
    // www.worldmonitor.app/docs/mcp returns 200. The committed card must carry
    // the working facade URL and must not smuggle the mintlify.dev host.
    const card = JSON.parse(
      readFileSync(resolve(__dirname, '../public/.well-known/mcp/docs-server-card.json'), 'utf-8')
    );
    const WORKING = 'https://www.worldmonitor.app/docs/mcp';
    assert.equal(card.url, WORKING, 'docs card url must be the working /docs/mcp facade');
    assert.equal(card.serverUrl, WORKING, 'docs card serverUrl must be the working /docs/mcp facade');
    assert.ok(
      !JSON.stringify({ url: card.url, serverUrl: card.serverUrl }).includes('mintlify.dev'),
      'docs card endpoint fields must not point at the dead mintlify.dev host'
    );
    assert.ok(Array.isArray(card.tools) && card.tools.length >= 1, 'docs card must list at least one tool');
  });

  it('the api host root has its own context object', () => {
    assert.ok(apiEntry, 'linkset must contain a context object anchored at https://api.worldmonitor.app/');
  });

  it('status href points at the KEYLESS compact form of /api/health', () => {
    // Two drift classes guarded here:
    //   (1) the SPA lives at /health — a bare-host href would 200 HTML and
    //       look healthy;
    //   (2) #4715 gated detailed /api/health behind an operator key, so the
    //       bare endpoint 401s keyless callers. An advertised status URL must
    //       return 2xx WITHOUT credentials — that is ?compact=1 (#4856; an
    //       agent-journey run read the stale bare-URL advertisement, got 401,
    //       and flagged the whole status surface as broken).
    const statusHref = apiEntry.status[0].href;
    assert.ok(
      statusHref.startsWith('https://api.worldmonitor.app'),
      `status href must be on api.worldmonitor.app, got: ${statusHref}`
    );
    assert.equal(
      statusHref,
      'https://api.worldmonitor.app/api/health?compact=1',
      'status href must be the keyless compact health form'
    );
  });

  it('every vercel.json Link rel="status" advertisement uses the keyless compact form', () => {
    // Same #4715→#4856 drift class as above, for the Link-header copies: an
    // auth-gating change on /api/health must not silently strand the
    // machine-readable status advertisements on a URL that 401s keyless.
    const vercelRaw = readFileSync(resolve(__dirname, '../vercel.json'), 'utf-8');
    const statusLinks = vercelRaw.match(/<[^>]*>;\s*rel=\\"status\\"/g) ?? [];
    assert.ok(statusLinks.length > 0, 'expected at least one Link rel="status" advertisement in vercel.json');
    for (const link of statusLinks) {
      assert.ok(
        link.startsWith('</api/health?compact=1>'),
        `Link rel="status" must point at /api/health?compact=1 (keyless), got: ${link}`
      );
    }
  });

  it('service-meta advertises the machine-readable pricing + support surfaces', () => {
    // Pricing/support were previously discoverable ONLY via llms.txt; agents
    // entering through the Link-header → api-catalog chain never saw them and
    // fell back to slug-guessing (#4854, #4857). RFC 9727 allows arbitrary
    // link relations on a context object; service-meta is the metadata slot.
    const meta = apiEntry['service-meta'];
    assert.ok(Array.isArray(meta) && meta.length > 0, 'api context must carry service-meta entries');
    const hrefs = meta.map((entry) => entry.href);
    assert.ok(hrefs.includes('https://worldmonitor.app/pricing.md'), 'service-meta must advertise pricing.md');
    assert.ok(
      hrefs.includes('https://www.worldmonitor.app/api/product-catalog'),
      'service-meta must advertise the live product-catalog JSON endpoint'
    );
    assert.ok(hrefs.includes('https://worldmonitor.app/support.md'), 'service-meta must advertise support.md');
    assert.ok(hrefs.includes('https://worldmonitor.app/agents.md'), 'service-meta must advertise agents.md (#4952)');
    // The Commerce spec lives outside the root openapi bundle (size budget,
    // #4853) — without this link no advertised descriptor reaches it
    // (post-#4867 review finding); Mintlify serves the raw YAML at this URL.
    const commerceSpec = meta.find(
      (entry) => entry.href === 'https://www.worldmonitor.app/docs/openapi/CommerceService.openapi.yaml'
    );
    assert.ok(commerceSpec, 'service-meta must link the Commerce OpenAPI spec');
    assert.equal(commerceSpec.type, 'application/vnd.oai.openapi');
  });

  it('service-desc points at /openapi.yaml with the OpenAPI media type', () => {
    const serviceDesc = apiEntry['service-desc'][0];
    assert.ok(
      serviceDesc.href.endsWith('/openapi.yaml'),
      `service-desc href must end with /openapi.yaml, got: ${serviceDesc.href}`
    );
    assert.equal(serviceDesc.type, 'application/vnd.oai.openapi');
  });

  it('also advertises a JSON service-desc at /openapi.json for JSON-only parsers', () => {
    // Some agent-readiness scanners (ora.ai / orank) run the spec straight
    // through a JSON parser; YAML input trips them ("found but failed to
    // parse"). The JSON mirror is a second service-desc so those scanners
    // have a parseable spec. YAML stays at [0] (human-readable canonical).
    // Read from apiEntry (the api.worldmonitor.app context object), not
    // linkset[0] — since #4691 added the RFC 9727 catalog anchor, linkset[0]
    // is the catalog itself (item enumeration, no service-desc). The sibling
    // /openapi.yaml assertion above already uses apiEntry for the same reason.
    const jsonDesc = apiEntry['service-desc'][1];
    assert.ok(jsonDesc, 'api anchor must have a second service-desc entry (JSON mirror)');
    assert.ok(
      jsonDesc.href.endsWith('/openapi.json'),
      `second service-desc href must end with /openapi.json, got: ${jsonDesc.href}`
    );
    assert.equal(jsonDesc.type, 'application/json');
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

  it('exposes a build:openapi script that copies docs/api → public/openapi.yaml AND emits public/openapi.json', () => {
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
    // The JSON mirror (served at /openapi.json for JSON-only scanners) is
    // generated by scripts/build-openapi-json.mjs in the same step.
    assert.ok(
      buildOpenapi.includes('build-openapi-json.mjs'),
      `build:openapi must run scripts/build-openapi-json.mjs to emit public/openapi.json, got: ${buildOpenapi}`
    );
    assert.ok(
      existsSync(resolve(__dirname, '../scripts/build-openapi-json.mjs')),
      'scripts/build-openapi-json.mjs must exist'
    );
  });

  it('no dashboard-serving rewrite can shadow the static /openapi.json spec', () => {
    // #6575: the SPA catch-all is gone, so /openapi.json resolves as a static
    // file by default. Guard that no dashboard rewrite ever matches it again
    // and that the pinned HTML-cache exclusion stays in place.
    const shadow = vercelConfig.rewrites.find((r) =>
      r.destination === DASHBOARD_HTML_DESTINATION && sourceToRegExp(r.source).test('/openapi.json')
    );
    assert.equal(shadow, undefined, '/openapi.json must serve the static spec, not the app shell');
    assert.ok(
      SPA_HTML_CACHE_SOURCE.includes('openapi'),
      'HTML cache catch-all must keep excluding openapi.json'
    );
  });

  it('every web-variant build regenerates inventory facts and OpenAPI', () => {
    // build:desktop and build:pro are intentionally excluded — Tauri
    // sidecar builds and the standalone pro-test workspace don't ship
    // the OpenAPI spec.
    const declaredVariants = variantDashboardSource
      .match(/WEB_DASHBOARD_VARIANTS\s*=\s*\[([^\]]+)\]/)?.[1]
      .match(/'[^']+'/g)
      ?.map((value) => value.slice(1, -1));
    assert.ok(declaredVariants?.length, 'WEB_DASHBOARD_VARIANTS extraction must not be empty');

    for (const variant of ['full', ...declaredVariants]) {
      const buildName = `build:${variant}`;
      const prebuildName = `prebuild:${variant}`;
      const script = pkg.scripts[buildName];
      assert.ok(script, `package.json must define scripts["${buildName}"]`);
      assert.ok(
        script.includes('npm run build:openapi'),
        `scripts["${buildName}"] must chain "npm run build:openapi" so the web bundle ships the spec; got: ${script}`
      );
      assert.equal(
        pkg.scripts[prebuildName],
        'npm run product:facts',
        `scripts["${prebuildName}"] must regenerate ignored inventory facts before ${buildName}`,
      );
    }
  });

  it('keeps a prebuild hook so the default `npm run build` path also copies the spec', () => {
    assert.ok(
      pkg.scripts.prebuild?.includes('npm run product:facts'),
      'package.json scripts["prebuild"] must regenerate ignored product and inventory facts',
    );
    assert.ok(
      pkg.scripts.prebuild?.includes('npm run build:openapi'),
      'package.json scripts["prebuild"] must copy the generated OpenAPI spec',
    );
  });

  it('does not regenerate committed product config before build:pro', () => {
    // build:pro runs in the CI unit job immediately before
    // `WM_EXPECT_BUILT_OUTPUT=1 npm run test:data` (#6898). A prebuild:pro hook
    // would fire `npm run product:facts` there and REWRITE the committed
    // generated config on disk -- and
    // tests/product-catalog-freshness.test.mjs proves freshness by reading
    // those files, re-running the generator, and diffing the two. Regenerating
    // first makes both sides identical, so a genuinely stale commit passes.
    // Verified by mutation: staling products.generated.ts fails that suite, and
    // fails it no longer once `npm run product:facts` has run first.
    //
    // Nothing needs the hook: build/build:full regenerate via
    // prebuild/prebuild:full, pro-bundle-freshness.yml has its own
    // `npm run product:facts` step, and .husky/pre-push runs
    // generate-product-config.mjs directly.
    assert.equal(
      pkg.scripts['prebuild:pro'],
      undefined,
      'package.json must NOT define scripts["prebuild:pro"] — it disarms the freshness guard in the CI unit job',
    );
  });

  it('regenerates ignored inventory facts before the Tauri desktop build', () => {
    assert.equal(
      pkg.scripts['prebuild:desktop'],
      'npm run product:facts',
      'Tauri packages api/ and public/ resources, so build:desktop must regenerate ignored facts',
    );
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

  // RFC 8414 authorization-server metadata is ALSO a dynamic edge fn (was a
  // static file at public/.well-known/oauth-authorization-server). Host
  // derivation keeps `issuer` == the origin the PRM advertises, so ora.ai/orank
  // can cross-check that PRM `authorization_servers` resolves to an AS document
  // whose `issuer` matches — while same-origin also satisfies isitagentready.
  it('oauth-authorization-server handler returns host-derived RFC 8414 metadata + WorkOS agent_auth block', async () => {
    const mod = await import('../api/oauth-authorization-server.ts');
    const handler = mod.default;
    assert.equal(typeof handler, 'function', 'handler must be the default export');

    const hosts = ['worldmonitor.app', 'www.worldmonitor.app', 'api.worldmonitor.app'];
    for (const host of hosts) {
      const req = new Request(`https://${host}/.well-known/oauth-authorization-server`, {
        headers: { host },
      });
      const res = await handler(req);
      assert.equal(res.status, 200, `status 200 for ${host}`);
      assert.equal(res.headers.get('content-type'), 'application/json', `JSON for ${host}`);
      assert.equal(res.headers.get('vary'), 'Host', `Vary: Host for ${host}`);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=3600', `cacheable for ${host}`);
      const json = await res.json();

      // RFC 8414 issuer + endpoints are all self-origin.
      assert.equal(json.issuer, `https://${host}`, `issuer matches ${host}`);
      assert.equal(json.authorization_endpoint, `https://${host}/oauth/authorize`);
      assert.equal(json.token_endpoint, `https://${host}/oauth/token`);
      assert.equal(json.registration_endpoint, `https://${host}/oauth/register`);
      assert.deepEqual(json.code_challenge_methods_supported, ['S256']);
      assert.deepEqual(json.token_endpoint_auth_methods_supported, ['none']);
      assert.deepEqual(json.scopes_supported, ['mcp']);

      // WorkOS auth.md agent_auth discovery block (only `anonymous` is honest —
      // WM has no ID-JAG identity endpoint, so identity_assertion is not advertised).
      assert.ok(json.agent_auth, `agent_auth block present for ${host}`);
      assert.equal(json.agent_auth.skill, `https://${host}/auth.md`, `skill round-trips to /auth.md for ${host}`);
      assert.equal(json.agent_auth.register_uri, `https://${host}/oauth/register`);
      assert.deepEqual(json.agent_auth.identity_types_supported, ['anonymous']);
      // Only `access_token` — an api_key is user-minted (carries a user
      // identity), so it is not an anonymous-registration credential.
      assert.deepEqual(
        json.agent_auth.anonymous.credential_types_supported,
        ['access_token'],
        `anonymous sibling block enumerates credential types for ${host}`
      );
      // The anonymous registration method requires a claim URI (readiness
      // scanners reject the method without it). Anonymous credentials are
      // claimed at authorization time, so claim_uri == the authorization
      // endpoint. Advertised both at the agent_auth top level (parallel to
      // register_uri) and inside the anonymous method object.
      assert.equal(
        json.agent_auth.claim_uri,
        `https://${host}/oauth/authorize`,
        `agent_auth.claim_uri = authorization endpoint for ${host}`
      );
      assert.equal(
        json.agent_auth.anonymous.claim_uri,
        `https://${host}/oauth/authorize`,
        `anonymous method advertises claim_uri for ${host}`
      );
    }
  });

  // The Host header is client-controlled; both discovery handlers derive their
  // origin through the shared allowlist (api/_agent-metadata.ts) so a spoofed
  // Host cannot be reflected into issuer/resource/endpoints. They also guard the
  // HTTP method (read-only docs).
  it('discovery handlers reject spoofed Host (apex fallback) and non-GET methods', async () => {
    const prm = (await import('../api/oauth-protected-resource.ts')).default;
    const as = (await import('../api/oauth-authorization-server.ts')).default;

    // Spoofed / unrecognized Host → apex fallback, never reflected.
    for (const host of ['evil.com', 'worldmonitor.app.evil.com', 'evilworldmonitor.app', 'x.y.worldmonitor.app']) {
      const prmRes = await prm(new Request('https://worldmonitor.app/.well-known/oauth-protected-resource', { headers: { host } }));
      const prmJson = await prmRes.json();
      assert.equal(prmJson.resource, 'https://worldmonitor.app', `PRM must not reflect spoofed host ${host}`);
      assert.deepEqual(prmJson.authorization_servers, ['https://worldmonitor.app']);

      const asRes = await as(new Request('https://worldmonitor.app/.well-known/oauth-authorization-server', { headers: { host } }));
      const asJson = await asRes.json();
      assert.equal(asJson.issuer, 'https://worldmonitor.app', `AS must not reflect spoofed host ${host}`);
      assert.equal(asJson.token_endpoint, 'https://worldmonitor.app/oauth/token', `AS token_endpoint must not carry spoofed host ${host}`);
      assert.equal(asJson.agent_auth.register_uri, 'https://worldmonitor.app/oauth/register');
      assert.equal(asJson.agent_auth.claim_uri, 'https://worldmonitor.app/oauth/authorize', `AS claim_uri must not carry spoofed host ${host}`);
      assert.equal(asJson.agent_auth.anonymous.claim_uri, 'https://worldmonitor.app/oauth/authorize');
    }

    // Legit subdomain still self-describes.
    const variant = await as(new Request('https://tech.worldmonitor.app/.well-known/oauth-authorization-server', { headers: { host: 'tech.worldmonitor.app' } }));
    assert.equal((await variant.json()).issuer, 'https://tech.worldmonitor.app');

    // Method guard: OPTIONS → 204 preflight, other verbs → 405 + Allow, GET → 200.
    for (const handler of [prm, as]) {
      const opt = await handler(new Request('https://worldmonitor.app/x', { method: 'OPTIONS', headers: { host: 'worldmonitor.app' } }));
      assert.equal(opt.status, 204, 'OPTIONS is a CORS preflight');
      assert.equal(opt.headers.get('access-control-allow-methods'), 'GET, HEAD, OPTIONS');

      const post = await handler(new Request('https://worldmonitor.app/x', { method: 'POST', headers: { host: 'worldmonitor.app' } }));
      assert.equal(post.status, 405, 'non-GET/HEAD is rejected');
      assert.equal(post.headers.get('allow'), 'GET, HEAD, OPTIONS');

      const get = await handler(new Request('https://worldmonitor.app/x', { headers: { host: 'worldmonitor.app' } }));
      assert.equal(get.status, 200, 'GET is served');
    }
  });

  it('vercel.json rewrites /.well-known/oauth-authorization-server to the edge fn and the static file is gone', () => {
    const rewrite = vercelConfig.rewrites.find(
      (r) => r.source === '/.well-known/oauth-authorization-server'
    );
    assert.ok(rewrite, 'expected a rewrite for /.well-known/oauth-authorization-server');
    assert.equal(rewrite.destination, '/api/oauth-authorization-server');
    // The static file MUST be deleted — Vercel serves real files before
    // rewrites, so a leftover static doc would shadow the dynamic handler.
    assert.ok(
      !existsSync(resolve(__dirname, '../public/.well-known/oauth-authorization-server')),
      'static public/.well-known/oauth-authorization-server must be removed so the edge fn is not shadowed'
    );
  });
});

// Agent readiness: a WorkOS-spec /auth.md walkthrough that agents can fetch to
// learn the registration flow, cross-linked from the AS metadata agent_auth.skill.
describe('agent readiness: auth.md walkthrough', () => {
  const authMd = readFileSync(resolve(__dirname, '../public/auth.md'), 'utf-8');

  it('publishes /auth.md with the WorkOS-prescribed sections', () => {
    for (const heading of ['Discover', 'Pick a method', 'Register', 'Claim', 'Use the credential', 'Errors', 'Revocation']) {
      assert.match(
        authMd,
        new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'm'),
        `auth.md must have a "## ${heading}" section`
      );
    }
  });

  it('references the auth.md spec and carries the spec anchor keywords', () => {
    assert.ok(authMd.includes('https://workos.com/auth-md'), 'auth.md must reference the WorkOS spec');
    for (const keyword of ['agent_auth', 'register_uri', 'claim_uri', 'identity_assertion', 'id-jag', 'WWW-Authenticate']) {
      assert.ok(authMd.includes(keyword), `auth.md must mention spec keyword: ${keyword}`);
    }
  });

  it('keeps every section header within the scanner read budget (~5 KB truncation)', () => {
    // isitagentready / ora.ai reads only the first ~5 KB of auth.md; any `## `
    // section header past that byte offset is dropped and the section reported
    // missing (regressing auth-md-structure). This has bitten us before, so
    // guard with a conservative ceiling — an edit that bloats an earlier
    // section fails HERE instead of silently regressing the live scan.
    const HEADER_BUDGET = 4800;
    let offset = 0;
    for (const line of authMd.split('\n')) {
      if (line.startsWith('## ')) {
        assert.ok(
          offset < HEADER_BUDGET,
          `"${line.trim()}" starts at byte ${offset}; must be < ${HEADER_BUDGET} to survive the ~5 KB scanner truncation`
        );
      }
      offset += Buffer.byteLength(line, 'utf8') + 1; // + the newline that split() dropped
    }
  });

  it('advertises a register endpoint that resolves (matches the agent_auth register_uri path)', () => {
    assert.match(
      authMd,
      /https:\/\/(?:api\.)?worldmonitor\.app\/oauth\/register/,
      'auth.md must document the reachable /oauth/register endpoint so the discovery chain is not stale'
    );
  });

  it('serves /auth.md as markdown, never the app shell', () => {
    assert.equal(getHeaderValueForSource('/auth.md', 'Content-Type'), 'text/markdown; charset=utf-8');
    assert.equal(getHeaderValueForSource('/auth.md', 'Access-Control-Allow-Origin'), '*');
    // #6575: the SPA catch-all rewrite is gone, so the real file is served (or
    // a deletion 404s) by default. Guard both directions.
    const dashboardShadow = (path) => vercelConfig.rewrites.find((r) =>
      r.destination === DASHBOARD_HTML_DESTINATION && sourceToRegExp(r.source).test(path)
    );
    assert.equal(dashboardShadow('/auth.md'), undefined, '/auth.md must serve the real file, not the dashboard');
    assert.ok(SPA_HTML_CACHE_SOURCE.includes('|auth\\.md|'), 'HTML cache catch-all must keep excluding /auth.md');
  });
});

// orank "Markdown URL fallback": homepage /index.md already returns markdown,
// but the scanner sampled GET /api/download as the content page and then
// requested /api/download.md. That path used to hit api/[...notfound].ts as
// JSON 404. Cloudflare Markdown for Agents cannot fill this gap — it converts
// HTML only when Accept: text/markdown, and /api/download is a 302, not HTML.
describe('agent readiness: /api/download.md URL twin', () => {
  const downloadMdPath = resolve(__dirname, '../public/api/download.md');
  const downloadMd = readFileSync(downloadMdPath, 'utf-8');

  it('publishes heading-led markdown at public/api/download.md', () => {
    assert.ok(existsSync(downloadMdPath), 'expected public/api/download.md (markdown twin of GET /api/download)');
    assert.match(downloadMd, /^# /m, '/api/download.md must open with a heading so scanners accept a non-HTML body');
    assert.match(downloadMd, /platform=windows-exe/);
    assert.match(downloadMd, /platform=macos-arm64/);
    assert.match(downloadMd, /platform=linux-appimage/);
  });

  it('serves /api/download.md as markdown with CORS and a self-canonical Link', () => {
    assert.equal(getHeaderValueForSource('/api/download.md', 'Content-Type'), 'text/markdown; charset=utf-8');
    assert.equal(getHeaderValueForSource('/api/download.md', 'Access-Control-Allow-Origin'), '*');
    assert.equal(
      getHeaderValueForSource('/api/download.md', 'Link'),
      '<https://www.worldmonitor.app/api/download.md>; rel="canonical"'
    );
  });

  it('is not rewritten to the dashboard shell', () => {
    const dashboardShadow = (path) => vercelConfig.rewrites.find((r) =>
      r.destination === DASHBOARD_HTML_DESTINATION && sourceToRegExp(r.source).test(path)
    );
    assert.equal(dashboardShadow('/api/download.md'), undefined, '/api/download.md must serve the static twin, not the dashboard');
    assert.ok(
      SPA_HTML_CACHE_SOURCE.startsWith('/((?!api|'),
      '/api/* (including /api/download.md) must stay outside the HTML-cache catch-all'
    );
  });
});

// orank "Markdown URL fallback" is site-wide (`/docs/auth` → `/docs/auth.md`),
// not a single sampled URL. Static public/*.md files still win (afterFiles).
// /docs/:match* stays first so Mintlify keeps /docs/*.md. /index.md stays
// ahead of the generic fallback. /api/*.md is excluded from this rewrite so
// the filesystem catch-all (api/[...notfound].ts) can emit markdown without
// reintroducing a shadowing /api/:path* rewrite (#4724).
describe('agent readiness: generic markdown URL-fallback rewrite', () => {
  const mdTwinRewrite = vercelConfig.rewrites.find((r) =>
    typeof r.destination === 'string' && r.destination.startsWith('/api/md-twin')
  );
  const rewriteIndex = (source) => vercelConfig.rewrites.findIndex((r) => r.source === source);

  it('rewrites unmatched /{page}.md to /api/md-twin after docs and /index.md', () => {
    assert.ok(mdTwinRewrite, 'expected a generic /{page}.md → /api/md-twin rewrite');
    assert.match(mdTwinRewrite.source, /api\//, 'rewrite must exclude /api/*.md (handled by the not-found catch-all)');
    assert.match(mdTwinRewrite.source, /:mdPath|:path/, 'rewrite must capture the sibling path as a Vercel :param');
    assert.doesNotMatch(
      mdTwinRewrite.source,
      /\(\?</,
      'PCRE named groups are not Vercel :params; destination :mdPath would fail deploy (invalid-route-destination-segment)',
    );
    const mdIdx = vercelConfig.rewrites.indexOf(mdTwinRewrite);
    assert.ok(mdIdx > rewriteIndex('/docs/:match*'), '/docs/:match* must stay ahead of the generic .md fallback');
    assert.ok(mdIdx > rewriteIndex('/index.md'), '/index.md → /home.md must stay ahead of the generic .md fallback');
  });

  it('does not reintroduce a shadowing /api/:path* → /api/not-found rewrite', () => {
    const shadow = (vercelConfig.rewrites ?? []).find((r) =>
      r.destination === '/api/not-found' && /^\/api\/(?::[^/]*\*|\(\.\*\))$/.test(r.source ?? '')
    );
    assert.equal(shadow, undefined, 'do not add /api/:path* → /api/not-found; it shadows [rpc].ts gateways (#4724)');
  });

  it('sends content-page .md twins to the generator, not the dashboard shell', () => {
    assert.equal(firstRewriteFor({ host: 'www.worldmonitor.app', path: '/dashboard.md' })?.destination, '/api/md-twin?path=:mdPath');
    assert.equal(firstRewriteFor({ host: 'www.worldmonitor.app', path: '/stocks/AAPL.md' })?.destination, '/api/md-twin?path=:mdPath');
    assert.equal(firstRewriteFor({ host: 'www.worldmonitor.app', path: '/docs/auth.md' })?.destination, 'https://worldmonitor.mintlify.dev/docs/:match*');
    assert.equal(firstRewriteFor({ host: 'www.worldmonitor.app', path: '/index.md' })?.destination, '/home.md');
    assert.equal(firstRewriteFor({ host: 'www.worldmonitor.app', path: '/api/health.md' }), null);
  });

  it('keeps HTML-cache catch-all from applying to generated .md twins', () => {
    assert.ok(SPA_HTML_CACHE_SOURCE.includes('|.*\\.md$'), 'HTML cache catch-all must exclude every *.md path');
    assert.equal(sourceToRegExp(SPA_HTML_CACHE_SOURCE).test('/dashboard.md'), false);
    assert.equal(sourceToRegExp(SPA_HTML_CACHE_SOURCE).test('/dashboard'), true);
  });
});

describe('agent readiness: remaining markdown twins', () => {
  // pricing.md and support.md are advertised in api-catalog service-meta and
  // llms.txt (#4854/#4857), agents.md is the agent-discovery entry point
  // (#4952), so they get the same three-way pinning as auth.md:
  // explicit markdown Content-Type + CORS, catch-all exclusion (deleting or
  // renaming the static file must 404, not silently serve the dashboard HTML
  // misleading-200 the journey runs flagged), and this guard. /ai-search.md
  // joined the set with its canonical Link header (#4999): it is
  // sitemap-listed, and without the catch-all exclusion the SPA cache-header
  // catch-all (later in the headers array) overrides its max-age rule.
  for (const mdPath of ['/pricing.md', '/support.md', '/agents.md', '/ai-search.md']) {
    it(`serves ${mdPath} as markdown, never the app shell`, () => {
      assert.equal(getHeaderValueForSource(mdPath, 'Content-Type'), 'text/markdown; charset=utf-8');
      assert.equal(getHeaderValueForSource(mdPath, 'Access-Control-Allow-Origin'), '*');
      // #6575: no dashboard-serving rewrite may match the static markdown page.
      const shadow = vercelConfig.rewrites.find((r) =>
        r.destination === DASHBOARD_HTML_DESTINATION && sourceToRegExp(r.source).test(mdPath)
      );
      assert.equal(shadow, undefined, `${mdPath} must serve the real file, not the dashboard`);
      const token = mdPath.slice(1).replaceAll('.', '\\.');
      assert.ok(SPA_HTML_CACHE_SOURCE.includes(`|${token}|`), `HTML cache catch-all must keep excluding ${mdPath}`);
      assert.ok(
        existsSync(resolve(__dirname, `../public${mdPath}`)),
        `public${mdPath} must exist — it is advertised in api-catalog service-meta and llms.txt`
      );
    });
  }

  // /agent.txt (#4958 follow-up): the when-to-use agent-instruction file
  // (agent.txt convention; telnyx-parity). Same three-way pinning, but plain
  // text rather than markdown.
  it('serves /agent.txt as plain text, never the app shell', () => {
    assert.equal(getHeaderValueForSource('/agent.txt', 'Content-Type'), 'text/plain; charset=utf-8');
    assert.equal(getHeaderValueForSource('/agent.txt', 'Access-Control-Allow-Origin'), '*');
    const dashboardShadow = (path) => vercelConfig.rewrites.find((r) =>
      r.destination === DASHBOARD_HTML_DESTINATION && sourceToRegExp(r.source).test(path)
    );
    assert.equal(dashboardShadow('/agent.txt'), undefined, '/agent.txt must serve the real file, not the dashboard');
    assert.ok(SPA_HTML_CACHE_SOURCE.includes('|agent\\.txt|'), 'HTML cache catch-all must keep excluding /agent.txt');
    const agentTxt = readFileSync(resolve(__dirname, '../public/agent.txt'), 'utf-8');
    assert.match(agentTxt, /When to use/i, 'agent.txt must carry when-to-use guidance');
    assert.ok(agentTxt.includes('https://worldmonitor.app/mcp'), 'agent.txt must point at the MCP server');
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
      const entry = vercel.headers.find((h) =>
        h.source === source && h.headers.some((header) => header.key === 'Link')
      );
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

      // The docs MCP server (#4958) is advertised in the Link header directly —
      // header-first crawlers should not have to follow rel="api-catalog" to
      // discover the second MCP surface. Same rel as the product card, but
      // anchored to /docs/mcp (the card describes the docs endpoint). We
      // advertise a FIRST-PARTY card (/.well-known/mcp/docs-server-card.json),
      // NOT Mintlify's /docs/.well-known/mcp/server-card.json, because that
      // card's url points at worldmonitor.mintlify.dev/mcp which 404s on
      // initialize — a card-following agent would land on a dead endpoint
      // (#4964 review). The first-party card advertises the working
      // /docs/mcp facade.
      assert.match(
        linkHeader.value,
        /<\/\.well-known\/mcp\/docs-server-card\.json>[^,]*rel="mcp-server-card"[^,]*anchor="\/docs\/mcp"/,
        'docs mcp-server-card rel must point at the first-party /.well-known/mcp/docs-server-card.json with anchor="/docs/mcp"'
      );

      // `service-desc` is advertised twice — the JSON spec (/openapi.json,
      // parseable by JSON-only scanners like ora.ai/orank) first, then the
      // human-readable YAML (/openapi.yaml). Both must be present.
      assert.match(
        linkHeader.value,
        /<\/openapi\.json>; rel="service-desc"; type="application\/json"/,
        'Link header must advertise /openapi.json as a JSON service-desc'
      );
      assert.match(
        linkHeader.value,
        /<\/openapi\.yaml>; rel="service-desc"; type="application\/vnd\.oai\.openapi"/,
        'Link header must still advertise /openapi.yaml as the OpenAPI service-desc'
      );

      // Target URIs must be root-relative (start with /, not http://).
      // One target per required rel, plus two rels advertised with a second
      // target: service-desc (/openapi.json + /openapi.yaml) and
      // mcp-server-card (product /mcp card + docs /docs/mcp card) — hence +2.
      const EXTRA_DOUBLE_ADVERTISED_RELS = 2;
      const targetMatches = [...linkHeader.value.matchAll(/<([^>]+)>/g)];
      assert.strictEqual(
        targetMatches.length,
        requiredRels.length + EXTRA_DOUBLE_ADVERTISED_RELS,
        `expected exactly ${requiredRels.length + EXTRA_DOUBLE_ADVERTISED_RELS} link targets, got ${targetMatches.length}`
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
    const dashboard = vercel.headers
      .filter((h) => h.source === '/dashboard')
      .flatMap((entry) => entry.headers)
      .find((h) => h.key === 'Link');
    const dashboardHtml = vercel.headers
      .filter((h) => h.source === '/dashboard.html')
      .flatMap((entry) => entry.headers)
      .find((h) => h.key === 'Link');
    assert.strictEqual(dashboard.value, dashboardHtml.value);
  });
});

// Content-Signal (contentsignals.org draft RFC) is declared in TWO places:
// the robots.txt group directive (what agent-readiness scanners read) and the
// origin-wide HTTP response header in vercel.json. The two values must never
// drift apart, and the robots.txt line must live inside the `User-agent: *`
// group (a blank line would end the group and orphan the directive).
// Lighthouse's robots.txt validator safelists `content-signal`, so the
// directive no longer costs SEO points (#4471 history).
describe('agent readiness: Content-Signal declarations', () => {
  const robotsFiles = ['robots.www.txt', 'robots.variant.txt', 'robots.api.txt'];
  const robotsSource = readFileSync(resolve(__dirname, '../public/robots.www.txt'), 'utf-8');

  const headerValue = () => {
    for (const block of vercelConfig.headers ?? []) {
      const hit = (block.headers ?? []).find((h) => h.key === 'Content-Signal');
      if (hit) return hit.value;
    }
    return null;
  };

  it('vercel.json serves an origin-wide Content-Signal header', () => {
    const value = headerValue();
    assert.ok(value, 'vercel.json must carry a Content-Signal response header');
    assert.match(value, /ai-train=(yes|no)/);
    assert.match(value, /search=(yes|no)/);
    assert.match(value, /ai-input=(yes|no)/);
  });

  it('every host robots file declares the same Content-Signal inside the User-agent group', () => {
    for (const file of robotsFiles) {
      const source = readFileSync(resolve(__dirname, '../public', file), 'utf-8');
      const lines = source.split('\n');
      const uaIndex = lines.findIndex((l) => l.trim().toLowerCase() === 'user-agent: *');
      assert.ok(uaIndex !== -1, `${file} must have a \`User-agent: *\` group`);
      const signalIndex = lines.findIndex((l) => l.startsWith('Content-Signal:'));
      assert.ok(signalIndex > uaIndex, `${file} Content-Signal must appear after \`User-agent: *\``);
      for (let i = uaIndex + 1; i < signalIndex; i++) {
        assert.notStrictEqual(
          lines[i].trim(),
          '',
          `${file} Content-Signal must not be separated from its User-agent group by a blank line`
        );
      }
      const robotsValue = lines[signalIndex].slice('Content-Signal:'.length).trim();
      assert.strictEqual(
        robotsValue,
        headerValue(),
        `${file} Content-Signal must match the vercel.json header value`
      );
    }
  });

  it('robots.txt declares the same Content-Signal inside the User-agent group', () => {
    const lines = robotsSource.split('\n');
    const uaIndex = lines.findIndex((l) => l.trim().toLowerCase() === 'user-agent: *');
    assert.ok(uaIndex !== -1, 'robots.txt must have a `User-agent: *` group');
    const signalIndex = lines.findIndex((l) => l.startsWith('Content-Signal:'));
    assert.ok(signalIndex > uaIndex, 'Content-Signal directive must appear after `User-agent: *`');
    for (let i = uaIndex + 1; i < signalIndex; i++) {
      assert.notStrictEqual(
        lines[i].trim(),
        '',
        'Content-Signal must not be separated from its User-agent group by a blank line'
      );
    }
    const robotsValue = lines[signalIndex].slice('Content-Signal:'.length).trim();
    assert.strictEqual(
      robotsValue,
      headerValue(),
      'robots.txt Content-Signal must match the vercel.json header value'
    );
  });

  it('every Content-Signal line in robots.txt matches the header (multi-group)', () => {
    // The AI-agent groups added in #4952 carry their own Content-Signal
    // directive; none of the copies may drift from the origin-wide header.
    for (const file of robotsFiles) {
      const signalLines = readFileSync(resolve(__dirname, '../public', file), 'utf-8')
        .split('\n')
        .filter((l) => l.startsWith('Content-Signal:'));
      assert.ok(signalLines.length >= 1, `${file} must declare Content-Signal`);
      for (const line of signalLines) {
        assert.strictEqual(
          line.slice('Content-Signal:'.length).trim(),
          headerValue(),
          `${file} Content-Signal must match the vercel.json header value`
        );
      }
    }
  });
});

// #4952 — three-tier AI crawler policy. A named `User-agent` group REPLACES
// the `*` group for that crawler (robots.txt groups do not inherit), so the
// AI search/assistant allow-group must restate the full `*` rule set or those
// crawlers would lose the /api/ protections. The training-only group must
// stay a hard `Disallow: /`.
describe('agent readiness: robots.txt AI crawler policy', () => {
  const robotsSource = readFileSync(resolve(__dirname, '../public/robots.www.txt'), 'utf-8');

  // Minimal robots.txt group parser: consecutive User-agent lines share one
  // group; a blank line or a User-agent line following rules starts a new one;
  // comments never end a group.
  const parseGroups = (source) => {
    const groups = [];
    let current = null;
    for (const raw of source.split('\n')) {
      const line = raw.trim();
      if (line === '') {
        current = null;
        continue;
      }
      if (line.startsWith('#')) continue;
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (key === 'user-agent') {
        if (!current || current.rules.length > 0) {
          current = { agents: [], rules: [] };
          groups.push(current);
        }
        current.agents.push(value.toLowerCase());
      } else if (current && (key === 'allow' || key === 'disallow')) {
        current.rules.push(`${key}: ${value}`);
      }
    }
    return groups;
  };

  const groups = parseGroups(robotsSource);
  const starGroup = groups.find((g) => g.agents.includes('*'));
  const aiAllowGroup = groups.find((g) => g.agents.includes('gptbot'));
  const trainingBlockGroup = groups.find((g) => g.agents.includes('ccbot'));

  // The agents AEO scanners score by name (search/assistant tier).
  const REQUIRED_AI_SEARCH_AGENTS = [
    'gptbot',
    'claudebot',
    'chatgpt-user',
    'perplexitybot',
    'google-extended',
    'applebot-extended',
  ];
  const BLOCKED_TRAINING_AGENTS = ['ccbot', 'bytespider', 'anthropic-ai'];

  it('explicitly allows the AI search/assistant agents in one named group', () => {
    assert.ok(aiAllowGroup, 'robots.txt must have a named AI search/assistant group (GPTBot et al.)');
    for (const agent of REQUIRED_AI_SEARCH_AGENTS) {
      assert.ok(
        aiAllowGroup.agents.includes(agent),
        `AI search/assistant group must include User-agent: ${agent}`
      );
    }
    assert.ok(
      aiAllowGroup.rules.includes('allow: /'),
      'AI search/assistant group must Allow: /'
    );
  });

  it('keeps the AI allow-group rules in parity with the `*` group', () => {
    assert.ok(starGroup, 'robots.txt must have a `User-agent: *` group');
    assert.deepStrictEqual(
      [...aiAllowGroup.rules].sort(),
      [...starGroup.rules].sort(),
      'the AI allow-group must restate the exact `*` rule set — named groups do not inherit, so a drift here silently opens /api/ (or blocks paths) for AI crawlers'
    );
  });

  it('disallows the bulk training-only scrapers entirely', () => {
    assert.ok(trainingBlockGroup, 'robots.txt must have a training-scraper block group (CCBot et al.)');
    for (const agent of BLOCKED_TRAINING_AGENTS) {
      assert.ok(
        trainingBlockGroup.agents.includes(agent),
        `training block group must include User-agent: ${agent}`
      );
    }
    assert.deepStrictEqual(
      trainingBlockGroup.rules,
      ['disallow: /'],
      'training-only scrapers must be blocked with exactly `Disallow: /`'
    );
  });

  it('never lists an allowed AI agent in the blocked group (and vice versa)', () => {
    for (const agent of REQUIRED_AI_SEARCH_AGENTS) {
      assert.ok(
        !trainingBlockGroup.agents.includes(agent),
        `${agent} drives citations and must not be in the blocked group`
      );
    }
    for (const agent of BLOCKED_TRAINING_AGENTS) {
      assert.ok(
        !aiAllowGroup.agents.includes(agent),
        `${agent} is training-only and must not be in the allow group`
      );
    }
  });

  it('every crawl-permitting group keeps /api/ protected', () => {
    for (const group of groups) {
      if (group.rules.includes('allow: /')) {
        assert.ok(
          group.rules.includes('disallow: /api/'),
          `group [${group.agents.join(', ')}] allows crawling but does not restate Disallow: /api/`
        );
      }
    }
  });
});

describe('vercel deployment excludes api test files', () => {
  // Vercel deploys every non-underscore file under api/ as a live serverless
  // function. A deployed *.test.mjs is a public endpoint that executes its
  // whole node:test suite (with production env + Sentry) on every request —
  // WORLDMONITOR-VD flooded Sentry with "Upstash Redis is not configured"
  // because wm-session.test.mjs deletes the Upstash env vars to exercise the
  // fail-closed path, and something polls /api/wm-session.test every ~2 min.
  const vercelignore = readFileSync(resolve(__dirname, '../.vercelignore'), 'utf-8');
  const ignoreRules = vercelignore
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  const collectApiTestFiles = (dir) => {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) found.push(...collectApiTestFiles(full));
      else if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) found.push(full);
    }
    return found;
  };
  const apiTestFiles = collectApiTestFiles(resolve(__dirname, '../api'));

  it('.vercelignore excludes api/**/*.test.mjs', () => {
    assert.ok(
      ignoreRules.includes('api/**/*.test.mjs'),
      '.vercelignore must contain "api/**/*.test.mjs" — without it every api test file deploys as a live production function'
    );
  });

  it('every api test file uses the .test.mjs extension the ignore rule covers', () => {
    assert.ok(apiTestFiles.length > 0, 'expected api test files to exist (walker broke?)');
    for (const file of apiTestFiles) {
      assert.match(
        file,
        /\.test\.mjs$/,
        `${file}: api test files must end in .test.mjs so the .vercelignore rule excludes them from deployment — extend both if introducing a new extension`
      );
    }
  });
});

// Registry branding + ARD catalog (ora.ai Discovery checks). The MCP
// server-card must carry the full branding trio (name, icon, description —
// `registry-branding`), and /.well-known/ai-catalog.json publishes the ARD
// manifest (`ard-catalog` bonus): host identity plus domain-anchored
// urn:air: entries, each with a media type, URL, and trust manifest —
// mirroring ora's own /api/ard/catalog dialect, which is what their parser
// reads.
describe('agent readiness: registry branding + ARD catalog', () => {
  const serverCard = JSON.parse(
    readFileSync(resolve(__dirname, '../public/.well-known/mcp/server-card.json'), 'utf-8')
  );
  const aiCatalog = JSON.parse(
    readFileSync(resolve(__dirname, '../public/.well-known/ai-catalog.json'), 'utf-8')
  );

  it('server-card carries the full branding trio and the icon asset exists', () => {
    assert.ok(serverCard.name, 'server-card must have a name');
    assert.ok(serverCard.description, 'server-card must have a description');
    assert.match(
      serverCard.icon ?? '',
      /^https:\/\/(www\.)?worldmonitor\.app\//,
      'server-card icon must be an absolute worldmonitor.app URL'
    );
    const iconPath = new URL(serverCard.icon).pathname;
    assert.ok(
      existsSync(resolve(__dirname, `../public${iconPath}`)),
      `server-card icon must point at a real public asset (public${iconPath})`
    );
  });

  it('ai-catalog.json declares the World Monitor host identity', () => {
    assert.strictEqual(aiCatalog.specVersion, '1.0');
    assert.strictEqual(aiCatalog.host?.displayName, 'World Monitor');
    assert.strictEqual(aiCatalog.host?.identifier, 'did:web:worldmonitor.app');
    assert.ok(Array.isArray(aiCatalog.entries) && aiCatalog.entries.length >= 2);
  });

  it('every ai-catalog entry is domain-anchored and complete', () => {
    for (const entry of aiCatalog.entries) {
      const label = `ai-catalog entry ${entry.identifier}`;
      assert.match(
        entry.identifier ?? '',
        /^urn:air:worldmonitor\.app:[a-z-]+:[a-z0-9-]+$/,
        `${label} must be a domain-anchored urn:air URN`
      );
      assert.ok(entry.displayName, `${label} needs a displayName`);
      assert.ok(entry.type, `${label} needs a media type`);
      assert.ok(entry.description, `${label} needs a description`);
      assert.match(
        entry.url ?? '',
        /^https:\/\/(www\.)?worldmonitor\.app\//,
        `${label} URL must be same-origin`
      );
      assert.strictEqual(
        entry.trustManifest?.identity,
        'did:web:worldmonitor.app',
        `${label} trust identity must be the domain DID`
      );
    }
  });

  it('the ai-catalog MCP entry points at the real server-card path', () => {
    const mcpEntry = aiCatalog.entries.find((e) => e.type === 'application/mcp-server-card+json');
    assert.ok(mcpEntry, 'ai-catalog must list the MCP server');
    assert.ok(
      mcpEntry.url.endsWith('/.well-known/mcp/server-card.json'),
      'MCP entry URL must target the published server-card'
    );
    assert.ok(
      existsSync(resolve(__dirname, '../public/.well-known/agent-skills/index.json')) ===
        aiCatalog.entries.some((e) => e.url.endsWith('/.well-known/agent-skills/index.json')),
      'agent-skills entry must exist iff the skills index is published'
    );
  });
});

describe('variant subdomain dashboard SEO (#4996)', () => {
  // No hardcoded variant list: every set is extracted from its real source
  // and compared BIDIRECTIONALLY, so adding a variant to any one surface
  // (middleware host map, generator, vercel.json rewrites) without the
  // others fails here instead of shipping a subdomain with full-brand meta.
  const dashboardRewrites = vercelConfig.rewrites.filter((r) => r.source === '/dashboard');

  const rewriteVariants = dashboardRewrites
    .filter((r) => r.has)
    .map((r) => {
      const host = (r.has ?? []).find((h) => h.type === 'host')?.value ?? '';
      return host.replace('.worldmonitor.app', '');
    })
    .sort();

  const middlewareVariants = [...middlewareSource.matchAll(/'([a-z]+)\.worldmonitor\.app': '([a-z]+)'/g)]
    .map((m) => m[2])
    .sort();

  const variantHtmlSource = readFileSync(resolve(__dirname, '../src/config/variant-dashboard-html.ts'), 'utf-8');
  const generatorArrayMatch = variantHtmlSource.match(/WEB_DASHBOARD_VARIANTS = \[([^\]]+)\]/);
  const generatorVariants = (generatorArrayMatch?.[1] ?? '')
    .split(',')
    .map((s) => s.trim().replace(/['"]/g, ''))
    .filter(Boolean)
    .sort();

  it('extracted all three variant sets (extraction regressions fail loudly)', () => {
    assert.ok(rewriteVariants.length > 0, 'no host-conditioned /dashboard rewrites found in vercel.json');
    assert.ok(middlewareVariants.length > 0, 'VARIANT_HOST_MAP extraction from middleware.ts found nothing');
    assert.ok(generatorVariants.length > 0, 'WEB_DASHBOARD_VARIANTS extraction from variant-dashboard-html.ts found nothing');
  });

  it('vercel.json rewrites, middleware host map, and the generator cover the SAME variant set (bidirectional)', () => {
    assert.deepEqual(rewriteVariants, middlewareVariants, 'vercel.json /dashboard host rewrites vs middleware VARIANT_HOST_MAP diverged');
    assert.deepEqual(rewriteVariants, generatorVariants, 'vercel.json /dashboard host rewrites vs WEB_DASHBOARD_VARIANTS diverged');
  });

  it('each variant host rewrite targets its generated variant file', () => {
    for (const rule of dashboardRewrites.filter((r) => r.has)) {
      const host = (rule.has ?? []).find((h) => h.type === 'host')?.value ?? '';
      const variant = host.replace('.worldmonitor.app', '');
      assert.match(host, /^[a-z]+\.worldmonitor\.app$/, `unexpected host condition shape: ${host}`);
      assert.strictEqual(
        rule.destination,
        `/dashboard-${variant}.html`,
        `${host} rewrite must target the build-generated variant file`
      );
    }
  });

  it('keeps the host-specific rules BEFORE the generic /dashboard rewrite (order is match priority)', () => {
    const genericIndex = dashboardRewrites.findIndex((r) => !r.has);
    assert.ok(genericIndex >= 0, 'generic /dashboard -> /dashboard.html rewrite must exist');
    assert.strictEqual(
      genericIndex,
      dashboardRewrites.length - 1,
      'the un-conditioned /dashboard rewrite must come last so host rules win'
    );
    assert.strictEqual(dashboardRewrites.length, rewriteVariants.length + 1, 'exactly one un-conditioned /dashboard rewrite expected');
  });

  it('vite build emits the variant dashboard files the rewrites point at (web full build only)', () => {
    assert.match(
      viteConfigSource,
      /!isDesktopBuild && activeVariant === 'full' && variantDashboardHtmlPlugin\(\)/,
      'variantDashboardHtmlPlugin must be registered for web full builds'
    );
  });
});

describe('docs host scoping — Mintlify proxy is www-only (#5345)', () => {
  // The /docs rewrite proxies worldmonitor.mintlify.dev with no host condition,
  // so every variant subdomain served the full docs site and Googlebot crawled
  // the duplicates. Redirects run before rewrites on Vercel, so a host-scoped
  // redirect entry is what keeps subdomain /docs requests from reaching the
  // proxy. The host list is derived from the /dashboard variant rewrites so a
  // new variant subdomain cannot ship outside the docs redirect.
  const docsHostRedirect = vercelConfig.redirects.find(
    (r) => r.source === '/docs/:match*' && r.has
  );
  const variantHosts = vercelConfig.rewrites
    .filter((r) => r.source === '/dashboard' && r.has)
    .map((r) => (r.has ?? []).find((h) => h.type === 'host')?.value ?? '');

  it('redirects subdomain /docs/* to www permanently', () => {
    assert.ok(docsHostRedirect, 'expected a host-conditioned redirect for /docs/:match*');
    assert.equal(docsHostRedirect.destination, 'https://www.worldmonitor.app/docs/:match*');
    assert.equal(docsHostRedirect.permanent, true);
  });

  it('the host condition covers every variant subdomain plus api., and never www.', () => {
    const hostValue = (docsHostRedirect?.has ?? []).find((h) => h.type === 'host')?.value ?? '';
    const hostRe = new RegExp(hostValue);
    assert.ok(variantHosts.length > 0, 'variant host extraction from /dashboard rewrites found nothing');
    for (const host of [...variantHosts, 'api.worldmonitor.app']) {
      assert.match(host, hostRe, `${host} must be caught by the docs host redirect`);
    }
    assert.ok(!hostRe.test('www.worldmonitor.app'), 'www must keep serving the docs proxy');
  });

  it('redirects prefix-less /api-reference/* (Googlebot fetches Mintlify RSC route strings) into /docs on www', () => {
    // Mintlify's RSC flight payload embeds its internal routes without the
    // /docs base path; Googlebot speculatively fetches those strings against
    // whatever host served the page. Without this redirect they 404 (the SPA
    // catch-all excludes ^api), flooding GSC.
    const redirect = vercelConfig.redirects.find((r) => r.source === '/api-reference/:match*');
    assert.ok(redirect, 'expected a redirect for /api-reference/:match*');
    assert.equal(redirect.destination, 'https://www.worldmonitor.app/docs/api-reference/:match*');
    assert.equal(redirect.permanent, true);
    assert.equal(redirect.has, undefined, 'must apply on every host, www included');
  });

  it('the www docs proxy rewrite itself is untouched', () => {
    const proxy = vercelConfig.rewrites.find((r) => r.source === '/docs/:match*');
    assert.ok(proxy, 'expected the /docs/:match* rewrite');
    assert.equal(proxy.destination, 'https://worldmonitor.mintlify.dev/docs/:match*');
  });
});

describe('markdown canonical Link headers (#4999)', () => {
  // The sitemap-listed markdown pages are intentionally raw text/markdown for
  // agents, so they cannot carry a <link rel="canonical">. RFC 6596 allows the
  // HTTP Link header form; without it these are the only indexable URLs with
  // no canonical signal at all.
  const MD_PAGES = ['/pricing.md', '/support.md', '/ai-search.md', '/developers.md', '/mcp-server.md', '/openapi.md', '/sdks.md', '/auth.md', '/agents.md', '/home.md'];

  for (const page of MD_PAGES) {
    it(`${page} declares a self-referencing canonical Link header`, () => {
      assert.strictEqual(
        getHeaderValueForSource(page, 'Link'),
        `<https://www.worldmonitor.app${page}>; rel="canonical"`,
        `${page} must self-canonicalize on the www host via the Link header`
      );
      assert.strictEqual(
        getHeaderValueForSource(page, 'Content-Type'),
        'text/markdown; charset=utf-8'
      );
    });
  }

  const CORPUS_PAGES = ['/llms.txt', '/llms-full.txt', '/agent.txt', '/openapi.yaml', '/openapi.json', '/schemamap.xml'];

  for (const page of CORPUS_PAGES) {
    it(`${page} declares a www canonical Link header`, () => {
      assert.strictEqual(
        getHeaderValueForSource(page, 'Link'),
        `<https://www.worldmonitor.app${page}>; rel="canonical"`,
        `${page} must self-canonicalize on the www host via the Link header`
      );
    });
  }

  it('every sitemap-listed .md URL has the canonical Link header rule', () => {
    const sitemap = readFileSync(resolve(__dirname, '../public/sitemap.xml'), 'utf-8');
    const mdUrls = [...sitemap.matchAll(/<loc>https:\/\/www\.worldmonitor\.app(\/[^<]+\.md)<\/loc>/g)].map((m) => m[1]);
    assert.ok(mdUrls.length > 0, 'expected .md entries in sitemap.xml');
    for (const path of mdUrls) {
      assert.ok(MD_PAGES.includes(path), `${path} is in sitemap.xml but has no canonical Link header rule — add it to vercel.json and this test`);
    }
  });
});

// #4953 — developer-resource discoverability: an agent web-searching "World
// Monitor MCP server", "World Monitor OpenAPI", "World Monitor developer
// portal", or "World Monitor SDK" must land on a crawlable page whose H1 names
// that resource type. Each named page mirrors the auth.md/ai-search.md serving
// pattern (static public/*.md, excluded from the SPA catch-all, advertised in
// the discovery chain).
describe('agent readiness: named developer-resource pages (#4953)', () => {
  const DEV_PAGES = [
    { file: 'developers.md', path: '/developers.md', h1: '# World Monitor Developer Portal' },
    { file: 'mcp-server.md', path: '/mcp-server.md', h1: '# World Monitor MCP Server' },
    { file: 'openapi.md', path: '/openapi.md', h1: '# World Monitor OpenAPI Specification' },
    { file: 'sdks.md', path: '/sdks.md', h1: '# World Monitor SDKs' },
  ];


  for (const page of DEV_PAGES) {
    it(`public/${page.file} opens with the brand-named H1 "${page.h1}"`, () => {
      const body = readFileSync(resolve(__dirname, `../public/${page.file}`), 'utf-8');
      assert.ok(body.startsWith(`${page.h1}\n`), `public/${page.file} must open with "${page.h1}"`);
    });

    it(`${page.path} serves the static page, never the app shell`, () => {
      // #6575: the SPA catch-all is gone; guard that it stays that way per page.
      const shadow = vercelConfig.rewrites.find((r) =>
        r.destination === DASHBOARD_HTML_DESTINATION && sourceToRegExp(r.source).test(page.path)
      );
      assert.equal(shadow, undefined, `${page.path} must not be rewritten to the app shell`);
      assert.ok(
        !sourceToRegExp(SPA_HTML_CACHE_SOURCE).test(page.path),
        `${page.path} must be excluded from the pinned HTML-cache catch-all`
      );
    });
  }

  it('advertises the developer portal + resource pages across the discovery chain', () => {
    // Mirror the #4958 "advertises...on every discovery surface" guard: a page
    // that is supposed to be advertised everywhere silently going unadvertised
    // on one surface was a real drift incident. Check the api-catalog plus every
    // text discovery surface the PR wires (llms.txt, llms-full.txt, agents.md,
    // api/llms.txt).
    const catalog = JSON.parse(readFileSync(resolve(__dirname, '../public/.well-known/api-catalog'), 'utf-8'));
    const catalogHrefs = catalog.linkset.flatMap((ctx) =>
      Object.values(ctx).flatMap((v) => (Array.isArray(v) ? v.map((e) => e.href) : []))
    );
    const surfaces = ['llms.txt', 'llms-full.txt', 'agents.md', 'api/llms.txt'].map((f) => [
      f,
      readFileSync(resolve(__dirname, `../public/${f}`), 'utf-8'),
    ]);
    // The sitemap and the indexed "Build on World Monitor" blog post are the two
    // web-search discovery surfaces (candidate fixes #1/#3 of the issue) — assert
    // them directly so a dropped sitemap entry or blog cross-link is caught here,
    // not only via the reverse #4999 sitemap->MD_PAGES sweep.
    const sitemap = readFileSync(resolve(__dirname, '../public/sitemap.xml'), 'utf-8');
    const blogPost = readFileSync(
      resolve(__dirname, '../blog-site/src/content/blog/build-on-worldmonitor-developer-api-open-source.md'),
      'utf-8'
    );
    for (const page of DEV_PAGES) {
      const url = `https://worldmonitor.app${page.path}`;
      assert.ok(catalogHrefs.includes(url), `api-catalog must advertise ${url}`);
      for (const [name, content] of surfaces) {
        assert.ok(content.includes(page.path), `public/${name} must link ${page.path}`);
      }
      assert.ok(
        sitemap.includes(`https://www.worldmonitor.app${page.path}`),
        `sitemap.xml must register ${page.path} on the www host`
      );
      assert.ok(blogPost.includes(page.path), `the developer blog post must cross-link ${page.path}`);
    }
  });
});

// NLWeb schemamap (orank "NLWeb Schema Feeds"): keep the file published and
// discoverable without advertising it through robots.txt. Lighthouse rejects
// the emerging `Schemamap:` directive as unknown, dropping SEO 100 -> 92 on
// every route; #4835 tracks the upstream safelist unblock. Every <loc> must
// still resolve to a tracked file or a live route — a schemamap pointing at a
// 404 is worse than none (same dead-pointer class as the deleted Wikidata QID
// incident).
describe('NLWeb schemamap (/schemamap.xml)', () => {
  const schemamapSource = readFileSync(resolve(__dirname, '../public/schemamap.xml'), 'utf-8');

  it('keeps the file published without an unsupported robots.txt directive', () => {
    assert.doesNotMatch(
      robotsSource,
      /^Schemamap:/mi,
      'Lighthouse rejects Schemamap as an unknown robots.txt directive; see #4835'
    );
    assert.match(schemamapSource, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.ok(
      schemamapSource.includes('<schemamap xmlns="http://www.nlweb.ai/schemas/schemamap/0.1">'),
      'schemamap must declare the NLWeb schemamap namespace'
    );
  });

  it('every advertised <loc> resolves to a tracked file or a live route', () => {
    const locs = [...schemamapSource.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    assert.ok(locs.length >= 3, 'schemamap must index at least the homepage, blog, and RSS feed');
    const resolvable = {
      'https://www.worldmonitor.app/': () =>
        vercelConfig.rewrites.some((r) => r.source === '/' && r.destination === '/pro/welcome.html'),
      'https://www.worldmonitor.app/blog/': () =>
        existsSync(resolve(__dirname, '../blog-site/src/pages/index.astro')),
      'https://www.worldmonitor.app/blog/rss.xml': () =>
        existsSync(resolve(__dirname, '../blog-site/src/pages/rss.xml.ts')),
      'https://www.worldmonitor.app/blog/glossary/': () =>
        existsSync(resolve(__dirname, '../blog-site/src/pages/glossary/index.astro')),
    };
    for (const loc of locs) {
      const probe = resolvable[loc];
      assert.ok(probe, `schemamap <loc> ${loc} has no resolvability probe — add one when adding entries`);
      assert.ok(probe(), `schemamap <loc> ${loc} does not resolve to a tracked file or live route`);
    }
    // Each entry must pair the loc with a schema.org type. Line-anchored so
    // the explanatory XML comment (which names the tags) doesn't count.
    const entries = schemamapSource.match(/^ {2}<url>$/gm) || [];
    const schemas = schemamapSource.match(/<schema>https:\/\/schema\.org\/[A-Za-z]+<\/schema>/g) || [];
    assert.equal(entries.length, locs.length);
    assert.equal(schemas.length, locs.length, 'every schemamap entry needs a schema.org type');
  });

  it('the schemamap.xml headers rule serves XML with CORS', () => {
    const rule = vercelConfig.headers.find((h) => h.source === '/schemamap.xml');
    assert.ok(rule, 'vercel.json must carry a /schemamap.xml headers rule');
    const keys = Object.fromEntries(rule.headers.map((h) => [h.key, h.value]));
    assert.match(keys['Content-Type'], /application\/xml/);
    assert.equal(keys['Access-Control-Allow-Origin'], '*');
  });
});

// Docs MCP facade: /docs/mcp must hit api/docs-mcp.ts (which lifts the
// upstream's protocol-level tool-call failures into real JSON-RPC errors)
// BEFORE the catch-all /docs/:match* Mintlify rewrite — rewrites are
// first-match-wins, so ordering is load-bearing.
describe('docs MCP facade (/docs/mcp)', () => {
  it('rewrites /docs/mcp to /api/docs-mcp ahead of the Mintlify catch-all', () => {
    const rewrites = vercelConfig.rewrites;
    const facadeIdx = rewrites.findIndex(
      (r) => r.source === '/docs/mcp' && r.destination === '/api/docs-mcp'
    );
    const mintlifyIdx = rewrites.findIndex(
      (r) => r.source === '/docs/:match*' && String(r.destination).includes('mintlify.dev')
    );
    assert.ok(facadeIdx >= 0, 'missing /docs/mcp → /api/docs-mcp rewrite');
    assert.ok(mintlifyIdx >= 0, 'Mintlify /docs rewrite missing');
    assert.ok(facadeIdx < mintlifyIdx, '/docs/mcp rewrite must precede the /docs/:match* Mintlify rewrite');
    assert.ok(existsSync(resolve(__dirname, '../api/docs-mcp.ts')), 'api/docs-mcp.ts must exist');
  });

  it('the first-party docs server card still points at the facade URL', () => {
    const card = JSON.parse(
      readFileSync(resolve(__dirname, '../public/.well-known/mcp/docs-server-card.json'), 'utf-8')
    );
    assert.equal(card.url, 'https://www.worldmonitor.app/docs/mcp');
    assert.equal(card.serverUrl, 'https://www.worldmonitor.app/docs/mcp');
  });
});

// Modular llms.txt (orank "Modular llms.txt per product area"): section-scoped
// files must exist and the site-wide llms.txt must cross-link every section so
// agents can discover them without probing paths blind.
describe('section-scoped llms.txt files', () => {
  it('tracked section files exist', () => {
    for (const path of ['../public/api/llms.txt', '../public/developers/llms.txt', '../blog-site/src/pages/llms.txt.ts']) {
      assert.ok(existsSync(resolve(__dirname, path)), `${path} must exist`);
    }
  });

  it('the site-wide llms.txt cross-links every section file and the sandbox', () => {
    const llms = readFileSync(resolve(__dirname, '../public/llms.txt'), 'utf-8');
    for (const url of [
      'https://worldmonitor.app/api/llms.txt',
      'https://www.worldmonitor.app/docs/llms.txt',
      'https://worldmonitor.app/developers/llms.txt',
      'https://www.worldmonitor.app/blog/llms.txt',
      'https://www.worldmonitor.app/sandbox/index.json',
      'https://www.worldmonitor.app/schemamap.xml',
    ]) {
      assert.ok(llms.includes(url), `public/llms.txt must link ${url}`);
    }
  });
});

describe('skeleton brand text extraction (#5541)', () => {
  const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');

  it('.skeleton-brand raw textContent does not contain "WWorld"', () => {
    const match = indexHtml.match(/<div class="skeleton-brand">([\s\S]*?)<\/div>/);
    assert.ok(match, 'index.html must contain .skeleton-brand element');
    // Simulate raw textContent: strip all HTML tags
    const rawText = match[1].replace(/<[^>]+>/g, '');
    assert.doesNotMatch(rawText, /WWorld/, 'skeleton-brand raw text must not concatenate as "WWorld Monitor"');
    assert.match(rawText, /World Monitor/, 'skeleton-brand raw text must contain "World Monitor"');
  });

  it('.skeleton-brand-mark is aria-hidden and has no text content', () => {
    const markMatch = indexHtml.match(/<span class="skeleton-brand-mark"[^>]*>([\s\S]*?)<\/span>/);
    assert.ok(markMatch, 'index.html must contain .skeleton-brand-mark element');
    assert.match(markMatch[0], /aria-hidden="true"/, 'skeleton-brand-mark must be aria-hidden');
    const markText = markMatch[1].replace(/<[^>]+>/g, '').trim();
    assert.equal(markText, '', 'skeleton-brand-mark must have no text content (use CSS ::after instead)');
  });

  it('.skeleton-brand-mark renders "W" via CSS content pseudo-element', () => {
    assert.match(indexHtml, /\.skeleton-brand-mark::after\s*\{\s*content:\s*"W"\s*\}/, 'skeleton-brand-mark must render W via CSS ::after content');
  });
});

// #6832/#6833/#6834/#6835/#6836 — one Vercel project serves every host, so
// shared HTML/XML on tech/finance/commodity/happy/energy/api is crawled as
// alternates (or, for RSS, duplicates with no user-selected canonical).
describe('variant-host canonicalization (#6833–#6836)', () => {
  const docsHostRedirect = vercelConfig.redirects.find(
    (r) => r.source === '/docs/:match*' && r.has
  );
  const sharedHostValue = (docsHostRedirect?.has ?? []).find((h) => h.type === 'host')?.value ?? '';
  const sharedHostRe = new RegExp(sharedHostValue);
  const dashboardVariantHosts = vercelConfig.rewrites
    .filter((r) => r.source === '/dashboard' && r.has)
    .map((r) => (r.has ?? []).find((h) => h.type === 'host')?.value ?? '')
    .filter(Boolean);

  const hostRedirect = (source, hostNeedle) =>
    vercelConfig.redirects.find((r) => {
      if (r.source !== source) return false;
      const hostValue = (r.has ?? []).find((h) => h.type === 'host')?.value ?? '';
      return hostNeedle ? hostValue.includes(hostNeedle) : Boolean(r.has);
    });

  const SHARED_WWW_PREFIXES = [
    'blog',
    'countries',
    'chokepoints',
    'research',
    'tools',
    'crises',
    'use-cases',
    'reference',
    'sources',
  ];

  it('keeps the docs host regex as the single shared-content host list', () => {
    assert.ok(sharedHostValue, 'docs host redirect must exist so shared-content 308s can share its host list');
    for (const host of [...dashboardVariantHosts, 'api.worldmonitor.app']) {
      assert.match(host, sharedHostRe, `${host} must stay in the shared-content host regex`);
    }
    assert.ok(!sharedHostRe.test('www.worldmonitor.app'), 'www must not be redirected off itself');
    assert.ok(!sharedHostRe.test('worldmonitor.app'), 'apex must not inherit variant 308s');
  });

  for (const prefix of SHARED_WWW_PREFIXES) {
    it(`308s variant/api /${prefix}/* to www (#6833)`, () => {
      const redirect = hostRedirect(`/${prefix}/:match*`, 'tech');
      assert.ok(redirect, `expected a host-conditioned 308 for /${prefix}/:match*`);
      assert.equal(redirect.destination, `https://www.worldmonitor.app/${prefix}/:match*`);
      assert.equal(redirect.permanent, true);
      const hostValue = (redirect.has ?? []).find((h) => h.type === 'host')?.value;
      assert.equal(
        hostValue,
        sharedHostValue,
        `/${prefix}/:match* must reuse the /docs host regex so a new variant cannot ship uncovered`
      );
    });
  }

  it('308s variant/api /pro exactly, never /pro/assets (#6833)', () => {
    const redirect = hostRedirect('/pro', 'tech');
    assert.ok(redirect, 'expected a host-conditioned 308 for /pro');
    assert.equal(redirect.destination, 'https://www.worldmonitor.app/pro');
    assert.equal(redirect.permanent, true);
    assert.equal((redirect.has ?? []).find((h) => h.type === 'host')?.value, sharedHostValue);
    assert.equal(
      vercelConfig.redirects.some((r) => r.source === '/pro/:match*' && r.has),
      false,
      '/pro/:match* would 308 hashed /pro/assets/* off the variant host'
    );
  });

  it('308s prefix-less /zh/* into /docs/zh on www on every host (#6833)', () => {
    const redirect = vercelConfig.redirects.find((r) => r.source === '/zh/:match*');
    assert.ok(redirect, 'expected a redirect for /zh/:match*');
    assert.equal(redirect.destination, 'https://www.worldmonitor.app/docs/zh/:match*');
    assert.equal(redirect.permanent, true);
    assert.equal(redirect.has, undefined, '/zh/* is a Mintlify leak — must apply on www too');
  });

  it('308s product-variant / to same-host /dashboard (#6833)', () => {
    const redirect = vercelConfig.redirects.find((r) =>
      r.source === '/' && r.destination === '/dashboard'
    );
    assert.ok(redirect, 'expected a host-conditioned 308 for product-variant /');
    assert.equal(redirect.destination, '/dashboard');
    assert.equal(redirect.permanent, true);
    const hostRe = new RegExp((redirect.has ?? []).find((h) => h.type === 'host')?.value ?? '');
    for (const host of dashboardVariantHosts) {
      assert.match(host, hostRe, `${host}/ must 308 to /dashboard`);
    }
    assert.ok(!hostRe.test('www.worldmonitor.app'), 'www / must stay the welcome page');
    assert.ok(!hostRe.test('worldmonitor.app'), 'apex / must stay the welcome page');
    assert.ok(!hostRe.test('api.worldmonitor.app'), 'api / is not a product variant');
  });

  it('308s api / to www / (#6833)', () => {
    const redirect = firstRedirectFor({ host: 'api.worldmonitor.app', path: '/' });
    assert.ok(redirect, 'expected a host-conditioned 308 for api.worldmonitor.app/');
    assert.equal(redirect.destination, 'https://www.worldmonitor.app/');
    assert.equal(redirect.permanent, true);
    const hostValue = (redirect.has ?? []).find((h) => h.type === 'host')?.value ?? '';
    assert.ok(new RegExp(hostValue).test('api.worldmonitor.app'));
    assert.ok(!new RegExp(hostValue).test('www.worldmonitor.app'));
  });

  it('evaluates first-match redirects by host and path (#6833)', () => {
    const tech = 'tech.worldmonitor.app';
    assert.equal(firstRedirectFor({ host: tech, path: '/' })?.destination, '/dashboard');
    assert.equal(firstRedirectFor({ host: tech, path: '/', query: { mode: 'agent' } }), null);
    assert.equal(firstRedirectFor({ host: 'www.worldmonitor.app', path: '/' }), null);
    assert.equal(firstRedirectFor({ host: 'worldmonitor.app', path: '/' }), null);
    assert.equal(firstRedirectFor({ host: 'api.worldmonitor.app', path: '/' })?.destination, 'https://www.worldmonitor.app/');
    assert.equal(
      firstRedirectFor({ host: tech, path: '/blog/rss.xml' })?.destination,
      'https://www.worldmonitor.app/blog/:match*'
    );
    assert.equal(firstRedirectFor({ host: tech, path: '/pro' })?.destination, 'https://www.worldmonitor.app/pro');
    assert.equal(firstRedirectFor({ host: tech, path: '/pro/' })?.destination, 'https://www.worldmonitor.app/pro');
    assert.equal(firstRedirectFor({ host: tech, path: '/pro/assets/index-abc.js' }), null);
    assert.equal(firstRedirectFor({ host: tech, path: '/dashboard' }), null);
    assert.equal(
      firstRedirectFor({ host: tech, path: '/zh/mcp-error-catalog' })?.destination,
      'https://www.worldmonitor.app/docs/zh/:match*'
    );
    assert.equal(firstRewriteFor({ host: tech, path: '/', query: { mode: 'agent' } })?.destination, '/agent-view.json');
  });

  it('does not 308 variant /dashboard to www (#6833)', () => {
    const dashboardToWww = vercelConfig.redirects.filter((r) =>
      r.source === '/dashboard' && String(r.destination).includes('www.worldmonitor.app')
    );
    assert.deepEqual(dashboardToWww, [], 'variant /dashboard is the indexable product URL');
  });

  it('places shared-content 308s before host-agnostic trailing-slash redirects (#6833)', () => {
    const blogIdx = vercelConfig.redirects.findIndex((r) => r.source === '/blog/:match*' && r.has);
    const slashIdx = vercelConfig.redirects.findIndex((r) => r.source === '/countries' && !r.has);
    assert.ok(blogIdx >= 0, 'missing /blog/:match* host 308');
    assert.ok(slashIdx >= 0, 'missing /countries trailing-slash redirect');
    assert.ok(blogIdx < slashIdx, 'host 308s must run before same-host slash normalization');
  });

  it('advertises the www RSS feed as the user-selected canonical (#6834)', () => {
    assert.equal(
      getHeaderValueForSource('/blog/rss.xml', 'Link'),
      '<https://www.worldmonitor.app/blog/rss.xml>; rel="canonical"'
    );
    assert.equal(getHeaderValueForSource('/blog/rss.xml', 'X-Robots-Tag'), 'noindex, follow');
  });

  it('blog HTML autodiscovery points at the absolute www feed (#6834)', () => {
    const layout = readFileSync(resolve(__dirname, '../blog-site/src/layouts/Base.astro'), 'utf-8');
    assert.match(
      layout,
      /rel="alternate"[^>]*type="application\/rss\+xml"[^>]*href="https:\/\/www\.worldmonitor\.app\/blog\/rss\.xml"/
    );
    assert.doesNotMatch(
      layout,
      /rel="alternate"[^>]*href="\/blog\/rss\.xml"/,
      'relative /blog/rss.xml on a variant-host 200 teaches Google a new feed URL'
    );
    const rss = readFileSync(resolve(__dirname, '../blog-site/src/pages/rss.xml.ts'), 'utf-8');
    assert.match(rss, /atom:link href="https:\/\/www\.worldmonitor\.app\/blog\/rss\.xml" rel="self"/);
  });

  it('rewrites variant and api /robots.txt to dedicated files (#6835)', () => {
    assert.equal(
      existsSync(resolve(__dirname, '../public/robots.txt')),
      false,
      'public/robots.txt would win filesystem precedence and ignore host rewrites (#4825 class)'
    );
    assert.ok(existsSync(resolve(__dirname, '../public/robots.www.txt')));
    assert.equal(firstRewriteFor({ host: 'tech.worldmonitor.app', path: '/robots.txt' })?.destination, '/robots.variant.txt');
    assert.equal(firstRewriteFor({ host: 'happy.worldmonitor.app', path: '/robots.txt' })?.destination, '/robots.variant.txt');
    assert.equal(firstRewriteFor({ host: 'api.worldmonitor.app', path: '/robots.txt' })?.destination, '/robots.api.txt');
    assert.equal(firstRewriteFor({ host: 'www.worldmonitor.app', path: '/robots.txt' })?.destination, '/robots.www.txt');
    assert.equal(
      vercelConfig.redirects.some((r) => r.source === '/robots.txt'),
      false,
      '/robots.txt must 200 on every host — never 308 to www'
    );
  });

  it('variant robots.txt keeps /dashboard crawlable and does not Disallow 308 families (#6835)', () => {
    const body = readFileSync(resolve(__dirname, '../public/robots.variant.txt'), 'utf-8');
    for (const path of [...SHARED_WWW_PREFIXES.map((p) => `/${p}`), '/docs', '/zh']) {
      assert.doesNotMatch(
        body,
        new RegExp(`^Disallow: ${path.replace('/', '\\/')}$`, 'm'),
        `Disallow ${path} would hide the 308 from a compliant crawler`
      );
    }
    for (const path of ['/pro', '/api/', '/tests/']) {
      assert.match(body, new RegExp(`^Disallow: ${path.replace('/', '\\/')}$`, 'm'), `variant robots must Disallow ${path}`);
    }
    assert.match(body, /^Allow: \/dashboard$/m);
    assert.doesNotMatch(body, /^Disallow: \/dashboard$/m);
    assert.match(body, /^Sitemap: https:\/\/www\.worldmonitor\.app\/sitemap\.xml$/m);
  });

  it('api robots.txt does not invite a marketing crawl of / (#6835)', () => {
    const body = readFileSync(resolve(__dirname, '../public/robots.api.txt'), 'utf-8');
    assert.match(body, /^Disallow: \/$/m);
    assert.match(body, /^Allow: \/api\/llms\.txt$/m);
    assert.match(body, /^Allow: \/api\/product-catalog$/m);
    assert.match(body, /^Allow: \/\.well-known\/$/m);
    assert.match(body, /^Allow: \/mcp$/m);
    assert.match(body, /^Allow: \/a2a$/m);
    assert.match(body, /^Allow: \/llms\.txt$/m);
    assert.match(body, /^Disallow: \/pro$/m);
  });

  it('308s www /reference/ to the changelog so empty :match* is not a 404', () => {
    assert.equal(
      firstRedirectFor({ host: 'www.worldmonitor.app', path: '/reference/' })?.destination,
      '/reference/changelog/',
    );
    assert.equal(
      firstRedirectFor({ host: 'tech.worldmonitor.app', path: '/reference/' })?.destination,
      '/reference/changelog/',
    );
    assert.equal(
      firstRedirectFor({ host: 'tech.worldmonitor.app', path: '/reference' })?.destination,
      'https://www.worldmonitor.app/reference/:match*',
    );
  });

  it('keeps the pinned HTML-cache catch-all header without a serving counterpart', () => {
    // #6575: the negative-lookahead rewrite is gone (unknown paths 404). The
    // cache-header catch-all stays as the pinned no-cache rule for HTML-ish
    // paths; it no longer needs a byte-identical rewrite sibling.
    const catchAllHeader = vercelConfig.headers.find((r) => r.source === SPA_HTML_CACHE_SOURCE);
    assert.ok(catchAllHeader, 'expected the pinned SPA cache-header rule');
    assert.equal(getCacheHeaderValue(SPA_HTML_CACHE_SOURCE), 'private, no-cache, must-revalidate');
    // The enumerated SPA entry routes keep the no-cache policy.
    for (const path of ['/dashboard', '/stocks', '/stocks/AAPL', '/story']) {
      assert.equal(effectiveCacheControl(path), 'private, no-cache, must-revalidate', path + ' must stay no-cache');
    }
  });

  it('variant and api robots keep AI-group rule parity with their own * group (#6835)', () => {
    const parseGroups = (source) => {
      const groups = [];
      let current = null;
      for (const raw of source.split('\n')) {
        const line = raw.trim();
        if (line === '') {
          current = null;
          continue;
        }
        if (line.startsWith('#')) continue;
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (key === 'user-agent') {
          if (!current || current.rules.length > 0) {
            current = { agents: [], rules: [] };
            groups.push(current);
          }
          current.agents.push(value.toLowerCase());
        } else if (current && (key === 'allow' || key === 'disallow')) {
          current.rules.push(`${key}: ${value}`);
        }
      }
      return groups;
    };

    for (const file of ['robots.variant.txt', 'robots.api.txt']) {
      const groups = parseGroups(readFileSync(resolve(__dirname, `../public/${file}`), 'utf-8'));
      const star = groups.find((g) => g.agents.includes('*'));
      const ai = groups.find((g) => g.agents.includes('gptbot'));
      const training = groups.find((g) => g.agents.includes('ccbot'));
      assert.ok(star, `${file} must have a * group`);
      assert.ok(ai, `${file} must restate the AI search/assistant group`);
      assert.deepStrictEqual(
        [...ai.rules].sort(),
        [...star.rules].sort(),
        `${file} AI group must restate the * rules`
      );
      assert.deepStrictEqual(training?.rules, ['disallow: /']);
    }
  });

  it('keeps leaked source/tmp/server paths off the dashboard document (#6836, #6575)', () => {
    for (const path of [
      '/src/generated/server/worldmonitor/seismology/v1/service_server',
      '/tmp/gem-drops.log',
      '/server/worldmonitor/intelligence/v1/_risk-config.ts',
      '/llms*.txt',
      '/country-intel',
    ]) {
      const shadow = vercelConfig.rewrites.find((r) =>
        r.destination === DASHBOARD_HTML_DESTINATION && sourceToRegExp(r.source).test(path)
      );
      assert.equal(shadow, undefined, `${path} must 404 instead of serving dashboard.html`);
    }
    // The real client-side History routes keep reaching the SPA document.
    assert.equal(firstRewriteFor({ host: 'www.worldmonitor.app', path: '/stocks' })?.destination, DASHBOARD_HTML_DESTINATION);
    assert.equal(firstRewriteFor({ host: 'www.worldmonitor.app', path: '/stocks/AAPL' })?.destination, DASHBOARD_HTML_DESTINATION);
    assert.equal(firstRewriteFor({ host: 'www.worldmonitor.app', path: '/story' })?.destination, DASHBOARD_HTML_DESTINATION);
    assert.equal(firstRewriteFor({ host: 'www.worldmonitor.app', path: '/stocks/foo/bar' }), null);
    assert.ok(SPA_HTML_CACHE_SOURCE.includes('|src|'), 'HTML cache catch-all must exclude /src');
    assert.ok(SPA_HTML_CACHE_SOURCE.includes('|tmp|'), 'HTML cache catch-all must exclude /tmp');
    assert.ok(SPA_HTML_CACHE_SOURCE.includes('|server|'), 'HTML cache catch-all must exclude /server');
  });
});
