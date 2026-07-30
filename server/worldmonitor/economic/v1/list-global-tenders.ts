/**
 * RPC: listGlobalTenders -- paginated reads of the Railway-seeded global procurement feed.
 * Upstream procurement portals are never fetched from Edge request paths.
 */

import type {
  GlobalTender,
  ListGlobalTendersRequest,
  ListGlobalTendersResponse,
  ServerContext,
  TenderSourceStatus,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const SEED_CACHE_KEY = 'economic:global-tenders:v1';
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const STALE_AFTER_MS = 180 * 60_000;

type SeedSnapshot = {
  fetchedAt?: number | string;
  dataAvailable?: boolean;
  availability?: string;
  tenders?: GlobalTender[];
  sourceStatuses?: TenderSourceStatus[];
};

function snapshotTimestamp(value: number | string | undefined): number {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function applySnapshotFreshness(snapshot: SeedSnapshot, now = Date.now()): SeedSnapshot {
  const fetchedAt = snapshotTimestamp(snapshot.fetchedAt);
  const stale = snapshot.dataAvailable === true
    && (snapshot.availability === 'stale' || !fetchedAt || now - fetchedAt > STALE_AFTER_MS);
  if (!stale) return snapshot;
  return {
    ...snapshot,
    availability: 'stale',
    sourceStatuses: (snapshot.sourceStatuses || []).map((status) => status.state === 'ok'
      ? { ...status, state: 'stale', stale: true, lastSuccessfulAt: status.lastSuccessfulAt || status.fetchedAt }
      : status),
  };
}

function normalized(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

function asTimestamp(value: string | undefined, fallback: number): number {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function pageOffset(cursor: string): number {
  if (!/^\d{1,6}$/.test(cursor || '')) return 0;
  const value = Number(cursor);
  return Number.isSafeInteger(value) ? value : 0;
}

function pageSize(value: number): number {
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Number.isInteger(value) && value > 0 ? value : DEFAULT_PAGE_SIZE));
}

function matchesText(tender: GlobalTender, query: string): boolean {
  if (!query) return true;
  return [tender.title, tender.description, tender.buyer, tender.source, ...tender.categoryCodes, ...tender.sectors]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(query);
}

function compareTenders(sort: string, left: GlobalTender, right: GlobalTender): number {
  const byId = left.id.localeCompare(right.id);
  if (sort === 'closing_soon') {
    return asTimestamp(left.deadline, Number.MAX_SAFE_INTEGER) - asTimestamp(right.deadline, Number.MAX_SAFE_INTEGER) || byId;
  }
  if (sort === 'estimated_value') return (right.money?.amount || 0) - (left.money?.amount || 0) || byId;
  if (sort === 'relevance') return (right.automationFit?.score || 0) - (left.automationFit?.score || 0) || byId;
  return asTimestamp(right.publishedAt || right.updatedAt, 0) - asTimestamp(left.publishedAt || left.updatedAt, 0) || byId;
}

export function filterAndPaginateTenders(tenders: GlobalTender[], req: ListGlobalTendersRequest): Pick<ListGlobalTendersResponse, 'tenders' | 'nextCursor' | 'total' | 'appliedFilters' | 'countryCoverage'> {
  const countries = new Set([req.country, ...(req.countries || [])].map((value) => normalized(value)).filter(Boolean));
  const region = normalized(req.region);
  const source = normalized(req.source);
  const status = normalized(req.status);
  const currency = normalized(req.currency);
  const category = normalized(req.category);
  const query = normalized(req.query);
  const buyer = normalized(req.buyer);
  const deadlineFrom = asTimestamp(req.deadlineFrom, Number.NEGATIVE_INFINITY);
  const deadlineTo = asTimestamp(req.deadlineTo, Number.POSITIVE_INFINITY);
  const publishedFrom = asTimestamp(req.publishedFrom, Number.NEGATIVE_INFINITY);
  const publishedTo = asTimestamp(req.publishedTo, Number.POSITIVE_INFINITY);
  const hasDeadlineFrom = Boolean(req.deadlineFrom);
  const hasDeadlineTo = Boolean(req.deadlineTo);
  const hasPublishedFrom = Boolean(req.publishedFrom);
  const hasPublishedTo = Boolean(req.publishedTo);
  const minValue = req.minValue > 0 ? req.minValue : null;
  const maxValue = req.maxValue > 0 ? req.maxValue : null;
  // Evidence-backed relevance threshold; disabled unless a positive bounded
  // value is supplied so unfiltered callers keep the complete open feed.
  // The field is int32 in the contract, so non-integer input is malformed and
  // disables the filter (mirroring page_size), keeping runtime behavior
  // aligned with the integer type the OpenAPI schema advertises.
  const minAutomationScore = Number.isInteger(req.minAutomationScore) && req.minAutomationScore > 0
    ? Math.min(100, req.minAutomationScore)
    : null;
  const sort = ['newest', 'closing_soon', 'estimated_value', 'relevance'].includes(req.sort) ? req.sort : 'newest';

  const appliedFilters = [
    countries.size && 'country', region && 'region', source && 'source', status && 'status',
    hasDeadlineFrom && 'deadline_from', hasDeadlineTo && 'deadline_to', minValue !== null && 'min_value', maxValue !== null && 'max_value',
    currency && 'currency', category && 'category', query && 'query', buyer && 'buyer',
    hasPublishedFrom && 'published_from', hasPublishedTo && 'published_to',
    minAutomationScore !== null && 'min_automation_score',
  ].filter((value): value is string => Boolean(value));

  const filtered = tenders.filter((tender) => {
    const amount = tender.money?.amount;
    const deadline = asTimestamp(tender.deadline, Number.NaN);
    const published = asTimestamp(tender.publishedAt, Number.NaN);
    return (!countries.size || countries.has(normalized(tender.countryCode)))
      && (!region || normalized(tender.region) === region)
      && (!source || normalized(tender.source) === source)
      && (!status || normalized(tender.status) === status)
      && (!buyer || normalized(tender.buyer).includes(buyer))
      && (!hasDeadlineFrom || (Number.isFinite(deadline) && deadline >= deadlineFrom))
      && (!hasDeadlineTo || (Number.isFinite(deadline) && deadline <= deadlineTo))
      && (!hasPublishedFrom || (Number.isFinite(published) && published >= publishedFrom))
      && (!hasPublishedTo || (Number.isFinite(published) && published <= publishedTo))
      && (minValue === null || (typeof amount === 'number' && amount >= minValue))
      && (maxValue === null || (typeof amount === 'number' && amount <= maxValue))
      && (!currency || normalized(tender.money?.currency) === currency)
      && (!category || [...tender.categoryCodes, ...tender.sectors].some((value) => normalized(value).includes(category)))
      && (minAutomationScore === null || (tender.automationFit?.score || 0) >= minAutomationScore)
      && matchesText(tender, query);
  }).sort((left, right) => compareTenders(sort, left, right));

  // A snapshot cannot establish that a country has no opportunities or that no
  // adapter supports it. It can only establish that this request has (or lacks)
  // an observed country record, so surface that uncertainty to callers.
  const observedCountries = new Set(tenders.map((tender) => normalized(tender.countryCode)).filter(Boolean));
  const countryCoverage = countries.size === 0 ? 'not_requested'
    : [...countries].every((country) => observedCountries.has(country)) ? 'observed' : 'unknown';

  const size = pageSize(req.pageSize);
  const start = pageOffset(req.cursor);
  const page = start < filtered.length ? filtered.slice(start, start + size) : [];
  const next = start + page.length;
  return { tenders: page, nextCursor: next < filtered.length ? String(next) : '', total: filtered.length, appliedFilters, countryCoverage };
}

function unavailable(ctx: ServerContext): ListGlobalTendersResponse {
  return markNoStoreFallbackResponse(ctx.request, {
    tenders: [], nextCursor: '', fetchedAt: '', dataAvailable: false, availability: 'unavailable', sourceStatuses: [], total: 0, appliedFilters: [], countryCoverage: 'unknown',
  });
}

export async function listGlobalTenders(ctx: ServerContext, req: ListGlobalTendersRequest): Promise<ListGlobalTendersResponse> {
  try {
    const snapshot = await getCachedJson(SEED_CACHE_KEY, true) as SeedSnapshot | null;
    if (!snapshot || !Array.isArray(snapshot.tenders) || !Array.isArray(snapshot.sourceStatuses)) return unavailable(ctx);
    const freshSnapshot = applySnapshotFreshness(snapshot);
    const page = filterAndPaginateTenders(freshSnapshot.tenders || [], req);
    return {
      ...page,
      fetchedAt: freshSnapshot.fetchedAt ? new Date(freshSnapshot.fetchedAt).toISOString() : '',
      dataAvailable: freshSnapshot.dataAvailable === true,
      availability: freshSnapshot.availability || 'unavailable',
      sourceStatuses: freshSnapshot.sourceStatuses || [],
    };
  } catch {
    return unavailable(ctx);
  }
}
