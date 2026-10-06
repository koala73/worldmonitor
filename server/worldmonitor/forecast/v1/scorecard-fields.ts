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
  'publishedByDomain',
  'uncertainty',
  'funnel',
] as const satisfies readonly (keyof GetForecastScorecardResponse)[];

export type ScorecardData = Pick<GetForecastScorecardResponse, typeof SCORECARD_DATA_FIELDS[number]>;

const INTERVAL_FIELDS = ['count', 'mean', 'ci95', 'insufficientSample'] as const;
const PROPORTION_FIELDS = ['count', 'successes', 'rate', 'ci95'] as const;

// The two #7072 blocks are filtered member by member, matching
// SCORECARD_NESTED_OBJECT_FIELDS and SCORECARD_NESTED_CHILD_FIELDS in
// scripts/build-accuracy-page.mjs (a test pins the parity). The producer writes
// null for an interval or rate it cannot compute; the contract types those as
// optional messages, so null is omitted here. Older blocks pass through as-is.
export const SCORECARD_BLOCK_FIELDS = {
  uncertainty: {
    fields: ['method', 'overallBrier', 'skillBrier'],
    children: { overallBrier: INTERVAL_FIELDS, skillBrier: INTERVAL_FIELDS },
  },
  funnel: {
    fields: [
      'matured', 'immature', 'maturityUnknown', 'resolved', 'scored', 'pendingHardMatured', 'pendingJudgeMatured',
      'resolvedOfMatured', 'scoredOfMatured',
    ],
    children: { resolvedOfMatured: PROPORTION_FIELDS, scoredOfMatured: PROPORTION_FIELDS },
  },
} as const;

type BlockName = keyof typeof SCORECARD_BLOCK_FIELDS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function pickNonNull(value: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (value[field] != null) out[field] = value[field];
  }
  return out;
}

function selectBlock(block: BlockName, value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const { fields, children } = SCORECARD_BLOCK_FIELDS[block];
  const out = pickNonNull(value, fields);
  for (const [child, childFields] of Object.entries(children)) {
    if (!(child in out)) continue;
    if (isRecord(out[child])) out[child] = pickNonNull(out[child] as Record<string, unknown>, childFields);
    else delete out[child];
  }
  return out;
}

export function selectScorecardFields(data: Record<string, unknown>): Partial<ScorecardData> {
  const selected: Record<string, unknown> = {};
  for (const field of SCORECARD_DATA_FIELDS) {
    if (data[field] == null) continue;
    const value = field in SCORECARD_BLOCK_FIELDS ? selectBlock(field as BlockName, data[field]) : data[field];
    if (value !== undefined) selected[field] = value;
  }
  return selected as Partial<ScorecardData>;
}
