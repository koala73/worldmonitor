import { createLazyClient, getRpcBaseUrl } from '@/services/rpc-client';
import { normalizeAdvisorySnapshot, type AdvisorySnapshotRecord } from '../../shared/intelligence-snapshots.js';
import { getHydratedData } from '@/services/bootstrap';
import { dataFreshness } from './data-freshness';
import { IntelligenceServiceClient } from '@/services/generated-rpc-clients';

export interface SecurityAdvisory {
  title: string;
  link: string;
  pubDate: Date;
  source: string;
  sourceCountry: string;
  level?: 'do-not-travel' | 'reconsider' | 'caution' | 'normal' | 'info';
  country?: string;
}

export interface SecurityAdvisoriesFetchResult {
  ok: boolean;
  advisories: SecurityAdvisory[];
  cachedAt?: string;
}

const getClient = createLazyClient(() => new IntelligenceServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) }));

function normalizeAdvisories(raw: { advisories: AdvisorySnapshotRecord[] }): SecurityAdvisory[] {
  return raw.advisories.map(a => ({
    title: a.title,
    link: a.link,
    pubDate: new Date(a.pubDate),
    source: a.source,
    sourceCountry: a.sourceCountry,
    level: (a.level || 'info') as SecurityAdvisory['level'],
    ...(a.country ? { country: a.country } : {}),
  }));
}

let cachedResult: SecurityAdvisory[] | null = null;
let lastFetch = 0;
const CACHE_TTL = 15 * 60 * 1000;
// Last-good advisories survive a failed read for at most an hour.
const STALE_MAX = 60 * 60 * 1000;

export async function loadAdvisoriesFromServer(): Promise<SecurityAdvisoriesFetchResult> {
  const now = Date.now();
  if (cachedResult && now - lastFetch < CACHE_TTL) {
    return { ok: true, advisories: cachedResult };
  }

  const hydrated = normalizeAdvisorySnapshot(getHydratedData('securityAdvisories'));
  if (hydrated) {
    const advisories = normalizeAdvisories(hydrated);
    cachedResult = advisories;
    lastFetch = Date.now();
    dataFreshness.recordUpdate('security_advisories', advisories.length);
    return { ok: true, advisories };
  }

  try {
    const snapshot = normalizeAdvisorySnapshot(await getClient().listSecurityAdvisories({}));
    if (!snapshot) throw new Error('Security advisory snapshot unavailable');
    const advisories = normalizeAdvisories(snapshot);
    cachedResult = advisories;
    lastFetch = Date.now();
    if (advisories.length > 0) {
      dataFreshness.recordUpdate('security_advisories', advisories.length);
    }
    return { ok: true, advisories };
  } catch (e) {
    console.warn('[SecurityAdvisories] RPC failed:', e);
    dataFreshness.recordError('security_advisories', e instanceof Error ? e.message : 'Fetch failed');
  }

  return { ok: false, advisories: cachedResult && Date.now() - lastFetch < STALE_MAX ? cachedResult : [] };
}

/** @deprecated Use loadAdvisoriesFromServer() instead */
export async function fetchSecurityAdvisories(): Promise<SecurityAdvisoriesFetchResult> {
  return loadAdvisoriesFromServer();
}
