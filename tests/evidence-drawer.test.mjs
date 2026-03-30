import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

test('evidence drawer component exists with support and conflict sections', () => {
  const source = read('src/components/EvidenceDrawer.ts');

  assert.match(source, /export class EvidenceDrawer/, 'evidence drawer should be a reusable component');
  assert.match(source, /supportingSources/, 'drawer should render supporting sources');
  assert.match(source, /conflictingSources/, 'drawer should render conflicting sources');
  assert.match(source, /Why we believe this/, 'drawer should present an explicit trust affordance');
});

test('alert center exposes a Why affordance wired to evidence', () => {
  const source = read('src/components/AlertCenterPanel.ts');

  assert.match(source, /new EvidenceDrawer\(/, 'alert center should own an evidence drawer instance');
  assert.match(source, /ac-why-btn/, 'alert center should render a why button');
  assert.match(source, /data-alert-id/, 'alert center should keep per-row identity for evidence lookup');
  assert.match(source, /detail\.evidence|entry\.evidence|a\.evidence/, 'alert center should carry evidence with each alert entry');
});

test('news panel exposes cluster evidence through the drawer', () => {
  const source = read('src/components/NewsPanel.ts');

  assert.match(source, /new EvidenceDrawer\(/, 'news panel should own an evidence drawer instance');
  assert.match(source, /cluster-why-btn/, 'cluster cards should render a why button');
  assert.match(source, /cluster\.evidence/, 'cluster cards should read structured evidence');
  assert.match(source, /Why we believe this/, 'cluster cards should expose the same evidence language as alert center');
});

test('components index exports the evidence drawer', () => {
  const source = read('src/components/index.ts');
  assert.match(source, /export \* from '\.\/EvidenceDrawer';/, 'components index should export the evidence drawer');
});
