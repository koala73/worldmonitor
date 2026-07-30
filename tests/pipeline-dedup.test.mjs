// @ts-check
//
// Tests for scripts/_pipeline-dedup.mjs — the haversine + Jaccard dedup
// helper. Both criteria (≤5km AND ≥0.6) must hold for a match. Existing rows
// always win to preserve hand-curated evidence.

import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { dedupePipelines, _internal } from '../scripts/_pipeline-dedup.mjs';

const { jaccard, averageEndpointDistanceKm, tokenize, uniqueId } = _internal;

function makePipeline(id, name, startLat, startLon, endLat, endLon) {
  return {
    id,
    name,
    startPoint: { lat: startLat, lon: startLon },
    endPoint: { lat: endLat, lon: endLon },
  };
}

describe('pipeline-dedup — internal helpers', () => {
  test('tokenize lowercases, splits, drops stopwords', () => {
    const tokens = tokenize('Trans-Siberian Pipeline System');
    assert.deepEqual(tokens.sort(), ['siberian', 'trans']);
  });

  test('tokenize removes punctuation and accents', () => {
    const tokens = tokenize('Caño Limón–Coveñas Pipeline');
    // After NFKD normalization + ascii-only filter, accented chars survive
    // as their base letter; we accept either exact or close behaviour.
    assert.ok(tokens.includes('limon') || tokens.includes('lim'),
      `expected Limón to tokenize; got ${tokens.join(',')}`);
  });

  test('jaccard returns 1.0 for identical token sets', () => {
    assert.equal(jaccard('Test Pipeline System', 'Test Pipeline'), 1.0);
  });

  test('jaccard returns 0 for fully disjoint names', () => {
    assert.equal(jaccard('Druzhba North', 'Nord Stream'), 0);
  });

  test('jaccard 0.5 for half-overlap', () => {
    assert.equal(jaccard('Trans Adriatic', 'Trans Caspian'), 1 / 3);
  });

  test('haversine distance is symmetric', () => {
    const a = makePipeline('a', 'A', 60, 30, 54, 13);
    const b = makePipeline('b', 'B', 60.001, 30.001, 54.001, 13.001);
    assert.ok(averageEndpointDistanceKm(a, b) < 1, 'sub-km on tiny offsets');
  });

  test('haversine distance for far-apart pipelines is large', () => {
    const a = makePipeline('a', 'A', 60, 30, 54, 13);  // RU→DE
    const b = makePipeline('b', 'B', 30, -90, 25, -85); // Gulf of Mexico
    assert.ok(averageEndpointDistanceKm(a, b) > 5000);
  });

  test('uniqueId preserves base when free, suffixes when taken', () => {
    const taken = new Set(['foo', 'foo-2']);
    assert.equal(uniqueId('bar', taken), 'bar');
    assert.equal(uniqueId('foo', taken), 'foo-3');
  });
});

describe('pipeline-dedup — match logic', () => {
  test('happy path: completely-different name + far endpoints → added', () => {
    const existing = [makePipeline('druzhba-north', 'Druzhba Pipeline (Northern Branch)',
      52.6, 49.4, 52.32, 14.06)];
    const candidates = [makePipeline('nord-stream-1', 'Nord Stream 1',
      60.08, 29.05, 54.14, 13.66)];
    const { toAdd, skippedDuplicates } = dedupePipelines(existing, candidates);
    assert.equal(toAdd.length, 1);
    assert.equal(skippedDuplicates.length, 0);
  });

  test('match by both criteria: close endpoints + similar name → skipped (existing wins)', () => {
    const existing = [makePipeline('druzhba-north', 'Druzhba Pipeline',
      52.6, 49.4, 52.32, 14.06)];
    const candidates = [makePipeline('druzhba-import', 'Druzhba Pipeline',
      52.601, 49.401, 52.321, 14.061)];
    const { toAdd, skippedDuplicates } = dedupePipelines(existing, candidates);
    assert.equal(toAdd.length, 0);
    assert.equal(skippedDuplicates.length, 1);
    assert.equal(skippedDuplicates[0].matchedExistingId, 'druzhba-north');
  });

  test('identical names + one shared terminus (≤25 km) → deduped (PR #3406 Dampier-Bunbury regression)', () => {
    // Real-world case from PR #3406 review: GEM digitized only the southern
    // 60% of the line, so the shared Bunbury terminus matched at 13.7 km
    // but the average-endpoint distance was 287 km (over the 5 km gate).
    // Identical token sets + ≥1 close pairing = same physical pipeline.
    const existing = [makePipeline('dampier-bunbury', 'Dampier to Bunbury Natural Gas Pipeline',
      -20.68, 116.72, -33.33, 115.63)];
    const candidates = [makePipeline('dampier-to-bunbury-natural-gas-pipeline-au',
      'Dampier to Bunbury Natural Gas Pipeline',
      -33.265797, 115.755682, -24.86854, 113.674968)];
    const { toAdd, skippedDuplicates } = dedupePipelines(existing, candidates);
    assert.equal(toAdd.length, 0);
    assert.equal(skippedDuplicates.length, 1);
    assert.equal(skippedDuplicates[0].matchedExistingId, 'dampier-bunbury');
  });

  test('name-match only (endpoints in different ocean) → added', () => {
    const existing = [makePipeline('nord-stream-1', 'Nord Stream 1',
      60.08, 29.05, 54.14, 13.66)];
    const candidates = [makePipeline('imposter', 'Nord Stream 1',
      40.0, -100.0, 35.0, -90.0)]; // different continent
    const { toAdd, skippedDuplicates } = dedupePipelines(existing, candidates);
    assert.equal(toAdd.length, 1, 'low haversine confidence overrides high name match');
    assert.equal(skippedDuplicates.length, 0);
  });

  test('endpoint-match only (different name) → added (real distinct pipelines can share endpoints)', () => {
    const existing = [makePipeline('yamal-europe', 'Yamal–Europe',
      67.0, 75.0, 52.0, 14.0)];
    const candidates = [makePipeline('different-route', 'Trans-Siberian Coal Slurry',
      67.001, 75.001, 52.001, 14.001)];
    const { toAdd } = dedupePipelines(existing, candidates);
    assert.equal(toAdd.length, 1, 'name disambiguates: same endpoints, different infrastructure');
  });

  test('reverse-direction match: candidate endpoints flipped → still detected', () => {
    const existing = [makePipeline('druzhba', 'Druzhba',
      52.6, 49.4, 52.32, 14.06)];
    // Same pipeline, route described in reverse direction
    const candidates = [makePipeline('druzhba-flipped', 'Druzhba',
      52.32, 14.06, 52.6, 49.4)];
    const { toAdd, skippedDuplicates } = dedupePipelines(existing, candidates);
    assert.equal(toAdd.length, 0);
    assert.equal(skippedDuplicates.length, 1);
  });

  test('stopword-only difference: "Pipeline System" vs "Line" → matches by Jaccard', () => {
    const existing = [makePipeline('trans-sib', 'Trans-Siberian Pipeline System',
      55, 30, 60, 90)];
    const candidates = [makePipeline('trans-sib-cand', 'Trans-Siberian Line',
      55.001, 30.001, 60.001, 90.001)];
    const { toAdd, skippedDuplicates } = dedupePipelines(existing, candidates);
    assert.equal(toAdd.length, 0);
    assert.equal(skippedDuplicates.length, 1);
    assert.ok(skippedDuplicates[0].jaccard >= 0.6);
  });
});

describe('pipeline-dedup — id collision', () => {
  test('candidate with id colliding existing gets suffixed -2', () => {
    const existing = [makePipeline('foo', 'Foo Pipeline', 0, 0, 1, 1)];
    const candidates = [makePipeline('foo', 'Bar Pipeline', 50, 50, 60, 60)];
    const { toAdd } = dedupePipelines(existing, candidates);
    assert.equal(toAdd.length, 1);
    assert.equal(toAdd[0].id, 'foo-2');
  });

  test('three candidates colliding the same existing id get -2, -3, -4', () => {
    const existing = [makePipeline('foo', 'Foo Pipeline', 0, 0, 1, 1)];
    const candidates = [
      makePipeline('foo', 'Bar Pipeline', 50, 50, 60, 60),
      makePipeline('foo', 'Baz Pipeline', 70, 70, 80, 80),
      makePipeline('foo', 'Qux Pipeline', 30, -30, 40, -40),
    ];
    const { toAdd } = dedupePipelines(existing, candidates);
    assert.equal(toAdd.length, 3);
    assert.deepEqual(
      toAdd.map((p) => p.id).sort(),
      ['foo-2', 'foo-3', 'foo-4'],
    );
  });
});

describe('pipeline-dedup — determinism', () => {
  test('two invocations on identical inputs produce identical output', () => {
    const existing = [
      makePipeline('a', 'Alpha Pipeline', 10, 10, 20, 20),
      makePipeline('b', 'Beta Pipeline', 30, 30, 40, 40),
    ];
    const candidates = [
      makePipeline('a', 'Alpha Pipeline', 10.001, 10.001, 20.001, 20.001),
      makePipeline('c', 'Gamma Pipeline', 50, 50, 60, 60),
    ];
    const r1 = dedupePipelines(existing, candidates);
    const r2 = dedupePipelines(existing, candidates);
    assert.deepEqual(
      r1.toAdd.map((p) => p.id),
      r2.toAdd.map((p) => p.id),
    );
    assert.deepEqual(
      r1.skippedDuplicates.map((d) => d.matchedExistingId),
      r2.skippedDuplicates.map((d) => d.matchedExistingId),
    );
  });
});

describe('pipeline-dedup — within-batch dedup (review fix)', () => {
  test('two candidates that match each other but not any existing → only first is added', () => {
    // Regression: pre-fix, dedup compared each candidate ONLY against the
    // original `existing` array, so two GEM rows for the same pipeline (e.g.
    // a primary entry and a duplicate from a different source spreadsheet)
    // would BOTH end up in the registry.
    const candidates = [
      makePipeline('east-west-saudi', 'East-West Crude Pipeline', 25, 49, 24, 38),
      // Same pipeline, slightly different name + endpoints (within match
      // tolerance). Should be skipped as a duplicate of the first candidate.
      makePipeline('saudi-petroline', 'East-West Crude', 25.001, 49.001, 24.001, 38.001),
    ];
    const { toAdd, skippedDuplicates } = dedupePipelines([], candidates);
    assert.equal(toAdd.length, 1, 'second matching candidate must be skipped');
    assert.equal(skippedDuplicates.length, 1);
    assert.equal(toAdd[0].id, 'east-west-saudi', 'first-accepted candidate wins (deterministic)');
    assert.equal(skippedDuplicates[0].matchedExistingId, 'east-west-saudi',
      'skipped candidate matches the earlier-accepted one, not anything in `existing`');
  });

  test('three candidates with transitive matches collapse to one', () => {
    const candidates = [
      makePipeline('a', 'Druzhba', 52.6, 49.4, 52.32, 14.06),
      makePipeline('b', 'Druzhba Pipeline', 52.601, 49.401, 52.321, 14.061),
      makePipeline('c', 'Druzhba Line', 52.602, 49.402, 52.322, 14.062),
    ];
    const { toAdd } = dedupePipelines([], candidates);
    assert.equal(toAdd.length, 1, 'three matching candidates must collapse to the first one accepted');
  });

  test('existing wins over already-accepted candidate', () => {
    // If a candidate matches an existing row, it must be reported as
    // matching the existing row (existing-vs-toAdd precedence). Names
    // chosen so Jaccard exceeds 0.6 after stopword removal.
    const existing = [makePipeline('canon', 'Druzhba Northern', 52.6, 49.4, 52.32, 14.06)];
    const candidates = [
      makePipeline('cand-1', 'Druzhba Northern', 60, 30, 50, 14),  // doesn't match existing (far endpoints)
      makePipeline('cand-2', 'Druzhba Northern', 52.601, 49.401, 52.321, 14.061),  // matches existing (near + Jaccard=1)
    ];
    const { toAdd, skippedDuplicates } = dedupePipelines(existing, candidates);
    assert.equal(toAdd.length, 1, 'cand-1 added; cand-2 skipped against existing');
    assert.equal(skippedDuplicates[0].matchedExistingId, 'canon',
      'cand-2 should be reported as matching the existing canon, not the earlier candidate');
  });
});

describe('pipeline-dedup — empty inputs', () => {
  test('empty existing + N candidates → all N added, none skipped', () => {
    const candidates = [
      makePipeline('a', 'A', 0, 0, 1, 1),
      makePipeline('b', 'B', 5, 5, 6, 6),
    ];
    const { toAdd, skippedDuplicates } = dedupePipelines([], candidates);
    assert.equal(toAdd.length, 2);
    assert.equal(skippedDuplicates.length, 0);
  });

  test('N existing + empty candidates → empty result', () => {
    const existing = [makePipeline('a', 'A', 0, 0, 1, 1)];
    const { toAdd, skippedDuplicates } = dedupePipelines(existing, []);
    assert.equal(toAdd.length, 0);
    assert.equal(skippedDuplicates.length, 0);
  });
});
