import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const panelsSrc = readFileSync(resolve(root, 'src/config/panels.ts'), 'utf8');
const panelLayoutSrc = readFileSync(resolve(root, 'src/app/panel-layout.ts'), 'utf8');
const modeManagerSrc = readFileSync(resolve(root, 'src/services/mode-manager.ts'), 'utf8');
const componentsIndexSrc = readFileSync(resolve(root, 'src/components/index.ts'), 'utf8');
const servicesIndexSrc = readFileSync(resolve(root, 'src/services/index.ts'), 'utf8');
const commsPanelPath = resolve(root, 'src/components/CommsPlanPanel.ts');
const commsServicePath = resolve(root, 'src/services/comms-plan.ts');

const commsPanelSrc = existsSync(commsPanelPath)
  ? readFileSync(commsPanelPath, 'utf8')
  : '';
const commsServiceSrc = existsSync(commsServicePath)
  ? readFileSync(commsServicePath, 'utf8')
  : '';

test('registers a tactical comms panel in the full variant defaults and category map', () => {
  assert.match(
    panelsSrc,
    /'comms-plan':\s*\{[^}]*name:\s*'Tactical Comms'[^}]*enabled:\s*true[^}]*\}/,
  );
  assert.match(
    panelsSrc,
    /panelKeys:\s*\[[^\]]*'comms-plan'/,
  );
});

test('creates and exports the comms panel and service', () => {
  assert.equal(existsSync(commsPanelPath), true, 'CommsPlanPanel should exist');
  assert.equal(existsSync(commsServicePath), true, 'comms-plan service should exist');
  assert.match(commsPanelSrc, /export class CommsPlanPanel extends Panel/);
  assert.match(componentsIndexSrc, /export \* from '\.\/CommsPlanPanel';/);
  assert.match(servicesIndexSrc, /export \* from '\.\/comms-plan';/);
});

test('wires the comms panel into panel layout and saved-place focus', () => {
  assert.match(panelLayoutSrc, /new CommsPlanPanel\(/);
  assert.match(panelLayoutSrc, /this\.ctx\.panels\['comms-plan'\]\s*=\s*commsPlanPanel/);
  assert.match(panelLayoutSrc, /commsPlanPanel\?\.setPlaceId\(placeId\)/);
});

test('mode-manager builds a place-aware family check-in from the comms plan service', () => {
  assert.match(commsServiceSrc, /buildPrimaryCommsMessage|buildCommsMessage/);
  assert.match(modeManagerSrc, /buildPrimaryCommsMessage|buildCommsMessage/);
  assert.doesNotMatch(modeManagerSrc, /WORLD MONITOR — SAFETY ALERT/);
});
