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
  HUMAN_NOT_FOUND_CONTENT_TYPE,
  buildAgentNotFoundMarkdown,
  buildHumanNotFoundHtml,
  isKnownPublicPagePath,
  prefersAgentNotFound,
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
const CHROME_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const CURL_UA = 'curl/8.4.0';

function call(
  path: string,
  init: { method?: string; ua?: string; accept?: string } = {},
): Response | void {
  const headers: Record<string, string> = {
    host: 'www.worldmonitor.app',
    'user-agent': init.ua ?? CURL_UA,
  };
  if (init.accept !== undefined) headers.accept = init.accept;
  return middleware(
    new Request(`https://www.worldmonitor.app${path}`, {
      method: init.method ?? 'GET',
      headers,
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

describe('prefersAgentNotFound (content negotiation)', () => {
  it('treats browser Accept: text/html as a human 404', () => {
    assert.equal(prefersAgentNotFound(CHROME_ACCEPT), false);
    assert.equal(prefersAgentNotFound('text/html'), false);
  });

  it('treats curl */*, missing Accept, and text/markdown as agent 404s', () => {
    assert.equal(prefersAgentNotFound('*/*'), true);
    assert.equal(prefersAgentNotFound(null), true);
    assert.equal(prefersAgentNotFound(''), true);
    assert.equal(prefersAgentNotFound('text/markdown'), true);
    assert.equal(prefersAgentNotFound('text/html;q=0.8, text/markdown'), true);
  });
});

describe('agent-friendly 404s (orank agent-friendly-404)', () => {
  it('returns HTTP 404 markdown that points agents at sitemap, llms.txt, and docs', async () => {
    const res = call('/some-path-that-does-not-exist', { accept: '*/*' });
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

  it('answers agent HEAD with 404 markdown and no body', async () => {
    const res = call('/this-is-not-a-page', { method: 'HEAD', accept: '*/*' });
    assert.ok(res instanceof Response);
    assert.equal(res.status, AGENT_NOT_FOUND_STATUS);
    assert.equal(res.headers.get('content-type'), AGENT_NOT_FOUND_CONTENT_TYPE);
    assert.equal(await res.text(), '');
  });

  it('serves browsers an HTML 404 instead of the agent markdown body', async () => {
    const res = call('/some-path-that-does-not-exist', {
      ua: CHROME_UA,
      accept: CHROME_ACCEPT,
    });
    assert.ok(res instanceof Response, 'humans must still get a real HTTP 404, not a soft-404 SPA');
    assert.equal(res.status, AGENT_NOT_FOUND_STATUS);
    assert.equal(res.headers.get('content-type'), HUMAN_NOT_FOUND_CONTENT_TYPE);
    const body = await res.text();
    assert.match(body, /<!DOCTYPE html>/i);
    assert.match(body, /<html/i);
    assert.match(body, /Page not found/i);
    assert.doesNotMatch(body, /^# Not found/m);
    assert.ok(body.includes('/dashboard'));
    assert.ok(body.includes(AGENT_NOT_FOUND_INDEXES.docs.replace('https://www.worldmonitor.app', '')));
  });

  it('answers browser HEAD with 404 HTML and no body', async () => {
    const res = call('/this-is-not-a-page', {
      method: 'HEAD',
      ua: CHROME_UA,
      accept: CHROME_ACCEPT,
    });
    assert.ok(res instanceof Response);
    assert.equal(res.status, AGENT_NOT_FOUND_STATUS);
    assert.equal(res.headers.get('content-type'), HUMAN_NOT_FOUND_CONTENT_TYPE);
    assert.equal(await res.text(), '');
  });

  it('HTML-escapes a hostile path in the human 404 body', () => {
    const body = buildHumanNotFoundHtml('/<script>alert(1)</script>');
    assert.ok(body.includes('&lt;script&gt;'));
    assert.doesNotMatch(body, /<script>alert\(1\)<\/script>/);
  });

  it('does not intercept known product routes or mutating methods', () => {
    for (const path of ['/', '/dashboard', '/stocks/AAPL', '/story', '/pro', '/docs/mcp', '/countries/united-states']) {
      assert.equal(call(path, { accept: '*/*' }), undefined, `${path} must keep its vercel.json route`);
    }
    assert.equal(call('/some-path-that-does-not-exist', { method: 'POST', accept: '*/*' }), undefined);
  });

  it('404s leaked SPA guesses that used to soft-404 the dashboard (#6575, #6836)', async () => {
    for (const path of ['/country-intel', '/security', '/trust']) {
      const res = call(path, { accept: '*/*' });
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

  it('keeps public/404.html as the human HTML filesystem 404', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../public/404.html'), 'utf8');
    assert.equal(html, buildHumanNotFoundHtml());
    assert.match(html, /<!DOCTYPE html>/i, 'Vercel filesystem 404s must be a human HTML page');
    assert.match(html, /Page not found/i);
    assert.ok(html.includes('/dashboard'));
    assert.ok(html.includes('/docs/documentation'));
    assert.doesNotMatch(html, /^# Not found/m);
    assert.equal(
      buildAgentNotFoundMarkdown('/missing').includes(AGENT_NOT_FOUND_INDEXES.llmsTxt),
      true,
    );
  });
});
