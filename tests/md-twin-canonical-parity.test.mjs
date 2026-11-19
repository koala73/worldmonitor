/**
 * Every Markdown twin must name exactly the canonical its HTML page declares.
 *
 * Regression for the trailing-slash drift (2026-10-24): static directory pages
 * (/blog/..., /sources/...) answer 200 at both /x and /x/, so the twin fetched
 * /x, never saw a redirect, and emitted .../x as canonical while the HTML said
 * .../x/. The twin now repeats the page's own <link rel="canonical">.
 *
 * Iterates the whole twin set, not one example: every www page in the main
 * sitemap plus every blog post and buying guide the blog builds.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { load } from 'js-yaml';

import { buildMarkdownTwinResponse } from '../api/_md-url-twin.ts';
import { declaredHtmlCanonical, pageCanonicalUrl } from '../shared/page-canonical.js';

const ORIGIN = 'https://www.worldmonitor.app';
const root = new URL('../', import.meta.url);

function sitemapPages() {
  const xml = readFileSync(new URL('public/sitemap-main.xml', root), 'utf8');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1])
    .filter((loc) => loc.startsWith(`${ORIGIN}/`) && loc !== `${ORIGIN}/`);
}

function blogPages() {
  const content = new URL('blog-site/src/content/', root);
  const posts = readdirSync(new URL('blog/', content))
    .filter((f) => /\.mdx?$/.test(f))
    .map((f) => `${ORIGIN}/blog/posts/${f.replace(/\.mdx?$/, '')}/`);
  const guides = readdirSync(new URL('guides/', content)).flatMap((category) =>
    readdirSync(new URL(`guides/${category}/`, content))
      .filter((f) => /\.mdx?$/.test(f))
      .map((f) => `${ORIGIN}/blog/${category}/${f.replace(/\.mdx?$/, '')}/`));
  return [`${ORIGIN}/blog/`, ...posts, ...guides];
}

const TWIN_SET = [...new Set([...sitemapPages(), ...blogPages()])];

/**
 * A stand-in for production static hosting: each page answers 200 at both its
 * slash and slash-less path, HTML carries the declared canonical, and the
 * text/markdown conversion carries none (Vercel's conversion drops <head>).
 */
function staticSite(pages) {
  const byPath = new Map();
  for (const canonical of pages) {
    const path = new URL(canonical).pathname;
    byPath.set(path, canonical);
    byPath.set(path.replace(/\/$/, '') || '/', canonical);
  }
  return async (input, init) => {
    const url = new URL(String(input));
    const canonical = byPath.get(url.pathname);
    if (!canonical) return new Response('# Not found\n', { status: 404 });
    const accept = new Headers(init?.headers).get('accept') ?? '';
    if (accept.startsWith('text/markdown')) {
      return new Response('---\ntitle: "Page"\n---\n\n# Page\n\nBody.\n', {
        status: 200,
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      });
    }
    return new Response(
      `<!doctype html><html><head><title>Page</title><link rel="canonical" href="${canonical}"></head><body><main><h1>Page</h1></main></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  };
}

function twinPathFor(canonical) {
  return `${new URL(canonical).pathname.replace(/\/$/, '')}.md`;
}

function linkCanonical(response) {
  return (response.headers.get('link') ?? '').match(/<([^>]+)>; rel="canonical"/)?.[1] ?? null;
}

describe('markdown twin canonical parity', () => {
  it('covers the real twin set, trailing-slash blog pages included', () => {
    assert.ok(TWIN_SET.length > 300, `twin set unexpectedly small: ${TWIN_SET.length}`);
    assert.ok(TWIN_SET.some((u) => u.startsWith(`${ORIGIN}/blog/best/`)));
    assert.ok(TWIN_SET.some((u) => u.startsWith(`${ORIGIN}/sources/`)));
    assert.ok(TWIN_SET.some((u) => !u.endsWith('/')), 'slash-less canonicals must be covered too');
  });

  const fetchImpl = staticSite(TWIN_SET);
  for (const method of ['GET', 'HEAD']) {
    it(`${method}: Link header and front-matter equal the HTML canonical for every twin`, async () => {
      const mismatches = [];
      for (const htmlCanonical of TWIN_SET) {
        const twinPath = twinPathFor(htmlCanonical);
        const response = await buildMarkdownTwinResponse(
          new Request(`${ORIGIN}${twinPath}`, { method }),
          twinPath,
          fetchImpl,
        );
        const header = linkCanonical(response);
        let front = null;
        if (method === 'GET') {
          const block = (await response.text()).match(/^---\n([\s\S]*?)\n---\n/);
          front = block ? load(block[1])?.canonical ?? null : null;
        }
        if (response.status !== 200 || header !== htmlCanonical || (method === 'GET' && front !== htmlCanonical)) {
          mismatches.push(`${twinPath}: status=${response.status} html=${htmlCanonical} link=${header} front=${front}`);
        }
      }
      assert.deepEqual(mismatches, []);
    });
  }
});

describe('shared page canonical helper', () => {
  it('reads the declared canonical whatever the attribute order or quoting', () => {
    assert.equal(declaredHtmlCanonical('<link rel="canonical" href="https://www.worldmonitor.app/a/">'), 'https://www.worldmonitor.app/a/');
    assert.equal(declaredHtmlCanonical("<link href='/b/' rel='canonical' />"), '/b/');
    assert.equal(declaredHtmlCanonical('<link rel=canonical href=/c/>'), '/c/');
    assert.equal(declaredHtmlCanonical('<link rel="alternate" href="/x">'), null);
    assert.equal(declaredHtmlCanonical(null), null);
  });

  it('matches canonical as an exact rel token', () => {
    assert.equal(declaredHtmlCanonical('<link rel="alternate canonical" href="/current/">'), '/current/');
    assert.equal(declaredHtmlCanonical('<link rel="CANONICAL alternate" href="/current/">'), '/current/');
    assert.equal(declaredHtmlCanonical('<link rel="canonicalized" href="/wrong/"><link rel="canonical" href="/current/">'), '/current/');
    assert.equal(declaredHtmlCanonical('<link data-rel="canonical" href="/wrong/">'), null);
  });

  it('reads href as an attribute rather than data-href or quoted text', () => {
    assert.equal(declaredHtmlCanonical('<link rel="canonical" data-href="/old/" href="/current/">'), '/current/');
    assert.equal(declaredHtmlCanonical('<link title="href=\'/old/\'" rel="canonical" href="/current/">'), '/current/');
  });

  it('honours a first-party declaration and falls back to the page URL otherwise', () => {
    assert.equal(pageCanonicalUrl(`${ORIGIN}/blog/x?utm_source=a`, `${ORIGIN}/blog/x/`), `${ORIGIN}/blog/x/`);
    assert.equal(pageCanonicalUrl(`${ORIGIN}/blog/x?a=1`, null), `${ORIGIN}/blog/x`);
    assert.equal(pageCanonicalUrl(`${ORIGIN}/blog/x`, 'https://evil.example/blog/x/'), `${ORIGIN}/blog/x`);
    assert.equal(pageCanonicalUrl(`${ORIGIN}/blog/x`, 'javascript:alert(1)'), `${ORIGIN}/blog/x`);
  });

  it('preserves the accepted canonical origin while removing query and fragment', () => {
    assert.equal(pageCanonicalUrl('https://tech.worldmonitor.app/agent/', `${ORIGIN}/agent/?utm_source=a#tools`), `${ORIGIN}/agent/`);
    assert.equal(pageCanonicalUrl(`${ORIGIN}/x`, 'https://worldmonitor.app/x/'), 'https://worldmonitor.app/x/');
  });
});

describe('canonical parity with the real agent HTML page', () => {
  const html = readFileSync(new URL('public/agent/index.html', root), 'utf8');
  const canonical = `${ORIGIN}/agent/`;

  for (const origin of [ORIGIN, 'https://tech.worldmonitor.app']) {
    for (const method of ['GET', 'HEAD']) {
      for (const representation of ['html', 'markdown']) {
        it(`${origin} ${method} with ${representation} sibling preserves the HTML declaration`, async () => {
          assert.equal(declaredHtmlCanonical(html), canonical);
          let fetchCount = 0;
          const response = await buildMarkdownTwinResponse(
            new Request(`${origin}/agent.md`, { method }),
            '/agent.md',
            async (_input, init) => {
              fetchCount += 1;
              const markdown = representation === 'markdown'
                && new Headers(init?.headers).get('accept').startsWith('text/markdown');
              const body = markdown ? '# World Monitor for AI agents\n' : html;
              return new Response(init?.method === 'HEAD' ? null : body, {
                headers: { 'content-type': markdown ? 'text/markdown' : 'text/html' },
              });
            },
          );

          assert.equal(response.status, 200);
          assert.equal(linkCanonical(response), canonical);
          assert.equal(fetchCount, method === 'GET' && representation === 'html' ? 1 : 2);
          const body = await response.text();
          if (method === 'GET') {
            const block = body.match(/^---\n([\s\S]*?)\n---\n/);
            assert.equal(load(block[1]).canonical, canonical);
          } else {
            assert.equal(body, '');
          }
        });
      }
    }
  }
});
