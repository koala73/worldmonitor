import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'src/components/BreakingNewsBanner.ts'), 'utf8');

describe('BreakingNewsBanner interaction semantics', () => {
  it('keeps the alert container non-interactive and exposes a native panel action', () => {
    assert.doesNotMatch(source, /el\.setAttribute\('role',\s*'button'\)/);
    assert.doesNotMatch(source, /el\.setAttribute\('tabindex',\s*'0'\)/);
    assert.match(source, /const viewPanelBtn = document\.createElement\('button'\)/);
    assert.match(source, /viewPanelBtn\.className = 'breaking-alert-view-panel'/);
    assert.match(source, /viewPanelBtn\.setAttribute\('aria-label',\s*t\('components\.breakingNews\.viewPanel'\)\)/);
    assert.match(source, /el\.appendChild\(viewPanelBtn\);\s*el\.appendChild\(dismissBtn\);/);
  });

  it('leaves the headline as a native link and does not also trigger panel scrolling', () => {
    assert.match(source, /const headlineLink = document\.createElement\('a'\)/);
    assert.match(source, /if \(target\.closest\('\.breaking-alert-headline-link'\)\) return;/);
    assert.doesNotMatch(source, /addEventListener\('keydown'/);
  });

  it('keeps dismissal on its own named native button', () => {
    assert.match(source, /const dismissBtn = document\.createElement\('button'\)/);
    assert.match(source, /dismissBtn\.setAttribute\('aria-label',\s*t\('components\.breakingNews\.dismiss'\)\)/);
    assert.match(source, /if \(target\.closest\('\.breaking-alert-dismiss'\)\)/);
  });
});

describe('icon-only controls named in this a11y pass', () => {
  const read = (rel) => readFileSync(resolve(root, rel), 'utf8');

  it('gives previously unnamed icon-only buttons an aria-label', () => {
    assert.match(read('src/app/panel-layout.ts'), /banner-dismiss" aria-label="\$\{t\('common\.dismiss'\)\}"/);
    assert.match(read('src/settings-window.ts'), /settingsWindowClose" aria-label="\$\{escapeHtml\(t\('common\.close'\)\)\}"/);
    assert.match(read('src/components/AviationCommandBar.ts'), /aviation-cmd-close" aria-label="Close"/);
    assert.match(read('src/components/payment-failure-banner.ts'), /pf-dismiss-btn" aria-label="\$\{t\('common\.dismiss'\)\}"/);
    assert.match(read('src/components/ConsumerPricesPanel.ts'), /data-clear-filter aria-label="Clear category filter"/);
    assert.match(read('src/components/AirlineIntelPanel.ts'), /trackClearBtn" class="icon-btn"[^>]*aria-label="Back to live feed"/);
  });

  it('promotes title-only map zoom controls to aria-label', () => {
    const deck = read('src/components/DeckGLMap.ts');
    assert.match(deck, /class="map-btn zoom-in"[^>]*aria-label="\$\{t\('components\.deckgl\.zoomIn'\)\}"/);
    assert.match(deck, /class="map-btn zoom-out"[^>]*aria-label="\$\{t\('components\.deckgl\.zoomOut'\)\}"/);
    assert.match(deck, /class="map-btn zoom-reset"[^>]*aria-label="\$\{t\('components\.deckgl\.resetView'\)\}"/);
    const globe = read('src/components/GlobeMap.ts');
    assert.match(globe, /class="map-btn zoom-in"[^>]*aria-label="Zoom in"/);
    assert.match(globe, /class="map-btn zoom-out"[^>]*aria-label="Zoom out"/);
    assert.match(globe, /class="map-btn zoom-reset"[^>]*aria-label="Reset view"/);
  });
});
