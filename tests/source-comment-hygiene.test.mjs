import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = (path) => readFileSync(join(ROOT, path), 'utf8');

test('obsolete ESLint suppressions do not return', () => {
  assert.doesNotMatch(
    source('src/types/globe-gl.d.ts'),
    /eslint-disable-next-line @typescript-eslint\/no-explicit-any\s+export interface GlobeInstance/,
  );
  assert.doesNotMatch(
    source('src/components/CountryDeepDivePanel.ts'),
    /eslint-disable-next-line @typescript-eslint\/no-require-imports\s+import\('@\/shared\/pipeline-registry-store'\)/,
  );
});

test('source comments do not repeat retired claims or hand-maintained totals', () => {
  assert.doesNotMatch(
    source('tests/seed-ttl-outlives-staleness-fleet.test.mjs'),
    /The REAL defect is underneath and is tracked separately/,
  );
  assert.doesNotMatch(
    source('scripts/enforce-panel-content-writes.mjs'),
    /\d+ entries \/ \d+ call sites across \d+ files/,
  );
  assert.doesNotMatch(
    source('server/worldmonitor/intelligence/v1/get-risk-scores.ts'),
    /military activity, gathered, not yet scored/,
  );
  assert.doesNotMatch(
    source('src/components/Map.ts'),
    /SVG fallback: news locations rendered as simple circles/,
  );
});
