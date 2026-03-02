import type {
  ServerContext,
  ListCyberThreatsRequest,
  ListCyberThreatsResponse,
} from '../../../../src/generated/server/worldmonitor/cyber/v1/service_server';

import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';

import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  DEFAULT_DAYS,
  MAX_DAYS,
  clampInt,
  THREAT_TYPE_MAP,
  SOURCE_MAP,
  SEVERITY_MAP,
  SEVERITY_RANK,
  fetchFeodoSource,
  fetchUrlhausSource,
  fetchC2IntelSource,
  fetchOtxSource,
  fetchAbuseIpDbSource,
  dedupeThreats,
  hydrateThreatCoordinates,
  toProtoCyberThreat,
} from './_shared';

type CachedThreats = Pick<ListCyberThreatsResponse, 'threats'>;

const REDIS_CACHE_KEY = 'cyber:threats:v2';
const REDIS_CACHE_TTL = 7200; // 2 hr — IOC feeds update at most daily
const MAX_CACHED_THREATS = 2000;
const SEED_FRESHNESS_MS = 150 * 60 * 1000; // 2.5 hours

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = parseInt(cursor, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[cyber] invalid cursor "${cursor}", resetting to 0`);
    return 0;
  }
  return n;
}

function filterSeededThreats(
  threats: ListCyberThreatsResponse['threats'],
  req: ListCyberThreatsRequest,
): ListCyberThreatsResponse['threats'] {
  let results = threats;
  if (req.type && req.type !== 'CYBER_THREAT_TYPE_UNSPECIFIED') {
    results = results.filter((t) => t.type === req.type);
  }
  if (req.source && req.source !== 'CYBER_THREAT_SOURCE_UNSPECIFIED') {
    results = results.filter((t) => t.source === req.source);
  }
  if (req.minSeverity && req.minSeverity !== 'CRITICALITY_LEVEL_UNSPECIFIED') {
    const minRank = SEVERITY_RANK[req.minSeverity] || 0;
    results = results.filter((t) => (SEVERITY_RANK[t.severity || ''] || 0) >= minRank);
  }
  return results;
}

async function trySeededData(req: ListCyberThreatsRequest): Promise<CachedThreats | null> {
  try {
    const [seedData, seedMeta] = await Promise.all([
      getCachedJson(REDIS_CACHE_KEY, true) as Promise<CachedThreats | null>,
      getCachedJson('seed-meta:cyber:threats', true) as Promise<{ fetchedAt?: number } | null>,
    ]);

    if (!seedData?.threats?.length) return null;

    const fetchedAt = seedMeta?.fetchedAt ?? 0;
    const isFresh = Date.now() - fetchedAt < SEED_FRESHNESS_MS;

    if (isFresh) {
      return { threats: filterSeededThreats(seedData.threats, req) };
    }

    if (!process.env.SEED_FALLBACK_CYBER) {
      return { threats: filterSeededThreats(seedData.threats, req) };
    }

    return null;
  } catch {
    return null;
  }
}

export async function listCyberThreats(
  _ctx: ServerContext,
  req: ListCyberThreatsRequest,
): Promise<ListCyberThreatsResponse> {
  const empty: ListCyberThreatsResponse = { threats: [], pagination: { nextCursor: '', totalCount: 0 } };

  try {
    const now = Date.now();

    const pageSize = clampInt(req.pageSize, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = parseCursor(req.cursor);

    const seeded = await trySeededData(req);
    if (seeded) {
      const allThreats = seeded.threats;
      if (offset >= allThreats.length) return empty;
      const page = allThreats.slice(offset, offset + pageSize);
      const hasMore = offset + pageSize < allThreats.length;
      return {
        threats: page,
        pagination: { totalCount: allThreats.length, nextCursor: hasMore ? String(offset + pageSize) : '' },
      };
    }

    const cacheKey = `${REDIS_CACHE_KEY}:${req.start || 0}:${req.type || ''}:${req.source || ''}:${req.minSeverity || ''}`;

    const cached = await cachedFetchJson<CachedThreats>(cacheKey, REDIS_CACHE_TTL, async () => {
      let days = DEFAULT_DAYS;
      if (req.start) {
        days = clampInt(
          Math.ceil((now - req.start) / (24 * 60 * 60 * 1000)),
          DEFAULT_DAYS, 1, MAX_DAYS,
        );
      }
      const cutoffMs = now - days * 24 * 60 * 60 * 1000;

      const [feodoResult, urlhausResult, c2intelResult, otxResult, abuseipdbResult] = await Promise.allSettled([
        fetchFeodoSource(MAX_LIMIT, cutoffMs),
        fetchUrlhausSource(MAX_LIMIT, cutoffMs),
        fetchC2IntelSource(MAX_LIMIT),
        fetchOtxSource(MAX_LIMIT, days),
        fetchAbuseIpDbSource(MAX_LIMIT),
      ]);
      const fallback = { ok: false, threats: [] as any[] };
      if (feodoResult.status === 'rejected') console.warn('[cyber] feodo fetch failed, using partial results:', feodoResult.reason);
      if (urlhausResult.status === 'rejected') console.warn('[cyber] urlhaus fetch failed, using partial results:', urlhausResult.reason);
      if (c2intelResult.status === 'rejected') console.warn('[cyber] c2intel fetch failed, using partial results:', c2intelResult.reason);
      if (otxResult.status === 'rejected') console.warn('[cyber] otx fetch failed, using partial results:', otxResult.reason);
      if (abuseipdbResult.status === 'rejected') console.warn('[cyber] abuseipdb fetch failed, using partial results:', abuseipdbResult.reason);
      const feodo = feodoResult.status === 'fulfilled' ? feodoResult.value : fallback;
      const urlhaus = urlhausResult.status === 'fulfilled' ? urlhausResult.value : fallback;
      const c2intel = c2intelResult.status === 'fulfilled' ? c2intelResult.value : fallback;
      const otx = otxResult.status === 'fulfilled' ? otxResult.value : fallback;
      const abuseipdb = abuseipdbResult.status === 'fulfilled' ? abuseipdbResult.value : fallback;

      const anySucceeded = feodo.ok || urlhaus.ok || c2intel.ok || otx.ok || abuseipdb.ok;
      if (!anySucceeded) return null;

      const combined = dedupeThreats([
        ...feodo.threats,
        ...urlhaus.threats,
        ...c2intel.threats,
        ...otx.threats,
        ...abuseipdb.threats,
      ]);

      const hydrated = await hydrateThreatCoordinates(combined);

      let results = hydrated
        .filter((t) => t.lat !== null && t.lon !== null && t.lat >= -90 && t.lat <= 90 && t.lon >= -180 && t.lon <= 180);

      if (req.type && req.type !== 'CYBER_THREAT_TYPE_UNSPECIFIED') {
        const filterType = req.type;
        results = results.filter((t) => THREAT_TYPE_MAP[t.type] === filterType);
      }
      if (req.source && req.source !== 'CYBER_THREAT_SOURCE_UNSPECIFIED') {
        const filterSource = req.source;
        results = results.filter((t) => SOURCE_MAP[t.source] === filterSource);
      }
      if (req.minSeverity && req.minSeverity !== 'CRITICALITY_LEVEL_UNSPECIFIED') {
        const minRank = SEVERITY_RANK[req.minSeverity] || 0;
        results = results.filter((t) => (SEVERITY_RANK[SEVERITY_MAP[t.severity] || ''] || 0) >= minRank);
      }

      results.sort((a, b) => {
        const bySeverity = (SEVERITY_RANK[SEVERITY_MAP[b.severity] || ''] || 0)
          - (SEVERITY_RANK[SEVERITY_MAP[a.severity] || ''] || 0);
        if (bySeverity !== 0) return bySeverity;
        return (b.lastSeen || b.firstSeen) - (a.lastSeen || a.firstSeen);
      });

      const threats = results.slice(0, MAX_CACHED_THREATS).map(toProtoCyberThreat);
      return threats.length > 0 ? { threats } : null;
    });

    if (!cached) return empty;

    const allThreats = cached.threats;
    if (offset >= allThreats.length) return empty;
    const page = allThreats.slice(offset, offset + pageSize);
    const hasMore = offset + pageSize < allThreats.length;

    return {
      threats: page,
      pagination: {
        totalCount: allThreats.length,
        nextCursor: hasMore ? String(offset + pageSize) : '',
      },
    };
  } catch (err) {
    console.error('[cyber] listCyberThreats failed', err);
    return empty;
  }
}
