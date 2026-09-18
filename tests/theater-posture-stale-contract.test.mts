import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('theater posture marks retained data stale and refreshes it', async () => {
  const service = await readFile(new URL('../src/services/cached-theater-posture.ts', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../src/components/StrategicPosturePanel.ts', import.meta.url), 'utf8');
  assert.match(service, /stale: Date\.now\(\) - savedAt >= BREAKER_TTL_MS/);
  assert.match(service, /forceRefresh, staleRefreshMode: forceRefresh \? 'await' : 'background'/);
  assert.match(panel, /if \(this\.isStale && !forceRefresh\)/);
  assert.match(panel, /void this\.fetchAndRender\(true\)/);
});
