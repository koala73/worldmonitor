import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

test('maritime snapshots separate candidate reads and reject degraded payloads from the cache', () => {
  const source = readFileSync(new URL('../src/services/maritime/index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('async function fetchSnapshotPayload');
  const end = source.indexOf('// ---- Callback Emission ----', start);
  const fn = source.slice(start, end);
  assert.match(fn, /cacheKey: includeCandidates \? 'candidates' : 'density'/);
  assert.match(fn, /shouldCache: \(result\) => result\.dataAvailable && result\.snapshot !== undefined/);
});
