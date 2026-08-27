import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TPS_CALLS_KEY,
  TPS_CALLS_MAX_CONTENT_AGE_MIN,
  TPS_CALLS_PAGE_CAP,
  TPS_CALLS_SERVICE_ITEM_ID,
  TPS_CALLS_SEMANTIC,
  TPS_MCI_KEY,
  TPS_MCI_MAX_CONTENT_AGE_MIN,
  TPS_MCI_PAGE_CAP,
  TPS_MCI_REQUIRED_FIELDS,
  TPS_MCI_SERVICE_ITEM_ID,
  TPS_MCI_SEMANTIC,
  TPS_OGL_ATTRIBUTION,
  buildTpsCallsSnapshot,
  buildTpsMciSnapshot,
  fetchTpsCallsAttended,
  fetchTpsMci,
  fetchTpsOpenData,
  interpretArcGisPage,
  normalizeTpsMciFeature,
  parseTpsMciFeatures,
  queryArcGisPages,
  resolveTpsPublish,
  tpsContentMeta,
  utcEpochToIso,
  validateTpsCallsSnapshot,
  validateTpsMciSnapshot,
} from '../scripts/lib/tps-open-data.mjs';
import { runTpsSeed } from '../scripts/lib/tps-seed-runner.mjs';
import { TPS_ON_DEMAND_SECTIONS } from '../scripts/seed-tps-open-data.mjs';

const REPORT = Date.UTC(2026, 5, 30, 0, 0, 0);
const OCC = Date.UTC(2026, 5, 29, 12, 0, 0);

function mciAttrs(overrides = {}) {
  return {
    OBJECTID: 1,
    EVENT_UNIQUE_ID: 'GO-2026-100',
    REPORT_DATE: REPORT,
    OCC_DATE: OCC,
    DIVISION: 'D51',
    LOCATION_TYPE: 'Streets, Roads, Highways (Bicycle Path, Private Road)',
    PREMISES_TYPE: 'Outside',
    UCR_CODE: '1430',
    UCR_EXT: '100',
    OFFENCE: 'Assault',
    CSI_CATEGORY: 'Assault',
    HOOD_158: '168',
    NEIGHBOURHOOD_158: 'Downtown Yonge East',
    HOOD_140: '75',
    NEIGHBOURHOOD_140: 'Church-Yonge Corridor',
    LONG_WGS84: -79.3791,
    LAT_WGS84: 43.6561,
    ...overrides,
  };
}

function callsAttrs(overrides = {}) {
  return {
    ObjectId: 1,
    EVENT_YEAR: 2025,
    DIVISION_ORIGINAL: 'D51',
    DIVISION_FINAL: 'D51',
    HOOD_158: '168',
    NEIGHBOURHOOD_158: 'Downtown Yonge East',
    EVENT_COUNT: 42,
    ...overrides,
  };
}

function feature(attributes) {
  return { attributes };
}

function pageBody(features, { exceeded = false } = {}) {
  return { features, exceededTransferLimit: exceeded };
}

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function metadataBody({ maxRecordCount, fields, dataLastEditDate = 1784207489712, serviceItemId }) {
  return {
    maxRecordCount,
    serviceItemId,
    editingInfo: { dataLastEditDate, lastEditDate: dataLastEditDate },
    fields: fields.map((name) => ({ name })),
  };
}

function stableFetch(features, metadata = null, objectIdField = 'OBJECTID') {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.searchParams.get('returnIdsOnly') === 'true') {
      return jsonResponse({
        objectIdFieldName: objectIdField,
        objectIds: features.map((row) => row.attributes[objectIdField]),
      });
    }
    if (!parsed.searchParams.has('objectIds')) return jsonResponse(metadata);
    const ids = parsed.searchParams.get('objectIds').split(',').map(Number);
    return jsonResponse(pageBody(features.filter((row) => ids.includes(row.attributes[objectIdField]))));
  };
}

describe('TPS Open Data pagination and semantics (#7012)', () => {
  it('pages past the 2000-record MCI cap', async () => {
    const first = Array.from({ length: 2000 }, (_, i) => feature(mciAttrs({ OBJECTID: i + 1, EVENT_UNIQUE_ID: `GO-2026-${i}` })));
    const second = Array.from({ length: 250 }, (_, i) => feature(mciAttrs({ OBJECTID: 2001 + i, EVENT_UNIQUE_ID: `GO-2026-${2000 + i}` })));
    const result = await queryArcGisPages({
      queryUrl: 'https://services.arcgis.com/S9th0jAJ7bqgIRjw/arcgis/rest/services/Major_Crime_Indicators_Open_Data/FeatureServer/0/query',
      pageSize: TPS_MCI_PAGE_CAP,
      maxPages: 3,
      orderByFields: 'OBJECTID',
      objectIdField: 'OBJECTID',
      fetchImpl: stableFetch([...first, ...second]),
      label: 'mci',
    });
    assert.equal(result.features.length, 2250);
    assert.equal(result.pages, 2);
    assert.ok(result.features.length > TPS_MCI_PAGE_CAP);
  });

  it('pages past the 1000-record Calls Attended cap', async () => {
    const first = Array.from({ length: 1000 }, (_, i) => feature(callsAttrs({ ObjectId: i + 1 })));
    const second = Array.from({ length: 200 }, (_, i) => feature(callsAttrs({ ObjectId: 1001 + i, EVENT_YEAR: 2024 })));
    const result = await queryArcGisPages({
      queryUrl: 'https://services.arcgis.com/S9th0jAJ7bqgIRjw/arcgis/rest/services/Calls_for_Service_Attended_(ASR_CS_TBL_003)/FeatureServer/0/query',
      pageSize: TPS_CALLS_PAGE_CAP,
      maxPages: 4,
      orderByFields: 'ObjectId',
      objectIdField: 'ObjectId',
      fetchImpl: stableFetch([...first, ...second], null, 'ObjectId'),
      label: 'calls',
    });
    assert.equal(result.features.length, 1200);
    assert.ok(result.features.length > TPS_CALLS_PAGE_CAP);
  });

  it('keeps several offence/victim rows for one EVENT_UNIQUE_ID', () => {
    const rows = parseTpsMciFeatures([
      feature(mciAttrs({ OBJECTID: 10, UCR_CODE: '1430', OFFENCE: 'Assault' })),
      feature(mciAttrs({ OBJECTID: 11, UCR_CODE: '1430', UCR_EXT: '200', OFFENCE: 'Assault With Weapon' })),
      feature(mciAttrs({ OBJECTID: 12, UCR_CODE: '1610', CSI_CATEGORY: 'Robbery', OFFENCE: 'Robbery' })),
    ]);
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((row) => row.eventUniqueId)).size, 1);
    assert.deepEqual(rows.map((row) => row.id), ['tps-mci:10', 'tps-mci:11', 'tps-mci:12']);
  });

  it('preserves UTC dates and approximate offset coordinates', () => {
    const row = normalizeTpsMciFeature(feature(mciAttrs()));
    assert.equal(utcEpochToIso(REPORT), '2026-06-30T00:00:00.000Z');
    assert.equal(row.reportDate, '2026-06-30T00:00:00.000Z');
    assert.equal(row.occDate, '2026-06-29T12:00:00.000Z');
    assert.equal(row.lon, -79.3791);
    assert.equal(row.lat, 43.6561);
    assert.equal(row.approximate, true);
    assert.equal(row.geocoded, false);
    assert.equal(row.snapped, false);
    assert.equal(row.live, false);
    assert.equal(row.semantic, TPS_MCI_SEMANTIC);
  });

  it('fails closed on schema drift, 4xx/5xx, malformed JSON, and partial pages', async () => {
    assert.throws(
      () => interpretArcGisPage({ body: { features: [feature(mciAttrs())], exceededTransferLimit: true }, pageSize: 2000, label: 'mci' }),
      /partial_page/,
    );
    assert.throws(
      () => normalizeTpsMciFeature(feature({ OBJECTID: 1, EVENT_UNIQUE_ID: 'GO-1' })),
      /schema_drift/,
    );

    const http502 = await fetchTpsMci({
      metadata: { maxRecordCount: 2000, fields: TPS_MCI_REQUIRED_FIELDS, editingInfo: { dataLastEditDate: 1 }, serviceItemId: TPS_MCI_SERVICE_ITEM_ID },
      fetchImpl: async () => jsonResponse({ error: 'no' }, { status: 502 }),
    });
    assert.equal(http502.ok, false);
    assert.match(http502.reason, /http_502/);

    const malformed = await fetchTpsMci({
      metadata: { maxRecordCount: 2000, fields: TPS_MCI_REQUIRED_FIELDS, editingInfo: { dataLastEditDate: 1 }, serviceItemId: TPS_MCI_SERVICE_ITEM_ID },
      fetchImpl: async () => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    assert.equal(malformed.ok, false);
    assert.match(malformed.reason, /malformed_json|shape_break/);
  });

  it('health uses dataLastEditDate and newest content date/year, not fetch time', () => {
    const snapshot = buildTpsMciSnapshot({
      records: [normalizeTpsMciFeature(feature(mciAttrs()))],
      editingInfo: { dataLastEditDate: 1784207489712 },
      fetchedAt: '2026-08-21T00:00:00.000Z',
    });
    const meta = tpsContentMeta(snapshot);
    assert.equal(meta.dataLastEditDate, 1784207489712);
    assert.equal(meta.newestContentAt, REPORT);
    assert.notEqual(meta.newestItemAt, Date.parse(snapshot.fetchedAt));
    assert.equal(meta.newestItemAt, Math.min(1784207489712, REPORT));
    assert.equal(meta.oldestItemAt, meta.newestItemAt);

    const calls = buildTpsCallsSnapshot({
      records: [{ eventYear: 2025 }],
      editingInfo: { dataLastEditDate: 1784654305769 },
      fetchedAt: '2026-08-21T00:00:00.000Z',
    });
    const callsMeta = tpsContentMeta(calls);
    assert.equal(callsMeta.newestContentYear, 2025);
    assert.equal(callsMeta.dataLastEditDate, 1784654305769);
    assert.equal(callsMeta.newestItemAt, Math.min(1784654305769, Date.UTC(2025, 11, 31)));
    assert.equal(tpsContentMeta(buildTpsMciSnapshot({ records: [], editingInfo: { dataLastEditDate: 1 } })), null);
    assert.equal(TPS_MCI_MAX_CONTENT_AGE_MIN, 120 * 24 * 60);
    assert.equal(TPS_CALLS_MAX_CONTENT_AGE_MIN, 400 * 24 * 60);
  });

  it('one source failing keeps the other last-good snapshot', async () => {
    const goodMci = buildTpsMciSnapshot({
      records: [normalizeTpsMciFeature(feature(mciAttrs()))],
      editingInfo: { dataLastEditDate: 1 },
    });
    const goodCalls = buildTpsCallsSnapshot({
      records: [{
        id: 'tps-calls:1',
        objectId: 1,
        semantic: TPS_CALLS_SEMANTIC,
        source: 'tps-calls-attended',
        official: true,
        live: false,
        incidentPoint: false,
        eventYear: 2025,
        eventCount: 3,
      }],
      editingInfo: { dataLastEditDate: 2 },
    });
    assert.equal(validateTpsMciSnapshot(goodMci), true);
    assert.equal(validateTpsCallsSnapshot(goodCalls), true);

    const mciFail = resolveTpsPublish({ ok: false, reason: 'http_503' }, goodMci, validateTpsMciSnapshot);
    assert.equal(mciFail.keepLastGood, true);
    assert.equal(mciFail.sourceState, 'degraded');
    const callsOk = resolveTpsPublish({ ok: true, snapshot: goodCalls }, null, validateTpsCallsSnapshot);
    assert.equal(callsOk.persist, true);
    assert.notEqual(TPS_MCI_KEY, TPS_CALLS_KEY);
    assert.notEqual(TPS_MCI_SEMANTIC, TPS_CALLS_SEMANTIC);

    const combined = await fetchTpsOpenData({
      lastGood: { mci: goodMci, calls: goodCalls },
      fetchImpl: async () => jsonResponse({ error: 'down' }, { status: 503 }),
    });
    assert.equal(combined.mci.keepLastGood, true);
    assert.equal(combined.calls.keepLastGood, true);
    assert.match(TPS_OGL_ATTRIBUTION, /Open Government Licence - Ontario/);
  });

  it('pins the official layer IDs and page caps', () => {
    assert.equal(TPS_MCI_PAGE_CAP, 2000);
    assert.equal(TPS_CALLS_PAGE_CAP, 1000);
    assert.equal(TPS_MCI_KEY, 'safety:toronto:tps-mci:v1');
    assert.equal(TPS_CALLS_KEY, 'safety:toronto:tps-calls-attended:v1');
    assert.ok(TPS_MCI_REQUIRED_FIELDS.includes('EVENT_UNIQUE_ID'));
    assert.ok(TPS_MCI_REQUIRED_FIELDS.includes('LONG_WGS84'));
  });

  it('freezes object IDs before paging so live insertions cannot duplicate or omit rows', async () => {
    const original = [4, 3, 2, 1].map((id) => feature(mciAttrs({ OBJECTID: id, REPORT_DATE: REPORT + id })));
    let idsSnapshotted = false;
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      if (parsed.searchParams.get('returnIdsOnly') === 'true') {
        idsSnapshotted = true;
        return jsonResponse({ objectIdFieldName: 'OBJECTID', objectIds: [4, 3, 2, 1] });
      }
      assert.equal(idsSnapshotted, true);
      const requested = parsed.searchParams.get('objectIds').split(',').map(Number);
      const liveRows = [feature(mciAttrs({ OBJECTID: 5, REPORT_DATE: REPORT + 5 })), ...original];
      return jsonResponse(pageBody(liveRows.filter((row) => requested.includes(row.attributes.OBJECTID))));
    };
    const result = await queryArcGisPages({
      queryUrl: 'https://services.arcgis.com/S9th0jAJ7bqgIRjw/arcgis/rest/services/Major_Crime_Indicators_Open_Data/FeatureServer/0/query',
      pageSize: 2,
      maxPages: 2,
      orderByFields: 'REPORT_DATE DESC,OBJECTID',
      objectIdField: 'OBJECTID',
      fetchImpl,
      label: 'mci',
    });
    assert.deepEqual(result.features.map((row) => row.attributes.OBJECTID), [4, 3, 2, 1]);
  });

  it('fails closed before paging when the frozen ID set exceeds the page budget', async () => {
    await assert.rejects(
      queryArcGisPages({
        queryUrl: 'https://services.arcgis.com/S9th0jAJ7bqgIRjw/arcgis/rest/services/Major_Crime_Indicators_Open_Data/FeatureServer/0/query',
        pageSize: 2,
        maxPages: 2,
        orderByFields: 'OBJECTID',
        objectIdField: 'OBJECTID',
        fetchImpl: async () => jsonResponse({ objectIdFieldName: 'OBJECTID', objectIds: [1, 2, 3, 4, 5] }),
        label: 'mci',
      }),
      /pagination_incomplete:mci:max_pages_2/,
    );
  });

  it('fails closed when a page does not return the exact frozen IDs', async () => {
    let call = 0;
    await assert.rejects(
      queryArcGisPages({
        queryUrl: 'https://services.arcgis.com/S9th0jAJ7bqgIRjw/arcgis/rest/services/Major_Crime_Indicators_Open_Data/FeatureServer/0/query',
        pageSize: 2,
        maxPages: 1,
        orderByFields: 'OBJECTID',
        objectIdField: 'OBJECTID',
        fetchImpl: async () => {
          call += 1;
          return call === 1
            ? jsonResponse({ objectIdFieldName: 'OBJECTID', objectIds: [1, 2] })
            : jsonResponse(pageBody([feature(mciAttrs({ OBJECTID: 1 }))]));
        },
        label: 'mci',
      }),
      /object_id_mismatch/,
    );
  });

  it('runs each TPS resource with its own canonical key and fail-closed hooks', async () => {
    const calls = [];
    const runSeedImpl = async (domain, resource, key, fetchSnapshot, options) => {
      calls.push({ domain, resource, key, snapshot: await fetchSnapshot(), options });
    };
    await runTpsSeed('mci', {
      runSeedImpl,
      fetchMci: async () => ({ ok: false, reason: 'http_503' }),
    });
    await runTpsSeed('calls', {
      runSeedImpl,
      fetchCalls: async () => ({ ok: false, reason: 'timeout' }),
    });
    assert.deepEqual(calls.map((entry) => entry.key), [TPS_MCI_KEY, TPS_CALLS_KEY]);
    assert.deepEqual(calls.map((entry) => entry.resource), ['tps-mci', 'tps-calls-attended']);
    assert.equal(calls[0].snapshot.sourceUnavailable, true);
    assert.equal(calls[0].options.validateFn(calls[0].snapshot), false);
    assert.equal((await calls[0].options.afterValidationSkip(calls[0].snapshot)).freshnessMetaPatch.sourceState, 'degraded');
    assert.equal(calls[0].options.contentMeta, tpsContentMeta);
    assert.equal(TPS_ON_DEMAND_SECTIONS.length, 2);
    assert.deepEqual(TPS_ON_DEMAND_SECTIONS.map((section) => section.canonicalKey), [TPS_MCI_KEY, TPS_CALLS_KEY]);
  });

  it('pins each fetched layer to its official ArcGIS service item', async () => {
    const mci = await fetchTpsMci({
      metadata: { maxRecordCount: 2000, fields: TPS_MCI_REQUIRED_FIELDS, editingInfo: { dataLastEditDate: 1 }, serviceItemId: 'wrong' },
      fetchImpl: async () => jsonResponse({}),
    });
    assert.match(mci.reason, /service_item_mismatch/);
    assert.equal(TPS_MCI_SERVICE_ITEM_ID, '0a239a5563a344a3bbf8452504ed8d68');
    assert.equal(TPS_CALLS_SERVICE_ITEM_ID, '46c7581a136445c78831acb657a4fb0d');
  });
});
