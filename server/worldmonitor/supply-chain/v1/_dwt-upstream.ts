/**
 * S&P Global Market Intelligence — Tanker DWT Departure Data
 *
 * Fetches weekly directional DWT (deadweight tonnage) departure metrics
 * for monitored chokepoints. Data sourced from S&P Global Maritime & Trade
 * vessel tracking, matching the taxonomy used by UBS Evidence Lab.
 *
 * API: S&P Global Market Intelligence Maritime API
 * Auth: Bearer token via SP_GLOBAL_API_KEY
 * Rate limit: 100 req/min (commercial tier)
 * Refresh: Weekly (data published every Monday)
 */

import { cachedFetchJson } from '../../../_shared/redis';

const SP_GLOBAL_API_KEY = process.env.SP_GLOBAL_API_KEY ?? '';
const SP_GLOBAL_BASE_URL = process.env.SP_GLOBAL_BASE_URL ?? 'https://api.spglobal.com/maritime/v1';
const FETCH_TIMEOUT_MS = 15_000;
const REDIS_CACHE_KEY = 'supply_chain:dwt_departures:v1';
const REDIS_CACHE_TTL = 3600; // 1 hour — data is weekly, no need to hammer

/**
 * Chokepoint ID mapping from our internal IDs to S&P Global's chokepoint slugs.
 * S&P uses a different naming convention for their API endpoints.
 */
const SP_CHOKEPOINT_SLUGS: Record<string, string> = {
  suez: 'suez-canal',
  malacca: 'malacca-strait',
  hormuz: 'hormuz-strait',
  bab_el_mandeb: 'bab-el-mandeb',
  panama: 'panama-canal',
  taiwan: 'taiwan-strait',
  cape_of_good_hope: 'cape-good-hope',
  gibraltar: 'gibraltar-strait',
  bosphorus: 'bosphorus-strait',
  dardanelles: 'dardanelles-strait',
};

export interface DwtDataPoint {
  direction: string;
  dwtThousandTonnes: number;
  wowChangePct: number;
}

export interface ChokepointDwtData {
  [chokepointId: string]: DwtDataPoint[];
}

interface SpGlobalDwtResponse {
  data: {
    chokepoint: string;
    direction: string;
    dwt_departing_kt: number;
    wow_change_pct: number;
    as_of_date: string;
    vessel_category: string;
  }[];
  meta: {
    as_of: string;
    total_records: number;
  };
}

async function fetchDwtFromSpGlobal(): Promise<ChokepointDwtData | null> {
  if (!SP_GLOBAL_API_KEY) return null;

  try {
    const url = `${SP_GLOBAL_BASE_URL}/chokepoints/dwt-departures?vessel_category=tanker&period=latest`;

    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${SP_GLOBAL_API_KEY}`,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!resp.ok) return null;

    const body: SpGlobalDwtResponse = await resp.json();
    if (!body.data?.length) return null;

    // Build a reverse map: S&P slug → our internal ID
    const slugToId = new Map<string, string>();
    for (const [id, slug] of Object.entries(SP_CHOKEPOINT_SLUGS)) {
      slugToId.set(slug, id);
    }

    // Group by chokepoint ID
    const result: ChokepointDwtData = {};
    for (const row of body.data) {
      const cpId = slugToId.get(row.chokepoint);
      if (!cpId) continue;

      if (!result[cpId]) result[cpId] = [];
      result[cpId].push({
        direction: row.direction,
        dwtThousandTonnes: row.dwt_departing_kt,
        wowChangePct: row.wow_change_pct,
      });
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * Fetch DWT departure data with Redis caching.
 * Returns null if the upstream is unavailable or API key is not configured.
 */
export async function getDwtDepartures(): Promise<ChokepointDwtData | null> {
  if (!SP_GLOBAL_API_KEY) return null;

  const result = await cachedFetchJson<{ dwt: ChokepointDwtData }>(
    REDIS_CACHE_KEY,
    REDIS_CACHE_TTL,
    async () => {
      const dwt = await fetchDwtFromSpGlobal();
      return dwt ? { dwt } : null;
    },
  );

  return result?.dwt ?? null;
}
