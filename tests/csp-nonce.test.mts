import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it, afterEach } from 'node:test';

import middleware, { config as middlewareConfig } from '../middleware.ts';
import {
  CSP_NONCE_PLACEHOLDER,
  RETIRED_STATIC_SCRIPT_NONCE,
  STAMPED_DOCUMENT_CACHE_CONTROL,
  STAMPED_DOCUMENT_CDN_CACHE_CONTROL,
  attributeNonces,
  policyNonces,
  stampCspDocument,
} from '../shared/csp-nonce.mjs';

const ROOT = new URL('..', import.meta.url);
const POLICY = "default-src 'self'; script-src 'self' 'strict-dynamic' 'sha256-abc='";
const DOCUMENT = `<!doctype html><script nonce="${CSP_NONCE_PLACEHOLDER}" src="/a.js"></script><script nonce="${CSP_NONCE_PLACEHOLDER}">var ready = true;</script>`;

const HEADER_FILES = [
  'vercel.json',
  'docker/nginx.conf',
  'docker/nginx.conf.template',
  'docker/nginx-security-headers.conf',
  'docker/nginx-embed-security-headers.conf',
  'docker/nginx-oauth-authorize-security-headers.conf',
  'docker/nginx-youtube-embed-security-headers.conf',
];

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function read(path: string): string {
  return readFileSync(new URL(path, ROOT), 'utf8');
}

function nonceAgreement(html: string, policy: string): void {
  const bodyNonces = attributeNonces(html);
  const headerNonces = policyNonces(policy);
  assert.ok(bodyNonces.length > 0, 'response should carry a script nonce');
  assert.deepEqual(headerNonces, [bodyNonces[0]]);
  assert.ok(bodyNonces.every((nonce) => nonce === headerNonces[0]));
  assert.equal(html.includes(CSP_NONCE_PLACEHOLDER), false);
  assert.equal(policy.includes(CSP_NONCE_PLACEHOLDER), false);
  assert.equal(policy.includes(RETIRED_STATIC_SCRIPT_NONCE), false);
}

describe('per-response CSP nonce', () => {
  it('stamps a fresh nonce that matches every script and differs across responses', () => {
    const first = stampCspDocument(DOCUMENT, POLICY);
    const second = stampCspDocument(DOCUMENT, POLICY);
    assert.ok(first && second);
    nonceAgreement(first.html, first.policy);
    nonceAgreement(second.html, second.policy);
    assert.notEqual(first.nonce, second.nonce);
    assert.match(first.policy, /script-src 'nonce-[^']+' 'self' 'strict-dynamic'/);
  });

  it('leaves the retired static nonce only in the shared constant', () => {
    let output = '';
    try {
      output = execFileSync('git', [
        'grep',
        '-l',
        '-F',
        RETIRED_STATIC_SCRIPT_NONCE,
      ], { cwd: new URL('.', ROOT), encoding: 'utf8' });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 1) throw error;
    }
    const hits = output.trim() ? output.trim().split('\n') : [];
    assert.deepEqual(hits, ['shared/csp-nonce.mjs']);
  });

  it('committed CSP headers do not allow the placeholder or the retired nonce', () => {
    const forbidden = [
      `'nonce-${RETIRED_STATIC_SCRIPT_NONCE}'`,
      `'nonce-${CSP_NONCE_PLACEHOLDER}'`,
    ];
    for (const file of HEADER_FILES) {
      const text = read(file);
      for (const token of forbidden) {
        assert.equal(text.includes(token), false, `${file} still allows ${token}`);
      }
    }
    const vercel = read('vercel.json');
    assert.equal(vercel.includes("'nonce-"), false, 'vercel.json must not ship a static script nonce');
    for (const file of ['docker/nginx.conf', 'docker/nginx-security-headers.conf']) {
      assert.match(read(file), /script-src 'self' 'strict-dynamic' 'nonce-\$request_id'/);
    }
    for (const file of ['docker/nginx.conf', 'docker/nginx.conf.template']) {
      const text = read(file);
      assert.match(text, new RegExp(`sub_filter '${CSP_NONCE_PLACEHOLDER}' '\\$request_id';`));
      assert.match(text, /sub_filter_once off;/);
    }
    assert.match(read('docker/nginx.conf'), /gzip_static off;/);
  });

  it('matches html documents in middleware and leaves hashed assets alone', () => {
    const routeMatcher = middlewareConfig.matcher.find((matcher) => matcher.startsWith('/((?!'));
    assert.ok(routeMatcher);
    const routeRegex = new RegExp(`^${routeMatcher}$`);
    for (const path of ['/', '/dashboard', '/settings.html', '/pro/index.html', '/blog/post']) {
      assert.match(path, routeRegex, path);
    }
    for (const path of ['/assets/app.js', '/assets/app.css', '/api/health', '/favicon.ico']) {
      assert.doesNotMatch(path, routeRegex, path);
    }
  });

  it('routes every dotted SPA rewrite into middleware', () => {
    const vercel = JSON.parse(read('vercel.json'));
    const dynamicHtml = vercel.rewrites.filter(
      ({ source, destination }: { source: string; destination: string }) =>
        source.includes(':') && destination.endsWith('.html'),
    );
    assert.ok(dynamicHtml.length > 0);
    for (const { source } of dynamicHtml) {
      const prefix = source.slice(0, source.indexOf(':'));
      assert.ok(
        middlewareConfig.matcher.includes(`${prefix}:path*`),
        `${source} needs ${prefix}:path* in config.matcher so a dotted value is stamped`,
      );
    }
  });

  it('middleware responses agree on the nonce, differ, and are not cached', async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = async (input, init) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(DOCUMENT, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', etag: '"built"' },
      });
    };
    const request = () => new Request('https://www.worldmonitor.app/dashboard?utm_source=x', {
      headers: {
        accept: 'text/html',
        'if-none-match': '"built"',
        'if-modified-since': 'Sat, 17 Oct 2026 00:00:00 GMT',
        range: 'bytes=0-10',
        cookie: 'session=secret',
      },
    });
    const first = await middleware(request());
    const second = await middleware(request());
    assert.ok(first instanceof Response && second instanceof Response);
    const firstHtml = await first.text();
    const secondHtml = await second.text();
    const firstPolicy = first.headers.get('content-security-policy') ?? '';
    const secondPolicy = second.headers.get('content-security-policy') ?? '';
    nonceAgreement(firstHtml, firstPolicy);
    nonceAgreement(secondHtml, secondPolicy);
    assert.notEqual(policyNonces(firstPolicy)[0], policyNonces(secondPolicy)[0]);
    assert.equal(first.headers.get('cache-control'), STAMPED_DOCUMENT_CACHE_CONTROL);
    assert.equal(first.headers.get('cdn-cache-control'), STAMPED_DOCUMENT_CDN_CACHE_CONTROL);
    assert.equal(first.headers.get('vercel-cdn-cache-control'), STAMPED_DOCUMENT_CDN_CACHE_CONTROL);
    assert.equal(first.headers.get('etag'), null);
    assert.equal(first.headers.get('x-middleware-override-headers'), null);
    // The inner fetch is a separate cache key (Cloudflare keys on URL, not on
    // request headers) and carries none of the client's validators.
    for (const call of seen) {
      const inner = new URL(call.url);
      assert.equal(inner.pathname, '/dashboard');
      assert.equal(inner.searchParams.get('wm-built'), '1');
      assert.equal(inner.searchParams.get('utm_source'), 'x');
      for (const name of ['if-none-match', 'if-modified-since', 'range', 'cookie']) {
        assert.equal(call.headers.get(name), null, name);
      }
      assert.equal(call.headers.get('accept'), 'text/html');
    }
  });

  it('stamps a request with no Accept header', async () => {
    let accept: string | null = null;
    globalThis.fetch = async (_input, init) => {
      accept = new Headers(init?.headers).get('accept');
      return new Response(DOCUMENT, { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const response = await middleware(new Request('https://www.worldmonitor.app/countries/'));
    assert.ok(response instanceof Response);
    nonceAgreement(await response.text(), response.headers.get('content-security-policy') ?? '');
    assert.equal(accept, 'text/html');
  });

  it('stamps a dotted stock symbol route', async () => {
    globalThis.fetch = async () =>
      new Response(DOCUMENT, { status: 200, headers: { 'content-type': 'text/html' } });
    const response = await middleware(new Request('https://www.worldmonitor.app/stocks/GLEN.L', {
      headers: { accept: 'text/html' },
    }));
    assert.ok(response instanceof Response);
    nonceAgreement(await response.text(), response.headers.get('content-security-policy') ?? '');
  });

  it('answers an uncached 503 when the document cannot be fetched', async () => {
    globalThis.fetch = async () => {
      throw new DOMException('timed out', 'TimeoutError');
    };
    const response = await middleware(new Request('https://www.worldmonitor.app/dashboard', {
      headers: { accept: 'text/html' },
    }));
    assert.ok(response instanceof Response);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), STAMPED_DOCUMENT_CACHE_CONTROL);
    assert.equal(response.headers.get('cdn-cache-control'), STAMPED_DOCUMENT_CDN_CACHE_CONTROL);
    assert.equal(response.headers.get('vercel-cdn-cache-control'), STAMPED_DOCUMENT_CDN_CACHE_CONTROL);
    assert.ok(!(await response.text()).includes(CSP_NONCE_PLACEHOLDER));
  });

  it('never re-fetches a page path that vercel.json rewrites to a handler', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: 'https://client.example/cb' } });
    };
    for (const path of [
      '/oauth/authorize-pro?nonce=n&grant=g',
      '/oauth/authorize',
      '/ask',
      '/a2a',
      '/agent/auth',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      assert.equal(await middleware(new Request(`https://www.worldmonitor.app${path}`, {
        headers: { accept: 'text/html' },
      })), undefined, path);
    }
    assert.equal(calls, 0);
  });

  it('passes through every representation Cloudflare never caches without a fetch', async () => {
    const { NEGOTIATED_MEDIA_TYPES, RSC_REQUEST_HEADERS } = await import('../scripts/cloudflare-cache-rule.mjs');
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(DOCUMENT, { status: 200, headers: { 'content-type': 'text/html' } });
    };
    for (const type of NEGOTIATED_MEDIA_TYPES) {
      assert.equal(await middleware(new Request('https://www.worldmonitor.app/countries/', {
        headers: { accept: type.toUpperCase() },
      })), undefined, type);
    }
    for (const name of RSC_REQUEST_HEADERS) {
      assert.equal(await middleware(new Request('https://www.worldmonitor.app/countries/', {
        headers: { accept: 'text/html', [name]: '1' },
      })), undefined, name);
    }
    assert.equal(calls, 0);
    // Accept values Cloudflare does cache are stamped.
    for (const accept of ['*/*', 'application/json']) {
      const response = await middleware(new Request('https://www.worldmonitor.app/countries/', {
        headers: { accept },
      }));
      assert.ok(response instanceof Response, accept);
    }
  });

  it('keeps the /api bot gate for a client that sends the old raw marker', async () => {
    const response = await middleware(new Request('https://www.worldmonitor.app/api/market/v1/list-market-quotes', {
      headers: { 'user-agent': 'curl/8.1.2', 'x-wm-csp-raw': '1' },
    }));
    assert.ok(response instanceof Response);
    assert.equal(response.status, 403);
  });

  it('does not stamp a platform redirect or a built-page inner fetch', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: 308, headers: { location: '/dashboard' } });
    };
    assert.equal(await middleware(new Request('https://tech.worldmonitor.app/', {
      headers: { accept: 'text/html' },
    })), undefined);
    assert.equal(calls, 1);

    calls = 0;
    assert.equal(await middleware(new Request('https://www.worldmonitor.app/settings.html?wm-built=1', {
      headers: { accept: 'text/html' },
    })), undefined);
    assert.equal(calls, 0);
  });
});
