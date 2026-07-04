import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  latestSnapshot,
  parseAttributes,
  selectorForNode,
  attributeLayers,
  groupBySelector,
  summarizeReasons,
  buildLayerReport,
} from '../scripts/measure-composited-layers.mjs';

// Deterministic fixtures (CI-safe, no browser). A `result` mirrors what measure()
// returns: composited `layers` (some tied to DOM nodes via backendNodeId), the
// resolved `nodes` map (CDP DOM.describeNode shape: nodeName + flat attribute
// array), and per-layer compositing `reasons`.
function fixtureResult() {
  return {
    url: 'http://x/dashboard',
    cpu: 1,
    layers: [
      // three .virtual-item rows — the over-promotion signal (#4630)
      { layerId: '1', backendNodeId: 10, width: 200, height: 40, paintCount: 1, drawsContent: true },
      { layerId: '2', backendNodeId: 11, width: 200, height: 40, paintCount: 1, drawsContent: true },
      { layerId: '3', backendNodeId: 12, width: 200, height: 40, paintCount: 1, drawsContent: true },
      // the unavoidable map canvas
      { layerId: '4', backendNodeId: 20, width: 1350, height: 700, paintCount: 3, drawsContent: true },
      // a structural compositor layer (no owning node)
      { layerId: '5', width: 1350, height: 940, paintCount: 0, drawsContent: false },
      // a layer whose node failed to resolve (detached between snapshot and describe)
      { layerId: '6', backendNodeId: 99, width: 10, height: 10, paintCount: 1, drawsContent: true },
    ],
    nodes: {
      10: { nodeName: 'DIV', attributes: ['class', 'virtual-item'] },
      11: { nodeName: 'DIV', attributes: ['class', 'virtual-item'] },
      12: { nodeName: 'DIV', attributes: ['class', 'virtual-item'] },
      20: { nodeName: 'CANVAS', attributes: ['class', 'maplibregl-canvas', 'id', 'map'] },
      99: null,
    },
    reasons: {
      '1': ['willChangeTransform'],
      '2': ['willChangeTransform'],
      '3': ['willChangeTransform'],
      '4': ['canvas'],
      '5': ['root'],
      '6': ['willChangeTransform'],
    },
  };
}

test('parseArgs reads url + flags with sane defaults', () => {
  assert.deepEqual(parseArgs(['node', 's.mjs']).url, 'https://www.worldmonitor.app/dashboard');
  const a = parseArgs(['node', 's.mjs', 'http://127.0.0.1:4173/dashboard', '--cpu', '4', '--json']);
  assert.equal(a.url, 'http://127.0.0.1:4173/dashboard');
  assert.equal(a.cpu, 4);
  assert.equal(a.json, true);
});

test('parseArgs rejects non-positive, non-finite, and missing numeric flags', () => {
  for (const value of ['0', '-1', 'Infinity']) {
    assert.throws(() => parseArgs(['node', 's.mjs', '--cpu', value]), /--cpu must be a finite positive number/);
    assert.throws(() => parseArgs(['node', 's.mjs', '--settle', value]), /--settle must be a finite positive number/);
  }
  assert.throws(() => parseArgs(['node', 's.mjs', '--cpu']), /--cpu must be a finite positive number/);
  assert.throws(() => parseArgs(['node', 's.mjs', '--settle']), /--settle must be a finite positive number/);
});

test('parseAttributes turns the flat CDP attribute array into {id, className}', () => {
  assert.deepEqual(parseAttributes(['class', 'virtual-item', 'id', 'foo']), { id: 'foo', className: 'virtual-item' });
  assert.deepEqual(parseAttributes([]), { id: '', className: '' });
  assert.deepEqual(parseAttributes(undefined), { id: '', className: '' });
});

test('selectorForNode prefers id, else first two classes, else tag; unknown is safe', () => {
  assert.equal(selectorForNode({ nodeName: 'DIV', attributes: ['id', 'panelsGrid'] }), 'div#panelsGrid');
  assert.equal(selectorForNode({ nodeName: 'DIV', attributes: ['class', 'a b c'] }), 'div.a.b');
  assert.equal(selectorForNode({ nodeName: 'SPAN', attributes: [] }), 'span');
  assert.equal(selectorForNode(null), '(unknown)');
});

test('happy path: buildLayerReport counts layers and ranks owners by layer count (#4630 R1)', () => {
  const report = buildLayerReport(fixtureResult());
  assert.equal(report.layerCount, 6);
  assert.equal(report.contentLayerCount, 5); // the structural layer draws no content
  // .virtual-item is the top owner (3 layers) — the over-promotion signal
  assert.deepEqual(report.owners[0], { selector: 'div.virtual-item', count: 3 });
  // every layer is attributed to some bucket; nothing dropped
  const totalAttributed = report.owners.reduce((s, o) => s + o.count, 0);
  assert.equal(totalAttributed, 6);
  // compositing reasons aggregate across layers, willChangeTransform dominant
  assert.deepEqual(report.reasons[0], { reason: 'willChangeTransform', count: 4 });
});

test('groupBySelector attributes structural + detached layers to their own buckets, never dropping', () => {
  const attributed = attributeLayers(fixtureResult().layers, fixtureResult().nodes);
  const owners = groupBySelector(attributed);
  const byName = Object.fromEntries(owners.map((o) => [o.selector, o.count]));
  assert.equal(byName['div.virtual-item'], 3);
  assert.equal(byName['canvas#map'], 1); // id wins over class
  assert.equal(byName['(structural)'], 1); // no backendNodeId
  assert.equal(byName['(detached)'], 1); // backendNodeId present but node null
});

test('cap-skipped nodes are reported separately from detached nodes', () => {
  const result = {
    url: 'http://x/dashboard',
    cpu: 1,
    layers: [
      { layerId: '1', backendNodeId: 10, width: 20, height: 20, paintCount: 1, drawsContent: true },
      { layerId: '2', backendNodeId: 99, width: 20, height: 20, paintCount: 1, drawsContent: true },
      { layerId: '3', backendNodeId: 100, width: 20, height: 20, paintCount: 1, drawsContent: true },
    ],
    nodes: {
      10: { nodeName: 'DIV', attributes: ['class', 'known-owner'] },
      99: null,
      100: { skippedByDescribeNodeCap: true },
    },
    reasons: {},
  };
  const report = buildLayerReport(result);
  const byName = Object.fromEntries(report.owners.map((o) => [o.selector, o.count]));
  assert.equal(byName['div.known-owner'], 1);
  assert.equal(byName['(detached)'], 1);
  assert.equal(byName['(describe-cap-skipped)'], 1);
  assert.equal(report.describeNodeCap, 400);
  assert.equal(report.describeNodeSkippedCount, 1);
  assert.match(report.warning, /DOM\.describeNode cap reached/);
});

test('edge: only the two unavoidable map canvases → count 2, no excess owner', () => {
  const result = {
    url: 'http://x/dashboard',
    cpu: 1,
    layers: [
      { layerId: '1', backendNodeId: 20, width: 1350, height: 700, paintCount: 3, drawsContent: true },
      { layerId: '2', backendNodeId: 21, width: 1350, height: 700, paintCount: 3, drawsContent: true },
    ],
    nodes: {
      20: { nodeName: 'CANVAS', attributes: ['class', 'maplibregl-canvas'] },
      21: { nodeName: 'CANVAS', attributes: ['class', 'deckgl-canvas'] },
    },
    reasons: { '1': ['canvas'], '2': ['canvas'] },
  };
  const report = buildLayerReport(result);
  assert.equal(report.layerCount, 2);
  assert.ok(report.owners.every((o) => o.count === 1)); // no single selector over-promotes
});

test('edge: repeated layerTreeDidChange events → only the latest snapshot is counted', () => {
  const snapshots = [
    { layers: [{ layerId: '1' }, { layerId: '2' }] },
    {}, // a no-op change event (no layers field) — ignored
    { layers: [{ layerId: '1' }, { layerId: '2' }, { layerId: '3' }] },
  ];
  assert.equal(latestSnapshot(snapshots).length, 3);
  assert.equal(latestSnapshot([]).length, 0);
  assert.equal(latestSnapshot(undefined).length, 0);
});

test('error: LayerTree unavailable → warning report, count 0, non-fatal', () => {
  const report = buildLayerReport({ url: 'http://x/dashboard', cpu: 1, warning: 'CDP LayerTree unavailable: boom' });
  assert.equal(report.layerCount, 0);
  assert.equal(report.contentLayerCount, 0);
  assert.deepEqual(report.owners, []);
  assert.deepEqual(report.reasons, []);
  assert.match(report.warning, /LayerTree unavailable/);
});

test('--json report round-trips through JSON.parse(JSON.stringify(report))', () => {
  const report = buildLayerReport(fixtureResult());
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));
});

test('summarizeReasons is empty-safe', () => {
  assert.deepEqual(summarizeReasons({}), []);
  assert.deepEqual(summarizeReasons(undefined), []);
});
