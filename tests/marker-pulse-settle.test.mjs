import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const css = readFileSync(resolve(repoRoot, 'src/styles/main.css'), 'utf8');
const mapSrc = readFileSync(resolve(repoRoot, 'src/components/Map.ts'), 'utf8');

// #4669: every map-scoped infinite pulse must stop once the map settles, so the
// per-marker compositing layers are released (385 of 517 desktop layers were
// held by these animations; Layerize scaled with the count). Markers still
// pulse on appearance — MapComponent re-arms the settle window per render.
const SETTLED_SELECTORS = [
  '.hotspot-marker.high',
  '.hotspot-breaking',
  '.breaking-tag',
  '.cable-path.cable-health-fault',
  '.cable-advisory-marker.fault',
  '.protest-marker.high',
  '.outage-marker.total',
  '.conflict-zone',
  '.iran-event-marker',
  '.earthquake-marker',
  '.nuclear-marker.active',
  '.nuclear-marker.contested',
  '.weather-marker.extreme .weather-icon',
  '.flight-delay-marker.major',
  '.flight-delay-marker.severe',
  '.military-vessel-marker.dark-vessel',
  '.military-vessel-marker.interesting',
  '.dark-vessel-indicator',
  '.tech-event-marker.upcoming-soon::after',
];

// Map-scoped infinite animations that intentionally KEEP running after settle.
const SETTLE_EXEMPT = [
  '.cable-path:hover', // interaction-bounded: animates only while hovered
  '.cable-path.asset-highlight', // user-intent single-asset highlight (#4538: don't demote genuine animation)
  '.pipeline-path.asset-highlight',
  '.asset-highlight',
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Scan main.css: selector of every rule whose block declares an infinite animation.
function infiniteAnimationSelectors() {
  const selectors = [];
  let current = '';
  for (const line of css.split('\n')) {
    if (/^[^\s@}].*\{/.test(line)) {
      current = line.replace(/\s*\{.*$/, '').trim();
    }
    if (/animation:[^;]*\binfinite\b/.test(line)) {
      selectors.push(current);
    }
  }
  return selectors;
}

describe('marker pulse settle (#4669)', () => {
  it('main.css settles every listed marker pulse under .markers-settled', () => {
    for (const sel of SETTLED_SELECTORS) {
      const settled = new RegExp(`\\.markers-settled ${escapeRegExp(sel)}`);
      assert.match(
        css,
        settled,
        `expected a ".markers-settled ${sel}" rule in src/styles/main.css — ` +
          'every marker pulse must be released after the settle window',
      );
    }
    const block = css.match(/\.markers-settled [^{]+\{([^}]+)\}/);
    assert.ok(block, 'expected the .markers-settled rule block to exist');
    assert.match(block[1], /animation:\s*none/, 'the settle block must set animation: none');
  });

  it('every map-scoped infinite pulse in main.css is either settled or exempt', () => {
    const mapScoped = infiniteAnimationSelectors().filter((sel) =>
      /marker|hotspot|conflict-zone|breaking-tag|dark-vessel|cable-path/i.test(sel),
    );
    assert.ok(mapScoped.length >= SETTLED_SELECTORS.length - 2, 'scan should find the marker pulses');
    for (const sel of mapScoped) {
      const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
      for (const part of parts) {
        const covered =
          SETTLED_SELECTORS.includes(part) ||
          SETTLE_EXEMPT.some((ex) => part === ex || part.endsWith(ex));
        assert.ok(
          covered,
          `"${part}" declares an infinite animation but is neither in SETTLED_SELECTORS nor ` +
            'SETTLE_EXEMPT — a new marker pulse must be added to the .markers-settled block ' +
            '(and this test) or explicitly exempted with a reason (#4669)',
        );
      }
    }
  });

  it('MapComponent arms the settle window on overlay renders', () => {
    assert.match(mapSrc, /MARKER_SETTLE_MS/, 'Map.ts must define MARKER_SETTLE_MS');
    assert.match(
      mapSrc,
      /classList\.remove\('markers-settled'\)/,
      'renders must clear the settled state so fresh markers pulse',
    );
    assert.match(
      mapSrc,
      /classList\.add\('markers-settled'\)/,
      'the settle timer must add the settled class',
    );
    assert.match(
      mapSrc,
      /armMarkerSettle\(\)/,
      'renderOverlays must arm the marker settle window',
    );
  });
});
