import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { measureResilienceStaticFetch } from '../scripts/seed-resilience-static.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('measureResilienceStaticFetch times the concurrent adapter fan-out', async () => {
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
  assert.match(result.measuredAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('#6562 Resilience-Static timeout cites a dated live measurement, not only a design worst case', () => {
  const bundle = readFileSync(join(root, 'scripts/seed-bundle-resilience.mjs'), 'utf8');
  const staticBlock = bundle.match(
    /\/\/[^\n]*11 dataset adapters[\s\S]*?\{ label: 'Resilience-Static'[^}]+timeoutMs:\s*([\d_]+)/,
  );
  assert.ok(staticBlock, 'Resilience-Static must keep its timeout next to the adapter-fan-out comment');

  const comment = staticBlock[0];
  const timeoutMs = Number(staticBlock[1].replace(/_/g, ''));
  const measured = comment.match(/measured (\d{4}-\d{2}-\d{2})[^\n]*?(\d+(?:\.\d+)?)s/);
  assert.ok(
    measured,
    'the Resilience-Static comment must cite `measured YYYY-MM-DD … Ns` from a real run — '
      + 'a design-worst-case timeout is how #6556 left this member unmeasured',
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

  const seeder = readFileSync(join(root, 'scripts/seed-resilience-static.mjs'), 'utf8');
  assert.match(
    seeder,
    /--measure-fetch-only/,
    'the seeder must keep a --measure-fetch-only path so this timeout can be re-measured',
  );
});
