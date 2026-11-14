const OPEN = ['open-optical', 'open-radar'];
const COMMERCIAL = ['commercial-optical', 'commercial-radar'];

// The tier decision table, read top to bottom; the first matching row wins.
// `needs` lists the geometry facts that must all hold; `archive` is the
// archive state the row requires ('any' when it does not look).
const TIER_TABLE = [
  { categories: ['military'], needs: ['inFootprint'], archive: 'any', tier: { kind: 'capability-overhead' } },
  { categories: OPEN, needs: ['inFootprint', 'daylight', 'coverage'], archive: 'not-in-archive', tier: { kind: 'passed-overhead', note: 'not-in-archive' } },
  { categories: OPEN, needs: ['inFootprint', 'daylight', 'coverage'], archive: 'pending', tier: { kind: 'likely-imaged' } },
  { categories: ['weather-polar'], needs: ['inFootprint', 'dailyMosaic'], archive: 'any', tier: { kind: 'daily-mosaic' } },
  { categories: COMMERCIAL, needs: ['inFootprint', 'daylight'], archive: 'any', tier: { kind: 'within-reach' } },
  { categories: ['crewed-station'], needs: ['inFootprint'], archive: 'any', tier: { kind: 'passed-overhead' } },
];

export const OPTICAL_MIN_SUN_ELEVATION_DEG = 5;
const HOUR_MS = 3_600_000;

function passFacts(pass, profile) {
  const optical = profile.category === 'open-optical' || profile.category === 'commercial-optical';
  return {
    inFootprint: pass.inFootprint,
    daylight: !optical || pass.sunElevationDeg >= OPTICAL_MIN_SUN_ELEVATION_DEG,
    coverage: pass.coverage,
    dailyMosaic: profile.dailyMosaic === true,
  };
}

function archiveState(pass, profile, archive, nowMs) {
  if (archive?.status === 'match') return 'match';
  const waitMs = (profile.archiveWaitHours ?? 0) * HOUR_MS;
  if (archive?.status === 'no-match' && nowMs - pass.timeMs >= waitMs) return 'not-in-archive';
  return 'pending';
}

export function decidePassTier(pass, profile, archive, now) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (pass.timeMs > nowMs) return { kind: 'opportunity' };
  const facts = passFacts(pass, profile);
  const state = archiveState(pass, profile, archive, nowMs);
  // The archive holding the scene outranks the modelled geometry: a match is an
  // image, and a disagreeing model is noted rather than allowed to hide it.
  if (state === 'match' && OPEN.includes(profile.category)) {
    const agreed = facts.inFootprint && facts.daylight && facts.coverage;
    return agreed ? { kind: 'confirmed-image' } : { kind: 'confirmed-image', note: 'geometry-disagreed' };
  }
  const row = TIER_TABLE.find((candidate) =>
    candidate.categories.includes(profile.category) &&
    candidate.needs.every((fact) => facts[fact]) &&
    (candidate.archive === 'any' || candidate.archive === state));
  return row ? { ...row.tier } : { kind: 'passed-overhead' };
}
