import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildChinaMacroSnapshot, fetchShanghaiM2Observation, parseShanghaiM2Release } from '../scripts/china-macro/adapters.mjs';
import { validateChinaMacroSnapshot } from '../scripts/seed-china-macro.mjs';
import {
  normalizeChinaMacroObservation,
  normalizeChinaMacroObservations,
  normalizeChinaMacroPreflight,
  validateChinaMacroAvailabilityBindings,
} from '../shared/china-macro-normalization';
import { buildOfficialChinaMacroFixture } from './helpers/china-macro-fixture.mjs';
import * as shared from '../shared/china-macro-contract.js';
import * as railway from '../scripts/_china-macro-contract.mjs';

const fixture = (name: string) => readFileSync(new URL(`fixtures/china-macro/${name}`, import.meta.url), 'utf8');
const augustUrl = 'https://jrj.sh.gov.cn/SCGK194/20260915/8b8f76bb432e4c4b8aa290646d19231b.html';
const septemberUrl = 'https://jrj.sh.gov.cn/SCGK194/20261015/24a15f78c09947de9eb58a48c2fdb451.html';
const retrievalTime = '2026-10-24T10:20:00.000Z';
const now = Date.parse(retrievalTime);
function sourceFetch({ robots = new Response('', { status: 404 }), page = fixture('shanghai-m2-september.html'), calls = [] as string[] } = {}) {
  return async (url: string) => {
    calls.push(url);
    if (url === 'https://jrj.sh.gov.cn/robots.txt') return robots;
    if (url === 'https://jrj.sh.gov.cn/SCGK194/index.html') return new Response(fixture('shanghai-m2-list.html'));
    if (url === septemberUrl) return new Response(page);
    throw new Error(`Unexpected source request ${url}`);
  };
}

describe('Shanghai official M2 republication', () => {
  it('binds August growth, exact source credit and the republication date without inventing a release time', () => {
    const row = parseShanghaiM2Release(fixture('shanghai-m2-august.html'), { sourceUrl: augustUrl, retrievalTime });
    assert.equal(row.value, 7.5);
    assert.equal(row.observationPeriod, '2026-08');
    assert.equal(row.releaseTime, '2026-09-15');
    assert.equal(row.releasePrecision, 'day');
    assert.equal(row.source, 'People’s Bank of China via Shanghai Financial Portal');
    assert.equal(row.provenance.claims.publisher.value.id, 'publisher:shanghai-finance-cn');
    assert.equal(row.provenance.claims.publication_time.value.precision, 'day');
    assert.equal(row.provenance.claims.source_url.value, augustUrl);
    assert.equal(row.stale, true, 'a successful new retrieval does not refresh August content');
    assert.ok(normalizeChinaMacroObservation(row, now));
  });

  it('discovers the subsequent quarter report as September monthly M2 using three bounded HTTPS reads', async () => {
    const calls: string[] = [];
    const result = await fetchShanghaiM2Observation({ now, fetchFn: sourceFetch({ calls }) });
    assert.equal(result.observation.value, 7.2);
    assert.equal(result.observation.observationPeriod, '2026-09');
    assert.equal(result.observation.releaseTime, '2026-10-15');
    assert.equal(result.observation.stale, false);
    assert.equal(result.observation.sourceUrl, septemberUrl);
    assert.equal(result.decision.status, 'accepted');
    assert.equal(result.decision.robotsStatus, 'no_rules_published');
    assert.equal(result.decision.requestCount, 3);
    assert.equal(calls.length, 3);
    assert.ok(normalizeChinaMacroObservation(result.observation, now));
  });

  it('rejects changed attribution, missing date, wrong period and non-M2 text', () => {
    const original = fixture('shanghai-m2-august.html');
    for (const html of [
      original.replaceAll('中国人民银行', 'another source'),
      original.replaceAll('2026年09月15日', '').replaceAll('2026-09-15', ''),
      original.replace('2026年8月金融统计数据报告', '2026年7月金融统计数据报告'),
      original.replaceAll('(M2)', '(M1)'),
    ]) assert.throws(() => parseShanghaiM2Release(html, { sourceUrl: augustUrl, retrievalTime }), /MALFORMED_RELEASE/);
  });

  it('stops before article reads on an actual robots denial or insecure redirect', async () => {
    for (const robots of [
      new Response('User-agent: *\nDisallow: /SCGK194/\n'),
      new Response('', { status: 302, headers: { Location: 'http://jrj.sh.gov.cn/' } }),
    ]) {
      const calls: string[] = [];
      const result = await fetchShanghaiM2Observation({ now, fetchFn: sourceFetch({ robots, calls }) });
      assert.equal(result.decision.status, 'blocked');
      assert.equal(result.observation.value, null);
      assert.equal(result.observation.provenance, null);
      assert.equal(calls.length, 1);
    }
  });

  it('retains the successful observation and clocks after a source failure', async () => {
    const previous = parseShanghaiM2Release(fixture('shanghai-m2-september.html'), { sourceUrl: septemberUrl, retrievalTime });
    const result = await fetchShanghaiM2Observation({
      now: now + 86_400_000,
      previousObservation: previous,
      fetchFn: sourceFetch({ page: '<html>broken report</html>' }),
    });
    assert.equal(result.observation.value, 7.2);
    assert.equal(result.observation.retrievalTime, retrievalTime);
    assert.equal(result.observation.releaseTime, '2026-10-15');
    assert.equal(result.observation.transportStatus, 'error');
    assert.equal(result.observation.transportFailureReason, 'SCHEMA_DRIFT');
    assert.equal(result.observation.provenance.claims.transport_freshness.value.lastSuccessAt, retrievalTime);
  });

  it('accepts the new binding only with its publisher preflight and preserves old stored payloads', async () => {
    const legacy = await buildOfficialChinaMacroFixture();
    const oldM2 = legacy.observations.find((row: { seriesId: string }) => row.seriesId === 'pboc_m2_yoy');
    const { source: directSource, sourceHost } = shared.CHINA_MACRO_SERIES_CONTRACT.pboc_m2_yoy;
    Object.assign(oldM2, { source: directSource, sourceUrl: `https://${sourceHost}/`, unavailableReason: 'ROBOTS_DISALLOW', transportFailureReason: 'ROBOTS_DISALLOW' });
    legacy.sourceDecisions = legacy.sourceDecisions.filter((row: { publisherId: string }) => row.publisherId !== 'publisher:shanghai-finance-cn');
    const legacyNow = Date.parse(legacy.generatedAt);
    assert.ok(normalizeChinaMacroObservations(legacy.observations, legacyNow, legacy.generatedAt));
    const oldDecisions = normalizeChinaMacroPreflight(legacy.sourceDecisions, legacy.generatedAt, legacyNow);
    assert.ok(oldDecisions);
    assert.equal(validateChinaMacroAvailabilityBindings(legacy.observations, oldDecisions), true);

    const { observation, decision } = await fetchShanghaiM2Observation({ now, fetchFn: sourceFetch() });
    const rows = legacy.observations.map((row: { seriesId: string }) => row.seriesId === observation.seriesId ? observation : row);
    const decisions = normalizeChinaMacroPreflight([...legacy.sourceDecisions.map((d: object) => ({ ...d, checkedAt: retrievalTime })), decision], retrievalTime, now);
    assert.ok(decisions);
    assert.equal(validateChinaMacroAvailabilityBindings(rows, decisions), true);
    assert.equal(validateChinaMacroAvailabilityBindings(rows, oldDecisions), false);
    const forged = structuredClone(observation);
    forged.provenance.claims.publisher.value.id = 'publisher:pboc-cn';
    assert.equal(normalizeChinaMacroObservation(forged, now), null);
    const wrongSeries = structuredClone(observation);
    wrongSeries.seriesId = 'pboc_new_rmb_loans';
    assert.equal(normalizeChinaMacroObservation(wrongSeries, now), null);
  });

  it('keeps the new source descriptor and freshness boundary identical in both runtimes', () => {
    assert.deepEqual(shared.CHINA_MACRO_M2_REPUBLICATION, railway.CHINA_MACRO_M2_REPUBLICATION);
    for (const at of [Date.parse('2026-10-20T23:59:59Z'), Date.parse('2026-10-21T00:00:00Z')]) {
      assert.equal(shared.isChinaMacroObservationStale('pboc_m2_yoy', '2026-08', at), railway.isChinaMacroObservationStale('pboc_m2_yoy', '2026-08', at));
    }
    assert.equal(shared.isChinaMacroObservationStale('pboc_m2_yoy', '2026-08', Date.parse('2026-10-20T23:59:59Z')), false);
    assert.equal(shared.isChinaMacroObservationStale('pboc_m2_yoy', '2026-08', Date.parse('2026-10-21T00:00:00Z')), true);
    assert.equal(shared.isChinaMacroObservationStale('pboc_m2_yoy', '2026-06', Date.parse('2026-08-17T23:59:59Z') + 36 * 3_600_000), false);
  });

  it('publishes and reads the new source with all producer and reader bindings intact', async () => {
    const base = await buildOfficialChinaMacroFixture(now);
    const { observation, decision } = await fetchShanghaiM2Observation({ now, fetchFn: sourceFetch() });
    const snapshot = buildChinaMacroSnapshot({
      observations: base.observations.map((row: { seriesId: string }) => row.seriesId === 'pboc_m2_yoy' ? observation : row),
      sourceDecisions: base.sourceDecisions.map((row: { publisherId: string }) => row.publisherId === decision.publisherId ? decision : row),
      generatedAt: retrievalTime,
    });
    assert.equal(validateChinaMacroSnapshot(snapshot, now), true);
    assert.ok(normalizeChinaMacroObservations(snapshot.observations, now, retrievalTime));
    const decisions = normalizeChinaMacroPreflight(snapshot.sourceDecisions, retrievalTime, now);
    assert.ok(decisions);
    assert.equal(validateChinaMacroAvailabilityBindings(snapshot.observations, decisions), true);
    const forged = structuredClone(snapshot);
    forged.sourceDecisions.find((row: { publisherId: string }) => row.publisherId === decision.publisherId).robotsStatus = 'unavailable';
    assert.equal(validateChinaMacroSnapshot(forged, now), false);
    assert.equal(normalizeChinaMacroPreflight(forged.sourceDecisions, retrievalTime, now), null);
    const listingSource = structuredClone(snapshot);
    const m2 = listingSource.observations.find((row: { seriesId: string }) => row.seriesId === 'pboc_m2_yoy');
    for (const row of [m2, ...m2.vintages]) {
      row.sourceUrl = 'https://jrj.sh.gov.cn/SCGK194/index.html';
      row.provenance.claims.source_url.value = row.sourceUrl;
    }
    assert.equal(validateChinaMacroSnapshot(listingSource, now), false);
    assert.equal(normalizeChinaMacroObservation(m2, now), null);
  });

  it('rejects unreviewed source paths and hosts before issuing a request', async () => {
    for (const target of ['http://jrj.sh.gov.cn/private', 'https://example.com/article', 'https://jrj.sh.gov.cn/not-reviewed/article']) {
      const calls: string[] = [];
      const result = await fetchShanghaiM2Observation({ now, fetchFn: async (url: string) => {
        calls.push(url);
        if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
        if (url.endsWith('/SCGK194/index.html')) return new Response(`<a href="${target}">2026年9月金融统计数据报告</a>`);
        throw new Error('Unreviewed request escaped guard');
      } });
      assert.equal(result.observation.value, null);
      assert.equal(result.decision.reason, 'UNAPPROVED_URL');
      assert.equal(calls.length, 2);
    }
  });

  it('keeps same-period corrections as distinct vintages and rejects unreviewed reader URLs', () => {
    const html = fixture('shanghai-m2-september.html');
    const original = parseShanghaiM2Release(html, { sourceUrl: septemberUrl, retrievalTime });
    const revised = parseShanghaiM2Release(html.replace('7.2%', '7.1%'), { sourceUrl: septemberUrl, retrievalTime: '2026-10-25T10:20:00.000Z', previousObservation: original });
    assert.equal(revised.revisionSequence, 2);
    assert.equal(revised.vintages[0].value, 7.2);
    assert.equal(revised.value, 7.1);
    assert.ok(normalizeChinaMacroObservation(revised, now + 86_400_000));
    for (const url of ['https://jrj.sh.gov.cn/SCGK194/not-reviewed', septemberUrl.replace('https:', 'http:'), septemberUrl.replace('jrj.sh.gov.cn', 'jrj.sh.gov.cn:444')]) {
      const forged = structuredClone(original);
      forged.sourceUrl = url;
      assert.equal(normalizeChinaMacroObservation(forged, now), null);
    }
  });

  it('rejects mismatched publisher names and registry sources on observations and vintages', () => {
    const original = parseShanghaiM2Release(fixture('shanghai-m2-september.html'), { sourceUrl: septemberUrl, retrievalTime });
    for (const target of ['observation', 'vintage']) {
      for (const field of ['name', 'registrySource']) {
        const forged = structuredClone(original);
        const publisher = (target === 'observation' ? forged : forged.vintages[0]).provenance.claims.publisher.value;
        if (field === 'name') publisher.name = 'Another government publisher';
        else publisher.registryReference.sourceName = 'NBS (China)';
        assert.equal(normalizeChinaMacroObservation(forged, now), null, `${target} must bind publisher ${field}`);
      }
    }
  });

  it('rejects contradictory decline signs and preserves valid negative growth', () => {
    const html = fixture('shanghai-m2-september.html');
    const options = { sourceUrl: septemberUrl, retrievalTime };
    assert.throws(() => parseShanghaiM2Release(html.replace('同比增长7.2%', '同比下降-7.2%'), options), /MALFORMED_RELEASE:SHANGHAI_M2_CONTRADICTORY_SIGN/);
    assert.equal(parseShanghaiM2Release(html.replace('同比增长7.2%', '同比下降7.2%'), options).value, -7.2);
    assert.equal(parseShanghaiM2Release(html.replace('同比增长7.2%', '同比增长-7.2%'), options).value, -7.2);
  });
});
