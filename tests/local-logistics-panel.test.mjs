import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const panelsSrc = readFileSync(resolve(root, 'src/config/panels.ts'), 'utf8');
const panelLayoutSrc = readFileSync(resolve(root, 'src/app/panel-layout.ts'), 'utf8');
const placeBriefsSrc = readFileSync(resolve(root, 'src/services/place-briefs.ts'), 'utf8');
const componentsIndexSrc = readFileSync(resolve(root, 'src/components/index.ts'), 'utf8');
const localLogisticsPanelPath = resolve(root, 'src/components/LocalLogisticsPanel.ts');
const localLogisticsServicePath = resolve(root, 'src/services/local-logistics.ts');
const localLogisticsRoutePath = resolve(root, 'api/local-logistics.js');

const localLogisticsPanelSrc = existsSync(localLogisticsPanelPath)
  ? readFileSync(localLogisticsPanelPath, 'utf8')
  : '';
const localLogisticsServiceSrc = existsSync(localLogisticsServicePath)
  ? readFileSync(localLogisticsServicePath, 'utf8')
  : '';
const localLogisticsRouteSrc = existsSync(localLogisticsRoutePath)
  ? readFileSync(localLogisticsRoutePath, 'utf8')
  : '';

test('registers a local logistics panel in the full variant defaults', () => {
  assert.match(
    panelsSrc,
    /'local-logistics':\s*\{[^}]*name:\s*'Local Logistics'[^}]*enabled:\s*true[^}]*\}/,
  );
});

test('creates a local logistics panel and exports it', () => {
  assert.equal(existsSync(localLogisticsPanelPath), true, 'LocalLogisticsPanel should exist');
  assert.match(localLogisticsPanelSrc, /export class LocalLogisticsPanel extends Panel/);
  assert.match(componentsIndexSrc, /export \* from '\.\/LocalLogisticsPanel';/);
});

test('wires local logistics into panel layout and place focus', () => {
  assert.match(panelLayoutSrc, /new LocalLogisticsPanel\(/);
  assert.match(panelLayoutSrc, /this\.ctx\.panels\['local-logistics'\]\s*=\s*localLogisticsPanel/);
  assert.match(panelLayoutSrc, /localLogisticsPanel\?\.setPlaceId\(placeId\)/);
});

test('service fetches through the local route and uses offline cache', () => {
  assert.equal(existsSync(localLogisticsServicePath), true, 'local logistics service should exist');
  assert.match(localLogisticsServiceSrc, /\/api\/local-logistics/);
  assert.match(localLogisticsServiceSrc, /writeOfflineCacheEntry|withOfflineCache|readOfflineCacheEntry/);
});

test('place briefs fold cached local logistics items into the saved-place brief', () => {
  assert.match(placeBriefsSrc, /buildLocalLogisticsBriefItems|getCachedLocalLogistics/);
});

test('route exists and queries OSM/Overpass with a timeout', () => {
  assert.equal(existsSync(localLogisticsRoutePath), true, 'local logistics route should exist');
  assert.match(localLogisticsRouteSrc, /overpass|openstreetmap/i);
  assert.match(localLogisticsRouteSrc, /AbortController|signal/);
});
