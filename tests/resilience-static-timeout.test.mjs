import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MEASURE_FETCH_ONLY_FLAG,
  main,
  measureResilienceStaticFetch,
  resolveEntry,
  runMeasureFetchOnly,
} from '../scripts/seed-resilience-static.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The comment shape `runMeasureFetchOnly` produces and the guard below accepts.
// Stated here so a future re-measurement can be written to match without
// reverse-engineering the regex.
//   measured YYYY-MM-DD: <N>s fetch-only (...)
const MEASURED_RE = /measured (\d{4}-\d{2}-\d{2}): (\d+(?:\.\d+)?)s fetch-only\b/;

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
  // Pin measuredAt to the FIRST now() call, not just to ISO shape: a shape-only
  // match cannot tell the start stamp from the post-fetch one.
  assert.equal(result.measuredAt, new Date(1_000).toISOString());
});

test('measureResilienceStaticFetch passes failures through and sizes non-Map slots as 0', async () => {
  const result = await measureResilienceStaticFetch({
    fetchAll: async () => ({
      // fetchAllDatasetMaps assigns an empty Map for a failed adapter, so a
      // failure is visible only via failedDatasets — adapterCount stays at the
      // number ATTEMPTED. That is exactly why runMeasureFetchOnly cannot use
      // adapterCount to judge success.
      datasetMaps: { wgi: new Map([['US', {}]]), rsf: new Map(), gpi: undefined },
      failedDatasets: ['rsf'],
    }),
    now: () => 5_000,
  });

  assert.deepEqual(result.failedDatasets, ['rsf']);
  assert.equal(result.adapterCount, 3);
  assert.deepEqual(result.sizes, { wgi: 1, rsf: 0, gpi: 0 });
});

test('runMeasureFetchOnly rejects a partially-failed fan-out, not just a fully-failed one', async () => {
  // The regression this pins: the original guard fired only when EVERY adapter
  // failed, so a 10-of-11 failure printed a fast, confident duration and exited
  // 0 — the number then citable in the timeout comment.
  const measured = (failedDatasets) => async () => ({
    measuredAt: '2026-08-18T00:00:00.000Z',
    durationMs: 800,
    failedDatasets,
    sizes: { wgi: 0, rsf: 176 },
    adapterCount: 2,
  });

  await assert.rejects(
    () => runMeasureFetchOnly({ measure: measured(['wgi']) }),
    /1\/2 adapter\(s\) failed \(wgi\)/,
  );
  await assert.doesNotReject(() => runMeasureFetchOnly({ measure: measured([]) }));
});

test('the CLI dispatch selects the measurement path and refuses unknown arguments', () => {
  assert.equal(resolveEntry(['node', 's.mjs', MEASURE_FETCH_ONLY_FLAG]), runMeasureFetchOnly);
  assert.equal(resolveEntry(['node', 's.mjs']), main);
  // The failure this prevents: main() acquires the lock, fetches and PUBLISHES,
  // so a typo must not silently become a real seed run.
  for (const typo of ['--measure-fetch', '--measureFetchOnly', '--measure_fetch_only']) {
    assert.throws(() => resolveEntry(['node', 's.mjs', typo]), /Unknown argument/, `${typo} must not fall through to main()`);
  }
});

test('#6562 Resilience-Static timeout cites a dated live measurement, not only a design worst case', () => {
  const bundle = readFileSync(join(root, 'scripts/seed-bundle-resilience.mjs'), 'utf8');
  // Two narrow matches instead of one wide one. Anchoring on the prose above the
  // section (the old `11 dataset adapters` literal) coupled the guard to wording
  // that may change for unrelated reasons; but widening the span to the whole
  // file is worse, because the citation search would then reach into a SIBLING
  // section's comment and read its number as Resilience-Static's. So: take the
  // timeout from the section literal, and search for the citation only in the
  // comment block between the previous section and this one.
  const sectionRe = /\{ label: 'Resilience-Static'[^}]+timeoutMs:\s*([\d_]+)/;
  const section = bundle.match(sectionRe);
  assert.ok(section, "seed-bundle-resilience.mjs must declare a Resilience-Static section with a timeoutMs");

  const sectionStart = bundle.indexOf(section[0]);
  const previousSectionEnd = bundle.lastIndexOf('{ label:', sectionStart - 1);
  const comment = bundle.slice(previousSectionEnd === -1 ? 0 : previousSectionEnd, sectionStart);
  const timeoutMs = Number(section[1].replace(/_/g, ''));
  // Anchored to the slot immediately after the date, with the unit and the
  // `fetch-only` qualifier pinned. The previous loose pattern took the FIRST
  // <digits>s token anywhere on the line, which accepted
  // "measured 2027-03-01: design worst case ~92s, no live run" (the exact thing
  // this test is named for rejecting) and read "6min 30s" as 30s and
  // "p50 2.5s, p99 410s" as 2.5s — each slipping a too-slow member past the
  // ceiling below.
  const measured = comment.match(MEASURED_RE);
  assert.ok(
    measured,
    'the Resilience-Static comment must cite `measured YYYY-MM-DD: <N>s fetch-only` from a real '
      + `\`node scripts/seed-resilience-static.mjs ${MEASURE_FETCH_ONLY_FLAG}\` run — `
      + 'a design-worst-case timeout is how #6556 left this member unmeasured',
  );

  // The date is the half that makes "dated live measurement" mean anything; the
  // original guard captured it and never read it, so `measured 1999-01-01` passed.
  // Bounding its AGE is deliberately not done here: a time-based assertion in the
  // merge-blocking suite goes red on a date, with no code change, in someone
  // else's PR.
  const measuredAt = new Date(`${measured[1]}T00:00:00Z`);
  assert.ok(
    Number.isFinite(measuredAt.getTime()) && measuredAt.getTime() <= Date.now(),
    `cited measurement date ${measured[1]} is not a real, past date`,
  );

  const measuredS = Number(measured[2]);
  const declaredS = timeoutMs / 1000;
  assert.ok(
    declaredS >= measuredS,
    `timeout ${declaredS}s is below the cited measurement ${measuredS}s`,
  );
  // Comfortable headroom inside the 570s bundle: after Scores' 250s reservation
  // (240s + 10s kill grace) there are 320s left. A member that needs more than
  // that on a real run does not belong in this bundle (#6562 item 1).
  assert.ok(
    measuredS <= 320,
    `measured ${measuredS}s does not fit comfortably after Resilience-Scores — `
      + 'split Resilience-Static to its own Railway service instead of raising 420s',
  );

  // Behavioural, not a whole-file grep for the flag string: a leftover comment
  // satisfied the old assertion just as well as a working entry point.
  assert.equal(
    resolveEntry(['node', 'seed-resilience-static.mjs', MEASURE_FETCH_ONLY_FLAG]),
    runMeasureFetchOnly,
    'the seeder must keep a working --measure-fetch-only path so this timeout can be re-measured',
  );
});

test('the measurement-citation pattern rejects the shapes that used to slip through', () => {
  // Positive control. Without this, nothing proves the assertions above can fail
  // at all — the guard would agree with itself forever.
  const rejected = [
    'measured 2027-03-01: design worst case ~92s, no live run',
    'measured 2027-03-01: 6min 30s fetch-only',
    'measured 2027-01-01: 8m10s fetch-only',
    'measured 2027-01-01: p50 2.5s, p99 410s fetch-only',
    'measured 2027-01-01: 450000ms fetch-only',
    'estimated 2027-01-01: 3.0s fetch-only',
  ];
  for (const citation of rejected) {
    assert.equal(MEASURED_RE.test(citation), false, `must not accept: ${citation}`);
  }

  const accepted = 'measured 2026-08-18: 3.0s fetch-only (11/11 adapters; repeats 1.3s / 1.6s)';
  const match = accepted.match(MEASURED_RE);
  assert.ok(match, `must accept the committed shape: ${accepted}`);
  assert.equal(match[1], '2026-08-18');
  assert.equal(Number(match[2]), 3);

  // And the ceiling itself must be able to fail, not merely pass on 3.0s.
  const tooSlow = 'measured 2027-01-01: 390s fetch-only'.match(MEASURED_RE);
  assert.ok(tooSlow && Number(tooSlow[2]) > 320, 'a 390s citation must exceed the 320s ceiling');
});
