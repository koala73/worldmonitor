import type {
  InfrastructureServiceHandler,
  ServerContext,
  GetBootstrapDataRequest,
  GetBootstrapDataResponse,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { BOOTSTRAP_CACHE_KEYS, BOOTSTRAP_TIERS } from '../../../_shared/cache-keys';
import { getCachedJsonBatch } from '../../../_shared/redis';

// Iran-events domain sunset (war ended 2026-07). Default OFF: this RPC bootstrap
// surface must also stop shipping iranEvents, mirroring api/bootstrap.js. It
// reads the SHARED BOOTSTRAP_CACHE_KEYS, so the gate lives here. Set
// IRAN_EVENTS_ENABLED=true to restore. See api/health.js.
const IRAN_EVENTS_ENABLED = (process.env.IRAN_EVENTS_ENABLED ?? 'false').toLowerCase() === 'true';

function buildRegistry(req: GetBootstrapDataRequest): Record<string, string> {
  let registry: Record<string, string>;
  if (req.tier === 'slow' || req.tier === 'fast') {
    registry = Object.fromEntries(
      Object.entries(BOOTSTRAP_CACHE_KEYS).filter(([key]) => BOOTSTRAP_TIERS[key] === req.tier),
    );
  } else if (req.keys.length > 0) {
    registry = Object.fromEntries(
      Object.entries(BOOTSTRAP_CACHE_KEYS).filter(([key]) => req.keys.includes(key)),
    );
  } else {
    // Copy so the sunset delete below never mutates the shared registry.
    registry = { ...BOOTSTRAP_CACHE_KEYS };
  }

  if (!IRAN_EVENTS_ENABLED) delete registry.iranEvents;
  return registry;
}

/**
 * GetBootstrapData performs bulk Redis key retrieval for initial app state.
 */
export const getBootstrapData: InfrastructureServiceHandler['getBootstrapData'] = async (
  _ctx: ServerContext,
  req: GetBootstrapDataRequest,
): Promise<GetBootstrapDataResponse> => {
  const registry = buildRegistry(req);

  const names = Object.keys(registry);
  const cacheKeys = Object.values(registry);

  try {
    const cached = await getCachedJsonBatch(cacheKeys);
    const data: Record<string, string> = {};
    const missing: string[] = [];

    for (let i = 0; i < names.length; i += 1) {
      const keyName = names[i]!;
      const cacheKey = cacheKeys[i]!;
      const value = cached.get(cacheKey);
      if (value === undefined) {
        missing.push(keyName);
        continue;
      }
      data[keyName] = JSON.stringify(value);
    }

    return { data, missing };
  } catch {
    return { data: {}, missing: names };
  }
};
