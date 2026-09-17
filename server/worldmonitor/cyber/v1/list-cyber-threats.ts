/**
 * ListCyberThreats RPC -- reads seeded cyber threat data from Railway seed cache.
 * All external IOC feed calls happen in seed-cyber.mjs on Railway.
 */

import {
  ApiError,
  type ServerContext,
  type ListCyberThreatsRequest,
  type ListCyberThreatsResponse,
} from '../../../../src/generated/server/worldmonitor/cyber/v1/service_server';

import { logCacheReadError, readCachedJson } from '../../../_shared/redis';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  clampInt,
  SEVERITY_RANK,
} from './_shared';

const SEED_CACHE_KEY = 'cyber:threats:v2';

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = parseInt(cursor, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
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

export async function listCyberThreats(
  _ctx: ServerContext,
  req: ListCyberThreatsRequest,
): Promise<ListCyberThreatsResponse> {
  const empty: ListCyberThreatsResponse = { threats: [], pagination: { nextCursor: '', totalCount: 0 } };

  const cached = await readCachedJson(SEED_CACHE_KEY, true);
  if (cached.status === 'error') logCacheReadError(SEED_CACHE_KEY, cached.error);
  const seedData = cached.status === 'hit' ? cached.value as Pick<ListCyberThreatsResponse, 'threats'> | null : null;
  if (!seedData || !Array.isArray(seedData.threats)) {
    throw new ApiError(503, 'Cyber threats cache unavailable', '');
  }

  const pageSize = clampInt(req.pageSize, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = parseCursor(req.cursor);

  const allThreats = filterSeededThreats(seedData.threats, req);
  if (offset >= allThreats.length) return empty;
  const page = allThreats.slice(offset, offset + pageSize);
  const hasMore = offset + pageSize < allThreats.length;
  return {
    threats: page,
    pagination: { totalCount: allThreats.length, nextCursor: hasMore ? String(offset + pageSize) : '' },
  };
}
