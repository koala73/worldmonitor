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
