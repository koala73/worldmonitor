// #961 routed desktop RSS through `proxyUrl(feedUrl)`, which hands back an
// absolute publisher URL unchanged. The WebView then fetched every publisher
// cross-origin, so a desktop whose variant digest lacked a panel's category
// showed "No news available (France 24, EuroNews, Le Monde failed)" (#9396).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FEED = 'https://www.france24.com/en/rss';

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rssProxyUrl', () => {
  it('sends desktop feeds through the sidecar rss proxy', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    const { rssProxyUrl } = await import('@/utils/proxy');
    expect(rssProxyUrl(FEED)).toBe(`/api/rss-proxy?url=${encodeURIComponent(FEED)}`);
  });

  it('keeps the web rss proxy path', async () => {
    const { rssProxyUrl } = await import('@/utils/proxy');
    expect(rssProxyUrl(FEED)).toBe(`/api/rss-proxy?url=${encodeURIComponent(FEED)}`);
  });
});
