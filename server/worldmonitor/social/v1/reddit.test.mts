import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Mock fetch before importing the module
const mockFetch = mock.fn<typeof globalThis.fetch>();
globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

// Set env vars for OAuth2
process.env.REDDIT_CLIENT_ID = 'test-client-id';
process.env.REDDIT_CLIENT_SECRET = 'test-client-secret';

const { listRedditPosts, _resetTokenCache } = await import('./reddit.ts');

describe('listRedditPosts', () => {
  beforeEach(() => {
    mockFetch.mock.resetCalls();
    _resetTokenCache();
  });

  it('returns error when credentials are not configured', async () => {
    const origId = process.env.REDDIT_CLIENT_ID;
    const origSecret = process.env.REDDIT_CLIENT_SECRET;
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_CLIENT_SECRET;

    const result = await listRedditPosts({ subreddits: [], limit: 25, sort: 'hot' });
    assert.equal(result.status, 'error');
    assert.equal(result.count, 0);
    assert.ok(result.errorMessage.includes('not configured'));

    process.env.REDDIT_CLIENT_ID = origId;
    process.env.REDDIT_CLIENT_SECRET = origSecret;
  });

  it('fetches OAuth2 token and subreddit posts', async () => {
    mockFetch.mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url.includes('access_token')) {
        return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.includes('/r/OSINT/')) {
        return new Response(JSON.stringify({
          data: {
            children: [
              {
                data: {
                  id: 'abc123',
                  author: 'testuser',
                  title: 'Test OSINT Post',
                  permalink: '/r/OSINT/comments/abc123/test/',
                  created_utc: 1709500000,
                  score: 42,
                },
              },
            ],
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await listRedditPosts({ subreddits: ['OSINT'], limit: 10, sort: 'hot' });

    assert.equal(result.status, 'ok');
    assert.equal(result.count, 1);
    assert.equal(result.posts[0].platform, 'reddit');
    assert.equal(result.posts[0].id, 'reddit-abc123');
    assert.equal(result.posts[0].author, 'u/testuser');
    assert.ok(result.posts[0].content.includes('Test OSINT Post'));
    assert.equal(result.posts[0].engagement, 42);
    assert.equal(result.posts[0].subreddit, 'OSINT');
  });

  it('uses default subreddits when none provided', async () => {
    const requestedUrls: string[] = [];
    mockFetch.mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requestedUrls.push(url);

      if (url.includes('access_token')) {
        return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ data: { children: [] } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });

    await listRedditPosts({ subreddits: [], limit: 25, sort: 'hot' });

    // Should fetch default subreddits: OSINT, geopolitics, CombatFootage, worldnews
    const subredditUrls = requestedUrls.filter(u => u.includes('oauth.reddit.com'));
    assert.ok(subredditUrls.length >= 4, `Expected 4+ subreddit requests, got ${subredditUrls.length}`);
  });

  it('caps limit to 100', async () => {
    mockFetch.mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url.includes('access_token')) {
        return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      // Check that limit param is capped at 100
      const urlObj = new URL(url);
      const limitParam = urlObj.searchParams.get('limit');
      assert.ok(Number(limitParam) <= 100, `limit should be capped at 100, got ${limitParam}`);

      return new Response(JSON.stringify({ data: { children: [] } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });

    await listRedditPosts({ subreddits: ['OSINT'], limit: 500, sort: 'hot' });
  });

  it('sorts posts by engagement descending', async () => {
    mockFetch.mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url.includes('access_token')) {
        return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        data: {
          children: [
            { data: { id: 'low', author: 'a', title: 'Low', permalink: '/r/t/low', created_utc: 1709500000, score: 5 } },
            { data: { id: 'high', author: 'b', title: 'High', permalink: '/r/t/high', created_utc: 1709500001, score: 100 } },
          ],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await listRedditPosts({ subreddits: ['test'], limit: 10, sort: 'hot' });

    assert.equal(result.posts[0].engagement, 100);
    assert.equal(result.posts[1].engagement, 5);
  });

  it('handles API errors gracefully', async () => {
    mockFetch.mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url.includes('access_token')) {
        return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Server Error', { status: 500 });
    });

    const result = await listRedditPosts({ subreddits: ['OSINT'], limit: 10, sort: 'hot' });
    assert.equal(result.status, 'ok');
    assert.equal(result.count, 0);
  });

  it('returns error when OAuth2 token request fails', async () => {
    mockFetch.mock.mockImplementation(async () => {
      return new Response('Unauthorized', { status: 401 });
    });

    const result = await listRedditPosts({ subreddits: ['OSINT'], limit: 10, sort: 'hot' });
    assert.equal(result.status, 'error');
    assert.ok(result.errorMessage.includes('token'));
  });
});
