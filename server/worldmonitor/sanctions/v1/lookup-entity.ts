import type {
  LookupSanctionEntityRequest,
  LookupSanctionEntityResponse,
  SanctionEntityMatch,
  SanctionsServiceHandler,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/sanctions/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const ENTITY_INDEX_KEY = 'sanctions:entities:v1';
const DEFAULT_MAX = 10;
const MAX_RESULTS_LIMIT = 50;
const MAX_QUERY_LENGTH = 200;
const MIN_QUERY_LENGTH = 2;
const OPENSANCTIONS_BASE = 'https://api.opensanctions.org';
const OPENSANCTIONS_TIMEOUT_MS = 8_000;

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

  if (!resp.ok) return null;

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
  try {
    const upstream = await searchOpenSanctions(q, maxResults);
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
