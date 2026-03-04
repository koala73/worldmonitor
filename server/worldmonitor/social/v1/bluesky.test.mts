import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Mock fetch before importing
const mockFetch = mock.fn<typeof globalThis.fetch>();
globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

const { listBlueskyPosts } = await import('./bluesky.ts');

describe('listBlueskyPosts', () => {
  beforeEach(() => {
    mockFetch.mock.resetCalls();
  });

  it('fetches posts from the public AT Protocol API', async () => {
    mockFetch.mock.mockImplementation(async () => {
      return new Response(JSON.stringify({
        posts: [
          {
            uri: 'at://did:plc:abc123/app.bsky.feed.post/rkey1',
            cid: 'bafy1234',
            author: {
              handle: 'osint.bsky.social',
              displayName: 'OSINT Analyst',
            },
            record: {
              text: 'Breaking OSINT analysis on conflict zone',
              createdAt: '2024-03-04T12:00:00.000Z',
            },
            likeCount: 25,
            repostCount: 10,
            indexedAt: '2024-03-04T12:00:01.000Z',
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await listBlueskyPosts({ query: 'OSINT', limit: 10 });

    assert.equal(result.status, 'ok');
    assert.equal(result.count, 1);
    assert.equal(result.posts[0].platform, 'bluesky');
    assert.ok(result.posts[0].id.startsWith('bluesky-'));
    assert.equal(result.posts[0].author, '@osint.bsky.social');
    assert.ok(result.posts[0].content.includes('Breaking OSINT analysis'));
    assert.equal(result.posts[0].engagement, 35); // 25 likes + 10 reposts
  });

  it('caps limit to 25 (AT Protocol max)', async () => {
    let capturedUrl = '';
    mockFetch.mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      capturedUrl = url;
      return new Response(JSON.stringify({ posts: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });

    await listBlueskyPosts({ query: 'test', limit: 100 });

    const urlObj = new URL(capturedUrl);
    const limitParam = urlObj.searchParams.get('limit');
    assert.equal(Number(limitParam), 25, `Limit should be capped at 25, got ${limitParam}`);
  });

  it('uses default query when none provided', async () => {
    let capturedUrl = '';
    mockFetch.mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      capturedUrl = url;
      return new Response(JSON.stringify({ posts: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });

    await listBlueskyPosts({ query: '', limit: 10 });

    assert.ok(capturedUrl.includes('OSINT'), 'Should use default OSINT query');
  });

  it('handles API errors gracefully', async () => {
    mockFetch.mock.mockImplementation(async () => {
      return new Response('Service Unavailable', { status: 503 });
    });

    const result = await listBlueskyPosts({ query: 'test', limit: 10 });
    assert.equal(result.status, 'error');
    assert.equal(result.count, 0);
  });

  it('generates correct Bluesky profile URL', async () => {
    mockFetch.mock.mockImplementation(async () => {
      return new Response(JSON.stringify({
        posts: [
          {
            uri: 'at://did:plc:abc123/app.bsky.feed.post/rkey1',
            cid: 'bafy1234',
            author: { handle: 'user.bsky.social', displayName: 'User' },
            record: { text: 'test post', createdAt: '2024-03-04T12:00:00.000Z' },
            likeCount: 0,
            repostCount: 0,
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await listBlueskyPosts({ query: 'test', limit: 10 });
    assert.ok(result.posts[0].url.includes('bsky.app/profile/user.bsky.social'));
  });
});
