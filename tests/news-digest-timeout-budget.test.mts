import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';

const {
  VERCEL_INITIAL_RESPONSE_LIMIT_MS,
  DIGEST_RESPONSE_TIMEOUT_MS,
  POST_FETCH_HEADROOM_MS,
  OVERALL_DEADLINE_MS,
} = __testing__;

const DIGEST_SRC = readFileSync(
  new URL('../server/worldmonitor/news/v1/list-feed-digest.ts', import.meta.url),
  'utf8',
);

describe('news digest timeout budget', () => {
  it('keeps cold cache misses below Vercel initial-response timeout', () => {
    assert.equal(VERCEL_INITIAL_RESPONSE_LIMIT_MS, 25_000);
    assert.ok(
      DIGEST_RESPONSE_TIMEOUT_MS <= VERCEL_INITIAL_RESPONSE_LIMIT_MS - 5_000,
      'digest cache miss timeout must leave platform response headroom',
    );
    assert.ok(
      OVERALL_DEADLINE_MS <= VERCEL_INITIAL_RESPONSE_LIMIT_MS - POST_FETCH_HEADROOM_MS,
      'RSS collection must leave post-fetch assembly headroom',
    );
    assert.ok(
      OVERALL_DEADLINE_MS < DIGEST_RESPONSE_TIMEOUT_MS,
      'RSS collection deadline must fire before the cache miss response timeout',
    );
  });

  it('passes the digest-specific timeout to cachedFetchJson', () => {
    assert.match(
      DIGEST_SRC,
      /cachedFetchJson<ListFeedDigestResponse>\([\s\S]*\{\s*timeoutMs:\s*DIGEST_RESPONSE_TIMEOUT_MS\s*\}\s*,\s*\)/,
      'listFeedDigest must not rely on cachedFetchJson default timeout for cold builds',
    );
  });
});
