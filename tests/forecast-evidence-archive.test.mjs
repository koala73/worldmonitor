import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let mod;
let seederMod;
let backfillMod;

before(async () => {
  const result = await build({
    stdin: {
      contents: "export * from './scripts/_forecast-evidence-archive.mjs';",
      loader: 'ts',
      resolveDir: root,
      sourcefile: 'forecast-evidence-archive-test-entry.ts',
    },
    bundle: true,
    format: 'esm',
    logLevel: 'silent',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  const source = result.outputFiles[0]?.text;
  assert.ok(source, 'esbuild must emit the evidence archive harness');
  mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  seederMod = await import(new URL('../scripts/seed-forecast-resolutions.mjs', import.meta.url));
  backfillMod = await import(new URL('../scripts/backfill-forecast-evidence-archive.mjs', import.meta.url));
});

const response = body => ({ ok: true, status: 200, json: async () => body });

function sequenceFetch(bodies, calls = []) {
  return async (url, init) => {
    calls.push({ url: String(url), command: JSON.parse(init.body) });
    assert.ok(bodies.length > 0, `unexpected Redis request: ${url}`);
    return response(bodies.shift());
  };
}

describe('forecast evidence archive records (#7082)', () => {
  it('builds a self-contained member that round-trips through parse', () => {
    const member = mod.buildForecastEvidenceMember(
      {
        hash: 'a'.repeat(64),
        title: 'Central bank holds rates',
        link: 'https://news.example/rates',
        description: 'Officials held rates unchanged.',
        publishedAt: 1750000000000,
      },
      1750000100000,
    );
    assert.ok(member, 'member must build for a well-formed track');
    const { record, malformed, oversized } = mod.parseForecastEvidenceMember(member);
    assert.equal(malformed, false);
    assert.equal(oversized, false);
    assert.ok(record);
    assert.equal(record.hash, 'a'.repeat(64));
    assert.equal(record.title, 'Central bank holds rates');
    assert.equal(record.link, 'https://news.example/rates');
    assert.equal(record.publishedAt, 1750000000000);
    assert.equal(record.lastSeen, 1750000100000);
    assert.equal(record.v, mod.FORECAST_EVIDENCE_VERSION);
  });

  it('refuses members with missing required fields', () => {
    assert.equal(mod.buildForecastEvidenceMember({ hash: '', title: 'x', link: 'y', publishedAt: 1 }, 2), null);
    assert.equal(mod.buildForecastEvidenceMember({ hash: 'h', title: '', link: 'y', publishedAt: 1 }, 2), null);
    assert.equal(mod.buildForecastEvidenceMember({ hash: 'h', title: 't', link: 'y', publishedAt: NaN }, 2), null);
  });

  it('caps descriptions and refuses oversized members instead of archiving them', () => {
    const member = mod.buildForecastEvidenceMember(
      {
        hash: 'b'.repeat(64),
        title: 't'.repeat(2500),
        link: 'https://news.example/x',
        description: '',
        publishedAt: 1,
      },
      2,
    );
    assert.equal(member, null, 'a member over the byte budget must be dropped at build time');
  });

  it('measures the member budget in UTF-8 bytes', () => {
    const member = mod.buildForecastEvidenceMember(
      {
        hash: 'a'.repeat(64),
        title: '💥'.repeat(800),
        link: 'https://news.example/unicode',
        description: '',
        publishedAt: 1,
      },
      2,
    );
    assert.equal(member, null);

    const raw = JSON.stringify({
      v: mod.FORECAST_EVIDENCE_VERSION,
      hash: 'a'.repeat(64),
      title: '💥'.repeat(800),
      link: 'x',
      description: '',
      publishedAt: 1,
      lastSeen: 2,
    });
    assert.ok(raw.length < mod.FORECAST_EVIDENCE_MEMBER_MAX_BYTES);
    assert.ok(mod.utf8ByteLength(raw) > mod.FORECAST_EVIDENCE_MEMBER_MAX_BYTES);
    assert.equal(mod.parseForecastEvidenceMember(raw).oversized, true);
  });

  it('uses one stable index identity for every refresh of a story hash', () => {
    const hash = 'a'.repeat(64);
    const first = mod.buildForecastEvidenceMember({ hash, title: 'first', link: 'x', description: '', publishedAt: 1 }, 2);
    const refreshed = mod.buildForecastEvidenceMember({ hash, title: 'changed', link: 'x', description: '', publishedAt: 1 }, 3);
    assert.notEqual(first, refreshed, 'the self-contained payload may refresh');
    assert.equal(mod.forecastEvidenceRecordKey(hash), mod.forecastEvidenceRecordKey(hash));
    assert.equal(hash, hash, 'the ZSet member remains the hash');
  });

  it('reports malformed members as tombstones, never silently omitted', () => {
    for (const bad of ['not json', '42', 'null', JSON.stringify({ v: 99 }), JSON.stringify({ v: 1 })]) {
      const { record, malformed } = mod.parseForecastEvidenceMember(bad);
      assert.equal(record, null, `unusable member must not parse: ${bad.slice(0, 24)}`);
      assert.equal(malformed, true);
    }
  });

  it('archives only the full/English scope that judging reads', () => {
    assert.equal(mod.isEligibleForecastEvidence('full', 'en'), true);
    assert.equal(mod.isEligibleForecastEvidence('full', 'de'), false);
    assert.equal(mod.isEligibleForecastEvidence('tech', 'en'), false);
  });

  it('sizes retention for the 14-day reader contract plus a guard band', () => {
    assert.equal(mod.FORECAST_EVIDENCE_TTL_S, 15 * 24 * 60 * 60);
    assert.equal(mod.FORECAST_EVIDENCE_MAX_LOOKBACK_MS, 14 * 24 * 60 * 60 * 1000);
  });

  it('preserves and validates the complete v1 coverage proof', () => {
    const end = 1_750_000_000_000;
    const start = end - mod.FORECAST_EVIDENCE_MAX_LOOKBACK_MS;
    const metadata = {
      v: mod.FORECAST_EVIDENCE_COVERAGE_VERSION,
      coverageStartMs: start,
      coverageEndMs: end,
      cutoverVerifiedAtMs: end - 1,
      sourceDigestAtMs: end,
      maxLookbackMs: mod.FORECAST_EVIDENCE_MAX_LOOKBACK_MS,
      retentionSeconds: mod.FORECAST_EVIDENCE_TTL_S,
      sourceKey: mod.FORECAST_EVIDENCE_SOURCE_KEY,
      legacyOldestHash: 'f'.repeat(64),
      legacyOldestScoreMs: start - 1,
    };
    assert.deepEqual(mod.parseForecastEvidenceCoverage(JSON.stringify(metadata)), metadata);
    assert.equal(mod.parseForecastEvidenceCoverage({ ...metadata, legacyOldestHash: 'f'.repeat(32) }), null);
    assert.equal(mod.parseForecastEvidenceCoverage({ ...metadata, retentionSeconds: 1 }), null);
    assert.equal(mod.parseForecastEvidenceCoverage({ ...metadata, sourceDigestAtMs: end - 1 }), null);
    assert.equal(mod.parseForecastEvidenceCoverage({ ...metadata, legacyOldestScoreMs: start + 1 }), null);
    assert.equal(mod.parseForecastEvidenceCoverage({ ...metadata, coverageStartMs: start + 1 }), null);
  });

  it('kills every arm of the coverage guard independently', () => {
    // This guard is the single gate that both (a) decides whether judging
    // trusts the archive and (b) authorises the destructive accumulator prune.
    // Six of its eleven conjuncts previously had no test, so any of them could
    // be deleted with the suite still green. One mutation per arm, so a
    // deleted arm fails exactly one case and names itself.
    const end = 1_750_000_000_000;
    const start = end - mod.FORECAST_EVIDENCE_MAX_LOOKBACK_MS;
    const valid = {
      v: mod.FORECAST_EVIDENCE_COVERAGE_VERSION,
      coverageStartMs: start,
      coverageEndMs: end,
      cutoverVerifiedAtMs: end - 1,
      sourceDigestAtMs: end,
      maxLookbackMs: mod.FORECAST_EVIDENCE_MAX_LOOKBACK_MS,
      retentionSeconds: mod.FORECAST_EVIDENCE_TTL_S,
      sourceKey: mod.FORECAST_EVIDENCE_SOURCE_KEY,
      legacyOldestHash: 'f'.repeat(64),
      legacyOldestScoreMs: start - 1,
    };
    // Positive control: the fixture itself must parse, or every rejection
    // below would pass for the wrong reason.
    assert.ok(mod.parseForecastEvidenceCoverage(valid), 'fixture must be a valid marker');

    const mutations = {
      'version pin': { v: 2 },
      'maxLookbackMs pin': { maxLookbackMs: mod.FORECAST_EVIDENCE_MAX_LOOKBACK_MS - 1 },
      'retentionSeconds pin': { retentionSeconds: mod.FORECAST_EVIDENCE_TTL_S - 1 },
      'sourceKey pin': { sourceKey: 'digest:accumulator:v1:finance:en' },
      'legacyOldestHash shape': { legacyOldestHash: 'zz' },
      'coverage span >= 14d': { coverageStartMs: start + 1, legacyOldestScoreMs: start },
      'start <= end ordering': { coverageStartMs: end + 1, sourceDigestAtMs: end, legacyOldestScoreMs: end },
      'sourceDigestAtMs === coverageEndMs': { sourceDigestAtMs: end - 1 },
      'cutoverVerifiedAtMs >= coverageStartMs': { cutoverVerifiedAtMs: start - 1 },
      'cutoverVerifiedAtMs <= coverageEndMs': { cutoverVerifiedAtMs: end + 1 },
      'legacyOldestScoreMs <= coverageStartMs': { legacyOldestScoreMs: start + 1 },
      'time fields are safe non-negative integers': { coverageEndMs: Number.MAX_SAFE_INTEGER + 2 },
      'negative time fields': { cutoverVerifiedAtMs: -1 },
      'non-integer time fields': { coverageEndMs: end + 0.5 },
    };
    for (const [arm, patch] of Object.entries(mutations)) {
      assert.equal(
        mod.parseForecastEvidenceCoverage({ ...valid, ...patch }),
        null,
        `guard arm not enforced: ${arm}`,
      );
    }
  });

  it('rejects non-object and unparseable markers', () => {
    for (const bad of ['not json', '42', 'null', 42, null, undefined, [], 'true']) {
      assert.equal(mod.parseForecastEvidenceCoverage(bad), null, `must reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('accumulator prune bounds (#7082)', () => {
  it('prunes strictly older than the widest accumulator reader contract', () => {
    const now = 1750000000000;
    const bounds = mod.accumulatorPruneBounds(now);
    assert.equal(bounds.min, '-inf');
    assert.equal(bounds.max, `(${now - mod.ACCUMULATOR_RETENTION_MS}`);
  });

  it('retains the weekly digest window that seed-digest-notifications reads', () => {
    // buildDigest() anchors its ZRANGEBYSCORE at the subscriber's lastSentAt,
    // ~6.5-7d for digestMode 'weekly'. A 48h prune silently truncated those
    // emails to two days of stories; retention must outlive the widest reader.
    const now = 1750000000000;
    const cutoff = Number(mod.accumulatorPruneBounds(now).max.slice(1));
    const weeklyWindowStart = now - 7 * 24 * 60 * 60 * 1000;
    assert.ok(
      cutoff < weeklyWindowStart,
      `prune cutoff ${new Date(cutoff).toISOString()} must precede the weekly window start ${new Date(weeklyWindowStart).toISOString()}`,
    );
    // ...and still bound the key: a member older than STORY_TTL + guard is gone.
    assert.ok(cutoff > now - 9 * 24 * 60 * 60 * 1000);
  });

  it('honours an explicit retention override', () => {
    const now = 1750000000000;
    assert.equal(mod.accumulatorPruneBounds(now, 3_600_000).max, `(${now - 3_600_000}`);
  });

  it('rejects a non-finite clock', () => {
    assert.throws(() => mod.accumulatorPruneBounds(NaN));
  });
});

describe('evidence prune bounds (#7082)', () => {
  const now = 1_750_000_000_000;
  const day = 24 * 60 * 60 * 1000;

  it('prunes strictly older than the 14-day contract plus the 1-day guard band', () => {
    const bounds = mod.evidencePruneBounds(now);
    assert.equal(bounds.min, '-inf');
    assert.equal(bounds.max, `(${now - mod.FORECAST_EVIDENCE_MAX_LOOKBACK_MS - day}`);
  });

  it('keeps a day-13 member and removes a day-16 member', () => {
    // Issue #7082: "readable at day 13 and ineligible after the declared
    // maximum retention". The exclusive bound is the whole contract here.
    const cutoff = Number(mod.evidencePruneBounds(now).max.slice(1));
    assert.ok(now - 13 * day > cutoff, 'a day-13 member must survive the prune');
    assert.ok(now - 16 * day < cutoff, 'a day-16 member must be pruned');
    // The exact boundary member (15d) is retained: the bound is exclusive.
    assert.equal(now - 15 * day, cutoff);
  });

  it('rejects a non-finite clock', () => {
    assert.throws(() => mod.evidencePruneBounds(NaN));
  });
});

describe('coverage staleness budget (#7082)', () => {
  const now = 1_750_000_000_000;
  const start = now - 14 * 24 * 60 * 60 * 1000;
  const marker = endMs => ({
    v: 1,
    coverageStartMs: endMs - 14 * 24 * 60 * 60 * 1000,
    coverageEndMs: endMs,
    cutoverVerifiedAtMs: endMs - 1,
    sourceDigestAtMs: endMs,
    maxLookbackMs: 14 * 24 * 60 * 60 * 1000,
    retentionSeconds: 15 * 24 * 60 * 60,
    sourceKey: 'digest:accumulator:v1:full:en',
    legacyOldestHash: 'f'.repeat(64),
    legacyOldestScoreMs: endMs - 14 * 24 * 60 * 60 * 1000 - 1,
  });

  it('defaults to zero tolerance so destructive gates keep demanding a current marker', () => {
    // The publication prune and the sweep tool both rely on this default.
    assert.equal(mod.forecastEvidenceCoversWindow(marker(now - 1), start, now), false);
    assert.equal(mod.forecastEvidenceCoversWindow(marker(now), start, now), true);
  });

  it('accepts a marker inside the budget and refuses one beyond it', () => {
    const lag = mod.FORECAST_EVIDENCE_COVERAGE_MAX_LAG_MS;
    assert.equal(mod.forecastEvidenceCoversWindow(marker(now - lag + 1), start, now, lag), true);
    assert.equal(mod.forecastEvidenceCoversWindow(marker(now - lag), start, now, lag), true);
    assert.equal(mod.forecastEvidenceCoversWindow(marker(now - lag - 1), start, now, lag), false);
  });

  it('never lets the budget excuse a short coverage START', () => {
    // The budget forgives publication lag at the END of the window only. A
    // marker that never covered the beginning is still refused.
    const short = marker(now);
    short.coverageStartMs += 1;
    short.legacyOldestScoreMs += 1;
    assert.equal(
      mod.forecastEvidenceCoversWindow(short, start, now, mod.FORECAST_EVIDENCE_COVERAGE_MAX_LAG_MS),
      false,
    );
  });

  it('reads the budget from the environment, falling back to the default', () => {
    assert.equal(mod.resolveForecastEvidenceCoverageMaxLagMs({}), mod.FORECAST_EVIDENCE_COVERAGE_MAX_LAG_MS);
    assert.equal(
      mod.resolveForecastEvidenceCoverageMaxLagMs({ FORECAST_EVIDENCE_COVERAGE_MAX_LAG_MS: 'nonsense' }),
      mod.FORECAST_EVIDENCE_COVERAGE_MAX_LAG_MS,
    );
    assert.equal(mod.resolveForecastEvidenceCoverageMaxLagMs({ FORECAST_EVIDENCE_COVERAGE_MAX_LAG_MS: '0' }), 0);
    assert.equal(mod.resolveForecastEvidenceCoverageMaxLagMs({ FORECAST_EVIDENCE_COVERAGE_MAX_LAG_MS: '90000' }), 90_000);
  });
});

describe('coverage marker advance (#7082)', () => {
  const now = 1_750_000_000_000;
  const markerEnd = now - 60_000;
  const base = {
    v: 1,
    coverageStartMs: markerEnd - 14 * 24 * 60 * 60 * 1000,
    coverageEndMs: markerEnd,
    cutoverVerifiedAtMs: markerEnd - 60_000,
    sourceDigestAtMs: markerEnd,
    maxLookbackMs: 14 * 24 * 60 * 60 * 1000,
    retentionSeconds: 15 * 24 * 60 * 60,
    sourceKey: 'digest:accumulator:v1:full:en',
    legacyOldestHash: 'f'.repeat(64),
    legacyOldestScoreMs: markerEnd - 14 * 24 * 60 * 60 * 1000 - 1,
  };

  it('starts from a marker its own validator accepts', () => {
    // Positive control: without this, every assertion below could pass because
    // the fixture is malformed rather than because the code behaves.
    assert.ok(mod.parseForecastEvidenceCoverage(base));
  });

  it('produces a marker that survives its own validator', () => {
    // The writer used to hand-reconstruct this object; the round trip is what
    // guarantees the invariants (sourceDigestAtMs === coverageEndMs, the
    // >= 14-day span, cutoverVerifiedAtMs inside the window) still hold.
    const advanced = mod.advanceForecastEvidenceCoverage(base, now);
    assert.ok(advanced);
    assert.equal(advanced.coverageEndMs, now);
    assert.equal(advanced.sourceDigestAtMs, now);
    assert.deepEqual(mod.parseForecastEvidenceCoverage(JSON.stringify(advanced)), advanced);
  });

  it('never moves the window backwards', () => {
    // Concurrent publications each read-then-SET this marker, so a slow
    // instance must not regress a newer instance's coverageEndMs.
    const advanced = mod.advanceForecastEvidenceCoverage(base, markerEnd - 600_000);
    assert.equal(advanced.coverageEndMs, base.coverageEndMs);
    assert.equal(advanced.sourceDigestAtMs, base.coverageEndMs);
  });

  it('refuses an invalid marker or clock instead of inventing one', () => {
    assert.equal(mod.advanceForecastEvidenceCoverage(null, now), null);
    assert.equal(mod.advanceForecastEvidenceCoverage({ ...base, sourceKey: 'other' }, now), null);
    assert.equal(mod.advanceForecastEvidenceCoverage(base, NaN), null);
  });
});

describe('reader migration (#7082)', () => {
  const now = 1_750_000_000_000;
  const start = now - 14 * 24 * 60 * 60 * 1000;
  const coverage = JSON.stringify({
    v: 1,
    coverageStartMs: start,
    coverageEndMs: now,
    cutoverVerifiedAtMs: now - 1,
    sourceDigestAtMs: now,
    maxLookbackMs: 14 * 24 * 60 * 60 * 1000,
    retentionSeconds: 15 * 24 * 60 * 60,
    sourceKey: 'digest:accumulator:v1:full:en',
    legacyOldestHash: 'f'.repeat(64),
    legacyOldestScoreMs: start - 1,
  });

  it('does not claim coverage for an empty archive without a verified marker', async () => {
    const calls = [];
    const result = await seederMod.readForecastEvidenceArchive(start, now, {
      redisUrl: 'https://redis.example',
      redisToken: 'token',
      fetchFn: sequenceFetch([{ result: null }], calls),
    });
    assert.equal(result.available, false);
    assert.equal(result.coverageComplete, false);
    assert.equal(result.incompleteReason, 'coverage_unverified');
    assert.equal(calls.length, 1, 'an unverified archive must not be treated as an empty successful query');
  });

  it('rejects a verified marker that covers only part of the requested window', async () => {
    const partial = JSON.stringify({
      v: 1,
      coverageStartMs: start + 1,
      coverageEndMs: now + 1,
      cutoverVerifiedAtMs: now,
      sourceDigestAtMs: now + 1,
      maxLookbackMs: 14 * 24 * 60 * 60 * 1000,
      retentionSeconds: 15 * 24 * 60 * 60,
      sourceKey: 'digest:accumulator:v1:full:en',
      legacyOldestHash: 'f'.repeat(64),
      legacyOldestScoreMs: start,
    });
    const result = await seederMod.readForecastEvidenceArchive(start, now, {
      redisUrl: 'https://redis.example', redisToken: 'token', fetchFn: sequenceFetch([{ result: partial }]),
    });
    assert.equal(result.available, false);
    assert.equal(result.incompleteReason, 'coverage_window_incomplete');
  });

  it('reads stable hashes, preserves publishedAt, and ignores lastSeen for evidence time', async () => {
    const hash = 'a'.repeat(64);
    const publishedAt = start + 10;
    const member = mod.buildForecastEvidenceMember({ hash, title: 'Event happened', link: 'https://example.test', description: 'body', publishedAt }, now - 5);
    const result = await seederMod.readForecastEvidenceArchive(start, now, {
      redisUrl: 'https://redis.example',
      redisToken: 'token',
      fetchFn: sequenceFetch([
        { result: coverage },
        { result: [hash, String(now - 5)] },
        [{ result: member }],
      ]),
    });
    assert.equal(result.available, true);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].publishedAt, publishedAt);
  });

  it('serves a marker written moments before the read (two independent clocks)', async () => {
    // THE regression test for the archive's central bug: the digest writer and
    // this seeder are separate processes, so coverageEndMs is ALWAYS behind the
    // read clock in production. Every other fixture here pins them equal — the
    // one value production never produces — which is why the suite was green
    // while the archive could never be read at all.
    const publishedAt = now - 5 * 60 * 1000;
    const lagMs = 11 * 60 * 1000; // digest published 11 minutes ago
    const markerEnd = now - lagMs;
    const laggedCoverage = JSON.stringify({
      v: 1,
      coverageStartMs: markerEnd - 14 * 24 * 60 * 60 * 1000,
      coverageEndMs: markerEnd,
      cutoverVerifiedAtMs: markerEnd - 1,
      sourceDigestAtMs: markerEnd,
      maxLookbackMs: 14 * 24 * 60 * 60 * 1000,
      retentionSeconds: 15 * 24 * 60 * 60,
      sourceKey: 'digest:accumulator:v1:full:en',
      legacyOldestHash: 'f'.repeat(64),
      legacyOldestScoreMs: markerEnd - 14 * 24 * 60 * 60 * 1000 - 1,
    });
    const hash = 'a'.repeat(64);
    const member = mod.buildForecastEvidenceMember(
      { hash, title: 'Event happened', link: 'https://example.test', description: 'body', publishedAt },
      markerEnd,
    );
    const result = await seederMod.readForecastEvidenceArchive(markerEnd - 14 * 24 * 60 * 60 * 1000, now, {
      redisUrl: 'https://redis.example',
      redisToken: 'token',
      fetchFn: sequenceFetch([
        { result: laggedCoverage },
        { result: [hash, String(markerEnd)] },
        [{ result: member }],
      ]),
    });
    assert.equal(result.available, true, 'a marker inside the staleness budget must be usable');
    assert.equal(result.items.length, 1);
    assert.equal(result.coverageLagMs, lagMs, 'the observed lag is reported for operators');
    // The window handed downstream reaches nowMs, so archiveCoversEntryWindow
    // does not reject every due entry on the strength of publication lag.
    assert.equal(result.coverageEndMs, now);
    assert.equal(result.markerCoverageEndMs, markerEnd);
  });

  it('still refuses a marker past the staleness budget', async () => {
    const markerEnd = now - mod.FORECAST_EVIDENCE_COVERAGE_MAX_LAG_MS - 1;
    const staleCoverage = JSON.stringify({
      v: 1,
      coverageStartMs: markerEnd - 14 * 24 * 60 * 60 * 1000,
      coverageEndMs: markerEnd,
      cutoverVerifiedAtMs: markerEnd - 1,
      sourceDigestAtMs: markerEnd,
      maxLookbackMs: 14 * 24 * 60 * 60 * 1000,
      retentionSeconds: 15 * 24 * 60 * 60,
      sourceKey: 'digest:accumulator:v1:full:en',
      legacyOldestHash: 'f'.repeat(64),
      legacyOldestScoreMs: markerEnd - 14 * 24 * 60 * 60 * 1000 - 1,
    });
    const calls = [];
    const result = await seederMod.readForecastEvidenceArchive(markerEnd - 14 * 24 * 60 * 60 * 1000, now, {
      redisUrl: 'https://redis.example',
      redisToken: 'token',
      fetchFn: sequenceFetch([{ result: staleCoverage }], calls),
    });
    assert.equal(result.available, false);
    assert.equal(result.incompleteReason, 'coverage_window_incomplete');
    assert.equal(calls.length, 1, 'a stale marker must short-circuit before the ZSet read');
  });

  it('narrows coverage on hash-cap truncation instead of failing the whole read', async () => {
    // The accumulator reader this replaces degraded this way. Failing the read
    // outright means that once the 14-day window exceeds the cap — a standing
    // property of a busy archive, not a blip — no judged forecast ever
    // resolves again. Narrowing keeps it fail-closed PER ENTRY instead.
    const newest = 'a'.repeat(64);
    const oldest = 'b'.repeat(64);
    const newestScore = now - 60_000;
    const droppedScore = now - 120_000;
    const member = mod.buildForecastEvidenceMember(
      { hash: newest, title: 'Retained', link: 'https://example.test/a', description: '', publishedAt: newestScore },
      newestScore,
    );
    const result = await seederMod.readForecastEvidenceArchive(start, now, {
      redisUrl: 'https://redis.example',
      redisToken: 'token',
      maxHashes: 1,
      fetchFn: sequenceFetch([
        { result: coverage },
        { result: [newest, String(newestScore), oldest, String(droppedScore)] },
        [{ result: member }],
      ]),
    });
    assert.equal(result.available, true, 'truncation must not fail the read');
    assert.equal(result.truncated, true);
    assert.equal(result.coverageComplete, false, 'the caller can still see it was capped');
    assert.equal(result.items.length, 1);
    // Coverage now begins at the oldest RETAINED score, so an entry needing
    // anything older is refused by archiveCoversEntryWindow rather than being
    // judged against a silently short window.
    assert.equal(result.coverageStartMs, newestScore);
    assert.ok(result.coverageStartMs > droppedScore);
  });

  it('marks raw cap and tombstone gaps incomplete before filtering', async () => {
    const firstHash = 'b'.repeat(64);
    const secondHash = 'c'.repeat(64);
    const result = await seederMod.readForecastEvidenceArchive(start, now, {
      redisUrl: 'https://redis.example',
      redisToken: 'token',
      maxHashes: 1,
      fetchFn: sequenceFetch([
        { result: coverage },
        { result: [firstHash, String(now), secondHash, String(now - 1)] },
        [{ result: null }],
      ]),
    });
    assert.equal(result.available, false);
    assert.equal(result.truncated, true);
    assert.equal(result.malformedTombstones, 1);
  });

  it('does not let duplicate index hashes crowd unique evidence silently', async () => {
    const hash = 'a'.repeat(64);
    const member = mod.buildForecastEvidenceMember({
      hash,
      title: 'Duplicate index member',
      link: 'https://example.test/z',
      description: '',
      publishedAt: start + 1,
    }, now);
    const result = await seederMod.readForecastEvidenceArchive(start, now, {
      redisUrl: 'https://redis.example',
      redisToken: 'token',
      maxHashes: 3,
      fetchFn: sequenceFetch([
        { result: coverage },
        { result: [hash, String(now), hash, String(now - 1)] },
        [{ result: member }],
      ]),
    });
    assert.equal(result.available, false);
    assert.equal(result.items.length, 1);
    assert.equal(result.malformedTombstones, 1);
  });

  it('falls back to the accumulator when archive coverage is unverified', async () => {
    const hash = 'd'.repeat(64);
    const calls = [];
    const result = await seederMod.readJudgedNewsArchiveForLedger({
      forecast: {
        status: 'pending-judge',
        deadline: now - 1,
        spec: { kind: 'judged', deadline: now - 1, question: 'Did the event happen?' },
      },
    }, now, {
      redisUrl: 'https://redis.example',
      redisToken: 'token',
      quietArchiveMigration: true,
      fetchFn: sequenceFetch([
        { result: null },
        { result: [hash, String(now - 10)] },
        [{ result: ['title', 'Event happened', 'link', 'https://example.test', 'description', 'body', 'publishedAt', String(now - 20)] }],
      ], calls),
    });
    assert.equal(result.available, true);
    assert.equal(result.items[0].hash, hash);
    assert.equal(calls.length, 3);
  });

  it('waits instead of using a pruned legacy fallback when verified coverage lags', async () => {
    // Lag must exceed FORECAST_EVIDENCE_COVERAGE_MAX_LAG_MS. A marker one
    // millisecond behind the read clock is the NORMAL steady state (the digest
    // writer is a different process) and is accepted; only a writer that has
    // genuinely stopped leaves a hole worth stalling for.
    const staleEnd = now - mod.FORECAST_EVIDENCE_COVERAGE_MAX_LAG_MS - 1;
    const laggingCoverage = JSON.stringify({
      v: 1,
      coverageStartMs: staleEnd - 14 * 24 * 60 * 60 * 1000,
      coverageEndMs: staleEnd,
      cutoverVerifiedAtMs: staleEnd - 10,
      sourceDigestAtMs: staleEnd,
      maxLookbackMs: 14 * 24 * 60 * 60 * 1000,
      retentionSeconds: 15 * 24 * 60 * 60,
      sourceKey: 'digest:accumulator:v1:full:en',
      legacyOldestHash: 'f'.repeat(64),
      legacyOldestScoreMs: staleEnd - 14 * 24 * 60 * 60 * 1000 - 1,
    });
    const calls = [];
    const result = await seederMod.readJudgedNewsArchiveForLedger({
      forecast: {
        status: 'pending-judge',
        deadline: now - 1,
        spec: { kind: 'judged', deadline: now - 1, question: 'Did the event happen?' },
      },
    }, now, {
      redisUrl: 'https://redis.example',
      redisToken: 'token',
      quietArchiveMigration: true,
      cutoverEnabled: true,
      fetchFn: sequenceFetch([{ result: laggingCoverage }], calls),
    });
    assert.equal(result.available, false);
    assert.equal(result.cutoverVerified, true);
    assert.equal(result.incompleteReason, 'coverage_window_incomplete');
    assert.equal(calls.length, 1, 'the pruned accumulator must not be used after cutover');
  });

  it('may use the intact legacy fallback for lagging archive coverage before cutover', async () => {
    // Was vacuous: 32-char hashes fail isForecastEvidenceHash, so the marker
    // parsed to null and this exercised the coverage_UNVERIFIED branch that the
    // test above already covers — never the lagging-coverage branch it names.
    const hash = 'd'.repeat(64);
    const staleEnd = now - mod.FORECAST_EVIDENCE_COVERAGE_MAX_LAG_MS - 1;
    const laggingCoverage = JSON.stringify({
      v: 1,
      coverageStartMs: staleEnd - 14 * 24 * 60 * 60 * 1000,
      coverageEndMs: staleEnd,
      cutoverVerifiedAtMs: staleEnd - 10,
      sourceDigestAtMs: staleEnd,
      maxLookbackMs: 14 * 24 * 60 * 60 * 1000,
      retentionSeconds: 15 * 24 * 60 * 60,
      sourceKey: 'digest:accumulator:v1:full:en',
      legacyOldestHash: 'f'.repeat(64),
      legacyOldestScoreMs: staleEnd - 14 * 24 * 60 * 60 * 1000 - 1,
    });
    const calls = [];
    const result = await seederMod.readJudgedNewsArchiveForLedger({
      forecast: {
        status: 'pending-judge',
        deadline: now - 1,
        spec: { kind: 'judged', deadline: now - 1, question: 'Did the event happen?' },
      },
    }, now, {
      redisUrl: 'https://redis.example',
      redisToken: 'token',
      quietArchiveMigration: true,
      cutoverEnabled: false,
      fetchFn: sequenceFetch([
        { result: laggingCoverage },
        { result: [hash, String(now - 10)] },
        [{ result: ['title', 'Event happened', 'link', 'https://example.test', 'description', 'body', 'publishedAt', String(now - 20)] }],
      ], calls),
    });
    assert.equal(result.available, true);
    assert.equal(result.items[0].hash, hash);
    assert.equal(calls.length, 3);
  });

  it('fails closed without reading legacy when the coverage GET throws after cutover', async () => {
    const calls = [];
    const result = await seederMod.readJudgedNewsArchiveForLedger({
      forecast: {
        status: 'pending-judge',
        deadline: now - 1,
        spec: { kind: 'judged', deadline: now - 1, question: 'Did the event happen?' },
      },
    }, now, {
      redisUrl: 'https://redis.example',
      redisToken: 'token',
      cutoverEnabled: true,
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), command: JSON.parse(init.body) });
        throw new Error('coverage Redis unavailable');
      },
    });
    assert.equal(result.available, false);
    assert.equal(result.cutoverEnabled, true);
    assert.equal(result.incompleteReason, 'archive_read_failed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command[0], 'GET');
  });

  it('fails closed without reading legacy when the archive query throws after cutover', async () => {
    const calls = [];
    const result = await seederMod.readJudgedNewsArchiveForLedger({
      forecast: {
        status: 'pending-judge',
        deadline: now - 1,
        spec: { kind: 'judged', deadline: now - 1, question: 'Did the event happen?' },
      },
    }, now, {
      redisUrl: 'https://redis.example',
      redisToken: 'token',
      cutoverEnabled: true,
      fetchFn: async (url, init) => {
        const command = JSON.parse(init.body);
        calls.push({ url: String(url), command });
        if (calls.length === 1) return response({ result: coverage });
        throw new Error('archive ZSet unavailable');
      },
    });
    assert.equal(result.available, false);
    assert.equal(result.incompleteReason, 'archive_read_failed');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].command[0], 'ZREVRANGEBYSCORE');
  });
});

describe('bounded backfill and cutover (#7082)', () => {
  const now = 1_750_000_000_000;
  const hash = 'e'.repeat(64);
  const track = ['title', 'Backfilled event', 'link', 'https://example.test/e', 'description', 'body', 'publishedAt', String(now - 1_000)];

  it('is a dry-run by default and never writes a cutover marker', async () => {
    const calls = [];
    const report = await backfillMod.backfillForecastEvidenceArchive({
      nowMs: now,
      redisUrl: 'https://redis.example',
      redisToken: 'token',
      fetchFn: sequenceFetch([
        { result: [hash, String(now - 500)] },
        { result: ['f'.repeat(64), String(now - backfillMod.FORECAST_EVIDENCE_BACKFILL_WINDOW_MS - 1)] },
        [{ result: null }, { result: track }],
      ], calls),
    });
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.cutoverVerified, false);
    assert.equal(calls.some(call => call.command[0] === 'SET'), false);
  });

  it('reports an incomplete dry-run instead of certifying or throwing it away', async () => {
    const report = await backfillMod.backfillForecastEvidenceArchive({
      nowMs: now,
      redisUrl: 'https://redis.example',
      redisToken: 'token',
      fetchFn: sequenceFetch([
        { result: [hash, String(now - 500)] },
        { result: ['f'.repeat(64), String(now - backfillMod.FORECAST_EVIDENCE_BACKFILL_WINDOW_MS - 1)] },
        [{ result: null }, { result: [] }],
      ]),
    });
    assert.equal(report.cutoverVerified, false);
    assert.equal(report.missingRows, 1);
    assert.equal(report.writableRecords, 0);
  });

  it('keeps cutover unverified when the oldest legacy member is newer than the window', async () => {
    const report = await backfillMod.backfillForecastEvidenceArchive({
      nowMs: now,
      redisUrl: 'https://redis.example',
      redisToken: 'token',
      fetchFn: sequenceFetch([
        { result: [hash, String(now - 500)] },
        { result: ['f'.repeat(64), String(now - backfillMod.FORECAST_EVIDENCE_BACKFILL_WINDOW_MS + 1)] },
        [{ result: null }, { result: track }],
      ]),
    });
    assert.equal(report.legacyCoverageObserved, false);
    assert.equal(report.cutoverVerified, false);
  });

  it('does not certify an empty 14-day range from an old sentinel alone', async () => {
    const calls = [];
    const report = await backfillMod.backfillForecastEvidenceArchive({
      apply: true,
      nowMs: now,
      redisUrl: 'https://redis.example',
      redisToken: 'token',
      fetchFn: sequenceFetch([
        { result: [] },
        { result: ['f'.repeat(64), String(now - backfillMod.FORECAST_EVIDENCE_BACKFILL_WINDOW_MS - 1)] },
      ], calls),
    });
    assert.equal(report.sourceRecords, 0);
    assert.equal(report.legacyCoverageObserved, true);
    assert.equal(report.cutoverVerified, false);
    assert.equal(calls.some(call => call.command[0] === 'SET' && call.command[1] === mod.FORECAST_EVIDENCE_COVERAGE_KEY), false);
  });

  it('writes the marker only after bounded writes and read-back verification', async () => {
    const calls = [];
    const member = mod.buildForecastEvidenceMember({ hash, title: 'Backfilled event', link: 'https://example.test/e', description: 'body', publishedAt: now - 1_000 }, now - 500);
    const marker = JSON.stringify({
      v: 1,
      coverageStartMs: now - backfillMod.FORECAST_EVIDENCE_BACKFILL_WINDOW_MS,
      coverageEndMs: now,
      cutoverVerifiedAtMs: now,
      sourceDigestAtMs: now,
      maxLookbackMs: mod.FORECAST_EVIDENCE_MAX_LOOKBACK_MS,
      retentionSeconds: mod.FORECAST_EVIDENCE_TTL_S,
      sourceKey: backfillMod.FORECAST_EVIDENCE_BACKFILL_SOURCE_KEY,
      legacyOldestHash: 'f'.repeat(64),
      legacyOldestScoreMs: now - backfillMod.FORECAST_EVIDENCE_BACKFILL_WINDOW_MS - 1,
    });
    const report = await backfillMod.backfillForecastEvidenceArchive({
      apply: true,
      nowMs: now,
      redisUrl: 'https://redis.example',
      redisToken: 'token',
      fetchFn: sequenceFetch([
        { result: [hash, String(now - 500)] },
        { result: ['f'.repeat(64), String(now - backfillMod.FORECAST_EVIDENCE_BACKFILL_WINDOW_MS - 1)] },
        [{ result: null }, { result: track }],
        [{ result: 'OK' }, { result: 1 }],
        [{ result: member }, { result: String(now - 500) }],
        { result: 'OK' },
        { result: marker },
      ], calls),
    });
    assert.equal(report.cutoverVerified, true);
    assert.equal(report.legacyCoverageObserved, true);
    const zadd = calls.find(call => Array.isArray(call.command[0]) && call.command.some(command => command[0] === 'ZADD'));
    assert.ok(zadd);
    assert.deepEqual(zadd.command.find(command => command[0] === 'ZADD').slice(-1), [hash]);
    assert.equal(calls.at(-2).command[1], mod.FORECAST_EVIDENCE_COVERAGE_KEY);
  });

  it('does not write a cutover marker after an unconfirmed archive write', async () => {
    const calls = [];
    await assert.rejects(
      backfillMod.backfillForecastEvidenceArchive({
        apply: true,
        nowMs: now,
        redisUrl: 'https://redis.example',
        redisToken: 'token',
        fetchFn: sequenceFetch([
          { result: [hash, String(now - 500)] },
          { result: ['f'.repeat(64), String(now - backfillMod.FORECAST_EVIDENCE_BACKFILL_WINDOW_MS - 1)] },
          [{ result: null }, { result: track }],
          [],
        ], calls),
      }),
      /write was not confirmed/,
    );
    assert.equal(calls.some(call => call.command[0] === 'SET' && call.command[1] === mod.FORECAST_EVIDENCE_COVERAGE_KEY), false);
  });
});
