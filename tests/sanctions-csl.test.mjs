// US Consolidated Screening List (#9352 part C): the six non-Treasury lists
// feed screening and the change feed. OFAC already supplies the Treasury rows.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CSL_SOURCES, CSL_URL, ingestCslEntries, parseCslPayload } from '../scripts/_csl-sanctions.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/csl-consolidated-sample.json', import.meta.url), 'utf8'));
const today = Date.UTC(2026, 9, 18);

describe('CSL parsing', () => {
  it('keeps one source per non-Treasury list and drops the Treasury rows', () => {
    const { lists, error } = parseCslPayload(fixture, today);
    assert.equal(error, null);
    assert.deepEqual(Object.keys(lists).sort(), [...CSL_SOURCES].sort());
    assert.deepEqual(CSL_SOURCES.slice().sort(), ['CSL-ACN', 'CSL-DPL', 'CSL-DTC', 'CSL-EL', 'CSL-MEU', 'CSL-UVL']);
    const all = Object.values(lists).flatMap(list => list.records);
    assert.ok(all.every(record => !/AEROCARIBBEAN/.test(record.name)), 'SDN rows come from OFAC, not the CSL');
  });

  it('maps a row to the seeder record shape with its legal instrument and list link', () => {
    const [record] = parseCslPayload(fixture, today).lists['CSL-EL'].records;
    assert.match(record.id, /^CSL-EL:[0-9a-f]{56}$/);
    assert.equal(record.name, 'China Aeronautical Radio Electronics Research Institute');
    assert.deepEqual(record.sourceLists, ['CSL-EL']);
    assert.equal(record.entityType, 'SANCTIONS_ENTITY_TYPE_UNSPECIFIED');
    assert.deepEqual(record.countryCodes, ['CN']);
    assert.deepEqual(record.countryNames, []);
    assert.deepEqual(record.programs, []);
    assert.equal(record.effectiveAt, String(Date.UTC(2025, 2, 28)));
    assert.equal(record._notice, '90 FR 14032');
    assert.equal(record._url, 'https://www.bis.gov/regulations/ear/744#supplement-4-744');
    assert.equal(record._aliases.length, 10, 'aliases are capped at 10');
    assert.deepEqual(record._identifiers, []);
  });

  it('drops a denial whose end date has passed and keeps one that is still in force', () => {
    const names = parseCslPayload(fixture, today).lists['CSL-DPL'].records.map(record => record.name);
    assert.ok(!names.includes('SEMICONDUCTOR SYSTEMS INTL., INC. (SSI)'), 'ended 2000-10-04');
    assert.ok(names.includes('THANE-COAT, INC'), 'ends 2027-01-24');
  });

  it('reads countries from addresses and the row, deduplicated, ISO alpha-2 only', () => {
    const { lists } = parseCslPayload(fixture, today);
    assert.deepEqual(lists['CSL-DPL'].records.find(r => r.name === 'UNITED AFRICAN AIRLINES').countryCodes, ['LY', 'LU', 'MT']);
    assert.deepEqual(lists['CSL-ACN'].records[0].countryCodes, ['TH']);
    assert.deepEqual(lists['CSL-ACN'].records[0].programs, ['Chemical and Biological Weapons Act']);
    assert.deepEqual(lists['CSL-DTC'].records[0].countryCodes, []);
    assert.equal(lists['CSL-DTC'].records[0].effectiveAt, '0', 'no start date');
    assert.match(lists['CSL-DTC'].records[0].id, /^CSL-DTC:[0-9a-f]{32}$/, 'DTC and MEU ids are 32 hex characters');
  });

  it('caps a long Federal Register citation and omits an empty one', () => {
    const { lists } = parseCslPayload(fixture, today);
    const long = lists['CSL-DPL'].records.find(r => r.name === 'THANE-COAT, INC');
    assert.ok(long._notice.length <= 200);
    assert.equal(lists['CSL-UVL'].records[0]._notice, undefined);
  });

  it('dates each list by its own source_last_updated', () => {
    const { lists } = parseCslPayload(fixture, today);
    assert.equal(lists['CSL-EL'].publishedAt, Date.parse('2026-08-21T20:19:33+00:00'));
    assert.equal(lists['CSL-ACN'].publishedAt, Date.parse('2026-10-02T14:20:52+00:00'));
  });

  it('reports a list missing from an otherwise good download instead of an empty list', () => {
    const withoutUvl = { ...fixture, results: fixture.results.filter(r => !r.source.startsWith('Unverified')) };
    const { lists } = parseCslPayload(withoutUvl, today);
    assert.equal(lists['CSL-UVL'].error, 'CSL_LIST_MISSING');
    assert.equal(lists['CSL-EL'].error, null);
  });

  it('rejects a payload that is not the bulk download shape', () => {
    assert.equal(parseCslPayload({ results: 'x' }, today).error, 'CSL_INVALID_PAYLOAD');
    assert.equal(parseCslPayload(null, today).error, 'CSL_INVALID_PAYLOAD');
  });
});

describe('CSL ingest', () => {
  it('fetches the bulk JSON from data.trade.gov with a User-Agent and no redirects', async () => {
    let seen;
    const result = await ingestCslEntries({
      now: today,
      fetchFn: async (url, init) => { seen = { url, init }; return Response.json(fixture); },
    });
    assert.equal(seen.url, CSL_URL);
    assert.equal(seen.init.redirect, 'error');
    assert.ok(seen.init.headers['User-Agent']);
    assert.equal(result.error, null);
    assert.equal(result.lists['CSL-EL'].records.length, 1);
  });

  it('turns HTTP and transport failures into an error for every list, never a throw', async () => {
    const http = await ingestCslEntries({ now: today, fetchFn: async () => new Response('no', { status: 503 }) });
    assert.equal(http.error, 'HTTP 503');
    const down = await ingestCslEntries({ now: today, fetchFn: async () => { throw new Error('ECONNRESET'); } });
    assert.equal(down.error, 'ECONNRESET');
    assert.deepEqual(down.lists, {});
  });
});
