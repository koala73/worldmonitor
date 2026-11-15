import { twoline2satrec } from 'satellite.js';
import { findPasses, ORBIT_ELEMENTS_MAX_AGE_DAYS, type OrbitElements, type Pass } from '../../../shared/orbital/pass-geometry.js';
import { matchSensorProfile, type SensorCategory, type SensorProfile } from '../../../shared/orbital/sensor-profiles.js';
import { decidePassTier, OPTICAL_MIN_SUN_ELEVATION_DEG, type PassTier } from '../../../shared/orbital/tiers.js';
import type { WatchedSite } from '../../../shared/watched-sites';
import { BoundedCache, shareWork, type SharedWork } from './request-cache';
import { classifyYaogan } from './yaogan-class';

export const COVERAGE_WINDOW_HOURS = 24;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const YIELD_AFTER_MS = 8;

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
  | { status: 'bad-elements' }
  /** The pass geometry rejected the elements (for example an epoch far after now); nothing is listed. */
  | { status: 'unavailable' };

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
  if (profile.daylight && pass.sunElevationDeg < OPTICAL_MIN_SUN_ELEVATION_DEG) return false;
  return profile.category === 'military' || pass.coverage;
}

const sensorOf = (profile: SensorProfile): CoverageSensor => ({ profileId: profile.id, family: profile.family, category: profile.category });
const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The watched sites a tracked satellite's modelled footprint covers between `nowMs`
 * and `hours` later. Runs on the client from the layer's element set and the public
 * site registry; no point leaves the browser.
 */
async function computeCoverage(input: {
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

  let sliceStart = performance.now();
  for (let i = 0; i < input.sites.length; i++) {
    if (performance.now() - sliceStart > YIELD_AFTER_MS) {
      await nextTick();
      if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      sliceStart = performance.now();
    }
    const site = input.sites[i]!;
    let result;
    try {
      result = findPasses({ elements, profile, point: { lat: site.lat, lon: site.lon }, window, now: input.nowMs });
    } catch {
      return { status: 'unavailable' };
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

let watchedSites: Promise<CoverageSite[]> | null = null;

/** The public watched-site registry, loaded once on first use. */
export function loadWatchedSites(): Promise<CoverageSite[]> {
  watchedSites ??= import('../../../shared/watched-sites')
    .then(({ composeWatchedSites }) => composeWatchedSites())
    .catch((err: unknown) => {
      watchedSites = null;
      throw err;
    });
  return watchedSites;
}

/** A card shows a scan until its 24-hour window has slid this far, then scans again. */
export const COVERAGE_RENEW_MS = HOUR_MS;

interface CoverageEntry { windowStartMs: number; work: SharedWork<SatelliteCoverage> }
/** Completed scans by registry, then by satellite, element set and window length. Browser memory only. */
const coverageCaches = new WeakMap<readonly CoverageSite[], BoundedCache<CoverageEntry>>();

/** Drops passes already behind `nowMs`, keeping the earliest-next-pass order. */
export function coverageAt(coverage: SatelliteCoverage, nowMs: number): SatelliteCoverage {
  if (coverage.status !== 'ok') return coverage;
  const sites = coverage.sites
    .map((entry) => ({ site: entry.site, passes: entry.passes.filter((p) => p.timeMs > nowMs) }))
    .filter((entry) => entry.passes.length > 0)
    .sort((a, b) => a.passes[0]!.timeMs - b.passes[0]!.timeMs || a.site.name.localeCompare(b.site.name));
  return { ...coverage, sites };
}

/**
 * The watched sites a satellite covers over the window starting at `nowMs`.
 * A scan of the same satellite, element set and registry whose window started
 * less than `COVERAGE_RENEW_MS` ago answers instead, with passes already behind
 * dropped; once the window slides that far the satellite is scanned again.
 * A consumer that aborts never cancels a scan another consumer still waits on.
 */
export async function sitesCoveredBySatellite(input: {
  tle: TrackedSatelliteTle;
  sites: readonly CoverageSite[];
  nowMs: number;
  hours?: number;
  signal?: AbortSignal;
}): Promise<SatelliteCoverage> {
  input.signal?.throwIfAborted();
  let cache = coverageCaches.get(input.sites);
  if (!cache) coverageCaches.set(input.sites, cache = new BoundedCache<CoverageEntry>(16));
  const hours = input.hours ?? COVERAGE_WINDOW_HOURS;
  const key = `${input.tle.noradId}|${input.tle.name}|${input.tle.line1}|${input.tle.line2}|${hours}`;
  const elements = orbitElementsFromTle(input.tle);
  const elementsTooOld = !!elements && input.nowMs - elements.epochMs > ORBIT_ELEMENTS_MAX_AGE_DAYS * DAY_MS;
  let entry = cache.get(key, input.nowMs);
  if (!entry || entry.work.abandoned || elementsTooOld || input.nowMs < entry.windowStartMs) {
    const { tle, sites, nowMs } = input;
    const created: CoverageEntry = { windowStartMs: nowMs, work: shareWork((signal) => computeCoverage({ tle, sites, nowMs, hours, signal })) };
    const owner = cache;
    owner.set(key, created, nowMs + COVERAGE_RENEW_MS);
    const forget = () => owner.delete(key, created);
    created.work.done.then((coverage) => { if (coverage.status === 'unavailable') forget(); }, forget);
    entry = created;
  }
  const coverage = await entry.work.join(input.signal, () => { throw new DOMException('Aborted', 'AbortError'); });
  return coverageAt(coverage, input.nowMs);
}

/** Half a 0.01° grid cell: a looked-up point this close to a site's coordinates is that site. */
const SITE_MATCH_DEG = 0.005;

/** The watched site at a looked-up point, nearest first; matched in the browser, so the point never leaves it. */
export function watchedSiteAt(point: { lat: number; lon: number }, sites: readonly CoverageSite[]): CoverageSite | null {
  let best: CoverageSite | null = null;
  let bestOffset = Infinity;
  for (const site of sites) {
    const dLat = Math.abs(site.lat - point.lat);
    const dLon = Math.abs(((site.lon - point.lon + 540) % 360) - 180);
    if (dLat > SITE_MATCH_DEG || dLon > SITE_MATCH_DEG) continue;
    const offset = dLat + dLon;
    if (offset < bestOffset) {
      best = site;
      bestOffset = offset;
    }
  }
  return best;
}

export interface SiteSatellite {
  noradId: string;
  name: string;
  sensor: CoverageSensor;
  /** Closest approaches inside the modelled footprint, earliest first. */
  passes: CoveragePass[];
}

/** One stable registry per site, so a reopened site reads the satellites' cached scans. */
const singleSiteRegistries = new Map<string, readonly CoverageSite[]>();

/**
 * The tracked satellites whose modelled footprint covers `site` in the window, earliest
 * pass first: the reverse of `sitesCoveredBySatellite`, from the same scan, so a site
 * and a satellite card always agree.
 */
export async function satellitesCoveringSite(input: {
  site: CoverageSite;
  tles: readonly TrackedSatelliteTle[];
  nowMs: number;
  hours?: number;
  signal?: AbortSignal;
}): Promise<SiteSatellite[]> {
  const { site, tles, nowMs, hours, signal } = input;
  let sites = singleSiteRegistries.get(site.id);
  if (!sites) {
    sites = [site];
    singleSiteRegistries.set(site.id, sites);
  }
  const covering: SiteSatellite[] = [];
  for (const tle of tles) {
    const coverage = await sitesCoveredBySatellite({ tle, sites, nowMs, hours, signal });
    const passes = coverage.status === 'ok' ? coverage.sites[0]?.passes : undefined;
    if (coverage.status === 'ok' && passes?.length) covering.push({ noradId: tle.noradId, name: tle.name, sensor: coverage.sensor, passes });
  }
  return covering.sort((a, b) => a.passes[0]!.timeMs - b.passes[0]!.timeMs || a.name.localeCompare(b.name));
}
