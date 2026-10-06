import type { GetForecastScorecardResponse } from '../../../../src/generated/server/worldmonitor/forecast/v1/service_server';

// The producer-owned fields of the public scorecard. Seeder observability and
// experiments (judgedLane, calibrationShadow, ...) share the Redis value but
// are not part of the contract, so both the REST handler and the MCP tool
// select from this list instead of spreading the stored object.
export const SCORECARD_DATA_FIELDS = [
  'schemaVersion',
  'generatedAt',
  'rollingWindowDays',
  'methodology',
  'totals',
  'overall',
  'byDomain',
  'byGenerationOrigin',
  'calibration',
  'vsMarketSkill',
  'skill',
] as const satisfies readonly (keyof GetForecastScorecardResponse)[];

export type ScorecardData = Pick<GetForecastScorecardResponse, typeof SCORECARD_DATA_FIELDS[number]>;

export function selectScorecardFields(data: Record<string, unknown>): Partial<ScorecardData> {
  const selected: Record<string, unknown> = {};
  for (const field of SCORECARD_DATA_FIELDS) {
    if (data[field] != null) selected[field] = data[field];
  }
  return selected as Partial<ScorecardData>;
}
