import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CHINA_NO2_ACTIVITY_METHOD,
  CHINA_NO2_ACTIVITY_METHOD_VERSION,
  CHINA_NO2_REGIONS,
  validateChinaNo2ActivityPayload,
} from '../scripts/shared/china-no2-activity.mjs';
import {
  CDSE_STATISTICS_URL,
  CDSE_TOKEN_URL,
  EVALSCRIPT,
  baselineWindow,
  buildStatisticsRequest,
  compositeOf,
  currentWindow,
  makeFetchAll,
  parseStatisticsResponse,
  regionResult,
  summarizeWindow,
} from '../scripts/seed-china-no2-activity.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/china-no2/statistics-jing-jin-ji-offl-2026-10.json', import.meta.url), 'utf8'));
const METHOD = CHINA_NO2_ACTIVITY_METHOD;
const JJJ = CHINA_NO2_REGIONS[0];
const DAY_MS = 86_400_000;

function rows(entries) {
  return new Map(entries.map(([date, mean, validFraction]) => [date, { date, mean, validFraction }]));
}

function window(windowStart, windowEnd, mean, validDays = 20) {
  return {
    windowStart,
    windowEnd,
    validDays,
    maskedDays: 0,
    meanNo2MolM2: validDays === 0 ? null : mean,
    meanValidFraction: validDays === 0 ? null : 0.5,
  };
}

function baselineYears(means, validDays = 20) {
  return means.map((mean, index) => ({
    year: 2025 - index,
    ...window(`${2025 - index}-08-29`, `${2025 - index}-10-23`, mean, validDays),
  }));
}

describe('seed-china-no2-activity request builder', () => {
  it('asks the Statistical API for daily OFFL NO2 at QA 75 over the region bbox with an exclusive end', () => {
    const body = buildStatisticsRequest(JJJ, { from: '2026-08-29', to: '2026-10-24' });
    assert.deepEqual(body.input.bounds.bbox, [114, 36, 119, 41]);
    assert.equal(body.input.bounds.properties.crs, 'http://www.opengis.net/def/crs/OGC/1.3/CRS84');
    assert.deepEqual(body.input.data, [{
      type: 'sentinel-5p-l2',
      dataFilter: { timeliness: 'OFFL' },
      processing: { minQa: 75 },
    }]);
    assert.deepEqual(body.aggregation.timeRange, { from: '2026-08-29T00:00:00Z', to: '2026-10-24T00:00:00Z' });
    assert.deepEqual(body.aggregation.aggregationInterval, { of: 'P1D' });
    assert.equal(body.aggregation.resx, 0.05);
    assert.equal(body.aggregation.resy, 0.05);
    assert.equal(body.aggregation.evalscript, EVALSCRIPT);
    assert.match(EVALSCRIPT, /bands: \["NO2", "dataMask"\]/);
    assert.match(EVALSCRIPT, /id: "no2", bands: 1, sampleType: "FLOAT32"/);
    assert.match(EVALSCRIPT, /id: "dataMask", bands: 1/);
    assert.equal(Object.isFrozen(body.input.bounds.bbox), false);
  });
});

describe('seed-china-no2-activity calendar', () => {
  it('ends the current window windowEndLagDays before the UTC run date and spans windowDays', () => {
    const current = currentWindow(Date.parse('2026-10-26T06:20:00Z'));
    assert.equal(current.windowEnd, '2026-10-23');
    assert.equal(current.windowStart, '2026-08-29');
    assert.equal(current.dates.length, METHOD.windowDays);
    assert.deepEqual(current.range, { from: '2026-08-29', to: '2026-10-24' });
    assert.equal(currentWindow(Date.parse('2026-10-26T23:59:59Z')).windowEnd, '2026-10-23');
  });

  it('maps the same month-day span to each baseline year', () => {
    const current = currentWindow(Date.parse('2026-10-26T06:20:00Z'));
    const baseline = baselineWindow(current, 2);
    assert.equal(baseline.year, 2024);
    assert.equal(baseline.windowStart, '2024-08-29');
    assert.equal(baseline.windowEnd, '2024-10-23');
    assert.deepEqual(baseline.range, { from: '2024-08-29', to: '2024-10-24' });
  });

  it('drops Feb 29 when the baseline year has none', () => {
    const current = currentWindow(Date.parse('2028-03-03T06:20:00Z'));
    assert.equal(current.windowEnd, '2028-02-29');
    const baseline = baselineWindow(current, 1);
    assert.equal(baseline.year, 2027);
    assert.equal(baseline.windowEnd, '2027-02-28');
    assert.equal(baseline.dates.includes('2027-02-29'), false);
    assert.equal(baseline.dates.length, METHOD.windowDays - 1);
    assert.deepEqual(baseline.range, { from: baseline.windowStart, to: '2027-03-01' });
    assert.equal(baselineWindow(current, 4).windowEnd, '2024-02-29');
  });

  it('names a year-spanning baseline window by its end year', () => {
    const current = currentWindow(Date.parse('2026-01-20T00:00:00Z'));
    assert.equal(current.windowStart, '2025-11-23');
    const baseline = baselineWindow(current, 1);
    assert.equal(baseline.year, 2025);
    assert.equal(baseline.windowStart, '2024-11-23');
    assert.equal(baseline.windowEnd, '2025-01-17');
  });
});

describe('seed-china-no2-activity response parsing', () => {
  it('reads the recorded OFFL response into one row per day', () => {
    const parsed = parseStatisticsResponse(FIXTURE.response);
    assert.equal(parsed.size, 29);
    const first = parsed.get('2026-09-26');
    assert.equal(first.mean, 5.0234815305675796e-05);
    assert.equal(first.validFraction, 0.2478);
    const cloudy = parsed.get('2026-10-24');
    assert.equal(cloudy.mean, null);
    assert.equal(cloudy.validFraction, 0);
  });

  it('treats a day without outputs or with zero samples as invalid', () => {
    const parsed = parseStatisticsResponse({
      data: [
        { interval: { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' }, error: { type: 'EXECUTION_ERROR' } },
        {
          interval: { from: '2026-10-02T00:00:00Z', to: '2026-10-03T00:00:00Z' },
          outputs: { no2: { bands: { B0: { stats: { mean: 1e-4, sampleCount: 0, noDataCount: 0 } } } } },
        },
      ],
    });
    assert.deepEqual(parsed.get('2026-10-01'), { date: '2026-10-01', mean: null, validFraction: null });
    assert.deepEqual(parsed.get('2026-10-02'), { date: '2026-10-02', mean: null, validFraction: null });
    assert.throws(() => parseStatisticsResponse({ status: 'OK' }), /no data array/);
  });
});

describe('seed-china-no2-activity window summary', () => {
  it('gates days at the minimum valid fraction boundary', () => {
    const summary = summarizeWindow(rows([
      ['2026-10-01', 1e-4, 0.19],
      ['2026-10-02', 2e-4, 0.2],
      ['2026-10-03', 4e-4, 0.6],
      ['2026-10-04', null, 0.9],
    ]), '2026-10-01', '2026-10-05');
    assert.equal(summary.windowStart, '2026-10-01');
    assert.equal(summary.windowEnd, '2026-10-05');
    assert.equal(summary.validDays, 2);
    assert.equal(summary.maskedDays, 0);
    assert.ok(Math.abs(summary.meanNo2MolM2 - 3e-4) < 1e-15);
    assert.ok(Math.abs(summary.meanValidFraction - 0.4) < 1e-12);
  });

  it('masks Lunar New Year days even when they carry valid data', () => {
    const summary = summarizeWindow(rows([
      ['2026-02-09', 1e-4, 0.5],
      ['2026-02-10', 9e-4, 0.5],
      ['2026-03-03', 9e-4, 0.5],
      ['2026-03-04', 3e-4, 0.5],
    ]), '2026-02-09', '2026-03-04');
    assert.equal(summary.maskedDays, 22);
    assert.equal(summary.validDays, 2);
    assert.ok(Math.abs(summary.meanNo2MolM2 - 2e-4) < 1e-15);
  });

  it('reports null means when no day is valid', () => {
    const summary = summarizeWindow(new Map(), '2026-10-01', '2026-10-03');
    assert.deepEqual(summary, {
      windowStart: '2026-10-01',
      windowEnd: '2026-10-03',
      validDays: 0,
      maskedDays: 0,
      meanNo2MolM2: null,
      meanValidFraction: null,
    });
  });
});

describe('seed-china-no2-activity region result', () => {
  const current = (mean, validDays = 20) => window('2026-08-29', '2026-10-23', mean, validDays);

  it('computes the change against the mean of the eligible baseline years', () => {
    const result = regionResult(JJJ, { current: current(1.2e-4), years: baselineYears([1e-4, 1.1e-4, 0.9e-4]) });
    assert.equal(result.exclusion, null);
    assert.ok(Math.abs(result.baseline.meanNo2MolM2 - 1e-4) < 1e-15);
    assert.ok(Math.abs(result.changePercent - 20) < 1e-9);
    assert.deepEqual(result.bbox, [114, 36, 119, 41]);
    assert.equal(result.id, JJJ.id);
    assert.equal(result.label, JJJ.label);
    assert.equal(result.baseline.years.length, 3);
  });

  it('drops baseline years below the minimum valid days but still lists them', () => {
    const years = baselineYears([1e-4, 3e-4, 1.5e-4]);
    years[1] = { ...years[1], validDays: METHOD.minValidDays - 1 };
    const result = regionResult(JJJ, { current: current(1.5e-4), years });
    assert.equal(result.exclusion, null);
    assert.ok(Math.abs(result.baseline.meanNo2MolM2 - 1.25e-4) < 1e-15);
    assert.ok(Math.abs(result.changePercent - 20) < 1e-9);
    assert.deepEqual(result.baseline.years.map((year) => year.year), [2025, 2024, 2023]);
  });

  it('excludes a region whose current window has too few valid days', () => {
    const result = regionResult(JJJ, { current: current(1.2e-4, METHOD.minValidDays - 1), years: baselineYears([1e-4, 1e-4, 1e-4]) });
    assert.equal(result.exclusion, 'insufficient_valid_days');
    assert.equal(result.changePercent, null);
    assert.ok(Math.abs(result.baseline.meanNo2MolM2 - 1e-4) < 1e-15);
    assert.equal(regionResult(JJJ, { current: current(1.2e-4, METHOD.minValidDays), years: baselineYears([1e-4, 1e-4, 1e-4]) }).exclusion, null);
  });

  it('excludes a region with fewer eligible baseline years than required', () => {
    const years = baselineYears([1e-4, 1e-4, 1e-4]);
    years[0] = { ...years[0], validDays: 0, meanNo2MolM2: null, meanValidFraction: null };
    years[2] = { ...years[2], validDays: 3 };
    const result = regionResult(JJJ, { current: current(1.2e-4), years });
    assert.equal(result.exclusion, 'insufficient_baseline_years');
    assert.equal(result.changePercent, null);
    assert.equal(result.baseline.meanNo2MolM2, null);
    assert.equal(result.baseline.years.length, 3);
  });

  it('excludes a region whose baseline mean is not positive', () => {
    const result = regionResult(JJJ, { current: current(1e-4), years: baselineYears([0, 0, 0]) });
    assert.equal(result.exclusion, 'insufficient_baseline_years');
    assert.equal(result.baseline.meanNo2MolM2, null);
  });

  it('marks a failed region request_failed with an empty current window', () => {
    const result = regionResult(JJJ, {
      current: null,
      currentSpan: { windowStart: '2026-08-29', windowEnd: '2026-10-23' },
      years: baselineYears([1e-4, 1e-4]),
      requestFailed: true,
    });
    assert.equal(result.exclusion, 'request_failed');
    assert.equal(result.changePercent, null);
    assert.deepEqual(result.current, window('2026-08-29', '2026-10-23', null, 0));
    assert.equal(result.baseline.years.length, 2);
    assert.equal(result.baseline.meanNo2MolM2, null);
  });
});

describe('seed-china-no2-activity composite', () => {
  const region = (id, changePercent) => ({ id, changePercent, exclusion: changePercent === null ? 'insufficient_valid_days' : null });

  it('takes the median of eligible regions in registry order', () => {
    assert.deepEqual(compositeOf([region('a', 30), region('b', null), region('c', 12), region('d', 18)]), {
      changePercent: 18,
      signalValue: 18,
      regionIds: ['a', 'c', 'd'],
      exclusion: null,
    });
    const even = compositeOf([region('a', 30), region('b', 10), region('c', 12), region('d', 18)]);
    assert.equal(even.changePercent, 15);
  });

  it('zeroes the signal inside the dead band and keeps it at the edge', () => {
    assert.equal(compositeOf([region('a', 9.9), region('b', 9.9)]).signalValue, 0);
    assert.equal(compositeOf([region('a', -9.9), region('b', -9.9)]).signalValue, 0);
    assert.equal(compositeOf([region('a', 10), region('b', 10)]).signalValue, 10);
    assert.equal(compositeOf([region('a', -12), region('b', -14)]).signalValue, -13);
  });

  it('excludes the composite with fewer than minRegions eligible regions', () => {
    assert.deepEqual(compositeOf([region('a', 30), region('b', null), region('c', null), region('d', null)]), {
      changePercent: null,
      signalValue: null,
      regionIds: ['a'],
      exclusion: 'insufficient_regions',
    });
  });
});

const FIXTURE_STATS = FIXTURE.response.data.map((row) => row.outputs.no2.bands.B0.stats);

/**
 * A Statistical API stub: each requested day reuses a recorded day's stats
 * (cycled), with the mean scaled per year so the current year reads `change`
 * percent above every baseline year.
 */
function stubFetch({ change = 20, fail = () => false, pu = '1.25' } = {}) {
  const calls = { token: 0, statistics: [] };
  const fetchImpl = async (url, init) => {
    assert.match(init.headers['User-Agent'], /^WorldMonitor seed-china-no2-activity/);
    if (url === CDSE_TOKEN_URL) {
      calls.token++;
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('grant_type'), 'client_credentials');
      assert.equal(form.get('client_id'), 'id');
      assert.equal(form.get('client_secret'), 'secret');
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 1800 }), { status: 200 });
    }
    assert.equal(url, CDSE_STATISTICS_URL);
    assert.equal(init.headers.Authorization, 'Bearer tok');
    const body = JSON.parse(init.body);
    calls.statistics.push(body);
    if (fail(body)) return new Response('{"error":"boom"}', { status: 503 });
    const fromMs = Date.parse(body.aggregation.timeRange.from);
    const toMs = Date.parse(body.aggregation.timeRange.to);
    const factor = new Date(toMs - DAY_MS).getUTCFullYear() === 2026 ? 1 + change / 100 : 1;
    const data = [];
    for (let ms = fromMs, index = 0; ms < toMs; ms += DAY_MS, index++) {
      const stats = FIXTURE_STATS[index % FIXTURE_STATS.length];
      data.push({
        interval: { from: new Date(ms).toISOString().replace('.000', ''), to: new Date(ms + DAY_MS).toISOString().replace('.000', '') },
        outputs: { no2: { bands: { B0: { stats: { ...stats, mean: typeof stats.mean === 'number' ? stats.mean * factor : stats.mean } } } } },
      });
    }
    return new Response(JSON.stringify({ data, status: 'OK' }), { status: 200, headers: { 'x-processingunits-spent': pu } });
  };
  return { fetchImpl, calls };
}

const NOW = Date.parse('2026-10-26T06:20:00Z');
const fetchAllWith = (fetchImpl) => makeFetchAll({
  fetchImpl,
  clientId: 'id',
  clientSecret: 'secret',
  now: () => NOW,
  retryDelayMs: 0,
  log: () => {},
});

describe('seed-china-no2-activity fetchAll', () => {
  it('publishes a validated payload from 16 statistics requests', async () => {
    const { fetchImpl, calls } = stubFetch();
    const payload = await fetchAllWith(fetchImpl)();
    assert.equal(validateChinaNo2ActivityPayload(payload), true);
    assert.equal(calls.token, 1);
    assert.equal(calls.statistics.length, 16);
    assert.equal(payload.methodVersion, CHINA_NO2_ACTIVITY_METHOD_VERSION);
    assert.equal(payload.generatedAt, '2026-10-26T06:20:00.000Z');
    assert.deepEqual(payload.method, { ...METHOD, holidayMask: { ...METHOD.holidayMask } });
    assert.equal(Object.isFrozen(payload.method), false);
    assert.equal(payload.source.requestCount, 16);
    assert.ok(Math.abs(payload.source.processingUnitsSpent - 20) < 1e-9);
    assert.equal(payload.source.attribution, 'Contains modified Copernicus Sentinel data 2023-2026');
    for (const region of payload.regions) {
      assert.equal(region.exclusion, null, region.id);
      assert.ok(Math.abs(region.changePercent - 20) < 1e-6, region.id);
      assert.equal(region.current.windowEnd, '2026-10-23');
      assert.deepEqual(region.baseline.years.map((year) => year.year), [2025, 2024, 2023]);
    }
    assert.ok(Math.abs(payload.composite.signalValue - 20) < 1e-6);
    assert.deepEqual(payload.composite.regionIds, CHINA_NO2_REGIONS.map((region) => region.id));
  });

  it('publishes per-region request_failed when one region keeps failing', async () => {
    const { fetchImpl, calls } = stubFetch({ fail: (body) => body.input.bounds.bbox[0] === 112.5 });
    const payload = await fetchAllWith(fetchImpl)();
    assert.equal(validateChinaNo2ActivityPayload(payload), true);
    const failed = payload.regions.find((region) => region.id === 'pearl-river-delta');
    assert.equal(failed.exclusion, 'request_failed');
    assert.equal(failed.current.validDays, 0);
    assert.deepEqual(failed.baseline.years, []);
    assert.deepEqual(payload.composite.regionIds, ['jing-jin-ji', 'yangtze-river-delta', 'shandong']);
    assert.equal(calls.statistics.length, 12 + 4 * 3);
    assert.equal(payload.source.requestCount, 24);
    assert.ok(Math.abs(payload.source.processingUnitsSpent - 12 * 1.25) < 1e-9);
  });

  it('throws a preservable failure when every region fails', async () => {
    const { fetchImpl } = stubFetch({ fail: () => true });
    await assert.rejects(fetchAllWith(fetchImpl)(), (error) => {
      assert.equal(error.preservableFetchFailure, true);
      assert.match(error.message, /every region/);
      return true;
    });
  });

  it('throws a preservable failure when the token endpoint is down', async () => {
    const fetchImpl = async () => new Response('down', { status: 502 });
    await assert.rejects(fetchAllWith(fetchImpl)(), (error) => error.preservableFetchFailure === true);
  });
});
