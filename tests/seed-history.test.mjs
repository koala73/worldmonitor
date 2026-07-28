/**
 * Unit tests for scripts/_seed-history.mjs — the seeder-side helper that
 * embeds and appends historical intelligence records to the Convex
 * intel-history relay.
 *
 * Everything is exercised through the `deps` DI seam (fetch / embed /
 * env), mirroring the stub-embedder pattern in
 * tests/brief-dedup-embedding.test.mjs. No network, no seeder imports.
 *
 * Run: ./node_modules/.bin/tsx --test tests/seed-history.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  HISTORY_CHUNK_SIZE,
  HISTORY_MAX_RECORDS_PER_RUN,
  appendSeedHistory,
  buildHistoryEmbeddingText,
  normalizeHistoryRecords,
} from '../scripts/_seed-history.mjs';

// ── Fixtures / harness ────────────────────────────────────────────────────────

const ENV = {
  CONVEX_SITE_URL: 'https://example.convex.site',
  RELAY_SHARED_SECRET: 'test-secret',
  OPENROUTER_API_KEY: 'sk-test',
};

const BASE_AT = Date.UTC(2026, 6, 1);

function record(i, overrides = {}) {
  return {
    dedupeKey: `conflict:acled:evt-${i}`,
    title: `Event ${i}`,
    summary: `Summary for event ${i}`,
    country: 'LB',
    category: 'conflict',
    sourceUrl: `https://example.test/${i}`,
    occurredAt: BASE_AT + i * 1000,
    ...overrides,
  };
}

/**
 * Fetch stub. `plan` maps a 0-based call index to a response spec; any
 * index without an entry falls back to `fallback`. Captures every call.
 */
function stubFetch(fallback, plan = {}) {
  const calls = [];
  async function fetchImpl(url, init) {
    const index = calls.length;
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const spec = plan[index] ?? fallback;
    const status = spec.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => spec.body ?? {},
      text: async () => spec.text ?? JSON.stringify(spec.body ?? {}),
    };
  }
  return { fetchImpl, calls };
}

/** Deterministic embedder that records the exact texts it was handed. */
function stubEmbed() {
  const batches = [];
  async function embed(texts) {
    batches.push(texts.slice());
    return texts.map((t, i) => [t.length, i, 0.5, -0.5]);
  }
  return { embed, batches };
}

/** Capture console.warn for the duration of `fn`. */
async function withCapturedWarn(fn) {
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => warns.push(args.map(String).join(' '));
  try {
    return { result: await fn(), warns };
  } finally {
    console.warn = original;
  }
}

// ── normalizeHistoryRecords (pure) ────────────────────────────────────────────

describe('normalizeHistoryRecords', () => {
  it('drops records missing dedupeKey, title, or a finite occurredAt', () => {
    const out = normalizeHistoryRecords([
      record(1),
      record(2, { dedupeKey: undefined }),
      record(3, { dedupeKey: '   ' }),
      record(4, { title: '' }),
      record(5, { title: undefined }),
      record(6, { occurredAt: 'yesterday' }),
      record(7, { occurredAt: Number.NaN }),
      record(8, { occurredAt: undefined }),
      null,
      undefined,
      'not-an-object',
      record(9),
    ]);

    assert.deepEqual(
      out.map((r) => r.dedupeKey),
      ['conflict:acled:evt-9', 'conflict:acled:evt-1'],
    );
  });

  // The relay route rejects a dedupeKey over 256 chars with a 400 that fails
  // the WHOLE chunk, so an over-long key must never reach the wire. It is
  // dropped rather than clipped: dedupeKey is an identity, and two distinct
  // events truncated to the same prefix would silently collapse into one row.
  it('drops an over-long dedupeKey instead of truncating it into a collision', () => {
    const prefix = `conflict:acled:${'x'.repeat(250)}`;
    const out = normalizeHistoryRecords([
      record(1, { dedupeKey: `${prefix}-AAAA` }),
      record(2, { dedupeKey: `${prefix}-BBBB` }),
      record(3, { dedupeKey: 'conflict:acled:short' }),
    ]);

    assert.deepEqual(
      out.map((r) => r.dedupeKey),
      ['conflict:acled:short'],
    );
  });

  it('keeps a dedupeKey exactly at the wire limit', () => {
    const exact = 'k'.repeat(256);
    const out = normalizeHistoryRecords([record(1, { dedupeKey: exact })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].dedupeKey.length, 256);
  });

  // sourceUrl is published to agents as a canonical link and history is
  // durable, so a poisoned feed's javascript:/data: value would persist for
  // the full retention window. The field is dropped; the row is kept.
  it('drops a non-http(s) sourceUrl but keeps the record', () => {
    const hostile = [
      'javascript:alert(1)',
      '\tjavascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      '//evil.test/path',
      'not a url at all',
    ];

    for (const sourceUrl of hostile) {
      const out = normalizeHistoryRecords([record(1, { sourceUrl })]);
      assert.equal(out.length, 1, `${sourceUrl}: record must survive`);
      assert.equal(out[0].sourceUrl, undefined, `${sourceUrl}: field must be dropped`);
      assert.equal(out[0].title, 'Event 1');
    }
  });

  it('keeps http and https sourceUrls', () => {
    for (const sourceUrl of ['https://example.test/a', 'http://example.test/b']) {
      const [out] = normalizeHistoryRecords([record(1, { sourceUrl })]);
      assert.equal(out.sourceUrl, sourceUrl);
    }
  });

  it('keeps the newest HISTORY_MAX_RECORDS_PER_RUN by occurredAt desc', () => {
    const input = [];
    for (let i = 0; i < HISTORY_MAX_RECORDS_PER_RUN + 60; i++) input.push(record(i));

    const out = normalizeHistoryRecords(input);

    assert.equal(out.length, HISTORY_MAX_RECORDS_PER_RUN);
    assert.equal(out[0].dedupeKey, `conflict:acled:evt-${HISTORY_MAX_RECORDS_PER_RUN + 59}`);
    // Sorted newest-first, and the oldest kept record is exactly the
    // 150th newest input.
    for (let i = 1; i < out.length; i++) {
      assert.ok(out[i - 1].occurredAt >= out[i].occurredAt);
    }
    assert.equal(out.at(-1).dedupeKey, `conflict:acled:evt-60`);
  });

  it('truncates title to 500 chars and summary to 2000 chars', () => {
    const [out] = normalizeHistoryRecords([
      record(1, { title: 'T'.repeat(900), summary: 'S'.repeat(4000) }),
    ]);

    assert.equal(out.title.length, 500);
    assert.equal(out.summary.length, 2000);
  });

  it('passes the wire fields through and drops unknown keys', () => {
    const [out] = normalizeHistoryRecords([record(1, { embedding: [1, 2, 3], junk: 'x' })]);

    assert.deepEqual(Object.keys(out).sort(), [
      'category',
      'country',
      'dedupeKey',
      'occurredAt',
      'sourceUrl',
      'summary',
      'title',
    ]);
  });

  it('returns an empty array for a non-array input', () => {
    assert.deepEqual(normalizeHistoryRecords(undefined), []);
    assert.deepEqual(normalizeHistoryRecords(null), []);
  });
});

// ── buildHistoryEmbeddingText (pure) ──────────────────────────────────────────

describe('buildHistoryEmbeddingText', () => {
  it('joins title and summary, normalizes, and caps the result at 300 chars', () => {
    assert.equal(
      buildHistoryEmbeddingText({ title: 'Iran Closes  Strait', summary: 'Tankers Rerouted' }),
      'iran closes strait — tankers rerouted',
    );
    assert.equal(buildHistoryEmbeddingText({ title: 'Bare Title' }), 'bare title');

    const long = buildHistoryEmbeddingText({ title: 'L'.repeat(400), summary: 'S'.repeat(400) });
    assert.equal(long.length, 300);
    assert.ok(!long.includes('—'), 'no room for a summary behind an over-long title');
  });
});

// ── appendSeedHistory — env guard ─────────────────────────────────────────────

describe('appendSeedHistory env guard', () => {
  it('returns { skipped: "unconfigured" } with exactly one warn and no fetch', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { inserted: 1, skipped: 0 } });
    const { embed, batches } = stubEmbed();

    const { result, warns } = await withCapturedWarn(() =>
      appendSeedHistory(
        { domain: 'conflict', resource: 'acled', runId: 'run-1', records: [record(1)] },
        { fetchImpl, embed, env: {} },
      ),
    );

    assert.deepEqual(result, { skipped: 'unconfigured' });
    assert.equal(calls.length, 0);
    assert.equal(batches.length, 0);
    assert.equal(warns.length, 1);
  });

  it('names every missing variable in the single warn', async () => {
    const { fetchImpl } = stubFetch({ body: {} });
    const { embed } = stubEmbed();

    const { warns } = await withCapturedWarn(() =>
      appendSeedHistory(
        { domain: 'conflict', resource: 'acled', runId: 'run-1', records: [record(1)] },
        { fetchImpl, embed, env: { CONVEX_SITE_URL: ENV.CONVEX_SITE_URL } },
      ),
    );

    assert.equal(warns.length, 1);
    assert.match(warns[0], /RELAY_SHARED_SECRET/);
    assert.match(warns[0], /OPENROUTER_API_KEY/);
    assert.doesNotMatch(warns[0], /CONVEX_SITE_URL/);
  });

  it('derives CONVEX_SITE_URL from CONVEX_URL (.convex.cloud → .convex.site)', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { inserted: 1, skipped: 0 } });
    const { embed } = stubEmbed();

    const result = await appendSeedHistory(
      { domain: 'conflict', resource: 'acled', runId: 'run-1', records: [record(1)] },
      {
        fetchImpl,
        embed,
        env: {
          CONVEX_URL: 'https://fearless-otter-42.convex.cloud',
          RELAY_SHARED_SECRET: ENV.RELAY_SHARED_SECRET,
          OPENROUTER_API_KEY: ENV.OPENROUTER_API_KEY,
        },
      },
    );

    assert.deepEqual(result, { inserted: 1, skipped: 0, chunks: 1, abandoned: 0, failedChunks: 0 });
    assert.equal(calls[0].url, 'https://fearless-otter-42.convex.site/relay/intel-history');
  });
});

// ── appendSeedHistory — happy path ────────────────────────────────────────────

describe('appendSeedHistory', () => {
  it('returns zeros without fetching when nothing survives normalization', async () => {
    const { fetchImpl, calls } = stubFetch({ body: {} });
    const { embed, batches } = stubEmbed();

    const result = await appendSeedHistory(
      {
        domain: 'conflict',
        resource: 'acled',
        runId: 'run-1',
        records: [record(1, { dedupeKey: null }), null],
      },
      { fetchImpl, embed, env: ENV },
    );

    assert.deepEqual(result, { inserted: 0, skipped: 0, chunks: 0, abandoned: 0, failedChunks: 0 });
    assert.equal(calls.length, 0);
    assert.equal(batches.length, 0);
  });

  it('chunks 120 records into 50/50/20 POSTs and aggregates the counters', async () => {
    const { fetchImpl, calls } = stubFetch(
      { body: { inserted: 0, skipped: 0 } },
      {
        0: { body: { inserted: 40, skipped: 10 } },
        1: { body: { inserted: 45, skipped: 5 } },
        2: { body: { inserted: 18, skipped: 2 } },
      },
    );
    const { embed } = stubEmbed();

    const records = [];
    for (let i = 0; i < 120; i++) records.push(record(i));

    const result = await appendSeedHistory(
      { domain: 'conflict', resource: 'acled', runId: 'run-42', records },
      { fetchImpl, embed, env: ENV },
    );

    assert.deepEqual(result, { inserted: 103, skipped: 17, chunks: 3, abandoned: 0, failedChunks: 0 });
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((c) => c.body.records.length),
      [HISTORY_CHUNK_SIZE, HISTORY_CHUNK_SIZE, 20],
    );

    for (const call of calls) {
      assert.equal(call.url, 'https://example.convex.site/relay/intel-history');
      assert.equal(call.init.method, 'POST');
      assert.equal(call.init.headers.Authorization, 'Bearer test-secret');
      assert.equal(call.init.headers['Content-Type'], 'application/json');
      assert.equal(call.body.domain, 'conflict');
      assert.equal(call.body.resource, 'acled');
      assert.equal(call.body.runId, 'run-42');
      for (const r of call.body.records) {
        assert.ok(Array.isArray(r.embedding), 'each record carries its embedding');
        assert.equal(typeof r.dedupeKey, 'string');
      }
    }

    // Chunk boundaries must not shuffle: the vector attached to a record
    // is the one embedded for that record's own text.
    const firstRecord = calls[0].body.records[0];
    assert.equal(firstRecord.embedding[1], 0, 'first record gets the first vector');
  });

  it('embeds "title — summary" normalized and capped at 300 chars', async () => {
    const { fetchImpl } = stubFetch({ body: { inserted: 2, skipped: 0 } });
    const { embed, batches } = stubEmbed();

    await appendSeedHistory(
      {
        domain: 'conflict',
        resource: 'acled',
        runId: 'run-1',
        records: [
          record(1, {
            occurredAt: BASE_AT + 2000,
            title: 'Iran Closes Strait Of Hormuz',
            summary: 'Tankers rerouted around the cape',
          }),
          record(2, {
            occurredAt: BASE_AT + 1000,
            title: 'L'.repeat(120),
            summary: 'S'.repeat(900),
          }),
        ],
      },
      { fetchImpl, embed, env: ENV },
    );

    assert.equal(batches.length, 1);
    const [texts] = batches;
    assert.equal(texts.length, 2);
    assert.equal(texts[0], 'iran closes strait of hormuz — tankers rerouted around the cape');
    assert.ok(texts[1].length <= 300, `expected <=300 chars, got ${texts[1].length}`);
    assert.ok(texts[1].startsWith('l'.repeat(120)));
    assert.ok(texts[1].includes(' — '), 'summary is appended when budget allows');
  });

  it('omits the separator when the record has no summary', async () => {
    const { fetchImpl } = stubFetch({ body: { inserted: 1, skipped: 0 } });
    const { embed, batches } = stubEmbed();

    await appendSeedHistory(
      {
        domain: 'conflict',
        resource: 'acled',
        runId: 'run-1',
        records: [record(1, { title: 'Bare Title', summary: undefined })],
      },
      { fetchImpl, embed, env: ENV },
    );

    assert.deepEqual(batches[0], ['bare title']);
  });

  // The append runs AFTER the canonical publish but BEFORE runSeed writes
  // seed-meta. A degraded relay that stalls this loop (3 chunks x 3 attempts x
  // a 10s timeout) risks a SIGTERM landing before the freshness write, which
  // would publish fresh data that health then reads as stale. The budget stops
  // issuing chunks instead of stalling; whatever already committed is kept.
  it('abandons remaining chunks once the aggregate budget is spent', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { inserted: 50, skipped: 0 } });
    const { embed } = stubEmbed();

    const records = [];
    for (let i = 0; i < 120; i++) records.push(record(i));

    // Deadline, embed allowance, post-embed guard, first chunk guard, and the
    // first request all stay inside the budget. The second chunk sees expiry.
    let ticks = 0;
    const now = () => (ticks++ < 5 ? 0 : 999_999);

    const result = await appendSeedHistory(
      { domain: 'conflict', resource: 'acled', runId: 'run-budget', records },
      { fetchImpl, embed, env: ENV, now, budgetMs: 30_000 },
    );

    assert.equal(calls.length, 1, 'only the pre-deadline chunk is sent');
    assert.equal(result.chunks, 1);
    assert.equal(result.inserted, 50, 'the committed chunk still counts');
    assert.equal(result.abandoned, 70, 'the untried remainder (120 - the 50 sent) is reported');
    assert.equal(result.failedChunks, 0);
  });

  it('includes embedding in the aggregate budget and sends no relay request after expiry', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { inserted: 1, skipped: 0 } });
    let currentTime = 0;
    let receivedOptions;
    const embed = async (texts, options) => {
      receivedOptions = options;
      currentTime = 30_001;
      return texts.map(() => [1, 0, 0, 0]);
    };

    const { result, warns } = await withCapturedWarn(() =>
      appendSeedHistory(
        { domain: 'conflict', resource: 'acled', runId: 'run-slow-embed', records: [record(1)] },
        {
          fetchImpl,
          embed,
          env: ENV,
          now: () => currentTime,
          budgetMs: 30_000,
        },
      ),
    );

    assert.equal(receivedOptions.wallClockMs, 30_000);
    assert.equal(receivedOptions.deadline, 30_000);
    assert.equal(calls.length, 0);
    assert.deepEqual(result, {
      inserted: 0,
      skipped: 0,
      chunks: 0,
      abandoned: 1,
      failedChunks: 0,
    });
    assert.ok(warns.some((w) => w.includes('budget exhausted during embedding')));
  });

  it('does not retry a relay failure after the shared deadline expires', async () => {
    let currentTime = 0;
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      currentTime = 501;
      return {
        ok: false,
        status: 500,
        headers: {},
        json: async () => ({ error: 'slow failure' }),
        text: async () => 'slow failure',
      };
    };
    const { embed } = stubEmbed();

    const { result, warns } = await withCapturedWarn(() =>
      appendSeedHistory(
        { domain: 'conflict', resource: 'acled', runId: 'run-relay-budget', records: [record(1)] },
        {
          fetchImpl,
          embed,
          env: ENV,
          now: () => currentTime,
          sleep: async () => assert.fail('retry sleep must not run after deadline'),
          budgetMs: 500,
        },
      ),
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(result, {
      inserted: 0,
      skipped: 0,
      chunks: 0,
      abandoned: 1,
      failedChunks: 0,
    });
    assert.ok(warns.some((w) => w.includes('budget exhausted during relay')));
  });

  // Chunks are independent POSTs over a newest-first slice, so letting one
  // rejection unwind the loop would discard the OLDER history the remaining
  // chunks would have stored fine.
  it('keeps going when a middle chunk fails permanently', async () => {
    const { fetchImpl, calls } = stubFetch(
      { body: { inserted: 50, skipped: 0 } },
      { 1: { status: 400, body: { error: 'INVALID_RECORD' }, text: 'INVALID_RECORD' } },
    );
    const { embed } = stubEmbed();

    const records = [];
    for (let i = 0; i < 120; i++) records.push(record(i));

    const { result, warns } = await withCapturedWarn(() =>
      appendSeedHistory(
        { domain: 'conflict', resource: 'acled', runId: 'run-partial', records },
        { fetchImpl, embed, env: ENV },
      ),
    );

    assert.equal(calls.length, 3, 'the third chunk is still attempted');
    assert.equal(result.chunks, 2, 'two chunks committed');
    assert.equal(result.failedChunks, 1);
    assert.equal(result.inserted, 100);
    assert.ok(warns.some((w) => w.includes('chunk 2 failed')));
  });

  // A systemic outage (bad secret, relay down) must not be reported as a
  // successful no-op run — every chunk failing still surfaces the error.
  it('throws when every chunk fails', async () => {
    const { fetchImpl } = stubFetch({ status: 500, body: { error: 'boom' }, text: 'boom' });
    const { embed } = stubEmbed();

    await withCapturedWarn(async () => {
      await assert.rejects(
        appendSeedHistory(
          { domain: 'conflict', resource: 'acled', runId: 'run-dead', records: [record(1)] },
          { fetchImpl, embed, env: ENV },
        ),
        /HTTP 500/,
      );
    });
  });

  it('retries a 500 chunk and still aggregates the full result', async () => {
    const { fetchImpl, calls } = stubFetch(
      { body: { inserted: 0, skipped: 0 } },
      {
        0: { status: 500, text: 'upstream boom' },
        1: { body: { inserted: 3, skipped: 1 } },
      },
    );
    const { embed } = stubEmbed();

    const { result } = await withCapturedWarn(() =>
      appendSeedHistory(
        {
          domain: 'conflict',
          resource: 'acled',
          runId: 'run-1',
          records: [record(1), record(2), record(3), record(4)],
        },
        { fetchImpl, embed, env: ENV },
      ),
    );

    assert.deepEqual(result, { inserted: 3, skipped: 1, chunks: 1, abandoned: 0, failedChunks: 0 });
    assert.equal(calls.length, 2, 'one failed attempt + one successful retry');
  });

  it('throws with the status and a body snippet on a persistent non-ok response', async () => {
    const { fetchImpl, calls } = stubFetch({ status: 401, text: 'bad relay secret' });
    const { embed } = stubEmbed();

    await assert.rejects(
      () =>
        appendSeedHistory(
          { domain: 'conflict', resource: 'acled', runId: 'run-1', records: [record(1)] },
          { fetchImpl, embed, env: ENV },
        ),
      (err) => {
        assert.match(err.message, /401/);
        assert.match(err.message, /bad relay secret/);
        assert.equal(err.status, 401);
        return true;
      },
    );
    // 401 is permanent — no point burning the seeder's budget on backoff.
    assert.equal(calls.length, 1);
  });

  it('truncates the error body snippet to 200 chars', async () => {
    const { fetchImpl } = stubFetch({ status: 403, text: 'x'.repeat(5000) });
    const { embed } = stubEmbed();

    await assert.rejects(
      () =>
        appendSeedHistory(
          { domain: 'conflict', resource: 'acled', runId: 'run-1', records: [record(1)] },
          { fetchImpl, embed, env: ENV },
        ),
      (err) => {
        assert.ok(err.message.length < 400, `message too long: ${err.message.length}`);
        return true;
      },
    );
  });

  it('throws when the embedder returns the wrong number of vectors', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { inserted: 1, skipped: 0 } });

    await assert.rejects(
      () =>
        appendSeedHistory(
          { domain: 'conflict', resource: 'acled', runId: 'run-1', records: [record(1), record(2)] },
          { fetchImpl, embed: async () => [[1, 2, 3]], env: ENV },
        ),
      /embedding/i,
    );
    assert.equal(calls.length, 0, 'nothing is POSTed when the embed batch is short');
  });

  it('rejects a missing domain or resource before doing any work', async () => {
    const { fetchImpl, calls } = stubFetch({ body: {} });
    const { embed } = stubEmbed();

    await assert.rejects(
      () => appendSeedHistory({ resource: 'acled', records: [record(1)] }, { fetchImpl, embed, env: ENV }),
      /domain/i,
    );
    await assert.rejects(
      () => appendSeedHistory({ domain: 'conflict', records: [record(1)] }, { fetchImpl, embed, env: ENV }),
      /resource/i,
    );
    assert.equal(calls.length, 0);
  });
});
