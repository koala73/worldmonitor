import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BLOG_CONVERSION_EVENT,
  BLOG_CONVERSION_MEDIUM,
  BLOG_CONVERSION_SOURCE,
  BLOG_PRODUCT_URLS,
  normalizeBlogAttributionToken,
} from '../blog-site/src/lib/blog-conversion-attribution.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

describe('blog conversion attribution', () => {
  it('keeps internal product links clean so inbound acquisition UTMs survive', () => {
    assert.equal(BLOG_PRODUCT_URLS.dashboard, 'https://www.worldmonitor.app/');
    assert.equal(BLOG_PRODUCT_URLS.pro, 'https://www.worldmonitor.app/pro');
    assert.equal(new URL(BLOG_PRODUCT_URLS.pro).search, '');
    assert.equal(BLOG_CONVERSION_SOURCE, 'worldmonitor-blog');
    assert.equal(BLOG_CONVERSION_MEDIUM, 'owned-content');
  });

  it('normalizes empty and high-cardinality values', () => {
    assert.equal(normalizeBlogAttributionToken(undefined, 'fallback'), 'fallback');
    assert.equal(normalizeBlogAttributionToken('  ///  ', 'fallback'), 'fallback');
    assert.equal(
      normalizeBlogAttributionToken('A'.repeat(150), 'fallback').length,
      100,
    );
  });

  it('keeps the shared templates on the measurable, post-launch CTA contract', () => {
    const base = readFileSync(
      resolve(root, 'blog-site/src/layouts/Base.astro'),
      'utf8',
    );
    const post = readFileSync(
      resolve(root, 'blog-site/src/layouts/BlogPost.astro'),
      'utf8',
    );
    const trackedLink = readFileSync(
      resolve(root, 'blog-site/src/components/TrackedProductLink.astro'),
      'utf8',
    );

    assert.doesNotMatch(base, /#waitlist|Get Early Access/);
    assert.match(base, /TrackedProductLink/);
    assert.match(base, /productFacts\.product\.primaryCtaLabel/);
    assert.match(base, /href=\{proCtaUrl\}/);
    assert.match(post, /Explore Pro/);
    assert.match(
      base,
      /data-domains="[^"]*\bwww\.worldmonitor\.app\b[^"]*"/,
    );
    assert.match(trackedLink, /BLOG_CONVERSION_EVENT/);
    assert.match(trackedLink, /data-umami-event-source/);
    assert.match(trackedLink, /data-umami-event-medium/);
    assert.match(post, /article-cta-dashboard/);
    assert.match(post, /article-cta-pro/);
    assert.equal(BLOG_CONVERSION_EVENT, 'blog-product-cta-click');
  });
});
