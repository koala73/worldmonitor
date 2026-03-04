import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Mock fetch before importing
const mockFetch = mock.fn<typeof globalThis.fetch>();
globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

// Set env var
process.env.VK_SERVICE_TOKEN = 'test-vk-service-token';

const { listVKPosts } = await import('./vk.ts');

describe('listVKPosts', () => {
  beforeEach(() => {
    mockFetch.mock.resetCalls();
  });

  it('returns error when service token is not configured', async () => {
    const origToken = process.env.VK_SERVICE_TOKEN;
    delete process.env.VK_SERVICE_TOKEN;

    const result = await listVKPosts({ ownerIds: [], limit: 25 });
    assert.equal(result.status, 'error');
    assert.ok(result.errorMessage.includes('not configured'));

    process.env.VK_SERVICE_TOKEN = origToken;
  });

  it('fetches wall posts from VK API v5', async () => {
    mockFetch.mock.mockImplementation(async () => {
      return new Response(JSON.stringify({
        response: {
          count: 100,
          items: [
            {
              id: 12345,
              owner_id: -123456,
              from_id: -123456,
              text: 'Military analysis update from VK',
              date: 1709553600, // Unix timestamp
              likes: { count: 50 },
              reposts: { count: 10 },
            },
          ],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await listVKPosts({ ownerIds: ['-123456'], limit: 25 });

    assert.equal(result.status, 'ok');
    assert.equal(result.count, 1);
    assert.equal(result.posts[0].platform, 'vk');
    assert.ok(result.posts[0].id.startsWith('vk-'));
    assert.ok(result.posts[0].content.includes('Military analysis update'));
    assert.equal(result.posts[0].engagement, 60); // 50 likes + 10 reposts
    assert.ok(result.posts[0].url.includes('vk.com/wall'));
  });

  it('uses default groups when none provided', async () => {
    const requestedUrls: string[] = [];
    mockFetch.mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requestedUrls.push(url);
      return new Response(JSON.stringify({
        response: { count: 0, items: [] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await listVKPosts({ ownerIds: [], limit: 25 });

    // Should have made at least one request with default groups
    assert.ok(requestedUrls.length > 0, 'Should make at least one request for default groups');
    assert.ok(requestedUrls.some(u => u.includes('owner_id=')), 'Should include owner_id param');
  });

  it('caps limit at 100', async () => {
    let capturedUrl = '';
    mockFetch.mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      capturedUrl = url;
      return new Response(JSON.stringify({
        response: { count: 0, items: [] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await listVKPosts({ ownerIds: ['-1'], limit: 500 });

    assert.ok(capturedUrl.includes('count=100') || capturedUrl.includes('count=25'),
      `Expected capped limit, got URL: ${capturedUrl}`);
  });

  it('handles VK API errors gracefully', async () => {
    mockFetch.mock.mockImplementation(async () => {
      return new Response(JSON.stringify({
        error: { error_code: 15, error_msg: 'Access denied' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await listVKPosts({ ownerIds: ['-1'], limit: 10 });
    // Should still return ok with empty posts (graceful degradation per group)
    assert.equal(result.status, 'ok');
    assert.equal(result.count, 0);
  });

  it('handles fetch errors gracefully', async () => {
    mockFetch.mock.mockImplementation(async () => {
      return new Response('Service Unavailable', { status: 503 });
    });

    const result = await listVKPosts({ ownerIds: ['-1'], limit: 10 });
    assert.equal(result.status, 'ok');
    assert.equal(result.count, 0);
  });

  it('uses VK API v5.199', async () => {
    let capturedUrl = '';
    mockFetch.mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      capturedUrl = url;
      return new Response(JSON.stringify({
        response: { count: 0, items: [] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await listVKPosts({ ownerIds: ['-1'], limit: 10 });

    assert.ok(capturedUrl.includes('v=5.199'), `Expected VK API v5.199, got URL: ${capturedUrl}`);
  });
});
