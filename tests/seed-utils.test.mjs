import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isTransientRedisError, computeRecordCount } from '../scripts/_seed-utils.mjs';

describe('seed utils redis error handling', () => {
  it('treats undici connect timeout as transient', () => {
    const err = new TypeError('fetch failed');
    err.cause = new Error('Connect Timeout Error');
    err.cause.code = 'UND_ERR_CONNECT_TIMEOUT';

    assert.equal(isTransientRedisError(err), true);
  });

  it('treats ECONNRESET as transient', () => {
    const err = new Error('fetch failed');
    err.cause = new Error('read ECONNRESET');
    err.cause.code = 'ECONNRESET';
    assert.equal(isTransientRedisError(err), true);
  });

  it('treats DNS lookup failure as transient', () => {
    const err = new Error('fetch failed');
    err.cause = new Error('getaddrinfo EAI_AGAIN redis-host');
    err.cause.code = 'EAI_AGAIN';
    assert.equal(isTransientRedisError(err), true);
  });

  it('treats ETIMEDOUT as transient', () => {
    const err = new Error('fetch failed');
    err.cause = new Error('connect ETIMEDOUT');
    err.cause.code = 'ETIMEDOUT';
    assert.equal(isTransientRedisError(err), true);
  });

  it('does not treat Redis HTTP 403 as transient', () => {
    const err = new Error('Redis command failed: HTTP 403');
    assert.equal(isTransientRedisError(err), false);
  });

  it('does not treat generic validation errors as transient', () => {
    const err = new Error('validation failed');
    assert.equal(isTransientRedisError(err), false);
  });

  it('does not treat payload size errors as transient', () => {
    const err = new Error('Payload too large: 6.2MB > 5MB limit');
    assert.equal(isTransientRedisError(err), false);
  });
});

describe('computeRecordCount', () => {
  it('uses opts.recordCount as a number when provided', () => {
    assert.equal(
      computeRecordCount({ opts: { recordCount: 42 }, data: { foo: 'bar' }, payloadBytes: 1000 }),
      42,
    );
  });

  it('uses opts.recordCount as a function when provided', () => {
    const data = { items: [1, 2, 3, 4, 5] };
    assert.equal(
      computeRecordCount({ opts: { recordCount: (d) => d.items.length * 2 }, data, payloadBytes: 100 }),
      10,
    );
  });

  it('respects opts.recordCount=0 even when payload has bytes (explicit zero)', () => {
    // A seeder that explicitly says "0 records" must be trusted — used by
    // seeders like seed-owid-energy-mix that never have a meaningful count.
    assert.equal(
      computeRecordCount({ opts: { recordCount: 0 }, data: { stuff: 1 }, payloadBytes: 500 }),
      0,
    );
  });

  it('auto-detects array length when data is an array', () => {
    assert.equal(
      computeRecordCount({ data: [1, 2, 3, 4], payloadBytes: 100 }),
      4,
    );
  });

  // Note: node:test does not provide it.each — explicit cases below.
  it('auto-detects data.events.length', () => {
    assert.equal(
      computeRecordCount({ data: { events: [{}, {}, {}] }, payloadBytes: 50 }),
      3,
    );
  });

  it('auto-detects data.predictions.length', () => {
    assert.equal(
      computeRecordCount({ data: { predictions: [{}, {}] }, payloadBytes: 30 }),
      2,
    );
  });

  it('auto-detects topicArticleCount when topics shape', () => {
    assert.equal(
      computeRecordCount({ data: { topics: [{}] }, topicArticleCount: 17, payloadBytes: 200 }),
      17,
    );
  });

  it('does NOT fire fallback when known shape returns 0 (empty array, payloadBytes>0)', () => {
    // Regression guard: if a seeder publishes {events: []} (genuinely zero
    // events upstream), the JSON serialization is non-empty (~12 bytes for
    // {"events":[]}). detectedFromShape resolves to 0 (a real number, not
    // null), so the chain MUST stop there and report 0 — not flip to the
    // payloadBytes>0 fallback. Otherwise we'd silently mask genuine empty
    // upstream cycles as "1 record" and break the SKIPPED/EMPTY signal.
    let warned = false;
    const result = computeRecordCount({
      data: { events: [] },
      payloadBytes: 12,
      onPhantomFallback: () => { warned = true; },
    });
    assert.equal(result, 0);
    assert.equal(warned, false, 'no fallback when known shape is present but empty');
  });

  it('FALLBACK: returns 1 when payloadBytes>0 and shape unknown (phantom EMPTY_DATA fix)', () => {
    // This is the proven-payload fallback. Without it, a seeder that publishes
    // {score, inputs} (e.g. seed-fear-greed) would write recordCount=0 to
    // seed-meta and trigger phantom EMPTY_DATA in /api/health even though the
    // panel renders fine.
    let warned = false;
    const result = computeRecordCount({
      data: { score: 42, inputs: { foo: 'bar' } },  // unknown shape
      payloadBytes: 6093,
      onPhantomFallback: () => { warned = true; },
    });
    assert.equal(result, 1);
    assert.equal(warned, true, 'expected onPhantomFallback to fire');
  });

  it('returns 0 when neither known shape nor payloadBytes > 0', () => {
    let warned = false;
    const result = computeRecordCount({
      data: { unknownShape: true },
      payloadBytes: 0,
      onPhantomFallback: () => { warned = true; },
    });
    assert.equal(result, 0);
    assert.equal(warned, false, 'no fallback warn when payload is empty');
  });

  it('does not fire fallback when shape matches (no spurious warn)', () => {
    let warned = false;
    computeRecordCount({
      data: [1, 2, 3],
      payloadBytes: 100,
      onPhantomFallback: () => { warned = true; },
    });
    assert.equal(warned, false);
  });

  it('opts.recordCount=0 from a function suppresses fallback (explicit-zero precedence)', () => {
    let warned = false;
    const result = computeRecordCount({
      opts: { recordCount: () => 0 },
      data: { mystery: true },
      payloadBytes: 9999,
      onPhantomFallback: () => { warned = true; },
    });
    assert.equal(result, 0);
    assert.equal(warned, false);
  });
});
