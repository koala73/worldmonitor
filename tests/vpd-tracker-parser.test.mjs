import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseRealtimeAlerts, parseHistoricalData } from '../scripts/seed-vpd-tracker.mjs';

// Fixture mirroring the post-2026-04 bundle shape verified against the live
// 7.5MB index_bundle.js on 2026-05-01: two `eval("var res = [...]")` blocks
// with JSON-quoted properties inside JS-escaped string literals.
function buildBundleFixture({ realtime, historical, blockOrder = ['historical', 'realtime'] } = {}) {
  realtime ??= [
    { Alert_ID: '8731706', lat: '56.85', lng: '24.92', diseases: 'Measles', place_name: 'Riga', country: 'Latvia', date: '2026-04-15', cases: '12', link: 'https://example.com/a', Type: 'outbreak', summary: 'Cluster' },
    { Alert_ID: '8731707', lat: '40.4', lng: '-3.7', diseases: 'Pertussis', place_name: 'Madrid', country: 'Spain', date: '2026-04-12', cases: '1,234', link: 'https://example.com/b', Type: 'outbreak', summary: 'Surge' },
    { Alert_ID: '8731708', lat: '', lng: '', diseases: 'Diphtheria', place_name: 'Unknown', country: 'Nowhere', date: '2026-04-10', cases: '', link: '', Type: 'note', summary: 'Drop me' },
  ];
  historical ??= [
    { country: 'Afghanistan', iso: 'AF', disease: 'Diphtheria', year: '2024', cases: '207' },
    { country: 'Albania', iso: 'AL', disease: 'Diphtheria', year: '2024', cases: '0' },
    { country: 'Australia', iso: 'AU', disease: 'Measles', year: '2024', cases: '9' },
  ];
  const realtimeInner = `var res = ${JSON.stringify(realtime)}`;
  const historicalInner = `var res = ${JSON.stringify(historical)}`;
  const realtimeEscaped = JSON.stringify(realtimeInner).slice(1, -1);
  const historicalEscaped = JSON.stringify(historicalInner).slice(1, -1);
  const blocks = {
    realtime: `eval("${realtimeEscaped}")`,
    historical: `eval("${historicalEscaped}")`,
  };
  return [
    '/* unrelated leading bundler boilerplate */',
    blocks[blockOrder[0]],
    '/* lots of intermediate webpack chunks */',
    blocks[blockOrder[1]],
    '/* trailing webpack runtime */',
  ].join('\n');
}

// Backwards-compat name so the existing test sites still call it
const buildNewBundleFixture = () => buildBundleFixture();

describe('seed-vpd-tracker: parseRealtimeAlerts (post-2026-04 bundle format)', () => {
  it('extracts alerts from the new eval("var res = [...]") shape', () => {
    const bundle = buildNewBundleFixture();
    const alerts = parseRealtimeAlerts(bundle);
    assert.equal(alerts.length, 2, 'must drop the alert with empty lat/lng');
    assert.equal(alerts[0].alertId, '8731706');
    assert.equal(alerts[0].lat, 56.85);
    assert.equal(alerts[0].lng, 24.92);
    assert.equal(alerts[0].disease, 'Measles');
    assert.equal(alerts[0].country, 'Latvia');
    assert.equal(alerts[0].cases, 12);
  });

  it('parses comma-separated case counts as integers', () => {
    const bundle = buildNewBundleFixture();
    const alerts = parseRealtimeAlerts(bundle);
    const madrid = alerts.find((a) => a.country === 'Spain');
    assert.ok(madrid);
    assert.equal(madrid.cases, 1234, 'comma-separated "1,234" must parse to 1234');
  });

  it('throws a clear error when no eval block matches realtime schema (upstream format drift)', () => {
    const bundle = '/* bundle with no eval var-res blocks */';
    assert.throws(
      () => parseRealtimeAlerts(bundle),
      /no eval block matches realtime schema \(Alert_ID, lat, lng, diseases\)/,
    );
  });

  it('throws clear error when realtime schema fields cannot be found in any block', () => {
    // Bundle has an eval block but its records don't match the schema.
    const phantom = [{ key: 'foo' }, { key: 'bar' }];
    const inner = `var res = ${JSON.stringify(phantom)}`;
    const escaped = JSON.stringify(inner).slice(1, -1);
    const bundle = `eval("${escaped}")`;
    assert.throws(
      () => parseRealtimeAlerts(bundle),
      /no eval block matches realtime schema/,
    );
  });
});

describe('seed-vpd-tracker: parseHistoricalData (post-2026-04 bundle format)', () => {
  it('extracts WHO annual counts from the new eval("var res = [...]") shape', () => {
    const bundle = buildNewBundleFixture();
    const records = parseHistoricalData(bundle);
    assert.equal(records.length, 3);
    assert.equal(records[0].country, 'Afghanistan');
    assert.equal(records[0].iso, 'AF');
    assert.equal(records[0].disease, 'Diphtheria');
    assert.equal(records[0].year, 2024);
    assert.equal(records[0].cases, 207);
  });

  it('parses string year/cases fields into numbers', () => {
    const bundle = buildNewBundleFixture();
    const records = parseHistoricalData(bundle);
    const aus = records.find((r) => r.iso === 'AU');
    assert.ok(aus);
    assert.equal(typeof aus.year, 'number');
    assert.equal(typeof aus.cases, 'number');
    assert.equal(aus.year, 2024);
    assert.equal(aus.cases, 9);
  });

  it('throws a clear error when no eval block matches historical schema', () => {
    // Bundle has an Alert_ID block, but no historical-shaped block.
    const realtime = [{ Alert_ID: '1', lat: '0', lng: '0', diseases: 'Measles', place_name: '', country: '', date: '', cases: '', link: '', Type: '', summary: '' }];
    const inner = `var res = ${JSON.stringify(realtime)}`;
    const escaped = JSON.stringify(inner).slice(1, -1);
    const bundle = `eval("${escaped}")`;
    assert.throws(
      () => parseHistoricalData(bundle),
      /no eval block matches historical schema/,
    );
  });
});

describe('seed-vpd-tracker: REGRESSION — schema-based identification (key reordering, block reordering)', () => {
  // Reorder field keys WITHIN every record. A position-anchored parser
  // would fail because Alert_ID is no longer the first key; the
  // schema-based finder must succeed because the field set is unchanged.
  it('parses realtime alerts when Alert_ID is NOT the first key in records', () => {
    const reorderedRealtime = [
      { lat: '56.85', lng: '24.92', diseases: 'Measles', Alert_ID: '8731706', place_name: 'Riga', country: 'Latvia', date: '2026-04-15', cases: '12', link: 'https://example.com/a', Type: 'outbreak', summary: 'Cluster' },
      { country: 'Spain', diseases: 'Pertussis', lat: '40.4', lng: '-3.7', Alert_ID: '8731707', place_name: 'Madrid', date: '2026-04-12', cases: '50', link: 'https://example.com/b', Type: 'outbreak', summary: 'Surge' },
    ];
    const bundle = buildBundleFixture({ realtime: reorderedRealtime });
    const alerts = parseRealtimeAlerts(bundle);
    assert.equal(alerts.length, 2);
    assert.equal(alerts[0].alertId, '8731706');
    assert.equal(alerts[1].country, 'Spain');
  });

  it('parses historical when country is NOT the first key in records', () => {
    const reorderedHistorical = [
      { iso: 'AF', country: 'Afghanistan', disease: 'Diphtheria', year: '2024', cases: '207' },
      { year: '2024', cases: '9', iso: 'AU', country: 'Australia', disease: 'Measles' },
    ];
    const bundle = buildBundleFixture({ historical: reorderedHistorical });
    const records = parseHistoricalData(bundle);
    assert.equal(records.length, 2);
    assert.equal(records[0].country, 'Afghanistan');
    assert.equal(records[1].country, 'Australia');
  });

  it('parses regardless of which eval block appears first in the bundle', () => {
    // Live bundle has historical-first; this test forces realtime-first.
    const bundle = buildBundleFixture({ blockOrder: ['realtime', 'historical'] });
    const alerts = parseRealtimeAlerts(bundle);
    const historical = parseHistoricalData(bundle);
    assert.equal(alerts.length, 2);
    assert.equal(historical.length, 3);
  });

  it('discriminates between realtime and historical even when both blocks coexist', () => {
    // Both parsers run on the same bundle; each must find the right block,
    // not return the other's data. Schema fingerprint guarantees this:
    // realtime requires (Alert_ID, lat, lng, diseases); historical
    // requires (country, iso, disease, year, cases).
    const bundle = buildBundleFixture();
    const alerts = parseRealtimeAlerts(bundle);
    const historical = parseHistoricalData(bundle);
    assert.ok(alerts[0].alertId, 'realtime parsed Alert_ID');
    assert.ok(historical[0].iso, 'historical parsed iso');
    // Cross-contamination check: a historical record has no `alertId`
    assert.ok(historical[0].alertId === undefined);
  });

  it('skips a phantom eval("var res = [...]") block that does NOT match either schema', () => {
    // Some bundlers emit OTHER eval blocks (e.g. for color palettes or
    // layout config). The finder must walk past them.
    const phantom = [{ key: 'foo', value: 'bar' }, { key: 'baz', value: 'qux' }];
    const phantomInner = `var res = ${JSON.stringify(phantom)}`;
    const phantomEscaped = JSON.stringify(phantomInner).slice(1, -1);
    const base = buildBundleFixture();
    const bundleWithPhantom = `eval("${phantomEscaped}")\n${base}`;
    const alerts = parseRealtimeAlerts(bundleWithPhantom);
    const historical = parseHistoricalData(bundleWithPhantom);
    assert.equal(alerts.length, 2);
    assert.equal(historical.length, 3);
  });
});

describe('seed-vpd-tracker: REGRESSION — pre-2026-04 bundle shape now throws clearly', () => {
  // The OLD format: `var a=[{Alert_ID:"...",...}]; a.columns=["Alert_ID",...]`
  // and `[{country:"Afghanistan",...}]`. The pre-fix parser anchored on these.
  // Post-fix, the same input throws a clear "anchor not found" message instead
  // of attempting to parse and producing a confusing downstream error.
  it('rejects the pre-2026-04 var-a format with a clear message', () => {
    const oldShape = [
      'var a=[{Alert_ID:"8731706",lat:"56.85",lng:"24.92",diseases:"Measles"}];',
      'a.columns=["Alert_ID","lat","lng","diseases"];',
      '[{country:"Afghanistan",iso:"AF",disease:"Diphtheria",year:"2024",cases:"207"}]',
    ].join('\n');
    assert.throws(
      () => parseRealtimeAlerts(oldShape),
      /no eval block matches realtime schema/,
    );
    assert.throws(
      () => parseHistoricalData(oldShape),
      /no eval block matches historical schema/,
    );
  });
});
