import type {
  ServerContext,
  ListCyberThreatsRequest,
  ListCyberThreatsResponse,
} from '../../../../src/generated/server/worldmonitor/cyber/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';

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
const MAX_CACHED_THREATS = 2000; // cap cached set to avoid oversized Redis values

/** Parse a cursor string into a numeric offset. Invalid/negative values reset to page 1. */
function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = parseInt(cursor, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[cyber] invalid cursor "${cursor}", resetting to 0`);
    return 0;
  }
  return n;
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

    // Cache key excludes pageSize and cursor — cache holds the full filtered result set.
    // Changing filter params (start, type, source, minSeverity) between pages resets pagination
    // because the underlying result set changes. Clients must keep filters stable across pages.
    const cacheKey = `${REDIS_CACHE_KEY}:${req.start || 0}:${req.type || ''}:${req.source || ''}:${req.minSeverity || ''}`;

    const cached = await cachedFetchJson<CachedThreats>(cacheKey, REDIS_CACHE_TTL, async () => {
      // Derive days from timeRange or use default
      let days = DEFAULT_DAYS;
      if (req.start) {
        days = clampInt(
          Math.ceil((now - req.start) / (24 * 60 * 60 * 1000)),
          DEFAULT_DAYS, 1, MAX_DAYS,
        );
      }
      const cutoffMs = now - days * 24 * 60 * 60 * 1000;

      // Fetch all sources in parallel — use MAX_LIMIT so the cache covers all pages.
      const [feodo, urlhaus, c2intel, otx, abuseipdb] = await Promise.all([
        fetchFeodoSource(MAX_LIMIT, cutoffMs),
        fetchUrlhausSource(MAX_LIMIT, cutoffMs),
        fetchC2IntelSource(MAX_LIMIT),
        fetchOtxSource(MAX_LIMIT, days),
        fetchAbuseIpDbSource(MAX_LIMIT),
      ]);

      const anySucceeded = feodo.ok || urlhaus.ok || c2intel.ok || otx.ok || abuseipdb.ok;
      if (!anySucceeded) return null;

      // Merge, deduplicate, hydrate coordinates
      const combined = dedupeThreats([
        ...feodo.threats,
        ...urlhaus.threats,
        ...c2intel.threats,
        ...otx.threats,
        ...abuseipdb.threats,
      ]);

      const hydrated = await hydrateThreatCoordinates(combined);

      // Filter to only threats with valid coordinates
      let results = hydrated
        .filter((t) => t.lat !== null && t.lon !== null && t.lat >= -90 && t.lat <= 90 && t.lon >= -180 && t.lon <= 180);

      // Apply optional filters BEFORE sorting (C-2 fix)
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

      // Sort by severity then recency — store the full sorted set (no slice).
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

    // Apply cursor-based pagination over the cached full result set.
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
