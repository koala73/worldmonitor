import type {
  GetDefenseIndustrialBaseRequest,
  GetDefenseIndustrialBaseResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';
import {
  buildDefenseIndustrialResponse,
  type StoredIndustrialSnapshot,
  type StoredSupplierSnapshot,
} from '../../../../shared/defense-industrial-response';
import { readCachedJson } from '../../../_shared/redis';
import type { CacheReadResult } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const INDUSTRIAL_BASE_KEY = 'military:industrial-base:v1';
const ARMS_SUPPLIERS_KEY = 'military:arms-suppliers:v1';
type CacheReader = (key: string, raw?: boolean) => Promise<CacheReadResult>;

export async function getDefenseIndustrialBaseWithReader(
  ctx: ServerContext,
  req: GetDefenseIndustrialBaseRequest,
  reader: CacheReader,
): Promise<GetDefenseIndustrialBaseResponse> {
  const countryCode = String(req.countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return markNoStoreFallbackResponse(ctx.request, buildDefenseIndustrialResponse(countryCode, null, null));
  }
  try {
    const [industrialRead, dependenciesRead] = await Promise.all([
      reader(INDUSTRIAL_BASE_KEY, true),
      reader(ARMS_SUPPLIERS_KEY, true),
    ]);
    const industrial = industrialRead.status === 'hit'
      ? industrialRead.value as StoredIndustrialSnapshot
      : null;
    const dependencies = dependenciesRead.status === 'hit'
      ? dependenciesRead.value as StoredSupplierSnapshot
      : null;
    const response: GetDefenseIndustrialBaseResponse = buildDefenseIndustrialResponse(countryCode, industrial, dependencies);
    const cacheComplete = industrialRead.status === 'hit' && dependenciesRead.status === 'hit';
    return response.available && cacheComplete ? response : markNoStoreFallbackResponse(ctx.request, response);
  } catch {
    return markNoStoreFallbackResponse(ctx.request, buildDefenseIndustrialResponse(countryCode, null, null));
  }
}

export async function getDefenseIndustrialBase(
  ctx: ServerContext,
  req: GetDefenseIndustrialBaseRequest,
): Promise<GetDefenseIndustrialBaseResponse> {
  return getDefenseIndustrialBaseWithReader(ctx, req, readCachedJson);
}
