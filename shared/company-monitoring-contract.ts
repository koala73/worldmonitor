/**
 * Company Monitoring's storage-independent public contract.
 *
 * Public callers use stable logical IDs and opaque cursors. Account identity is
 * always supplied by trusted server context, never by a request field.
 */

export const COMPANY_MONITORING_LIMITS = {
  maxCompaniesPerAccount: 500,
  maxRequestBytes: 256 * 1024,
  maxImportBatchBytes: 256 * 1024,
  maxImportRows: 100,
  maxImportRowBytes: 8 * 1024,
  maxClientImportIdBytes: 64,
  maxNameBytes: 256,
  maxCustomerReferenceBytes: 128,
  maxAliasBytes: 256,
  maxDomainBytes: 253,
  maxIdentifierBytes: 512,
  maxXHandleBytes: 15,
  maxXHandleInputBytes: 16,
  maxXAccountIdBytes: 32,
  maxLocationBytes: 256,
  maxAliases: 20,
  maxDomains: 10,
  maxIdentifiers: 20,
  maxXHandles: 5,
  maxLocations: 20,
  maxClaimsPerCompany: 81,
  maxEvidenceReferences: 20,
  maxPageSize: 100,
  maxCursorBytes: 2_048,
  maxCursorTtlMs: 24 * 60 * 60 * 1000,
  maxCursorClockSkewMs: 60 * 1000,
} as const;

export const COMPANY_MONITORING_CURSOR_VERSION = 1 as const;
export const COMPANY_MONITORING_IMPORT_VERSION = 'cm-import-v1' as const;
export const COMPANY_MONITORING_IMPORT_PATH = '/api/company-monitoring/v1/import-monitored-company-batch' as const;

export const COMPANY_MONITORING_RPC_SCOPES = {
  CreateMonitoredCompany: 'company_monitoring:write',
  UpdateMonitoredCompany: 'company_monitoring:write',
  SetMonitoredCompanyState: 'company_monitoring:write',
  ImportMonitoredCompanyBatch: 'company_monitoring:write',
  ListMonitoredCompanies: 'company_monitoring:read',
  ListCompanyEventImpacts: 'company_monitoring:read',
  ListCompanyEventChanges: 'company_monitoring:read',
  GetCompanyMaterialEvent: 'company_monitoring:read',
  GetCompanyCoverage: 'company_monitoring:read',
  GetCompanyMonitoringStatus: 'company_monitoring:read',
} as const;

export type CompanyMonitoringRpc = keyof typeof COMPANY_MONITORING_RPC_SCOPES;
export type CompanyMonitoringApiScope = typeof COMPANY_MONITORING_RPC_SCOPES[CompanyMonitoringRpc];

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/u;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const X_HANDLE = /^[a-z0-9_]{1,15}$/;
const X_ACCOUNT_ID = /^\d{1,32}$/;
const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const FILTER_HASH = /^[a-f0-9]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const LOGICAL_ID_PREFIXES = {
  company: 'cm_company_',
  claim: 'cm_claim_',
  event: 'cm_event_',
  impact: 'cm_impact_',
  evidence: 'cm_evidence_',
} as const;
const ULID = '[0-9A-HJKMNP-TV-Z]{26}';

const encoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function assertPlainText(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const unicodeNormalized = value.normalize('NFC');
  if (CONTROL_CHARACTERS.test(unicodeNormalized)) throw new Error(`${field} contains control characters`);
  const normalized = unicodeNormalized.trim().replace(/\s+/g, ' ');
  if (!normalized) throw new Error(`${field} is required`);
  if (utf8Bytes(normalized) > maxBytes) throw new Error(`${field} exceeds ${maxBytes} bytes`);
  return normalized;
}

function normalizeOptionalText(value: unknown, field: string, maxBytes: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return assertPlainText(value, field, maxBytes);
}

function normalizeList(
  value: unknown,
  field: string,
  maxItems: number,
  normalize: (item: unknown, index: number) => string,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be a list`);
  if (value.length > maxItems) throw new Error(`${field} exceeds ${maxItems} items`);
  return [...new Set(value.map(normalize))].sort();
}

function normalizeDomain(value: unknown, index: number): string {
  const domain = assertPlainText(
    value,
    `domains[${index}]`,
    COMPANY_MONITORING_LIMITS.maxDomainBytes,
  ).toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!DOMAIN.test(domain)) throw new Error(`invalid domain: ${domain}`);
  return domain;
}

function normalizeXHandle(value: unknown, index: number): string {
  const handle = assertPlainText(
    value,
    `xHandles[${index}]`,
    COMPANY_MONITORING_LIMITS.maxXHandleInputBytes,
  ).replace(/^@/, '').toLowerCase();
  if (!X_HANDLE.test(handle)) throw new Error(`invalid X handle: ${handle}`);
  return handle;
}

const DOMICILE_COUNTRY_BY_INPUT = {
  US: 'US',
  GB: 'GB',
  DOMICILE_COUNTRY_US: 'US',
  DOMICILE_COUNTRY_GB: 'GB',
} as const;

export type CompanyClaimType =
  | 'alias'
  | 'domain'
  | 'legal_identifier'
  | 'x_account_id'
  | 'x_handle'
  | 'location'
  | 'customer_reference';

const COMPANY_CLAIM_TYPE_BY_INPUT: Readonly<Record<string, CompanyClaimType>> = {
  alias: 'alias',
  domain: 'domain',
  legal_identifier: 'legal_identifier',
  x_account_id: 'x_account_id',
  x_handle: 'x_handle',
  location: 'location',
  customer_reference: 'customer_reference',
  COMPANY_CLAIM_TYPE_ALIAS: 'alias',
  COMPANY_CLAIM_TYPE_DOMAIN: 'domain',
  COMPANY_CLAIM_TYPE_LEGAL_IDENTIFIER: 'legal_identifier',
  COMPANY_CLAIM_TYPE_X_ACCOUNT_ID: 'x_account_id',
  COMPANY_CLAIM_TYPE_X_HANDLE: 'x_handle',
  COMPANY_CLAIM_TYPE_LOCATION: 'location',
  COMPANY_CLAIM_TYPE_CUSTOMER_REFERENCE: 'customer_reference',
};

export interface CompanyClaimInput {
  type: string;
  value: string;
}

export interface NormalizedCompanyClaimInput {
  type: CompanyClaimType;
  value: string;
}

export function normalizeCompanyClaimInput(input: CompanyClaimInput): NormalizedCompanyClaimInput {
  if (!input || typeof input !== 'object') throw new Error('company claim is required');
  // Own-property lookup: a plain object literal inherits `__proto__`, `constructor`,
  // `toString`, etc., and a truthiness check would let those through as a "valid" type.
  const type = Object.hasOwn(COMPANY_CLAIM_TYPE_BY_INPUT, input.type)
    ? COMPANY_CLAIM_TYPE_BY_INPUT[input.type]
    : undefined;
  if (!type) throw new Error('company claim type is invalid');

  let value: string;
  switch (type) {
    case 'alias':
      value = assertPlainText(input.value, 'claim.value', COMPANY_MONITORING_LIMITS.maxAliasBytes);
      break;
    case 'domain':
      value = normalizeDomain(input.value, 0);
      break;
    case 'legal_identifier':
      value = assertPlainText(input.value, 'claim.value', COMPANY_MONITORING_LIMITS.maxIdentifierBytes);
      break;
    case 'x_account_id':
      value = assertPlainText(input.value, 'claim.value', COMPANY_MONITORING_LIMITS.maxXAccountIdBytes);
      if (!X_ACCOUNT_ID.test(value)) throw new Error('invalid X account ID');
      break;
    case 'x_handle':
      value = normalizeXHandle(input.value, 0);
      break;
    case 'location':
      value = assertPlainText(input.value, 'claim.value', COMPANY_MONITORING_LIMITS.maxLocationBytes);
      break;
    case 'customer_reference':
      value = assertPlainText(input.value, 'claim.value', COMPANY_MONITORING_LIMITS.maxCustomerReferenceBytes);
      break;
  }
  return { type, value };
}

export interface MonitoredCompanyInput {
  name: string;
  domicileCountry: string;
  aliases?: string[];
  domains?: string[];
  identifiers?: string[];
  xHandles?: string[];
  locations?: string[];
  customerReference?: string;
}

export interface CompanyImportRowInput extends MonitoredCompanyInput {
  clientImportId: string;
  ordinal: number;
}

export interface NormalizedMonitoredCompanyInput {
  name: string;
  domicileCountry: 'US' | 'GB';
  aliases: string[];
  domains: string[];
  identifiers: string[];
  xHandles: string[];
  locations: string[];
  customerReference?: string;
}

export interface NormalizedCompanyImportRow extends NormalizedMonitoredCompanyInput {
  contractVersion: typeof COMPANY_MONITORING_IMPORT_VERSION;
  clientImportId: string;
  ordinal: number;
}

export function normalizeMonitoredCompanyInput(input: MonitoredCompanyInput): NormalizedMonitoredCompanyInput {
  if (!input || typeof input !== 'object') throw new Error('company input is required');
  const domicileInput = String(input.domicileCountry ?? '').trim().toUpperCase();
  const domicileCountry = Object.hasOwn(DOMICILE_COUNTRY_BY_INPUT, domicileInput)
    ? DOMICILE_COUNTRY_BY_INPUT[domicileInput as keyof typeof DOMICILE_COUNTRY_BY_INPUT]
    : undefined;
  if (!domicileCountry) {
    throw new Error('domicileCountry must be US or GB');
  }

  const normalized: NormalizedMonitoredCompanyInput = {
    name: assertPlainText(input.name, 'name', COMPANY_MONITORING_LIMITS.maxNameBytes),
    domicileCountry,
    aliases: normalizeList(
      input.aliases,
      'aliases',
      COMPANY_MONITORING_LIMITS.maxAliases,
      (value, index) => assertPlainText(value, `aliases[${index}]`, COMPANY_MONITORING_LIMITS.maxAliasBytes),
    ),
    domains: normalizeList(input.domains, 'domains', COMPANY_MONITORING_LIMITS.maxDomains, normalizeDomain),
    identifiers: normalizeList(
      input.identifiers,
      'identifiers',
      COMPANY_MONITORING_LIMITS.maxIdentifiers,
      (value, index) => assertPlainText(value, `identifiers[${index}]`, COMPANY_MONITORING_LIMITS.maxIdentifierBytes),
    ),
    xHandles: normalizeList(input.xHandles, 'xHandles', COMPANY_MONITORING_LIMITS.maxXHandles, normalizeXHandle),
    locations: normalizeList(
      input.locations,
      'locations',
      COMPANY_MONITORING_LIMITS.maxLocations,
      (value, index) => assertPlainText(value, `locations[${index}]`, COMPANY_MONITORING_LIMITS.maxLocationBytes),
    ),
  };

  const customerReference = normalizeOptionalText(
    input.customerReference,
    'customerReference',
    COMPANY_MONITORING_LIMITS.maxCustomerReferenceBytes,
  );
  if (customerReference !== undefined) normalized.customerReference = customerReference;
  return normalized;
}

export function normalizeCompanyImportRow(input: CompanyImportRowInput): NormalizedCompanyImportRow {
  if (!input || typeof input !== 'object') throw new Error('import row is required');
  const clientImportId = assertPlainText(
    input.clientImportId,
    'clientImportId',
    COMPANY_MONITORING_LIMITS.maxClientImportIdBytes,
  );
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || input.ordinal >= COMPANY_MONITORING_LIMITS.maxImportRows) {
    throw new Error('ordinal must be between 0 and 99');
  }

  const normalized: NormalizedCompanyImportRow = {
    contractVersion: COMPANY_MONITORING_IMPORT_VERSION,
    clientImportId,
    ordinal: input.ordinal,
    ...normalizeMonitoredCompanyInput(input),
  };

  if (utf8Bytes(JSON.stringify(normalized)) > COMPANY_MONITORING_LIMITS.maxImportRowBytes) {
    throw new Error(`row exceeds ${COMPANY_MONITORING_LIMITS.maxImportRowBytes} bytes`);
  }
  return normalized;
}

export function normalizeCompanyImportBatch(inputs: CompanyImportRowInput[]): NormalizedCompanyImportRow[] {
  if (!Array.isArray(inputs)) throw new Error('import batch must be a list');
  if (inputs.length === 0) throw new Error('import batch requires at least one row');
  if (inputs.length > COMPANY_MONITORING_LIMITS.maxImportRows) {
    throw new Error(`batch exceeds ${COMPANY_MONITORING_LIMITS.maxImportRows} rows`);
  }

  const normalized = inputs.map(normalizeCompanyImportRow).sort((left, right) => left.ordinal - right.ordinal);
  const importId = normalized[0]?.clientImportId;
  for (let index = 0; index < normalized.length; index += 1) {
    const row = normalized[index];
    if (row.clientImportId !== importId) throw new Error('batch rows must share one clientImportId');
    if (row.ordinal !== index) throw new Error('batch ordinals must be contiguous from 0');
  }
  if (utf8Bytes(JSON.stringify(normalized)) > COMPANY_MONITORING_LIMITS.maxImportBatchBytes) {
    throw new Error(`batch exceeds ${COMPANY_MONITORING_LIMITS.maxImportBatchBytes} bytes`);
  }
  return normalized;
}

export function assertCompanyMonitoringPayloadSize(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error('request byte length is invalid');
  if (byteLength > COMPANY_MONITORING_LIMITS.maxRequestBytes) {
    throw new Error(`request exceeds ${COMPANY_MONITORING_LIMITS.maxRequestBytes} bytes`);
  }
}

export function assertCompanyMonitoringAccountContext(
  context: { ownerAccountId?: string } | null | undefined,
): string {
  const ownerAccountId = context?.ownerAccountId;
  if (typeof ownerAccountId !== 'string' || !ownerAccountId.trim()) {
    throw new Error('account context is required');
  }
  if (ownerAccountId !== ownerAccountId.trim() || !ACCOUNT_ID.test(ownerAccountId)) {
    throw new Error('account context is invalid');
  }
  return ownerAccountId;
}

export type CompanyMonitoringLogicalIdKind = keyof typeof LOGICAL_ID_PREFIXES;

export function assertLogicalId(kind: CompanyMonitoringLogicalIdKind, value: string): string {
  const pattern = new RegExp(`^${LOGICAL_ID_PREFIXES[kind]}${ULID}$`);
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`invalid ${kind} logical ID`);
  return value;
}

export interface CompanyMonitoringConfidenceAxes {
  attribution: number;
  occurrenceTruth: number;
  materialImpact: number;
  overall: number;
}

export function validateConfidenceAxes(
  axes: CompanyMonitoringConfidenceAxes,
): CompanyMonitoringConfidenceAxes {
  for (const field of ['attribution', 'occurrenceTruth', 'materialImpact', 'overall'] as const) {
    const value = axes?.[field];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${field} must be between 0 and 1`);
    }
  }
  const minimum = Math.min(axes.attribution, axes.occurrenceTruth, axes.materialImpact);
  if (Math.abs(axes.overall - minimum) > Number.EPSILON) {
    throw new Error('overall must equal the minimum confidence axis');
  }
  return axes;
}

// SetMonitoredCompanyState is a *set* operation, so setting a company to the state it
// is already in is a no-op success, not an error: the natural client is a reconciliation
// loop ("ensure every company in my portfolio is active"), and rejecting the no-op would
// error on every already-correct row. Self-transitions are therefore listed explicitly
// on every company state, mirroring the impact machine's existing 'corrected' ->
// 'corrected'. 'removed' remains terminal in the sense that it has no outward edge.
const COMPANY_LIFECYCLE_TRANSITIONS = new Map<string, readonly string[]>([
  ['active', ['active', 'paused', 'removed']],
  ['paused', ['active', 'paused', 'removed']],
  ['removed', ['removed']],
]);
// The impact machine is event-driven (a correction or retraction is recorded, not
// "set"), so only 'corrected' -> 'corrected' is meaningful; re-admitting or
// re-retracting is not, and stays rejected.
const IMPACT_LIFECYCLE_TRANSITIONS = new Map<string, readonly string[]>([
  ['admitted', ['corrected', 'retracted']],
  ['corrected', ['corrected', 'retracted']],
  ['retracted', []],
]);

const LIFECYCLE_MACHINES = {
  company: COMPANY_LIFECYCLE_TRANSITIONS,
  impact: IMPACT_LIFECYCLE_TRANSITIONS,
} as const;

export type LifecycleMachine = keyof typeof LIFECYCLE_MACHINES;

/**
 * Validates a lifecycle transition against ONE named state machine.
 *
 * The machine is an explicit parameter rather than being inferred from `from`: the two
 * vocabularies are disjoint today, but inferring would silently validate an impact
 * transition against the company table the moment either machine gains a shared state
 * name, and nothing would flag it.
 */
export function assertLifecycleTransition(machine: LifecycleMachine, from: string, to: string): void {
  const table = LIFECYCLE_MACHINES[machine];
  if (!table) throw new Error(`unknown lifecycle machine: ${machine}`);
  if (!table.has(from)) {
    throw new Error(`invalid ${machine} lifecycle state: ${from}`);
  }
  if (!table.get(from)?.includes(to)) {
    throw new Error(`invalid lifecycle transition: ${from} -> ${to}`);
  }
}

export function assertCompanyClaimBudget(input: {
  currentCount: number;
  addedCount: number;
  removedCount: number;
}): void {
  for (const [field, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  }
  if (input.removedCount > input.currentCount) throw new Error('removedCount exceeds current claims');
  const resultingCount = input.currentCount - input.removedCount + input.addedCount;
  if (resultingCount > COMPANY_MONITORING_LIMITS.maxClaimsPerCompany) {
    throw new Error(`company claims exceed ${COMPANY_MONITORING_LIMITS.maxClaimsPerCompany}`);
  }
}

const MONITORED_COMPANY_LIFECYCLE_BY_INPUT: Readonly<Record<string, string>> = {
  active: 'active',
  paused: 'paused',
  removed: 'removed',
  MONITORED_COMPANY_LIFECYCLE_ACTIVE: 'active',
  MONITORED_COMPANY_LIFECYCLE_PAUSED: 'paused',
  MONITORED_COMPANY_LIFECYCLE_REMOVED: 'removed',
};
const MATERIAL_IMPACT_LIFECYCLE_BY_INPUT: Readonly<Record<string, string>> = {
  admitted: 'admitted',
  corrected: 'corrected',
  retracted: 'retracted',
  MATERIAL_IMPACT_LIFECYCLE_ADMITTED: 'admitted',
  MATERIAL_IMPACT_LIFECYCLE_CORRECTED: 'corrected',
  MATERIAL_IMPACT_LIFECYCLE_RETRACTED: 'retracted',
};
const COVERAGE_STATE_BY_INPUT: Readonly<Record<string, string>> = {
  awaiting_first_scan: 'awaiting_first_scan',
  adequate: 'adequate',
  partial: 'partial',
  stale: 'stale',
  unavailable: 'unavailable',
  needs_confirmation: 'needs_confirmation',
  COMPANY_COVERAGE_STATE_AWAITING_FIRST_SCAN: 'awaiting_first_scan',
  COMPANY_COVERAGE_STATE_ADEQUATE: 'adequate',
  COMPANY_COVERAGE_STATE_PARTIAL: 'partial',
  COMPANY_COVERAGE_STATE_STALE: 'stale',
  COMPANY_COVERAGE_STATE_UNAVAILABLE: 'unavailable',
  COMPANY_COVERAGE_STATE_NEEDS_CONFIRMATION: 'needs_confirmation',
};
const IMPACT_DIRECTION_BY_INPUT: Readonly<Record<string, string>> = {
  positive: 'positive',
  negative: 'negative',
  mixed: 'mixed',
  MATERIAL_IMPACT_DIRECTION_POSITIVE: 'positive',
  MATERIAL_IMPACT_DIRECTION_NEGATIVE: 'negative',
  MATERIAL_IMPACT_DIRECTION_MIXED: 'mixed',
};

function normalizeFilterValues(
  values: readonly string[],
  field: string,
  vocabulary: Readonly<Record<string, string>>,
): string[] {
  if (!Array.isArray(values)) throw new Error(`${field} must be a list`);
  const normalized = values.map((value) => {
    // Own-property lookup — see normalizeCompanyClaimInput. A truthiness check on a
    // plain object literal accepts inherited keys like `__proto__` and `constructor`
    // and returns a non-string, silently violating this function's own return type.
    if (typeof value !== 'string' || !Object.hasOwn(vocabulary, value)) {
      throw new Error(`${field} contains an unsupported value`);
    }
    return vocabulary[value];
  });
  return [...new Set(normalized)].sort();
}

export const normalizeMonitoredCompanyLifecycleFilters = (values: readonly string[]): string[] => (
  normalizeFilterValues(values, 'lifecycles', MONITORED_COMPANY_LIFECYCLE_BY_INPUT)
);
export const normalizeCoverageFilters = (values: readonly string[]): string[] => (
  normalizeFilterValues(values, 'coverageStates', COVERAGE_STATE_BY_INPUT)
);
export const normalizeImpactLifecycleFilters = (values: readonly string[]): string[] => (
  normalizeFilterValues(values, 'lifecycles', MATERIAL_IMPACT_LIFECYCLE_BY_INPUT)
);
export const normalizeImpactDirectionFilters = (values: readonly string[]): string[] => (
  normalizeFilterValues(values, 'directions', IMPACT_DIRECTION_BY_INPUT)
);

export interface CompanyMonitoringCoverageContract {
  coverage: 'awaiting_first_scan' | 'adequate' | 'partial' | 'stale' | 'unavailable' | 'needs_confirmation';
  observation: 'events_observed' | 'no_events_observed' | 'unknown';
  providers: Array<{
    provider: 'exa' | 'x';
    state: 'complete' | 'partial' | 'failed';
    capped: boolean;
    fresh: boolean;
  }>;
  assessmentReady: boolean;
}

export function assertCoverageObservation(contract: CompanyMonitoringCoverageContract): void {
  const coverageStates = new Set(['awaiting_first_scan', 'adequate', 'partial', 'stale', 'unavailable', 'needs_confirmation']);
  const observationStates = new Set(['events_observed', 'no_events_observed', 'unknown']);
  const providerNames = new Set(['exa', 'x']);
  const providerStates = new Set(['complete', 'partial', 'failed']);
  if (!contract || typeof contract !== 'object') throw new Error('coverage contract is required');
  if (!coverageStates.has(contract.coverage)) throw new Error('coverage state is invalid');
  if (!observationStates.has(contract.observation)) throw new Error('observation state is invalid');
  if (!Array.isArray(contract.providers) || contract.providers.length > 2) {
    throw new Error('provider coverage list is invalid');
  }
  if (typeof contract.assessmentReady !== 'boolean') throw new Error('assessmentReady must be boolean');
  for (const provider of contract.providers) {
    if (!provider || typeof provider !== 'object') throw new Error('provider coverage is invalid');
    if (!providerNames.has(provider.provider)) throw new Error('provider is invalid');
    if (!providerStates.has(provider.state)) throw new Error('provider state is invalid');
    if (typeof provider.capped !== 'boolean' || typeof provider.fresh !== 'boolean') {
      throw new Error('provider coverage flags must be boolean');
    }
  }
  if (new Set(contract.providers.map((provider) => provider.provider)).size !== contract.providers.length) {
    throw new Error('provider coverage contains duplicates');
  }
  const requiredProviders = new Set(contract.providers.map((provider) => provider.provider));
  const fullyCovered = requiredProviders.has('exa')
    && requiredProviders.has('x')
    && contract.providers.every((provider) => provider.state === 'complete' && !provider.capped && provider.fresh)
    && contract.assessmentReady;

  if (contract.coverage === 'adequate' && !fullyCovered) {
    throw new Error('adequate coverage requires complete, uncapped, fresh provider assessment');
  }
  if (contract.observation === 'no_events_observed' && (contract.coverage !== 'adequate' || !fullyCovered)) {
    throw new Error('no_events_observed requires adequate, complete, uncapped, fresh coverage');
  }
}

export interface CompanyMonitoringCursorClaims {
  version: number;
  ownerAccountId: string;
  filterHash: string;
  surface: 'ListMonitoredCompanies' | 'ListCompanyEventImpacts' | 'ListCompanyEventChanges';
  mode: 'snapshot' | 'poll';
  issuedAt: number;
  expiresAt: number;
  snapshotGeneration: number;
  snapshotAsOf: string;
  watermark: string;
  changedAt?: string;
  impactId?: string;
}

export interface CompanyMonitoringCursorExpectedBindings {
  ownerAccountId: string;
  filterHash: string;
  surface: CompanyMonitoringCursorClaims['surface'];
  mode: CompanyMonitoringCursorClaims['mode'];
  snapshotGeneration: number;
  nowMs: number;
}

function assertRfc3339(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !RFC3339.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be RFC3339 UTC`);
  }
}

export function validateCursorClaims<T extends CompanyMonitoringCursorClaims>(
  claims: T,
  expected: CompanyMonitoringCursorExpectedBindings,
): T {
  if (!claims || typeof claims !== 'object') throw new Error('cursor claims are required');
  if (claims.version !== COMPANY_MONITORING_CURSOR_VERSION) throw new Error('unsupported cursor version');
  if (claims.mode !== 'snapshot' && claims.mode !== 'poll') throw new Error('unsupported cursor mode');
  if (!['ListMonitoredCompanies', 'ListCompanyEventImpacts', 'ListCompanyEventChanges'].includes(claims.surface)) {
    throw new Error('unsupported cursor surface');
  }
  const ownerAccountId = assertCompanyMonitoringAccountContext({ ownerAccountId: claims.ownerAccountId });
  const expectedOwnerAccountId = assertCompanyMonitoringAccountContext({ ownerAccountId: expected?.ownerAccountId });
  if (!FILTER_HASH.test(claims.filterHash)) throw new Error('cursor filter hash is invalid');
  if (!FILTER_HASH.test(expected?.filterHash ?? '')) throw new Error('expected filter hash is invalid');
  if (!Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)) {
    throw new Error('cursor timestamps must be integer milliseconds');
  }
  if (!Number.isSafeInteger(expected?.nowMs)) throw new Error('cursor validation time is invalid');
  if (claims.expiresAt <= claims.issuedAt) throw new Error('cursor expiry must follow issue time');
  if (claims.expiresAt - claims.issuedAt > COMPANY_MONITORING_LIMITS.maxCursorTtlMs) {
    throw new Error('cursor lifetime exceeds the contract limit');
  }
  if (claims.expiresAt <= expected.nowMs) throw new Error('cursor has expired');
  if (claims.issuedAt > expected.nowMs + COMPANY_MONITORING_LIMITS.maxCursorClockSkewMs) {
    throw new Error('cursor issue time is in the future');
  }
  if (!Number.isSafeInteger(claims.snapshotGeneration) || claims.snapshotGeneration < 0) {
    throw new Error('cursor snapshot generation is invalid');
  }
  if (!Number.isSafeInteger(expected?.snapshotGeneration) || expected.snapshotGeneration < 0) {
    throw new Error('expected snapshot generation is invalid');
  }
  assertRfc3339(claims.snapshotAsOf, 'snapshotAsOf');
  assertRfc3339(claims.watermark, 'watermark');
  if ((claims.changedAt === undefined) !== (claims.impactId === undefined)) {
    throw new Error('cursor changedAt and impactId must be present together');
  }
  if (claims.changedAt !== undefined) assertRfc3339(claims.changedAt, 'changedAt');
  if (claims.impactId !== undefined) assertLogicalId('impact', claims.impactId);
  if (ownerAccountId !== expectedOwnerAccountId) throw new Error('cursor account binding does not match');
  if (claims.filterHash !== expected.filterHash) throw new Error('cursor filter binding does not match');
  if (claims.surface !== expected.surface) throw new Error('cursor surface binding does not match');
  if (claims.mode !== expected.mode) throw new Error('cursor mode binding does not match');
  if (claims.snapshotGeneration !== expected.snapshotGeneration) {
    throw new Error('cursor snapshot generation requires a new snapshot');
  }
  return claims;
}

export function assertOpaqueCursorShape(cursor: string): string {
  if (typeof cursor !== 'string' || !cursor.startsWith('cmc1.')) {
    throw new Error('unsupported cursor envelope');
  }
  if (utf8Bytes(cursor) > COMPANY_MONITORING_LIMITS.maxCursorBytes) {
    throw new Error(`cursor exceeds ${COMPANY_MONITORING_LIMITS.maxCursorBytes} bytes`);
  }
  if (!/^cmc1\.[A-Za-z0-9_-]{16,1536}\.[A-Za-z0-9_-]{43}$/.test(cursor)) {
    throw new Error('signed opaque cursor is malformed');
  }
  return cursor;
}

export interface VerifyOpaqueCursorOptions<T extends CompanyMonitoringCursorClaims> {
  expected: CompanyMonitoringCursorExpectedBindings;
  verifySignature: (signedPayload: string, signature: string) => boolean | Promise<boolean>;
  decodePayload: (encodedPayload: string) => T;
}

export async function verifyOpaqueCursor<T extends CompanyMonitoringCursorClaims>(
  cursor: string,
  options: VerifyOpaqueCursorOptions<T>,
): Promise<T> {
  assertOpaqueCursorShape(cursor);
  const [version, encodedPayload, signature] = cursor.split('.');
  if (!(await options.verifySignature(`${version}.${encodedPayload}`, signature))) {
    throw new Error('cursor signature is invalid');
  }
  let claims: T;
  try {
    claims = options.decodePayload(encodedPayload);
  } catch {
    throw new Error('cursor payload is invalid');
  }
  return validateCursorClaims(claims, options.expected);
}
