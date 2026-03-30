import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const panelsSrc = readFileSync(resolve(root, 'src/config/panels.ts'), 'utf8');
const panelLayoutSrc = readFileSync(resolve(root, 'src/app/panel-layout.ts'), 'utf8');
const searchManagerSrc = readFileSync(resolve(root, 'src/app/search-manager.ts'), 'utf8');
const searchModalSrc = readFileSync(resolve(root, 'src/components/SearchModal.ts'), 'utf8');
const savedPlacesPanelPath = resolve(root, 'src/components/SavedPlacesPanel.ts');
const savedPlacesPanelSrc = existsSync(savedPlacesPanelPath)
  ? readFileSync(savedPlacesPanelPath, 'utf8')
  : '';

describe('saved places panel wiring', () => {
  it('registers the saved places panel in the full variant defaults', () => {
    assert.match(
      panelsSrc,
      /'saved-places':\s*\{[^}]*name:\s*'Saved Places'[^}]*enabled:\s*true[^}]*\}/,
      'full variant should expose the saved places panel',
    );
  });

  it('creates a dedicated SavedPlacesPanel component', () => {
    assert.equal(existsSync(savedPlacesPanelPath), true, 'SavedPlacesPanel should exist');
    assert.match(
      savedPlacesPanelSrc,
      /export class SavedPlacesPanel extends Panel/,
      'saved places panel should extend the base Panel class',
    );
  });

  it('instantiates the saved places panel and wires map focus in panel layout', () => {
    assert.match(
      panelLayoutSrc,
      /new SavedPlacesPanel\(/,
      'panel layout should create the saved places panel',
    );
    assert.match(
      panelLayoutSrc,
      /this\.ctx\.panels\['saved-places'\]\s*=\s*savedPlacesPanel/,
      'panel layout should register the saved places panel',
    );
    assert.match(
      panelLayoutSrc,
      /setCenter\(place\.lat,\s*place\.lon,\s*6\)/,
      'saved place focus should center the map on the saved place',
    );
    assert.match(
      panelLayoutSrc,
      /flashLocation\(place\.lat,\s*place\.lon,\s*3000\)/,
      'saved place focus should flash the selected saved place',
    );
  });

  it('indexes saved places in search and handles place selection', () => {
    assert.match(
      searchModalSrc,
      /'place'/,
      'search modal should allow place results',
    );
    assert.match(
      searchManagerSrc,
      /registerSource\('place'/,
      'search manager should register saved places as a search source',
    );
    assert.match(
      searchManagerSrc,
      /case 'place':/,
      'search manager should handle saved place search selections',
    );
  });
});
