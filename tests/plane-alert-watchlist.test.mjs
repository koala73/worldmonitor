import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  INCLUDED_GROUPS,
  WATCHLIST_COLUMNS,
  buildWatchlist,
  diffWatchlist,
  hasDrift,
  parseCsv,
  parsePlaneAlertCsv,
  serializeWatchlist,
} from '../scripts/build-plane-alert-watchlist.mjs';
import {
  getPlaneAlertWatchlistMeta,
  lookupPlaneAlertAircraft,
  validatePlaneAlertWatchlist,
} from '../scripts/_plane-alert-registry.mjs';
import { filterMilitaryFlights } from '../scripts/seed-military-flights.mjs';

const committed = JSON.parse(readFileSync(new URL('../scripts/data/plane-alert-watchlist.json', import.meta.url), 'utf8'));

const HEADER = '$ICAO,$Registration,$Operator,$Type,$ICAO Type,#CMPG,$Tag 1,$#Tag 2,$#Tag 3,Category,$#Link';
const META = { retrievedAt: '2026-10-18', sourceSha256: 'a'.repeat(64) };
const fixtureCsv = [
  HEADER,
  'ae1234,N1,"Operator, With Comma","Boeing ""Jumbo"" 747",B744,Mil,t1,t2,t3,USAF,https://example.test/a',
  '000004,FAC1282,Colombian Aerospace Force,CASA C-295 M,C295,Mil,Cargo,Tactical,Powder,Other Air Forces,',
  '00412D,Z-WPE,Air Zimbabwe,Boeing 767,B763,Gov,,,,Dictator Alert,',
  '004006,Z-WSG,Medical Air Rescue,B200,BE20,Civ,,,,Flying Doctors,',
  '43C009,G-POLA,Police,EC135,EC35,Pol,,,,Police Forces,',
  '10166,BAD,Five Char Hex,Type,TYP,Mil,,,,USAF,',
  'AE1234,DUPE,Duplicate Of First,Type,TYP,Mil,,,,USAF,',
].join('\r\n') + '\r\n';

function makeState(icao24, callsign = '') {
  return [icao24, callsign, 'United States', null, Date.now() / 1000, 120.7, 15.1, 0, false, 0, 0, 0, null, null, null, {}];
}

describe('vendored plane-alert watchlist', () => {
  it('validates, carries provenance and license, and clears the size floor', () => {
    assert.deepEqual(validatePlaneAlertWatchlist(committed), []);
    assert.equal(committed.schemaVersion, 1);
    assert.match(committed.license, /ODbL-1\.0/);
    assert.match(committed.licenseUrl, /^https:\/\/opendatacommons\.org\//);
    assert.match(committed.sourceFileUrl, /^https:\/\/raw\.githubusercontent\.com\/sdr-enthusiasts\/plane-alert-db\//);
    assert.match(committed.attribution, /SDR-Enthusiasts/);
    assert.deepEqual(committed.includedGroups, INCLUDED_GROUPS);
    assert.deepEqual(committed.columns, WATCHLIST_COLUMNS);
    assert.equal(committed.rows, committed.aircraft.length);
    assert.ok(committed.aircraft.length >= 10_000, `expected at least 10000 aircraft, got ${committed.aircraft.length}`);
    assert.equal(committed.upstreamRows, committed.rows + committed.excludedRows + committed.skippedRows);
  });

  it('is sorted by hex with no duplicates and only the vendored groups', () => {
    const hexes = committed.aircraft.map((row) => row[0]);
    assert.deepEqual(hexes, [...hexes].sort());
    assert.equal(new Set(hexes).size, hexes.length);
    for (const row of committed.aircraft) {
      assert.match(row[0], /^[0-9A-F]{6}$/);
      assert.ok(INCLUDED_GROUPS.includes(row[5]), `${row[0]} group ${row[5]}`);
    }
  });
});

describe('plane-alert CSV conversion', () => {
  it('parses quoted commas, doubled quotes, CRLF line endings and a BOM', () => {
    const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n1,2\r\n');
    assert.deepEqual(rows, [['﻿a', 'b'], ['x, y', 'say "hi"'], ['1', '2']]);
    const records = parsePlaneAlertCsv('﻿' + fixtureCsv);
    assert.equal(records[0].operator, 'Operator, With Comma');
    assert.equal(records[0].type, 'Boeing "Jumbo" 747');
    assert.equal(records.length, 7);
  });

  it('refuses an upstream header that lost a required column', () => {
    assert.throws(() => parsePlaneAlertCsv(HEADER.replace('$Operator', '$Op') + '\n'), /missing the "\$Operator" column/);
  });

  it('keeps Mil and Gov rows, uppercases and sorts hexes, and drops bad or duplicate keys', () => {
    const watchlist = buildWatchlist(parsePlaneAlertCsv(fixtureCsv), META);
    assert.deepEqual(watchlist.aircraft.map((row) => row[0]), ['000004', '00412D', 'AE1234']);
    assert.deepEqual(watchlist.aircraft[2], ['AE1234', 'N1', 'Operator, With Comma', 'Boeing "Jumbo" 747', 'B744', 'Mil', 'USAF']);
    assert.equal(watchlist.upstreamRows, 7);
    assert.equal(watchlist.excludedRows, 2, 'Civ and Pol rows are excluded');
    assert.equal(watchlist.skippedRows, 2, 'five-character hex and duplicate hex are skipped');
    assert.equal(watchlist.rows, 3);
    assert.equal(watchlist.retrievedAt, META.retrievedAt);
    assert.equal(watchlist.sourceSha256, META.sourceSha256);
    assert.deepEqual(validatePlaneAlertWatchlist({ ...watchlist, aircraft: watchlist.aircraft }).filter((e) => !/at least/.test(e)), []);
  });

  it('serializes one aircraft per line and round-trips through JSON.parse', () => {
    const watchlist = buildWatchlist(parsePlaneAlertCsv(fixtureCsv), META);
    const text = serializeWatchlist(watchlist);
    assert.deepEqual(JSON.parse(text), watchlist);
    assert.equal(text.split('\n').filter((line) => line.startsWith('    ["')).length, 3);
  });

  it('reports drift as added, removed and changed hexes but not as a new retrieval stamp', () => {
    const base = buildWatchlist(parsePlaneAlertCsv(fixtureCsv), META);
    const same = buildWatchlist(parsePlaneAlertCsv(fixtureCsv), { retrievedAt: '2027-01-01', sourceSha256: 'b'.repeat(64) });
    assert.equal(hasDrift(diffWatchlist(base, same)), false);

    const edited = fixtureCsv
      .replace('00412D,Z-WPE,Air Zimbabwe', '00412D,Z-WPE,Air Zimbabwe Renamed')
      .replace('000004,FAC1282', '000005,FAC1282');
    const diff = diffWatchlist(base, buildWatchlist(parsePlaneAlertCsv(edited), META));
    assert.deepEqual(diff, { added: ['000005'], removed: ['000004'], changed: ['00412D'], metadata: [] });
    assert.equal(hasDrift(diff), true);

    const meta = diffWatchlist(base, { ...same, includedGroups: ['Mil'] });
    assert.deepEqual(meta.metadata, ['includedGroups']);
    assert.equal(hasDrift(meta), true);
  });
});

describe('plane-alert registry reader', () => {
  it('resolves a listed hex case-insensitively and returns null otherwise', () => {
    const [hex, registration, operator, type, icaoType, group, category] = committed.aircraft[0];
    assert.deepEqual(lookupPlaneAlertAircraft(hex.toLowerCase()), { hex, registration, operator, type, icaoType, group, category });
    assert.deepEqual(lookupPlaneAlertAircraft(` ${hex} `), lookupPlaneAlertAircraft(hex));
    assert.equal(lookupPlaneAlertAircraft('ZZZZZZ'), null);
    assert.equal(lookupPlaneAlertAircraft('ADF80'), null);
    assert.equal(lookupPlaneAlertAircraft(undefined), null);
    assert.equal(getPlaneAlertWatchlistMeta().rows, committed.rows);
    assert.equal('aircraft' in getPlaneAlertWatchlistMeta(), false);
  });

  it('names the structural problems in a broken watchlist', () => {
    const good = buildWatchlist(parsePlaneAlertCsv(fixtureCsv), META);
    const problems = (patch) => validatePlaneAlertWatchlist({
      ...good, ...(patch.aircraft ? { rows: patch.aircraft.length } : {}), ...patch,
    }).filter((e) => !/at least/.test(e));
    assert.deepEqual(problems({}), []);
    assert.match(problems({ columns: ['hex'] })[0], /columns must be/);
    assert.match(problems({ rows: 99 })[0], /rows \(99\)/);
    assert.match(problems({ aircraft: [['12345', 'r', 'o', 't', 'i', 'Mil', 'c']] })[0], /not six uppercase hex/);
    assert.match(problems({ aircraft: [['AE1234', 'r', 'o', 't', 'i', 'Civ', 'c']] })[0], /outside includedGroups/);
    assert.match(problems({ aircraft: [good.aircraft[2], good.aircraft[0]] }).join('\n'), /out of order/);
    assert.match(problems({ sourceSha256: 'nope' })[0], /sha256/);
    assert.match(problems({ license: '' })[0], /license must be/);
    assert.deepEqual(validatePlaneAlertWatchlist(null), ['watchlist is not an object']);
  });
});

describe('military flight seeder watchlist join', () => {
  const listedUsaf = committed.aircraft.find((row) => row[0] >= 'ADF7C8' && row[0] <= 'AFFFFF');
  assert.ok(listedUsaf, 'the vendored list should hold at least one aircraft in the USAF hex range');

  it('annotates a listed aircraft with its named operator without changing the classification', () => {
    const { flights, audit } = filterMilitaryFlights([makeState(listedUsaf[0].toLowerCase())]);
    assert.equal(flights.length, 1);
    assert.equal(flights[0].admissionReason, 'hex_trusted');
    assert.equal(flights[0].operator, 'usaf');
    assert.deepEqual(flights[0].watchlist, {
      operator: listedUsaf[2],
      category: listedUsaf[6],
      registration: listedUsaf[1],
      aircraftModel: listedUsaf[3],
      icaoType: listedUsaf[4],
      group: listedUsaf[5],
    });
    assert.equal(audit.watchlistMatched, 1);
    assert.equal(audit.watchlistMatchRate, 1);
  });

  it('leaves an unlisted aircraft unannotated and counts it in the rate', () => {
    assert.equal(lookupPlaneAlertAircraft('ADF800'), null, 'ADF800 is the existing unlisted test hex');
    const { flights, audit } = filterMilitaryFlights([makeState('ADF800'), makeState(listedUsaf[0])]);
    assert.equal(flights.length, 2);
    assert.equal(flights.find((f) => f.hexCode === 'ADF800').watchlist, undefined);
    assert.equal(audit.watchlistMatched, 1);
    assert.equal(audit.watchlistMatchRate, 0.5);
  });
});
