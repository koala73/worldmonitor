import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifySitemapUrl,
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

  it('accepts the canonical apex MCP URL in the root sitemap inventory', async () => {
    const mcpUrl = 'https://worldmonitor.app/mcp';
    const rootSitemap = 'https://www.worldmonitor.app/sitemap.xml';
    const blogSitemap = 'https://www.worldmonitor.app/blog/sitemap-index.xml';
    const docsSitemap = 'https://www.worldmonitor.app/docs/sitemap.xml';
    const responses = new Map([
      [
        'https://www.worldmonitor.app/robots.txt',
        `Sitemap: ${rootSitemap}\nSitemap: ${blogSitemap}\nSitemap: ${docsSitemap}\n`,
      ],
      [rootSitemap, `<urlset><url><loc>${mcpUrl}</loc></url></urlset>`],
      [blogSitemap, '<urlset><url><loc>https://www.worldmonitor.app/blog/</loc></url></urlset>'],
      [docsSitemap, '<urlset><url><loc>https://www.worldmonitor.app/docs/</loc></url></urlset>'],
      ['https://www.worldmonitor.app/blog/', '<html><head><link rel="canonical" href="https://www.worldmonitor.app/blog/"></head></html>'],
      ['https://www.worldmonitor.app/docs/', '<html><head><link rel="canonical" href="https://www.worldmonitor.app/docs/"></head></html>'],
      [mcpUrl, '# World Monitor MCP'],
    ]);
    const fetchImpl = async (url) => {
      const value = String(url);
      const isMcp = value === mcpUrl;
      const isPage = value.endsWith('/') || isMcp;
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
