// Personalized carousel images used @vercel/og's default year-long
// immutable cache. The HMAC token is the credential and the Redis
// envelope expires in 7 days, so the image cache must not outlive it
// and error responses must not be stored.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET = 'carousel-cache-test-secret';
const PATH = 'https://worldmonitor.app/api/brief/carousel/user_test/2026-04-18-0800/0';

const originalFetch = globalThis.fetch;
const originalSecret = process.env.BRIEF_URL_SIGNING_SECRET;
const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  restore('BRIEF_URL_SIGNING_SECRET', originalSecret);
  restore('UPSTASH_REDIS_REST_URL', originalUrl);
  restore('UPSTASH_REDIS_REST_TOKEN', originalToken);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('api/brief/carousel cache policy', () => {
  it('does not store a 503 when the signer secret is missing', async () => {
    delete process.env.BRIEF_URL_SIGNING_SECRET;
    const { default: handler } = await import('../api/brief/carousel/[userId]/[issueDate]/[page].ts');
    const res = await handler(new Request(PATH));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });

  it('does not store a 403 for a missing token', async () => {
    process.env.BRIEF_URL_SIGNING_SECRET = SECRET;
    const { default: handler } = await import('../api/brief/carousel/[userId]/[issueDate]/[page].ts');
    const res = await handler(new Request(PATH));
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });

  it('does not store a 404 when the envelope is missing', async () => {
    process.env.BRIEF_URL_SIGNING_SECRET = SECRET;
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
    globalThis.fetch = async () => new Response(JSON.stringify({ result: null }), { status: 200 });
    const { signBriefToken } = await import('../server/_shared/brief-url.ts');
    const token = await signBriefToken('user_test', '2026-04-18-0800', SECRET);
    const { default: handler } = await import('../api/brief/carousel/[userId]/[issueDate]/[page].ts');
    const res = await handler(new Request(`${PATH}?t=${token}`));
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });

  it('replaces the year-long immutable cache with the 7-day envelope TTL', { timeout: 60_000 }, async () => {
    process.env.BRIEF_URL_SIGNING_SECRET = SECRET;
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
    const fontUrl = 'https://cdn.jsdelivr.net/npm/@fontsource/noto-serif/files/noto-serif-latin-400-normal.woff';
    const font = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), '../blog-site/scripts/fonts/inter-regular.ttf'));
    const envelope = {
      version: 1,
      issuedAt: 1_700_000_000_000,
      data: {
        issue: '001',
        dateLong: '19 April 2026',
        user: { name: 'Test User' },
        digest: {
          greeting: 'Good morning',
          lead: 'A sample lead.',
          threads: [{ tag: 'TEST', teaser: 'A thread teaser' }],
        },
        stories: [{
          category: 'World',
          headline: 'A headline',
          threatLevel: 'low',
          isAlert: false,
        }],
      },
    };
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === fontUrl) {
        return new Response(font, { status: 200, headers: { 'Content-Type': 'font/ttf' } });
      }
      return new Response(JSON.stringify({ result: JSON.stringify(envelope) }), { status: 200 });
    };
    const { signBriefToken } = await import('../server/_shared/brief-url.ts');
    const token = await signBriefToken('user_test', '2026-04-18-0800', SECRET);
    const { default: handler } = await import('../api/brief/carousel/[userId]/[issueDate]/[page].ts');
    const res = await handler(new Request(`${PATH}?t=${token}`));
    assert.equal(res.status, 200);
    const cache = res.headers.get('Cache-Control') ?? '';
    assert.equal(cache, 'public, max-age=604800');
    assert.equal(cache.includes('immutable'), false);
    assert.equal(res.headers.get('CDN-Cache-Control'), 'public, max-age=604800');
    assert.equal(res.headers.get('Vercel-CDN-Cache-Control'), 'public, max-age=604800');
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.equal(bytes[0], 0x89);
    assert.equal(bytes[1], 0x50);
  });
});
