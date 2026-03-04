import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Mock fetch before importing
const mockFetch = mock.fn<typeof globalThis.fetch>();
globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

// Set env var for YouTube API
process.env.YOUTUBE_API_KEY = 'test-youtube-api-key';

const { listYouTubeVideos } = await import('./youtube.ts');

describe('listYouTubeVideos', () => {
  beforeEach(() => {
    mockFetch.mock.resetCalls();
  });

  it('returns error when API key is not configured', async () => {
    const origKey = process.env.YOUTUBE_API_KEY;
    delete process.env.YOUTUBE_API_KEY;

    const result = await listYouTubeVideos({ query: 'test', channelId: '', limit: 10 });
    assert.equal(result.status, 'error');
    assert.ok(result.errorMessage.includes('not configured'));

    process.env.YOUTUBE_API_KEY = origKey;
  });

  it('fetches videos from YouTube Data API v3', async () => {
    mockFetch.mock.mockImplementation(async () => {
      return new Response(JSON.stringify({
        items: [
          {
            id: { videoId: 'dQw4w9WgXcQ' },
            snippet: {
              title: 'OSINT Analysis: Ukraine Conflict Update',
              channelTitle: 'OSINT Channel',
              publishedAt: '2024-03-04T12:00:00Z',
              thumbnails: {
                medium: { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg' },
              },
            },
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await listYouTubeVideos({ query: 'OSINT', channelId: '', limit: 10 });

    assert.equal(result.status, 'ok');
    assert.equal(result.count, 1);
    assert.equal(result.posts[0].platform, 'youtube');
    assert.equal(result.posts[0].id, 'youtube-dQw4w9WgXcQ');
    assert.equal(result.posts[0].author, 'OSINT Channel');
    assert.ok(result.posts[0].content.includes('OSINT Analysis'));
    assert.ok(result.posts[0].url.includes('youtube.com/watch?v=dQw4w9WgXcQ'));
    assert.ok(result.posts[0].mediaUrl.includes('mqdefault.jpg'));
  });

  it('passes channelId to API when provided', async () => {
    let capturedUrl = '';
    mockFetch.mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      capturedUrl = url;
      return new Response(JSON.stringify({ items: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });

    await listYouTubeVideos({ query: 'test', channelId: 'UC123456', limit: 10 });

    assert.ok(capturedUrl.includes('channelId=UC123456'), `Expected channelId in URL, got: ${capturedUrl}`);
  });

  it('caps limit at 50', async () => {
    let capturedUrl = '';
    mockFetch.mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      capturedUrl = url;
      return new Response(JSON.stringify({ items: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });

    await listYouTubeVideos({ query: 'test', channelId: '', limit: 200 });

    const urlObj = new URL(capturedUrl);
    const maxResults = urlObj.searchParams.get('maxResults');
    assert.equal(Number(maxResults), 50, `maxResults should be capped at 50, got ${maxResults}`);
  });

  it('uses default query when none provided', async () => {
    let capturedUrl = '';
    mockFetch.mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      capturedUrl = url;
      return new Response(JSON.stringify({ items: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });

    await listYouTubeVideos({ query: '', channelId: '', limit: 10 });

    assert.ok(capturedUrl.includes('OSINT'), 'Should use default OSINT query');
  });

  it('handles API errors gracefully', async () => {
    mockFetch.mock.mockImplementation(async () => {
      return new Response('Forbidden', { status: 403 });
    });

    const result = await listYouTubeVideos({ query: 'test', channelId: '', limit: 10 });
    assert.equal(result.status, 'error');
    assert.ok(result.errorMessage.includes('403'));
  });
});
