/**
 * ListCyberThreats RPC -- reads seeded cyber threat data from Railway seed cache.
 * All external IOC feed calls happen in seed-cyber.mjs on Railway.
 */

import type {
  ServerContext,
  ListCyberThreatsRequest,
  ListCyberThreatsResponse,
} from '../../../../src/generated/server/worldmonitor/cyber/v1/service_server';

import { readRequiredSeed } from '../../../_shared/required-seed';
import { isCyberThreatSnapshot } from '../../../../shared/cyber-threat-snapshot';
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
  const pageSize = req.pageSize <= 0 ? DEFAULT_LIMIT : clampInt(req.pageSize, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = parseCursor(req.cursor);

  const seedData = await readRequiredSeed(SEED_CACHE_KEY, value => isCyberThreatSnapshot(value) ? value : undefined);

  const allThreats = filterSeededThreats(seedData.threats, req);
  // Past the last page there is still a total, and the handler has just
  // counted it. Reporting 0 here would contradict every in-range page of the
  // same query and read as "nothing matched".
  if (offset >= allThreats.length) {
    return { threats: [], pagination: { nextCursor: '', totalCount: allThreats.length } };
  }
  const page = allThreats.slice(offset, offset + pageSize);
  const hasMore = offset + pageSize < allThreats.length;
  return {
    threats: page,
    pagination: { totalCount: allThreats.length, nextCursor: hasMore ? String(offset + pageSize) : '' },
  };
}
