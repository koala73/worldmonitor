import {
  DECISION_SIGNAL_PROVENANCE_CLAIM_STATUSES,
  DECISION_SIGNAL_PROVENANCE_CONTRACT_VERSION,
  DECISION_SIGNAL_PROVENANCE_DIMENSIONS,
  DECISION_SIGNAL_PROVENANCE_SURFACES,
  DECISION_SIGNAL_PUBLISHER_TYPES,
  type DecisionSignalConfidence,
  type DecisionSignalContentFreshness,
  type DecisionSignalCorroboration,
  type DecisionSignalDerivation,
  type DecisionSignalOriginalReference,
  type DecisionSignalProvenance,
  type DecisionSignalProvenanceDimension,
  type DecisionSignalProvenanceFamilyDeclaration,
  type DecisionSignalProvenanceSurface,
  type DecisionSignalPublisherReference,
  type DecisionSignalRevision,
  type DecisionSignalSupersession,
  type DecisionSignalTimeReference,
  type DecisionSignalTranslation,
  type DecisionSignalTransportFreshness,
} from './decision-signal-provenance-contract';
import {
  DECISION_SIGNAL_PROVENANCE_FAMILY_DECLARATIONS,
} from './decision-signal-provenance-families';
import { getSourceProvenanceState } from './source-provenance';

export * from './decision-signal-provenance-contract';
export {
  DECISION_SIGNAL_PROVENANCE_FAMILY_DECLARATIONS,
  DECISION_SIGNAL_PROVENANCE_FAMILY_REGISTRATIONS,
} from './decision-signal-provenance-families';

export interface DecisionSignalProvenanceValidationIssue {
  path: string;
  code: string;
  message: string;
}

export type DecisionSignalProvenanceValidationResult =
  | { ok: true; value: DecisionSignalProvenance }
  | { ok: false; errors: DecisionSignalProvenanceValidationIssue[] };

type RecordValue = Record<string, unknown>;

const TOP_LEVEL_KEYS = ['contractVersion', 'signalId', 'familyId', 'claims'] as const;
const CLAIM_KNOWN_KEYS = ['status', 'value'] as const;
const CLAIM_UNAVAILABLE_KEYS = ['status', 'reason'] as const;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function pushIssue(
  errors: DecisionSignalProvenanceValidationIssue[],
  path: string,
  code: string,
  message: string,
): void {
  errors.push({ path, code, message });
}

function validateExactKeys(
  value: RecordValue,
  allowed: readonly string[],
  path: string,
  errors: DecisionSignalProvenanceValidationIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      pushIssue(errors, `${path}.${key}`, 'INVALID_SHAPE', `Unexpected field ${key}`);
    }
  }
}

function validateRequiredString(
  value: unknown,
  path: string,
  errors: DecisionSignalProvenanceValidationIssue[],
): value is string {
  if (!isNonEmptyString(value)) {
    pushIssue(errors, path, 'INVALID_VALUE', 'Expected a non-empty string');
    return false;
  }
  return true;
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/,
  );
  if (!match) return false;
  return isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))
    && Number(match[4]) <= 23
    && Number(match[5]) <= 59
    && Number(match[6]) <= 59;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= (daysInMonth[month - 1] ?? 0);
}

function isCalendarMonth(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4})-(\d{2})$/);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

function isCalendarDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  return isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

function isProvenanceTimestamp(value: unknown): value is string {
  return isIsoInstant(value)
    || isCalendarDay(value)
    || isCalendarMonth(value)
    || (typeof value === 'string' && /^\d{4}$/.test(value));
}

function validateTimestampValue(
  value: unknown,
  precision: unknown,
  path: string,
  errors: DecisionSignalProvenanceValidationIssue[],
): void {
  let valid = false;
  if (precision === 'instant') valid = isIsoInstant(value);
  if (precision === 'day') valid = isCalendarDay(value);
  if (precision === 'month') valid = isCalendarMonth(value);
  if (precision === 'year') valid = typeof value === 'string' && /^\d{4}$/.test(value);
  if (!valid) {
    pushIssue(errors, path, 'INVALID_VALUE', `Invalid ${String(precision)} timestamp`);
  }
}

function validatePublisher(
  value: unknown,
  path: string,
  errors: DecisionSignalProvenanceValidationIssue[],
): value is DecisionSignalPublisherReference {
  if (!isRecord(value)) {
    pushIssue(errors, path, 'INVALID_VALUE', 'Publisher must be an object');
    return false;
  }
  validateExactKeys(value, ['id', 'name', 'type', 'registryReference'], path, errors);
  validateRequiredString(value.id, `${path}.id`, errors);
  validateRequiredString(value.name, `${path}.name`, errors);
  if (!DECISION_SIGNAL_PUBLISHER_TYPES.includes(value.type as never)) {
    pushIssue(errors, `${path}.type`, 'INVALID_STATUS_VOCABULARY', 'Unknown publisher type');
  }

  if (value.type === 'derived_output') {
    if (value.registryReference !== null) {
      pushIssue(
        errors,
        `${path}.registryReference`,
        'INVALID_SOURCE_REFERENCE',
        'Derived outputs must not masquerade as a source-registry publisher',
      );
    }
    return true;
  }

  if (!isRecord(value.registryReference)) {
    pushIssue(
      errors,
      `${path}.registryReference`,
      'UNKNOWN_SOURCE_REFERENCE',
      'Source-backed publishers require a #5571 registry reference',
    );
    return false;
  }

  const registryReference = value.registryReference;
  validateExactKeys(
    registryReference,
    ['sourceName', 'sourceType', 'propagandaRisk'],
    `${path}.registryReference`,
    errors,
  );
  if (!validateRequiredString(
    registryReference.sourceName,
    `${path}.registryReference.sourceName`,
    errors,
  )) {
    return false;
  }

  const registryState = getSourceProvenanceState(registryReference.sourceName);
  if (!registryState.typeDeclared || !registryState.riskDeclared) {
    pushIssue(
      errors,
      `${path}.registryReference.sourceName`,
      'UNKNOWN_SOURCE_REFERENCE',
      `${registryReference.sourceName} is not explicitly declared in the #5571 source registry`,
    );
    return false;
  }
  if (
    registryReference.sourceType !== registryState.type
    || registryReference.propagandaRisk !== registryState.risk
  ) {
    pushIssue(
      errors,
      `${path}.registryReference`,
      'STALE_SOURCE_REFERENCE',
      'Publisher registry snapshot no longer matches the canonical #5571 source registry',
    );
  }
  if (value.type === 'official_government' && registryState.type !== 'gov') {
    pushIssue(
      errors,
      `${path}.type`,
      'PUBLISHER_CLASS_MISMATCH',
      'Official-government publishers must resolve to a government registry type',
    );
  }
  if (
    value.type === 'state_controlled_media'
    && (!registryState.stateAffiliated || registryState.type === 'gov')
  ) {
    pushIssue(
      errors,
      `${path}.type`,
      'PUBLISHER_CLASS_MISMATCH',
      'State-controlled media must remain distinct from direct government publishers',
    );
  }
  if (
    (value.type === 'independent_media' || value.type === 'independent_observation')
    && (
      registryState.risk !== 'low'
      || registryState.type === 'gov'
      || registryState.type === 'wire'
      || registryState.type === 'market'
    )
  ) {
    pushIssue(
      errors,
      `${path}.type`,
      'PUBLISHER_CLASS_MISMATCH',
      'Independent publisher claims require a low-risk non-government, non-wire, non-market registry entry',
    );
  }
  if (
    registryState.risk === 'high'
    && registryState.stateAffiliated
    && registryState.type !== 'gov'
    && value.type !== 'state_controlled_media'
    && value.type !== 'unknown'
  ) {
    pushIssue(
      errors,
      `${path}.type`,
      'PUBLISHER_CLASS_MISMATCH',
      'State-controlled media cannot be relabeled as a wire or independent publisher',
    );
  }
  if (
    value.type === 'wire_service'
    && (registryState.type !== 'wire' || registryState.risk === 'high')
  ) {
    pushIssue(
      errors,
      `${path}.type`,
      'PUBLISHER_CLASS_MISMATCH',
      'Wire-service claims require a non-state-controlled wire registry entry',
    );
  }
  if (value.type === 'market_publisher' && registryState.type !== 'market') {
    pushIssue(
      errors,
      `${path}.type`,
      'PUBLISHER_CLASS_MISMATCH',
      'Market-publisher claims require a market registry entry',
    );
  }
  if (
    value.type === 'official_exchange'
    && registryState.type !== 'market'
    && registryState.type !== 'gov'
  ) {
    pushIssue(
      errors,
      `${path}.type`,
      'PUBLISHER_CLASS_MISMATCH',
      'Official-exchange claims require a market or government registry entry',
    );
  }
  return true;
}

function validateSourceUrl(
  value: unknown,
  path: string,
  errors: DecisionSignalProvenanceValidationIssue[],
): value is string {
  if (!validateRequiredString(value, path, errors)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('unsafe URL');
  } catch {
    pushIssue(errors, path, 'INVALID_VALUE', 'Source URL must be an absolute credential-free HTTPS URL');
    return false;
  }
  return true;
}

function validateOriginalReference(
  value: unknown,
  path: string,
  errors: DecisionSignalProvenanceValidationIssue[],
): value is DecisionSignalOriginalReference {
  if (!isRecord(value)) {
    pushIssue(errors, path, 'INVALID_VALUE', 'Original reference must be an object');
    return false;
  }
  validateExactKeys(value, ['kind', 'id', 'contentHash'], path, errors);
  if (!['document', 'text', 'observation', 'event', 'dataset'].includes(String(value.kind))) {
    pushIssue(errors, `${path}.kind`, 'INVALID_STATUS_VOCABULARY', 'Unknown original-reference kind');
  }
  validateRequiredString(value.id, `${path}.id`, errors);
  if (value.contentHash !== undefined && (
    typeof value.contentHash !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(value.contentHash)
  )) {
    pushIssue(errors, `${path}.contentHash`, 'INVALID_VALUE', 'Expected a lowercase sha256 content hash');
  }
  return true;
}

function validateTranslation(
  value: unknown,
  path: string,
  errors: DecisionSignalProvenanceValidationIssue[],
): value is DecisionSignalTranslation {
  if (!isRecord(value)) {
    pushIssue(errors, path, 'INVALID_VALUE', 'Translation must be an object');
    return false;
  }
  validateExactKeys(value, ['state', 'targetLanguage'], path, errors);
  const states = ['unavailable', 'not_translated', 'machine_assisted', 'human_reviewed'];
  if (!states.includes(String(value.state))) {
    pushIssue(errors, `${path}.state`, 'INVALID_STATUS_VOCABULARY', 'Unknown translation state');
  }
  if (value.state === 'machine_assisted' || value.state === 'human_reviewed') {
    validateRequiredString(value.targetLanguage, `${path}.targetLanguage`, errors);
  } else if (value.targetLanguage !== undefined) {
    pushIssue(
      errors,
      `${path}.targetLanguage`,
      'INVALID_VALUE',
      'Unavailable or untranslated evidence cannot claim a target language',
    );
  }
  return true;
}

const TIME_ROLES: Readonly<
  Record<
    Extract<
      DecisionSignalProvenanceDimension,
      'observation_time' | 'effective_time' | 'publication_time' | 'retrieval_time'
    >,
    DecisionSignalTimeReference['role']
  >
> = {
  observation_time: 'observation',
  effective_time: 'effective',
  publication_time: 'publication',
  retrieval_time: 'retrieval',
};

function validateTimeReference(
  dimension: keyof typeof TIME_ROLES,
  value: unknown,
  path: string,
  errors: DecisionSignalProvenanceValidationIssue[],
): value is DecisionSignalTimeReference {
  if (!isRecord(value)) {
    pushIssue(errors, path, 'INVALID_VALUE', 'Time reference must be an object');
    return false;
  }
  validateExactKeys(value, ['role', 'value', 'precision'], path, errors);
  if (value.role !== TIME_ROLES[dimension]) {
    pushIssue(
      errors,
      `${path}.role`,
      'TIMESTAMP_ROLE_MISMATCH',
      `${dimension} must retain its ${TIME_ROLES[dimension]} semantic role`,
    );
  }
  if (!['instant', 'day', 'month', 'year'].includes(String(value.precision))) {
    pushIssue(errors, `${path}.precision`, 'INVALID_STATUS_VOCABULARY', 'Unknown timestamp precision');
  } else {
    validateTimestampValue(value.value, value.precision, `${path}.value`, errors);
  }
  return true;
}

function validateRevision(
  value: unknown,
  path: string,
  errors: DecisionSignalProvenanceValidationIssue[],
): value is DecisionSignalRevision {
  if (!isRecord(value)) {
    pushIssue(errors, path, 'INVALID_VALUE', 'Revision must be an object');
    return false;
  }
  validateExactKeys(value, ['vintageId', 'sequence', 'state'], path, errors);
  validateRequiredString(value.vintageId, `${path}.vintageId`, errors);
  if (!Number.isInteger(value.sequence) || Number(value.sequence) < 1) {
    pushIssue(errors, `${path}.sequence`, 'INVALID_VALUE', 'Revision sequence must be a positive integer');
  }
  if (!['preliminary', 'original', 'revised', 'corrected'].includes(String(value.state))) {
    pushIssue(errors, `${path}.state`, 'INVALID_STATUS_VOCABULARY', 'Unknown revision state');
  }
  if ((value.state === 'preliminary' || value.state === 'original') && value.sequence !== 1) {
    pushIssue(errors, `${path}.sequence`, 'INVALID_LINEAGE', 'Preliminary and original vintages must use sequence 1');
  }
  if ((value.state === 'revised' || value.state === 'corrected') && Number(value.sequence) < 2) {
    pushIssue(errors, `${path}.sequence`, 'INVALID_LINEAGE', 'Revised vintages must advance the sequence');
  }
  return true;
}

function validateSupersession(
  value: unknown,
  path: string,
  errors: DecisionSignalProvenanceValidationIssue[],
): value is DecisionSignalSupersession {
  if (!isRecord(value)) {
    pushIssue(errors, path, 'INVALID_VALUE', 'Supersession must be an object');
    return false;
  }
  validateExactKeys(value, ['state', 'relatedSignalId', 'reason'], path, errors);
  if (!['current', 'corrected', 'cancelled', 'superseded'].includes(String(value.state))) {
    pushIssue(errors, `${path}.state`, 'INVALID_STATUS_VOCABULARY', 'Unknown supersession state');
  }
  if (value.state === 'corrected' || value.state === 'superseded') {
    validateRequiredString(value.relatedSignalId, `${path}.relatedSignalId`, errors);
  }
  if (value.state === 'cancelled') {
    validateRequiredString(value.reason, `${path}.reason`, errors);
  }
  if (
    value.state === 'current'
    && (value.relatedSignalId !== undefined || value.reason !== undefined)
  ) {
    pushIssue(
      errors,
      path,
      'INVALID_LINEAGE',
      'Current signals cannot carry correction, cancellation, or supersession metadata',
    );
  }
  return true;
}

function validateConfidence(
  value: unknown,
  path: string,
  errors: DecisionSignalProvenanceValidationIssue[],
): value is DecisionSignalConfidence {
  if (!isRecord(value)) {
    pushIssue(errors, path, 'INVALID_VALUE', 'Confidence must be an object');
    return false;
  }
  validateExactKeys(value, ['score', 'method'], path, errors);
  if (
    typeof value.score !== 'number'
    || !Number.isFinite(value.score)
    || value.score < 0
    || value.score > 1
  ) {
    pushIssue(errors, `${path}.score`, 'INVALID_VALUE', 'Confidence score must be finite and between 0 and 1');
  }
  validateRequiredString(value.method, `${path}.method`, errors);
  return true;
}

function validateSignalIds(
  value: unknown,
  path: string,
  errors: DecisionSignalProvenanceValidationIssue[],
): value is string[] {
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
    pushIssue(errors, path, 'INVALID_VALUE', 'Expected an array of non-empty signal IDs');
    return false;
  }
  if (new Set(value).size !== value.length) {
    pushIssue(errors, path, 'INVALID_VALUE', 'Signal IDs must be unique');
    return false;
  }
  return true;
}

function validateCorroboration(
  value: unknown,
  path: string,
  errors: DecisionSignalProvenanceValidationIssue[],
): value is DecisionSignalCorroboration {
  if (!isRecord(value)) {
    pushIssue(errors, path, 'INVALID_VALUE', 'Corroboration must be an object');
    return false;
  }
  validateExactKeys(value, ['state', 'sourceSignalIds'], path, errors);
  const states = ['single_source', 'multi_source', 'independently_corroborated', 'contradicted'];
  if (!states.includes(String(value.state))) {
    pushIssue(errors, `${path}.state`, 'INVALID_STATUS_VOCABULARY', 'Unknown corroboration state');
  }
  if (validateSignalIds(value.sourceSignalIds, `${path}.sourceSignalIds`, errors)) {
    const count = value.sourceSignalIds.length;
    if (value.state === 'single_source' && count !== 1) {
      pushIssue(errors, `${path}.sourceSignalIds`, 'INVALID_VALUE', 'single_source requires exactly one source');
    }
    if (
      (value.state === 'multi_source'
        || value.state === 'independently_corroborated'
        || value.state === 'contradicted')
      && count < 2
    ) {
      pushIssue(errors, `${path}.sourceSignalIds`, 'INVALID_VALUE', `${String(value.state)} requires two sources`);
    }
  }
  return true;
}

function validateTransportFreshness(
  value: unknown,
  path: string,
  errors: DecisionSignalProvenanceValidationIssue[],
): value is DecisionSignalTransportFreshness {
  if (!isRecord(value)) {
    pushIssue(errors, path, 'INVALID_VALUE', 'Transport freshness must be an object');
    return false;
  }
  validateExactKeys(value, ['state', 'assessedAt', 'lastSuccessAt'], path, errors);
  if (!['fresh', 'stale', 'missing', 'error'].includes(String(value.state))) {
    pushIssue(errors, `${path}.state`, 'INVALID_STATUS_VOCABULARY', 'Unknown transport-freshness state');
  }
  if (!isIsoInstant(value.assessedAt)) {
    pushIssue(errors, `${path}.assessedAt`, 'INVALID_VALUE', 'assessedAt must be an ISO instant');
  }
  if (value.lastSuccessAt !== undefined && !isIsoInstant(value.lastSuccessAt)) {
    pushIssue(errors, `${path}.lastSuccessAt`, 'INVALID_VALUE', 'lastSuccessAt must be an ISO instant');
  }
  return true;
}

function validateContentFreshness(
  value: unknown,
  path: string,
  errors: DecisionSignalProvenanceValidationIssue[],
): value is DecisionSignalContentFreshness {
  if (!isRecord(value)) {
    pushIssue(errors, path, 'INVALID_VALUE', 'Content freshness must be an object');
    return false;
  }
  validateExactKeys(value, ['state', 'assessedAt', 'contentAsOf'], path, errors);
  const states = ['current', 'stale', 'unavailable', 'partial', 'timestamp_unknown'];
  if (!states.includes(String(value.state))) {
    pushIssue(errors, `${path}.state`, 'INVALID_STATUS_VOCABULARY', 'Unknown content-freshness state');
  }
  if (!isIsoInstant(value.assessedAt)) {
    pushIssue(errors, `${path}.assessedAt`, 'INVALID_VALUE', 'assessedAt must be an ISO instant');
  }
  if (value.contentAsOf !== undefined && !isProvenanceTimestamp(value.contentAsOf)) {
    pushIssue(
      errors,
      `${path}.contentAsOf`,
      'INVALID_VALUE',
      'contentAsOf must be a valid instant, day, month, or year',
    );
  }
  if ((value.state === 'current' || value.state === 'stale') && !isNonEmptyString(value.contentAsOf)) {
    pushIssue(errors, `${path}.contentAsOf`, 'INVALID_VALUE', `${String(value.state)} content requires contentAsOf`);
  }
  if (value.state === 'timestamp_unknown' && value.contentAsOf !== undefined) {
    pushIssue(
      errors,
      `${path}.contentAsOf`,
      'INVALID_VALUE',
      'timestamp_unknown content cannot carry a known content timestamp',
    );
  }
  return true;
}

function validateDerivation(
  value: unknown,
  path: string,
  errors: DecisionSignalProvenanceValidationIssue[],
): value is DecisionSignalDerivation {
  if (!isRecord(value)) {
    pushIssue(errors, path, 'INVALID_VALUE', 'Derivation must be an object');
    return false;
  }
  validateExactKeys(value, ['methodId', 'methodVersion', 'computedAt', 'inputSignalIds'], path, errors);
  validateRequiredString(value.methodId, `${path}.methodId`, errors);
  validateRequiredString(value.methodVersion, `${path}.methodVersion`, errors);
  if (!isIsoInstant(value.computedAt)) {
    pushIssue(errors, `${path}.computedAt`, 'INVALID_VALUE', 'computedAt must be an ISO instant');
  }
  if (validateSignalIds(value.inputSignalIds, `${path}.inputSignalIds`, errors) && value.inputSignalIds.length === 0) {
    pushIssue(errors, `${path}.inputSignalIds`, 'INVALID_VALUE', 'Derived outputs require at least one input signal');
  }
  return true;
}

function validateKnownClaimValue(
  dimension: DecisionSignalProvenanceDimension,
  value: unknown,
  path: string,
  errors: DecisionSignalProvenanceValidationIssue[],
): void {
  if (dimension === 'publisher') validatePublisher(value, path, errors);
  if (dimension === 'source_url') validateSourceUrl(value, path, errors);
  if (dimension === 'original_reference') validateOriginalReference(value, path, errors);
  if (dimension === 'original_language') validateRequiredString(value, path, errors);
  if (dimension === 'translation') validateTranslation(value, path, errors);
  if (dimension in TIME_ROLES) {
    validateTimeReference(dimension as keyof typeof TIME_ROLES, value, path, errors);
  }
  if (dimension === 'revision') validateRevision(value, path, errors);
  if (dimension === 'supersession') validateSupersession(value, path, errors);
  if (dimension === 'extraction_confidence' || dimension === 'classification_confidence') {
    validateConfidence(value, path, errors);
  }
  if (dimension === 'corroboration') validateCorroboration(value, path, errors);
  if (dimension === 'transport_freshness') validateTransportFreshness(value, path, errors);
  if (dimension === 'content_freshness') validateContentFreshness(value, path, errors);
  if (dimension === 'derivation') validateDerivation(value, path, errors);
}

function validateClaim(
  dimension: DecisionSignalProvenanceDimension,
  claim: unknown,
  declaration: DecisionSignalProvenanceFamilyDeclaration,
  errors: DecisionSignalProvenanceValidationIssue[],
): void {
  const path = `claims.${dimension}`;
  if (!isRecord(claim)) {
    pushIssue(errors, path, 'INVALID_CLAIM', 'Claim must be an object');
    return;
  }
  if (!DECISION_SIGNAL_PROVENANCE_CLAIM_STATUSES.includes(claim.status as never)) {
    pushIssue(errors, `${path}.status`, 'INVALID_STATUS_VOCABULARY', 'Unknown claim status');
    return;
  }
  const policy = declaration.dimensions[dimension];
  if (
    (policy === 'required' && claim.status !== 'known')
    || (policy === 'not_applicable' && claim.status !== 'not_applicable')
    || (policy === 'unknown_allowed' && claim.status === 'not_applicable')
  ) {
    pushIssue(
      errors,
      `${path}.status`,
      'CLAIM_STATUS_VIOLATES_DECLARATION',
      `${claim.status as string} is not allowed by ${policy}`,
    );
    return;
  }

  if (claim.status === 'known') {
    validateExactKeys(claim, CLAIM_KNOWN_KEYS, path, errors);
    if (!Object.prototype.hasOwnProperty.call(claim, 'value')) {
      pushIssue(errors, `${path}.value`, 'MISSING_CLAIM_VALUE', 'Known claims require a value');
      return;
    }
    validateKnownClaimValue(dimension, claim.value, `${path}.value`, errors);
    return;
  }

  validateExactKeys(claim, CLAIM_UNAVAILABLE_KEYS, path, errors);
  validateRequiredString(claim.reason, `${path}.reason`, errors);
  if (Object.prototype.hasOwnProperty.call(claim, 'value')) {
    pushIssue(
      errors,
      `${path}.value`,
      'INVALID_CLAIM',
      'Unknown or not-applicable claims cannot carry an inferred value',
    );
  }
}

export function validateDecisionSignalProvenance(
  input: unknown,
): DecisionSignalProvenanceValidationResult {
  const errors: DecisionSignalProvenanceValidationIssue[] = [];
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [{ path: '$', code: 'INVALID_SHAPE', message: 'Provenance must be an object' }],
    };
  }
  validateExactKeys(input, TOP_LEVEL_KEYS, '$', errors);
  if (input.contractVersion !== DECISION_SIGNAL_PROVENANCE_CONTRACT_VERSION) {
    pushIssue(
      errors,
      'contractVersion',
      'UNSUPPORTED_CONTRACT_VERSION',
      `Expected ${DECISION_SIGNAL_PROVENANCE_CONTRACT_VERSION}`,
    );
  }
  validateRequiredString(input.signalId, 'signalId', errors);
  const familyId = validateRequiredString(input.familyId, 'familyId', errors)
    ? input.familyId
    : null;
  const declaration = familyId
    ? DECISION_SIGNAL_PROVENANCE_FAMILY_DECLARATIONS[familyId]
    : undefined;
  if (!declaration) {
    pushIssue(errors, 'familyId', 'UNKNOWN_FAMILY', 'Signal family has no provenance declaration');
  }
  if (!isRecord(input.claims)) {
    pushIssue(errors, 'claims', 'INVALID_SHAPE', 'Claims must be an object');
  } else if (declaration) {
    validateExactKeys(input.claims, DECISION_SIGNAL_PROVENANCE_DIMENSIONS, 'claims', errors);
    for (const dimension of DECISION_SIGNAL_PROVENANCE_DIMENSIONS) {
      if (!Object.prototype.hasOwnProperty.call(input.claims, dimension)) {
        pushIssue(
          errors,
          `claims.${dimension}`,
          'MISSING_CLAIM',
          'Every provenance dimension must be declared explicitly',
        );
        continue;
      }
      validateClaim(dimension, input.claims[dimension], declaration, errors);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as DecisionSignalProvenance };
}

export class DecisionSignalProvenanceValidationError extends Error {
  readonly errors: DecisionSignalProvenanceValidationIssue[];

  constructor(errors: DecisionSignalProvenanceValidationIssue[]) {
    super(errors.map((error) => `${error.path}: ${error.message}`).join('; '));
    this.name = 'DecisionSignalProvenanceValidationError';
    this.errors = errors;
  }
}

function requireValidDecisionSignalProvenance(input: unknown): DecisionSignalProvenance {
  const result = validateDecisionSignalProvenance(input);
  if (!result.ok) throw new DecisionSignalProvenanceValidationError(result.errors);
  return result.value;
}

export function serializeDecisionSignalProvenance(input: unknown): string {
  return JSON.stringify(requireValidDecisionSignalProvenance(input));
}

export function parseDecisionSignalProvenance(serialized: string): DecisionSignalProvenance {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new DecisionSignalProvenanceValidationError([
      { path: '$', code: 'INVALID_JSON', message: 'Serialized provenance is not valid JSON' },
    ]);
  }
  return requireValidDecisionSignalProvenance(parsed);
}

function serializeSurface(input: unknown): DecisionSignalProvenance {
  return JSON.parse(serializeDecisionSignalProvenance(input)) as DecisionSignalProvenance;
}

function deserializeSurface(input: unknown): DecisionSignalProvenance {
  return requireValidDecisionSignalProvenance(input);
}

export interface DecisionSignalProvenanceSurfaceAdapter {
  serialize(input: unknown): DecisionSignalProvenance;
  deserialize(input: unknown): DecisionSignalProvenance;
}

function surfaceAdapter(): Readonly<DecisionSignalProvenanceSurfaceAdapter> {
  return Object.freeze({
    serialize: serializeSurface,
    deserialize: deserializeSurface,
  });
}

const CANONICAL_SURFACE_ADAPTER = surfaceAdapter();

export const DECISION_SIGNAL_PROVENANCE_SURFACE_ADAPTERS: Readonly<
  Record<DecisionSignalProvenanceSurface, Readonly<DecisionSignalProvenanceSurfaceAdapter>>
> = Object.freeze({
  cache_storage: CANONICAL_SURFACE_ADAPTER,
  api: CANONICAL_SURFACE_ADAPTER,
  mcp: CANONICAL_SURFACE_ADAPTER,
  ui: CANONICAL_SURFACE_ADAPTER,
});

if (
  Object.keys(DECISION_SIGNAL_PROVENANCE_SURFACE_ADAPTERS).length
  !== DECISION_SIGNAL_PROVENANCE_SURFACES.length
) {
  throw new Error('Decision-signal provenance surface adapter registry is incomplete');
}
