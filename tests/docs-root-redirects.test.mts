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

  it('defers Vercel-owned first segments that also appear in the docs map', () => {
    // #6575: the SPA catch-all lookahead this used to parse is gone. Pin the
    // product-owned roots from getRootlessDocsDestination's allowlist instead
    // of reconstructing them from a deleted rewrite.
    const vercelOwnedDocPaths = ['/about', '/changelog', '/contact', '/pricing', '/privacy', '/sandbox', '/support', '/terms'];
    assert.ok(ROOTLESS_DOC_REDIRECTS.has('/sandbox'), 'docs still publishes sandbox; owned-path must keep deferring it');

    const catchAll = vercelConfig.rewrites.find((rewrite) => (
      rewrite.destination === '/dashboard.html' && rewrite.source.includes('(?!')
    ));
    assert.equal(catchAll, undefined, 'dashboard catch-all rewrite must stay removed (#6575)');

    for (const path of vercelOwnedDocPaths.filter((root) => ROOTLESS_DOC_REDIRECTS.has(root))) {
      assert.equal(
        getRootlessDocsDestination(path),
        null,
        `${path} is Vercel-owned and must not 308 to /docs`
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

  it('does not intercept product routes or non-read methods', () => {
    for (const path of ['/pricing', '/changelog', '/sandbox', '/sandbox/', '/sandbox/index.json']) {
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

  it('lets the agent-friendly 404 handle unknown extensionless routes', () => {
    const response = middleware(new Request('https://www.worldmonitor.app/country-intel', {
      headers: { host: 'www.worldmonitor.app', 'user-agent': 'Googlebot' },
    }));
    assert.ok(response instanceof Response, '/country-intel is not a product route and must 404');
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /text\/markdown/);
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
