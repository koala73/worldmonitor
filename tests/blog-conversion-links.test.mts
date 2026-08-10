import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import {
  BLOG_CONVERSION_EVENT,
  BLOG_CONVERSION_MEDIUM,
  BLOG_CONVERSION_SOURCE,
  BLOG_PRODUCT_URLS,
  buildBlogProductLinkUrl,
  normalizeBlogAttributionToken,
} from '../blog-site/src/lib/blog-conversion-attribution.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function executeInlineUtmPropagation(incomingSearch: string, hrefs: Array<string | null>): Array<string | null> {
  const base = readFileSync(resolve(root, 'blog-site/src/layouts/Base.astro'), 'utf8');
  const script = base.match(
    /<script is:inline nonce="wm-static-bootstrap">([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(script, 'the inline UTM propagation script must remain present and CSP-authorized');

  const anchors = hrefs.map((initialHref) => {
    let href = initialHref;
    return {
      getAttribute(name: string): string | null {
        return name === 'href' ? href : null;
      },
      setAttribute(name: string, value: string): void {
        assert.equal(name, 'href');
        href = value;
      },
      currentHref(): string | null {
        return href;
      },
    };
  });
  const location = {
    href: `https://www.worldmonitor.app/blog/posts/example/${incomingSearch}`,
    get search(): string {
      return new URL(this.href).search;
    },
  };

  runInNewContext(script, {
    URL,
    URLSearchParams,
    window: { location },
    document: {
      querySelectorAll(selector: string) {
        assert.equal(selector, 'a[data-wm-content-link]');
        return anchors;
      },
    },
  });

  return anchors.map((anchor) => anchor.currentHref());
}

describe('blog conversion attribution', () => {
  it('keeps base product URLs clean and puts bounded attribution on handoffs', () => {
    assert.equal(BLOG_PRODUCT_URLS.dashboard, 'https://www.worldmonitor.app/dashboard');
    assert.equal(BLOG_PRODUCT_URLS.pro, 'https://www.worldmonitor.app/pro');
    assert.equal(new URL(BLOG_PRODUCT_URLS.pro).search, '');
    assert.equal(BLOG_CONVERSION_SOURCE, 'worldmonitor-blog');
    assert.equal(BLOG_CONVERSION_MEDIUM, 'owned-content');

    for (const destination of ['dashboard', 'pro', 'api', 'mcp'] as const) {
      const url = new URL(buildBlogProductLinkUrl(
        destination,
        `article-cta-${destination}`,
        'A useful article',
      ));
      assert.equal(url.searchParams.get('wm_content_source'), BLOG_CONVERSION_SOURCE);
      assert.equal(url.searchParams.get('wm_content_medium'), BLOG_CONVERSION_MEDIUM);
      assert.equal(url.searchParams.get('wm_content_campaign'), 'a-useful-article');
      assert.equal(url.searchParams.get('wm_content_destination'), destination);
      assert.equal(url.searchParams.get('wm_content_placement'), `article-cta-${destination}`);
      assert.equal(url.searchParams.has('ref'), false);
      assert.equal(url.searchParams.has('wm_referral'), false);
    }
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
    assert.match(trackedLink, /data-wm-content-link/);
    assert.match(trackedLink, /data-umami-event-source/);
    assert.match(trackedLink, /data-umami-event-medium/);
    assert.match(trackedLink, /data-umami-event-content-campaign/);
    assert.match(base, /utm_source/);
    assert.match(post, /article-cta-dashboard/);
    assert.match(post, /article-cta-pro/);
    assert.match(post, /article-cta-api/);
    assert.match(post, /article-cta-mcp/);
    assert.equal(BLOG_CONVERSION_EVENT, 'blog-product-cta-click');
  });

  it('executes the inline UTM propagation contract without clobbering destination values', () => {
    const hrefs = executeInlineUtmPropagation(
      `?utm_source=inbound&utm_source=second&utm_medium=email&utm_campaign=${'x'.repeat(120)}&utm_term=term&utm_content=button&ref=affiliate&wm_referral=partner`,
      [
        'https://www.worldmonitor.app/dashboard?utm_source=destination&utm_medium=existing',
        '/pro?utm_campaign=article',
        null,
      ],
    );

    const dashboard = new URL(hrefs[0]!);
    assert.equal(dashboard.searchParams.get('utm_source'), 'destination');
    assert.equal(dashboard.searchParams.get('utm_medium'), 'existing');
    assert.equal(dashboard.searchParams.get('utm_campaign')?.length, 100);
    assert.equal(dashboard.searchParams.get('utm_term'), 'term');
    assert.equal(dashboard.searchParams.get('utm_content'), 'button');
    assert.equal(dashboard.searchParams.has('ref'), false);
    assert.equal(dashboard.searchParams.has('wm_referral'), false);

    const pro = new URL(hrefs[1]!);
    assert.equal(pro.searchParams.get('utm_source'), 'inbound');
    assert.equal(pro.searchParams.get('utm_campaign'), 'article');
    assert.equal(hrefs[2], null);
  });
});
