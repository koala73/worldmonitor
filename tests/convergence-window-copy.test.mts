import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('source-convergence copy matches its one-hour filter window', async () => {
  const source = await readFile(new URL('../src/services/analysis-core.ts', import.meta.url), 'utf8');
  assert.match(source, /const WINDOW_MS = 60 \* 60 \* 1000;/);
  assert.match(source, /sources in 60m/);
  assert.doesNotMatch(source, /sources in 30m/);
});
