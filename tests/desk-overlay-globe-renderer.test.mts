import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const readSrc = (path: string) => readFileSync(resolve(root, path), 'utf-8');

describe('Desk Overlay globe renderer', () => {
  const src = readSrc('src/components/GlobeMap.ts');

  it('loads only the public validated Desk Overlay and retains it as a distinct marker kind', () => {
    assert.match(src, /import \{[^}]*loadDeskOverlay[^}]*\} from '@\/services\/desk-overlay';/);
    assert.match(src, /interface DeskOverlayMarker extends BaseMarker[\s\S]*_kind: 'deskOverlay'/);
    assert.match(src, /this\.deskOverlayMarkers/);
    assert.match(src, /void this\.loadDeskOverlay\(\)/);
  });

  it('opens a dedicated context-only Desk drawer from an overlay pin instead of treating it as a trade action', () => {
    assert.match(src, /private openDeskOverlayDrawer\(caseFile: DeskOverlayCaseFile\)/);
    assert.match(src, /주문·승인 신호 아님/);
    assert.match(src, /this\.deskOverlayDrawerEl/);
    assert.match(src, /d\._kind === 'deskOverlay'/);
  });

  it('keeps public artifact failure non-fatal and never invents a point for global-only rows', () => {
    assert.match(src, /loadDeskOverlay\(\)[\s\S]*\.catch\(\(\) =>/);
    assert.match(src, /\.filter\(\(caseFile\) => caseFile\.mapLocation\)/);
  });

  it('opens a validated Desk deep link directly in globe mode and focuses the requested case', () => {
    const mapContainer = readSrc('src/components/MapContainer.ts');

    assert.match(mapContainer, /parseDeskOverlayCaseId\(window\.location\.search\)/);
    assert.match(mapContainer, /preferGlobe \|\| parseDeskOverlayCaseId\(window\.location\.search\)/);
    assert.match(src, /this\.deskOverlayRequestedCaseId/);
    assert.match(src, /this\.openDeskOverlayDrawer\(requestedCase\)/);
    assert.match(src, /this\.globe\.pointOfView\(/);
  });
});
