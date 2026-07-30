import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  compareReferenceResults,
  recomputeReferenceManifest,
  type ResilienceReferenceManifest,
} from '../scripts/resilience-reference-recompute.mts';
import { RESILIENCE_SCORE_CACHE_PREFIX } from '../server/worldmonitor/resilience/v1/_shared.ts';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const MANIFEST_PATH = path.join(
  REPO_ROOT,
  'docs',
  'methodology',
  'country-resilience-index',
  'reference-edition',
  '2026',
  'manifest.json',
);

const EXPECTED_COUNTRIES = ['NO', 'US', 'TR', 'YE', 'CH', 'AE', 'IN', 'SY', 'NR', 'ER'];
const EXPECTED_DIMENSIONS = [
  'governanceInstitutional',
  'borderSecurity',
  'fiscalSpace',
  'liquidReserveAdequacy',
  'externalDebtCoverage',
  'sovereignFiscalBuffer',
];
const CAPTURED_SCORE_CACHE_PREFIX = 'resilience:score:v18:';
const CAPTURED_RANKING_CACHE_KEY = 'resilience:ranking:v18';
const CAPTURED_HISTORY_KEY_PREFIX = 'resilience:history:v13:';
const CAPTURED_SCORE_CACHE_SOURCE = `${CAPTURED_SCORE_CACHE_PREFIX}{countryCode}`;
const CAPTURED_RECOMPUTE_SOURCE = 'country-sliced Redis input snapshot recompute';
// v24 includes the v23 score-affecting batch (import-HHI certainty derate #4088,
// outage observed-quiet semantics #4094/P3-8, WTO trade-policy severity #4092/P2-1)
// plus the PR #4101 governance WGI slot-semantics cleanup. The historical-
// manifest drift guard allows the union of fields already proven to drift from
// the frozen v18 reference capture.
const CURRENT_COMBINED_SCORER_CACHE_PREFIX = 'resilience:score:v25:';
const EXPECTED_CURRENT_SCORER_DRIFT_COUNTRIES = new Set(EXPECTED_COUNTRIES);
const EXPECTED_CURRENT_SCORER_DRIFT_FIELDS = new Set([
  'overallScore',
  'domains.infrastructure.score',
  'pillars.live-shock-exposure.score',
  'domains.economic.score',
  'pillars.structural-readiness.score',
]);

function loadManifest(): ResilienceReferenceManifest & {
  scorer?: { scoreCachePrefix?: string; rankingCacheKey?: string; historyKeyPrefix?: string };
  redis?: ResilienceReferenceManifest['redis'] & { keyCount?: number };
  productionScoreCacheAtCapture?: {
    source?: string;
    countries?: Record<string, { overallScore?: unknown; formula?: unknown }>;
  };
  recomputeAtCapture?: {
    source?: string;
  };
} {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

describe('country resilience reference-edition recompute artifact', () => {
  it('commits a non-placeholder pc manifest with captured cache-key provenance metadata', () => {
    const manifest = loadManifest();

    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.referenceEdition, '2026');
    assert.match(manifest.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(manifest.formula, 'pc');
    assert.equal(manifest.scorer?.scoreCachePrefix, CAPTURED_SCORE_CACHE_PREFIX);
    assert.equal(manifest.scorer?.rankingCacheKey, CAPTURED_RANKING_CACHE_KEY);
    assert.equal(manifest.scorer?.historyKeyPrefix, CAPTURED_HISTORY_KEY_PREFIX);
    assert.equal(manifest.productionScoreCacheAtCapture?.source, CAPTURED_SCORE_CACHE_SOURCE);
    assert.equal(manifest.recomputeAtCapture?.source, CAPTURED_RECOMPUTE_SOURCE);
    assert.deepEqual(manifest.sample.countries, EXPECTED_COUNTRIES);
    assert.deepEqual(manifest.sample.dimensions, EXPECTED_DIMENSIONS);
    assert.equal(manifest.published.source, CAPTURED_SCORE_CACHE_SOURCE);
    assert.equal(manifest.redis?.slice?.mode, 'sample-country-slice');
    assert.deepEqual(manifest.redis?.slice?.countryCodes, EXPECTED_COUNTRIES);
    assert.ok((manifest.redis?.slice?.prunedKeys ?? 0) > 0, 'manifest must record pruned source keys');
    assert.ok((manifest.redis?.keyCount ?? 0) >= 50, 'manifest must include the traced Redis input keys');
    assert.ok(Object.keys(manifest.redis.values).length >= 50, 'manifest must include frozen Redis input values');
  });

  it('pins finite published values for every sampled country and dimension', () => {
    const manifest = loadManifest();

    for (const countryCode of EXPECTED_COUNTRIES) {
      const country = manifest.published.countries[countryCode];
      assert.ok(country, `missing published country ${countryCode}`);
      assert.equal(country.countryCode, countryCode);
      assert.equal(country.formula, 'pc');
      assert.ok(Number.isFinite(country.overallScore), `${countryCode}.overallScore must be finite`);

      const cacheObserved = manifest.productionScoreCacheAtCapture?.countries?.[countryCode];
      assert.equal(cacheObserved?.formula, 'pc', `${countryCode} score-cache capture must record formula=pc`);
      assert.ok(Number.isFinite(cacheObserved?.overallScore), `${countryCode} score-cache capture must be finite`);
      assert.equal(cacheObserved?.overallScore, country.overallScore, `${countryCode} published score must be the score-cache capture`);

      for (const dimensionId of EXPECTED_DIMENSIONS) {
        const dimension = country.dimensions[dimensionId];
        assert.ok(dimension, `missing ${countryCode}.${dimensionId}`);
        assert.ok(Number.isFinite(dimension.score), `${countryCode}.${dimensionId}.score must be finite`);
        assert.ok(Number.isFinite(dimension.coverage), `${countryCode}.${dimensionId}.coverage must be finite`);
      }
    }
  });

  it('recomputes the sampled scores from the frozen Redis manifest within tolerance for the captured scorer version', async () => {
    const manifest = loadManifest();
    const computed = await recomputeReferenceManifest(manifest);
    const mismatches = compareReferenceResults(manifest, computed);

    if (manifest.scorer?.scoreCachePrefix === RESILIENCE_SCORE_CACHE_PREFIX) {
      assert.deepEqual(mismatches, []);
      return;
    }

    assert.equal(manifest.scorer?.scoreCachePrefix, CAPTURED_SCORE_CACHE_PREFIX);
    assert.equal(
      RESILIENCE_SCORE_CACHE_PREFIX,
      CURRENT_COMBINED_SCORER_CACHE_PREFIX,
      'historical reference-edition drift guard must be revisited on the next score-cache bump',
    );
    assert.ok(
      mismatches.length > 0,
      'current scorer must no longer silently match the historical v18 capture after the import-HHI derate, outage-feed semantics, and WTO severity methodology changes',
    );
    assert.ok(
      mismatches.every((mismatch) => EXPECTED_CURRENT_SCORER_DRIFT_COUNTRIES.has(mismatch.countryCode)),
      `unexpected countries drifted from the historical reference manifest: ${JSON.stringify(mismatches)}`,
    );
    assert.ok(
      mismatches.every((mismatch) => EXPECTED_CURRENT_SCORER_DRIFT_FIELDS.has(mismatch.field)),
      `unexpected fields drifted from the historical reference manifest: ${JSON.stringify(mismatches)}`,
    );
  });

  it('stores country-sliced source feeds instead of full global feeds', () => {
    const manifest = loadManifest();
    const keys = Object.fromEntries((manifest.redis?.keys ?? []).map((entry) => [entry.key, entry]));

    for (const key of [
      'conflict:ucdp-events:v1',
      'cyber:threats:v2',
      'displacement:summary:v1:2026',
      'intelligence:gpsjam:v2',
      'news:threat:summary:v1',
    ]) {
      const entry = keys[key];
      assert.ok(entry, `missing ${key} metadata`);
      assert.equal(entry.pruned, true, `${key} must be recorded as pruned`);
      assert.ok((entry.sourceByteLength ?? 0) > entry.byteLength, `${key} byte length should shrink after pruning`);
      assert.ok((entry.sourceRecordCount ?? 0) >= (entry.sampleRecordCount ?? 0), `${key} record count should not grow`);
    }

    const ucdp = manifest.redis.values['conflict:ucdp-events:v1'] as { events?: unknown[] };
    const cyber = manifest.redis.values['cyber:threats:v2'] as { threats?: unknown[] };
    const displacement = manifest.redis.values['displacement:summary:v1:2026'] as {
      summary?: { countries?: unknown[]; topFlows?: unknown[] };
    };
    const gps = manifest.redis.values['intelligence:gpsjam:v2'] as { hexes?: unknown[] };
    const threatSummary = manifest.redis.values['news:threat:summary:v1'] as { byCountry?: Record<string, unknown> };

    assert.ok((ucdp.events?.length ?? 0) < (keys['conflict:ucdp-events:v1'].sourceRecordCount ?? 0));
    assert.ok((cyber.threats?.length ?? 0) < (keys['cyber:threats:v2'].sourceRecordCount ?? 0));
    assert.ok((displacement.summary?.countries?.length ?? 0) < (keys['displacement:summary:v1:2026'].sourceRecordCount ?? 0));
    assert.ok((gps.hexes?.length ?? 0) < (keys['intelligence:gpsjam:v2'].sourceRecordCount ?? 0));
    const byCountryKeys = Object.keys(threatSummary.byCountry ?? {});
    assert.ok(byCountryKeys.length > 0, 'news threat slice must retain at least one sampled country');
    assert.ok(
      byCountryKeys.every((countryCode) => EXPECTED_COUNTRIES.includes(countryCode)),
      'news threat slice must not retain non-sampled countries',
    );
  });
});
