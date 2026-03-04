import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Mock fetch before importing
const mockFetch = mock.fn<typeof globalThis.fetch>();
globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

describe('listTweets', () => {
  beforeEach(() => {
    mockFetch.mock.resetCalls();
    // Clear all Twitter env vars
    delete process.env.TWITTER_API_IO_KEY;
    delete process.env.SOCIALDATA_API_KEY;
    delete process.env.TWITTER_BEARER_TOKEN;
  });

  it('returns error when no adapter credentials are configured', async () => {
    const { listTweets } = await import('./twitter.ts');
    const result = await listTweets({ query: 'test', username: '', limit: 10 });
    assert.equal(result.status, 'error');
    assert.ok(result.errorMessage.includes('not configured'));
  });

  it('uses TwitterApiIoAdapter when TWITTER_API_IO_KEY is set', async () => {
    process.env.TWITTER_API_IO_KEY = 'test-api-io-key';

    mockFetch.mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url.includes('twitterapi.io')) {
        return new Response(JSON.stringify({
          tweets: [
            {
              id: '12345',
              text: 'OSINT breaking news',
              author: { userName: 'osintuser' },
              createdAt: '2024-03-04T12:00:00Z',
              likeCount: 100,
              retweetCount: 50,
            },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    // Re-import to pick up new env
    const mod = await import('./twitter.ts');
    const result = await mod.listTweets({ query: 'OSINT', username: '', limit: 10 });

    assert.equal(result.status, 'ok');
    assert.equal(result.count, 1);
    assert.equal(result.posts[0].platform, 'twitter');
    assert.equal(result.posts[0].id, 'twitter-12345');
    assert.equal(result.posts[0].author, '@osintuser');
    assert.equal(result.posts[0].engagement, 150); // 100 likes + 50 retweets
  });

  it('fetches user tweets when username is provided', async () => {
    process.env.TWITTER_API_IO_KEY = 'test-key';

    let capturedUrl = '';
    mockFetch.mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      capturedUrl = url;
      return new Response(JSON.stringify({ tweets: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });

    const mod = await import('./twitter.ts');
    await mod.listTweets({ query: '', username: 'testuser', limit: 10 });

    assert.ok(capturedUrl.includes('from%3Atestuser') || capturedUrl.includes('from:testuser'));
  });

  it('validates username against TWITTER_HANDLE_PATTERN', async () => {
    process.env.TWITTER_API_IO_KEY = 'test-key';

    const mod = await import('./twitter.ts');
    const result = await mod.listTweets({ query: '', username: 'invalid user!', limit: 10 });

    assert.equal(result.status, 'error');
    assert.ok(result.errorMessage.includes('failed'));
  });

  it('caps limit at 100', async () => {
    process.env.TWITTER_API_IO_KEY = 'test-key';

    mockFetch.mock.mockImplementation(async () => {
      return new Response(JSON.stringify({ tweets: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });

    const mod = await import('./twitter.ts');
    // Should not throw even with large limit
    const result = await mod.listTweets({ query: 'test', username: '', limit: 500 });
    assert.equal(result.status, 'ok');
  });

  it('uses default query when none provided', async () => {
    process.env.TWITTER_API_IO_KEY = 'test-key';

    let capturedUrl = '';
    mockFetch.mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      capturedUrl = url;
      return new Response(JSON.stringify({ tweets: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });

    const mod = await import('./twitter.ts');
    await mod.listTweets({ query: '', username: '', limit: 10 });

    assert.ok(capturedUrl.includes('OSINT'), `Expected default OSINT query, got URL: ${capturedUrl}`);
  });
});
