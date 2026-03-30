import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const commsPanelPath = resolve(root, 'src/components/CommsPlanPanel.ts');
const commsDirectoryPath = resolve(root, 'src/services/comms-directory.ts');
const commsExportPath = resolve(root, 'src/services/comms-export.ts');
const exportUtilsSrc = readFileSync(resolve(root, 'src/utils/export.ts'), 'utf8');

const commsPanelSrc = existsSync(commsPanelPath)
  ? readFileSync(commsPanelPath, 'utf8')
  : '';
const commsDirectorySrc = existsSync(commsDirectoryPath)
  ? readFileSync(commsDirectoryPath, 'utf8')
  : '';
const commsExportSrc = existsSync(commsExportPath)
  ? readFileSync(commsExportPath, 'utf8')
  : '';

test('creates comms directory and export services', () => {
  assert.equal(existsSync(commsDirectoryPath), true, 'comms-directory service should exist');
  assert.equal(existsSync(commsExportPath), true, 'comms-export service should exist');
  assert.match(commsDirectorySrc, /export function getCommsDirectoryLinks/);
  assert.match(commsExportSrc, /export function buildCommsFieldCard/);
});

test('comms panel exposes export actions and curated external references', () => {
  assert.match(commsPanelSrc, /data-comms-export/);
  assert.match(commsPanelSrc, /getCommsDirectoryLinks/);
  assert.match(commsPanelSrc, /References|Field Card|Export JSON|Export CSV/);
});

test('export utils expose dedicated comms field-card download helpers', () => {
  assert.match(exportUtilsSrc, /export function exportCommsPlanJSON/);
  assert.match(exportUtilsSrc, /export function exportCommsPlanCSV/);
});
