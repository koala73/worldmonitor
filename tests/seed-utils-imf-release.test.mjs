import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as seedUtils from '../scripts/_seed-utils.mjs';

// Real public IMF response captured from api.imf.org on 2026-10-18:
// IMF.RES:WEO(9.0.0) USA.NGDPD.A with attributes=all.
const CAPTURE = JSON.parse(readFileSync(new URL('./fixtures/imf-weo/ngdpd-usa-attributes-all-2026-10-18.json', import.meta.url), 'utf8'));
const CAPTURED_RELEASE = { publishedAt: '2026-10-13T02:00:00Z', updatedAt: '2026-10-13T02:00:00Z' };
const CAPTURED_VALUES = { USA: { 2025: 30861300000000, 2026: 32642373375000, 2027: 34441606777000 } };
const YEARS = ['2025', '2026', '2027'];
const UNKNOWN = { publishedAt: null, updatedAt: null };

const realFetch = globalThis.fetch;
let requestedUrls = [];
afterEach(() => { globalThis.fetch = realFetch; requestedUrls = []; });

function serve(body) {
  globalThis.fetch = async url => {
    requestedUrls.push(String(url));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

function capture() {
  return structuredClone(CAPTURE);
}

// Synthetic variants below edit the real capture. Their dates are invented.
function setDatasetAttributes(body, entries, datasetIndex = 0) {
  const structure = body.data.structures[body.data.dataSets[datasetIndex].structure ?? 0];
  structure.attributes.dataSet = entries.map(([id, values]) => ({ id, values: values ?? null }));
  body.data.dataSets[datasetIndex].attributes = entries.map(([, , value]) => value);
  return body;
}

async function releaseOf(body) {
  serve(body);
  return (await seedUtils.imfSdmxFetchIndicatorWithRelease('NGDPD', { years: YEARS })).release;
}

describe('imfSdmxFetchIndicatorWithRelease against the real IMF capture', () => {
  it('requests reference metadata and DSD attributes together', async () => {
    serve(capture());
    await seedUtils.imfSdmxFetchIndicator('NGDPD', { years: YEARS });
    const params = new URL(requestedUrls[0]).searchParams;
    assert.equal(params.get('attributes'), 'all');
    assert.equal(params.get('measures'), 'all');
    assert.equal(params.get('dimensionAtObservation'), 'TIME_PERIOD');
  });

  it('returns the dataset publication and update dates with unchanged values', async () => {
    serve(capture());
    const result = await seedUtils.imfSdmxFetchIndicatorWithRelease('NGDPD', { years: YEARS });
    assert.deepEqual(result, { values: CAPTURED_VALUES, release: CAPTURED_RELEASE });
  });

  it('keeps the values-only helper contract for its other callers', async () => {
    serve(capture());
    assert.deepEqual(await seedUtils.imfSdmxFetchIndicator('NGDPD', { years: YEARS }), CAPTURED_VALUES);
  });
});

describe('imfSdmxFetchIndicatorWithRelease metadata decoding (synthetic)', () => {
  it('finds attributes by ID after the descriptors are reordered', async () => {
    const body = capture();
    const structure = body.data.structures[0];
    const order = structure.attributes.dataSet.map((_, i) => i).reverse();
    structure.attributes.dataSet = order.map(i => structure.attributes.dataSet[i]);
    body.data.dataSets[0].attributes = order.map(i => body.data.dataSets[0].attributes[i]);
    assert.deepEqual(await releaseOf(body), CAPTURED_RELEASE);
  });

  it('reads the structure the dataset names, not structure 0', async () => {
    const body = capture();
    const decoy = structuredClone(body.data.structures[0]);
    decoy.dimensions.observation[0].values = decoy.dimensions.observation[0].values.map(v => ({ value: String(Number(v.value) + 100) }));
    decoy.attributes.dataSet = [{ id: 'PUBLICATION_DATE', values: null }, { id: 'UPDATE_DATE', values: null }];
    body.data.structures = [decoy, body.data.structures[0]];
    body.data.dataSets[0].structure = 1;
    serve(body);
    assert.deepEqual(await seedUtils.imfSdmxFetchIndicatorWithRelease('NGDPD', { years: YEARS }), { values: CAPTURED_VALUES, release: CAPTURED_RELEASE });
  });

  it('reports unknown when the response carries no dataset attributes', async () => {
    const body = capture();
    delete body.data.structures[0].attributes.dataSet;
    delete body.data.dataSets[0].attributes;
    serve(body);
    assert.deepEqual(await seedUtils.imfSdmxFetchIndicatorWithRelease('NGDPD', { years: YEARS }), { values: CAPTURED_VALUES, release: UNKNOWN });
  });

  it('reports unknown for absent values', async () => {
    assert.deepEqual(await releaseOf(setDatasetAttributes(capture(), [['PUBLICATION_DATE', null, null], ['UPDATE_DATE', null, undefined]])), UNKNOWN);
  });

  it('reports unknown for values that are not calendar dates', async () => {
    for (const bad of [['2026-02-30T00:00:00Z'], ['2026-10-13T25:00:00Z'], ['13/10/2026'], ['2026'], [''], [42], [{ en: '2026-10-13' }], true]) {
      const body = setDatasetAttributes(capture(), [['PUBLICATION_DATE', null, bad], ['UPDATE_DATE', null, bad]]);
      assert.deepEqual(await releaseOf(body), UNKNOWN, JSON.stringify(bad));
    }
  });

  it('reports unknown when a value is ambiguous', async () => {
    const body = setDatasetAttributes(capture(), [
      ['PUBLICATION_DATE', null, ['2000-01-01T00:00:00Z', '2000-02-01T00:00:00Z']],
      ['UPDATE_DATE', null, ['2000-03-01T00:00:00Z']],
      ['UPDATE_DATE', null, ['2000-04-01T00:00:00Z']],
    ]);
    assert.deepEqual(await releaseOf(body), UNKNOWN);
  });

  it('accepts direct, single-element and coded values', async () => {
    const body = setDatasetAttributes(capture(), [
      ['PUBLICATION_DATE', null, '2000-01-01'],
      ['UPDATE_DATE', [{ id: 'X' }, { id: '2000-02-01T12:30:00+04:00' }], 1],
    ]);
    assert.deepEqual(await releaseOf(body), { publishedAt: '2000-01-01', updatedAt: '2000-02-01T12:30:00+04:00' });
  });

  it('reports unknown for a code index with no matching value', async () => {
    const body = setDatasetAttributes(capture(), [['PUBLICATION_DATE', [{ id: '2000-01-01' }], 3], ['UPDATE_DATE', null, 0]]);
    assert.deepEqual(await releaseOf(body), UNKNOWN);
  });

  it('never takes dates from a dataset other than the one it parsed', async () => {
    const body = setDatasetAttributes(capture(), [['PUBLICATION_DATE', null, null], ['UPDATE_DATE', null, null]]);
    const second = structuredClone(body.data.dataSets[0]);
    second.attributes = [['2000-01-01T00:00:00Z'], ['2000-02-01T00:00:00Z']];
    body.data.dataSets.push(second);
    assert.deepEqual(await releaseOf(body), UNKNOWN);
  });
});
