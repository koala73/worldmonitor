import type {
  GetChokepointDependenciesRequest,
  GetChokepointDependenciesResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import {
  mapChokepointDependency,
  type RawChokepointIndex,
  stringValue,
} from './_vulnerability-projection';

export const CHOKEPOINT_KEY = 'supply-chain:chokepoint-dependencies:v1';

export async function getChokepointDependencies(
  _ctx: ServerContext,
  req: GetChokepointDependenciesRequest,
): Promise<GetChokepointDependenciesResponse> {
  const chokepointId = (req.chokepointId || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,80}$/.test(chokepointId)) {
    throw new ValidationError([{ field: 'chokepointId', description: 'chokepointId must be a canonical chokepoint id' }]);
  }

  const payload = await getCachedJson(CHOKEPOINT_KEY, true).catch(() => null) as RawChokepointIndex | null;
  const chokepoint = payload?.chokepoints?.[chokepointId];
  const pageSize = Math.min(100, Math.max(1, req.pageSize || 25));
  return {
    chokepointId,
    chokepoint: stringValue(chokepoint?.name),
    dependencies: Array.isArray(chokepoint?.dependencies)
      ? chokepoint.dependencies.slice(0, pageSize).map(mapChokepointDependency)
      : [],
    generatedAt: stringValue(payload?.generatedAt),
    methodologyVersion: stringValue(payload?.methodologyVersion),
    upstreamUnavailable: payload == null,
  };
}
