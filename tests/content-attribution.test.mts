import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendContentAttributionToUrl,
  appendInboundUtmParams,
  captureContentAttributionFromUrl,
  CONTENT_ATTRIBUTION_STORAGE_KEY,
  getContentAttributionAnalyticsFields,
  inferLandingPageFamily,
  normalizeContentAttribution,
  parseContentAttribution,
  withContentAttribution,
} from '../shared/content-attribution.ts';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('content attribution contract', () => {
  it('parses direct handoffs into the closed reporting dimensions', () => {
    const attribution = parseContentAttribution(
      '?wm_content_source=worldmonitor-blog'
        + '&wm_content_medium=owned-content'
        + '&wm_content_campaign=country-risk'
        + '&wm_content_destination=dashboard'
        + '&wm_content_placement=article-cta-dashboard',
      '/dashboard',
    );

    assert.deepEqual(attribution, {
      source: 'worldmonitor-blog',
      medium: 'owned-content',
      campaign: 'country-risk',
      destination: 'dashboard',
      placement: 'article-cta-dashboard',
      landingPageFamily: 'dashboard',
    });
  });

  it('keeps destination URLs bounded and preserves existing query fields', () => {
    const url = new URL(appendContentAttributionToUrl(
      'https://www.worldmonitor.app/pro?ref=affiliate&utm_source=chatgpt.com#pricing',
      {
        source: 'worldmonitor-blog',
        medium: 'owned-content',
        campaign: 'country-risk',
        destination: 'pro',
        placement: 'article-cta-pro',
      },
    ));

    assert.equal(url.searchParams.get('ref'), 'affiliate');
    assert.equal(url.searchParams.get('utm_source'), 'chatgpt.com');
    assert.equal(url.searchParams.get('wm_content_destination'), 'pro');
    assert.equal(url.searchParams.get('wm_content_campaign'), 'country-risk');
    assert.equal(url.hash, '#pricing');
  });

  it('copies inbound UTMs without overwriting or copying affiliate parameters', () => {
    const url = new URL(appendInboundUtmParams(
      'https://www.worldmonitor.app/pro?ref=affiliate&utm_campaign=existing',
      '?utm_source=chatgpt.com&utm_campaign=inbound&utm_medium=referral&wm_referral=partner',
    ));

    assert.equal(url.searchParams.get('utm_source'), 'chatgpt.com');
    assert.equal(url.searchParams.get('utm_medium'), 'referral');
    assert.equal(url.searchParams.get('utm_campaign'), 'existing');
    assert.equal(url.searchParams.get('ref'), 'affiliate');
    assert.equal(url.searchParams.has('wm_referral'), false);
  });

  it('collapses unknown, malformed, and repeated values to bounded fallbacks', () => {
    const attribution = parseContentAttribution(
      '?wm_content_source=%3Cscript%3E'
        + '&wm_content_medium=owned-content'
        + '&wm_content_campaign=%3Cprompt%20text%3E'
        + '&wm_content_destination=not-a-product&wm_content_destination=pro'
        + '&wm_content_placement=unknown-placement',
      '/not-a-product',
    );

    assert.deepEqual(attribution, {
      source: 'unknown',
      medium: 'owned-content',
      campaign: 'unknown',
      destination: 'unknown',
      placement: 'unknown',
      landingPageFamily: 'unknown',
    });
  });

  it('sends only content dimensions to product events', () => {
    const attribution = normalizeContentAttribution({
      source: 'worldmonitor-blog',
      medium: 'owned-content',
      campaign: 'country-risk',
      destination: 'mcp',
      placement: 'article-cta-mcp',
      landingPageFamily: 'documentation',
    });
    const fields = getContentAttributionAnalyticsFields(attribution);

    assert.deepEqual(withContentAttribution({ eventValue: 'safe' }, attribution), {
      eventValue: 'safe',
      contentSource: 'worldmonitor-blog',
      contentMedium: 'owned-content',
      contentCampaign: 'country-risk',
      contentDestination: 'mcp',
      contentPlacement: 'article-cta-mcp',
      landingPageFamily: 'documentation',
    });
    assert.deepEqual(Object.keys(fields).sort(), [
      'contentCampaign',
      'contentDestination',
      'contentMedium',
      'contentPlacement',
      'contentSource',
      'landingPageFamily',
    ]);
  });

  it('maps product surfaces to scorecard page families', () => {
    assert.equal(inferLandingPageFamily('/'), 'homepage');
    assert.equal(inferLandingPageFamily('/pro'), 'pricing');
    assert.equal(inferLandingPageFamily('/mcp'), 'developer_mcp');
    assert.equal(inferLandingPageFamily('/docs/api-reference'), 'documentation');
    assert.equal(inferLandingPageFamily('/crafted-by-a-user'), 'unknown');
  });

  it('captures a direct handoff once, cleans the URL, and persists the record', () => {
    const storage = new MemoryStorage();
    const location = {
      href: 'https://www.worldmonitor.app/dashboard'
        + '?wm_content_source=worldmonitor-blog'
        + '&wm_content_medium=owned-content'
        + '&wm_content_campaign=country-risk'
        + '&wm_content_destination=dashboard'
        + '&wm_content_placement=article-cta-dashboard'
        + '&utm_source=chatgpt.com#overview',
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location,
        sessionStorage: storage,
        history: {
          replaceState(_state: unknown, _title: string, nextUrl: string) {
            location.href = new URL(nextUrl, location.href).href;
          },
        },
      },
    });

    const captured = captureContentAttributionFromUrl();
    assert.ok(captured);
    assert.deepEqual({ ...captured, capturedAt: undefined }, {
      source: 'worldmonitor-blog',
      medium: 'owned-content',
      campaign: 'country-risk',
      destination: 'dashboard',
      placement: 'article-cta-dashboard',
      landingPageFamily: 'dashboard',
      capturedAt: undefined,
    });
    assert.equal(new URL(location.href).search, '?utm_source=chatgpt.com');
    assert.equal(new URL(location.href).hash, '#overview');

    const stored = JSON.parse(storage.getItem(CONTENT_ATTRIBUTION_STORAGE_KEY)!);
    assert.equal(stored.source, 'worldmonitor-blog');
    assert.equal(stored.destination, 'dashboard');
    assert.equal(typeof stored.capturedAt, 'number');
    assert.equal(captureContentAttributionFromUrl(), null);
  });
});
