// MCP projection for get_reservoir_levels (climate:reservoir-levels:v1).
//
// Reuses the REST handler's normalizer, so MCP and /api/climate/v1/list-reservoir-levels
// agree on every field. The stored series is [date, levelM] tuples; the normalizer turns
// it into {date, levelM} objects, which the projection drops unless include_series is set.

import { normalizeReservoirLevelsSeed } from '../../../server/worldmonitor/climate/v1/list-reservoir-levels';
import { matchesCode } from '../filters';

export const RESERVOIR_LEVELS_LABEL = 'reservoir-levels';

// classifyStatus in scripts/_reservoir-levels.mjs; tests/mcp-reservoir-levels.test.mjs pins the match.
export const RESERVOIR_STATUSES = [
  'record_low', 'falling_fast', 'low', 'normal', 'high', 'rising_fast', 'record_high',
  'no_recent_data', 'insufficient_history',
] as const;

export type ReservoirLevelsQuery = {
  countries: string[];
  status: string;
  id: string;
  includeSeries: boolean;
};

export function projectReservoirLevels(raw: unknown, query: ReservoirLevelsQuery): Record<string, unknown> {
  const snapshot = normalizeReservoirLevelsSeed(raw);
  const reservoirs = snapshot.reservoirs
    .filter((r) => matchesCode([r.country, ...r.riparians], query.countries))
    .filter((r) => !query.status || r.status === query.status)
    .filter((r) => !query.id || r.id === query.id)
    .map(({ series, ...r }) => (query.includeSeries ? { ...r, series } : r));
  return { ...snapshot, reservoirs };
}

const POINT_SCHEMA = {
  type: 'object',
  properties: { date: { type: 'string', description: 'UTC pass date, YYYY-MM-DD.' }, levelM: { type: 'number' } },
  required: ['date', 'levelM'],
};

const metres = (description: string) => ({ type: 'number', description });

export const RESERVOIR_LEVELS_OUTPUT_SCHEMA = {
  type: ['object', 'null'],
  properties: {
    dataAvailable: { type: 'boolean', description: 'false when no snapshot was readable; reservoirs is then empty.' },
    fetchedAt: { type: 'integer', description: 'Seed run time, epoch milliseconds.' },
    source: { type: 'object', properties: { name: { type: 'string' }, product: { type: 'string' }, url: { type: 'string' }, processing: { type: 'string' } } },
    methodology: { type: 'string' },
    reservoirs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          country: { type: 'string', description: 'ISO 3166-1 alpha-2 code of the country holding the dam or lake.' },
          riparians: { type: 'array', items: { type: 'string' }, description: 'ISO 3166-1 alpha-2 codes of every country sharing the water.' },
          river: { type: 'string' },
          lat: { type: 'number' },
          lon: { type: 'number' },
          tags: { type: 'array', items: { type: 'string' } },
          why: { type: 'string', description: 'Why the reservoir is on the watchlist.' },
          latest: {
            type: 'object',
            description: 'Newest qualifying pass. Absent when the reservoir has none.',
            properties: {
              date: { type: 'string' },
              levelM: metres('Water-surface height, metres above the EGM2008 geoid.'),
              madM: metres('Median absolute deviation of the pass segments, metres.'),
              segmentCount: { type: 'integer' },
              ageDays: { type: 'integer', description: 'Days since the overpass. Normally 50 or more because passes publish late.' },
            },
          },
          prevDate: { type: 'string' },
          recordStart: { type: 'string', description: 'Date of the first qualifying pass.' },
          recordLow: { type: 'boolean' },
          recordHigh: { type: 'boolean' },
          status: { type: 'string', enum: [...RESERVOIR_STATUSES] },
          okPassCount: { type: 'integer' },
          changePrevM: metres('Change since the previous pass, metres.'),
          change30dM: metres('Change over about 30 days, metres.'),
          change90dM: metres('Change over about 90 days, metres.'),
          change365dM: metres('Change over about 365 days, metres.'),
          seasonalAnomalyM: metres('Departure from the median level at the same time of year in earlier years, metres.'),
          seasonalZ: { type: 'number', description: 'Seasonal anomaly in robust standard deviations.' },
          recordMinM: metres('Lowest qualifying level on record, metres.'),
          recordMaxM: metres('Highest qualifying level on record, metres.'),
          percentOfRange: { type: 'number', description: 'Latest level as a percent of the record range.' },
          series: { type: 'array', items: POINT_SCHEMA, description: 'Present with include_series: one point per pass day over the 36 months before the latest pass, oldest first.' },
        },
        required: ['id', 'name', 'country', 'riparians', 'status'],
      },
    },
  },
};
