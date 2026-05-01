import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseRealtimeAlerts, parseHistoricalData } from '../scripts/seed-vpd-tracker.mjs';

// Fixture mirroring the post-2026-04 bundle shape verified against the live
// 7.5MB index_bundle.js on 2026-05-01: two `eval("var res = [...]")` blocks
// with JSON-quoted properties inside JS-escaped string literals.
function buildNewBundleFixture() {
  const realtime = [
    { Alert_ID: '8731706', lat: '56.85', lng: '24.92', diseases: 'Measles', place_name: 'Riga', country: 'Latvia', date: '2026-04-15', cases: '12', link: 'https://example.com/a', Type: 'outbreak', summary: 'Cluster' },
    { Alert_ID: '8731707', lat: '40.4', lng: '-3.7', diseases: 'Pertussis', place_name: 'Madrid', country: 'Spain', date: '2026-04-12', cases: '1,234', link: 'https://example.com/b', Type: 'outbreak', summary: 'Surge' },
    { Alert_ID: '8731708', lat: '', lng: '', diseases: 'Diphtheria', place_name: 'Unknown', country: 'Nowhere', date: '2026-04-10', cases: '', link: '', Type: 'note', summary: 'Drop me' },
  ];
  const historical = [
    { country: 'Afghanistan', iso: 'AF', disease: 'Diphtheria', year: '2024', cases: '207' },
    { country: 'Albania', iso: 'AL', disease: 'Diphtheria', year: '2024', cases: '0' },
    { country: 'Australia', iso: 'AU', disease: 'Measles', year: '2024', cases: '9' },
  ];
  // Build the bundle text the same way the upstream bundler does:
  // `eval("<JS-string-literal-of-source>")` where the inner source is
  // `var res = <JSON.stringify(array)>`.
  const realtimeInner = `var res = ${JSON.stringify(realtime)}`;
  const historicalInner = `var res = ${JSON.stringify(historical)}`;
  // JS-escape the inner source for embedding in a string literal
  const realtimeEscaped = JSON.stringify(realtimeInner).slice(1, -1); // strip outer quotes
  const historicalEscaped = JSON.stringify(historicalInner).slice(1, -1);
  return [
    '/* unrelated leading bundler boilerplate */',
    `eval("${historicalEscaped}")`, // historical comes first in the live bundle (offset 5720 vs 2712352)
    '/* lots of intermediate webpack chunks */',
    `eval("${realtimeEscaped}")`,
    '/* trailing webpack runtime */',
  ].join('\n');
}

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

  it('throws a clear error when the realtime marker is missing (upstream format drift)', () => {
    const bundle = '/* bundle with no Alert_ID anchor */';
    assert.throws(
      () => parseRealtimeAlerts(bundle),
      /eval-block anchor for marker 'Alert_ID' not found/,
    );
  });

  it('throws a clear error when the array is unterminated (truncated bundle)', () => {
    const truncated = 'eval("var res = [{\\"Alert_ID\\":\\"8731706\\"';
    assert.throws(
      () => parseRealtimeAlerts(truncated),
      /array did not close for 'Alert_ID'/,
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

  it('throws a clear error when the historical marker is missing', () => {
    // Bundle has the Alert_ID block but no country block.
    const bundle = `eval("var res = ${JSON.stringify(`var res = ${JSON.stringify([{ Alert_ID: '1', lat: '0', lng: '0', diseases: '', place_name: '', country: '', date: '', cases: '', link: '', Type: '', summary: '' }])}`).slice(1, -1)}")`;
    assert.throws(
      () => parseHistoricalData(bundle),
      /eval-block anchor for marker 'country' not found/,
    );
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
      /eval-block anchor for marker 'Alert_ID' not found/,
    );
    assert.throws(
      () => parseHistoricalData(oldShape),
      /eval-block anchor for marker 'country' not found/,
    );
  });
});
