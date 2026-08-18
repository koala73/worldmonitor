import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADMISSION_HEADROOM_MS,
  KILL_GRACE_MS,
  sectionWorstCaseMs,
} from '../scripts/_bundle-runner.mjs';
import {
  MEASURE_FETCH_ONLY_FLAG,
  main,
  measureResilienceStaticFetch,
  resolveEntry,
  runMeasureFetchOnly,
} from '../scripts/seed-resilience-static.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const evidencePath = join(root, 'scripts/resilience-static-full-run-evidence.json');

// Only a completed full lifecycle may be used as timeout evidence. A
// fetch-only benchmark must never match this shape.
//   measured YYYY-MM-DD: <N>s full-run (...)
const FULL_RUN_MEASURED_RE = /measured (\d{4}-\d{2}-\d{2}): (\d+(?:\.\d+)?)s full-run\b/;

function parseFullRunMeasurementCitation(text, nowMs = Date.now()) {
  const match = text.match(FULL_RUN_MEASURED_RE);
  if (!match) return null;
  const measuredAt = new Date(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(measuredAt.getTime())) return null;
  // JavaScript normalizes impossible dates instead of rejecting them (for
  // example 2026-02-31 becomes 2026-03-03), so validity needs a round trip.
  if (measuredAt.toISOString().slice(0, 10) !== match[1]) return null;
  if (measuredAt.getTime() > nowMs) return null;
  return { date: match[1], durationS: Number(match[2]) };
}

function readResilienceBundleContract() {
  const source = readFileSync(join(root, 'scripts/seed-bundle-resilience.mjs'), 'utf8');
  const section = (label) => {
    const match = source.match(new RegExp(`\\{ label: '${label}'[^}]+timeoutMs:\\s*([\\d_]+)`));
    assert.ok(match, `seed-bundle-resilience.mjs must declare ${label} with timeoutMs`);
    return {
      start: source.indexOf(match[0]),
      timeoutMs: Number(match[1].replace(/_/g, '')),
    };
  };
  const maxMatch = source.match(/maxBundleMs:\s*([\d_]+)/);
  assert.ok(maxMatch, 'seed-bundle-resilience.mjs must declare maxBundleMs');
  const scores = section('Resilience-Scores');
  const staticSection = section('Resilience-Static');
  const previousSectionEnd = source.lastIndexOf('{ label:', staticSection.start - 1);
  return {
    maxBundleMs: Number(maxMatch[1].replace(/_/g, '')),
    scores,
    staticSection,
    staticComment: source.slice(previousSectionEnd === -1 ? 0 : previousSectionEnd, staticSection.start),
  };
}

function readFullRunEvidence() {
  return JSON.parse(readFileSync(evidencePath, 'utf8'));
}

test('measureResilienceStaticFetch computes duration, sizes and adapterCount from a fetchAll result', async () => {
  let now = 1_000;
  const datasetMaps = {
    wgi: new Map([['US', { source: 'worldbank-wgi' }]]),
    rsf: new Map([['NO', { source: 'rsf-ranking' }]]),
  };
  const result = await measureResilienceStaticFetch({
    fetchAll: async () => {
      now += 12_345;
      return { datasetMaps, failedDatasets: [] };
    },
    now: () => now,
  });

  assert.equal(result.durationMs, 12_345);
  assert.equal(result.adapterCount, 2);
  assert.deepEqual(result.failedDatasets, []);
  assert.deepEqual(result.sizes, { wgi: 1, rsf: 1 });
  assert.equal(result.measuredAt, new Date(1_000).toISOString());
});

test('measureResilienceStaticFetch passes failures through and sizes non-Map slots as 0', async () => {
  const result = await measureResilienceStaticFetch({
    fetchAll: async () => ({
      datasetMaps: { wgi: new Map([['US', {}]]), rsf: new Map(), gpi: undefined },
      failedDatasets: ['rsf'],
    }),
    now: () => 5_000,
  });

  assert.deepEqual(result.failedDatasets, ['rsf']);
  assert.equal(result.adapterCount, 3);
  assert.deepEqual(result.sizes, { wgi: 1, rsf: 0, gpi: 0 });
});

test('runMeasureFetchOnly emits success JSON only after a complete non-empty fan-out', async () => {
  const measured = (failedDatasets, adapterCount = 2) => async () => ({
    measuredAt: '2026-08-18T00:00:00.000Z',
    durationMs: 800,
    failedDatasets,
    sizes: { wgi: 0, rsf: 176 },
    adapterCount,
  });

  for (const [measure, expected] of [
    [measured(['wgi']), /1\/2 adapter\(s\) failed \(wgi\)/],
    [measured([], 0), /ran no adapters/],
  ]) {
    const stdout = [];
    await assert.rejects(() => runMeasureFetchOnly({ measure, write: (line) => stdout.push(line) }), expected);
    assert.deepEqual(stdout, [], 'a failed measurement must leave no citable JSON on stdout');
  }

  const stdout = [];
  const result = await runMeasureFetchOnly({ measure: measured([]), write: (line) => stdout.push(line) });
  assert.equal(stdout.length, 1);
  assert.deepEqual(JSON.parse(stdout[0]), result);
});

test('the CLI dispatch keeps fetch-only timing diagnostic and refuses unknown arguments', () => {
  assert.equal(resolveEntry(['node', 's.mjs', MEASURE_FETCH_ONLY_FLAG]), runMeasureFetchOnly);
  assert.equal(resolveEntry(['node', 's.mjs']), main);
  for (const typo of ['--measure-fetch', '--measureFetchOnly', '--measure_fetch_only']) {
    assert.throws(() => resolveEntry(['node', 's.mjs', typo]), /Unknown argument/, `${typo} must not fall through to main()`);
  }
});

test('#6562 timeout evidence is a source-bound full non-skipped Railway run', () => {
  const { staticComment, staticSection } = readResilienceBundleContract();
  const evidence = readFullRunEvidence();
  const citation = parseFullRunMeasurementCitation(staticComment);

  assert.ok(citation, 'the Static section must cite `measured YYYY-MM-DD: <N>s full-run`');
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.source, 'railway-production-log');
  assert.equal(evidence.service, 'seed-bundle-resilience');
  assert.match(evidence.deploymentId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.match(evidence.deploymentCommit, /^[0-9a-f]{40}$/);
  assert.equal(citation.date, evidence.capturedDate);
  assert.equal(citation.durationS, evidence.bundleRunner.doneSeconds);
  assert.match(staticComment, new RegExp(evidence.deploymentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(staticComment, new RegExp(evidence.deploymentCommit.slice(0, 8)));
  assert.match(staticComment, /resilience-static-full-run-evidence\.json/);

  assert.equal(evidence.seedComplete.event, 'seed_complete');
  assert.equal(evidence.seedComplete.domain, 'resilience:static');
  assert.equal(evidence.seedComplete.skipped, false);
  assert.deepEqual(evidence.seedComplete.failedDatasets, []);
  assert.ok(evidence.seedComplete.recordCount > 0);
  assert.equal(evidence.bundleRunner.status, 'OK');
  assert.equal(evidence.bundleRunner.durationMs, evidence.seedComplete.durationMs);
  assert.equal(evidence.bundleRunner.records, evidence.seedComplete.recordCount);
  assert.ok(
    evidence.bundleRunner.doneSeconds * 1000 >= evidence.seedComplete.durationMs,
    'the process-level Done time must include the seed_complete duration',
  );

  const observedAtMs = Date.parse(evidence.observedAt);
  const completedAtMs = Date.parse(evidence.seedComplete.timestamp);
  assert.ok(Number.isFinite(observedAtMs) && Number.isFinite(completedAtMs));
  assert.equal(new Date(observedAtMs).toISOString().slice(0, 10), evidence.capturedDate);
  assert.equal(new Date(completedAtMs).toISOString().slice(0, 10), evidence.capturedDate);
  assert.ok(observedAtMs >= completedAtMs, 'the captured log line must not predate the seed completion it records');
  assert.ok(
    staticSection.timeoutMs >= evidence.seedComplete.durationMs,
    `timeout ${staticSection.timeoutMs}ms is below the measured full run ${evidence.seedComplete.durationMs}ms`,
  );
  assert.doesNotMatch(
    staticComment,
    /measured \d{4}-\d{2}-\d{2}: \d+(?:\.\d+)?s fetch-only\b/,
    'fetch-only timing must never be presented as bundle-placement evidence',
  );
});

test('the full-run citation guard rejects normalized calendar dates and non-evidence shapes', () => {
  const now = Date.parse('2026-08-18T23:59:59Z');
  for (const citation of [
    'measured 2026-02-31: 12.3s full-run',
    'measured 2026-13-01: 12.3s full-run',
    'measured 2026-08-19: 12.3s full-run',
    'measured 2026-08-18: 12.3s fetch-only',
    'measured 2026-08-18: 6min 30s full-run',
    'estimated 2026-08-18: 12.3s full-run',
  ]) {
    assert.equal(parseFullRunMeasurementCitation(citation, now), null, `must not accept: ${citation}`);
  }

  assert.deepEqual(
    parseFullRunMeasurementCitation('measured 2026-08-18: 12.3s full-run (196 records)', now),
    { date: '2026-08-18', durationS: 12.3 },
  );
});

test('#6562 placement uses cumulative runner timeout-plus-grace arithmetic', () => {
  const { maxBundleMs, scores, staticSection, staticComment } = readResilienceBundleContract();
  const scoresWorstCaseMs = sectionWorstCaseMs({ timeoutMs: scores.timeoutMs });
  const staticWorstCaseMs = sectionWorstCaseMs({ timeoutMs: staticSection.timeoutMs });
  const latestStaticStartMs = maxBundleMs - staticWorstCaseMs;
  const admitsStatic = (elapsedMs) => elapsedMs + staticWorstCaseMs <= maxBundleMs;
  const conservativeTotalMs = ADMISSION_HEADROOM_MS + scoresWorstCaseMs + staticWorstCaseMs;

  assert.equal(KILL_GRACE_MS, 10_000, 'a kill-grace change must force this placement contract to be re-evaluated');
  assert.equal(ADMISSION_HEADROOM_MS, 15_000, 'an admission-headroom change must force this contract to be re-evaluated');
  assert.equal(scoresWorstCaseMs, 250_000);
  assert.equal(staticWorstCaseMs, 290_000);
  assert.equal(latestStaticStartMs, 280_000);
  assert.equal(conservativeTotalMs, 555_000);
  assert.ok(
    conservativeTotalMs <= maxBundleMs,
    'Static must remain admissible after Scores consumes its full reservation plus admission headroom',
  );
  assert.equal(admitsStatic(latestStaticStartMs), true, 'the runtime comparison admits exactly at the boundary');
  assert.equal(admitsStatic(latestStaticStartMs + 1), false, 'one millisecond past the boundary must defer');
  assert.ok(scoresWorstCaseMs <= latestStaticStartMs, 'Scores full worst case must leave enough runtime to admit Static');
  assert.equal(maxBundleMs - conservativeTotalMs, 15_000, 'the configured placement must retain its documented margin');
  assert.match(staticComment, /Scores' 250s worst case/);
  assert.match(staticComment, /555s/);
});
