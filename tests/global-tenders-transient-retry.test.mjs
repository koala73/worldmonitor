// Global-tender source adapters must survive a single transient upstream blip.
//
// Bug (found 2026-07-14 in production): /api/health reported
// globalTendersCanadaBuys: SEED_ERROR. The CanadaBuys upstream was perfectly
// healthy — probed 6/6 x HTTP 200, 6.0 MB, 2.1-4.3s against a 60s timeout — so a
// single transient failure on one hourly tick had failed the whole source and
// raised a health warn, then self-healed on the next tick.
//
// None of the six adapters had ANY retry: `fetchResponse` did one fetch and threw.
// One blip => source fails => health warn. That is noise the operator cannot act on
// and it trains them to ignore the channel.
//
// Bounded on purpose: the Global-Tenders bundle section has timeoutMs 180_000
// (scripts/seed-bundle-relay-backup.mjs) and CanadaBuys uses a 60s per-attempt
// timeout, so an unbounded retry chain would BREACH the section budget:
//   maxRetries 2 => 60 + 1 + 60 + 2 + 60 = 183s  > 180s  (breach)
//   maxRetries 1 => 60 + 1 + 60           = 121s  < 180s  (safe)
// Sources run in parallel (Promise.allSettled), so the section cost is the slowest
// source, not the sum.
import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchCanadaBuys } from '../scripts/seed-global-tenders.mjs';

const CSV = [
  '"title-titre-eng","referenceNumber-numeroReference","noticeURL-URLavis-eng",'
    + '"publicationDate-datePublication","tenderClosingDate-appelOffresDateCloture",'
    + '"tenderStatus-appelOffresStatut-eng"',
  '"Radar maintenance","REF-1","https://canadabuys.canada.ca/n/1","2026-07-01","2099-01-01","Open"',
].join('\n');

function stubFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const next = responses[calls.length - 1];
    if (!next) throw new Error('unexpected extra fetch');
    if (next.throw) throw Object.assign(new Error(next.throw), { name: 'TimeoutError' });
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (name) => next.headers?.[name.toLowerCase()] ?? null },
      text: async () => next.body ?? '',
      json: async () => ({}),
    };
  };
  return calls;
}

const realFetch = globalThis.fetch;

test('a transient CanadaBuys failure is retried, not surfaced as a source error', async () => {
  // First attempt dies the way a real blip dies (connection reset / timeout),
  // second attempt returns the documented CSV.
  const calls = stubFetch([{ throw: 'socket hang up' }, { status: 200, body: CSV }]);
  try {
    const { records, status } = await fetchCanadaBuys({ now: Date.parse('2026-07-14T00:00:00Z') });
    assert.equal(calls.length, 2, 'the transient failure must be retried');
    assert.equal(status.state, 'ok', 'a blip that succeeds on retry is not a source error');
    assert.equal(records.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a permanent 4xx is NOT retried — it would only burn the section timeout', async () => {
  // A 404/403 will not fix itself. withRetry honours `nonRetryable`, and retrying
  // here would waste the bundle's 180s budget for a guaranteed failure.
  const calls = stubFetch([{ status: 404, body: '' }]);
  try {
    await assert.rejects(
      () => fetchCanadaBuys({ now: Date.parse('2026-07-14T00:00:00Z') }),
      /HTTP 404/,
    );
    assert.equal(calls.length, 1, 'a permanent 4xx must fail fast, not retry');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('HTTP 408 is retried because it is a transient upstream timeout', async () => {
  const calls = stubFetch([{ status: 408, body: '' }, { status: 200, body: CSV }]);
  try {
    const { records, status } = await fetchCanadaBuys({ now: Date.parse('2026-07-14T00:00:00Z') });
    assert.equal(calls.length, 2, '408 must get the configured retry rather than fail as a permanent 4xx');
    assert.equal(status.state, 'ok');
    assert.equal(records.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
