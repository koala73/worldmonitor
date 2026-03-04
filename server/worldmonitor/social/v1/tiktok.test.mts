import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Mock fetch before importing
const mockFetch = mock.fn<typeof globalThis.fetch>();
globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

// Set env var
process.env.TIKTOK_APIFY_TOKEN = 'test-apify-token';

const { listTikTokPosts } = await import('./tiktok.ts');

describe('listTikTokPosts', () => {
  beforeEach(() => {
    mockFetch.mock.resetCalls();
  });

  it('returns error when Apify token is not configured', async () => {
    const origToken = process.env.TIKTOK_APIFY_TOKEN;
    delete process.env.TIKTOK_APIFY_TOKEN;

    const result = await listTikTokPosts({ query: 'test', limit: 10 });
    assert.equal(result.status, 'error');
    assert.ok(result.errorMessage.includes('not configured'));

    process.env.TIKTOK_APIFY_TOKEN = origToken;
  });

  it('fetches posts via Apify TikTok scraper', async () => {
    // Apify run start
    mockFetch.mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      // Start actor run
      if (url.includes('/runs') && !url.includes('/dataset')) {
        return new Response(JSON.stringify({
          data: { defaultDatasetId: 'dataset-123' },
        }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }

      // Get dataset items
      if (url.includes('/dataset') || url.includes('/items')) {
        return new Response(JSON.stringify([
          {
            id: 'tt-vid-123',
            text: 'Military analysis #OSINT',
            authorMeta: { name: 'osint_analyst', nickName: 'OSINT Analyst' },
            createTimeISO: '2024-03-04T12:00:00.000Z',
            diggCount: 1000,
            shareCount: 200,
            webVideoUrl: 'https://www.tiktok.com/@osint_analyst/video/tt-vid-123',
            videoMeta: { coverUrl: 'https://p16-sign.tiktokcdn.com/cover.jpg' },
            hashtags: [{ name: 'OSINT' }, { name: 'military' }],
          },
        ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await listTikTokPosts({ query: 'OSINT', limit: 10 });

    assert.equal(result.status, 'ok');
    assert.equal(result.count, 1);
    assert.equal(result.posts[0].platform, 'tiktok');
    assert.ok(result.posts[0].id.startsWith('tiktok-'));
    assert.ok(result.posts[0].content.includes('Military analysis'));
    assert.equal(result.posts[0].engagement, 1200); // 1000 likes + 200 shares
    assert.ok(result.posts[0].hashtags.includes('OSINT'));
  });

  it('uses default query when none provided', async () => {
    let capturedBody: any = null;
    mockFetch.mock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url.includes('/runs')) {
        if (init?.body) {
          capturedBody = JSON.parse(init.body as string);
        }
        return new Response(JSON.stringify({
          data: { defaultDatasetId: 'ds-123' },
        }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify([]), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });

    await listTikTokPosts({ query: '', limit: 10 });

    assert.ok(capturedBody, 'Should have sent a request body');
    const searchTerms = JSON.stringify(capturedBody);
    assert.ok(searchTerms.includes('OSINT') || searchTerms.includes('geopolitics'),
      'Should include default search terms');
  });

  it('caps limit at 50', async () => {
    let capturedBody: any = null;
    mockFetch.mock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url.includes('/runs') && init?.body) {
        capturedBody = JSON.parse(init.body as string);
        return new Response(JSON.stringify({
          data: { defaultDatasetId: 'ds-123' },
        }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify([]), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });

    await listTikTokPosts({ query: 'test', limit: 200 });

    assert.ok(capturedBody);
    assert.ok(capturedBody.resultsPerPage <= 50, `resultsPerPage should be <= 50, got ${capturedBody.resultsPerPage}`);
  });

  it('handles Apify API errors gracefully', async () => {
    mockFetch.mock.mockImplementation(async () => {
      return new Response('Unauthorized', { status: 401 });
    });

    const result = await listTikTokPosts({ query: 'test', limit: 10 });
    assert.equal(result.status, 'error');
    assert.equal(result.count, 0);
  });
});
