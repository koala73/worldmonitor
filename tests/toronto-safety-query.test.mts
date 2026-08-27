import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../src/generated/server/worldmonitor/safety/v1/service_server.ts';
import { queryTorontoSafety } from '../server/worldmonitor/safety/v1/get-toronto-safety.ts';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';

const MCI_KEY = 'safety:toronto:tps-mci:v1';
const MCI_META = 'seed-meta:safety:tps-mci';
const CALLS_KEY = 'safety:toronto:tps-calls-attended:v1';
const CALLS_META = 'seed-meta:safety:tps-calls-attended';

function reader(values: Map<string, unknown>) {
  return async (key: string) => values.has(key)
    ? { status: 'hit' as const, value: values.get(key) }
    : { status: 'miss' as const };
}

function request(overrides: Partial<{
  dataset: string;
  limit: number;
  division: string;
  neighbourhood: string;
  offence: string;
  year: number;
}> = {}) {
  return {
    dataset: '',
    limit: 0,
    division: '',
    neighbourhood: '',
    offence: '',
    year: 0,
    ...overrides,
  };
}

describe('Toronto safety bounded query surfaces (#7012)', () => {
  it('filters and caps reported occurrences while preserving approximate-location semantics', async () => {
    const records = Array.from({ length: 120 }, (_, index) => ({
      id: `tps-mci:${index + 1}`,
      objectId: index + 1,
      eventUniqueId: `GO-2026-${index}`,
      reportDate: '2026-06-30T00:00:00.000Z',
      occDate: '2026-06-29T00:00:00.000Z',
      division: index === 119 ? 'D52' : 'D51',
      locationType: 'Street',
      premisesType: 'Outside',
      offence: index === 119 ? 'Robbery' : 'Assault',
      csiCategory: 'Violent crime',
      neighbourhood158: index === 119 ? 'Harbourfront' : 'Downtown Yonge East',
      lon: -79.38,
      lat: 43.65,
      approximate: true,
    }));
    const values = new Map<string, unknown>([
      [MCI_KEY, {
        semantic: 'reported_occurrence',
        source: 'tps-mci',
        fetchedAt: '2026-08-20T00:00:00.000Z',
        editingInfo: { dataLastEditDate: 1787200000000 },
        newestContentAt: 1782777600000,
        records,
      }],
      [MCI_META, { fetchedAt: 1787200000000, sourceState: 'ok', dataLastEditDate: 1787190000000, newestContentAt: 1782777600000 }],
    ]);

    const bounded = await queryTorontoSafety(request({ dataset: 'reported_occurrence', limit: 999 }), reader(values));
    assert.equal(bounded.occurrences.length, 100);
    assert.equal(bounded.matched, 120);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.occurrences.every((row) => row.approximate), true);
    assert.match(bounded.attribution, /Open Government Licence - Ontario/);
    assert.match(bounded.disclaimer, /Not a live dispatch feed/);
    assert.equal(JSON.stringify(bounded).includes('GTA Update'), false);

    const filtered = await queryTorontoSafety(request({
      dataset: 'reported_occurrence', division: 'd52', offence: 'rob', neighbourhood: 'harbour', year: 2026,
    }), reader(values));
    assert.equal(filtered.matched, 1);
    assert.equal(filtered.occurrences[0]?.offence, 'Robbery');
  });

  it('keeps annual aggregates separate and never emits incident points', async () => {
    const values = new Map<string, unknown>([
      [CALLS_KEY, {
        semantic: 'annual_aggregate', source: 'tps-calls-attended', newestContentYear: 2025,
        records: [
          { id: 'tps-calls:1', objectId: 1, eventYear: 2025, divisionOriginal: 'D51', divisionFinal: 'D52', neighbourhood158: 'Harbourfront', eventCount: 42 },
          { id: 'tps-calls:2', objectId: 2, eventYear: 2024, divisionOriginal: 'D51', divisionFinal: 'D51', neighbourhood158: 'Downtown', eventCount: 9 },
        ],
      }],
      [CALLS_META, { fetchedAt: 1787200000000, sourceState: 'degraded', newestContentYear: 2025 }],
    ]);
    const result = await queryTorontoSafety(request({ dataset: 'annual_aggregate', year: 2025, division: '52' }), reader(values));
    assert.equal(result.occurrences.length, 0);
    assert.equal(result.aggregates.length, 1);
    assert.equal(result.aggregates[0]?.incidentPoint, false);
    assert.equal(result.degraded, true);
    assert.equal(result.newestContentYear, 2025);
  });

  it('reports an unpublished on-demand key as unavailable and rejects unknown datasets', async () => {
    const missing = await queryTorontoSafety(request({ dataset: 'reported_occurrence' }), reader(new Map()));
    assert.equal(missing.unavailable, true);
    assert.deepEqual(missing.occurrences, []);
    await assert.rejects(
      queryTorontoSafety(request({ dataset: 'live_dispatch' }), reader(new Map())),
      (error: unknown) => error instanceof ApiError && error.statusCode === 400,
    );
  });

  it('registers two independent, bounded MCP cache tools with the Safety RPC path', () => {
    const occurrences = CACHE_TOOLS.find((tool) => tool.name === 'get_toronto_reported_occurrences');
    const calls = CACHE_TOOLS.find((tool) => tool.name === 'get_toronto_calls_attended');
    assert.ok(occurrences && '_cacheKeys' in occurrences && occurrences._postFilter);
    assert.ok(calls && '_cacheKeys' in calls && calls._postFilter);
    assert.deepEqual(occurrences._cacheKeys, [MCI_KEY]);
    assert.deepEqual(calls._cacheKeys, [CALLS_KEY]);
    assert.deepEqual(occurrences._apiPaths, ['GET /api/safety/v1/get-toronto-safety']);
    assert.deepEqual(calls._apiPaths, ['GET /api/safety/v1/get-toronto-safety']);
    assert.equal(occurrences._freshnessChecks[0]?.key, MCI_META);
    assert.equal(calls._freshnessChecks[0]?.key, CALLS_META);

    const occurrenceData = {
      reported_occurrences: {
        records: Array.from({ length: 120 }, (_, index) => ({ division: index ? 'D51' : 'D52', neighbourhood158: 'Downtown', offence: 'Assault' })),
      },
    };
    occurrences._postFilter(occurrenceData, { division: 'd51', limit: 500 });
    assert.equal(occurrenceData.reported_occurrences.records.length, 100);

    const callsData = {
      annual_aggregates: {
        records: [
          { eventYear: 2025, divisionOriginal: 'D51', divisionFinal: 'D52', neighbourhood158: 'Harbourfront' },
          { eventYear: 2024, divisionOriginal: 'D51', divisionFinal: 'D51', neighbourhood158: 'Downtown' },
        ],
      },
    };
    calls._postFilter(callsData, { year: 2025, division: '52' });
    assert.equal(callsData.annual_aggregates.records.length, 1);
  });
});
