// SAM.gov request-budget regression tests (#5444).
//
// SAM.gov enforces a small per-key daily quota (10/day for non-federal keys).
// Pre-fix, the hourly seed fetched SAM every tick AND retried 429s in-run —
// ~72 requests/day against a 10/day budget — so the source pinned at HTTP 429
// and its age climbed past the 180-minute staleness ceiling (health
// SEED_ERROR, empty US tender queries). The fix spreads the budget: skip the
// request while the last success is fresher than SAM_MIN_FETCH_INTERVAL, and
// never spend in-run retries on a 429.
import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchSam } from '../scripts/seed-global-tenders.mjs';

const NOW = Date.parse('2026-07-22T12:00:00Z');
const OPEN_TENDER = {
  id: 'sam-1',
  source: 'sam',
  title: 'Cybersecurity support services',
  status: 'active',
  deadline: '2099-01-01T00:00:00Z',
};

function samSnapshot(lastSuccessfulAt) {
  return {
    tenders: [OPEN_TENDER],
    sourceStatuses: [
      {
        source: 'sam',
        state: 'ok',
        recordCount: 1,
        fetchedAt: lastSuccessfulAt,
        lastSuccessfulAt,
        stale: false,
      },
    ],
  };
}

test('fetchSam skips the request while the previous success is inside the budget interval', async () => {
  const calls = [];
  const fetchJsonFn = async (url) => {
    calls.push(String(url));
    return { opportunitiesData: [] };
  };
  const lastSuccessfulAt = new Date(NOW - 10 * 60_000).toISOString();

  const result = await fetchSam({
    apiKey: 'test-key',
    now: NOW,
    fetchJsonFn,
    previousSnapshot: samSnapshot(lastSuccessfulAt),
  });

  assert.equal(calls.length, 0, 'must not spend a SAM request inside the pacing interval');
  assert.equal(result.status.state, 'ok');
  assert.equal(result.status.paced, true);
  assert.equal(result.status.lastSuccessfulAt, lastSuccessfulAt, 'real success time must be preserved');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, 'sam-1');
});

test('fetchSam fetches again once the previous success is older than the interval', async () => {
  const calls = [];
  const fetchJsonFn = async (url) => {
    calls.push(String(url));
    return { opportunitiesData: [] };
  };
  const lastSuccessfulAt = new Date(NOW - 200 * 60_000).toISOString();

  const result = await fetchSam({
    apiKey: 'test-key',
    now: NOW,
    fetchJsonFn,
    previousSnapshot: samSnapshot(lastSuccessfulAt),
  });

  assert.equal(calls.length, 1, 'stale-enough prior success must trigger a real fetch');
  assert.equal(result.status.state, 'ok');
  assert.equal(result.status.paced, undefined);
});

test('fetchSam without a previous snapshot fetches (first run unchanged)', async () => {
  const calls = [];
  const fetchJsonFn = async () => {
    calls.push(1);
    return { opportunitiesData: [] };
  };
  await fetchSam({ apiKey: 'test-key', now: NOW, fetchJsonFn });
  assert.equal(calls.length, 1);
});

test('a SAM 429 is not retried in-run (no quota burn)', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: false,
      status: 429,
      headers: { get: () => null },
      text: async () => '',
      json: async () => ({}),
    };
  };

  await assert.rejects(
    () => fetchSam({ apiKey: 'test-key', now: NOW }),
    /HTTP 429/,
  );
  assert.equal(calls.length, 1, '429 must fail fast instead of burning retry attempts');
});
