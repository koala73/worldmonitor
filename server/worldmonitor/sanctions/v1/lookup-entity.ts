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
const MIN_QUERY_LENGTH = 2;

interface EntityIndexRecord {
  id: string;
  name: string;
  et: string;
  cc: string[];
  pr: string[];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function clampMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_RESULTS_LIMIT);
}

export const lookupSanctionEntity: SanctionsServiceHandler['lookupSanctionEntity'] = async (
  _ctx: ServerContext,
  req: LookupSanctionEntityRequest,
): Promise<LookupSanctionEntityResponse> => {
  const q = (req.q ?? '').trim();
  if (q.length < MIN_QUERY_LENGTH) {
    return { results: [], total: 0, source: 'ofac' };
  }

  const maxResults = clampMax(req.maxResults);
  const needle = normalize(q);
  const tokens = needle.split(' ').filter(Boolean);

  try {
    const raw = await getCachedJson(ENTITY_INDEX_KEY, true);
    if (!Array.isArray(raw)) return { results: [], total: 0, source: 'ofac' };

    const index = raw as EntityIndexRecord[];
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

    return { results, total: scored.length, source: 'ofac' };
  } catch {
    return { results: [], total: 0, source: 'ofac' };
  }
};
