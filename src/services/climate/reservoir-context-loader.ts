import { ORBITAL_WATCH_ENABLED } from '@/config/orbital-watch-flag';
import { loadOrbitalCatalog } from '@/services/orbital/catalog';
import { ICESAT2_PROFILE_ID, reservoirNextPassExpiresAt, type ReservoirNextPass, type ReservoirPassSite } from '@/services/orbital/reservoir-next-pass';
import { getOrbitalPassClient } from '@/services/orbital/pass-client';
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
interface NextPassEntry {
  until: number;
  passes: Promise<Map<string, ReservoirNextPass> | null>;
  /** Callers still waiting on the shared scan; the scan is cancelled when the last one leaves. */
  waiting: number;
  work: AbortController;
}
let pending: NextPassEntry | null = null;

/**
 * Orbital pass geometry, so dark unless Orbital Watch is enabled. Null when dark or unavailable.
 * The scan runs off the main thread and is shared by callers for an hour. A caller whose signal aborts
 * gets null at once, and the scan stops when no caller is left waiting for it.
 */
export function loadReservoirNextPasses(sites: readonly ReservoirPassSite[], options: { signal?: AbortSignal } = {}): Promise<Map<string, ReservoirNextPass> | null> {
  const { signal } = options;
  if (!ORBITAL_WATCH_ENABLED || signal?.aborted) return Promise.resolve(null);
  if (!(pending && Date.now() < pending.until)) pending = startNextPassScan(sites);
  return awaitNextPasses(pending, signal);
}

function startNextPassScan(sites: readonly ReservoirPassSite[]): NextPassEntry {
  const entry: NextPassEntry = { until: Date.now() + NEXT_PASS_REUSE_MS, passes: Promise.resolve(null), waiting: 0, work: new AbortController() };
  const forget = () => { if (pending === entry) pending = null; return null; };
  entry.passes = loadOrbitalCatalog()
    .then(catalog => {
      const satellites = catalog.satellites.filter(sat => sat.profileId === ICESAT2_PROFILE_ID);
      return getOrbitalPassClient().reservoirNextPasses({ satellites, sites: [...sites], nowMs: Date.now() }, { signal: entry.work.signal });
    })
    .then(passes => {
      if (!passes) return forget();
      // Recompute once the earliest prediction has elapsed, so a past crossing is never shown as next.
      for (const pass of passes.values()) entry.until = Math.min(entry.until, reservoirNextPassExpiresAt(pass));
      return passes;
    })
    .catch(forget);
  return entry;
}

function awaitNextPasses(entry: NextPassEntry, signal: AbortSignal | undefined): Promise<Map<string, ReservoirNextPass> | null> {
  entry.waiting++;
  return new Promise((resolve) => {
    let settled = false;
    const leave = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      entry.waiting--;
    };
    const onAbort = () => {
      if (settled) return;
      leave();
      resolve(null);
      if (entry.waiting === 0) entry.work.abort();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    entry.passes.then((passes) => { if (!settled) { leave(); resolve(passes); } });
  });
}
