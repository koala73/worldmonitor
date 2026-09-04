import type {
  LookupSanctionEntityRequest,
  LookupSanctionEntityResponse,
  SanctionEntityMatch,
  SanctionsServiceHandler,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/sanctions/v1/service_server';

import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';

const ENTITY_INDEX_KEY = 'sanctions:entities:v1';
const DEFAULT_MAX = 10;
const MAX_RESULTS_LIMIT = 50;
const MAX_QUERY_LENGTH = 200;
const MIN_QUERY_LENGTH = 2;
const OPENSANCTIONS_BASE = 'https://api.opensanctions.org';
const OPENSANCTIONS_TIMEOUT_MS = 8_000;
// Designations are published by regulators daily at most, so an hour of reuse
// is well inside any reasonable freshness expectation while collapsing the
// repeat-query traffic that dominates entity lookups.
const OPENSANCTIONS_CACHE_TTL_SECONDS = 3_600;

interface EntityIndexRecord {
  id: string;
  name: string;
  et: string;
  cc: string[];
  pr: string[];
}

interface OpenSanctionsHit {
  id?: string;
  schema?: string;
  caption?: string;
  properties?: {
    name?: string[];
    country?: string[];
    nationality?: string[];
    program?: string[];
    sanctions?: string[];
  };
}

interface OpenSanctionsSearchResponse {
  results?: OpenSanctionsHit[];
  total?: { value?: number };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function clampMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_RESULTS_LIMIT);
}

function entityTypeFromSchema(schema: string): string {
  if (schema === 'Vessel') return 'vessel';
  if (schema === 'Aircraft') return 'aircraft';
  if (schema === 'Person') return 'individual';
  return 'entity';
}

function normalizeOpenSanctionsHit(hit: OpenSanctionsHit): SanctionEntityMatch | null {
  const props = hit.properties ?? {};
  const name = (props.name ?? [hit.caption ?? '']).filter(Boolean)[0] ?? '';
  if (!name || !hit.id) return null;
  const countries = (props.country ?? props.nationality ?? []).slice(0, 3);
  const programs = (props.program ?? props.sanctions ?? []).slice(0, 3);
  return {
    id: `opensanctions:${hit.id}`,
    name,
    entityType: entityTypeFromSchema(hit.schema ?? ''),
    countryCodes: countries,
    programs,
  };
}

/**
 * Cache identity for a lookup. Case and surrounding/interior whitespace are
 * not meaningful to OpenSanctions' matcher, so folding them here lets the
 * common "same name typed slightly differently" retries share one entry.
 * `maxResults` stays in the key because a narrower response must never be
 * replayed to a caller that asked for a wider one.
 */
function lookupCacheKey(q: string, maxResults: number): string {
  const canonical = q.toLowerCase().replace(/\s+/g, ' ').trim();
  let hash = 2166136261;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `sanctions:lookup:v1:${(hash >>> 0).toString(36)}:${maxResults}`;
}

async function searchOpenSanctions(q: string, limit: number): Promise<{ results: SanctionEntityMatch[]; total: number } | null> {
  const url = new URL(`${OPENSANCTIONS_BASE}/search/default`);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(limit));

  const resp = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'WorldMonitor/1.0 sanctions-search',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(OPENSANCTIONS_TIMEOUT_MS),
  });

  // Throw rather than return null so an availability failure takes the
  // no-negative-cache path below. Returning null would persist a sentinel and
  // pin every later caller to the narrower OFAC index for the negative TTL.
  if (!resp.ok) throw new Error(`OpenSanctions HTTP ${resp.status}`);

  const data = (await resp.json()) as OpenSanctionsSearchResponse;
  const hits = Array.isArray(data.results) ? data.results : [];
  const results = hits
    .map(normalizeOpenSanctionsHit)
    .filter((r): r is SanctionEntityMatch => r !== null);
  const total = data.total?.value ?? results.length;
  return { results, total };
}

function searchOfacLocal(q: string, maxResults: number, raw: unknown): { results: SanctionEntityMatch[]; total: number } {
  if (!Array.isArray(raw)) return { results: [], total: 0 };

  const index = raw as EntityIndexRecord[];
  const needle = normalize(q);
  const tokens = needle.split(' ').filter(Boolean);
  const scored: Array<{ score: number; entry: EntityIndexRecord }> = [];

  for (const entry of index) {
    const haystack = normalize(entry.name);

    if (haystack === needle) {
      scored.push({ score: 100, entry });
      continue;
    }
    if (haystack.startsWith(needle)) {
      scored.push({ score: 80, entry });
      continue;
    }
    if (tokens.length > 0 && tokens.every((t) => haystack.includes(t))) {
      const pos = haystack.indexOf(tokens[0] ?? '');
      scored.push({ score: 60 - Math.min(pos, 20), entry });
      continue;
    }
    const matchCount = tokens.filter((t) => haystack.includes(t)).length;
    if (matchCount > 0) {
      scored.push({ score: matchCount * 10, entry });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const results: SanctionEntityMatch[] = scored.slice(0, maxResults).map(({ entry }) => ({
    id: entry.id,
    name: entry.name,
    entityType: entry.et,
    countryCodes: entry.cc,
    programs: entry.pr,
  }));

  return { results, total: scored.length };
}

export const lookupSanctionEntity: SanctionsServiceHandler['lookupSanctionEntity'] = async (
  _ctx: ServerContext,
  req: LookupSanctionEntityRequest,
): Promise<LookupSanctionEntityResponse> => {
  const q = (req.q ?? '').trim();
  if (q.length < MIN_QUERY_LENGTH || q.length > MAX_QUERY_LENGTH) {
    return { results: [], total: 0, source: 'opensanctions' };
  }

  const maxResults = clampMax(req.maxResults);

  // Primary: live query against OpenSanctions — broader global coverage than
  // the local OFAC index. Matches the legacy /api/sanctions-entity-search path.
  // Cached because repeat lookups dominate this route (#6235); a genuine
  // zero-match answer caches normally, but an upstream outage must not be
  // persisted as one, hence cacheFetcherErrors: false.
  try {
    const upstream = await cachedFetchJson<{ results: SanctionEntityMatch[]; total: number }>(
      lookupCacheKey(q, maxResults),
      OPENSANCTIONS_CACHE_TTL_SECONDS,
      () => searchOpenSanctions(q, maxResults),
      undefined,
      { cacheFetcherErrors: false },
    );
    if (upstream) {
      return { ...upstream, source: 'opensanctions' };
    }
  } catch {
    // fall through to OFAC fallback
  }

  // Fallback: local OFAC fuzzy match from the seeded Redis index. Keeps the
  // endpoint useful when OpenSanctions is unreachable or rate-limiting us.
  try {
    const raw = await getCachedJson(ENTITY_INDEX_KEY, true);
    return { ...searchOfacLocal(q, maxResults, raw), source: 'ofac' };
  } catch {
    return { results: [], total: 0, source: 'ofac' };
  }
};
