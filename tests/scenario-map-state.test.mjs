import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { GeoJsonLayer } from '@deck.gl/layers';
import { diffProps } from '../node_modules/@deck.gl/core/dist/lifecycle/props.js';

// Execute the production methods without constructing the browser/WebGL shell.
function method(file, name, bindings = {}) {
  const source = readFileSync(new URL(`../src/components/${file}.ts`, import.meta.url), 'utf8');
  const match = source.match(new RegExp(`  (?:public|private) ${name}\\([\\s\\S]*?\\n  }`));
  assert.ok(match, `${file}.${name} exists`);
  const code = ts.transpile(`class Subject { ${match[0]} }`, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(bindings), `${code}; return Subject.prototype.${name};`)(...Object.values(bindings));
}
const activate = method('MapContainer', 'activateScenario', {
  hasPremiumAccess: () => true, getAuthState: () => ({}), trackGateHit: () => {},
});
const heat = method('DeckGLMap', 'createScenarioHeatLayer', { GeoJsonLayer });
const signature = method('DeckGLMap', 'getSetSignature');
const result = (severity, countries) => ({
  affectedChokepointIds: ['hormuz_strait'],
  template: { disruptionPct: severity },
  topImpactCountries: countries.map(([iso2, totalImpact]) => ({ iso2, totalImpact, impactPct: totalImpact ? 100 : 0 })),
});
function activateResult(value) {
  const context = { applyScenarioState(state) { this.applied = state; }, supplyChainPanel: { showScenarioSummary(_id, result) { this.result = result; } } };
  activate.call(context, 'same-template', value);
  assert.equal(context.supplyChainPanel.result, value, 'coverage and export result remain intact');
  return context.applied;
}
test('zero evidence remains in the result but does not paint countries or physical routes', () => {
  const value = result(0, [['DE', 0], ['JP', 0]]);
  assert.deepEqual(activateResult(value), { scenarioId: 'same-template', disruptedChokepointIds: [], affectedIso2s: [] });
  assert.equal(value.topImpactCountries.length, 2);
  assert.deepEqual(activateResult(result(50, [['DE', 42], ['JP', 0]])).affectedIso2s, ['DE']);
});
test('tariff impacts and legacy results preserve their visual contract', () => {
  const tariff = { ...result(0, [['DE', 20]]), affectedChokepointIds: [] };
  assert.deepEqual(activateResult(tariff).affectedIso2s, ['DE']);
  const legacy = result(50, [['DE', 20]]); delete legacy.template;
  assert.deepEqual(activateResult(legacy).disruptedChokepointIds, ['hormuz_strait']);
});
test('same-template country changes invalidate real DeckGL fill attributes with cached data', () => {
  const data = { type: 'FeatureCollection', features: [] };
  const layer = (country) => heat.call({
    affectedIso2Set: new Set(country ? [country] : []), countriesGeoJsonData: data,
    getCulledCountriesGeoJson: () => data, getSetSignature: signature,
    scenarioState: { scenarioId: 'same-template' },
  });
  const before = layer('DE'); const after = layer('JP');
  assert.equal(after.props.data, before.props.data);
  assert.deepEqual(diffProps(after.props, before.props).updateTriggersChanged, { getFillColor: true });
  assert.equal(diffProps(layer('JP').props, after.props).updateTriggersChanged, false);
  assert.deepEqual(after.props.getFillColor({ properties: { 'ISO3166-1-Alpha-2': 'DE' } }), [0, 0, 0, 0]);
  assert.deepEqual(after.props.getFillColor({ properties: { 'ISO3166-1-Alpha-2': 'JP' } }), [220, 60, 40, 80]);
  assert.equal(layer(null), null);
});
