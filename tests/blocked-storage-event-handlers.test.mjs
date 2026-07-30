import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const eventHandlersSrc = readFileSync(
  resolve(import.meta.dirname, '../src/app/event-handlers.ts'),
  'utf-8',
);
const globeMapSrc = readFileSync(
  resolve(import.meta.dirname, '../src/components/GlobeMap.ts'),
  'utf-8',
);
const panelLayoutSrc = readFileSync(
  resolve(import.meta.dirname, '../src/app/panel-layout.ts'),
  'utf-8',
);

describe('blocked-storage event handlers', () => {
  it('reloads local variant navigation after a guarded storage write', () => {
    assert.match(
      eventHandlersSrc,
      /if \(this\.ctx\.isDesktopApp \|\| options\.isLocalDev\) \{\s*writeStorageValue\('worldmonitor-variant', variant\);\s*window\.location\.reload\(\);/,
    );
  });

  it('reloads layout reset after guarded storage removals', () => {
    const resetLayout = eventHandlersSrc.match(
      /resetLayout: \(\) => \{([\s\S]*?)window\.location\.reload\(\);\s*\},/,
    )?.[1];

    assert.ok(resetLayout, 'resetLayout must reload the page');
    assert.doesNotMatch(resetLayout, /localStorage\./);
    assert.match(resetLayout, /removeStorageValue\(this\.ctx\.PANEL_ORDER_KEY\)/);
    assert.match(resetLayout, /removeStorageValue\('map-height'\)/);
  });

  it('keeps the globe webcam marker control functional without persistence', () => {
    const webcamControl = globeMapSrc.match(
      /\/\/ ── Webcam marker-mode sub-toggle ─+([\s\S]*?)this\.enforceLayerLimit\(\);/,
    )?.[1];

    assert.ok(webcamControl, 'GlobeMap must define the webcam marker-mode control');
    assert.doesNotMatch(webcamControl, /localStorage\./);
    assert.match(webcamControl, /this\.webcamMarkerMode/);
  });

  it('keeps critical posture banner rendering and dismissal functional without session persistence', () => {
    const criticalBanner = panelLayoutSrc.match(
      /renderCriticalBanner\(postures: TheaterPostureSummary\[\]\): void \{([\s\S]*?)\n {2}\}\n\n {2}applyPanelSettings/,
    )?.[1];

    assert.ok(criticalBanner, 'PanelLayout must define the critical posture banner');
    assert.doesNotMatch(criticalBanner, /sessionStorage\./);
    assert.match(criticalBanner, /readSessionStorageValue\('banner-dismissed'\)/);
    assert.match(criticalBanner, /writeSessionStorageValue\('banner-dismissed', Date\.now\(\)\.toString\(\)\)/);
  });
});
