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
      if (decodeURIComponent(url).includes('brief:l10n:')) return new Response(JSON.stringify({ result: null }), { status: 200 });
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

  const READ_FAILS = Symbol('read fails');

  async function siblingHarness() {
    process.env.BRIEF_URL_SIGNING_SECRET = SECRET;
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
    const fontUrl = 'https://cdn.jsdelivr.net/npm/@fontsource/noto-serif/files/noto-serif-latin-400-normal.woff';
    const font = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), '../blog-site/scripts/fonts/inter-regular.ttf'));
    const canonical = {
      version: 4,
      issuedAt: 1_700_000_000_000,
      data: {
        user: { name: 'Test User', tz: 'UTC' }, issue: '001', date: '2026-04-18', dateLong: '18 April 2026',
        digest: { greeting: 'Good morning', lead: 'A sample lead.', numbers: { clusters: 1, multiSource: 1, surfaced: 1 }, threads: [{ tag: 'TEST', teaser: 'A thread teaser' }], signals: [] },
        stories: [{
          category: 'World', country: 'FR', threatLevel: 'low', headline: 'A headline', description: 'A description',
          source: 'Wire', sourceUrl: 'https://example.com/1', clusterId: 'cluster-1', whyMatters: 'Why it matters.',
        }],
      },
    };
    const sibling = {
      ...canonical, version: 5, lang: 'fr',
      data: { ...canonical.data, dateLong: '18 avril 2026', digest: { ...canonical.data.digest, greeting: 'Bonjour à tous' } },
    };
    const respond = async (siblingValue: unknown, method = 'GET'): Promise<Response> => {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url === fontUrl) return new Response(font, { status: 200, headers: { 'Content-Type': 'font/ttf' } });
        const key = decodeURIComponent(url.split('/get/')[1] ?? '');
        if (key.startsWith('brief:l10n:') && siblingValue === READ_FAILS) return new Response('down', { status: 500 });
        const value = key.startsWith('brief:l10n:') ? siblingValue : canonical;
        return new Response(JSON.stringify({ result: value == null ? null : JSON.stringify(value) }), { status: 200 });
      };
      const { signBriefToken } = await import('../server/_shared/brief-url.ts');
      const token = await signBriefToken('user_test', '2026-04-18-0800', SECRET);
      const { default: handler } = await import('../api/brief/carousel/[userId]/[issueDate]/[page].ts');
      const res = await handler(new Request(`${PATH}?t=${token}`, { method }));
      assert.equal(res.status, 200);
      return res;
    };
    const render = async (siblingValue: unknown): Promise<Uint8Array> =>
      new Uint8Array(await (await respond(siblingValue)).arrayBuffer());
    return { canonical, sibling, respond, render };
  }

  it('carousel route prefers a valid sibling', { timeout: 60_000 }, async () => {
    const { canonical, sibling, respond, render } = await siblingHarness();
    const english = await render(null);
    const localized = await render(sibling);
    const stale = await render({ ...sibling, issuedAt: canonical.issuedAt + 1 });
    assert.notDeepEqual(localized, english, 'a valid sibling must change the rendered image');
    assert.deepEqual(stale, english, 'a stale sibling must render the canonical image');
    for (const lang of ['ar', 'fa']) {
      const rtl = await render({ ...sibling, lang, data: { ...sibling.data, digest: { ...sibling.data.digest, greeting: 'مساء الخير' } } });
      assert.deepEqual(rtl, english, `a ${lang} sibling must render the canonical English image`);
    }

    const fallback = await respond(READ_FAILS);
    assert.deepEqual(new Uint8Array(await fallback.arrayBuffer()), english, 'a failed sibling read renders canonical');
    for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) {
      assert.equal(fallback.headers.get(header), 'no-store', `${header} after a failed sibling read`);
    }
    assert.equal((await respond(null)).headers.get('Cache-Control'), 'public, max-age=604800');

    // A sibling that was read but rejected (stale issuedAt mid-regeneration,
    // or invalid) renders English; that English image must not be cached.
    for (const rejected of [{ ...sibling, issuedAt: canonical.issuedAt + 1 }, { ...sibling, lang: 'en' }]) {
      for (const method of ['GET', 'HEAD']) {
        const res = await respond(rejected, method);
        for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) {
          assert.equal(res.headers.get(header), 'no-store', `${method} ${header} after a rejected sibling`);
        }
      }
    }
    assert.equal((await respond(sibling, 'HEAD')).headers.get('Cache-Control'), 'public, max-age=604800');
  });

  // The one registered face is Noto Serif's Latin subset. A sibling in a
  // language it does not cover (Latin Extended, Cyrillic, CJK, Thai, ...)
  // would draw through the image library's unbounded font fallback, so the
  // route keeps the canonical English image. That image is the intended
  // output, not a fallback after a failure, so it is cached.
  it('a sibling in a language the carousel cannot draw renders the cached English image', { timeout: 60_000 }, async () => {
    const { sibling, respond, render } = await siblingHarness();
    const english = await render(null);
    for (const [lang, greeting] of [['ja', 'こんばんは。'], ['ru', 'Добрый вечер.'], ['pl', 'Dzień dobry.'], ['th', 'สวัสดีตอนเย็น']]) {
      const gated = { ...sibling, lang, data: { ...sibling.data, digest: { ...sibling.data.digest, greeting } } };
      const res = await respond(gated);
      assert.deepEqual(new Uint8Array(await res.arrayBuffer()), english, `${lang} must render the canonical image`);
      for (const method of ['GET', 'HEAD']) {
        const headers = (await respond(gated, method)).headers;
        for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) {
          assert.equal(headers.get(header), 'public, max-age=604800', `${lang} ${method} ${header}`);
        }
      }
    }
  });
});
