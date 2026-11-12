import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { getMilitaryBaseColor } from '../src/config/military-base-colors.ts';

// Execute the real builders without starting MapLibre, like the fallback harness.
const source = ts.createSourceFile('DeckGLMap.ts', readFileSync(new URL('../src/components/DeckGLMap.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'DeckGLMap') as ts.ClassDeclaration;
const methods = ['createBasesClusterLayer', 'createMilitaryVesselClustersLayer', 'createMilitaryFlightClustersLayer', 'createProtestClusterLayers'];
const body = declaration.members.filter(node => methods.includes(node.name?.getText(source) ?? '')).map(node => node.getText(source)).join('\n');
const javascript = ts.transpileModule(`class Harness { ${body} }`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
// Extracted methods can use only `this` and the module symbols injected below.
// Add any new module-level dependency to this list when a builder starts using it.
const Harness = new Function('ScatterplotLayer', 'TextLayer', 'getMilitaryBaseColor', `${javascript}; return Harness;`)(ScatterplotLayer, TextLayer, getMilitaryBaseColor);

test('base clusters leave more map visible while retaining counts and picking', () => {
  const map = new Harness();
  map.serverBaseClusters = [{longitude:121,latitude:24,count:100,dominantType:'army'}];
  for (const zoom of [3, 5, 8]) {
    map.maplibreMap = {getZoom:()=>zoom};
    const [circle, count] = map.createBasesClusterLayer();
    assert.equal(circle.props.pickable, true);
    assert.ok(circle.props.radiusMaxPixels <= 24);
    assert.ok(circle.props.getFillColor(map.serverBaseClusters[0])[3] <= 130);
    assert.equal(count.props.getText(map.serverBaseClusters[0]), '100');
    assert.equal(count.props.getColor[3], 220, 'count text stays legible');
  }
});

test('event cluster fills retain severity colors and relative alpha, and remain pickable', () => {
  const map = new Harness();
  map.protestClusters=[];
  map.updateClusterData=()=>{};
  map.createEmptyGhost=()=>null;
  const protest = map.createProtestClusterLayers()[0];
  const colors = [{hasRiot:true}, {maxSeverity:'high'}, {maxSeverity:'medium'}, {maxSeverity:'low'}].map(d=>protest.props.getFillColor(d));
  assert.deepEqual(colors.map(c=>c.slice(0,3)), [[220,40,40],[255,80,60],[255,160,40],[255,220,80]]);
  assert.ok(colors.every(c=>c[3]<=150));
  assert.ok(colors.every((c,i)=>i===0 || c[3]<colors[i-1][3]));
  assert.equal(protest.props.pickable,true);
  for (const [builder, activities] of [
    ['createMilitaryVesselClustersLayer', ['exercise', 'deployment', 'transit', 'unknown']],
    ['createMilitaryFlightClustersLayer', ['exercise', 'patrol', 'transport', 'unknown']],
  ] as const) {
    const layer=map[builder]([]);
    assert.equal(layer.props.pickable,true);
    const alphas = activities.map(activityType => layer.props.getFillColor({activityType})[3]);
    assert.deepEqual(alphas, [150, 150, 135, 120], `${builder} retains activity alpha ordering`);
    assert.equal(layer.props.getFillColor({})[3], 120, `${builder} defaults missing activity to unknown`);
  }
});
