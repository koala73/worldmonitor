import type {
  GetChokepointDependenciesRequest,
  GetChokepointDependenciesResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { clampInt } from '../../../_shared/constants';
import { getCachedJson } from '../../../_shared/redis';
import {
  VULNERABILITY_COHORT_KEY,
  chokepointDependencyShardKey,
  isMatchingShard,
  mapChokepointDependency,
  type RawVulnerabilityCohort,
  type RawChokepointShard,
  stringValue,
  vulnerabilityShardSlot,
} from './_vulnerability-projection';

export async function getChokepointDependencies(
  _ctx: ServerContext,
  req: GetChokepointDependenciesRequest,
): Promise<GetChokepointDependenciesResponse> {
  const chokepointId = (req.chokepointId || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,80}$/.test(chokepointId)) {
    throw new ValidationError([{ field: 'chokepointId', description: 'chokepointId must be a canonical chokepoint id' }]);
  }

  const payload = await getCachedJson(VULNERABILITY_COHORT_KEY, true).catch(() => null) as RawVulnerabilityCohort | null;
  let chokepoint = payload?.chokepoints?.[chokepointId];
  let shardUnavailable = false;
  if (payload && !payload.chokepoints) {
    const slot = vulnerabilityShardSlot(payload.slot);
    const chokepointIds = Array.isArray(payload.chokepointIds)
      ? payload.chokepointIds.filter((id): id is string => typeof id === 'string')
      : null;
    if (slot === undefined || chokepointIds == null) {
      shardUnavailable = true;
    } else if (chokepointIds.includes(chokepointId)) {
      const shard = await getCachedJson(chokepointDependencyShardKey(slot, chokepointId), true)
        .catch(() => null) as RawChokepointShard | null;
      if (isMatchingShard(payload, shard)) chokepoint = shard?.chokepoint;
      else shardUnavailable = true;
    }
  }
  const pageSize = clampInt(req.pageSize, 25, 1, 100);
  return {
    chokepointId,
    chokepoint: stringValue(chokepoint?.name),
    dependencies: Array.isArray(chokepoint?.dependencies)
      ? chokepoint.dependencies.slice(0, pageSize).map(mapChokepointDependency)
      : [],
    generatedAt: stringValue(payload?.generatedAt),
    methodologyVersion: stringValue(payload?.methodologyVersion),
    upstreamUnavailable: payload == null || shardUnavailable,
  };
}
