// A country whose PortWatch reference ports have no Daily_Ports_Data rows at
// all is absent from the source, not a refresh failure. IMF republished the
// layer on 2026-10-28 without ~26 countries (BEL, HKG, QAT, ...) and dropped
// the ISO3/date indexes; every ISO3-filtered query for those countries then
// failed with ArcGIS's generic 400, the 174-country gate blocked publication,
// and the whole dataset went stale for days (WORLDMONITOR-1AF).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PORTWATCH_PORT_ACTIVITY_TARGET_COUNTRIES,
  MAX_SOURCE_ABSENT_COUNTRIES,
  buildCoverageReport,
  probeCountrySourceAbsence,
  selectSourceAbsentCountries,
  shouldAdvanceCanonicalForRun,
} from '../scripts/seed-portwatch-port-activity.mjs';
import { buildContentFreshnessReport, buildPortActivityMetaPayload } from '../scripts/_portwatch-content-freshness.mjs';
import { buildContentFreshnessAssessment } from '../api/_content-freshness.js';

const jsonResponse = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

function refMap(...ids) {
  return new Map(ids.map((id) => [id, { lat: 0, lon: 0 }]));
}

describe('probeCountrySourceAbsence', () => {
  it('queries the indexed portid column, never ISO3', async () => {
    let seen;
    const fetchFn = async (url) => { seen = new URL(url); return jsonResponse({ count: 0 }); };
    await probeCountrySourceAbsence('BEL', refMap('port57', 'port178'), { fetchFn });
    assert.equal(seen.searchParams.get('where'), "portid IN ('port57','port178')");
    assert.equal(seen.searchParams.get('returnCountOnly'), 'true');
  });

  it('is absent only on an explicit zero count', async () => {
    const probe = (body) => probeCountrySourceAbsence('BEL', refMap('port57'), {
      fetchFn: async () => jsonResponse(body),
    });
    assert.equal(await probe({ count: 0 }), 'absent');
    assert.equal(await probe({ count: 71 }), 'present');
    assert.equal(await probe({ error: { code: 400, message: 'Cannot perform query. Invalid query parameters.' } }), 'unknown');
    assert.equal(await probe({}), 'unknown');
    assert.equal(await probe({ count: '0' }), 'unknown');
  });

  it('treats a transport failure as unknown', async () => {
    const result = await probeCountrySourceAbsence('BEL', refMap('port57'), {
      fetchFn: async () => { throw new TypeError('fetch failed'); },
    });
    assert.equal(result, 'unknown');
  });

  it('cannot prove absence without reference ports or with an unsafe port id', async () => {
    let called = false;
    const fetchFn = async () => { called = true; return jsonResponse({ count: 0 }); };
    assert.equal(await probeCountrySourceAbsence('BEL', new Map(), { fetchFn }), 'unknown');
    assert.equal(await probeCountrySourceAbsence('BEL', refMap("port1') OR (1=1"), { fetchFn }), 'unknown');
    assert.equal(called, false);
  });
});

describe('selectSourceAbsentCountries', () => {
  const probes = new Map([['BE', 'absent'], ['HK', 'absent'], ['US', 'present'], ['QA', 'unknown']]);

  it('keeps only explicit absences while the table is populated', () => {
    const result = selectSourceAbsentCountries({ probes, tablePopulated: true });
    assert.deepEqual(result, { absent: ['BE', 'HK'], suppressed: null });
  });

  it('trusts no absence when no country observed a max date this run', () => {
    const result = selectSourceAbsentCountries({ probes, tablePopulated: false });
    assert.deepEqual(result.absent, []);
    assert.equal(result.suppressed, 'table_unobserved');
  });

  it('fails closed above the cap instead of shrinking the dataset', () => {
    const many = new Map(
      Array.from({ length: MAX_SOURCE_ABSENT_COUNTRIES + 1 }, (_, i) => [`X${i}`, 'absent']),
    );
    const result = selectSourceAbsentCountries({ probes: many, tablePopulated: true });
    assert.deepEqual(result.absent, []);
    assert.equal(result.suppressed, 'over_cap');
  });
});

describe('coverage with source-absent countries', () => {
  const eligible = ['BE', 'HK', 'US', 'GB'];
  const published = new Map([['US', { iso2: 'US' }], ['GB', { iso2: 'GB' }]]);

  it('drops absent countries from the target and the missing list, and names them', () => {
    const coverage = buildCoverageReport({
      eligibleCountries: eligible,
      // The prior canonical list still names them.
      expectedCountries: ['BE', 'HK', 'US', 'GB'],
      countryData: published,
      sourceAbsentCountries: ['BE', 'HK'],
    });
    assert.equal(coverage.target, PORTWATCH_PORT_ACTIVITY_TARGET_COUNTRIES - 2);
    assert.equal(coverage.referenceCountryCount, 2);
    assert.deepEqual(coverage.sourceAbsentCountries, ['BE', 'HK']);
    assert.ok(!coverage.missingCountries.includes('BE'));
    assert.ok(!coverage.missingCountries.includes('HK'));
  });

  it('defaults to no absent countries', () => {
    const coverage = buildCoverageReport({ eligibleCountries: eligible, countryData: published });
    assert.equal(coverage.target, PORTWATCH_PORT_ACTIVITY_TARGET_COUNTRIES);
    assert.deepEqual(coverage.sourceAbsentCountries, []);
  });

  it('advances the canonical list once every source-present country is usable', () => {
    const absent = Array.from({ length: 26 }, (_, i) => `A${i}`);
    const present = PORTWATCH_PORT_ACTIVITY_TARGET_COUNTRIES - absent.length;
    const countryData = new Map(Array.from({ length: present }, (_, i) => [`P${i}`, {}]));
    const coverage = buildCoverageReport({
      eligibleCountries: [...countryData.keys(), ...absent],
      countryData,
      sourceAbsentCountries: absent,
    });
    assert.equal(coverage.complete, true);
    assert.equal(shouldAdvanceCanonicalForRun({
      countryCount: countryData.size,
      referenceCountryCount: coverage.referenceCountryCount,
      upstreamContactCount: 1,
      coverage,
    }), true);
  });

  it('still refuses a shrunken reference that no absence proof accounts for', () => {
    const countryData = new Map(Array.from({ length: 148 }, (_, i) => [`P${i}`, {}]));
    const coverage = buildCoverageReport({
      eligibleCountries: [...countryData.keys()],
      countryData,
    });
    assert.equal(shouldAdvanceCanonicalForRun({
      countryCount: countryData.size,
      referenceCountryCount: coverage.referenceCountryCount,
      upstreamContactCount: 1,
      coverage,
    }), false);
  });
});

describe('content freshness with a source-absent critical country', () => {
  const now = Date.parse('2026-11-02T12:00:00Z');
  const countryData = new Map([['CN', { contentAsOfChangedAt: now - 60_000 }]]);
  const requirement = { countries: ['CN', 'HK'], budgetMinutes: 10 * 24 * 60 };

  it('reports HK as source-absent instead of stale or missing', () => {
    const report = buildContentFreshnessReport({ countryData, now, sourceAbsentCountries: ['HK'] });
    assert.deepEqual(report.criticalCountries, ['CN']);
    assert.deepEqual(report.criticalSourceAbsentCountries, ['HK']);
    assert.deepEqual(report.criticalStaleCountries, []);
    assert.equal(report.criticalMissingCountries, 0);
  });

  it('carries the coverage absence list into the meta block', () => {
    const meta = buildPortActivityMetaPayload({
      countryData,
      coverage: { sourceAbsentCountries: ['HK', 'BE'] },
      now,
    });
    assert.deepEqual(meta.contentFreshness.criticalSourceAbsentCountries, ['HK']);
  });

  it('health accepts the narrowed scope only for a declared source-absent country', () => {
    const declared = buildContentFreshnessAssessment({
      contentFreshness: buildContentFreshnessReport({ countryData, now, sourceAbsentCountries: ['HK'] }),
    }, requirement, now);
    assert.equal(declared.usable, true, declared.unusableReasons.join(','));
    assert.deepEqual(declared.criticalSourceAbsentCountries, ['HK']);

    const narrowedSilently = buildContentFreshnessAssessment({
      contentFreshness: buildContentFreshnessReport({ countryData, now, criticalCountries: ['CN'] }),
    }, requirement, now);
    assert.equal(narrowedSilently.usable, false);
    assert.ok(narrowedSilently.unusableReasons.includes('declared_scope_narrowed'));
  });

  it('health rejects a country listed both as critical and as source-absent', () => {
    const report = buildContentFreshnessReport({ countryData, now });
    const assessment = buildContentFreshnessAssessment({
      contentFreshness: { ...report, criticalSourceAbsentCountries: ['CN'] },
    }, requirement, now);
    assert.equal(assessment.usable, false);
    assert.ok(assessment.unusableReasons.includes('source_absent_overlaps_critical'));
  });
});
