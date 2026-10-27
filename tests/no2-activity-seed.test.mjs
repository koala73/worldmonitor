import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CDSE_STATISTICS_URL,
  CDSE_TOKEN_URL,
  backfillQueue,
  baselineWindow,
  buildStatisticsRequest,
  currentWindow,
  declareRecords,
  emptySeries,
  makeFetchAll,
  mergeSeries,
  neededYears,
  parseSeries,
  parseStatisticsResponse,
  pendingRecord,
  publishNo2Atomically,
  refreshRange,
  regionResult,
  summarizeWindow,
  windowYears,
  yearChunks,
} from '../scripts/seed-no2-activity.mjs';
import {
  NO2_ACTIVITY_METHOD,
  NO2_ACTIVITY_ACTIVATION_KEY,
  NO2_ACTIVITY_MAX_REFRESH_AGE_MS,
  NO2_ACTIVITY_SERIES_KEY_PREFIX,
  NO2_REGIONS,
  validateNo2ActivityDataset,
} from '../scripts/shared/no2-activity.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/no2/statistics-jing-jin-ji-offl-2026-10.json', import.meta.url), 'utf8'));
const FIXTURE_STATS = FIXTURE.response.data.map((row) => row.outputs.no2.bands.B0.stats);
const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-10-26T06:20:00Z');
const region = (id) => NO2_REGIONS.find((item) => item.id === id);
const JJJ = region('jing-jin-ji');
const DE = region('country-de');
const RU = region('country-ru');
const GEOMETRIES = { 'country-de': { type: 'Polygon', coordinates: [[[6, 47], [15, 47], [15, 55], [6, 55], [6, 47]]] } };

function seriesWith(regionDef, days, backfilledYears = []) {
  return { ...emptySeries(regionDef), refreshedAt: new Date(NOW).toISOString(), backfilledYears, days };
}

function denseDays(from, count, meanValue, fraction = 0.6) {
  const days = {};
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  for (let index = 0; index < count; index++) {
    days[new Date(fromMs + index * DAY_MS).toISOString().slice(0, 10)] = [meanValue, fraction];
  }
  return days;
}

describe('seed-no2-activity request builder', () => {
  it('sends a country polygon and a cluster bbox on the region grid at QA 75 over OFFL days', () => {
    const cluster = buildStatisticsRequest(JJJ, { from: '2026-10-14', to: '2026-10-24' });
    assert.deepEqual(cluster.input.bounds.bbox, [114, 36, 119, 41]);
    assert.equal(cluster.input.bounds.properties.crs, 'http://www.opengis.net/def/crs/OGC/1.3/CRS84');
    assert.deepEqual(cluster.input.data[0], { type: 'sentinel-5p-l2', dataFilter: { timeliness: 'OFFL' }, processing: { minQa: 75 } });
    assert.deepEqual(cluster.aggregation.timeRange, { from: '2026-10-14T00:00:00Z', to: '2026-10-24T00:00:00Z' });
    assert.deepEqual(cluster.aggregation.aggregationInterval, { of: 'P1D' });
    assert.equal(cluster.aggregation.resx, 0.05);
    assert.match(cluster.aggregation.evalscript, /bands: \["NO2", "dataMask"\]/);
    const country = buildStatisticsRequest(DE, { from: '2026-10-14', to: '2026-10-24' }, GEOMETRIES['country-de']);
    assert.equal(country.input.bounds.bbox, undefined);
    assert.equal(country.input.bounds.geometry.type, 'Polygon');
    assert.equal(country.aggregation.resx, DE.resolutionDegrees);
    assert.equal(buildStatisticsRequest(RU, { from: '2026-10-14', to: '2026-10-24' }).aggregation.resx, 1);
  });
});

describe('seed-no2-activity calendar', () => {
  it('ends the current window windowEndLagDays before the UTC run date and refreshes the trailing days', () => {
    const current = currentWindow(NOW);
    assert.equal(current.windowEnd, '2026-10-23');
    assert.equal(current.windowStart, '2026-08-29');
    assert.equal(current.dates.length, 56);
    assert.deepEqual(refreshRange(current), { from: '2026-10-14', to: '2026-10-24' });
  });

  it('maps the same month-day span to each baseline year and drops Feb 29', () => {
    const current = currentWindow(NOW);
    const prior = baselineWindow(current, 1);
    assert.deepEqual([prior.year, prior.windowStart, prior.windowEnd, prior.dates.length], [2025, '2025-08-29', '2025-10-23', 56]);
    const leap = baselineWindow(currentWindow(Date.parse('2028-03-10T00:00:00Z')), 1);
    assert.equal(leap.dates.includes('2027-02-29'), false);
    assert.equal(leap.dates.length, 55);
  });

  it('cuts a year into chunks sized by the region width and bounded by the window end', () => {
    assert.deepEqual(yearChunks(JJJ, 2025, '2026-10-23', '2026-10-14').map((chunk) => [chunk.from, chunk.to]), [['2025-01-01', '2025-07-03'], ['2025-07-03', '2026-01-01']]);
    const russia = yearChunks(RU, 2025, '2026-10-23', '2026-10-14');
    assert.equal(russia.length, 6);
    assert.equal(russia[0].to, '2025-03-03');
    const partial = yearChunks(JJJ, 2026, '2026-10-23', '2026-10-14');
    assert.equal(partial[partial.length - 1].to, '2026-10-14', 'the refresh range already covers the rest');
    assert.deepEqual(yearChunks(JJJ, 2026, '2026-01-05', '2025-12-27'), [], 'a year inside the refresh range needs no chunk');
  });

  it('needs every calendar year the current and baseline windows touch', () => {
    const october = currentWindow(NOW);
    assert.deepEqual(neededYears(october, [1, 2, 3].map((years) => baselineWindow(october, years))), [2023, 2024, 2025, 2026]);
    const january = currentWindow(Date.parse('2027-01-20T06:00:00Z'));
    assert.deepEqual([january.windowStart, january.windowEnd], ['2026-11-23', '2027-01-17']);
    assert.deepEqual(windowYears(january), [2026, 2027]);
    assert.deepEqual(neededYears(january, [1, 2, 3].map((years) => baselineWindow(january, years))), [2023, 2024, 2025, 2026, 2027]);
  });

  it('queues missing years clusters first and spends at most the budget', () => {
    const seriesById = new Map([[JJJ.id, seriesWith(JJJ, {}, [2023, 2024])]]);
    const years = [2023, 2024, 2025, 2026];
    const queue = backfillQueue([DE, JJJ], seriesById, years, '2026-10-23', '2026-10-14', 100);
    assert.equal(queue[0].region.id, 'jing-jin-ji');
    assert.deepEqual([...new Set(queue.filter((task) => task.region.id === 'jing-jin-ji').map((task) => task.year))], [2025, 2026]);
    assert.deepEqual([...new Set(queue.filter((task) => task.region.id === 'country-de').map((task) => task.year))], [2023, 2024, 2025, 2026]);
    assert.equal(backfillQueue([DE, JJJ], seriesById, years, '2026-10-23', '2026-10-14', 3).length, 2, 'whole years only: 2026 would not fit');
    assert.equal(backfillQueue([DE, JJJ], seriesById, years, '2026-10-23', '2026-10-14', 1).length, 2, 'the first year always starts');
    assert.equal(backfillQueue([DE, JJJ], seriesById, years, '2026-10-23', '2026-10-14', 0).length, 0);
  });
});

describe('seed-no2-activity response parsing and stored series', () => {
  it('rebuilds country series calculated with bounding-box coverage and preserves unchanged cluster series', () => {
    const country = seriesWith(DE, { '2026-10-01': [1e-4, 0.03] }, [2024, 2025, 2026]);
    const cluster = seriesWith(JJJ, { '2026-10-01': [1e-4, 0.3] }, [2024, 2025, 2026]);
    delete country.validFractionVersion;
    delete cluster.validFractionVersion;
    assert.deepEqual(parseSeries(country, DE), emptySeries(DE));
    assert.deepEqual(parseSeries(cluster, JJJ).days, cluster.days);
    assert.deepEqual(parseSeries(seriesWith(DE, cluster.days, [2024, 2025, 2026]), DE).days, cluster.days);
  });

  it('uses the response geometry pixel count for polygon coverage and bounds the fraction', () => {
    const data = [{
      interval: { from: '2026-10-01T00:00:00Z' },
      outputs: { no2: { bands: { B0: { stats: { mean: 1e-4, sampleCount: 1000, noDataCount: 970 } } } } },
    }];
    const rows = parseStatisticsResponse({ geometryPixelCount: 100, data });
    assert.equal(rows.get('2026-10-01').validFraction, 0.3);
    const series = mergeSeries(emptySeries(DE), rows, '2026-01-01');
    assert.equal(summarizeWindow(series, '2026-10-01', '2026-10-01', null).validDays, 1);
    assert.equal(parseStatisticsResponse({ geometryPixelCount: 20, data }).get('2026-10-01').validFraction, 1);
    for (const geometryPixelCount of [undefined, null, 0, -1, NaN]) {
      assert.equal(parseStatisticsResponse({ geometryPixelCount, data }).get('2026-10-01').validFraction, 0.03);
    }
  });

  it('reads the recorded OFFL response into one row per day', () => {
    const rows = parseStatisticsResponse(FIXTURE.response);
    assert.equal(rows.size, 29);
    const first = rows.get('2026-09-26');
    assert.equal(first.mean, 5.0234815305675796e-05);
    assert.ok(Math.abs(first.validFraction - 0.2478) < 1e-9);
  });

  it('treats a day without outputs or with zero samples as invalid', () => {
    const rows = parseStatisticsResponse({ data: [
      { interval: { from: '2026-10-01T00:00:00Z' }, outputs: { no2: { bands: { B0: { stats: { mean: 'NaN', sampleCount: 10, noDataCount: 10 } } } } } },
      { interval: { from: '2026-10-02T00:00:00Z' }, outputs: { no2: { bands: { B0: { stats: { sampleCount: 0, noDataCount: 0 } } } } } },
      { interval: { from: 'garbage' } },
    ] });
    assert.deepEqual(rows.get('2026-10-01'), { date: '2026-10-01', mean: null, validFraction: 0 });
    assert.deepEqual(rows.get('2026-10-02'), { date: '2026-10-02', mean: null, validFraction: null });
    assert.equal(rows.size, 2);
    assert.throws(() => parseStatisticsResponse({ status: 'OK' }), /no data array/);
  });

  it('merges later rows over earlier ones, prunes old days, and discards a series on another grid', () => {
    const series = seriesWith(JJJ, { '2022-01-01': [1e-4, 0.5], '2026-10-01': [1e-4, 0.5] }, [2025]);
    const merged = mergeSeries(series, parseStatisticsResponse({ data: [
      { interval: { from: '2026-10-01T00:00:00Z' }, outputs: { no2: { bands: { B0: { stats: { mean: 2e-4, sampleCount: 10, noDataCount: 2 } } } } } },
    ] }), '2023-01-01');
    assert.deepEqual(merged.days, { '2026-10-01': [2e-4, 0.8] });
    assert.deepEqual(merged.backfilledYears, [2025]);
    assert.deepEqual(series.days['2026-10-01'], [1e-4, 0.5]);
    assert.deepEqual(parseSeries(JSON.stringify({ ...series, resolutionDegrees: 0.25 }), JJJ), emptySeries(JJJ));
    assert.deepEqual(parseSeries('not json', JJJ), emptySeries(JJJ));
    assert.deepEqual(parseSeries(null, JJJ), emptySeries(JJJ));
    assert.deepEqual(parseSeries(JSON.stringify(series), JJJ).days, series.days);
  });
});

describe('seed-no2-activity window summary and region result', () => {
  const current = currentWindow(NOW);
  const baselines = [1, 2, 3].map((years) => baselineWindow(current, years));

  it('gates days at the minimum valid fraction and masks holidays only on the region calendar', () => {
    const series = seriesWith(JJJ, { '2026-02-10': [1e-4, 0.5], '2026-02-11': [2e-4, 0.19], '2026-02-12': [3e-4, 0.2], '2026-03-04': [4e-4, 0.9] });
    const masked = summarizeWindow(series, '2026-02-10', '2026-03-04', 'lunar_new_year');
    assert.equal(masked.maskedDays, 22);
    assert.equal(masked.validDays, 1);
    assert.equal(masked.meanNo2MolM2, 4e-4);
    const unmasked = summarizeWindow(series, '2026-02-10', '2026-03-04', null);
    assert.equal(unmasked.maskedDays, 0);
    assert.equal(unmasked.validDays, 3);
    assert.ok(Math.abs(unmasked.meanNo2MolM2 - (1e-4 + 3e-4 + 4e-4) / 3) < 1e-18);
    assert.deepEqual(summarizeWindow(emptySeries(DE), '2026-02-10', '2026-02-12', null), {
      windowStart: '2026-02-10', windowEnd: '2026-02-12', validDays: 0, maskedDays: 0, meanNo2MolM2: null, meanValidFraction: null,
    });
  });

  it('computes the change against the mean of the eligible backfilled baseline years', () => {
    const days = {
      ...denseDays('2026-08-29', 56, 1.2e-4),
      ...denseDays('2025-08-29', 56, 1.0e-4),
      ...denseDays('2024-08-29', 56, 1.1e-4),
      ...denseDays('2023-08-29', 10, 5e-4),
    };
    const result = regionResult(DE, seriesWith(DE, days, [2023, 2024, 2025, 2026]), current, baselines);
    assert.equal(result.exclusion, null);
    assert.ok(Math.abs(result.baseline.meanNo2MolM2 - 1.05e-4) < 1e-18);
    assert.ok(Math.abs(result.changePercent - (1.2e-4 / 1.05e-4 - 1) * 100) < 1e-9);
    assert.equal(result.direction, 'strengthening');
    assert.equal(result.signalValue, result.changePercent);
    assert.deepEqual(result.baseline.years.map((year) => [year.year, year.validDays]), [[2025, 56], [2024, 56], [2023, 10]]);
    assert.deepEqual(result.series, { refreshedAt: new Date(NOW).toISOString(), days: 178, firstDate: '2023-08-29', lastDate: '2026-10-23', backfilledYears: [2023, 2024, 2025, 2026] });
    assert.equal(validateNo2ActivityDataset({ ...datasetAround([result]) }), true);
  });

  it('names every exclusion and keeps a stored series alive through one failed refresh', () => {
    const full = { ...denseDays('2026-08-29', 56, 1.2e-4), ...denseDays('2025-08-29', 56, 1e-4), ...denseDays('2024-08-29', 56, 1e-4) };
    assert.equal(regionResult(DE, seriesWith(DE, full, [2026]), current, baselines).exclusion, 'baseline_backfill_pending');
    assert.equal(regionResult(DE, seriesWith(DE, { ...full, ...denseDays('2026-08-29', 56, 1.2e-4, 0.1) }, [2024, 2025, 2026]), current, baselines).exclusion, 'insufficient_valid_days');
    assert.equal(regionResult(DE, seriesWith(DE, { ...denseDays('2026-08-29', 56, 1.2e-4), ...denseDays('2025-08-29', 5, 1e-4), ...denseDays('2024-08-29', 56, 1e-4) }, [2024, 2025, 2026]), current, baselines).exclusion, 'insufficient_baseline_years');
    const survived = regionResult(DE, seriesWith(DE, full, [2024, 2025, 2026]), current, baselines, true);
    assert.equal(survived.exclusion, null);
    const failed = regionResult(DE, emptySeries(DE), current, baselines, true);
    assert.equal(failed.exclusion, 'request_failed');
    const january = currentWindow(Date.parse('2027-01-20T06:00:00Z'));
    const januaryBaselines = [1, 2, 3].map((years) => baselineWindow(january, years));
    const crossing = { ...denseDays('2026-11-23', 56, 1.2e-4), ...denseDays('2025-11-23', 56, 1e-4), ...denseDays('2024-11-23', 56, 1e-4) };
    assert.equal(regionResult(DE, seriesWith(DE, crossing, [2024, 2025, 2026, 2027]), january, januaryBaselines).exclusion, null);
    assert.equal(regionResult(DE, seriesWith(DE, crossing, [2025, 2026, 2027]), january, januaryBaselines).exclusion, 'baseline_backfill_pending', 'the 2024-11 baseline window touches an unbackfilled year');
    assert.equal(failed.changePercent, null);
    assert.equal(failed.direction, null);
    assert.equal(pendingRecord(DE, NOW).exclusion, 'baseline_backfill_pending');
  });

  it('excludes retained data after its fixed refresh deadline', () => {
    const series = seriesWith(DE, {
      ...denseDays('2026-08-29', 56, 1.2e-4),
      ...denseDays('2025-08-29', 56, 1e-4),
      ...denseDays('2024-08-29', 56, 1e-4),
    }, [2024, 2025, 2026]);
    series.refreshedAt = new Date(NOW - NO2_ACTIVITY_MAX_REFRESH_AGE_MS).toISOString();
    assert.equal(regionResult(DE, series, current, baselines, true, NO2_ACTIVITY_METHOD, NOW).exclusion, null);
    assert.equal(regionResult(DE, series, current, baselines, true, NO2_ACTIVITY_METHOD, NOW + 1).exclusion, 'request_failed');
    series.refreshedAt = null;
    assert.equal(regionResult(DE, series, current, baselines, true, NO2_ACTIVITY_METHOD, NOW).exclusion, 'request_failed');
  });
});

describe('NO2 atomic publication', () => {
  it('sends the payload and durable activation marker in one Redis command', async (t) => {
    const commands = [];
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      commands.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ result: 1 }));
    });
    await publishNo2Atomically({}, { canonicalKey: 'economic:no2-activity:v1', payload: '{}', ttlSeconds: 604800 }, { url: 'https://redis.test', token: 'test' });
    assert.equal(commands.length, 1);
    assert.equal(commands[0][0], 'EVAL');
    assert.match(commands[0][1], /SET.*KEYS\[1\].*EX.*SET.*KEYS\[2\]/);
    assert.deepEqual(commands[0].slice(2), [2, 'economic:no2-activity:v1', NO2_ACTIVITY_ACTIVATION_KEY, '{}', 604800]);
  });

  it('fails publication when Redis rejects or does not confirm the atomic write', async (t) => {
    for (const response of [{ error: 'publication failed' }, { result: null }]) {
      t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(response)));
      await assert.rejects(publishNo2Atomically({}, { canonicalKey: 'economic:no2-activity:v1', payload: '{}', ttlSeconds: 604800 }, { url: 'https://redis.test', token: 'test' }), /publication/);
    }
  });
});

function datasetAround(records) {
  return {
    methodVersion: 'no2-activity/v1',
    generatedAt: new Date(NOW).toISOString(),
    method: JSON.parse(JSON.stringify(NO2_ACTIVITY_METHOD)),
    source: { publisherId: 'publisher:copernicus-sentinel-5p', dataset: 'sentinel-5p-l2', band: 'NO2', unit: 'mol/m2', attribution: 'Contains modified Copernicus Sentinel data 2023-2026', requestCount: 1, processingUnitsSpent: 0.1 },
    regions: Object.fromEntries(NO2_REGIONS.map((definition) => [
      definition.id,
      records.find((record) => record.id === definition.id) ?? pendingRecord(definition, NOW),
    ])),
  };
}

function stubFetch({ fail = () => false, pu = '0.25' } = {}) {
  const calls = { token: 0, statistics: [] };
  const fetchImpl = async (url, init) => {
    assert.match(init.headers['User-Agent'], /^WorldMonitor seed-no2-activity/);
    if (url === CDSE_TOKEN_URL) {
      calls.token++;
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('grant_type'), 'client_credentials');
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 1800 }), { status: 200 });
    }
    assert.equal(url, CDSE_STATISTICS_URL);
    assert.equal(init.headers.Authorization, 'Bearer tok');
    const body = JSON.parse(init.body);
    calls.statistics.push(body);
    if (fail(body)) return new Response('{"error":"boom"}', { status: 503 });
    const fromMs = Date.parse(body.aggregation.timeRange.from);
    const toMs = Date.parse(body.aggregation.timeRange.to);
    const factor = new Date(toMs - DAY_MS).getUTCFullYear() === 2026 ? 1.2 : 1;
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

function stubStore(initial = {}) {
  const writes = [];
  return {
    writes,
    store: {
      async readSeries(keys) {
        return new Map(keys.map((key) => [key, initial[key] === undefined ? null : JSON.stringify(initial[key])]));
      },
      async writeSeries(key, series) {
        writes.push([key, series]);
      },
    },
  };
}

const REGIONS = [JJJ, DE];

function fetchAllWith(fetchImpl, store, options = {}) {
  return makeFetchAll({
    fetchImpl,
    store,
    clientId: 'id',
    clientSecret: 'secret',
    now: () => NOW,
    regions: REGIONS,
    geometries: GEOMETRIES,
    retryDelayMs: 0,
    log: () => {},
    ...options,
  });
}

describe('seed-no2-activity fetchAll', () => {
  for (const { label, previousRun, run, previousYears, gapDates, repairYears } of [
    {
      label: 'within one year', previousRun: '2026-10-10T06:20:00Z', run: NOW,
      previousYears: [2023, 2024, 2025, 2026], gapDates: ['2026-10-08', '2026-10-13'], repairYears: [2026],
    },
    {
      label: 'across New Year', previousRun: '2026-12-20T06:20:00Z', run: Date.parse('2027-01-20T06:20:00Z'),
      previousYears: [2023, 2024, 2025, 2026], gapDates: ['2026-12-18', '2027-01-07'], repairYears: [2026, 2027],
    },
  ]) {
    it(`persists incomplete years after a refresh gap ${label} and repairs them within the backfill budget`, async () => {
      const previousEnd = currentWindow(Date.parse(previousRun)).windowEnd;
      const key = `${NO2_ACTIVITY_SERIES_KEY_PREFIX}${JJJ.id}`;
      const previous = {
        ...seriesWith(JJJ, { [previousEnd]: [1e-4, 0.6] }, previousYears),
        refreshedAt: previousRun,
      };
      const { fetchImpl, calls } = stubFetch();
      const { store, writes } = stubStore({ [key]: previous });
      const deferred = await fetchAllWith(fetchImpl, store, { regions: [JJJ], now: () => run, backfillChunks: 0 })();
      assert.equal(calls.statistics.length, 1);
      const retained = writes[0][1];
      assert.deepEqual(retained.backfilledYears, previousYears.filter((year) => !repairYears.includes(year)));
      assert.equal(deferred.regions[JJJ.id].exclusion, 'baseline_backfill_pending');
      for (const date of gapDates) assert.equal(retained.days[date], undefined);

      const retry = stubFetch();
      const recovered = stubStore({ [key]: retained });
      const healed = await fetchAllWith(retry.fetchImpl, recovered.store, { regions: [JJJ], now: () => run, backfillChunks: 100 })();
      assert.deepEqual([...new Set(retry.calls.statistics.slice(1).map((body) => Number(body.aggregation.timeRange.from.slice(0, 4))))], repairYears);
      for (const date of gapDates) assert.ok(recovered.writes[0][1].days[date], `repaired ${date}`);
      for (const year of repairYears) assert.ok(healed.regions[JJJ.id].series.backfilledYears.includes(year));
    });
  }

  it('keeps completed years after a contiguous refresh even when the previous query returned sparse days', async () => {
    const key = `${NO2_ACTIVITY_SERIES_KEY_PREFIX}${JJJ.id}`;
    const previous = {
      ...seriesWith(JJJ, { '2026-10-03': [1e-4, 0.6] }, [2023, 2024, 2025, 2026]),
      refreshedAt: '2026-10-16T06:20:00Z',
    };
    const { fetchImpl, calls } = stubFetch();
    const { store } = stubStore({ [key]: previous });
    const dataset = await fetchAllWith(fetchImpl, store, { regions: [JJJ], backfillChunks: 100 })();
    assert.equal(calls.statistics.length, 1);
    assert.deepEqual(dataset.regions[JJJ.id].series.backfilledYears, previous.backfilledYears);
  });

  it('repairs gaps in a stored series that has no previous refresh clock', async () => {
    const key = `${NO2_ACTIVITY_SERIES_KEY_PREFIX}${JJJ.id}`;
    const previous = { ...seriesWith(JJJ, { '2026-10-07': [1e-4, 0.6] }, [2023, 2024, 2025, 2026]), refreshedAt: null };
    const { fetchImpl, calls } = stubFetch();
    const { store, writes } = stubStore({ [key]: previous });
    await fetchAllWith(fetchImpl, store, { regions: [JJJ], backfillChunks: 100 })();
    assert.ok(calls.statistics.length > 1);
    assert.ok(writes[0][1].days['2026-10-08']);
    assert.deepEqual(writes[0][1].backfilledYears, previous.backfilledYears);
  });

  it('preserves last-good publication when every refresh fails even with stored series', async () => {
    const stored = {
      [`${NO2_ACTIVITY_SERIES_KEY_PREFIX}jing-jin-ji`]: seriesWith(JJJ, {
        ...denseDays('2026-08-29', 36, 1.3e-4),
        ...denseDays('2025-08-29', 56, 1e-4),
        ...denseDays('2024-08-29', 56, 1e-4),
      }, [2024, 2025, 2026]),
    };
    const { fetchImpl } = stubFetch({ fail: () => true });
    const { store, writes } = stubStore(stored);
    await assert.rejects(fetchAllWith(fetchImpl, store, { backfillChunks: 0 })(), (error) => {
      assert.equal(error.preservableFetchFailure, true);
      return true;
    });
    assert.equal(writes.length, 0);
  });

  it('preserves each region refresh clock through partial failure', async () => {
    const refreshedAt = '2026-10-22T06:20:00.000Z';
    const stored = {
      [`${NO2_ACTIVITY_SERIES_KEY_PREFIX}jing-jin-ji`]: {
        ...seriesWith(JJJ, {
          ...denseDays('2026-08-29', 46, 1.3e-4),
          ...denseDays('2025-08-29', 56, 1e-4),
          ...denseDays('2024-08-29', 56, 1e-4),
        }, [2024, 2025, 2026]),
        refreshedAt,
      },
    };
    const { fetchImpl } = stubFetch({ fail: (body) => Boolean(body.input.bounds.bbox) });
    const { store } = stubStore(stored);
    const dataset = await fetchAllWith(fetchImpl, store, { backfillChunks: 0 })();
    assert.equal(dataset.regions['jing-jin-ji'].series.refreshedAt, refreshedAt);
    assert.equal(dataset.regions['country-de'].series.refreshedAt, new Date(NOW).toISOString());
  });

  it('refreshes every region, backfills within the budget, stores the series, and publishes a valid dataset', async () => {
    const { fetchImpl, calls } = stubFetch();
    const { store, writes } = stubStore();
    const partial = await fetchAllWith(fetchImpl, store, { backfillChunks: 4 })();
    assert.equal(calls.token, 1);
    assert.equal(calls.statistics.length, 2 + 4);
    assert.equal(partial.source.requestCount, 6);
    assert.ok(Math.abs(partial.source.processingUnitsSpent - 6 * 0.25) < 1e-9);
    const chunks = calls.statistics.slice(2).map((body) => body.aggregation.timeRange.from.slice(0, 10));
    assert.deepEqual(chunks, ['2023-01-01', '2023-07-03', '2024-01-01', '2024-07-02']);
    assert.ok(calls.statistics.slice(2).every((body) => body.input.bounds.bbox?.[0] === 114), 'the cluster backfills before the country');
    assert.equal(calls.statistics[1].input.bounds.geometry.type, 'Polygon');
    assert.deepEqual(writes.map(([key]) => key), [`${NO2_ACTIVITY_SERIES_KEY_PREFIX}jing-jin-ji`, `${NO2_ACTIVITY_SERIES_KEY_PREFIX}country-de`]);
    assert.deepEqual(writes[0][1].backfilledYears, [2023, 2024]);
    assert.equal(partial.regions['jing-jin-ji'].exclusion, 'baseline_backfill_pending');
    assert.equal(partial.regions['jing-jin-ji'].series.backfilledYears.length, 2);
    assert.equal(partial.regions['country-de'].series.days, 10);
    assert.equal(validateNo2ActivityDataset(datasetAround(Object.values(partial.regions))), true);
    assert.equal(declareRecords(partial), 0);
  });

  it('publishes a direction once the stored series carries the baseline years', async () => {
    const stored = {
      [`${NO2_ACTIVITY_SERIES_KEY_PREFIX}jing-jin-ji`]: seriesWith(JJJ, {
        ...denseDays('2026-08-29', 46, 1.3e-4),
        ...denseDays('2025-08-29', 56, 1e-4),
        ...denseDays('2024-08-29', 56, 1e-4),
        ...denseDays('2023-08-29', 56, 1e-4),
      }, [2023, 2024, 2025, 2026]),
    };
    const { fetchImpl } = stubFetch();
    const { store, writes } = stubStore(stored);
    const dataset = await fetchAllWith(fetchImpl, store, { backfillChunks: 0 })();
    const jjj = dataset.regions['jing-jin-ji'];
    assert.equal(jjj.exclusion, null);
    assert.equal(jjj.direction, 'strengthening');
    assert.ok(jjj.changePercent > 10);
    assert.equal(jjj.current.validDays >= 46, true);
    assert.equal(writes.length, 2, 'both series changed and were written');
    assert.equal(declareRecords(dataset), 1);
  });

  it('keeps a region with a stored series through a failed refresh and marks an empty one request_failed', async () => {
    const stored = {
      [`${NO2_ACTIVITY_SERIES_KEY_PREFIX}jing-jin-ji`]: seriesWith(JJJ, {
        ...denseDays('2026-08-29', 40, 1.3e-4), ...denseDays('2025-08-29', 56, 1e-4), ...denseDays('2024-08-29', 56, 1e-4),
      }, [2024, 2025, 2026]),
    };
    const { fetchImpl } = stubFetch({ fail: (body) => body.input.bounds.bbox?.[0] !== RU.bbox[0] });
    const { store, writes } = stubStore(stored);
    const dataset = await fetchAllWith(fetchImpl, store, { regions: [JJJ, DE, RU], backfillChunks: 0 })();
    assert.equal(dataset.regions['jing-jin-ji'].exclusion, null);
    assert.equal(dataset.regions['country-de'].exclusion, 'request_failed');
    assert.equal(writes.length, 1, 'only the successful refresh is written');
  });

  it('throws a preservable failure when every refresh fails with nothing stored, or the token is down', async () => {
    const { fetchImpl } = stubFetch({ fail: () => true });
    await assert.rejects(fetchAllWith(fetchImpl, stubStore().store)(), (error) => {
      assert.match(error.message, /every refresh failed/);
      assert.equal(error.preservableFetchFailure, true);
      return true;
    });
    const tokenDown = async (url) => (url === CDSE_TOKEN_URL ? new Response('nope', { status: 500 }) : assert.fail('no statistics call'));
    await assert.rejects(fetchAllWith(tokenDown, stubStore().store)(), (error) => {
      assert.match(error.message, /token fetch failed/);
      assert.equal(error.preservableFetchFailure, true);
      return true;
    });
  });

  it('fetches a fresh token when the API rejects the current one', async () => {
    const { fetchImpl, calls } = stubFetch();
    let rejected = false;
    const flaky = async (url, init) => {
      if (url === CDSE_STATISTICS_URL && !rejected) {
        rejected = true;
        return new Response('expired', { status: 401 });
      }
      return fetchImpl(url, init);
    };
    const dataset = await fetchAllWith(flaky, stubStore().store, { backfillChunks: 0 })();
    assert.equal(calls.token, 2);
    assert.equal(dataset.source.requestCount, 3);
  });

  it('stops starting backfill chunks past the deadline and leaves those years unmarked', async () => {
    const { fetchImpl, calls } = stubFetch();
    const { store, writes } = stubStore();
    await fetchAllWith(fetchImpl, store, { backfillChunks: 4, backfillDeadlineMs: -1 })();
    assert.equal(calls.statistics.length, 2);
    assert.deepEqual(writes[0][1].backfilledYears, []);
  });

  it('marks a year backfilled only when every chunk of it answered', async () => {
    const { fetchImpl } = stubFetch({ fail: (body) => body.aggregation.timeRange.from.startsWith('2023-07') });
    const { store, writes } = stubStore();
    await fetchAllWith(fetchImpl, store, { backfillChunks: 4 })();
    assert.deepEqual(writes[0][1].backfilledYears, [2024]);
  });
});
