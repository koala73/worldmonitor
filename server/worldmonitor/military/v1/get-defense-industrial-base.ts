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
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const INDUSTRIAL_BASE_KEY = 'military:industrial-base:v1';
const ARMS_SUPPLIERS_KEY = 'military:arms-suppliers:v1';

export async function getDefenseIndustrialBase(
  ctx: ServerContext,
  req: GetDefenseIndustrialBaseRequest,
): Promise<GetDefenseIndustrialBaseResponse> {
  const countryCode = String(req.countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return markNoStoreFallbackResponse(ctx.request, buildDefenseIndustrialResponse(countryCode, null, null));
  }
  try {
    const [industrialRead, dependenciesRead] = await Promise.all([
      readCachedJson(INDUSTRIAL_BASE_KEY, true),
      readCachedJson(ARMS_SUPPLIERS_KEY, true),
    ]);
    const industrial = industrialRead.status === 'hit'
      ? industrialRead.value as StoredIndustrialSnapshot
      : null;
    const dependencies = dependenciesRead.status === 'hit'
      ? dependenciesRead.value as StoredSupplierSnapshot
      : null;
    const response: GetDefenseIndustrialBaseResponse = buildDefenseIndustrialResponse(countryCode, industrial, dependencies);
    const readFailed = industrialRead.status === 'error' || dependenciesRead.status === 'error';
    return response.available && !readFailed ? response : markNoStoreFallbackResponse(ctx.request, response);
  } catch {
    return markNoStoreFallbackResponse(ctx.request, buildDefenseIndustrialResponse(countryCode, null, null));
  }
}
