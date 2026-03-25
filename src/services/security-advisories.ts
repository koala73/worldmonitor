import { getRpcBaseUrl } from '@/services/rpc-client';
import { getHydratedData } from '@/services/bootstrap';
import { dataFreshness } from './data-freshness';
import {
  IntelligenceServiceClient,
  type ListSecurityAdvisoriesResponse,
} from '@/generated/client/worldmonitor/intelligence/v1/service_client';

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

const client = new IntelligenceServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });

function normalizeAdvisories(
  raw: ListSecurityAdvisoriesResponse | { advisories: Array<{ title: string; link: string; pubDate: string; source: string; sourceCountry: string; level: string; country: string }>; byCountry: Record<string, string> },
): SecurityAdvisory[] {
  if (!raw?.advisories?.length) return [];
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

export async function loadAdvisoriesFromServer(): Promise<SecurityAdvisoriesFetchResult> {
  const now = Date.now();
  if (cachedResult && now - lastFetch < CACHE_TTL) {
    return { ok: true, advisories: cachedResult };
  }

  const hydrated = getHydratedData('securityAdvisories') as ListSecurityAdvisoriesResponse | undefined;
  if (hydrated?.advisories?.length) {
    const advisories = normalizeAdvisories(hydrated);
    cachedResult = advisories;
    lastFetch = now;
    dataFreshness.recordUpdate('security_advisories', advisories.length);
    return { ok: true, advisories };
  }

  try {
    const resp = await client.listSecurityAdvisories({});
    const advisories = normalizeAdvisories(resp);
    cachedResult = advisories;
    lastFetch = now;
    if (advisories.length > 0) {
      dataFreshness.recordUpdate('security_advisories', advisories.length);
    }
    return { ok: true, advisories };
  } catch (e) {
    console.warn('[SecurityAdvisories] RPC failed:', e);
  }

  return { ok: true, advisories: [] };
}

/** @deprecated Use loadAdvisoriesFromServer() instead */
export async function fetchSecurityAdvisories(): Promise<SecurityAdvisoriesFetchResult> {
  return loadAdvisoriesFromServer();
}
