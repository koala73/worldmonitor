import { twoline2satrec } from 'satellite.js';
import { findPasses, type OrbitElements, type Pass } from '../../../shared/orbital/pass-geometry.js';
import { matchSensorProfile, type SensorCategory, type SensorProfile } from '../../../shared/orbital/sensor-profiles.js';
import { decidePassTier, OPTICAL_MIN_SUN_ELEVATION_DEG, type PassTier } from '../../../shared/orbital/tiers.js';
import type { WatchedSite } from '../../../shared/watched-sites';
import { classifyYaogan } from './yaogan-class';

export const COVERAGE_WINDOW_HOURS = 24;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const YIELD_EVERY_SITES = 60;

/** One element set of a tracked satellite, as the map layer loads it. */
export interface TrackedSatelliteTle {
  noradId: string;
  name: string;
  line1: string;
  line2: string;
}

export type CoverageSite = Pick<WatchedSite, 'id' | 'name' | 'lat' | 'lon' | 'countryCode'>;

export interface CoveragePass {
  timeMs: number;
  groundDistanceKm: number;
  edgeOfSwath: boolean;
  direction: Pass['direction'];
  tier: PassTier['kind'];
}

export interface SiteCoverage {
  site: CoverageSite;
  /** Closest approaches inside the modelled footprint, earliest first. */
  passes: CoveragePass[];
}

/** The sensor a satellite's coverage was modelled with. */
export interface CoverageSensor {
  profileId: string;
  family: string;
  category: SensorCategory;
}

export type SatelliteCoverage =
  | { status: 'ok'; sensor: CoverageSensor; windowStartMs: number; windowEndMs: number; orbitAgeDays: number; sites: SiteCoverage[] }
  /** A Yaogan signals-intelligence object: no imager, so no site coverage. */
  | { status: 'signals' }
  /** An unidentified Yaogan object: left out everywhere. */
  | { status: 'excluded' }
  /** No sensor profile matches, so there is no footprint to model. */
  | { status: 'no-profile' }
  | { status: 'geostationary'; sensor: CoverageSensor }
  | { status: 'too-old'; orbitAgeDays: number }
  | { status: 'bad-elements' };

/** Epoch and mean motion straight from the TLE columns, with the SGP4 record satellite.js builds. */
export function orbitElementsFromTle(tle: TrackedSatelliteTle): OrbitElements | null {
  const line1 = tle.line1.trim();
  const line2 = tle.line2.trim();
  if (line1.length < 63 || line2.length < 63) return null;
  const yy = Number(line1.slice(18, 20));
  const dayOfYear = Number(line1.slice(20, 32));
  const meanMotionRevPerDay = Number(line2.slice(52, 63));
  const noradId = Number(tle.noradId);
  if (![yy, dayOfYear, meanMotionRevPerDay, noradId].every(Number.isFinite) || meanMotionRevPerDay <= 0) return null;
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const epochMs = Date.UTC(year, 0, 1) + (dayOfYear - 1) * DAY_MS;
  let satrec;
  try {
    satrec = twoline2satrec(line1, line2);
  } catch {
    return null;
  }
  if (!satrec || satrec.error) return null;
  return { noradId, name: tle.name, epochMs, meanMotionRevPerDay, satrec };
}

/** The imaging sensor profile for a tracked object; Yaogan signals and unidentified objects never get one. */
export function imagingProfileFor(tle: Pick<TrackedSatelliteTle, 'noradId' | 'name'>): SensorProfile | null {
  const yaogan = classifyYaogan(tle.name);
  if (yaogan === 'signals' || yaogan === 'unidentified') return null;
  return matchSensorProfile(tle.noradId, tle.name);
}

function covers(pass: Pass, profile: SensorProfile): boolean {
  if (!pass.inFootprint) return false;
  if (profile.category === 'military') return true;
  return pass.coverage && (!profile.daylight || pass.sunElevationDeg >= OPTICAL_MIN_SUN_ELEVATION_DEG);
}

const sensorOf = (profile: SensorProfile): CoverageSensor => ({ profileId: profile.id, family: profile.family, category: profile.category });
const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The watched sites a tracked satellite's modelled footprint covers between `nowMs`
 * and `hours` later. Runs on the client from the layer's element set and the public
 * site registry; no point leaves the browser.
 */
export async function sitesCoveredBySatellite(input: {
  tle: TrackedSatelliteTle;
  sites: readonly CoverageSite[];
  nowMs: number;
  hours?: number;
  signal?: AbortSignal;
}): Promise<SatelliteCoverage> {
  const yaogan = classifyYaogan(input.tle.name);
  if (yaogan === 'signals') return { status: 'signals' };
  if (yaogan === 'unidentified') return { status: 'excluded' };
  const profile = imagingProfileFor(input.tle);
  if (!profile) return { status: 'no-profile' };
  const elements = orbitElementsFromTle(input.tle);
  if (!elements) return { status: 'bad-elements' };

  const windowStartMs = input.nowMs;
  const windowEndMs = input.nowMs + (input.hours ?? COVERAGE_WINDOW_HOURS) * HOUR_MS;
  const window = { start: windowStartMs, end: windowEndMs };
  const orbitAgeDays = (input.nowMs - elements.epochMs) / DAY_MS;
  const sites: SiteCoverage[] = [];

  for (let i = 0; i < input.sites.length; i++) {
    if (i > 0 && i % YIELD_EVERY_SITES === 0) {
      await nextTick();
      if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    }
    const site = input.sites[i]!;
    let result;
    try {
      result = findPasses({ elements, profile, point: { lat: site.lat, lon: site.lon }, window, now: input.nowMs });
    } catch {
      return { status: 'too-old', orbitAgeDays };
    }
    if (result.status === 'too-old') return { status: 'too-old', orbitAgeDays: result.ageDays };
    if (result.status === 'geostationary') return { status: 'geostationary', sensor: sensorOf(profile) };
    const passes = result.passes
      .filter((pass) => covers(pass, profile))
      .map((pass) => ({
        timeMs: pass.timeMs,
        groundDistanceKm: pass.groundDistanceKm,
        edgeOfSwath: pass.edgeOfSwath,
        direction: pass.direction,
        tier: decidePassTier(pass, profile, null, input.nowMs).kind,
      }))
      .sort((a, b) => a.timeMs - b.timeMs);
    if (passes.length) sites.push({ site: { id: site.id, name: site.name, lat: site.lat, lon: site.lon, countryCode: site.countryCode }, passes });
  }

  sites.sort((a, b) => a.passes[0]!.timeMs - b.passes[0]!.timeMs || a.site.name.localeCompare(b.site.name));
  return { status: 'ok', sensor: sensorOf(profile), windowStartMs, windowEndMs, orbitAgeDays, sites };
}

export interface SatelliteOverSite {
  noradId: string;
  name: string;
  sensor: CoverageSensor;
  passes: CoveragePass[];
}

/**
 * The reverse view, for a site's evidence sheet: which tracked imaging satellites
 * cover one watched site in the window. Not wired to any sheet yet.
 */
export async function satellitesCoveringSite(input: {
  site: CoverageSite;
  tles: readonly TrackedSatelliteTle[];
  nowMs: number;
  hours?: number;
}): Promise<SatelliteOverSite[]> {
  const out: SatelliteOverSite[] = [];
  for (const tle of input.tles) {
    const coverage = await sitesCoveredBySatellite({ tle, sites: [input.site], nowMs: input.nowMs, hours: input.hours });
    if (coverage.status !== 'ok' || !coverage.sites.length) continue;
    out.push({ noradId: tle.noradId, name: tle.name, sensor: coverage.sensor, passes: coverage.sites[0]!.passes });
  }
  return out.sort((a, b) => a.passes[0]!.timeMs - b.passes[0]!.timeMs);
}

let watchedSites: Promise<CoverageSite[]> | null = null;

/** The public watched-site registry, loaded once on first use. */
export function loadWatchedSites(): Promise<CoverageSite[]> {
  watchedSites ??= import('../../../shared/watched-sites').then(({ composeWatchedSites }) => composeWatchedSites());
  return watchedSites;
}
