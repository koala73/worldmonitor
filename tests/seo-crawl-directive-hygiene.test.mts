import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import middleware from '../middleware';
import { INDEXABLE_ROBOTS_CONTENT } from '../src/config/seo-robots';
import {
  VARIANT_SEO_PARAGRAPHS,
  variantSeoWordCount,
} from '../src/config/variant-seo-summaries';
import { WEB_DASHBOARD_VARIANTS } from '../src/config/variant-dashboard-html';
import { INDEXABLE_ROBOTS_CONTENT as SHARED_ROBOTS } from '../shared/seo-robots.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), 'utf8');

describe('SEO crawl-directive hygiene (#7380)', () => {
  it('keeps the robots constant synchronized across TS and script mirrors', () => {
    assert.equal(INDEXABLE_ROBOTS_CONTENT, SHARED_ROBOTS);
    assert.match(INDEXABLE_ROBOTS_CONTENT, /max-image-preview:large/);
    assert.match(INDEXABLE_ROBOTS_CONTENT, /max-snippet:-1/);
  });

  it('ships uncapped snippet directives on homepage and dashboard shells', () => {
    const robotsRe = new RegExp(
      `name="robots" content="${INDEXABLE_ROBOTS_CONTENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`,
    );
    assert.match(read('index.html'), robotsRe);
    assert.match(read('pro-test/welcome.html'), robotsRe);
    assert.match(
      read('scripts/build-crawlable-corpus.mjs'),
      /robots = INDEXABLE_ROBOTS_CONTENT/,
    );
  });

  it('keeps each dashboard variant summary in the 300–500 word differentiation band', () => {
    for (const variant of ['full', ...WEB_DASHBOARD_VARIANTS]) {
      const words = variantSeoWordCount(variant);
      assert.ok(words >= 300, `${variant} SEO summary is ${words} words (<300)`);
      assert.ok(words <= 500, `${variant} SEO summary is ${words} words (>500)`);
      assert.ok(
        VARIANT_SEO_PARAGRAPHS[variant].length >= 4,
        `${variant} should have multiple differentiation paragraphs`,
      );
    }
  });

  it('embeds the full-dashboard SEO summary outside #app so hydration cannot wipe it', () => {
    const html = read('index.html');
    const summaryIdx = html.indexOf('<section class="app-seo-summary" aria-hidden="true">');
    const appIdx = html.indexOf('<div id="app">');
    assert.ok(summaryIdx > 0, 'missing app-seo-summary');
    assert.ok(appIdx > summaryIdx, 'SEO summary must precede #app');
    const summaryOpenTag = html.slice(summaryIdx, html.indexOf('>', summaryIdx) + 1);
    assert.doesNotMatch(
      summaryOpenTag,
      /aria-label=/,
      'crawler-only summary must stay out of the accessibility tree',
    );
    assert.match(html, /full-spectrum real-time global intelligence dashboard/i);
  });

  it('308-redirects bots away from ?ref= / utm_* duplicate dashboard URLs', () => {
    const res = middleware(
      new Request('https://finance.worldmonitor.app/dashboard?ref=welcome-pricing-free', {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)' },
      }),
    );
    assert.ok(res instanceof Response);
    assert.equal(res.status, 308);
    assert.equal(res.headers.get('location'), 'https://finance.worldmonitor.app/dashboard');
    assert.equal(res.headers.get('vary'), 'User-Agent');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  });

  it('leaves human traffic with referral params untouched for client capture', () => {
    const res = middleware(
      new Request('https://finance.worldmonitor.app/dashboard?ref=partner123', {
        headers: {
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        },
      }),
    );
    assert.equal(res, undefined);
  });

  it('passes AI crawlers through to the canonical variant dashboard', () => {
    const res = middleware(
      new Request('https://tech.worldmonitor.app/', {
        headers: { 'user-agent': 'Mozilla/5.0 GPTBot/1.1' },
      }),
    );
    assert.equal(res, undefined);
  });
});
