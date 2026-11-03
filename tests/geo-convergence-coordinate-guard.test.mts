import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { usableCoord } from '../shared/analysis-adapter-guards.ts';

test('coordinate guard rejects missing, invalid, and Null Island positions', () => {
  assert.equal(usableCoord(null, null), false);
  assert.equal(usableCoord(0, 0), false);
  assert.equal(usableCoord(91, 0), false);
  assert.equal(usableCoord(25, 55), true);
});

test('earthquake ingestion uses the shared coordinate guard', async () => {
  const source = await readFile(new URL('../src/services/geo-convergence.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(!usableCoord\(lat, lon\) \|\| lon === null\) continue;/);
});
