// Regression test for issue #5848 (mitigation 1 of #5843).
//
// `seed-gdelt-intel` fetched its six topics in fixed INTEL_TOPICS order and
// opens a run-wide circuit on the first failure. Under GDELT's sustained
// supply-side load shedding (#5843) most runs fail on the very first request —
// but the rare run where one DOC request slipped through ALWAYS awarded that
// success to `military`, because `military` is always attempted first. Topics
// 2..N only refreshed when MULTIPLE CONSECUTIVE requests succeeded, which
// essentially never happens during the brownout.
//
// Production evidence, 2026-07-30, per-topic `fetchedAt` inside
// `intelligence:gdelt-intel:v1`: military 5.1h old; cyber 18 days;
// nuclear/sanctions/intelligence/maritime ~29 days. One topic monopolized every
// lottery win while five starved indefinitely.
//
// The fix rotates the fetch order on a per-topic `attemptedAt` liveness stamp,
// tie-broken by content staleness. Ordering on content staleness ALONE is an
// absorbing state — a topic that never succeeds never advances, so it is
// permanently the neediest, pins itself first every run, and trips the circuit
// before anything else is tried. These tests pin both properties: the scarce
// success rotates across topics, AND one broken topic cannot capture the rotation.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fetchAllTopics, rankTopicsForFetch, RUN_SEED_OPTS } from '../scripts/seed-gdelt-intel.mjs';

const TOPIC_IDS = ['military', 'cyber', 'nuclear', 'sanctions', 'intelligence', 'maritime'];

// Per-topic `fetchedAt` as observed in production on 2026-07-30 (issue #5848).
const PRODUCTION_STALENESS = {
  military: '2026-07-30T03:00:00.000Z',
  cyber: '2026-07-12T00:00:00.000Z',
  nuclear: '2026-07-01T00:00:00.000Z',
  sanctions: '2026-07-01T00:00:00.000Z',
  intelligence: '2026-07-01T00:00:00.000Z',
  maritime: '2026-07-01T00:00:00.000Z',
};

// The production snapshot predates `attemptedAt`, so no entry carries one — every
// topic reads as never-attempted and the staleness tie-break decides, which is
// exactly the ordering the deploy inherits on its first run.
function snapshotOf(fetchedAtById) {
  return {
    topics: Object.entries(fetchedAtById).map(([id, fetchedAt]) => ({
      id,
      articles: [{ title: `cached ${id}`, url: `https://example.test/cached/${id}` }],
      fetchedAt,
    })),
  };
}

// The snapshot a run leaves in Redis — and therefore the one the NEXT run reads —
// is exactly what the seeder's own publish transform emits. Reuse it rather than
// re-listing its redactions, so this harness cannot drift from production.
function asPublishedSnapshot(out) {
  return RUN_SEED_OPTS.publishTransform(out);
}

// `_now` is the run's WALL clock, not just a budget counter: the ordering clamps
// forward clock skew against it, so a fictional `() => 0` would clamp every real
// timestamp to the epoch and flatten the order. Give each simulated run a real
// calendar position, one 4h cron tick apart.
const FIRST_RUN_AT = Date.parse('2026-08-01T00:00:00.000Z');
const CRON_TICK_MS = 4 * 60 * 60_000;
const runClock = (runIndex) => FIRST_RUN_AT + (runIndex * CRON_TICK_MS);

// One healthy 4h run: every article request succeeds, so the full attempt order
// is observable.
async function runHealthy(previous, overrides = {}) {
  const attempted = [];
  let snapshotReads = 0;
  const out = await fetchAllTopics({
    _now: () => FIRST_RUN_AT,
    _softBudgetMs: 60_000,
    _sleep: async () => {},
    _loadPrevious: async () => { snapshotReads += 1; return previous; },
    _fetchArticles: async (topic) => {
      attempted.push(topic.id);
      return {
        id: topic.id,
        articles: [{ title: `fresh ${topic.id}`, url: `https://example.test/live/${topic.id}` }],
        fetchedAt: 'NOW',
      };
    },
    _fetchTimeline: async () => ({ points: [{ date: '2026-07-29', value: 1 }], errorCode: null }),
    ...overrides,
  });
  return { attempted, snapshotReads, out, published: asPublishedSnapshot(out) };
}

// One 4h run under the brownout. `outcome(topicId, callIndex)` decides what GDELT
// does for each request, so a caller can model "first request succeeds", "every
// request fails", or "one topic is permanently blocked".
async function runBrownout(previous, runIndex, outcome) {
  const nowMs = runClock(runIndex);
  const runIso = new Date(nowMs).toISOString();
  const attempted = [];
  let snapshotReads = 0;
  const out = await fetchAllTopics({
    _now: () => nowMs,
    _softBudgetMs: 60_000,
    _sleep: async () => {},
    _loadPrevious: async () => { snapshotReads += 1; return previous; },
    _fetchArticles: async (topic) => {
      const callIndex = attempted.length;
      attempted.push(topic.id);
      const verdict = outcome(topic.id, callIndex);
      if (verdict === 'ok') {
        return {
          id: topic.id,
          articles: [{ title: `fresh ${topic.id}`, url: `https://example.test/live/${topic.id}` }],
          fetchedAt: runIso,
        };
      }
      if (verdict === 'empty') {
        // HTTP 200 with no matching articles. Deliberately NOT a failureCode —
        // this does not open the run circuit.
        return { id: topic.id, articles: [], fetchedAt: runIso };
      }
      return {
        id: topic.id,
        articles: [],
        fetchedAt: runIso,
        failureCode: 'GDELT_SHARED_PROXY_HTTP_429',
      };
    },
    _fetchTimeline: async () => ({ points: [], errorCode: null }),
  });
  return {
    attempted,
    snapshotReads,
    runIso,
    refreshed: attempted[0],
    published: asPublishedSnapshot(out),
    out,
  };
}

// Exactly the first attempted request succeeds; everything after it 429s.
const firstSucceeds = () => (_id, callIndex) => (callIndex === 0 ? 'ok' : '429');

async function chainRuns(count, outcomeFor, initial = null) {
  let previous = initial;
  const runs = [];
  for (let run = 0; run < count; run++) {
    const result = await runBrownout(previous, run, outcomeFor(run));
    runs.push(result);
    previous = result.published;
  }
  return runs;
}

describe('seed-gdelt-intel fetch rotation (issue #5848)', () => {
  it('spreads the scarce DOC success across all six topics instead of always refreshing military', async () => {
    const runs = await chainRuns(TOPIC_IDS.length, firstSucceeds, snapshotOf(PRODUCTION_STALENESS));
    const refreshedPerRun = runs.map((r) => r.refreshed);

    // With the pre-fix fixed order this is six copies of 'military': it is
    // always attempted first, so it monopolizes every lottery win.
    assert.equal(
      new Set(refreshedPerRun).size,
      TOPIC_IDS.length,
      `six single-success runs must refresh six DISTINCT topics; got ${JSON.stringify(refreshedPerRun)}`,
    );
    assert.equal(
      refreshedPerRun[0],
      'nuclear',
      'the first run after deploy has no attemptedAt stamps, so the stalest content wins',
    );
  });

  it('one permanently-blocked topic cannot capture the rotation', async () => {
    // The regression that ordering on content staleness alone would introduce:
    // maritime's query is blocked upstream and 429s forever. Because a failed
    // fetch never advances fetchedAt, staleness-only ordering pinned maritime
    // first on EVERY run, tripped the circuit before anything else was tried, and
    // took freshTopicCount from 5/6 per run to 0 indefinitely.
    const runs = await chainRuns(
      6,
      () => (id, callIndex) => (id === 'maritime' ? '429' : (callIndex === 0 ? 'ok' : '429')),
      snapshotOf({ ...PRODUCTION_STALENESS, maritime: '2026-06-01T00:00:00.000Z' }),
    );

    const maritimeFirst = runs.filter((r) => r.attempted[0] === 'maritime').length;
    assert.ok(
      maritimeFirst <= 1,
      `a broken topic may take the front of the queue once, not repeatedly; it was first in ${maritimeFirst}/6 runs`,
    );
    const starvedRuns = runs.filter((r) => r.out._freshTopicCount === 0).length;
    assert.ok(
      starvedRuns <= 1,
      `a single broken topic must not blank out every run; ${starvedRuns}/6 runs refreshed nothing`,
    );
    assert.ok(
      new Set(runs.map((r) => r.refreshed)).size >= 4,
      'the other topics must keep rotating through the front of the queue',
    );
  });

  it('a topic that returns HTTP 200 with zero articles cannot capture the rotation either', async () => {
    // Same absorbing-state trap by a different route: an empty-but-successful
    // response does not open the circuit, but the cache-merge reverts the topic's
    // fetchedAt to the cached value, so staleness-only ordering re-elected it
    // forever and every run ended with freshTopicCount 0.
    const runs = await chainRuns(
      5,
      () => (id, callIndex) => (id === 'military' ? 'empty' : (callIndex === 0 ? 'ok' : '429')),
      snapshotOf(Object.fromEntries(TOPIC_IDS.map((id) => [id, '2026-07-01T00:00:00.000Z']))),
    );

    // Two topics are attempted per run (the winner, then the 429 that trips the
    // circuit), so over five runs each topic legitimately reaches the front once
    // or twice. What must NOT happen is one topic holding it every run.
    const frontRunners = new Set(runs.map((r) => r.attempted[0]));
    assert.ok(
      frontRunners.size >= 3,
      `the front of the queue must keep moving; only ${[...frontRunners].join(', ')} ever led`,
    );
    assert.ok(
      runs.filter((r) => r.out._freshTopicCount > 0).length >= 3,
      'other topics must still get their turn at the scarce success',
    );
  });

  it('keeps rotating across runs where EVERY request fails — the modal brownout run', async () => {
    // The file's own premise is that most runs fail on the very first request. In
    // that regime nothing refreshes, so content staleness never changes and a
    // staleness-only order is frozen: the same topic absorbs the first slot on
    // every run and the rest are never even attempted.
    const runs = await chainRuns(4, () => () => '429', snapshotOf(PRODUCTION_STALENESS));

    const firstAttempted = runs.map((r) => r.attempted[0]);
    assert.equal(
      new Set(firstAttempted).size,
      4,
      `each all-failing run must try a different topic first; got ${JSON.stringify(firstAttempted)}`,
    );
    for (const run of runs) {
      assert.equal(run.out._gdeltFailureCode, 'GDELT_SHARED_PROXY_HTTP_429');
      assert.equal(run.out._freshTopicCount, 0);
    }
  });

  it('a starved topic keeps its old fetchedAt through the merge, so content age stays honest', async () => {
    const [run] = await chainRuns(1, firstSucceeds, snapshotOf(PRODUCTION_STALENESS));

    assert.deepEqual(
      run.attempted,
      ['nuclear', 'sanctions'],
      'the neediest topic is attempted first; the next 429 opens the run circuit',
    );
    const byId = new Map(run.published.topics.map((t) => [t.id, t]));
    assert.equal(byId.get('nuclear').fetchedAt, run.runIso, 'the winner is stamped fresh');
    for (const id of ['military', 'cyber', 'sanctions', 'intelligence', 'maritime']) {
      assert.equal(
        byId.get(id).fetchedAt,
        PRODUCTION_STALENESS[id],
        `${id} must coast on its previous fetchedAt so the content-age alarm stays honest`,
      );
    }
    // The attempt is recorded even for the topic whose request failed.
    assert.ok(byId.get('sanctions').attemptedAt, 'a failed attempt is still an attempt');
    assert.equal(byId.get('maritime').attemptedAt, undefined, 'an untouched topic gains no stamp');
  });

  it('attempts the neediest topic first, breaking equal-staleness ties on canonical order', async () => {
    const { attempted } = await runHealthy(snapshotOf(PRODUCTION_STALENESS));

    assert.deepEqual(attempted, ['nuclear', 'sanctions', 'intelligence', 'maritime', 'cyber', 'military']);
  });

  it('a topic missing from the previous snapshot sorts first', async () => {
    const { maritime: _dropped, ...withoutMaritime } = PRODUCTION_STALENESS;
    const { attempted } = await runHealthy(snapshotOf(withoutMaritime));

    assert.equal(attempted[0], 'maritime', 'a never-seeded topic is maximally overdue');
  });

  it('a topic with an unparseable fetchedAt sorts first', async () => {
    const { attempted } = await runHealthy(snapshotOf({
      ...PRODUCTION_STALENESS,
      cyber: 'not-a-timestamp',
    }));

    assert.equal(attempted[0], 'cyber', 'an unreadable stamp must be treated as oldest, not newest');
  });

  it('falls back to canonical order when there is no previous snapshot at all', async () => {
    const { attempted } = await runHealthy(null);

    assert.deepEqual(attempted, TOPIC_IDS, 'a cold start has no ordering signal to sort on');
  });

  it('publishes in canonical INTEL_TOPICS order regardless of fetch order', async () => {
    const { attempted, out } = await runHealthy(snapshotOf(PRODUCTION_STALENESS));

    assert.notDeepEqual(attempted, TOPIC_IDS, 'this run must genuinely fetch out of canonical order');
    assert.deepEqual(
      out.topics.map((t) => t.id),
      TOPIC_IDS,
      'consumers depend on canonical publish order, not fetch order',
    );
  });

  it('reads the previous snapshot exactly once per run on both the healthy and degraded paths', async () => {
    const healthy = await runHealthy(snapshotOf(PRODUCTION_STALENESS));
    assert.equal(healthy.snapshotReads, 1, 'ordering must not add a second Redis GET on a clean sweep');

    const [degraded] = await chainRuns(1, firstSucceeds, snapshotOf(PRODUCTION_STALENESS));
    assert.equal(degraded.snapshotReads, 1, 'the ordering read must be reused by the cache-merge backfill');
  });

  it('re-reads the snapshot at merge time when the ordering read came back empty', async () => {
    // `verifySeedKey` degrades a dead Upstash to null, so a blip at run start must
    // not be memoized as "there is no previous snapshot" — that would silently
    // disable the cache-merge that carries freshness through a brownout (#5437).
    let reads = 0;
    const out = await fetchAllTopics({
      _now: () => 0,
      _softBudgetMs: 60_000,
      _sleep: async () => {},
      _loadPrevious: async () => {
        reads += 1;
        return reads === 1 ? null : snapshotOf(PRODUCTION_STALENESS);
      },
      _fetchArticles: async (topic) => ({
        id: topic.id,
        articles: [],
        fetchedAt: 'NOW',
        failureCode: 'GDELT_SHARED_PROXY_HTTP_429',
      }),
      _fetchTimeline: async () => ({ points: [], errorCode: null }),
    });

    assert.equal(reads, 2, 'a null ordering read must leave the cache-merge its own attempt');
    assert.equal(
      out.topics.find((t) => t.id === 'cyber').articles[0].title,
      'cached cyber',
      'the merge must still backfill from the snapshot the retry recovered',
    );
  });

  it('does not spend the article budget waiting on a hung ordering read', async () => {
    // The read sits on the critical path before the first DOC request; the shared
    // Redis helper's retry ladder can otherwise burn a large slice of the soft
    // budget, paid for in whole topics.
    const attempted = [];
    const out = await fetchAllTopics({
      _softBudgetMs: 60_000,
      _minRequestBudgetMs: 50,
      _sleep: async () => {},
      _loadPrevious: () => new Promise(() => {}), // never settles
      _fetchArticles: async (topic) => {
        attempted.push(topic.id);
        return {
          id: topic.id,
          articles: [{ title: `fresh ${topic.id}`, url: `https://example.test/live/${topic.id}` }],
          fetchedAt: 'NOW',
        };
      },
      _fetchTimeline: async () => ({ points: [], errorCode: null }),
    });

    assert.deepEqual(attempted, TOPIC_IDS, 'a hung ordering read falls back to canonical order and still fetches');
    assert.equal(out._freshTopicCount, 6);
  });

  it('a failing ordering read never stops the run from fetching', async () => {
    // Ordering is an optimisation, so it must not become a new way for the run to
    // die before a single DOC request goes out. The cache-merge keeps its own
    // unguarded read, so a genuinely broken Redis still surfaces there.
    const attempted = [];
    const out = await fetchAllTopics({
      _now: () => FIRST_RUN_AT,
      _softBudgetMs: 60_000,
      _sleep: async () => {},
      _loadPrevious: async () => { throw new Error('upstash unreachable'); },
      _fetchArticles: async (topic) => {
        attempted.push(topic.id);
        return {
          id: topic.id,
          articles: [{ title: `fresh ${topic.id}`, url: `https://example.test/live/${topic.id}` }],
          fetchedAt: 'NOW',
        };
      },
      _fetchTimeline: async () => ({ points: [], errorCode: null }),
    });

    assert.deepEqual(attempted, TOPIC_IDS, 'a failed ordering read falls back to canonical order');
    assert.equal(out._freshTopicCount, 6, 'every topic still gets fetched');
  });

  it('still opens the run circuit on the first article failure, just on the neediest topic', async () => {
    const [run] = await chainRuns(1, firstSucceeds, snapshotOf(PRODUCTION_STALENESS));

    assert.equal(run.out._gdeltFailureCode, 'GDELT_SHARED_PROXY_HTTP_429');
    assert.equal(run.out._freshTopicCount, 1);
    assert.equal(run.attempted.length, 2, 'no DOC request may be launched after the circuit opens');
  });

  it('keeps the timeline pair on the 4h UTC slot rotation, not on the article fetch order', async () => {
    const timelineCalls = [];
    const slotMs = 4 * 60 * 60_000;
    await runHealthy(snapshotOf(PRODUCTION_STALENESS), {
      // Slot 4 → canonical INTEL_TOPICS[4] === 'intelligence', while the topic
      // fetched first this run is 'nuclear'.
      _now: () => 4 * slotMs,
      _fetchTimeline: async (topic, mode) => {
        timelineCalls.push(`${topic.id}/${mode}`);
        return { points: [{ date: '2026-07-29', value: 1 }], errorCode: null };
      },
    });

    assert.deepEqual(timelineCalls, ['intelligence/TimelineTone', 'intelligence/TimelineVol']);
  });
});

// The ordering key is the whole mechanism, so pin its input-domain edges directly
// rather than only through a full run.
describe('rankTopicsForFetch input domain', () => {
  const ids = (ranked) => ranked.map((e) => e.topic.id);
  const TOPICS = TOPIC_IDS.map((id) => ({ id }));
  const NOW = Date.parse('2026-07-30T00:00:00.000Z');
  const withArticles = (id, extra) => ({
    id,
    articles: [{ title: `cached ${id}`, url: `https://example.test/${id}` }],
    ...extra,
  });

  it('does not mutate the canonical topic list', () => {
    const canonical = [...TOPIC_IDS];
    rankTopicsForFetch(TOPICS, { topics: [withArticles('military', { fetchedAt: '2026-07-29T00:00:00.000Z' })] }, NOW);

    assert.deepEqual(
      TOPICS.map((t) => t.id),
      canonical,
      'the module-level INTEL_TOPICS order must survive sorting',
    );
  });

  it('orders by attemptedAt before content staleness', () => {
    const previous = {
      topics: [
        // Freshest content but longest since an attempt -> must come first.
        withArticles('maritime', { fetchedAt: '2026-07-29T00:00:00.000Z', attemptedAt: '2026-07-01T00:00:00.000Z' }),
        withArticles('military', { fetchedAt: '2026-06-01T00:00:00.000Z', attemptedAt: '2026-07-29T00:00:00.000Z' }),
      ],
    };

    const order = ids(rankTopicsForFetch(TOPICS, previous, NOW));
    assert.ok(order.indexOf('maritime') < order.indexOf('military'), `liveness outranks staleness; got ${order}`);
  });

  it('clamps a future stamp to the run clock so it cannot look fresher than reality', () => {
    // Container clock skew. Untrusted, a stamp far ahead of the run clock would
    // rank its topic as the most recently fetched forever. Clamping collapses it
    // onto "as of now", so it is bounded to one lap of the rotation rather than a
    // permanent exile. `attemptedAt` (the primary key) is what actually guarantees
    // the topic still gets its turn — see the chained test below.
    const order = (militaryFetchedAt) => ids(rankTopicsForFetch(TOPICS, {
      topics: TOPIC_IDS.map((id) => withArticles(id, {
        fetchedAt: id === 'military' ? militaryFetchedAt : '2026-07-29T00:00:00.000Z',
      })),
    }, NOW));

    assert.deepEqual(
      order('2099-01-01T00:00:00.000Z'),
      order(new Date(NOW).toISOString()),
      'a stamp in the year 2099 must rank identically to one stamped exactly now',
    );
  });

  it('a future stamp cannot exile a topic from the rotation', async () => {
    // The property that matters: even with a poisoned fetchedAt, the attemptedAt
    // key still brings the topic to the front within one lap.
    const poisoned = {
      topics: TOPIC_IDS.map((id) => ({
        id,
        articles: [{ title: `cached ${id}`, url: `https://example.test/${id}` }],
        fetchedAt: id === 'military' ? '2099-01-01T00:00:00.000Z' : '2026-07-29T00:00:00.000Z',
      })),
    };
    const runs = await chainRuns(TOPIC_IDS.length, firstSucceeds, poisoned);

    assert.ok(
      runs.some((r) => r.attempted.includes('military')),
      `a clock-skewed topic must still be attempted within one lap; got ${JSON.stringify(runs.map((r) => r.attempted))}`,
    );
  });

  it('degrades to canonical order for a malformed previous snapshot instead of throwing', () => {
    for (const previous of [null, undefined, {}, { topics: null }, { topics: {} }, { topics: 7 }, []]) {
      assert.deepEqual(
        ids(rankTopicsForFetch(TOPICS, previous, NOW)),
        TOPIC_IDS,
        `malformed snapshot ${JSON.stringify(previous)} must not throw or reorder`,
      );
    }
  });

  it('treats a non-array articles value as no evidence of a successful fetch', () => {
    // The non-array entry carries the NEWER stamp on purpose: if the guard were
    // missing, `'not-an-array'.length > 0` would count it as fetched and its newer
    // stamp would sort it LAST, so this can only pass when the value is rejected.
    const previous = {
      topics: [
        { id: 'military', articles: 'not-an-array', fetchedAt: '2026-07-29T00:00:00.000Z' },
        withArticles('cyber', { fetchedAt: '2026-06-01T00:00:00.000Z' }),
      ],
    };

    const order = ids(rankTopicsForFetch(TOPICS, previous, NOW));
    assert.ok(order.indexOf('military') < order.indexOf('cyber'), `got ${order}`);
  });
});


describe('seed-gdelt-intel fetch rotation — #5859 review round', () => {
  it('rotation survives production timing: same-run stamps tie so pairs cannot absorb the rotation', async () => {
    // ~22s transport + 5.5s pacing ADVANCE the clock within a run — the
    // dimension every frozen-clock run above hides. With per-attempt stamps the
    // modal first-succeeds regime locks into absorbing PAIRS (3 of 6 topics
    // refresh forever, the other 3 are perpetually the circuit-opening second
    // slot); stamping from runStartedAt makes same-run attempts tie, so the
    // staleness tie-break rotates last lap's loser back to the front.
    let fakeTime = 0;
    let previous = snapshotOf(PRODUCTION_STALENESS);
    const refreshed = [];
    for (let run = 0; run < 12; run++) {
      fakeTime = runClock(run);
      const attempted = [];
      const out = await fetchAllTopics({
        _now: () => fakeTime,
        _softBudgetMs: 300_000,
        _sleep: async (ms) => { fakeTime += ms; },
        _loadPrevious: async () => previous,
        _fetchArticles: async (topic) => {
          const callIndex = attempted.length;
          attempted.push(topic.id);
          fakeTime += 22_000;
          if (callIndex === 0) {
            return {
              id: topic.id,
              articles: [{ title: `fresh ${topic.id}`, url: `https://example.test/live/${topic.id}` }],
              fetchedAt: new Date(fakeTime).toISOString(),
            };
          }
          return { id: topic.id, articles: [], fetchedAt: new Date(fakeTime).toISOString(), failureCode: 'GDELT_SHARED_PROXY_HTTP_429' };
        },
        _fetchTimeline: async () => ({ points: [], errorCode: null }),
      });
      refreshed.push(attempted[0]);
      previous = asPublishedSnapshot(out);
    }
    assert.equal(
      new Set(refreshed).size,
      TOPIC_IDS.length,
      `12 advancing-clock single-success runs must reach all six topics; got ${JSON.stringify(refreshed)}`,
    );
  });

  it('the cache-merge waits out an in-flight ordering read instead of racing a duplicate Redis ladder', async () => {
    // withBudget abandons (never cancels) the ordering read on timeout. The
    // merge must JOIN that still-pending read, not start a concurrent second
    // retry ladder against an Upstash that is already degraded (#5859 review).
    let calls = 0;
    const gate = new Promise((resolve) => { setTimeout(resolve, 60); });
    const out = await fetchAllTopics({
      _softBudgetMs: 60_000,
      _minRequestBudgetMs: 1, // ordering read times out instantly; its operation stays in flight
      _sleep: async () => {},
      _loadPrevious: async () => {
        calls += 1;
        await gate;
        return snapshotOf(PRODUCTION_STALENESS);
      },
      _fetchArticles: async (topic) => ({ id: topic.id, articles: [], fetchedAt: 'NOW', failureCode: 'GDELT_SHARED_PROXY_HTTP_429' }),
      _fetchTimeline: async () => ({ points: [], errorCode: null }),
    });
    assert.equal(calls, 1, 'the merge must join the abandoned ordering read, not start a concurrent duplicate');
    assert.equal(
      out.topics.find((t) => t.id === 'cyber').articles[0].title,
      'cached cyber',
      'the shared read late result must still feed the backfill',
    );
  });

  it('emits the gdelt_intel_fetch_order event with per-topic ranking stamps', async () => {
    // The PR designates this event as the primary post-deploy signal (the
    // content-age alarm is blind per #5858), so its shape is a contract.
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); };
    try {
      await runHealthy(snapshotOf(PRODUCTION_STALENESS));
    } finally {
      console.log = originalLog;
    }
    const line = logs.find((l) => l.includes('gdelt_intel_fetch_order'));
    assert.ok(line, `the fetch-order event must be emitted; got: ${JSON.stringify(logs.slice(0, 5))}`);
    const parsed = JSON.parse(line);
    assert.deepEqual([...parsed.order].sort(), [...TOPIC_IDS].sort(), 'order must cover all six topics');
    assert.equal(parsed.order[0], 'nuclear', 'order[0] must reflect the ranking (stalest first on a stamp-free snapshot)');
    for (const entry of parsed.ranking) {
      assert.equal(entry.lastAttemptedAt, null, 'a pre-#5848 snapshot has no attempt stamps — null means never-attempted');
      assert.match(String(entry.lastFetchedAt), /^\d{4}-\d{2}-\d{2}T/, 'article-bearing entries carry an ISO lastFetchedAt');
    }
  });

  it('clamps future stamps to the run clock so skewed entries rank canonically, not by skew size', () => {
    // Discriminating clamp coverage (#5859 review): unclamped, cyber (2098)
    // would outrank military (2099); clamped, both collapse to the run clock,
    // tie, and fall back to canonical order — military before cyber.
    const bareTopics = TOPIC_IDS.map((id) => ({ id }));
    const ranked = rankTopicsForFetch(bareTopics, {
      topics: [
        { id: 'military', articles: [{ title: 'm' }], fetchedAt: '2099-01-01T00:00:00.000Z' },
        { id: 'cyber', articles: [{ title: 'c' }], fetchedAt: '2098-01-01T00:00:00.000Z' },
        { id: 'nuclear', articles: [{ title: 'n' }], fetchedAt: '2026-07-01T00:00:00.000Z' },
      ],
    }, FIRST_RUN_AT).map((entry) => entry.topic.id);

    const militaryPos = ranked.indexOf('military');
    const cyberPos = ranked.indexOf('cyber');
    assert.ok(ranked.indexOf('nuclear') < militaryPos, 'a genuinely past stamp must outrank clamped future stamps');
    assert.equal(cyberPos, militaryPos + 1, 'clamped future stamps must tie and fall back to canonical order (military before cyber)');
  });
});
