import type {
  GetForecastScorecardResponse,
  MarketAlertRow,
  MarketAlertScorecard,
} from '../../../../src/generated/server/worldmonitor/forecast/v1/service_server';

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
  'receipts',
  'familyOutcomes',
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

// Mirrors PUBLIC_RECEIPT_FIELDS in scripts/_forecast-scorecard.mjs (a test pins
// the parity), so a seeder row carrying anything else is trimmed here too.
export const RECEIPT_FIELDS = [
  'question', 'forecastAt', 'probability', 'outcome', 'resolvedAt',
  'voidReason', 'sourceFeed', 'observedValue', 'citationTitle', 'citationUrl',
] as const;

// Mirrors PUBLIC_FAMILY_OUTCOME_FIELDS in scripts/_forecast-scorecard.mjs (a test pins the parity).
export const FAMILY_OUTCOME_FIELDS = ['forecastId', 'outcome', 'voidReason'] as const;

const ROW_FIELDS: Record<string, readonly string[]> = { receipts: RECEIPT_FIELDS, familyOutcomes: FAMILY_OUTCOME_FIELDS };

function selectRows(value: unknown, fields: readonly string[]): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isRecord).map((row) => pickNonNull(row, fields));
}

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
    const rowFields = ROW_FIELDS[field];
    const value = rowFields
      ? selectRows(data[field], rowFields)
      : field in SCORECARD_BLOCK_FIELDS ? selectBlock(field as BlockName, data[field]) : data[field];
    if (value !== undefined) selected[field] = value;
  }
  return selected as Partial<ScorecardData>;
}

// The market-alert ledger scorecard (#8867) rides on the same response from
// its own key. Seeder totals, archive status and per-row outcome counts stay
// off the contract; a null row member is an optional proto field, so it is
// omitted rather than served as null.
export const MARKET_ALERT_FIELDS = [
  'generatedAt', 'windowHours', 'rollingWindowDays', 'methodology', 'byType',
] as const satisfies readonly (keyof MarketAlertScorecard)[];
export const MARKET_ALERT_ROW_FIELDS = [
  'type', 'scored', 'hitRate', 'baseN', 'baseHitRate', 'pairedHitRate', 'medianLeadTimeMs',
] as const satisfies readonly (keyof MarketAlertRow)[];

export function selectMarketAlertScorecard(value: unknown): MarketAlertScorecard | undefined {
  if (!isRecord(value) || typeof value.generatedAt !== 'number' || !Number.isFinite(value.generatedAt)) return undefined;
  const selected = pickNonNull(value, MARKET_ALERT_FIELDS);
  selected.byType = Array.isArray(value.byType)
    ? value.byType.filter(isRecord).map(selectMarketAlertRow)
    : [];
  return selected as unknown as MarketAlertScorecard;
}

// The ledger names the count n, which sebuf's JSON output turns into the
// property "false" (YAML 1.1), so the contract calls it scored. The ledger's
// median of an even count can end in .5, and the contract field is int64.
function selectMarketAlertRow(row: Record<string, unknown>): Record<string, unknown> {
  const selected = pickNonNull(row, MARKET_ALERT_ROW_FIELDS);
  if (row.n != null) selected.scored = row.n;
  if (typeof selected.medianLeadTimeMs === 'number') selected.medianLeadTimeMs = Math.round(selected.medianLeadTimeMs);
  return selected;
}
