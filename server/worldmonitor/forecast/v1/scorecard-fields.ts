import type {
  GetForecastScorecardResponse,
  MarketAlertRow,
  MarketAlertScorecard,
  ScorecardPublishedDomain,
  ScorecardSkill,
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

// Skill against the cohort base rate (#8990). The public OpenAPI document sits
// at its 950,000-byte cap, which had room for the headline bssCi95 and the
// domain bss only; the MCP tool also serves the *_EXTENDED_FIELDS the seeder
// writes beside them. Both contract lists mirror SKILL_FIELDS and
// PUBLISHED_DOMAIN_FIELDS in scripts/build-accuracy-page.mjs (a test pins the parity).
export const SKILL_FIELDS = [
  'count', 'brier', 'logScore', 'excludedScored', 'excludedOrigins', 'yesCount', 'bssCi95',
] as const satisfies readonly (keyof ScorecardSkill)[];
export const SKILL_EXTENDED_FIELDS = [
  'families', 'nEff', 'yesFamilies', 'noFamilies', 'referenceBrier', 'bss', 'measurable',
] as const;
export const PUBLISHED_DOMAIN_FIELDS = [
  'domain', 'count', 'brier', 'yesCount', 'bss',
] as const satisfies readonly (keyof ScorecardPublishedDomain)[];
export const PUBLISHED_DOMAIN_EXTENDED_FIELDS = [
  'families', 'nEff', 'yesFamilies', 'noFamilies', 'referenceBrier', 'bssCi95', 'measurable',
] as const;

type MemberLists = readonly [contract: readonly string[], extended?: readonly string[]];
const ROW_FIELDS: Record<string, MemberLists> = {
  receipts: [RECEIPT_FIELDS],
  familyOutcomes: [FAMILY_OUTCOME_FIELDS],
  publishedByDomain: [PUBLISHED_DOMAIN_FIELDS, PUBLISHED_DOMAIN_EXTENDED_FIELDS],
};
const OBJECT_FIELDS: Record<string, MemberLists> = { skill: [SKILL_FIELDS, SKILL_EXTENDED_FIELDS] };

function memberList([contract, extended = []]: MemberLists, withExtended: boolean): readonly string[] {
  return withExtended ? [...contract, ...extended] : contract;
}

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

// skill passed through whole before #8990, null members included; selecting
// its members keeps that, so only undeclared keys change.
function pickPresent(value: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (value[field] !== undefined) out[field] = value[field];
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

/** `extended` adds the members the seeder writes beyond the contract; only the MCP tool asks for them. */
export function selectScorecardFields(data: Record<string, unknown>, { extended = false } = {}): Partial<ScorecardData> {
  const selected: Record<string, unknown> = {};
  for (const field of SCORECARD_DATA_FIELDS) {
    if (data[field] == null) continue;
    const rowFields = ROW_FIELDS[field];
    const objectFields = OBJECT_FIELDS[field];
    const value = rowFields
      ? selectRows(data[field], memberList(rowFields, extended))
      : objectFields
        ? (isRecord(data[field]) ? pickPresent(data[field] as Record<string, unknown>, memberList(objectFields, extended)) : undefined)
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

// The median lead time is taken over HIT rows only, and the contract carries
// no hit count beside it, so it is withheld wherever /accuracy/ withholds it
// (marketAlertMedianPublished in scripts/build-accuracy-page.mjs, test-pinned).
export const MARKET_ALERT_MEDIAN_MIN_HITS = 30;
// A prediction question's topic words reach the news often anyway, so the page
// publishes nothing for this type until 30 control windows scored.
const CONTROL_GATED_ALERT_TYPES = new Set(['prediction_leads_news']);

const isRate = (value: unknown): boolean => typeof value === 'number' && value >= 0 && value <= 1;
const atFloor = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= MARKET_ALERT_MEDIAN_MIN_HITS;

function medianPublished(row: Record<string, unknown>): boolean {
  const compared = atFloor(row.baseN) && isRate(row.pairedHitRate) && isRate(row.baseHitRate);
  return atFloor(row.hit) && isRate(row.hitRate) && (compared || !CONTROL_GATED_ALERT_TYPES.has(String(row.type)));
}

// The ledger names the count n, which sebuf's JSON output turns into the
// property "false" (YAML 1.1), so the contract calls it scored. The ledger's
// median of an even count can end in .5, and the contract field is int64.
function selectMarketAlertRow(row: Record<string, unknown>): Record<string, unknown> {
  const selected = pickNonNull(row, MARKET_ALERT_ROW_FIELDS);
  if (row.n != null) selected.scored = row.n;
  if (!medianPublished(row)) delete selected.medianLeadTimeMs;
  if (typeof selected.medianLeadTimeMs === 'number') selected.medianLeadTimeMs = Math.round(selected.medianLeadTimeMs);
  return selected;
}
