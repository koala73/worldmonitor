// Every HTML page we serve under the site-wide CSP must be able to run its
// own scripts. That CSP (vercel.json catch-all) uses 'strict-dynamic' with no
// 'unsafe-inline', so the browser silently drops:
//   - an inline <script> without an allowed nonce or a listed SHA-256 hash,
//   - a `javascript:` URL,
//   - an inline event-handler attribute (onclick=, onload=, …).
// Each of these shipped once and left a dead control in production (the MCP
// consent page's "Use API key instead", the OAuth error pages' "go back", the
// hosted YouTube embed's player). This sweep reads the served sources so the
// next one fails here instead.

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import authorizeHandler, { consentPage } from '../api/oauth/authorize.js';
import { authorizeProHandler } from '../api/oauth/authorize-pro.ts';
import youtubeEmbedHandler from '../api/youtube/embed.js';

const ROOT = new URL('..', import.meta.url);
const STATIC_NONCE = "'nonce-wm-static-bootstrap'";

// Served under a different CSP, or not served as a page under ours.
const EXEMPT = {
  // Own CSP rules in vercel.json.
  'api/slack/oauth/callback.ts': '/api/slack/oauth/callback',
  'api/discord/oauth/callback.ts': '/api/discord/oauth/callback',
  'public/wm-widget-sandbox.html': '/wm-widget-sandbox.html',
  'embed.html': '/embed.html',
  // MCP App resources: the MCP server inlines them and the host renders them
  // in its own sandbox, under the host's CSP.
  'plugin.html': null,
  'market.html': null,
  'country.html': null,
};
const EXEMPT_DIRS = ['api/mcp/ui/'];

// Handlers whose inline scripts are allowed by hash under their own route CSP.
// Their scripts are checked against that CSP from the rendered page below.
const ROUTE_CSP_FILES = {
  'api/oauth/authorize.js': ['/oauth/authorize', '/api/oauth/authorize'],
  'api/oauth/authorize-pro.ts': ['/oauth/authorize-pro', '/api/oauth/authorize-pro'],
  'api/youtube/embed.js': ['/api/youtube/embed'],
};

// Vite source pages for /pro and /welcome; the build adds the script nonces,
// so only handlers and javascript: URLs are checked in the source.
const PRO_SOURCES = ['pro-test/index.html', 'pro-test/welcome.html'];

const vercel = JSON.parse(readFileSync(new URL('vercel.json', ROOT), 'utf8'));
const cspRules = vercel.headers
  .map((rule) => ({ source: rule.source, csp: rule.headers.find((h) => h.key === 'Content-Security-Policy')?.value }))
  .filter((rule) => rule.csp);
// Vercel applies every matching rule in order, so the last one sets the header.
const effectiveCsp = (path) => cspRules.findLast((rule) => new RegExp(`^${rule.source}$`).test(path))?.csp;
const directive = (csp, name) => csp?.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';
const tokens = (csp, name) => directive(csp, name).split(/\s+/).slice(1);
const siteCsp = cspRules.find((rule) => rule.source.startsWith('/((?!docs|embed'))?.csp;
const scriptSrc = tokens(siteCsp, 'script-src');

const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script[^>]*>/gi;
const JAVASCRIPT_URL = /\b(?:href|src|action)\s*=\s*["']?\s*javascript:/gi;
// A tag, then whole attributes (quoted values are skipped, so text such as
// aria-label="turn on x=1" is not read as a handler), then an on* attribute.
const INLINE_HANDLER = /<[a-zA-Z][^\s/>]*(?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>`]+))?)*?\s+on[a-z]+\s*=/gi;

const sha256Token = (body) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
const executableScripts = (html) => [...html.matchAll(SCRIPT_TAG)]
  .filter(([, attrs]) => !/\btype=["']?application\/(ld\+)?json/i.test(attrs));

function servedSources() {
  const files = execFileSync('git', ['ls-files', '*.html', 'public/*.html', 'api/**.js', 'api/**.ts', 'server/**.ts'], {
    cwd: ROOT, encoding: 'utf8',
  }).split('\n').filter(Boolean);
  return [...new Set(files)].filter((f) =>
    !f.includes('/') || f.startsWith('public/') || f.startsWith('api/') || f.startsWith('server/'))
    .filter((f) => !/(^|\/)__tests__\/|\.test\.|\.d\.ts$/.test(f))
    .filter((f) => !(f in EXEMPT) && !EXEMPT_DIRS.some((d) => f.startsWith(d)));
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function blockedMarkup(file, text) {
  const failures = [];
  for (const m of text.matchAll(JAVASCRIPT_URL)) failures.push(`${file}:${lineOf(text, m.index)} javascript: URL`);
  for (const m of text.matchAll(INLINE_HANDLER)) failures.push(`${file}:${lineOf(text, m.index)} inline event handler`);
  return failures;
}

describe('inline handler and javascript: URL detection', () => {
  const handlers = (html) => [...html.matchAll(INLINE_HANDLER)].length;
  it('finds quoted, unquoted and uppercase handlers', () => {
    assert.equal(handlers('<button onclick="run()">'), 1);
    assert.equal(handlers("<button onclick='run()'>"), 1);
    assert.equal(handlers('<button onclick=run()>'), 1);
    assert.equal(handlers('<button ONCLICK=run()>'), 1);
    assert.equal(handlers('<img src="x.png" OnError = "f()">'), 1);
    assert.equal(handlers('<input disabled\n  onfocus=f()>'), 1);
  });
  it('ignores attributes that only contain "on"', () => {
    assert.equal(handlers('<button data-onclick="run()">'), 0);
    assert.equal(handlers('<a aria-label="turn on x=1" href="/">'), 0);
    assert.equal(handlers('<div title=\'click on=me\'>'), 0);
    assert.equal(handlers('<span class=icon one-click>'), 0);
    assert.equal(handlers('if (a<b && el.onclick) el.onclick = f;'), 0);
  });
  it('finds javascript: URLs', () => {
    assert.equal([...'<a href="javascript:history.back()">'.matchAll(JAVASCRIPT_URL)].length, 1);
    assert.equal([...'<a HREF=javascript:void(0)>'.matchAll(JAVASCRIPT_URL)].length, 1);
    assert.equal([...'<a href="/docs/javascript:guide">'.matchAll(JAVASCRIPT_URL)].length, 0);
  });
});

describe('served HTML runs under the site-wide CSP', () => {
  it('reads the site-wide script-src', () => {
    assert.ok(scriptSrc.includes("'strict-dynamic'"), 'the sweep assumes the strict-dynamic catch-all CSP');
    assert.ok(!scriptSrc.includes("'unsafe-inline'"));
  });

  it('every exemption still exists and, when it claims its own CSP, has one', () => {
    for (const [file, route] of Object.entries(EXEMPT)) {
      assert.ok(existsSync(new URL(file, ROOT)), `stale exemption: ${file}`);
      if (route) assert.ok(cspRules.some((rule) => rule.source === route), `${file} claims its own CSP at ${route}`);
    }
    for (const [file, routes] of Object.entries(ROUTE_CSP_FILES)) {
      assert.ok(existsSync(new URL(file, ROOT)), `stale route-CSP entry: ${file}`);
      for (const route of routes) assert.notEqual(effectiveCsp(route), siteCsp, `${file} claims its own CSP at ${route}`);
    }
  });

  it('no inline script, javascript: URL or inline event handler is blocked', () => {
    const failures = [];
    for (const file of servedSources()) {
      const text = readFileSync(new URL(file, ROOT), 'utf8');
      if (!/<script\b|javascript:|<[a-z]/i.test(text)) continue;
      const isTemplate = /\.(js|ts)$/.test(file);

      if (!(file in ROUTE_CSP_FILES)) {
        for (const m of text.matchAll(SCRIPT_TAG)) {
          const [, attrs, body] = m;
          if (/\btype=["']?application\/(ld\+)?json/i.test(attrs)) continue; // data, never executed
          const nonce = /\bnonce=["']([^"']+)["']/.exec(attrs)?.[1];
          if (nonce && scriptSrc.includes(`'nonce-${nonce}'`)) continue;
          // A template's script body is filled per request, so only a nonce can match it.
          if (!isTemplate && scriptSrc.includes(sha256Token(body))) continue;
          failures.push(`${file}:${lineOf(text, m.index)} <script${attrs}> has no allowed nonce${isTemplate ? '' : ' or hash'}`);
        }
      }
      failures.push(...blockedMarkup(file, text));
    }
    for (const file of PRO_SOURCES) {
      failures.push(...blockedMarkup(file, readFileSync(new URL(file, ROOT), 'utf8')));
    }
    assert.deepEqual(failures, [], `blocked by the site-wide CSP:\n  ${failures.join('\n  ')}`);
  });
});

// Pages whose inline scripts are allowed by hash under a route CSP. The hash
// is computed from the rendered page, so editing a script without updating
// vercel.json (and the docker nginx copy) fails here.
const ROUTE_PAGES = [
  {
    name: 'OAuth consent page',
    routes: ROUTE_CSP_FILES['api/oauth/authorize.js'],
    nginx: 'docker/nginx-oauth-authorize-security-headers.conf',
    render: () => consentPage({ client_name: 'Claude', redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }, 'n').text(),
  },
  {
    // Also document.write()n into the consent page after a failed POST, where
    // it runs under the consent page's CSP: the same route rule.
    name: 'OAuth error page',
    routes: ROUTE_CSP_FILES['api/oauth/authorize.js'],
    nginx: 'docker/nginx-oauth-authorize-security-headers.conf',
    render: async () => (await authorizeHandler(new Request('https://api.worldmonitor.app/oauth/authorize'))).text(),
  },
  {
    name: 'Pro OAuth error page',
    routes: ROUTE_CSP_FILES['api/oauth/authorize-pro.ts'],
    nginx: 'docker/nginx-oauth-authorize-security-headers.conf',
    render: async () => (await authorizeProHandler(new Request('https://api.worldmonitor.app/oauth/authorize-pro'), {})).text(),
  },
  {
    name: 'YouTube embed page',
    routes: ROUTE_CSP_FILES['api/youtube/embed.js'],
    nginx: 'docker/nginx-youtube-embed-security-headers.conf',
    render: async () => (await youtubeEmbedHandler(new Request('https://worldmonitor.app/api/youtube/embed?videoId=iEpJwprxDdk'))).text(),
  },
];

function nginxCsp(file) {
  const line = readFileSync(new URL(file, ROOT), 'utf8').split('\n')
    .find((l) => l.startsWith('add_header Content-Security-Policy "'));
  return line?.match(/^add_header Content-Security-Policy "(.*)" always;/)?.[1];
}

// Everything but script-src must stay the site-wide policy, so the route
// rules cannot drift from it.
const withoutScriptSrc = (csp) => csp.split(';').map((d) => d.trim()).filter((d) => !d.startsWith('script-src ')).join('; ');

describe('route CSPs allow their page scripts by hash', () => {
  for (const page of ROUTE_PAGES) {
    it(`${page.name}: every inline script is listed by hash, with no static nonce`, async () => {
      const scripts = executableScripts(await page.render());
      assert.ok(scripts.length > 0, `${page.name} must render its inline script`);
      for (const route of page.routes) {
        const routeScriptSrc = tokens(effectiveCsp(route), 'script-src');
        assert.ok(!routeScriptSrc.includes(STATIC_NONCE), `${route} must not trust the static nonce`);
        for (const [, attrs, body] of scripts) {
          assert.doesNotMatch(attrs, /\bnonce=/, `${page.name} must not carry the static nonce`);
          assert.ok(routeScriptSrc.includes(sha256Token(body)), `${route} CSP must list ${sha256Token(body)}`);
        }
      }
    });

    it(`${page.name}: docker nginx mirrors the route script-src`, () => {
      const csp = nginxCsp(page.nginx);
      assert.ok(csp, `${page.nginx} must set a Content-Security-Policy`);
      assert.equal(directive(csp, 'script-src'), directive(effectiveCsp(page.routes[0]), 'script-src'));
      assert.equal(withoutScriptSrc(csp), withoutScriptSrc(nginxCsp('docker/nginx-security-headers.conf')));
    });
  }

  it('YouTube embed lists the hosts its player script loads from, for browsers without strict-dynamic', async () => {
    const html = await youtubeEmbedHandler(new Request('https://worldmonitor.app/api/youtube/embed?videoId=iEpJwprxDdk')).then((r) => r.text());
    const loaded = [...html.matchAll(/\.src\s*=\s*'(https:\/\/[^/']+)\//g)].map((m) => m[1]);
    assert.deepEqual(loaded, ['https://www.youtube.com']);
    const routeScriptSrc = tokens(effectiveCsp('/api/youtube/embed'), 'script-src');
    assert.ok(routeScriptSrc.includes("'strict-dynamic'"));
    for (const host of loaded) assert.ok(routeScriptSrc.includes(host), `/api/youtube/embed script-src must list ${host}`);
  });

  it('route rules differ from the site-wide CSP only in script-src', () => {
    for (const route of Object.values(ROUTE_CSP_FILES).flat()) {
      assert.equal(withoutScriptSrc(effectiveCsp(route)), withoutScriptSrc(siteCsp), route);
    }
  });

  it('docker nginx serves the route header sets on the proxied routes', () => {
    const template = readFileSync(new URL('docker/nginx.conf.template', ROOT), 'utf8');
    const dockerfile = readFileSync(new URL('docker/Dockerfile', ROOT), 'utf8');
    assert.match(template, /location ~ \^\/api\/oauth\/\(authorize\|authorize-pro\)\$ \{\n\s+include \/etc\/nginx\/oauth_authorize_security_headers\.conf;/);
    assert.match(template, /location = \/api\/youtube\/embed \{\n\s+include \/etc\/nginx\/youtube_embed_security_headers\.conf;/);
    assert.match(dockerfile, /COPY docker\/nginx-oauth-authorize-security-headers\.conf \/etc\/nginx\/oauth_authorize_security_headers\.conf/);
    assert.match(dockerfile, /COPY docker\/nginx-youtube-embed-security-headers\.conf \/etc\/nginx\/youtube_embed_security_headers\.conf/);
    // Every other header must match the site-wide nginx set.
    const otherHeaders = (file) => readFileSync(new URL(file, ROOT), 'utf8').split('\n')
      .filter((l) => l.startsWith('add_header ') && !l.startsWith('add_header Content-Security-Policy '));
    for (const file of ['docker/nginx-oauth-authorize-security-headers.conf', 'docker/nginx-youtube-embed-security-headers.conf']) {
      assert.deepEqual(otherHeaders(file), otherHeaders('docker/nginx-security-headers.conf'), file);
    }
  });
});
