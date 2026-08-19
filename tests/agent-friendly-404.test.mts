import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import middleware from '../middleware.ts';
import {
  AGENT_NOT_FOUND_CONTENT_TYPE,
  AGENT_NOT_FOUND_INDEXES,
  AGENT_NOT_FOUND_PASSTHROUGH_PREFIXES,
  AGENT_NOT_FOUND_STATUS,
  buildAgentNotFoundMarkdown,
  isKnownPublicPagePath,
} from '../src/config/agent-not-found.ts';
import { CONTENT_CORPUS_PREFIXES } from '../scripts/discover-content-corpus-pages.mjs';

const vercelConfig = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../vercel.json'), 'utf8'),
) as {
  redirects: Array<{ source: string }>;
  rewrites: Array<{ source: string; destination: string }>;
};

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function call(path: string, method = 'GET'): Response | void {
  return middleware(
    new Request(`https://www.worldmonitor.app${path}`, {
      method,
      headers: { host: 'www.worldmonitor.app', 'user-agent': CHROME_UA },
    }),
  ) as Response | void;
}

function examplePathFromSource(source: string): string | null {
  if (source.includes('(?!')) return null;
  const path = source
    .replace(/:[A-Za-z0-9_]+(\([^)]+\))?/g, 'x')
    .replace(/\*+/g, 'x');
  if (!path.startsWith('/')) return null;
  if (/\.[A-Za-z0-9]+$/.test(path)) return null;
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

describe('agent-friendly 404s (orank agent-friendly-404)', () => {
  it('returns HTTP 404 markdown that points agents at sitemap, llms.txt, and docs', async () => {
    const res = call('/some-path-that-does-not-exist');
    assert.ok(res instanceof Response, 'unknown paths must not fall through as a soft-404');
    assert.equal(res.status, AGENT_NOT_FOUND_STATUS);
    assert.equal(res.headers.get('content-type'), AGENT_NOT_FOUND_CONTENT_TYPE);
    assert.match(res.headers.get('cache-control') ?? '', /no-store/);
    const body = await res.text();
    assert.ok(body.startsWith('# Not found'), 'body must be heading-led markdown, not an HTML app shell');
    assert.ok(body.includes('/some-path-that-does-not-exist'));
    assert.ok(body.includes(AGENT_NOT_FOUND_INDEXES.llmsTxt));
    assert.ok(body.includes(AGENT_NOT_FOUND_INDEXES.sitemap));
    assert.ok(body.includes(AGENT_NOT_FOUND_INDEXES.docs));
  });

  it('answers HEAD with 404 and no body', async () => {
    const res = call('/this-is-not-a-page', 'HEAD');
    assert.ok(res instanceof Response);
    assert.equal(res.status, AGENT_NOT_FOUND_STATUS);
    assert.equal(res.headers.get('content-type'), AGENT_NOT_FOUND_CONTENT_TYPE);
    assert.equal(await res.text(), '');
  });

  it('does not intercept known product routes or mutating methods', () => {
    for (const path of ['/', '/dashboard', '/stocks/AAPL', '/story', '/pro', '/docs/mcp', '/countries/united-states']) {
      assert.equal(call(path), undefined, `${path} must keep its vercel.json route`);
    }
    assert.equal(call('/some-path-that-does-not-exist', 'POST'), undefined);
  });

  it('404s leaked SPA guesses that used to soft-404 the dashboard (#6575, #6836)', async () => {
    for (const path of ['/country-intel', '/security', '/trust']) {
      const res = call(path);
      assert.ok(res instanceof Response, `${path} must 404`);
      assert.equal(res.status, 404);
    }
  });

  it('passthrough prefixes cover every crawlable corpus section', () => {
    for (const prefix of CONTENT_CORPUS_PREFIXES) {
      assert.ok(
        (AGENT_NOT_FOUND_PASSTHROUGH_PREFIXES as readonly string[]).includes(`/${prefix}`),
        `corpus prefix /${prefix} must not 404 real static pages`,
      );
    }
  });

  it('passthrough list covers every extensionless vercel.json redirect and rewrite source', () => {
    const sources = [...vercelConfig.redirects, ...vercelConfig.rewrites].map((rule) => rule.source);
    const missed: string[] = [];
    for (const source of sources) {
      const example = examplePathFromSource(source);
      if (!example) continue;
      if (!isKnownPublicPagePath(example)) missed.push(`${source} (example ${example})`);
    }
    assert.deepEqual(missed, [], 'new vercel.json routes must be added to AGENT_NOT_FOUND_PASSTHROUGH_PREFIXES');
  });

  it('does not reintroduce a rewrite that would 200 the markdown 404 body', () => {
    const markdown404 = vercelConfig.rewrites.find((rule) =>
      /not-found|404/.test(`${rule.source} ${rule.destination}`),
    );
    assert.equal(
      markdown404,
      undefined,
      'a rewrite to the markdown 404 would surface HTTP 200 (the orank soft-404)',
    );
  });

  it('keeps public/404.html in sync with the middleware markdown indexes', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../public/404.html'), 'utf8');
    assert.ok(html.startsWith('# Not found'), 'Vercel filesystem 404s must also be heading-led markdown');
    assert.ok(html.includes(AGENT_NOT_FOUND_INDEXES.llmsTxt));
    assert.ok(html.includes(AGENT_NOT_FOUND_INDEXES.sitemap));
    assert.ok(html.includes(AGENT_NOT_FOUND_INDEXES.docs));
    assert.equal(
      buildAgentNotFoundMarkdown('/missing').includes(AGENT_NOT_FOUND_INDEXES.llmsTxt),
      true,
    );
  });
});
