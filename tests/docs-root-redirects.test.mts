import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import middleware, { config as middlewareConfig } from '../middleware.ts';
import {
  ROOTLESS_DOC_REDIRECTS,
  buildRootlessDocsRedirects,
  getRootlessDocsDestination,
} from '../src/config/docs-root-redirects.ts';

const vercelConfig = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../vercel.json'), 'utf8')
) as {
  redirects: Array<{ source: string; destination: string }>;
  rewrites: Array<{ source: string; destination: string }>;
};

describe('rootless Mintlify route canonicalization', () => {
  it('derives current and future routes from docs navigation and aliases', () => {
    const routes = buildRootlessDocsRedirects({
      navigation: {
        tabs: [{
          groups: [{
            pages: [
              'future-page',
              { group: 'Nested', pages: ['future-section/future-page'] },
            ],
          }],
        }],
      },
      redirects: [{ source: '/old-future-page', destination: '/future-page' }],
    });

    assert.equal(routes.get('/future-page'), 'https://www.worldmonitor.app/docs/future-page');
    assert.equal(
      routes.get('/future-section/future-page'),
      'https://www.worldmonitor.app/docs/future-section/future-page'
    );
    assert.equal(routes.get('/old-future-page'), 'https://www.worldmonitor.app/docs/future-page');
  });

  it('covers every published string page in docs.json without a hand-maintained allowlist', () => {
    for (const path of [
      '/api-brief',
      '/mcp-tools-reference',
      '/architecture',
      '/methodology/chokepoints',
      '/panels/forecast',
    ]) {
      assert.ok(ROOTLESS_DOC_REDIRECTS.has(path), `missing generated docs route ${path}`);
    }
    assert.ok(ROOTLESS_DOC_REDIRECTS.size > 200, 'expected the complete Mintlify navigation, not a remediation list');
  });

  it('defers exact paths already owned by Vercel routes', () => {
    const exactVercelPaths = [...vercelConfig.redirects, ...vercelConfig.rewrites]
      .map((redirect) => redirect.source)
      .filter((source) => /^\/[a-z0-9.-]+$/.test(source));

    for (const path of exactVercelPaths.filter((source) => ROOTLESS_DOC_REDIRECTS.has(source))) {
      assert.equal(
        getRootlessDocsDestination(path),
        null,
        `${path} must preserve the earlier Vercel route contract`
      );
    }
  });

  it('defers SPA-reserved first segments that also appear in the docs map', () => {
    const catchAll = vercelConfig.rewrites.find((rewrite) => (
      rewrite.destination === '/dashboard.html' && rewrite.source.includes('(?!')
    ));
    assert.ok(catchAll, 'expected the SPA catch-all rewrite');
    const lookaheadStart = catchAll.source.indexOf('(?!');
    const lookaheadEnd = catchAll.source.lastIndexOf(').*)');
    assert.ok(lookaheadStart >= 0 && lookaheadEnd > lookaheadStart, 'expected a negative-lookahead catch-all');
    const reservedRoots = catchAll.source
      .slice(lookaheadStart + 3, lookaheadEnd)
      .split('|')
      .filter((token) => /^[a-z][a-z0-9-]*$/.test(token))
      .map((token) => `/${token}`);

    assert.ok(reservedRoots.includes('/sandbox'), 'SPA catch-all must still reserve sandbox');
    assert.ok(ROOTLESS_DOC_REDIRECTS.has('/sandbox'), 'docs still publishes sandbox; owned-path must keep deferring it');

    for (const path of reservedRoots.filter((root) => ROOTLESS_DOC_REDIRECTS.has(root))) {
      assert.equal(
        getRootlessDocsDestination(path),
        null,
        `${path} is reserved by the SPA catch-all and must not 308 to /docs`
      );
    }
  });

  it('redirects registered root and nested docs routes on every host', () => {
    for (const [host, path, expected] of [
      ['www.worldmonitor.app', '/api-brief', 'https://www.worldmonitor.app/docs/api-brief'],
      ['happy.worldmonitor.app', '/mcp-tools-reference/', 'https://www.worldmonitor.app/docs/mcp-tools-reference'],
      ['api.worldmonitor.app', '/architecture', 'https://www.worldmonitor.app/docs/architecture'],
      ['finance.worldmonitor.app', '/methodology/chokepoints', 'https://www.worldmonitor.app/docs/methodology/chokepoints'],
      ['commodity.worldmonitor.app', '/panels/forecast', 'https://www.worldmonitor.app/docs/panels/forecast'],
    ] as const) {
      const response = middleware(new Request(`https://${host}${path}?source=gsc`, {
        headers: { host, 'user-agent': 'Googlebot' },
      }));
      assert.ok(response instanceof Response, `${host}${path} must return a redirect`);
      assert.equal(response.status, 308);
      assert.equal(response.headers.get('location'), `${expected}?source=gsc`);
    }
  });

  it('does not intercept product routes, unknown routes, or non-read methods', () => {
    for (const path of ['/pricing', '/changelog', '/country-intel', '/sandbox', '/sandbox/', '/sandbox/index.json']) {
      assert.equal(
        middleware(new Request(`https://www.worldmonitor.app${path}`, {
          headers: { host: 'www.worldmonitor.app', 'user-agent': 'Googlebot' },
        })),
        undefined,
        `${path} must keep the product sandbox/Vercel contract`
      );
    }
    assert.equal(
      middleware(new Request('https://www.worldmonitor.app/api-brief', {
        method: 'POST',
        headers: { host: 'www.worldmonitor.app', 'user-agent': 'Mozilla/5.0' },
      })),
      undefined
    );
  });

  it('matches future extensionless docs routes without intercepting static assets', () => {
    const routeMatcher = middlewareConfig.matcher.find((matcher) => matcher.startsWith('/((?!'));
    assert.ok(routeMatcher, 'expected a general extensionless-route middleware matcher');
    const routeRegex = new RegExp(`^${routeMatcher}$`);

    for (const path of [
      '/',
      '/api-brief',
      '/architecture',
      '/future-section/future-page',
      '/methodology/chokepoints',
      '/panels/forecast',
    ]) {
      assert.match(path, routeRegex, `middleware must inspect extensionless route ${path}`);
    }
    for (const path of ['/api/health', '/mcp', '/assets/app.js', '/docs/chunk.css']) {
      assert.doesNotMatch(path, routeRegex, `general matcher must leave ${path} to its dedicated route`);
    }
    assert.ok(middlewareConfig.matcher.includes('/api/:path*'));
    assert.ok(middlewareConfig.matcher.includes('/mcp'));
  });
});
