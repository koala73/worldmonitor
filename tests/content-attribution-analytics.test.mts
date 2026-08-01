import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { CONTENT_ATTRIBUTION_STORAGE_KEY } from '../shared/content-attribution.ts';

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

describe('dashboard content attribution analytics', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('enriches sign-up, checkout, and MCP events without adding user-level data', async () => {
    const storage = new MemoryStorage();
    storage.setItem(CONTENT_ATTRIBUTION_STORAGE_KEY, JSON.stringify({
      source: 'worldmonitor-blog',
      medium: 'owned-content',
      campaign: 'country-risk',
      destination: 'pro',
      placement: 'article-cta-pro',
      landingPageFamily: 'pricing',
      capturedAt: Date.now(),
    }));
    const calls: Array<{ name: string; data?: Record<string, unknown> }> = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        sessionStorage: storage,
        localStorage: storage,
        umami: {
          track: (name: string, data?: Record<string, unknown>) => calls.push({ name, data }),
          identify: () => {},
        },
      },
    });

    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    analytics.trackSignUp('clerk');
    analytics.trackCheckoutStart('pdt_0Nbtt71uObulf7fGXhQup', true);
    analytics.track('mcp-connect-success', { toolCount: 3 });
    analytics.trackContentHandoff();

    assert.deepEqual(calls.map(({ name, data }) => ({
      name,
      data: {
        contentSource: data?.contentSource,
        contentMedium: data?.contentMedium,
        contentCampaign: data?.contentCampaign,
        contentDestination: data?.contentDestination,
        contentPlacement: data?.contentPlacement,
        landingPageFamily: data?.landingPageFamily,
      },
    })), [
      { name: 'sign-up', data: {
        contentSource: 'worldmonitor-blog',
        contentMedium: 'owned-content',
        contentCampaign: 'country-risk',
        contentDestination: 'pro',
        contentPlacement: 'article-cta-pro',
        landingPageFamily: 'pricing',
      } },
      { name: 'checkout-start', data: {
        contentSource: 'worldmonitor-blog',
        contentMedium: 'owned-content',
        contentCampaign: 'country-risk',
        contentDestination: 'pro',
        contentPlacement: 'article-cta-pro',
        landingPageFamily: 'pricing',
      } },
      { name: 'mcp-connect-success', data: {
        contentSource: 'worldmonitor-blog',
        contentMedium: 'owned-content',
        contentCampaign: 'country-risk',
        contentDestination: 'pro',
        contentPlacement: 'article-cta-pro',
        landingPageFamily: 'pricing',
      } },
      { name: 'content-handoff', data: {
        contentSource: 'worldmonitor-blog',
        contentMedium: 'owned-content',
        contentCampaign: 'country-risk',
        contentDestination: 'pro',
        contentPlacement: 'article-cta-pro',
        landingPageFamily: 'pricing',
      } },
    ]);
    assert.equal(calls[2]?.data?.toolCount, 3);
    assert.equal('prompt' in (calls[2]?.data ?? {}), false);
    assert.equal('accountHistory' in (calls[2]?.data ?? {}), false);
  });
});
