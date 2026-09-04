/**
 * #7112 — every layer the SVG overlay marker budget can trim needs somewhere to
 * say so.
 *
 * `updateLayerTruncationLabels` writes a `shown/total` badge onto
 * `.layer-toggle-row[data-layer="<key>"]`. `createLayerToggles` builds those rows
 * from a per-variant list, while `planOverlayMarkerBudget` budgets from the layer
 * STATE. The two are unrelated code, so a layer can be switched on by a variant's
 * default map layers, be budgeted, be trimmed — and have no row to disclose the
 * cut on. Silent withholding on a monitoring product is indistinguishable from
 * missing data, and the trimmed layer still spends fair share out of the global
 * total, tightening the cap on the layers that DO disclose.
 *
 * #7144 closed the live case: commodity now has its own `commodityLayers` picker
 * list, so `fires` / `minerals` / `commodityHubs` (all default-on in
 * COMMODITY_MAP_LAYERS, none of them in `fullLayers`) get rows the badge can
 * write onto. This pins the relationship for every variant so the next gap
 * fails here instead of in production.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const mapSrc = read('../src/components/Map.ts');
const panelsSrc = read('../src/config/panels.ts');

function sliceBetween(src, start, end) {
  const startIdx = src.indexOf(start);
  assert.ok(startIdx >= 0, `anchor not found: ${start}`);
  const endIdx = src.indexOf(end, startIdx + 1);
  assert.ok(endIdx > startIdx, `end anchor not found after start: ${end}`);
  return src.slice(startIdx, endIdx);
}

/**
 * Accepted disclosure gaps. Each is a UI gap worth closing (give the layer a
 * row), not a property worth keeping — shrinking this map is progress. They stay
 * budgeted because the DOM ceiling is the point of #7112 and none of these feeds
 * is bounded upstream (`toMapFires` caps nothing), and their cut is reported via
 * `getOverlayMarkerBudgetState().undisclosed` rather than vanishing.
 *
 * Empty after #7144: commodity now has `commodityLayers`. Keep the map so the
 * stale-entry arm still exercises, and so the next gap has a place.
 */
const DECLARED_GAPS = new Map();

/** Variant -> the createLayerToggles list it actually uses. */
const VARIANT_PICKER_LIST = {
  full: 'fullLayers',
  tech: 'techLayers',
  finance: 'financeLayers',
  happy: 'happyLayers',
  energy: 'energyLayers',
  commodity: 'commodityLayers',
};

/** Variant -> the panels.ts default map-layer state it boots with. */
const VARIANT_LAYER_STATE = {
  full: 'FULL_MAP_LAYERS',
  tech: 'TECH_MAP_LAYERS',
  finance: 'FINANCE_MAP_LAYERS',
  happy: 'HAPPY_MAP_LAYERS',
  energy: 'ENERGY_MAP_LAYERS',
  commodity: 'COMMODITY_MAP_LAYERS',
};

const planBlock = sliceBetween(
  mapSrc,
  'private planOverlayMarkerBudget(',
  'private getOverlayBudgetCentre(',
);
const togglesBlock = sliceBetween(
  mapSrc,
  'private createLayerToggles(): HTMLElement {',
  'private clearLayerExplanationOutsideClickHandler(',
);

/** Layer keys the budget plan can produce a truncation entry for. */
function plannedLayers() {
  const layers = new Set();
  for (const match of planBlock.matchAll(/add\(\s*'([A-Za-z]+)'[^;]*/g)) {
    // `exempt: true` groups sit outside the budget entirely, so they can never
    // appear in the truncation record and need no row.
    if (/exempt:\s*true/.test(match[0])) continue;
    layers.add(match[1]);
  }
  return layers;
}

/** Layer keys one named picker list declares. */
function pickerLayersFor(listName) {
  const marker = `const ${listName}: (keyof MapLayers)[] = [`;
  const body = sliceBetween(togglesBlock, marker, '];').slice(marker.length);
  const layers = new Set();
  // Strip line comments first: several carry prose containing apostrophes.
  for (const [, key] of body.replace(/\/\/[^\n]*/g, '').matchAll(/'([A-Za-z]+)'/g)) layers.add(key);
  return layers;
}

/** Layer keys a variant's default state switches ON at boot. */
function defaultOnLayersFor(stateName) {
  const body = sliceBetween(panelsSrc, `const ${stateName}: MapLayers = {`, '\n};');
  const layers = new Set();
  for (const [, key] of body.matchAll(/^\s*([A-Za-z]+):\s*true\b/gm)) layers.add(key);
  return layers;
}

describe('SVG overlay marker budget disclosure (#7112)', () => {
  it('parses the plan, every picker list and every layer-state map', () => {
    // Vacuity guard: each of the three sources must be non-trivially populated,
    // or the real checks below pass by finding nothing.
    const planned = plannedLayers();
    assert.ok(planned.size > 20, `plan parsed as ${planned.size} layers`);
    for (const list of new Set(Object.values(VARIANT_PICKER_LIST))) {
      assert.ok(pickerLayersFor(list).size > 3, `${list} parsed as near-empty`);
    }
    for (const state of Object.values(VARIANT_LAYER_STATE)) {
      assert.ok(defaultOnLayersFor(state).size > 3, `${state} parsed as near-empty`);
    }
    // Positive controls: budgeted, default-on and rowed in the full variant, so a
    // regex that silently stopped matching fails here first.
    for (const layer of ['natural', 'weather', 'economic']) {
      assert.ok(planned.has(layer), `${layer} must be budgeted`);
      assert.ok(defaultOnLayersFor('FULL_MAP_LAYERS').has(layer), `${layer} must default on`);
      assert.ok(pickerLayersFor('fullLayers').has(layer), `${layer} must have a row`);
    }
    // Negative control: exempt groups must not count as budgeted.
    assert.ok(!planned.has('techHubs') && !planned.has('geoHubs'));
  });

  it('gives every budgeted, default-on layer a row to disclose its cut on', () => {
    const planned = plannedLayers();
    const undeclared = [];
    for (const [variant, stateName] of Object.entries(VARIANT_LAYER_STATE)) {
      const rows = pickerLayersFor(VARIANT_PICKER_LIST[variant]);
      for (const layer of defaultOnLayersFor(stateName)) {
        if (!planned.has(layer) || rows.has(layer)) continue;
        if (DECLARED_GAPS.has(`${variant}:${layer}`)) continue;
        undeclared.push(`${variant}:${layer}`);
      }
    }
    assert.deepEqual(
      undeclared,
      [],
      'budgeted and on by default with no toggle row to disclose a cut. Give it a ' +
        'row, mark the group exempt, or add it to DECLARED_GAPS with a reason: ' +
        undeclared.join(', '),
    );
  });

  it('keeps DECLARED_GAPS honest — no stale entries', () => {
    const planned = plannedLayers();
    const stale = [];
    for (const key of DECLARED_GAPS.keys()) {
      const [variant, layer] = key.split(':');
      const stateName = VARIANT_LAYER_STATE[variant];
      assert.ok(stateName, `DECLARED_GAPS names an unknown variant: ${variant}`);
      const stillGapped =
        planned.has(layer) &&
        defaultOnLayersFor(stateName).has(layer) &&
        !pickerLayersFor(VARIANT_PICKER_LIST[variant]).has(layer);
      if (!stillGapped) stale.push(key);
    }
    assert.deepEqual(stale, [], `no longer a gap — drop from DECLARED_GAPS: ${stale.join(', ')}`);
  });

  it('routes undisclosed truncation into the public budget state rather than dropping it', () => {
    // The mechanism the assertions above assume: without this the set would be
    // computed and thrown away, and `undisclosed` would always read empty.
    assert.match(
      mapSrc,
      /this\.overlayUndisclosedTruncation = undisclosed;/,
      'updateLayerTruncationLabels must record what it could not disclose',
    );
    assert.match(
      mapSrc,
      /undisclosed: this\.overlayUndisclosedTruncation,/,
      'getOverlayMarkerBudgetState must expose it',
    );
  });

  it('gives commodity toggle rows for fires/minerals/commodityHubs so a shown/total badge can render (#7144)', () => {
    // The live gap: COMMODITY_MAP_LAYERS turns these on, fullLayers lists none
    // of them, and without a commodityLayers list the ternary fell through.
    const defaultOn = defaultOnLayersFor('COMMODITY_MAP_LAYERS');
    const rows = pickerLayersFor('commodityLayers');
    const planned = plannedLayers();
    for (const layer of ['fires', 'minerals', 'commodityHubs']) {
      assert.ok(defaultOn.has(layer), `${layer} must stay default-on for commodity`);
      assert.ok(planned.has(layer), `${layer} must stay budgeted`);
      assert.ok(rows.has(layer), `commodityLayers must include ${layer}`);
    }
    assert.match(
      togglesBlock,
      /SITE_VARIANT === 'commodity' \? commodityLayers/,
      'createLayerToggles must select commodityLayers, not fall through to fullLayers',
    );

    // The badge writer keys off `.layer-toggle-row[data-layer="<key>"]`. Both
    // halves of that contract have to hold or a row exists and still cannot
    // carry shown/total.
    assert.match(togglesBlock, /row\.className = 'layer-toggle-row'/);
    assert.match(togglesBlock, /row\.dataset\.layer = layer/);
    const badgeSrc = read('../src/utils/layer-truncation-badge.ts');
    assert.match(badgeSrc, /root\.querySelectorAll<HTMLElement>\('\.layer-toggle-row'\)/);
    assert.match(badgeSrc, /row\.dataset\.layer/);
    assert.match(badgeSrc, /badge\.textContent = `\$\{counts\.shown\}\/\$\{counts\.total\}`/);
  });
});
