import type {
  ServerContext,
  GetPizzintStatusRequest,
  GetPizzintStatusResponse,
  TensionEvidence,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { readCachedJson, logCacheReadError } from '../../../_shared/redis';
import { markNoCacheResponse, markNoStoreFallbackResponse } from '../../../_shared/response-headers';
import pairs from '../../../../shared/gdelt-tension-pairs.json';

const SEED_KEY = 'intelligence:pizzint:seed:v1';
const TENSION_KEY = 'gdelt:bulk:dyad-tension:v1';
// Written by scripts/seed-tension-evidence.mjs every 15 minutes.
const EVIDENCE_KEY = 'intelligence:tension-evidence:v1';
const MAX_AGE_MS = 45 * 60_000;
const EVIDENCE_CHANNELS = new Set(['strikes', 'airports', 'military_aircraft', 'pla_aircraft', 'pla_ships', 'sanctions']);
const AIRPORT_STATUSES = new Set(['closed', 'halted', 'restricted']);
const ISO2 = /^[A-Z]{2}$/;

const isFresh = (updatedAt: unknown): boolean => typeof updatedAt === 'number'
  && updatedAt <= Date.now() && Date.now() - updatedAt <= MAX_AGE_MS;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function toEvidence(item: unknown): TensionEvidence | null {
  const stored = item as Record<string, unknown> | null;
  if (!stored || stored.notable !== true || !EVIDENCE_CHANNELS.has(stored.channel as string)) return null;
  const { value, baseline, countries, airports, observedAt } = stored;
  if (!isCount(value) || !(baseline == null || isCount(baseline)) || !isCount(observedAt)) return null;
  if (!Array.isArray(countries) || !countries.every(cc => typeof cc === 'string' && ISO2.test(cc))) return null;
  if (!Array.isArray(airports) || !airports.every(airport => typeof airport?.name === 'string'
    && AIRPORT_STATUSES.has(airport.status))) return null;
  return {
    channel: stored.channel as string,
    value,
    ...(baseline == null ? {} : { baseline }),
    countries,
    airports: airports.map(({ name, status }) => ({ name, status })),
    observedAt,
  };
}

export async function getPizzintStatus(
  ctx: ServerContext,
  req: GetPizzintStatusRequest,
): Promise<GetPizzintStatusResponse> {
  // Recheck the source clock on every request; the route's shared cache tier
  // would otherwise keep numeric scores beyond the source freshness budget.
  if (req.includeGdelt) markNoCacheResponse(ctx.request);
  let failed = false;
  async function readKey(key: string): Promise<unknown> {
    try {
      const read = await readCachedJson(key, true);
      if (read.status === 'error') {
        logCacheReadError(key, read.error);
        failed = true;
      }
      return read.status === 'hit' ? read.value : null;
    } catch { failed = true; return null; }
  }
  // Read alongside the scores; a missing or failed evidence read leaves the
  // scores as they are.
  const [pizza, tensions, evidence] = await Promise.all([
    readKey(SEED_KEY),
    req.includeGdelt ? readKey(TENSION_KEY) : null,
    req.includeGdelt ? readKey(EVIDENCE_KEY) : null,
  ]);
  const seed = tensions as { updatedAt?: number; tensionPairs?: GetPizzintStatusResponse['tensionPairs'] } | null;
  const stored = evidence as { updatedAt?: number; live?: unknown } | null;
  const live = isFresh(stored?.updatedAt) && stored?.live && typeof stored.live === 'object' && !Array.isArray(stored.live)
    ? stored.live as Record<string, unknown>
    : {};
  const evidenceFor = (id: string): TensionEvidence[] => (Array.isArray(live[id]) ? live[id] : [])
    .map(toEvidence)
    .filter((item): item is TensionEvidence => item !== null);
  const response: GetPizzintStatusResponse = {
    pizzint: (pizza as GetPizzintStatusResponse | null)?.pizzint,
    tensionPairs: isFresh(seed?.updatedAt) && Array.isArray(seed?.tensionPairs) ? seed.tensionPairs.filter(pair =>
      pair && pairs.some(config => config.id === pair.id)
      && Number.isFinite(pair.score) && pair.score >= 0 && pair.score <= 100
      && Number.isFinite(pair.changePercent)).map(pair => ({ ...pair, evidence: evidenceFor(pair.id) })) : [],
  };
  return failed ? markNoStoreFallbackResponse(ctx.request, response) : response;
}
