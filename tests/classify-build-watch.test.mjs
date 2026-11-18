// The relay classifies an edition as soon as its digest is rebuilt, instead of
// waiting for the next 15-minute cycle. These are the pure decisions behind
// that: which Redis key says "a new build exists", which editions have a build
// the relay has not classified, what a build pass covers, and how the latency
// of each queued alert is measured.
//
// Measured over 2026-11-10..17 (1,261 queued rss_alert events): the relay
// queued an alert a median 13.6 minutes (p90 28.2) after digest story tracking
// first saw the headline. That wait was the 15-minute cycle.
//
// Run: node --test tests/classify-build-watch.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const {
  DIGEST_BUILD_SETTLE_MS,
  BUILD_TO_QUEUE_BUDGET_MS,
  digestBuildStampKey,
  digestBuildStampMs,
  editionsWithUnclassifiedBuild,
  buildPassEditions,
  alertLatency,
  formatAlertLatency,
  summarizeAlertLatency,
  alertCountsBySource,
  strictLatencyVerdict,
  DIGEST_BUILD_RETRY_MS,
} = require('../scripts/lib/classify-digest-request.cjs');

const EDITIONS = ['full', 'tech', 'finance', 'commodity', 'happy', 'energy'];
const digestSrc = readFileSync(
  resolve(__dirname, '..', 'server', 'worldmonitor', 'news', 'v1', 'list-feed-digest.ts'),
  'utf8',
);

describe('digest build stamp', () => {
  it('reads the key the digest handler writes at the end of every build', () => {
    assert.equal(digestBuildStampKey('full'), 'news:coverage-ledger:v1:full:en');
    assert.equal(digestBuildStampKey('energy'), 'news:coverage-ledger:v1:energy:en');
    // The relay is CJS and cannot import the handler, so the key is pinned to
    // the handler's own literal. Renaming one side without the other would
    // silently return the relay to its 15-minute cycle.
    assert.match(
      digestSrc,
      /writeCoverageLedger\(\s*`news:coverage-ledger:v1:\$\{variant\}:\$\{lang\}`,\s*ledger,/,
      'list-feed-digest.ts must still write news:coverage-ledger:v1:<variant>:<lang>',
    );
    assert.match(
      digestSrc,
      /async function writeCoverageLedger\(key: string, ledger: unknown, deadlineAt: number\)[\s\S]*?setCachedJson\(key, ledger, 7200\)/,
      'writeCoverageLedger must still SET the ledger under the key it is given',
    );
    assert.match(digestSrc, /const ledger = \{\s*v: 1,\s*generatedAt: Date\.now\(\),/);
  });

  it('takes the build time from the ledger and rejects anything else', () => {
    assert.equal(digestBuildStampMs({ v: 1, generatedAt: 1794900000000 }), 1794900000000);
    assert.equal(digestBuildStampMs('{"v":1,"generatedAt":1794900000000}'), 1794900000000);
    for (const bad of [null, undefined, '', 'not json', {}, { generatedAt: 'soon' }, { generatedAt: -5 }, { generatedAt: 0 }]) {
      assert.equal(digestBuildStampMs(bad), 0);
    }
  });
});

describe('editionsWithUnclassifiedBuild', () => {
  const now = 1794900600000;
  const settled = now - DIGEST_BUILD_SETTLE_MS;

  it('returns the editions whose digest was rebuilt after the relay last classified them', () => {
    const stamps = new Map([['full', settled - 1000], ['tech', settled - 2000], ['finance', settled - 3000]]);
    const classifiedAt = new Map([['full', settled - 5000], ['tech', settled - 2000], ['finance', settled]]);
    assert.deepEqual(
      editionsWithUnclassifiedBuild({ editions: EDITIONS, stamps, classifiedAt, now }),
      ['full'],
    );
  });

  it('treats an edition the relay has never classified as new, so a restart catches up at once', () => {
    const stamps = new Map(EDITIONS.map((e) => [e, settled - 1000]));
    assert.deepEqual(
      editionsWithUnclassifiedBuild({ editions: EDITIONS, stamps, classifiedAt: new Map(), now }),
      EDITIONS,
    );
  });

  it('waits for the build to be published before reading it', () => {
    // The ledger is written inside the build; the body reaches the digest
    // cache a moment later. Fetching before that would start a second build.
    const stamps = new Map([['full', now - DIGEST_BUILD_SETTLE_MS + 1]]);
    assert.deepEqual(editionsWithUnclassifiedBuild({ editions: EDITIONS, stamps, classifiedAt: new Map(), now }), []);
    assert.deepEqual(
      editionsWithUnclassifiedBuild({ editions: EDITIONS, stamps, classifiedAt: new Map(), now: now + 1 }),
      ['full'],
    );
  });

  it('leaves an edition alone after a failed read until its retry time', () => {
    // A failed read does not count as classifying the build, so the build stays
    // new. Without a wait every 20-second check would re-read a failing API.
    const stamps = new Map([['full', settled - 1000], ['tech', settled - 1000]]);
    const retryAt = new Map([['full', now + 1]]);
    assert.deepEqual(editionsWithUnclassifiedBuild({ editions: EDITIONS, stamps, classifiedAt: new Map(), now, retryAt }), ['tech']);
    assert.deepEqual(
      editionsWithUnclassifiedBuild({ editions: EDITIONS, stamps, classifiedAt: new Map(), now: now + 1, retryAt }),
      ['full', 'tech'],
    );
    assert.ok(DIGEST_BUILD_RETRY_MS >= 60_000 && DIGEST_BUILD_RETRY_MS <= 5 * 60_000);
  });

  it('ignores editions with no stamp, an unreadable stamp or a stamp from the future', () => {
    const stamps = new Map([['full', 0], ['tech', Number.NaN], ['finance', now + 60_000]]);
    assert.deepEqual(editionsWithUnclassifiedBuild({ editions: EDITIONS, stamps, classifiedAt: new Map(), now }), []);
  });
});

describe('buildPassEditions', () => {
  it('classifies full first, then the rebuilt editions in edition order', () => {
    // An alert is published once, by the edition that classifies the headline
    // first, and a rule only receives its own edition. The 15-minute cycle
    // gives `full` first claim on a headline two editions carry; a build pass
    // has to keep that.
    assert.deepEqual(buildPassEditions(EDITIONS, ['finance']), ['full', 'finance']);
    assert.deepEqual(buildPassEditions(EDITIONS, ['energy', 'tech']), ['full', 'tech', 'energy']);
    assert.deepEqual(buildPassEditions(EDITIONS, ['full']), ['full']);
    assert.deepEqual(buildPassEditions(EDITIONS, ['full', 'happy']), ['full', 'happy']);
  });

  it('holds the whole pass while full is waiting to be retried', () => {
    // Reading another edition without full would hand it full's claim on a
    // shared headline, and reading full anyway would ignore its retry wait.
    // The rebuilt editions stay new and run once full can be read again.
    const now = 1794900600000;
    const retryAt = new Map([['full', now + 1]]);
    assert.deepEqual(buildPassEditions(EDITIONS, ['tech'], { now, retryAt }), []);
    assert.deepEqual(buildPassEditions(EDITIONS, ['tech'], { now: now + 1, retryAt }), ['full', 'tech']);
    // Another edition's retry wait does not hold the pass.
    assert.deepEqual(buildPassEditions(EDITIONS, ['tech'], { now, retryAt: new Map([['finance', now + 1]]) }), ['full', 'tech']);
  });

  it('runs nothing when no edition was rebuilt, and skips unknown editions', () => {
    assert.deepEqual(buildPassEditions(EDITIONS, []), []);
    assert.deepEqual(buildPassEditions(EDITIONS, ['sports']), []);
  });
});

describe('alertLatency', () => {
  const queuedAt = Date.parse('2026-11-16T23:45:55Z');

  it('splits the delay of the measured CNN case into its stages', () => {
    const latency = alertLatency({
      publishedAt: Date.parse('2026-11-16T22:59:28Z'),
      firstSeen: Date.parse('2026-11-16T23:34:25Z'),
      buildAt: Date.parse('2026-11-16T23:38:00Z'),
      queuedAt,
    });
    assert.equal(latency.publishToQueueMs, 2_787_000);
    assert.equal(latency.seenToQueueMs, 690_000);
    assert.equal(latency.buildToQueueMs, 475_000);
    assert.equal(latency.overBudget, true, 'a 7.9-minute build-to-queue wait is over the budget');
  });

  it('is within budget when the alert follows its build', () => {
    const latency = alertLatency({ publishedAt: queuedAt - 300_000, firstSeen: queuedAt - 60_000, buildAt: queuedAt - 40_000, queuedAt });
    assert.equal(latency.buildToQueueMs, 40_000);
    assert.equal(latency.overBudget, false);
    assert.ok(BUILD_TO_QUEUE_BUDGET_MS >= 2 * 60_000 && BUILD_TO_QUEUE_BUDGET_MS <= 5 * 60_000);
  });

  it('leaves out a stage it cannot measure instead of inventing zero', () => {
    // X posts have no digest build or story tracking; a publisher clock ahead
    // of ours would give a negative age.
    const latency = alertLatency({ publishedAt: queuedAt + 5000, firstSeen: undefined, buildAt: 0, queuedAt });
    assert.equal(latency.publishToQueueMs, null);
    assert.equal(latency.seenToQueueMs, null);
    assert.equal(latency.buildToQueueMs, null);
    assert.equal(latency.overBudget, false);
  });

  it('formats one greppable line per alert', () => {
    const line = formatAlertLatency(
      alertLatency({ publishedAt: queuedAt - 2_787_000, firstSeen: queuedAt - 690_000, buildAt: queuedAt - 475_000, queuedAt }),
      { severity: 'critical', importanceScore: 83, variant: 'full', source: 'CNN World' },
    );
    assert.equal(
      line,
      '[Classify] alert latency publish_to_queue_s=2787 seen_to_queue_s=690 build_to_queue_s=475 over_budget=true severity=critical score=83 variant=full source="CNN World"',
    );
    assert.match(
      formatAlertLatency(alertLatency({ publishedAt: queuedAt - 1000, queuedAt }), { severity: 'high', importanceScore: 60, variant: 'full', source: 'x' }),
      /seen_to_queue_s=n\/a build_to_queue_s=n\/a over_budget=false/,
    );
  });
});

describe('summarizeAlertLatency', () => {
  it('reports p50, p90 and max per stage and counts samples over the build-to-queue budget', () => {
    const minute = 60_000;
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map((m) => ({
      publishToQueueMs: (m + 10) * minute,
      seenToQueueMs: (m + 1) * minute,
      buildToQueueMs: m * minute,
    }));
    const summary = summarizeAlertLatency(samples);
    assert.equal(summary.count, 10);
    assert.deepEqual(summary.buildToQueue, { n: 10, p50: 6 * minute, p90: 20 * minute, max: 20 * minute });
    assert.equal(summary.publishToQueue.p50, 16 * minute);
    assert.equal(summary.overBudget, 7, 'samples over the 3-minute budget');
  });

  it('skips a stage a sample could not measure, and survives no samples at all', () => {
    const summary = summarizeAlertLatency([
      { publishToQueueMs: 60_000, seenToQueueMs: null, buildToQueueMs: null },
      { publishToQueueMs: 120_000, seenToQueueMs: 30_000, buildToQueueMs: 20_000 },
    ]);
    assert.deepEqual(summary.publishToSeen, { n: 1, p50: 90_000, p90: 90_000, max: 90_000 });
    assert.equal(summary.publishToQueue.n, 2);
    assert.equal(summary.buildToQueue.n, 1);
    assert.equal(summary.overBudget, 0);
    assert.deepEqual(summarizeAlertLatency([]).buildToQueue, { n: 0, p50: null, p90: null, max: null });
  });
});

describe('headline first sight before this publication', () => {
  // story:track firstSeen is the headline's first sight in any edition, so an
  // identical headline from another outlet can predate this item's timestamp.
  it('counts those samples instead of dropping them silently', () => {
    const summary = summarizeAlertLatency([
      { publishToQueueMs: 7 * 60_000, seenToQueueMs: 12 * 60_000, buildToQueueMs: 30_000 },
      { publishToQueueMs: 10 * 60_000, seenToQueueMs: 4 * 60_000, buildToQueueMs: 30_000 },
    ]);
    assert.equal(summary.publishToSeen.n, 1);
    assert.equal(summary.seenBeforePublish, 1);
  });
});

describe('alertCountsBySource', () => {
  it('counts every logged alert, with or without a publisher timestamp', () => {
    const counts = alertCountsBySource([
      { eventType: 'rss_alert', source: 'CNN World', publishedAt: 1_000 },
      { eventType: 'rss_alert', source: 'CNN World', publishedAt: null },
      { eventType: 'rss_alert', source: 'CNN World', publishedAt: 0 },
      { eventType: 'rss_alert', source: 'Reuters World' },
      { eventType: 'x_alert', source: 'CNN World', publishedAt: 1_000 },
    ]);
    assert.deepEqual([...counts], [['CNN World', 3], ['Reuters World', 1]]);
  });
});

describe('strictLatencyVerdict', () => {
  const minute = 60_000;
  const sample = (buildToQueueMs) => ({ publishToQueueMs: 10 * minute, seenToQueueMs: 2 * minute, buildToQueueMs });

  it('passes when build-to-queue p90 is within budget', () => {
    assert.deepEqual(strictLatencyVerdict(summarizeAlertLatency([sample(20_000), sample(40_000)])), { ok: true, reason: '' });
  });

  it('fails when build-to-queue p90 is over budget', () => {
    const verdict = strictLatencyVerdict(summarizeAlertLatency([sample(20_000), sample(14 * minute)]));
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /build-to-queue p90 14\.0 min is over the 3\.0-minute budget/);
  });

  it('fails when nothing measured the build stage, instead of passing on no evidence', () => {
    // A window with only X alerts has samples but no build-to-queue value.
    for (const samples of [[], [sample(null), sample(null)]]) {
      const verdict = strictLatencyVerdict(summarizeAlertLatency(samples));
      assert.equal(verdict.ok, false);
      assert.match(verdict.reason, /no alert in this window measured digest build to queue/);
    }
  });
});
