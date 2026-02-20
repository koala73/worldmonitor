declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  ListCyberThreatsRequest,
  ListCyberThreatsResponse,
} from '../../../../src/generated/server/worldmonitor/cyber/v1/service_server';

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

export async function listCyberThreats(
  _ctx: ServerContext,
  req: ListCyberThreatsRequest,
): Promise<ListCyberThreatsResponse> {
  try {
    const now = Date.now();
    const pageSize = clampInt(req.pagination?.pageSize, DEFAULT_LIMIT, 1, MAX_LIMIT);

    // Derive days from timeRange or use default
    let days = DEFAULT_DAYS;
    if (req.timeRange?.start) {
      days = clampInt(
        Math.ceil((now - req.timeRange.start) / (24 * 60 * 60 * 1000)),
        DEFAULT_DAYS, 1, MAX_DAYS,
      );
    }
    const cutoffMs = now - days * 24 * 60 * 60 * 1000;

    // Fetch all sources in parallel
    const [feodo, urlhaus, c2intel, otx, abuseipdb] = await Promise.all([
      fetchFeodoSource(pageSize, cutoffMs),
      fetchUrlhausSource(pageSize, cutoffMs),
      fetchC2IntelSource(pageSize),
      fetchOtxSource(pageSize, days),
      fetchAbuseIpDbSource(pageSize),
    ]);

    const anySucceeded = feodo.ok || urlhaus.ok || c2intel.ok || otx.ok || abuseipdb.ok;
    if (!anySucceeded) {
      return { threats: [], pagination: undefined };
    }

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

    // Apply optional filters BEFORE sorting + slicing (C-2 fix)
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

    // Sort by severity then recency, then apply page size limit
    results = results
      .sort((a, b) => {
        const bySeverity = (SEVERITY_RANK[SEVERITY_MAP[b.severity] || ''] || 0)
          - (SEVERITY_RANK[SEVERITY_MAP[a.severity] || ''] || 0);
        if (bySeverity !== 0) return bySeverity;
        return (b.lastSeen || b.firstSeen) - (a.lastSeen || a.firstSeen);
      })
      .slice(0, pageSize);

    return {
      threats: results.map(toProtoCyberThreat),
      pagination: undefined,
    };
  } catch {
    return { threats: [], pagination: undefined };
  }
}
