import { OrbitalServiceClient } from '@/services/generated-rpc-clients';
import { createLazyClient, getRpcBaseUrl } from '@/services/rpc-client';
import { toOrbitalCatalog, type OrbitalCatalog } from './catalog-shape';

const CATALOG_TTL_MS = 30 * 60_000;

const getOrbitalClient = createLazyClient(() => new OrbitalServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) }));

let cached: { promise: Promise<OrbitalCatalog>; loadedAt: number } | null = null;

export function loadOrbitalCatalog(nowMs = Date.now()): Promise<OrbitalCatalog> {
  if (cached && nowMs - cached.loadedAt < CATALOG_TTL_MS) return cached.promise;
  const entry = {
    loadedAt: nowMs,
    promise: getOrbitalClient().listImagingSatellites({}).then(toOrbitalCatalog),
  };
  entry.promise.catch(() => {
    if (cached === entry) cached = null;
  });
  cached = entry;
  return entry.promise;
}
