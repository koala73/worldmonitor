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

  it('throws a clear error when no matching array block for realtime schema (upstream format drift)', () => {
    const bundle = '/* bundle with no eval var-res blocks */';
    assert.throws(
      () => parseRealtimeAlerts(bundle),
      /no matching array block for realtime schema \(Alert_ID, lat, lng, diseases\)/,
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
      /no matching array block for realtime schema/,
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

  it('throws a clear error when no matching array block for historical schema', () => {
    // Bundle has an Alert_ID block, but no historical-shaped block.
    const realtime = [{ Alert_ID: '1', lat: '0', lng: '0', diseases: 'Measles', place_name: '', country: '', date: '', cases: '', link: '', Type: '', summary: '' }];
    const inner = `var res = ${JSON.stringify(realtime)}`;
    const escaped = JSON.stringify(inner).slice(1, -1);
    const bundle = `eval("${escaped}")`;
    assert.throws(
      () => parseHistoricalData(bundle),
      /no matching array block for historical schema/,
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

describe('seed-vpd-tracker: REGRESSION — JSON-escaped quotes inside string values', () => {
  // P1 review finding: when a JSON value contains a literal `"`, it's
  // JSON-encoded as `\"`. Wrapped in a JS string literal that becomes
  // `\\\"` (4 bundle bytes). Earlier scanner versions interpreted the
  // sequence as `\\` (backslash escape) + `\"` (string-boundary toggle),
  // incorrectly toggling inJsonString mid-value. If brackets appear inside
  // the embedded-quoted span, depth counting goes wrong and arrayClose
  // lands at the wrong position.
  //
  // The live bundle has 22 alerts whose `summary` field contains embedded
  // quotes (e.g. `"alternative wellness" seminar`), so this is not
  // theoretical — it was a latent production bug that worked by accident
  // (compensating bugs cancelled when the quoted span contained no
  // brackets).

  it('parses an alert whose summary contains embedded quotes', () => {
    const realtime = [
      {
        Alert_ID: '1', lat: '56.85', lng: '24.92', diseases: 'Measles',
        place_name: 'Riga', country: 'Latvia', date: '2026-04-15',
        cases: '12', link: 'https://example.com/a', Type: 'outbreak',
        summary: 'Officials confirm "alternative wellness" seminar exposure',
      },
    ];
    const bundle = buildBundleFixture({ realtime });
    const alerts = parseRealtimeAlerts(bundle);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].summary, 'Officials confirm "alternative wellness" seminar exposure');
  });

  it('parses correctly when an embedded-quote span ALSO contains brackets', () => {
    // Most adversarial case: a value contains `"[regional] outbreak"`.
    // Pre-fix scanner would have flipped inJsonString and then counted
    // the `[` and `]` as bracket-depth changes, mis-locating arrayClose.
    const realtime = [
      {
        Alert_ID: '1', lat: '56.85', lng: '24.92', diseases: 'Measles',
        place_name: 'Riga', country: 'Latvia', date: '2026-04-15',
        cases: '12', link: 'https://example.com/a', Type: 'outbreak',
        summary: 'Officials confirm "[regional] outbreak" contained',
      },
      {
        Alert_ID: '2', lat: '40.4', lng: '-3.7', diseases: 'Pertussis',
        place_name: 'Madrid', country: 'Spain', date: '2026-04-12',
        cases: '50', link: 'https://example.com/b', Type: 'outbreak',
        summary: 'Followup record',
      },
    ];
    const bundle = buildBundleFixture({ realtime });
    const alerts = parseRealtimeAlerts(bundle);
    assert.equal(alerts.length, 2, 'second record must be parsed (would be lost if depth counting misaligned)');
    assert.equal(alerts[0].summary, 'Officials confirm "[regional] outbreak" contained');
    assert.equal(alerts[1].alertId, '2');
  });

  it('parses correctly when a value contains backslash-bracket-bracket sequences', () => {
    // Defensive: a value with literal backslashes adjacent to brackets.
    // JSON encodes the backslash as `\\` and the value gets JS-string-
    // wrapped, so subtle escape-sequence-misalignment edges show up here.
    const realtime = [
      {
        Alert_ID: '1', lat: '1', lng: '1', diseases: 'Measles',
        place_name: '', country: '', date: '',
        cases: '0', link: '', Type: '',
        summary: 'Path: C:\\\\foo\\\\bar [warn]',
      },
      {
        Alert_ID: '2', lat: '2', lng: '2', diseases: 'Pertussis',
        place_name: '', country: '', date: '',
        cases: '0', link: '', Type: '',
        summary: 'Second record',
      },
    ];
    const bundle = buildBundleFixture({ realtime });
    const alerts = parseRealtimeAlerts(bundle);
    assert.equal(alerts.length, 2);
    assert.ok(alerts[1].alertId === '2');
  });

  it('parses historical when a value contains embedded quotes', () => {
    const historical = [
      { country: 'United States of "America"', iso: 'US', disease: 'Measles', year: '2024', cases: '10' },
      { country: 'Canada', iso: 'CA', disease: 'Measles', year: '2024', cases: '5' },
    ];
    const bundle = buildBundleFixture({ historical });
    const records = parseHistoricalData(bundle);
    assert.equal(records.length, 2);
    assert.equal(records[0].country, 'United States of "America"');
    assert.equal(records[1].cases, 5);
  });
});

describe('seed-vpd-tracker: plain-JS var-a format (pre-2026-04 / 2026-05-revert)', () => {
  // The bundle on 2026-05-09 reverted to plain JS object literals (or shipped
  // a third variant after the April webpack rebuild): unquoted keys, mixed
  // `"..."`/`'...'` string values, no eval wrapper. The parser now supports
  // BOTH this format AND the eval+escaped-JSON format from the April
  // rewrite — both iterate via findArrayBySchema. WM 2026-05-09 detected
  // via /api/health: vpdTrackerRealtime stale 72h while bundle siblings
  // (Disease-Outbreaks, Displacement) ran fine in the same bundle.
  it('parses unquoted-keys realtime alerts (var a=[{Alert_ID:...}])', () => {
    const bundle = [
      'function(e,s){var a=[{Alert_ID:"8731706",lat:"56.85",lng:"24.92",',
      'diseases:"Measles",place_name:"Riga, Latvia",country:"Latvia",',
      'date:"5/2/2026",cases:"3",link:"https://example.com/x",',
      'summary:"Three measles cases reported."},',
      '{Alert_ID:"8731707",lat:"40.1",lng:"-74.2",diseases:"Mumps",',
      'place_name:"Trenton, NJ",country:"United States",date:"5/3/2026",',
      'cases:"7",link:"https://example.com/y",summary:"Mumps cluster."}]}',
    ].join('');
    const out = parseRealtimeAlerts(bundle);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].alertId, '8731706');
    assert.strictEqual(out[0].disease, 'Measles');
    assert.strictEqual(out[0].cases, 3);
    assert.strictEqual(out[1].country, 'United States');
  });

  it('parses single-quoted JS values (used when value contains literal ")', () => {
    // Bundle uses `'...'` for any value with embedded double quotes, e.g.
    // summaries that quote source phrases. JSON requires `"..."` so the
    // normalizer rewrites quote style and re-escapes embedded `"`.
    const bundle = [
      'function(e,s){var a=[{Alert_ID:"X1",lat:"40",lng:"-74",',
      'diseases:"Measles",place_name:"Riga",country:"Latvia",',
      'date:"5/2/2026",cases:"3",link:"https://e.com",',
      'summary:\'A measles exposure linked to an "alternative wellness" seminar.\'}]}',
    ].join('');
    const out = parseRealtimeAlerts(bundle);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(
      out[0].summary,
      'A measles exposure linked to an "alternative wellness" seminar.',
    );
  });

  it('parses unquoted-keys historical (var a=[{country:...}])', () => {
    const bundle = [
      'function(e,s){var a=[{country:"Afghanistan",iso:"AF",',
      'disease:"Diphtheria",year:"2024",cases:"207"},',
      '{country:"Albania",iso:"AL",disease:"Measles",year:"2024",cases:"0"}]}',
    ].join('');
    const out = parseHistoricalData(bundle);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].country, 'Afghanistan');
    assert.strictEqual(out[0].cases, 207);
  });

  it('still throws clearly when no block matches either format', () => {
    // No eval wrapper, no var-array with the matching schema fingerprint.
    const garbage = 'function(e,s){var x = "irrelevant"; var n=[1,2,3]}';
    assert.throws(() => parseRealtimeAlerts(garbage), /no matching array block for realtime schema/);
    assert.throws(() => parseHistoricalData(garbage), /no matching array block for historical schema/);
  });

  // Regression test for codex round 4 P2: the prior two-pass implementation
  // (string-quote-normalize, then a regex `s/([{,])\s*(<ident>):/$1"\$2":/g`)
  // would corrupt summary fields whose body contained a `,<word>:` sequence
  // because the regex had no string-state awareness. The single-pass
  // jsLiteralToJSON walker now tracks inString and only quotes keys when
  // out-of-string, so this case parses cleanly.
  it('does NOT misquote `,ident:` sequences inside string values (round-4 P2)', () => {
    const bundle = [
      'function(e,s){var a=[{Alert_ID:"X1",lat:"40",lng:"-74",',
      'diseases:"Measles",place_name:"NYC",country:"USA",',
      'date:"5/2/2026",cases:"3",link:"https://e.com",',
      // The summary contains a literal `, date:` sequence — exactly the
      // pattern the old regex would have falsely quoted. The single-pass
      // walker is in `inString=true` here so it must NOT touch this.
      'summary:"Cases linked to event, date: 2026-05-01, source confirmed."}]}',
    ].join('');
    const out = parseRealtimeAlerts(bundle);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(
      out[0].summary,
      'Cases linked to event, date: 2026-05-01, source confirmed.',
    );
  });

  it('handles bundle truncation at a backslash without overshooting EOF (round-4 P3)', () => {
    // If the bundle is truncated mid-escape-sequence, the brace walker
    // must not advance past the end of the string when it hits `\` as the
    // last byte. Result: walker returns -1 cleanly, candidate is skipped,
    // findArrayBySchema falls through to the throw.
    const truncated = 'function(e,s){var a=[{Alert_ID:"foo",lat:"1",lng:"2",diseases:"X\\';
    assert.throws(() => parseRealtimeAlerts(truncated), /no matching array block/);
  });
});
