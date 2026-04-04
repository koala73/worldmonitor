import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeMonthlyNormals, buildZoneNormalsFromBatch } from '../scripts/seed-climate-zone-normals.mjs';
import { hasRequiredClimateZones } from '../scripts/_climate-zones.mjs';
import { fetchOpenMeteoArchiveBatch, parseRetryAfterMs } from '../scripts/_open-meteo-archive.mjs';
import {
  buildClimateAnomaly,
  buildClimateAnomaliesFromBatch,
  indexZoneNormals,
} from '../scripts/seed-climate-anomalies.mjs';
import {
  buildCo2MonitoringPayload,
  parseCo2DailyRows,
  parseCo2MonthlyRows,
  parseAnnualCo2Rows,
  parseGlobalMonthlyPpbRows,
} from '../scripts/seed-co2-monitoring.mjs';
import {
  buildIceTrend12mFromClimatology,
  buildIceTrend12m,
  buildOceanIcePayload,
  computeOceanBaselineOffsets,
  computeSeaIceMonthlyMedians,
  countIndicators,
  extractLatestOceanSeriesPath,
  parseOceanTemperatureRows,
  parseOhcYearlyRows,
  parseSeaIceClimatologyRows,
  parseSeaIceDailyRows,
  parseSeaIceMonthlyRows,
  parseSeaLevelOverlay,
} from '../scripts/seed-climate-ocean-ice.mjs';

describe('climate zone normals', () => {
  it('aggregates per-year monthly means into calendar-month normals', () => {
    const normals = computeMonthlyNormals({
      time: ['1991-01-01', '1991-01-02', '1991-02-01', '1992-01-01'],
      temperature_2m_mean: [10, 14, 20, 16],
      precipitation_sum: [2, 6, 1, 4],
    });

    assert.equal(normals.length, 2);
    assert.equal(normals[0].month, 1);
    assert.equal(normals[0].tempMean, 14);
    assert.equal(normals[0].precipMean, 4);
    assert.equal(normals[1].month, 2);
    assert.equal(normals[1].tempMean, 20);
    assert.equal(normals[1].precipMean, 1);
  });

  it('drops months that have zero samples', () => {
    const normals = computeMonthlyNormals({
      time: ['1991-01-01'],
      temperature_2m_mean: [10],
      precipitation_sum: [2],
    });

    assert.equal(normals.length, 1);
    assert.equal(normals[0].month, 1);
  });

  it('maps multi-location archive responses back to their zones', () => {
    const zones = [
      { name: 'Zone A', lat: 1, lon: 2 },
      { name: 'Zone B', lat: 3, lon: 4 },
    ];
    const months = Array.from({ length: 12 }, (_, index) => index + 1);
    const payloads = [
      {
        daily: {
          time: months.map((month) => `1991-${String(month).padStart(2, '0')}-01`),
          temperature_2m_mean: months.map((month) => month),
          precipitation_sum: months.map((month) => month + 0.5),
        },
      },
      {
        daily: {
          time: months.map((month) => `1991-${String(month).padStart(2, '0')}-01`),
          temperature_2m_mean: months.map((month) => month + 10),
          precipitation_sum: months.map((month) => month + 20),
        },
      },
    ];

    const normals = buildZoneNormalsFromBatch(zones, payloads);

    assert.equal(normals.length, 2);
    assert.equal(normals[0].zone, 'Zone A');
    assert.equal(normals[1].zone, 'Zone B');
    assert.equal(normals[0].months[0].tempMean, 1);
    assert.equal(normals[1].months[0].tempMean, 11);
  });

  it('skips zones with incomplete monthly normals but keeps other zones in the batch', () => {
    const zones = [
      { name: 'Zone A', lat: 1, lon: 2 },
      { name: 'Zone B', lat: 3, lon: 4 },
    ];
    const fullMonths = Array.from({ length: 12 }, (_, index) => index + 1);
    const shortMonths = Array.from({ length: 11 }, (_, index) => index + 1);
    const payloads = [
      {
        daily: {
          time: fullMonths.map((month) => `1991-${String(month).padStart(2, '0')}-01`),
          temperature_2m_mean: fullMonths.map((month) => month),
          precipitation_sum: fullMonths.map((month) => month + 0.5),
        },
      },
      {
        daily: {
          time: shortMonths.map((month) => `1991-${String(month).padStart(2, '0')}-01`),
          temperature_2m_mean: shortMonths.map((month) => month + 10),
          precipitation_sum: shortMonths.map((month) => month + 20),
        },
      },
    ];

    const normals = buildZoneNormalsFromBatch(zones, payloads);

    assert.equal(normals.length, 1);
    assert.equal(normals[0].zone, 'Zone A');
  });

  it('requires the new climate-specific zones to be present', () => {
    assert.equal(hasRequiredClimateZones([
      { zone: 'Arctic' },
      { zone: 'Greenland' },
      { zone: 'Western Antarctic Ice Sheet' },
      { zone: 'Tibetan Plateau' },
      { zone: 'Congo Basin' },
      { zone: 'Coral Triangle' },
      { zone: 'North Atlantic' },
    ], (zone) => zone.zone), true);

    assert.equal(hasRequiredClimateZones([
      { zone: 'Arctic' },
      { zone: 'Greenland' },
    ], (zone) => zone.zone), false);
  });
});

describe('climate anomalies', () => {
  it('uses stored monthly normals instead of a rolling 30-day baseline', () => {
    const normalsIndex = indexZoneNormals({
      normals: [
        {
          zone: 'Test Zone',
          months: [
            { month: 3, tempMean: 10, precipMean: 2 },
          ],
        },
      ],
    });

    const anomaly = buildClimateAnomaly(
      { name: 'Test Zone', lat: 1, lon: 2 },
      {
        time: ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07'],
        temperature_2m_mean: [15, 15, 15, 15, 15, 15, 15],
        precipitation_sum: [1, 1, 1, 1, 1, 1, 1],
      },
      normalsIndex.get('Test Zone:3'),
    );

    assert.equal(anomaly.tempDelta, 5);
    assert.equal(anomaly.precipDelta, -1);
    assert.equal(anomaly.severity, 'ANOMALY_SEVERITY_EXTREME');
    assert.equal(anomaly.type, 'ANOMALY_TYPE_WARM');
  });

  it('maps batched archive payloads back to the correct zones', () => {
    const zones = [
      { name: 'Zone A', lat: 1, lon: 2 },
      { name: 'Zone B', lat: 3, lon: 4 },
    ];
    const normalsIndex = indexZoneNormals({
      normals: [
        { zone: 'Zone A', months: [{ month: 3, tempMean: 10, precipMean: 2 }] },
        { zone: 'Zone B', months: [{ month: 3, tempMean: 20, precipMean: 5 }] },
      ],
    });
    const payloads = [
      {
        daily: {
          time: ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07'],
          temperature_2m_mean: [12, 12, 12, 12, 12, 12, 12],
          precipitation_sum: [1, 1, 1, 1, 1, 1, 1],
        },
      },
      {
        daily: {
          time: ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07'],
          temperature_2m_mean: [25, 25, 25, 25, 25, 25, 25],
          precipitation_sum: [9, 9, 9, 9, 9, 9, 9],
        },
      },
    ];

    const anomalies = buildClimateAnomaliesFromBatch(zones, payloads, normalsIndex);

    assert.equal(anomalies.length, 2);
    assert.equal(anomalies[0].zone, 'Zone A');
    assert.equal(anomalies[0].tempDelta, 2);
    assert.equal(anomalies[1].zone, 'Zone B');
    assert.equal(anomalies[1].tempDelta, 5);
    assert.equal(anomalies[1].precipDelta, 4);
  });

  it('skips zones missing monthly normals without failing the whole batch', () => {
    const zones = [
      { name: 'Zone A', lat: 1, lon: 2 },
      { name: 'Zone B', lat: 3, lon: 4 },
    ];
    const normalsIndex = indexZoneNormals({
      normals: [
        { zone: 'Zone A', months: [{ month: 3, tempMean: 10, precipMean: 2 }] },
      ],
    });
    const payloads = [
      {
        daily: {
          time: ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07'],
          temperature_2m_mean: [12, 12, 12, 12, 12, 12, 12],
          precipitation_sum: [1, 1, 1, 1, 1, 1, 1],
        },
      },
      {
        daily: {
          time: ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07'],
          temperature_2m_mean: [25, 25, 25, 25, 25, 25, 25],
          precipitation_sum: [9, 9, 9, 9, 9, 9, 9],
        },
      },
    ];

    const anomalies = buildClimateAnomaliesFromBatch(zones, payloads, normalsIndex);

    assert.equal(anomalies.length, 1);
    assert.equal(anomalies[0].zone, 'Zone A');
  });

  it('classifies wet precipitation anomalies with calibrated daily thresholds', () => {
    const anomaly = buildClimateAnomaly(
      { name: 'Wet Zone', lat: 1, lon: 2 },
      {
        time: ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07'],
        temperature_2m_mean: [10, 10, 10, 10, 10, 10, 10],
        precipitation_sum: [8, 8, 8, 8, 8, 8, 8],
      },
      { month: 3, tempMean: 10, precipMean: 1 },
    );

    assert.equal(anomaly.tempDelta, 0);
    assert.equal(anomaly.precipDelta, 7);
    assert.equal(anomaly.severity, 'ANOMALY_SEVERITY_MODERATE');
    assert.equal(anomaly.type, 'ANOMALY_TYPE_WET');
  });
});

describe('co2 monitoring seed', () => {
  it('parses NOAA text tables and computes monitoring metrics', () => {
    const dailyRows = parseCo2DailyRows(`
# comment
2024 03 28 2024.240 -999.99 0 0 0
2025 03 28 2025.238 424.10 424.10 424.10 1
2026 03 28 2026.238 427.55 427.55 427.55 1
`);
    const monthlyLines = ['# comment'];
    const monthlyValues = [
      ['2024-05', 420.0], ['2024-06', 420.1], ['2024-07', 420.2], ['2024-08', 420.3],
      ['2024-09', 420.4], ['2024-10', 420.5], ['2024-11', 420.6], ['2024-12', 420.7],
      ['2025-01', 420.8], ['2025-02', 420.9], ['2025-03', 421.0], ['2025-04', 421.1],
      ['2025-05', 422.0], ['2025-06', 422.1], ['2025-07', 422.2], ['2025-08', 422.3],
      ['2025-09', 422.4], ['2025-10', 422.5], ['2025-11', 422.6], ['2025-12', 422.7],
      ['2026-01', 422.8], ['2026-02', 422.9], ['2026-03', 423.0], ['2026-04', 423.1],
    ];
    for (const [month, value] of monthlyValues) {
      const [year, monthNum] = month.split('-');
      monthlyLines.push(`${year} ${monthNum} ${year}.${monthNum} ${value.toFixed(2)} ${value.toFixed(2)} 30 0.12 0.08`);
    }
    const monthlyRows = parseCo2MonthlyRows(monthlyLines.join('\n'));
    const annualRows = parseAnnualCo2Rows(`
# comment
2024 422.79 0.10
2025 425.64 0.09
`);
    const methaneRows = parseGlobalMonthlyPpbRows(`
# comment
2026 03 2026.208 1934.49 0.50 1933.80 0.48
`);
    const nitrousRows = parseGlobalMonthlyPpbRows(`
# comment
2026 03 2026.208 337.62 0.12 337.40 0.11
`);

    const payload = buildCo2MonitoringPayload({ dailyRows, monthlyRows, annualRows, methaneRows, nitrousRows });

    assert.equal(payload.monitoring.currentPpm, 427.55);
    assert.equal(payload.monitoring.yearAgoPpm, 424.1);
    assert.equal(payload.monitoring.annualGrowthRate, 2.85);
    assert.equal(payload.monitoring.preIndustrialBaseline, 280);
    assert.equal(payload.monitoring.monthlyAverage, 423);
    assert.equal(payload.monitoring.station, 'Mauna Loa, Hawaii');
    assert.equal(payload.monitoring.trend12m.length, 12);
    assert.equal(payload.monitoring.trend12m[0].month, '2025-05');
    assert.equal(payload.monitoring.trend12m.at(-1).month, '2026-04');
    assert.equal(payload.monitoring.trend12m.at(-1).anomaly, 2);
    assert.equal(payload.monitoring.methanePpb, 1934.49);
    assert.equal(payload.monitoring.nitrousOxidePpb, 337.62);
  });
});

describe('ocean ice seed', () => {
  it('parses the live NSIDC daily CSV spacing format', () => {
    const dailyRows = parseSeaIceDailyRows(`
Year, Month, Day,     Extent,    Missing, Source Data
1978,    10,  26,     10.231,      0.000, ['source-a']
2026,     3,  31,     14.130,      0.000, ['source-b']
`);

    assert.equal(dailyRows.length, 2);
    assert.equal(dailyRows[0].month, 10);
    assert.equal(dailyRows[1].day, 31);
    assert.equal(dailyRows[1].extent, 14.13);
  });

  it('computes monthly sea ice medians and trend anomalies from NSIDC rows', () => {
    const dailyRows = parseSeaIceDailyRows(`
2025,05,31,12.30,10.10
2025,06,30,10.50,8.20
2026,03,30,14.00,12.00
2026,03,31,13.95,11.95
`);
    const medians = computeSeaIceMonthlyMedians(new Map([
      [3, parseSeaIceMonthlyRows('1981,3,NSIDC-0051,N,14.80,13.20\n1990,3,NSIDC-0051,N,14.70,13.10\n2010,3,NSIDC-0051,N,14.65,13.05', 3)],
      [5, parseSeaIceMonthlyRows('1981,5,NSIDC-0051,N,12.60,10.90\n1990,5,NSIDC-0051,N,12.40,10.70\n2010,5,NSIDC-0051,N,12.50,10.80', 5)],
      [6, parseSeaIceMonthlyRows('1981,6,NSIDC-0051,N,10.90,9.50\n1990,6,NSIDC-0051,N,10.80,9.40\n2010,6,NSIDC-0051,N,10.70,9.30', 6)],
    ]));

    assert.equal(dailyRows.at(-1).extent, 13.95);
    assert.equal(medians.get(3), 14.7);
    assert.equal(medians.get(5), 12.5);

    const trend = buildIceTrend12m(dailyRows, medians);
    assert.equal(trend.length, 3);
    assert.deepEqual(trend[0], { month: '2025-05', extentMkm2: 12.3, anomalyMkm2: -0.2 });
    assert.deepEqual(trend[2], { month: '2026-03', extentMkm2: 13.95, anomalyMkm2: -0.75 });
  });

  it('parses NSIDC daily climatology medians and maps recent months against same-day baselines', () => {
    const climatologyRows = parseSeaIceClimatologyRows(`
std Years = 1981-2010
DOY,   Average Extent,   Std Deviation,      10th,      25th,      50th,      75th,      90th
090,           15.100,           0.400,    14.500,    14.800,    15.200,    15.400,    15.600
151,           12.100,           0.300,    11.700,    11.900,    12.200,    12.300,    12.500
181,           10.600,           0.250,    10.100,    10.400,    10.700,    10.900,    11.100
`);
    const dailyRows = parseSeaIceDailyRows(`
2025,05,31,12.30,0.00
2025,06,30,10.50,0.00
2026,03,31,13.95,0.00
`);
    const climatologyByDoy = new Map(climatologyRows.map((row) => [row.doy, row.medianExtent]));

    assert.equal(climatologyRows.length, 3);
    assert.equal(climatologyRows[0].medianExtent, 15.2);

    const trend = buildIceTrend12mFromClimatology(dailyRows, climatologyByDoy);
    assert.equal(trend.length, 3);
    assert.deepEqual(trend[0], { month: '2025-05', extentMkm2: 12.3, anomalyMkm2: 0.1 });
    assert.deepEqual(trend[2], { month: '2026-03', extentMkm2: 13.95, anomalyMkm2: -1.25 });
  });

  it('parses sea level, OHC, and NOAA ocean-only temperature rows', () => {
    const seaLevel = parseSeaLevelOverlay(`
      <div>RISE SINCE 1993</div>
      <div>98.8</div>
      <div>millimeters</div>
      <p>The annual rate of rise has increased from 0.08 inches/year (0.20 centimeters/year) in 1993
      to the current yearly rate of 0.17 inches/year (0.44 centimeters/year).</p>
    `);
    assert.equal(seaLevel.seaLevelMmAbove1993, 98.8);
    assert.equal(seaLevel.seaLevelAnnualRiseMm, 4.4);

    const ohcRows = parseOhcYearlyRows(`
YEAR WO WOse NH NHse SH SHse
2024.500 21.469 0.195 10.174 0.268 11.295 0.421
2025.500 22.845 0.175 11.850 0.239 10.995 0.242
`);
    assert.equal(ohcRows.length, 2);
    assert.equal(ohcRows.at(-1).world, 22.845);

    const sstRows = parseOceanTemperatureRows(`
2024 11    0.605664 -999.000000 -999.000000 -999.000000
2024 12    0.569422 -999.000000 -999.000000 -999.000000
2025  1    0.615606 -999.000000 -999.000000 -999.000000
`);
    assert.equal(sstRows.length, 3);
    assert.equal(sstRows.at(-1).year, 2025);
    assert.equal(sstRows.at(-1).month, 1);
    assert.equal(sstRows.at(-1).anomaly, 0.615606);
  });

  it('derives the requested 1971-2000 SST baseline offset from NOAA ocean-only history', () => {
    const baselineRows = parseOceanTemperatureRows(`
1991  3    0.220000 -999.000000 -999.000000 -999.000000
1992  3    0.260000 -999.000000 -999.000000 -999.000000
2020  3    0.280000 -999.000000 -999.000000 -999.000000
1991  4    0.300000 -999.000000 -999.000000 -999.000000
2020  4    0.360000 -999.000000 -999.000000 -999.000000
`);
    const offsets = computeOceanBaselineOffsets(baselineRows);

    assert.equal(offsets.get(3), 0.253);
    assert.equal(offsets.get(4), 0.33);
  });

  it('finds the latest NOAA ocean-only monthly series in the index', () => {
    const path = extractLatestOceanSeriesPath(`
<td><a href="aravg.mon.ocean.90S.90N.v6.0.0.202512.asc">aravg.mon.ocean.90S.90N.v6.0.0.202512.asc</a></td>
<td><a href="aravg.mon.ocean.90S.90N.v6.0.0.202412.asc">aravg.mon.ocean.90S.90N.v6.0.0.202412.asc</a></td>
<td><a href="aravg.mon.ocean.90S.90N.v6.1.0.202501.asc">aravg.mon.ocean.90S.90N.v6.1.0.202501.asc</a></td>
`);

    assert.equal(path, 'aravg.mon.ocean.90S.90N.v6.0.0.202512.asc');
  });

  it('merges all source sections and keeps the latest measured timestamp', () => {
    // positional: [seaIce, seaLevel, ohc, sst]
    const payload = buildOceanIcePayload([
      {
        data: { arctic_extent_mkm2: 13.95, arctic_extent_anomaly_mkm2: -0.75, arctic_trend: 'below_average' },
        measuredAt: Date.UTC(2026, 2, 31),
      },
      {
        data: { sea_level_mm_above_1993: 98.8, sea_level_annual_rise_mm: 4.4 },
      },
      {
        data: { ohc_0_700m_zj: 228.45 },
        measuredAt: Date.UTC(2026, 2, 1),
      },
      {
        data: { sst_anomaly_c: 0.91 },
      },
    ]);

    assert.equal(payload.arctic_extent_mkm2, 13.95);
    assert.equal(payload.ohc_0_700m_zj, 228.45);
    assert.equal(payload.sst_anomaly_c, 0.91);
    assert.equal(payload.sea_level_annual_rise_mm, 4.4);
    assert.equal(payload.measured_at, Date.UTC(2026, 2, 31));
  });

  it('counts partial scalar sections so validation does not discard useful partial data', () => {
    assert.equal(countIndicators({ sea_level_annual_rise_mm: 4.4 }), 1);
    assert.equal(countIndicators({ arctic_extent_anomaly_mkm2: -0.75 }), 1);
    assert.equal(countIndicators({ ice_trend_12m: [{ month: '2026-03', extent_mkm2: 13.95, anomaly_mkm2: -0.75 }] }), 1);
  });

  it('preserves prior cache for failed source groups only', () => {
    const prior = {
      arctic_extent_mkm2: 13.5,
      arctic_extent_anomaly_mkm2: -0.5,
      arctic_trend: 'below_average',
      sea_level_mm_above_1993: 98.8,
      sea_level_annual_rise_mm: 4.4,
      ohc_0_700m_zj: 220.0,
      sst_anomaly_c: 0.85,
    };
    // seaIce succeeded, seaLevel failed (null), ohc failed (null), sst succeeded
    const payload = buildOceanIcePayload(
      [
        { data: { arctic_extent_mkm2: 14.0 }, measuredAt: Date.UTC(2026, 2, 31) },
        null,
        null,
        { data: { sst_anomaly_c: 0.91 } },
      ],
      prior,
    );

    assert.equal(payload.arctic_extent_mkm2, 14.0);
    assert.equal(payload.arctic_extent_anomaly_mkm2, undefined, 'sea-ice section omitted anomaly — must not bleed from prior');
    assert.equal(payload.arctic_trend, undefined, 'sea-ice section omitted trend — must not bleed from prior');
    assert.equal(payload.sea_level_mm_above_1993, 98.8, 'sea-level failed — falls back to prior');
    assert.equal(payload.ohc_0_700m_zj, 220.0, 'ohc failed — falls back to prior');
    assert.equal(payload.sst_anomaly_c, 0.91, 'sst succeeded — uses fresh value');
  });

  it('sea-ice climatology unavailable + unrelated failure does not reintroduce stale anomaly/trend', () => {
    const prior = {
      arctic_extent_mkm2: 13.5,
      arctic_extent_anomaly_mkm2: -0.5,
      arctic_trend: 'below_average',
      ohc_0_700m_zj: 220.0,
    };
    // seaIce succeeded but omitted anomaly/trend (no climatology), seaLevel ok, ohc failed, sst ok
    const payload = buildOceanIcePayload(
      [
        { data: { arctic_extent_mkm2: 14.0 }, measuredAt: Date.UTC(2026, 2, 31) },
        { data: { sea_level_mm_above_1993: 99.0 } },
        null,
        { data: { sst_anomaly_c: 0.91 } },
      ],
      prior,
    );

    assert.equal(payload.arctic_extent_mkm2, 14.0);
    assert.equal(payload.arctic_extent_anomaly_mkm2, undefined, 'must not reintroduce stale anomaly');
    assert.equal(payload.arctic_trend, undefined, 'must not reintroduce stale trend');
    assert.equal(payload.ohc_0_700m_zj, 220.0, 'ohc failed — prior preserved');
    assert.equal(payload.sst_anomaly_c, 0.91);
  });

  it('does not use prior cache when all sources succeed', () => {
    const payload = buildOceanIcePayload(
      [
        { data: { arctic_extent_mkm2: 14.0 }, measuredAt: Date.UTC(2026, 2, 31) },
        { data: { sea_level_mm_above_1993: 99.0 } },
        { data: { ohc_0_700m_zj: 230.0 } },
        { data: { sst_anomaly_c: 0.91 } },
      ],
      undefined,
    );

    assert.equal(payload.arctic_extent_mkm2, 14.0);
    assert.equal(payload.sea_level_mm_above_1993, 99.0);
  });

  it('fallback sea level rate regex matches the current rate, not the historical one', () => {
    const seaLevel = parseSeaLevelOverlay(`
      <p>The rate has increased from 0.08 inches/year (0.20 centimeters/year) in 1993
      to the current rate of 0.17 inches/year (0.44 centimeters/year).</p>
    `);
    assert.equal(seaLevel.seaLevelAnnualRiseMm, 4.4);
  });
});

describe('open-meteo archive helper', () => {
  it('caps oversized Retry-After values', () => {
    assert.equal(parseRetryAfterMs('86400'), 60_000);
  });

  it('retries transient fetch errors', async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;

    try {
      globalThis.fetch = async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new TypeError('fetch failed');
        }

        return new Response(JSON.stringify({
          daily: {
            time: ['2026-03-01'],
            temperature_2m_mean: [12],
            precipitation_sum: [1],
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const result = await fetchOpenMeteoArchiveBatch(
        [{ name: 'Retry Zone', lat: 1, lon: 2 }],
        {
          startDate: '2026-03-01',
          endDate: '2026-03-01',
          daily: ['temperature_2m_mean', 'precipitation_sum'],
          maxRetries: 1,
          retryBaseMs: 0,
          label: 'network retry test',
        },
      );

      assert.equal(attempts, 2);
      assert.equal(result.length, 1);
      assert.equal(result[0].daily.time[0], '2026-03-01');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retries transient 503 responses', async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;

    try {
      globalThis.fetch = async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response('busy', { status: 503 });
        }

        return new Response(JSON.stringify({
          daily: {
            time: ['2026-03-01'],
            temperature_2m_mean: [12],
            precipitation_sum: [1],
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const result = await fetchOpenMeteoArchiveBatch(
        [{ name: 'Retry Zone', lat: 1, lon: 2 }],
        {
          startDate: '2026-03-01',
          endDate: '2026-03-01',
          daily: ['temperature_2m_mean', 'precipitation_sum'],
          maxRetries: 1,
          retryBaseMs: 0,
          label: 'retry test',
        },
      );

      assert.equal(attempts, 2);
      assert.equal(result.length, 1);
      assert.equal(result[0].daily.time[0], '2026-03-01');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
