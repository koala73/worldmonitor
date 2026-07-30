import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { __testing__ } from '../api/health.js';
import { TEMPORAL_ANOMALIES_TTL } from '../server/worldmonitor/infrastructure/v1/_shared.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

describe('temporal anomalies cache freshness', () => {
  it('keeps the data TTL beyond the strict health stale budget', () => {
    const maxStaleMin = __testing__.SEED_META.temporalAnomalies.maxStaleMin;

    assert.equal(TEMPORAL_ANOMALIES_TTL, 3600);
    assert.ok(TEMPORAL_ANOMALIES_TTL / 60 > maxStaleMin);
  });

  it('refreshes the data key and seed-meta on fresh cache hits', () => {
    const src = readFileSync(
      resolve(ROOT, 'server/worldmonitor/infrastructure/v1/list-temporal-anomalies.ts'),
      'utf8',
    );

    assert.match(src, /async function refreshTemporalAnomaliesCacheHit/);
    assert.match(src, /setCachedJson\(TEMPORAL_ANOMALIES_KEY, snapshot, TEMPORAL_ANOMALIES_TTL\)/);
    assert.match(src, /writeTemporalAnomaliesSeedMeta\(snapshot\)/);
    assert.match(src, /await refreshTemporalAnomaliesCacheHit\(cached\)/);
  });
});
