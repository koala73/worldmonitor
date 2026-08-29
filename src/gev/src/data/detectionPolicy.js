/**
 * @module detectionPolicy
 * @description Pure detection density/profile and collective-budget helpers.
 * The five-stop UI, share links, voice actions, and renderer all use this
 * module so density cannot drift into contradictory mode semantics again.
 */

export const DENSITY_STOPS = Object.freeze([0, 25, 50, 75, 100]);
export const ALLOCATION_ELASTIC = 'ELASTIC';
export const ALLOCATION_WEIGHTED = 'WEIGHTED';
export const ALLOCATION_STRATEGIES = Object.freeze([ALLOCATION_ELASTIC, ALLOCATION_WEIGHTED]);

// The keyhole's default 1% outside opacity is appropriate for text, but it
// made side aircraft brackets effectively disappear while the same contacts
// remained eligible. AIR geometry therefore gets a readable floor, without
// changing label budgets.
//
// The floor is 0.35 AT THE DEFAULT OUTSIDE OPACITY, and it SCALES with the
// OUTSIDE slider rather than overriding it. A flat 0.35 made that slider a
// no-op for aircraft: dialling it down to 1% still painted brackets at 35%, so
// the control did nothing across a third of its travel while visibly working
// for labels. A setting that moves everything except the thing the operator is
// looking at is a broken control, not a safety net.
export const AIRCRAFT_BRACKET_ALPHA_FLOOR = 0.35;

/**
 * Mirror of celestialRing's KEYHOLE_OUTSIDE_OPACITY_DEFAULT — the OUTSIDE
 * setting the bracket look is calibrated at, so `AIRCRAFT_BRACKET_ALPHA_FLOOR`
 * lands EXACTLY at the shipped default. Mirrored rather than imported so this
 * stays a pure policy module with no Cesium dependency; detectionPolicy.test.mjs
 * imports the real constant and pins the two together so they cannot drift.
 *
 * It MOVES WITH THE DEFAULT (0.05 → 0.03 → 0.01; final value 2026-08-24).
 * That pin is the tripwire
 * for exactly this change, and the decision it forces is which of two things the
 * approval attaches to: the bracket BRIGHTNESS, or the slider POSITION. It is
 * the brightness — the floor exists so side aircraft brackets stay readable at
 * whatever the default is, and the owner's directive moved the label default,
 * not the bracket look. Holding the anchor at 0.05 instead would dim brackets to
 * 0.07 on a first run at the 1% default, which is the dead-zone complaint in
 * reverse.
 */
export const AIRCRAFT_BRACKET_FLOOR_ANCHOR = 0.01;

/**
 * The AIR bracket alpha floor for a given OUTSIDE opacity setting.
 *
 * Piecewise linear through three fixed points, chosen so the control is honest
 * across its whole travel while the shipped look does not move:
 *
 *   slider 0    → 0     off means off; the operator's zero stays authoritative
 *   slider 0.01 → 0.35  EXACTLY the shipped constant at the default, so the
 *                       approved look is reproduced unchanged (above the
 *                       anchor the floor rises smoothly — 0.05 ≈ 0.376)
 *   slider 1.0  → 1.0   the boost decays to nothing: at full opacity the floor
 *                       equals the label alpha and stops overriding at all
 *
 * Strictly increasing, so every step of the slider changes the picture and
 * there is no dead zone at either end — which was the whole complaint.
 *
 * A non-finite input falls back to the anchor: an unreadable setting should
 * reproduce the approved default, never silently blank the brackets.
 *
 * @param {number} outsideOpacity - Keyhole outside opacity, 0-1.
 * @returns {number} Alpha floor for AIR brackets, 0-1.
 */
export function aircraftBracketAlphaFloor(outsideOpacity) {
  const raw = Number(outsideOpacity);
  const outside = Number.isFinite(raw)
    ? Math.max(0, Math.min(1, raw))
    : AIRCRAFT_BRACKET_FLOOR_ANCHOR;
  if (outside <= 0) return 0;
  if (outside <= AIRCRAFT_BRACKET_FLOOR_ANCHOR) {
    return AIRCRAFT_BRACKET_ALPHA_FLOOR * (outside / AIRCRAFT_BRACKET_FLOOR_ANCHOR);
  }
  const progress = (outside - AIRCRAFT_BRACKET_FLOOR_ANCHOR) / (1 - AIRCRAFT_BRACKET_FLOOR_ANCHOR);
  return AIRCRAFT_BRACKET_ALPHA_FLOOR + (1 - AIRCRAFT_BRACKET_ALPHA_FLOOR) * progress;
}

/**
 * Resolve the paint alpha for a detection bracket without altering admission.
 * @param {string} type - Detection object type; only AIR is floored.
 * @param {number} keyholeAlpha - Radial keyhole alpha for this contact.
 * @param {number} [outsideOpacity] - Live OUTSIDE slider value. Omitted means
 *   the default, so a caller that does not know it reproduces the shipped look.
 * @returns {number} Paint alpha, 0-1.
 */
export function detectionBracketAlpha(type, keyholeAlpha, outsideOpacity = AIRCRAFT_BRACKET_FLOOR_ANCHOR) {
  const alpha = Math.max(0, Math.min(1, Number(keyholeAlpha) || 0));
  if (String(type || '').toUpperCase() !== 'AIR' || alpha <= 0) return alpha;
  return Math.max(aircraftBracketAlphaFloor(outsideOpacity), alpha);
}

/** Stable left/front/right bucket for bracket coverage diagnostics and QA. */
export function detectionHorizontalSector(screenX, viewportWidth) {
  const width = Number(viewportWidth);
  const x = Number(screenX);
  if (!(width > 0) || !Number.isFinite(x)) return 'front';
  if (x < width / 3) return 'left';
  if (x > width * 2 / 3) return 'right';
  return 'front';
}

export const VIEW_SCALE_BUDGETS = Object.freeze({
  street: Object.freeze({ 0: 9, 25: 23, 50: 45, 75: 68, 100: 90 }),
  city: Object.freeze({ 0: 7, 25: 18, 50: 35, 75: 53, 100: 70 }),
  metro: Object.freeze({ 0: 6, 25: 14, 50: 28, 75: 41, 100: 55 }),
  regional: Object.freeze({ 0: 4, 25: 10, 50: 20, 75: 30, 100: 40 }),
  // Full-globe views leave substantial radial screen space around the Earth.
  // Dense satellite fields can use that space without card overlap, so the
  // global row intentionally has a larger ceiling than the regional row.
  global: Object.freeze({ 0: 6, 25: 14, 50: 28, 75: 42, 100: 56 }),
});

/** Clamp and canonicalize arbitrary input onto the five approved density stops. */
export function canonicalizeDensity(inputPct, fallback = 50) {
  const raw = Number(inputPct);
  if (!Number.isFinite(raw)) return canonicalizeDensity(fallback, 50);
  const pct = Math.max(0, Math.min(100, raw));
  if (pct <= 25) return pct < 12.5 ? 0 : 25;
  if (pct < 75) return 50;
  return pct < 87.5 ? 75 : 100;
}

/** Derive the only valid enabled profile from a canonical density stop. */
export function profileForDensity(inputPct) {
  const stop = canonicalizeDensity(inputPct);
  if (stop <= 25) return 'SPARSE';
  if (stop >= 75) return 'DENSE';
  return 'BALANCED';
}

/** Return the canonical default stop for an enabled profile or legacy alias. */
export function defaultDensityForProfile(profile) {
  const normalized = normalizeProfile(profile);
  if (normalized === 'SPARSE') return 25;
  if (normalized === 'DENSE') return 75;
  return 50;
}

/** Normalize current and legacy profile labels. OFF remains an enabled-state value. */
export function normalizeProfile(profile) {
  const raw = String(profile || '').trim().toUpperCase();
  if (raw === 'OFF') return 'OFF';
  if (raw === 'SPARSE' || raw === 'SURVEY') return 'SPARSE';
  if (raw === 'BALANCED' || raw === 'NORMAL') return 'BALANCED';
  if (raw === 'DENSE' || raw === 'PANOPTIC' || raw === 'GOD' || raw === 'ON') return 'DENSE';
  return null;
}

/** Normalize the user-selectable layer allocation strategy. */
export function normalizeAllocationStrategy(strategy, fallback = ALLOCATION_ELASTIC) {
  const raw = String(strategy || '').trim().toUpperCase();
  if (ALLOCATION_STRATEGIES.includes(raw)) return raw;
  const normalizedFallback = String(fallback || '').trim().toUpperCase();
  return ALLOCATION_STRATEGIES.includes(normalizedFallback)
    ? normalizedFallback
    : ALLOCATION_ELASTIC;
}

/** Classify camera altitude into the shared label-budget view scale. */
export function viewScaleForAltitude(altitudeM) {
  const altitude = Number.isFinite(Number(altitudeM)) ? Math.max(0, Number(altitudeM)) : 1e9;
  if (altitude < 1200) return 'street';
  if (altitude < 4500) return 'city';
  if (altitude < 20000) return 'metro';
  if (altitude < 150000) return 'regional';
  return 'global';
}

/** Resolve the collective text-callout cap for an altitude and density stop. */
export function labelBudgetFor(altitudeM, densityPct) {
  const scale = viewScaleForAltitude(altitudeM);
  const stop = canonicalizeDensity(densityPct);
  return VIEW_SCALE_BUDGETS[scale][stop];
}

/**
 * Migrate a persisted/legacy mode+density pair into one canonical state.
 * Legacy Panoptic/God intent resolves to Dense even when its historical
 * density was below 75; legacy Sparse remains inside the Sparse band.
 */
export function migrateDetectionState(mode, densityPct, fallbackDensity = 50) {
  const rawMode = String(mode || '').trim().toUpperCase();
  const normalized = normalizeProfile(rawMode);
  if (normalized === 'OFF') {
    const supplied = Number.isFinite(Number(densityPct)) ? densityPct : fallbackDensity;
    const stop = canonicalizeDensity(supplied, fallbackDensity);
    return { enabled: false, profile: profileForDensity(stop), densityPct: stop };
  }
  if (rawMode === 'PANOPTIC' || rawMode === 'GOD' || rawMode === 'ON') {
    const density = Number.isFinite(Number(densityPct)) ? Math.max(75, Number(densityPct)) : 75;
    return { enabled: true, profile: 'DENSE', densityPct: canonicalizeDensity(density) };
  }
  if (rawMode === 'SPARSE' || rawMode === 'SURVEY') {
    const density = Number.isFinite(Number(densityPct)) ? Math.min(25, Number(densityPct)) : 25;
    const stop = canonicalizeDensity(density, 25);
    return { enabled: true, profile: 'SPARSE', densityPct: stop };
  }
  if (normalized === 'BALANCED' || normalized === 'DENSE') {
    const supplied = Number.isFinite(Number(densityPct)) ? canonicalizeDensity(densityPct) : defaultDensityForProfile(normalized);
    const stop = profileForDensity(supplied) === normalized ? supplied : defaultDensityForProfile(normalized);
    return { enabled: true, profile: normalized, densityPct: stop };
  }
  const stop = canonicalizeDensity(densityPct, fallbackDensity);
  return { enabled: true, profile: profileForDensity(stop), densityPct: stop };
}
