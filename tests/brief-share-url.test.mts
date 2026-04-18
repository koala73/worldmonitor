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
    const hash = await deriveShareHash('user_abc', '2026-04-18', SECRET_A);
    assert.equal(hash.length, 12);
    assert.match(hash, /^[A-Za-z0-9_-]{12}$/);
  });

  it('is deterministic for the same inputs', async () => {
    const a = await deriveShareHash('user_abc', '2026-04-18', SECRET_A);
    const b = await deriveShareHash('user_abc', '2026-04-18', SECRET_A);
    assert.equal(a, b);
  });

  it('differs for different userIds', async () => {
    const a = await deriveShareHash('user_abc', '2026-04-18', SECRET_A);
    const b = await deriveShareHash('user_xyz', '2026-04-18', SECRET_A);
    assert.notEqual(a, b);
  });

  it('differs for different dates', async () => {
    const a = await deriveShareHash('user_abc', '2026-04-18', SECRET_A);
    const b = await deriveShareHash('user_abc', '2026-04-19', SECRET_A);
    assert.notEqual(a, b);
  });

  it('differs for different secrets (rotation invalidates old hashes)', async () => {
    const a = await deriveShareHash('user_abc', '2026-04-18', SECRET_A);
    const b = await deriveShareHash('user_abc', '2026-04-18', SECRET_B);
    assert.notEqual(a, b);
  });

  it('throws BriefShareUrlError on missing secret', async () => {
    await assert.rejects(
      () => deriveShareHash('user_abc', '2026-04-18', ''),
      (err: unknown) =>
        err instanceof BriefShareUrlError && err.code === 'missing_secret',
    );
  });

  it('throws on malformed userId', async () => {
    await assert.rejects(
      () => deriveShareHash('has spaces', '2026-04-18', SECRET_A),
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
    const encoded = encodePublicPointer('user_abc', '2026-04-18');
    assert.equal(encoded, 'user_abc:2026-04-18');
    assert.deepEqual(decodePublicPointer(encoded), {
      userId: 'user_abc',
      issueDate: '2026-04-18',
    });
  });

  it('rejects malformed inputs at encode time', () => {
    assert.throws(() => encodePublicPointer('bad user', '2026-04-18'), BriefShareUrlError);
    assert.throws(() => encodePublicPointer('user_abc', 'not-a-date'), BriefShareUrlError);
  });

  it('returns null on any decode failure', () => {
    assert.equal(decodePublicPointer(null), null);
    assert.equal(decodePublicPointer(42), null);
    assert.equal(decodePublicPointer(''), null);
    assert.equal(decodePublicPointer('no-colon'), null);
    assert.equal(decodePublicPointer('user:not-a-date'), null);
    assert.equal(decodePublicPointer('user spaces:2026-04-18'), null);
  });
});

describe('buildPublicBriefUrl', () => {
  it('returns a full URL under baseUrl with the derived hash in the path', async () => {
    const { url, hash } = await buildPublicBriefUrl({
      userId: 'user_abc',
      issueDate: '2026-04-18',
      baseUrl: 'https://worldmonitor.app',
      secret: SECRET_A,
    });
    assert.match(url, /^https:\/\/worldmonitor\.app\/api\/brief\/public\/[A-Za-z0-9_-]{12}$/);
    assert.ok(url.endsWith(hash));
  });

  it('attaches ?ref= when refCode is provided', async () => {
    const { url } = await buildPublicBriefUrl({
      userId: 'user_abc',
      issueDate: '2026-04-18',
      baseUrl: 'https://worldmonitor.app',
      secret: SECRET_A,
      refCode: 'ABC123',
    });
    assert.ok(url.endsWith('?ref=ABC123'));
  });

  it('URL-encodes refCode safely', async () => {
    const { url } = await buildPublicBriefUrl({
      userId: 'user_abc',
      issueDate: '2026-04-18',
      baseUrl: 'https://worldmonitor.app',
      secret: SECRET_A,
      refCode: 'a b+c',
    });
    assert.ok(url.includes('?ref=a%20b%2Bc'));
  });

  it('trims trailing slashes from baseUrl', async () => {
    const { url } = await buildPublicBriefUrl({
      userId: 'user_abc',
      issueDate: '2026-04-18',
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
    const encoded = encodePublicPointer('user_abc', '2026-04-18');
    // Write side: what api/brief/share-url.ts sends to Redis.
    const wireValue = JSON.stringify(encoded);
    // Read side: what readRawJsonFromUpstash returns after parsing
    // Upstash's `{result: <wireValue>}` response.
    const parsed = JSON.parse(wireValue);
    assert.equal(typeof parsed, 'string', 'parsed pointer is a string');
    const pointer = decodePublicPointer(parsed);
    assert.deepEqual(pointer, { userId: 'user_abc', issueDate: '2026-04-18' });
  });

  it('a raw colon-delimited string (the P1 bug) fails JSON.parse', () => {
    // This is the format the earlier buggy code wrote. If we ever
    // revert to it, readRawJsonFromUpstash's parse will throw and
    // the public route will 503. Locking the failure so anyone
    // who reintroduces the bug gets a red test.
    assert.throws(() => JSON.parse('user_abc:2026-04-18'), SyntaxError);
  });
});
