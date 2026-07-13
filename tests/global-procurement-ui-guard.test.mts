import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const panel = readFileSync(resolve(import.meta.dirname, '../src/components/EconomicPanel.ts'), 'utf8');
const loader = readFileSync(resolve(import.meta.dirname, '../src/app/data-loader.ts'), 'utf8');

test('procurement cards sanitize upstream URLs and preserve safe-link attributes', () => {
  assert.match(panel, /const safeUrl = sanitizeUrl\(tender\.officialUrl\)/);
  assert.match(panel, /href="\$\{safeUrl\}" target="_blank" rel="noopener noreferrer nofollow"/);
  assert.match(panel, /Technology relevance:/);
  assert.match(panel, /CLOSING SOON/);
});

test('procurement loading reports an explicit partial or unavailable state to StatusPanel', () => {
  assert.match(loader, /updateApi\('Global Procurement'/);
  assert.match(loader, /data\.availability === 'partial' \? 'warning' : 'ok'/);
  assert.match(loader, /availability: 'unavailable'/);
});
