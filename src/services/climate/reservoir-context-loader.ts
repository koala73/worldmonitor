import { ORBITAL_WATCH_ENABLED } from '@/config/orbital-watch-flag';
import { loadOrbitalCatalog } from '@/services/orbital/catalog';
import { computeReservoirNextPasses, reservoirNextPassExpiresAt, type ReservoirNextPass, type ReservoirPassSite } from '@/services/orbital/reservoir-next-pass';
import type { ReservoirLevel } from './reservoir-levels';
import { fetchReservoirLevels } from './index';

let levels: Promise<Map<string, ReservoirLevel>> | null = null;

/** Seeded Strategic Water Levels by reservoir id, fetched once per page. Empty when unavailable. */
export function loadReservoirLevelsById(): Promise<Map<string, ReservoirLevel>> {
  levels ??= fetchReservoirLevels()
    .then(result => new Map((result.snapshot?.reservoirs ?? []).map(r => [r.id, r])))
    .then(map => { if (map.size === 0) levels = null; return map; }, () => { levels = null; return new Map(); });
  return levels;
}

const NEXT_PASS_REUSE_MS = 60 * 60 * 1000;
let pending: { until: number; passes: Promise<Map<string, ReservoirNextPass> | null> } | null = null;

/** Orbital pass geometry, so dark unless Orbital Watch is enabled. Null when dark or unavailable. */
export function loadReservoirNextPasses(sites: readonly ReservoirPassSite[]): Promise<Map<string, ReservoirNextPass> | null> {
  if (!ORBITAL_WATCH_ENABLED) return Promise.resolve(null);
  if (pending && Date.now() < pending.until) return pending.passes;
  const entry = { until: Date.now() + NEXT_PASS_REUSE_MS, passes: Promise.resolve<Map<string, ReservoirNextPass> | null>(null) };
  const forget = () => { if (pending === entry) pending = null; return null; };
  entry.passes = loadOrbitalCatalog()
    .then(catalog => {
      const passes = computeReservoirNextPasses(catalog, sites);
      if (!passes) return forget();
      // Recompute once the earliest prediction has elapsed, so a past crossing is never shown as next.
      for (const pass of passes.values()) entry.until = Math.min(entry.until, reservoirNextPassExpiresAt(pass));
      return passes;
    })
    .catch(forget);
  pending = entry;
  return entry.passes;
}
