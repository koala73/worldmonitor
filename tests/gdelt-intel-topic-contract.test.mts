import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('GDELT topic requests use seeded identifiers', async () => {
  const source = await readFile(new URL('../src/services/gdelt-intel.ts', import.meta.url), 'utf8');
  assert.match(source, /fetchGdeltArticles\(topic\.id, 10, '24h'\)/);
  assert.match(source, /id: '(military|cyber|nuclear|sanctions|intelligence|maritime)'/);
});

test('hotspots map to supported seeded topics', async () => {
  const source = await readFile(new URL('../src/services/gdelt-intel.ts', import.meta.url), 'utf8');
  assert.match(source, /return fetchGdeltArticles\(selectHotspotTopicId\(hotspot\), 8, '48h'\)/);
  assert.match(source, /return 'maritime';/);
  assert.match(source, /return 'military';/);
});
