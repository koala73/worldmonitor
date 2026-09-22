import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifySitemapUrl,
  fetchSitemapTree,
  inspectIndexability,
  parseSitemapDocument,
  verifyProductionSitemaps,
} from '../scripts/verify-sitemaps.mjs';

describe('production sitemap verifier helpers', () => {
  it('parses sitemap indexes and URL sets without mixing their ownership', () => {
    const index = parseSitemapDocument(`<?xml version="1.0"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://www.worldmonitor.app/blog/sitemap-0.xml</loc></sitemap>
      </sitemapindex>`);
    assert.deepEqual(index, {
      type: 'index',
      locations: ['https://www.worldmonitor.app/blog/sitemap-0.xml'],
    });

    const urlset = parseSitemapDocument(`<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://www.worldmonitor.app/</loc></url>
        <url><loc>https://www.worldmonitor.app/countries/norway/</loc></url>
      </urlset>`);
    assert.deepEqual(urlset, {
      type: 'urlset',
      locations: [
        'https://www.worldmonitor.app/',
        'https://www.worldmonitor.app/countries/norway/',
      ],
    });
    assert.throws(
      () => parseSitemapDocument(`
        <urlset>
          <url><loc>https://www.worldmonitor.app/</loc></url>
          <url><loc>https://www.worldmonitor.app/</loc></url>
        </urlset>`),
      /duplicate/i,
    );
    assert.throws(
      () => parseSitemapDocument('<urlset><url><loc>https://www.worldmonitor.app/</url></urlset>'),
      /invalid sitemap XML/i,
    );
  });

  it('classifies every root, blog, docs, variant, and corpus family', () => {
    assert.equal(classifySitemapUrl('https://www.worldmonitor.app/'), 'landing');
    assert.equal(classifySitemapUrl('https://www.worldmonitor.app/dashboard'), 'dashboard');
    assert.equal(classifySitemapUrl('https://worldmonitor.app/mcp'), 'mcp');
    assert.equal(classifySitemapUrl('https://tech.worldmonitor.app/dashboard'), 'dashboard-variant');
    assert.equal(classifySitemapUrl('https://www.worldmonitor.app/pro'), 'product');
    assert.equal(classifySitemapUrl('https://www.worldmonitor.app/pricing.md'), 'machine-readable');
    assert.equal(classifySitemapUrl('https://www.worldmonitor.app/countries/norway/'), 'countries');
    assert.equal(classifySitemapUrl('https://www.worldmonitor.app/chokepoints/suez-canal/'), 'chokepoints');
    assert.equal(classifySitemapUrl('https://www.worldmonitor.app/compare/worldmonitor-vs-acled/'), 'compare');
    assert.equal(classifySitemapUrl('https://www.worldmonitor.app/crises/ukraine-war/'), 'crises');
    assert.equal(classifySitemapUrl('https://www.worldmonitor.app/tools/natural-hazard-pulse/'), 'tools');
    assert.equal(classifySitemapUrl('https://www.worldmonitor.app/research/strait-of-hormuz-transit-report-2026-07/'), 'research');
    assert.equal(classifySitemapUrl('https://www.worldmonitor.app/reference/changelog/'), 'reference');
    assert.equal(classifySitemapUrl('https://www.worldmonitor.app/blog/posts/example/'), 'blog');
    assert.equal(classifySitemapUrl('https://www.worldmonitor.app/docs/get-started'), 'docs');
  });

  it('reads canonical and noindex signals from HTML and HTTP headers', () => {
    const html = inspectIndexability({
      url: 'https://www.worldmonitor.app/countries/norway/',
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      body: '<html><head><link rel="canonical" href="https://www.worldmonitor.app/countries/norway/"><meta name="robots" content="index, follow"></head></html>',
    });
    assert.equal(html.canonical, 'https://www.worldmonitor.app/countries/norway/');
    assert.equal(html.indexable, true);

    const markdown = inspectIndexability({
      url: 'https://www.worldmonitor.app/pricing.md',
      headers: new Headers({
        'content-type': 'text/markdown; charset=utf-8',
        link: '<https://www.worldmonitor.app/pricing.md>; rel="canonical"',
        'x-robots-tag': 'noindex',
      }),
      body: '# Pricing',
    });
    assert.equal(markdown.canonical, 'https://www.worldmonitor.app/pricing.md');
    assert.equal(markdown.indexable, false);
  });

  it('rejects conflicting canonical signals instead of giving the HTTP header priority', () => {
    const url = 'https://www.worldmonitor.app/docs/zh/country-instability-index';
    const inspect = (htmlHref) => inspectIndexability({
      url,
      headers: new Headers({
        'content-type': 'text/html',
        link: `</docs/llms.txt>; rel="llms-txt", <${url}>; title="CII, documentation"; rel="canonical"`,
      }),
      body: `<html><head><link href="${htmlHref}" rel="canonical"></head></html>`,
    });
    const conflict = inspect('https://mirror.example/wm-proxy/docs/zh/country-instability-index');
    assert.equal(conflict.canonical, null);
    assert.match(conflict.canonicalErrors.join('\n'), /conflicting/i);
    assert.equal(conflict.canonicalDeclarations.length, 2);
    const agreement = inspect(url);
    assert.equal(agreement.canonical, url);
    assert.deepEqual(agreement.canonicalErrors, []);
  });

  it('reports duplicate, missing, invalid, relative and body-only docs canonicals', () => {
    const url = 'https://www.worldmonitor.app/docs/about';
    for (const [head, body, error] of [
      [`<link rel="canonical" href="${url}"><link rel="canonical" href="${url}">`, '', /duplicate/i],
      ['<link rel="canonical">', '', /missing.*href/i],
      ['<link rel="canonical" href="https://[broken">', '', /invalid/i],
      ['<link rel="canonical" href="/docs/about">', '', /absolute/i],
      [`<link data-rel="canonical" href="${url}">`, '', /missing/i],
      [`<link title="rel='canonical'" href="${url}">`, '', /missing/i],
      [`<link rel="canonical" data-href="${url}">`, '', /missing.*href/i],
      ['', `<link rel="canonical" href="${url}">`, /outside.*head/i],
      [`<!-- <link rel="canonical" href="${url}"> --><script>const example = '<link rel="canonical" href="${url}">';</script>`, '', /missing/i],
    ]) {
      const result = inspectIndexability({
        url, headers: new Headers({ 'content-type': 'text/html' }),
        body: `<html><head>${head}</head><body>${body}</body></html>`,
      });
      assert.match(result.canonicalErrors.join('\n'), error);
    }
  });

  it('does not lose earlier robots restrictions or apply another bot scope to Googlebot', () => {
    const inspect = (meta, header = '') => inspectIndexability({
      url: 'https://www.worldmonitor.app/docs/about',
      headers: new Headers({ 'content-type': 'text/html', 'x-robots-tag': header }),
      body: `<html><head>${meta}</head></html>`,
    });
    assert.equal(inspect('<meta name="robots" content="noindex"><meta name="robots" content="index">').indexable, false);
    assert.equal(inspect('<meta name="googlebot" content="none">').indexable, false);
    assert.equal(inspect('', 'googlebot: noindex, follow').indexable, false);
    assert.equal(inspect('', 'otherbot: noindex, googlebot: index').indexable, true);
    assert.equal(inspect('<meta name="robots" content="max-image-preview:none">').indexable, true);
    assert.equal(inspect('', 'max-image-preview: none').indexable, true);
    assert.equal(inspect('', 'googlebot: max-image-preview:none').indexable, true);
    assert.equal(inspect('', 'none').indexable, false);
    assert.equal(inspect('', 'max-image-preview:none, noindex').indexable, false);
  });

  it('parses each HTTP canonical without treating quoted Link parameters as declarations', () => {
    const url = 'https://www.worldmonitor.app/docs/about';
    const inspect = (link) => inspectIndexability({
      url, headers: new Headers({ 'content-type': 'text/html', link }),
      body: `<html><head><link rel="canonical" href="${url}"></head></html>`,
    });
    assert.match(inspect(`<${url}>; rel="canonical", <${url}>; rel="canonical"`).canonicalErrors.join('\n'), /duplicate http/);
    assert.match(inspect(`<${url}>; rel="canonical", invalid; rel="canonical"`).canonicalErrors.join('\n'), /missing href/);
    assert.deepEqual(inspect(`<${url}>; title="example, <not-a-link>; rel='canonical'"; rel="alternate"`).canonicalErrors, []);
  });

  it('GET-checks both CII locales and rejects conflicting canonicals or missing locales', async () => {
    const origin = 'https://www.worldmonitor.app';
    const pages = ['/', '/blog/', '/docs/about', '/docs/country-instability-index', '/docs/zh/country-instability-index'];
    const documents = new Map([
      [`${origin}/robots.txt`, `Sitemap: ${origin}/sitemap.xml\nSitemap: ${origin}/blog/sitemap-index.xml\nSitemap: ${origin}/docs/sitemap.xml`],
      [`${origin}/sitemap.xml`, `<sitemapindex>${['/sitemap-main.xml', '/blog/sitemap-index.xml', '/docs/sitemap.xml'].map(path => `<sitemap><loc>${origin}${path}</loc></sitemap>`).join('')}</sitemapindex>`],
      ...[['/sitemap-main.xml', pages.slice(0, 1)], ['/blog/sitemap-index.xml', pages.slice(1, 2)], ['/docs/sitemap.xml', pages.slice(2)]].map(([path, paths]) => [
        `${origin}${path}`, `<urlset>${paths.map(page => `<url><loc>${origin}${page}</loc></url>`).join('')}</urlset>`,
      ]),
    ]);
    const fetches = [];
    let conflicting = true;
    const fetchImpl = async (url, { method }) => {
      fetches.push({ url, method });
      if (documents.has(url)) return new Response(documents.get(url), { headers: { 'content-type': 'application/xml' } });
      const href = conflicting && url.includes('/zh/') ? 'https://mirror.example/docs/zh/country-instability-index' : url;
      return new Response(`<html><head><link rel="canonical" href="${href}"></head></html>`, {
        headers: { 'content-type': 'text/html', link: `<${url}>; rel="canonical"` },
      });
    };
    const result = await verifyProductionSitemaps({ fetchImpl });
    assert.equal(result.passed, false);
    assert.match(result.errors.join('\n'), /conflicting/i);
    for (const path of pages.slice(3)) {
      assert.ok(fetches.some(entry => entry.url === `${origin}${path}` && entry.method === 'GET'), path);
    }
    conflicting = false;
    assert.equal((await verifyProductionSitemaps({ fetchImpl })).passed, true);
    const sitemap = documents.get(`${origin}/docs/sitemap.xml`);
    for (const path of pages.slice(3)) {
      documents.set(`${origin}/docs/sitemap.xml`, sitemap.replace(`<url><loc>${origin}${path}</loc></url>`, ''));
      const missingLocale = await verifyProductionSitemaps({ fetchImpl });
      assert.equal(missingLocale.passed, false);
      assert.ok(missingLocale.errors.includes(`required docs page missing from sitemap: ${origin}${path}`));
    }
  });

  it('accepts the canonical apex MCP URL in the root sitemap inventory', async () => {
    const mcpUrl = 'https://worldmonitor.app/mcp';
    const rootSitemap = 'https://www.worldmonitor.app/sitemap.xml';
    const mainSitemap = 'https://www.worldmonitor.app/sitemap-main.xml';
    const blogSitemap = 'https://www.worldmonitor.app/blog/sitemap-index.xml';
    const docsSitemap = 'https://www.worldmonitor.app/docs/sitemap.xml';
    const responses = new Map([
      [
        'https://www.worldmonitor.app/robots.txt',
        `Sitemap: ${rootSitemap}\nSitemap: ${blogSitemap}\nSitemap: ${docsSitemap}\n`,
      ],
      [rootSitemap, `<sitemapindex>
        <sitemap><loc>${mainSitemap}</loc></sitemap>
        <sitemap><loc>${blogSitemap}</loc></sitemap>
        <sitemap><loc>${docsSitemap}</loc></sitemap>
      </sitemapindex>`],
      [mainSitemap, `<urlset><url><loc>${mcpUrl}</loc></url></urlset>`],
      [blogSitemap, '<urlset><url><loc>https://www.worldmonitor.app/blog/</loc></url></urlset>'],
      [docsSitemap, '<urlset><url><loc>https://www.worldmonitor.app/docs/</loc></url></urlset>'],
      ['https://www.worldmonitor.app/blog/', '<html><head><link rel="canonical" href="https://www.worldmonitor.app/blog/"></head></html>'],
      ['https://www.worldmonitor.app/docs/', '<html><head><link rel="canonical" href="https://www.worldmonitor.app/docs/"></head></html>'],
      [mcpUrl, '# World Monitor MCP'],
    ]);
    for (const path of ['/docs/country-instability-index', '/docs/zh/country-instability-index']) {
      const url = `https://www.worldmonitor.app${path}`;
      responses.set(docsSitemap, responses.get(docsSitemap).replace('</urlset>', `<url><loc>${url}</loc></url></urlset>`));
      responses.set(url, `<html><head><link rel="canonical" href="${url}"></head></html>`);
    }
    const fetchImpl = async (url) => {
      const value = String(url);
      const isMcp = value === mcpUrl;
      const isPage = value.endsWith('/') || value.endsWith('/country-instability-index') || isMcp;
      return new Response(responses.get(value), {
        status: responses.has(value) ? 200 : 404,
        headers: isMcp
          ? { 'content-type': 'text/markdown', link: `<${mcpUrl}>; rel="canonical"` }
          : { 'content-type': isPage ? 'text/html' : 'application/xml' },
      });
    };

    const result = await verifyProductionSitemaps({ fetchImpl });

    assert.equal(result.passed, true, result.errors.join('\n'));
    assert.equal(result.familySummary.mcp.urls, 1);
  });

  it('rejects a legacy root URL set when the canonical sitemap index is required', async () => {
    const rootSitemap = 'https://www.worldmonitor.app/sitemap.xml';
    const blogSitemap = 'https://www.worldmonitor.app/blog/sitemap-index.xml';
    const docsSitemap = 'https://www.worldmonitor.app/docs/sitemap.xml';
    const responses = new Map([
      [
        'https://www.worldmonitor.app/robots.txt',
        `Sitemap: ${rootSitemap}\nSitemap: ${blogSitemap}\nSitemap: ${docsSitemap}\n`,
      ],
      [rootSitemap, '<urlset><url><loc>https://www.worldmonitor.app/</loc></url></urlset>'],
      [blogSitemap, '<urlset><url><loc>https://www.worldmonitor.app/blog/</loc></url></urlset>'],
      [docsSitemap, '<urlset><url><loc>https://www.worldmonitor.app/docs/</loc></url></urlset>'],
      [
        'https://www.worldmonitor.app/',
        '<html><head><link rel="canonical" href="https://www.worldmonitor.app/"></head></html>',
      ],
      [
        'https://www.worldmonitor.app/blog/',
        '<html><head><link rel="canonical" href="https://www.worldmonitor.app/blog/"></head></html>',
      ],
      [
        'https://www.worldmonitor.app/docs/',
        '<html><head><link rel="canonical" href="https://www.worldmonitor.app/docs/"></head></html>',
      ],
    ]);
    const fetchImpl = async (url) => new Response(responses.get(String(url)), {
      status: responses.has(String(url)) ? 200 : 404,
      headers: {
        'content-type': String(url).endsWith('/') ? 'text/html' : 'application/xml',
      },
    });

    const result = await verifyProductionSitemaps({ fetchImpl });

    assert.equal(result.passed, false);
    assert.ok(result.errors.some((error) => /sitemap\.xml must be a sitemap index/.test(error)));
  });

  it('fails when multiple sitemap owners advertise the same canonical URL', async () => {
    const pageUrl = 'https://www.worldmonitor.app/blog/';
    const rootSitemap = 'https://www.worldmonitor.app/sitemap.xml';
    const blogSitemap = 'https://www.worldmonitor.app/blog/sitemap-index.xml';
    const docsSitemap = 'https://www.worldmonitor.app/docs/sitemap.xml';
    const responses = new Map([
      [
        'https://www.worldmonitor.app/robots.txt',
        `Sitemap: ${rootSitemap}\nSitemap: ${blogSitemap}\nSitemap: ${docsSitemap}\n`,
      ],
      [
        rootSitemap,
        `<urlset><url><loc>${pageUrl}</loc></url></urlset>`,
      ],
      [
        blogSitemap,
        `<urlset><url><loc>${pageUrl}</loc></url></urlset>`,
      ],
      [
        docsSitemap,
        '<urlset><url><loc>https://www.worldmonitor.app/docs/</loc></url></urlset>',
      ],
      [
        pageUrl,
        `<html><head><link rel="canonical" href="${pageUrl}"></head></html>`,
      ],
      [
        'https://www.worldmonitor.app/docs/',
        '<html><head><link rel="canonical" href="https://www.worldmonitor.app/docs/"></head></html>',
      ],
    ]);
    const fetchImpl = async (url) => new Response(responses.get(String(url)), {
      status: responses.has(String(url)) ? 200 : 404,
      headers: { 'content-type': String(url).endsWith('/') ? 'text/html' : 'application/xml' },
    });

    const result = await verifyProductionSitemaps({ fetchImpl });

    assert.equal(result.passed, false);
    assert.deepEqual(result.ownershipOverlaps, [{
      url: pageUrl,
      sitemaps: [rootSitemap, blogSitemap],
    }]);
    assert.ok(result.checks.every((check) => check.ok), 'ownership failure is independent of URL health');
    assert.ok(result.errors.some((error) => /owned by multiple sitemap documents/.test(error)));
    assert.ok(result.errors.some((error) => /root sitemap overlaps the blog inventory/.test(error)));
  });

  it('rejects unexpected robots references and unsafe page hosts without fetching them', async () => {
    const unexpectedSitemap = 'https://attacker.example/sitemap.xml';
    const fetches = [];
    const responses = new Map([
      [
        'https://www.worldmonitor.app/robots.txt',
        `Sitemap: https://www.worldmonitor.app/sitemap.xml\nSitemap: ${unexpectedSitemap}\n`,
      ],
      [
        'https://www.worldmonitor.app/sitemap.xml',
        '<urlset><url><loc>https://attacker.example/private</loc></url></urlset>',
      ],
    ]);
    const fetchImpl = async (url) => {
      fetches.push(String(url));
      return new Response(responses.get(String(url)), {
        status: responses.has(String(url)) ? 200 : 404,
        headers: { 'content-type': 'application/xml' },
      });
    };

    const result = await verifyProductionSitemaps({ fetchImpl });

    assert.equal(result.passed, false);
    assert.ok(result.errors.some((error) => /unexpected sitemap/.test(error)));
    assert.ok(result.errors.some((error) => /allowed canonical WorldMonitor URL/.test(error)));
    assert.ok(!fetches.includes(unexpectedSitemap));
    assert.ok(!fetches.includes('https://attacker.example/private'));
  });
});

describe('mixed-owner root index traversal', () => {
  it('validates index members under their own owning family', async () => {
    const bodies = {
      'https://www.worldmonitor.app/sitemap.xml': `<?xml version="1.0"?>
        <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>https://www.worldmonitor.app/sitemap-main.xml</loc></sitemap>
          <sitemap><loc>https://www.worldmonitor.app/blog/sitemap-index.xml</loc></sitemap>
          <sitemap><loc>https://www.worldmonitor.app/docs/sitemap.xml</loc></sitemap>
        </sitemapindex>`,
      'https://www.worldmonitor.app/sitemap-main.xml': `<?xml version="1.0"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://www.worldmonitor.app/dashboard</loc></url>
        </urlset>`,
      'https://www.worldmonitor.app/blog/sitemap-index.xml': `<?xml version="1.0"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://www.worldmonitor.app/blog/posts/example/</loc></url>
        </urlset>`,
      'https://www.worldmonitor.app/docs/sitemap.xml': `<?xml version="1.0"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://www.worldmonitor.app/docs/example</loc></url>
        </urlset>`,
    };
    const fetchImpl = async (url) => new Response(bodies[String(url)] ?? '', {
      status: bodies[String(url)] ? 200 : 404,
      headers: { 'content-type': 'application/xml' },
    });
    const { documents, urls, inventoryErrors } = await fetchSitemapTree(
      [{ url: 'https://www.worldmonitor.app/sitemap.xml', owner: 'root' }],
      fetchImpl,
      'https://www.worldmonitor.app',
    );
    assert.deepEqual(inventoryErrors, []);
    assert.equal(documents.length, 4);
    assert.ok(urls.has('https://www.worldmonitor.app/dashboard'));
    assert.ok(urls.has('https://www.worldmonitor.app/blog/posts/example/'));
    assert.ok(urls.has('https://www.worldmonitor.app/docs/example'));
  });

  it('rejects a nested index edge that crosses the inherited owner family', async () => {
    const rootSitemap = 'https://www.worldmonitor.app/sitemap.xml';
    const mainSitemap = 'https://www.worldmonitor.app/sitemap-main.xml';
    const blogSitemap = 'https://www.worldmonitor.app/blog/sitemap-index.xml';
    const docsSitemap = 'https://www.worldmonitor.app/docs/sitemap.xml';
    const fetches = [];
    const bodies = {
      [rootSitemap]: `<?xml version="1.0"?>
        <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>${mainSitemap}</loc></sitemap>
          <sitemap><loc>${blogSitemap}</loc></sitemap>
          <sitemap><loc>${docsSitemap}</loc></sitemap>
        </sitemapindex>`,
      [mainSitemap]: `<?xml version="1.0"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://www.worldmonitor.app/dashboard</loc></url>
        </urlset>`,
      [blogSitemap]: `<?xml version="1.0"?>
        <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>${docsSitemap}</loc></sitemap>
        </sitemapindex>`,
      [docsSitemap]: `<?xml version="1.0"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://www.worldmonitor.app/docs/example</loc></url>
        </urlset>`,
    };
    const fetchImpl = async (url) => {
      fetches.push(String(url));
      return new Response(bodies[String(url)] ?? '', {
        status: bodies[String(url)] ? 200 : 404,
        headers: { 'content-type': 'application/xml' },
      });
    };

    const { inventoryErrors } = await fetchSitemapTree(
      [{ url: rootSitemap, owner: 'root' }],
      fetchImpl,
      'https://www.worldmonitor.app',
    );

    assert.ok(inventoryErrors.some(
      (error) => error === `blog sitemap index points outside its owned path family: ${docsSitemap}`,
    ));
    assert.equal(fetches.filter((url) => url === docsSitemap).length, 1);
  });
});
