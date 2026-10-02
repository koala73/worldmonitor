// Public shared briefs must not pin outage or missing pages at the CDN.
// HTML_HEADERS used to attach `s-maxage=300` to every HTML response,
// including the Upstash 503 paths and the 404 paths.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const HASH = 'abcdefghijkl';
const URL = `https://worldmonitor.app/api/brief/public/${HASH}`;

const originalFetch = globalThis.fetch;
const originalEnv = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv.url === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalEnv.url;
  if (originalEnv.token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalEnv.token;
});

function upstash(result: unknown): void {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
  globalThis.fetch = async () => new Response(JSON.stringify({ result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('api/brief/public/[hash] cache policy', () => {
  it('does not CDN-cache a 503 when the pointer read fails', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const { default: handler } = await import('../api/brief/public/[hash].ts');
    const res = await handler(new Request(URL));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(res.headers.get('cache-control')?.includes('s-maxage'), false);
  });

  it('does not CDN-cache a 404 for a missing pointer', async () => {
    upstash(null);
    const { default: handler } = await import('../api/brief/public/[hash].ts');
    const res = await handler(new Request(URL));
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  });

  it('does not CDN-cache a 404 for a malformed hash', async () => {
    const { default: handler } = await import('../api/brief/public/[hash].ts');
    const res = await handler(new Request('https://worldmonitor.app/api/brief/public/not-a-hash'));
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  });

  it('keeps the 5-minute CDN cache on a rendered 200', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
    const pointer = JSON.stringify('user_test:2026-04-18-0800');
    const envelope = JSON.stringify({
      version: 2,
      issuedAt: 1_700_000_000_000,
      data: {
        user: { name: 'Preview User', tz: 'UTC' },
        issue: '18.04',
        date: '2026-04-18',
        dateLong: '18 April 2026',
        digest: {
          greeting: 'Good morning.',
          lead: 'A preview brief.',
          numbers: { clusters: 1, multiSource: 1, surfaced: 1 },
          threads: [],
          signals: [],
        },
        stories: [{
          category: 'World',
          country: 'US',
          threatLevel: 'low',
          headline: 'Preview headline',
          description: 'Preview description',
          source: 'Test source',
          sourceUrl: 'https://example.com/story',
          whyMatters: 'Preview round-trip proof.',
        }],
      },
    });
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      const body = calls === 1 ? pointer : envelope;
      return new Response(JSON.stringify({ result: body }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const { default: handler } = await import('../api/brief/public/[hash].ts');
    const res = await handler(new Request(URL));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=0, s-maxage=300, must-revalidate');
  });
});
