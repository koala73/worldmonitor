import type { DecisionSignalProvenance } from '../../shared/decision-signal-provenance-contract';
import { validateDecisionSignalProvenance } from '../../shared/decision-signal-provenance';
import { ensureHydrated } from '@/services/bootstrap';
import { toApiUrl } from '@/services/runtime';
import { createCircuitBreaker } from '@/utils/circuit-breaker';

export const CHINA_POLICY_EVENTS_BOOTSTRAP_KEY = 'chinaPolicyEvents';
export const CHINA_POLICY_EVENTS_CACHE_KEY = 'china-policy-events-v1';
export const CHINA_POLICY_TRANSPORT_STALE_MS = 36 * 60 * 60 * 1000;
export const CHINA_POLICY_LAST_GOOD_CEILING_MS = 7 * 24 * 60 * 60 * 1000;
const GENERATED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;

export type ChinaPolicyAgency = 'CAC' | 'SAMR' | 'MIIT' | 'MOFCOM' | 'NDRC' | 'PBOC';
export type ChinaPolicyActionType =
  | 'consultation_draft'
  | 'announcement_guidance'
  | 'final_rule'
  | 'administrative_approval_restriction'
  | 'investigation'
  | 'enforcement_penalty'
  | 'effective_date_change'
  | 'amendment_correction_repeal_supersession'
  | 'unknown';
export type ChinaPolicyStatus =
  | 'draft'
  | 'announced'
  | 'in_force'
  | 'under_investigation'
  | 'enforced'
  | 'amended'
  | 'corrected'
  | 'repealed'
  | 'superseded'
  | 'unknown';

export interface ChinaPolicyReviewedLink {
  id: string;
  name?: string;
  label?: string;
  reviewState: 'reviewed';
}

export interface ChinaPolicyEvent {
  id: string;
  lineageId: string;
  agency: ChinaPolicyAgency;
  actionType: ChinaPolicyActionType;
  status: ChinaPolicyStatus;
  titleOriginal: string;
  titleTranslated: string | null;
  originalText: string;
  originalLanguage: 'zh-CN';
  translation: {
    state: 'unavailable' | 'not_translated' | 'machine_assisted' | 'human_reviewed';
    targetLanguage?: string;
    failureReason?: string;
  };
  canonicalUrl: string;
  mirrorUrls: string[];
  documentNumber: string | null;
  publicationDate: string;
  retrievedAt: string;
  effectiveDate: string | null;
  sectors: ChinaPolicyReviewedLink[];
  entities: ChinaPolicyReviewedLink[];
  classification: {
    confidence: number;
    method: string;
    matchedTerms: string[];
    uncertain: boolean;
  };
  contentHash: string;
  revision: {
    state: 'original' | 'revised' | 'corrected';
    sequence: number;
    previousEventId: string | null;
  };
  supersession: {
    state: 'current' | 'corrected' | 'cancelled' | 'superseded';
    relatedEventId: string | null;
    reason: string | null;
  };
  provenance: DecisionSignalProvenance;
}

export interface ChinaPolicyAgencyHealth {
  status: 'ok' | 'partial' | 'error';
  retrievedAt: string;
  documentCount: number;
  failures: Array<{ canonicalUrl: string; reason: string }>;
  requestCount: number;
}

export interface ChinaPolicyPayload {
  schemaVersion: 1;
  generatedAt: string;
  agencies: Record<ChinaPolicyAgency, ChinaPolicyAgencyHealth>;
  events: ChinaPolicyEvent[];
}

export type ChinaPolicyDataState = 'live' | 'cached' | 'unavailable';

export interface ChinaPolicyFetchResult {
  data: ChinaPolicyPayload | null;
  state: ChinaPolicyDataState;
  cachedAt: number | null;
}

interface ChinaPolicySnapshot {
  data: ChinaPolicyPayload;
  cachedAt: number;
}

export interface ChinaPolicyServiceOptions {
  getHydrated?: () => Promise<unknown | undefined>;
  fetchImpl?: typeof globalThis.fetch;
  persistCache?: boolean;
  breakerName?: string;
  cacheKey?: string;
  now?: () => number;
}

const AGENCIES: ChinaPolicyAgency[] = ['CAC', 'SAMR', 'MIIT', 'MOFCOM', 'NDRC', 'PBOC'];
const ACTION_TYPES: ChinaPolicyActionType[] = [
  'consultation_draft',
  'announcement_guidance',
  'final_rule',
  'administrative_approval_restriction',
  'investigation',
  'enforcement_penalty',
  'effective_date_change',
  'amendment_correction_repeal_supersession',
  'unknown',
];
const STATUSES: ChinaPolicyStatus[] = [
  'draft',
  'announced',
  'in_force',
  'under_investigation',
  'enforced',
  'amended',
  'corrected',
  'repealed',
  'superseded',
  'unknown',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month! - 1
    && date.getUTCDate() === day;
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isOfficialUrl(value: unknown, agency: ChinaPolicyAgency): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    const parsed = new URL(value);
    const hosts: Record<ChinaPolicyAgency, string> = {
      CAC: 'www.cac.gov.cn',
      SAMR: 'www.samr.gov.cn',
      MIIT: 'www.miit.gov.cn',
      MOFCOM: 'www.mofcom.gov.cn',
      NDRC: 'zfxxgk.ndrc.gov.cn',
      PBOC: 'www.pbc.gov.cn',
    };
    return parsed.protocol === 'https:'
      && parsed.hostname === hosts[agency]
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isReviewedLinks(value: unknown): value is ChinaPolicyReviewedLink[] {
  return Array.isArray(value) && value.every((link) => (
    isRecord(link)
    && isNonEmptyString(link.id)
    && link.reviewState === 'reviewed'
    && (link.name === undefined || isNonEmptyString(link.name))
    && (link.label === undefined || isNonEmptyString(link.label))
  ));
}

function isPolicyEvent(value: unknown): value is ChinaPolicyEvent {
  if (!isRecord(value) || !AGENCIES.includes(value.agency as ChinaPolicyAgency)) return false;
  const agency = value.agency as ChinaPolicyAgency;
  if (
    !isNonEmptyString(value.id)
    || !isNonEmptyString(value.lineageId)
    || !ACTION_TYPES.includes(value.actionType as ChinaPolicyActionType)
    || !STATUSES.includes(value.status as ChinaPolicyStatus)
    || !isNonEmptyString(value.titleOriginal)
    || (value.titleTranslated !== null && !isNonEmptyString(value.titleTranslated))
    || !isNonEmptyString(value.originalText)
    || value.originalLanguage !== 'zh-CN'
    || !isOfficialUrl(value.canonicalUrl, agency)
    || !Array.isArray(value.mirrorUrls)
    || !value.mirrorUrls.every((url) => isOfficialUrl(url, agency))
    || (value.documentNumber !== null && !isNonEmptyString(value.documentNumber))
    || !isDay(value.publicationDate)
    || !isInstant(value.retrievedAt)
    || (value.effectiveDate !== null && !isDay(value.effectiveDate))
    || !isReviewedLinks(value.sectors)
    || !isReviewedLinks(value.entities)
    || !isRecord(value.translation)
    || !['unavailable', 'not_translated', 'machine_assisted', 'human_reviewed'].includes(
      String(value.translation.state),
    )
    || (value.translation.targetLanguage !== undefined
      && !isNonEmptyString(value.translation.targetLanguage))
    || (value.translation.failureReason !== undefined
      && !isNonEmptyString(value.translation.failureReason))
    || (value.translation.state === 'unavailable'
      && !isNonEmptyString(value.translation.failureReason))
    || !isRecord(value.classification)
    || !Number.isFinite(value.classification.confidence)
    || Number(value.classification.confidence) < 0
    || Number(value.classification.confidence) > 1
    || !isNonEmptyString(value.classification.method)
    || !isStringArray(value.classification.matchedTerms)
    || typeof value.classification.uncertain !== 'boolean'
    || typeof value.contentHash !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(value.contentHash)
    || !isRecord(value.revision)
    || !['original', 'revised', 'corrected'].includes(String(value.revision.state))
    || !Number.isInteger(value.revision.sequence)
    || Number(value.revision.sequence) < 1
    || (value.revision.previousEventId !== null
      && !isNonEmptyString(value.revision.previousEventId))
    || (value.revision.sequence === 1
      ? value.revision.previousEventId !== null
      : !isNonEmptyString(value.revision.previousEventId))
    || !isRecord(value.supersession)
    || !['current', 'corrected', 'cancelled', 'superseded'].includes(
      String(value.supersession.state),
    )
    || (value.supersession.relatedEventId !== null
      && !isNonEmptyString(value.supersession.relatedEventId))
    || (value.supersession.reason !== null
      && !isNonEmptyString(value.supersession.reason))
  ) {
    return false;
  }
  const provenance = validateDecisionSignalProvenance(value.provenance);
  return provenance.ok
    && provenance.value.signalId === value.id
    && provenance.value.familyId === 'typed_document_event';
}

function isAgencyHealth(value: unknown): value is ChinaPolicyAgencyHealth {
  return isRecord(value)
    && ['ok', 'partial', 'error'].includes(String(value.status))
    && isInstant(value.retrievedAt)
    && Number.isInteger(value.documentCount)
    && Number(value.documentCount) >= 0
    && Number.isInteger(value.requestCount)
    && Number(value.requestCount) >= 1
    && Array.isArray(value.failures)
    && value.failures.every((failure) => (
      isRecord(failure)
      && isNonEmptyString(failure.canonicalUrl)
      && isNonEmptyString(failure.reason)
    ));
}

export function isChinaPolicyPayload(value: unknown): value is ChinaPolicyPayload {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !isInstant(value.generatedAt)
    || !isRecord(value.agencies)
    || Object.keys(value.agencies).length !== AGENCIES.length
    || !Array.isArray(value.events)
    || value.events.length > 120
    || !value.events.every(isPolicyEvent)) {
    return false;
  }
  const agencies = value.agencies;
  return AGENCIES.every((agency) => isAgencyHealth(agencies[agency]));
}

function isSnapshot(value: unknown): value is ChinaPolicySnapshot {
  return isRecord(value)
    && isChinaPolicyPayload(value.data)
    && typeof value.cachedAt === 'number'
    && Number.isFinite(value.cachedAt)
    && value.cachedAt > 0;
}

export function createChinaPolicyService(options: ChinaPolicyServiceOptions = {}) {
  const getHydrated = options.getHydrated ?? (() => ensureHydrated('chinaPolicyEvents'));
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const cacheKey = options.cacheKey ?? CHINA_POLICY_EVENTS_CACHE_KEY;
  const now = options.now ?? Date.now;
  const breaker = createCircuitBreaker<ChinaPolicySnapshot | null>({
    name: options.breakerName ?? 'China Policy Events',
    cacheTtlMs: 60 * 60 * 1000,
    persistCache: options.persistCache ?? true,
    persistentStaleCeilingMs: CHINA_POLICY_LAST_GOOD_CEILING_MS,
  });

  async function fetchFresh(): Promise<ChinaPolicyPayload> {
    const hydrated = await getHydrated();
    if (isChinaPolicyPayload(hydrated)) {
      if (Date.parse(hydrated.generatedAt) > now() + GENERATED_AT_FUTURE_SKEW_MS) {
        throw new Error('China policy bootstrap generatedAt is in the future');
      }
      return hydrated;
    }

    const response = await fetchImpl(
      toApiUrl(`/api/bootstrap?keys=${CHINA_POLICY_EVENTS_BOOTSTRAP_KEY}&public=1`),
      {
        credentials: 'omit',
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Error(`China policy bootstrap failed: HTTP ${response.status}`);
    const payload = (await response.json()) as { data?: Record<string, unknown> };
    const data = payload.data?.[CHINA_POLICY_EVENTS_BOOTSTRAP_KEY];
    if (!isChinaPolicyPayload(data)) throw new Error('China policy bootstrap payload was invalid');
    if (Date.parse(data.generatedAt) > now() + GENERATED_AT_FUTURE_SKEW_MS) {
      throw new Error('China policy bootstrap generatedAt is in the future');
    }
    return data;
  }

  async function fetchData(): Promise<ChinaPolicyFetchResult> {
    let didFetchFresh = false;
    const snapshot = await breaker.execute(
      async () => {
        const data = await fetchFresh();
        didFetchFresh = true;
        return {
          data,
          cachedAt: Date.parse(data.generatedAt),
        };
      },
      null,
      {
        cacheKey,
        shouldCache: isSnapshot,
      },
    );
    if (
      snapshot === null
      || now() - snapshot.cachedAt > CHINA_POLICY_LAST_GOOD_CEILING_MS
    ) {
      return { data: null, state: 'unavailable', cachedAt: null };
    }
    const state: ChinaPolicyDataState = didFetchFresh
      && now() - snapshot.cachedAt <= CHINA_POLICY_TRANSPORT_STALE_MS
      ? 'live'
      : 'cached';
    return {
      data: snapshot.data,
      state,
      cachedAt: state === 'cached' ? snapshot.cachedAt : null,
    };
  }

  return { fetchFresh, fetch: fetchData };
}

const chinaPolicyService = createChinaPolicyService();

export async function fetchChinaPolicyEvents(): Promise<ChinaPolicyFetchResult> {
  return chinaPolicyService.fetch();
}
