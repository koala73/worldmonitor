// Tests for server/_shared/brief-share-url.ts
//
// The HMAC derivation is deterministic and only trusts BRIEF_SHARE_SECRET;
// these tests pin that behaviour so a future refactor can't accidentally
// make the hash non-deterministic (breaks every active share link) or
// secret-less (makes hashes predictable).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BriefShareUrlError,
  BRIEF_PUBLIC_POINTER_PREFIX,
  buildPublicBriefUrl,
  decodePublicPointer,
  deriveShareHash,
  encodePublicPointer,
  isValidShareHashShape,
} from '../server/_shared/brief-share-url';

const SECRET_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 32 chars
const SECRET_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('deriveShareHash', () => {
  it('produces a 12-char base64url string', async () => {
    const hash = await deriveShareHash('user_abc', '2026-04-18-0800', SECRET_A);
    assert.equal(hash.length, 12);
    assert.match(hash, /^[A-Za-z0-9_-]{12}$/);
  });

  it('is deterministic for the same inputs', async () => {
    const a = await deriveShareHash('user_abc', '2026-04-18-0800', SECRET_A);
    const b = await deriveShareHash('user_abc', '2026-04-18-0800', SECRET_A);
    assert.equal(a, b);
  });

  it('differs for different userIds', async () => {
    const a = await deriveShareHash('user_abc', '2026-04-18-0800', SECRET_A);
    const b = await deriveShareHash('user_xyz', '2026-04-18-0800', SECRET_A);
    assert.notEqual(a, b);
  });

  it('differs for different dates', async () => {
    const a = await deriveShareHash('user_abc', '2026-04-18-0800', SECRET_A);
    const b = await deriveShareHash('user_abc', '2026-04-19-0800', SECRET_A);
    assert.notEqual(a, b);
  });

  it('differs for same-day slots at different hours (the whole point of slot rollout)', async () => {
    // The regression this slot format prevents: morning + afternoon
    // digest emails on the same day must produce distinct public
    // share hashes so each dispatch has its own share URL.
    const morning = await deriveShareHash('user_abc', '2026-04-18-0800', SECRET_A);
    const afternoon = await deriveShareHash('user_abc', '2026-04-18-1300', SECRET_A);
    assert.notEqual(morning, afternoon);
  });

  it('differs for different secrets (rotation invalidates old hashes)', async () => {
    const a = await deriveShareHash('user_abc', '2026-04-18-0800', SECRET_A);
    const b = await deriveShareHash('user_abc', '2026-04-18-0800', SECRET_B);
    assert.notEqual(a, b);
  });

  it('throws BriefShareUrlError on missing secret', async () => {
    await assert.rejects(
      () => deriveShareHash('user_abc', '2026-04-18-0800', ''),
      (err: unknown) =>
        err instanceof BriefShareUrlError && err.code === 'missing_secret',
    );
  });

  it('throws on malformed userId', async () => {
    await assert.rejects(
      () => deriveShareHash('has spaces', '2026-04-18-0800', SECRET_A),
      (err: unknown) =>
        err instanceof BriefShareUrlError && err.code === 'invalid_user_id',
    );
  });

  it('throws on malformed issueDate', async () => {
    await assert.rejects(
      () => deriveShareHash('user_abc', '04/18/2026', SECRET_A),
      (err: unknown) =>
        err instanceof BriefShareUrlError && err.code === 'invalid_issue_date',
    );
  });
});

describe('isValidShareHashShape', () => {
  it('accepts a 12-char base64url string', () => {
    assert.equal(isValidShareHashShape('abcdef012345'), true);
    assert.equal(isValidShareHashShape('AB-_0123xyzZ'), true);
  });

  it('rejects other shapes', () => {
    assert.equal(isValidShareHashShape(''), false);
    assert.equal(isValidShareHashShape('short'), false);
    assert.equal(isValidShareHashShape('too-long-for-a-valid-share-hash'), false);
    assert.equal(isValidShareHashShape('has space!12'), false);
    assert.equal(isValidShareHashShape(null), false);
    assert.equal(isValidShareHashShape(12345), false);
  });
});

describe('encodePublicPointer / decodePublicPointer', () => {
  it('round-trips', () => {
    const encoded = encodePublicPointer('user_abc', '2026-04-18-0800');
    assert.equal(encoded, 'user_abc:2026-04-18-0800');
    assert.deepEqual(decodePublicPointer(encoded), {
      userId: 'user_abc',
      issueDate: '2026-04-18-0800',
    });
  });

  it('rejects malformed inputs at encode time', () => {
    assert.throws(() => encodePublicPointer('bad user', '2026-04-18-0800'), BriefShareUrlError);
    assert.throws(() => encodePublicPointer('user_abc', 'not-a-date'), BriefShareUrlError);
  });

  it('returns null on any decode failure', () => {
    assert.equal(decodePublicPointer(null), null);
    assert.equal(decodePublicPointer(42), null);
    assert.equal(decodePublicPointer(''), null);
    assert.equal(decodePublicPointer('no-colon'), null);
    assert.equal(decodePublicPointer('user:not-a-date'), null);
    assert.equal(decodePublicPointer('user spaces:2026-04-18-0800'), null);
  });
});

describe('buildPublicBriefUrl', () => {
  it('returns a full URL under baseUrl with the derived hash in the path', async () => {
    const { url, hash } = await buildPublicBriefUrl({
      userId: 'user_abc',
      issueDate: '2026-04-18-0800',
      baseUrl: 'https://worldmonitor.app',
      secret: SECRET_A,
    });
    assert.match(url, /^https:\/\/worldmonitor\.app\/api\/brief\/public\/[A-Za-z0-9_-]{12}$/);
    assert.ok(url.endsWith(hash));
  });

  it('attaches ?ref= when refCode is provided', async () => {
    const { url } = await buildPublicBriefUrl({
      userId: 'user_abc',
      issueDate: '2026-04-18-0800',
      baseUrl: 'https://worldmonitor.app',
      secret: SECRET_A,
      refCode: 'ABC123',
    });
    assert.ok(url.endsWith('?ref=ABC123'));
  });

  it('URL-encodes refCode safely', async () => {
    const { url } = await buildPublicBriefUrl({
      userId: 'user_abc',
      issueDate: '2026-04-18-0800',
      baseUrl: 'https://worldmonitor.app',
      secret: SECRET_A,
      refCode: 'a b+c',
    });
    assert.ok(url.includes('?ref=a%20b%2Bc'));
  });

  it('trims trailing slashes from baseUrl', async () => {
    const { url } = await buildPublicBriefUrl({
      userId: 'user_abc',
      issueDate: '2026-04-18-0800',
      baseUrl: 'https://worldmonitor.app///',
      secret: SECRET_A,
    });
    assert.ok(url.startsWith('https://worldmonitor.app/api/brief/public/'));
    assert.ok(!url.startsWith('https://worldmonitor.app///'));
  });
});

describe('BRIEF_PUBLIC_POINTER_PREFIX', () => {
  it('is the expected string (used by composer + routes)', () => {
    assert.equal(BRIEF_PUBLIC_POINTER_PREFIX, 'brief:public:');
  });
});

describe('pointer wire format (P1 regression — write ↔ read must round-trip)', () => {
  // Both write sites (api/brief/share-url.ts and api/brief/[userId]/
  // [issueDate].ts) JSON.stringify the pointer before SETting in
  // Redis. The public route reads via readRawJsonFromUpstash which
  // ALWAYS JSON.parses — so a bare colon-delimited string would
  // throw at parse time and the public route would 503 instead of
  // resolving the pointer. This test locks the wire format.
  it('JSON.stringify + JSON.parse + decodePublicPointer round-trips cleanly', () => {
    const encoded = encodePublicPointer('user_abc', '2026-04-18-0800');
    // Write side: what api/brief/share-url.ts sends to Redis.
    const wireValue = JSON.stringify(encoded);
    // Read side: what readRawJsonFromUpstash returns after parsing
    // Upstash's `{result: <wireValue>}` response.
    const parsed = JSON.parse(wireValue);
    assert.equal(typeof parsed, 'string', 'parsed pointer is a string');
    const pointer = decodePublicPointer(parsed);
    assert.deepEqual(pointer, { userId: 'user_abc', issueDate: '2026-04-18-0800' });
  });

  it('a raw colon-delimited string (the P1 bug) fails JSON.parse', () => {
    // This is the format the earlier buggy code wrote. If we ever
    // revert to it, readRawJsonFromUpstash's parse will throw and
    // the public route will 503. Locking the failure so anyone
    // who reintroduces the bug gets a red test.
    assert.throws(() => JSON.parse('user_abc:2026-04-18-0800'), SyntaxError);
  });
});

describe('preview share route reachability', () => {
  it('mints a preview URL whose public route can read the preview-owned pointer', async () => {
    const originalEnv = { ...process.env };
    const originalFetch = globalThis.fetch;
    const redis = new Map<string, string>();

    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_GIT_COMMIT_SHA = 'deadbeefcafebabe';
    process.env.WORLDMONITOR_PUBLIC_BASE_URL = 'https://worldmonitor.app';
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

    globalThis.fetch = (async (input, init = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'https://upstash.test/pipeline') {
        const commands = JSON.parse(String(init.body)) as string[][];
        const results = commands.map(([verb, key, value]) => {
          if (verb === 'SET' && key && value !== undefined) {
            redis.set(key, value);
            return { result: 'OK' };
          }
          return { result: null };
        });
        return Response.json(results);
      }
      if (url.startsWith('https://upstash.test/get/')) {
        const key = decodeURIComponent(url.slice('https://upstash.test/get/'.length));
        return Response.json({ result: redis.get(key) ?? null });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const shareRoute = await import('../api/brief/share-url.ts') as Record<string, unknown>;
      assert.equal(
        typeof shareRoute.publicBaseUrl,
        'function',
        'share route must expose its destination selector for the route round-trip contract',
      );
      const publicBaseUrl = shareRoute.publicBaseUrl as (req: Request) => string;
      const previewOrigin = 'https://worldmonitor-git-brief-test-eliewm.vercel.app';
      const userId = 'user_preview';
      const issueSlot = '2026-04-18-0800';
      const { url, hash } = await buildPublicBriefUrl({
        userId,
        issueDate: issueSlot,
        baseUrl: publicBaseUrl(new Request(`${previewOrigin}/api/brief/share-url`)),
        secret: SECRET_A,
      });

      const { redisPipeline } = await import('../api/_upstash-json.js');
      await redisPipeline([
        ['SET', `${BRIEF_PUBLIC_POINTER_PREFIX}${hash}`, JSON.stringify(encodePublicPointer(userId, issueSlot)), 'EX', '604800'],
      ]);
      await redisPipeline([
        ['SET', `brief:${userId}:${issueSlot}`, JSON.stringify({
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
        }), 'EX', '604800'],
      ], 5_000, true);

      assert.equal(new URL(url).origin, previewOrigin);
      const { default: publicHandler } = await import('../api/brief/public/[hash].ts');
      const response = await publicHandler(new Request(url));
      assert.equal(response.status, 200, 'the URL destination must read the pointer namespace that minted it');
      assert.match(await response.text(), /Preview headline/);
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      Object.assign(process.env, originalEnv);
    }
  });
});
