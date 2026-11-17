// Personalized carousel images used @vercel/og's default year-long
// immutable cache. The HMAC token is the credential and the Redis
// envelope expires in 7 days, so the image cache must not outlive it
// and error responses must not be stored.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error -- JS fixture module without declarations
import { installFontStub } from './fixtures/brief-carousel-fonts/stub.mjs';
// @ts-expect-error -- JS fixture module without declarations
import { CAROUSEL_FIXTURES } from './fixtures/brief-carousel-fonts/envelopes.mjs';

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
    installFontStub({ fallback: () => new Response(JSON.stringify({ result: JSON.stringify(envelope) }), { status: 200 }) });
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

  it('carousel route prefers a valid sibling', { timeout: 60_000 }, async () => {
    process.env.BRIEF_URL_SIGNING_SECRET = SECRET;
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
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
    const READ_FAILS = Symbol('read fails');
    const respond = async (siblingValue: unknown): Promise<Response> => {
      installFontStub({ fallback: (url: string) => {
        const key = decodeURIComponent(url.split('/get/')[1] ?? '');
        if (key.startsWith('brief:l10n:') && siblingValue === READ_FAILS) return new Response('down', { status: 500 });
        const value = key.startsWith('brief:l10n:') ? siblingValue : canonical;
        return new Response(JSON.stringify({ result: value == null ? null : JSON.stringify(value) }), { status: 200 });
      } });
      const { signBriefToken } = await import('../server/_shared/brief-url.ts');
      const token = await signBriefToken('user_test', '2026-04-18-0800', SECRET);
      const { default: handler } = await import('../api/brief/carousel/[userId]/[issueDate]/[page].ts');
      const res = await handler(new Request(`${PATH}?t=${token}`));
      assert.equal(res.status, 200);
      return res;
    };
    const render = async (siblingValue: unknown): Promise<Uint8Array> =>
      new Uint8Array(await (await respond(siblingValue)).arrayBuffer());
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
  });
});

describe('api/brief/carousel render failures', () => {
  const ROUTE = 'https://worldmonitor.app/api/brief/carousel/user_test/2026-04-18-0800';
  const canonical = CAROUSEL_FIXTURES.en;
  let n = 0;

  /** Serves `sibling` (with a headline unique to this call, so no font is memoized) beside the canonical brief. */
  async function call(sibling: any, stub: Record<string, string> = {}, { page = 2, method = 'GET' } = {}) {
    process.env.BRIEF_URL_SIGNING_SECRET = SECRET;
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
    n += 1;
    const story = sibling.data.stories[0];
    const fresh = { ...sibling, data: { ...sibling.data, stories: [{ ...story, headline: `${story.headline} ${'ЖЗИЙКЛМН'.slice(0, n % 8)}${n}` }] } };
    installFontStub({
      ...stub,
      fallback: (url: string) => {
        const key = decodeURIComponent(url.split('/get/')[1] ?? '');
        return new Response(JSON.stringify({ result: JSON.stringify(key.startsWith('brief:l10n:') ? fresh : canonical) }), { status: 200 });
      },
    });
    const { signBriefToken } = await import('../server/_shared/brief-url.ts');
    const token = await signBriefToken('user_test', '2026-04-18-0800', SECRET);
    const { default: handler } = await import('../api/brief/carousel/[userId]/[issueDate]/[page].ts');
    return handler(new Request(`${ROUTE}/${page}?t=${token}`, { method }));
  }

  function assertNoStore503(res: Response, label: string) {
    assert.equal(res.status, 503, label);
    for (const h of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) assert.equal(res.headers.get(h), 'no-store', `${label}: ${h}`);
  }

  it('a render error raised after the Response exists returns 503 no-store', { timeout: 60_000 }, async () => {
    // The font fetch succeeds but is not a font, so Satori throws inside the lazy body stream.
    assertNoStore503(await call(CAROUSEL_FIXTURES.ru, { garbage: 'Noto+Serif' }), 'unparseable font');
  });

  it('a failed extra-font fetch returns 503 no-store', { timeout: 60_000 }, async () => {
    assertNoStore503(await call(CAROUSEL_FIXTURES.ja, { fail: 'Noto+Sans+JP' }), 'font 500');
  });

  it('a font fetch timeout returns 503 no-store', { timeout: 60_000 }, async () => {
    assertNoStore503(await call(CAROUSEL_FIXTURES.hi, { timeout: 'Noto+Sans+Devanagari' }), 'font timeout');
  });

  it('a localized render keeps the 7-day cache policy', { timeout: 60_000 }, async () => {
    const res = await call(CAROUSEL_FIXTURES.ja);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=604800');
    assert.equal(res.headers.get('Content-Type'), 'image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });

  it('HEAD returns the GET status and headers with no body', { timeout: 60_000 }, async () => {
    const get = await call(CAROUSEL_FIXTURES.th);
    const head = await call(CAROUSEL_FIXTURES.th, {}, { method: 'HEAD' });
    assert.equal(head.status, get.status);
    for (const h of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control', 'Content-Type']) assert.equal(head.headers.get(h), get.headers.get(h), h);
    assert.equal(head.body, null);
    assertNoStore503(await call(CAROUSEL_FIXTURES.ko, { fail: 'Noto+Sans+KR' }, { method: 'HEAD' }), 'HEAD on font failure');
  });
});
