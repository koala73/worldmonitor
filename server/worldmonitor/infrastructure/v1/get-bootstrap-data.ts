import {
  ApiError,
  type InfrastructureServiceHandler,
  type ServerContext,
  type GetBootstrapDataRequest,
  type GetBootstrapDataResponse,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { BOOTSTRAP_CACHE_KEYS, BOOTSTRAP_TIERS } from '../../../_shared/cache-keys';
// @ts-expect-error — Edge-safe JS helper
import { sanitizeBootstrapValue } from '../../../../api/_bootstrap-public-payload.js';
// @ts-expect-error — Edge-safe JS helper
import { extraCanadaAlertsCutoverReadKeys, canadaAlertsCutoverFallbackValue } from '../../../../api/_canada-alerts-cutover.js';
import { getCachedJsonBatch } from '../../../_shared/redis';

// Iran-events domain sunset (war ended 2026-07). Default OFF: this RPC bootstrap
// surface must also stop shipping iranEvents, mirroring api/bootstrap.js. It
// reads the SHARED BOOTSTRAP_CACHE_KEYS, so the gate lives here. Set
// IRAN_EVENTS_ENABLED=true to restore. See api/health.js.
const IRAN_EVENTS_ENABLED = (process.env.IRAN_EVENTS_ENABLED ?? 'false').toLowerCase() === 'true';

function buildRegistry(req: GetBootstrapDataRequest): Record<string, string> {
  if ((req.tier && req.keys.length > 0)
    || (req.tier && req.tier !== 'fast' && req.tier !== 'slow')
    || (!req.tier && (req.keys.length !== 1 || !Object.prototype.hasOwnProperty.call(BOOTSTRAP_CACHE_KEYS, req.keys[0]!)))) {
    throw new ApiError(400, 'Specify a fast/slow tier or one registered bootstrap key', '');
  }
  let registry: Record<string, string>;
  if (req.tier === 'slow' || req.tier === 'fast') {
    registry = Object.fromEntries(
      Object.entries(BOOTSTRAP_CACHE_KEYS).filter(([key]) => BOOTSTRAP_TIERS[key] === req.tier),
    );
  } else {
    registry = Object.fromEntries(
      Object.entries(BOOTSTRAP_CACHE_KEYS).filter(([key]) => req.keys.includes(key)),
    );
  }

  if (!IRAN_EVENTS_ENABLED) delete registry.iranEvents;
  return registry;
}

/**
 * Fetch one named dataset or a fixed public tier; never enumerate the full registry.
 */
export const getBootstrapData: InfrastructureServiceHandler['getBootstrapData'] = async (
  _ctx: ServerContext,
  req: GetBootstrapDataRequest,
): Promise<GetBootstrapDataResponse> => {
  const registry = buildRegistry(req);

  const names = Object.keys(registry);
  const cacheKeys = Object.values(registry);

  const readKeys = [...cacheKeys, ...extraCanadaAlertsCutoverReadKeys(cacheKeys, BOOTSTRAP_CACHE_KEYS.canadaAlerts)];
  try {
    const cached = await getCachedJsonBatch(readKeys, true);
    const data: Record<string, string> = {};
    const missing: string[] = [];

    for (let i = 0; i < names.length; i += 1) {
      const keyName = names[i]!;
      const cacheKey = cacheKeys[i]!;
      const value = keyName === 'canadaAlerts' && !cached.has(cacheKey)
        ? canadaAlertsCutoverFallbackValue(cached)
        : cached.get(cacheKey);
      if (value === undefined) {
        missing.push(keyName);
        continue;
      }
      data[keyName] = JSON.stringify(sanitizeBootstrapValue(keyName, value));
    }

    return { data, missing };
  } catch {
    return { data: {}, missing: names };
  }
};
