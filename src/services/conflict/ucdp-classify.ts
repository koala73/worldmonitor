import type { UcdpViolenceEvent as ProtoUcdpEvent } from '@/generated/client/worldmonitor/conflict/v1/service_client';

export type ConflictIntensity = 'none' | 'minor' | 'war';

export interface UcdpConflictStatus {
  location: string;
  intensity: ConflictIntensity;
  year: number;
  sideA?: string;
  sideB?: string;
}

// Leaf module by design: it imports nothing at runtime, so tests can load it
// without Vite's import.meta.env. scripts/_ucdp-dashboard.mjs mirrors
// deriveUcdpClassifications (it cannot import from src/ — Railway builds seeders
// from a scripts-only Nixpacks root, #5268) and
// tests/ucdp-dashboard-projection.test.mts pins the two implementations equal.

function isRecentUcdpClassificationDate(dateStart: unknown, now: number, windowMs: number): boolean {
  const eventMs = Number(dateStart);
  return Number.isFinite(eventMs)
    && Number.isFinite(now)
    && eventMs <= now
    && now - eventMs < windowMs;
}

// Exported for tests/ucdp-dashboard-projection.test.mts: scripts/_ucdp-dashboard.mjs
// carries a mirror of this function (it cannot import from src/ — Railway builds
// seeders from a scripts-only root, #5268), and the parity test pins them equal.
export function deriveUcdpClassifications(events: ProtoUcdpEvent[], now = Date.now()): Map<string, UcdpConflictStatus> {
  const byCountry = new Map<string, ProtoUcdpEvent[]>();
  for (const e of events) {
    const country = e.country;
    if (!byCountry.has(country)) byCountry.set(country, []);
    byCountry.get(country)!.push(e);
  }

  const twoYearsMs = 2 * 365 * 24 * 60 * 60 * 1000;
  const result = new Map<string, UcdpConflictStatus>();

  for (const [country, countryEvents] of byCountry) {
    // Filter to trailing 2-year window
    const recentEvents = countryEvents.filter(e => isRecentUcdpClassificationDate(e.dateStart, now, twoYearsMs));
    const totalDeaths = recentEvents.reduce((sum, e) => sum + e.deathsBest, 0);
    const eventCount = recentEvents.length;

    let intensity: ConflictIntensity;
    if (totalDeaths > 1000 || eventCount > 100) {
      intensity = 'war';
    } else if (eventCount > 10) {
      intensity = 'minor';
    } else {
      intensity = 'none';
    }

    // Find the highest-death event for sideA/sideB
    let maxDeathEvent: ProtoUcdpEvent | undefined;
    for (const e of recentEvents) {
      if (!maxDeathEvent || e.deathsBest > maxDeathEvent.deathsBest) {
        maxDeathEvent = e;
      }
    }

    // Most recent event year
    const mostRecentEvent = recentEvents.reduce<ProtoUcdpEvent | undefined>(
      (latest, e) => (!latest || e.dateStart > latest.dateStart) ? e : latest,
      undefined,
    );
    const year = mostRecentEvent ? new Date(mostRecentEvent.dateStart).getFullYear() : new Date(now).getFullYear();

    result.set(country, {
      location: country,
      intensity,
      year,
      sideA: maxDeathEvent?.sideA,
      sideB: maxDeathEvent?.sideB,
    });
  }

  return result;
}
