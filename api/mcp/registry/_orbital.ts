import { requireCountryCode } from '../_country-args';
import { buildAuthHeaders } from '../auth';
import { assertToolFetchOk, RpcValidationError } from '../billing-denial';
import { fetchMcpDownstream } from '../downstream';
import type { ToolDef } from '../types';

const POINT_PASSES_PATH = '/api/orbital/v1/get-point-passes';
const COUNTRY_EVIDENCE_PATH = '/api/orbital/v1/get-country-imagery-evidence';
const USER_AGENT = 'worldmonitor-mcp-edge/1.0';

function coordinate(params: Record<string, unknown>, name: 'lat' | 'lon', limit: number): number {
  const value = params[name];
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit) {
    throw new RpcValidationError('get-point-passes', [{ field: name, description: `${name} must be a number from -${limit} to ${limit}.` }]);
  }
  return value;
}

const pointArgs = (params: Record<string, unknown>) => ({ lat: coordinate(params, 'lat', 90), lon: coordinate(params, 'lon', 180) });

async function readOrbital(path: string, query: URLSearchParams, label: string, base: string, context: Parameters<typeof buildAuthHeaders>[0], execution: Parameters<typeof fetchMcpDownstream>[2]) {
  const url = `${base}${path}?${query}`;
  const auth = await buildAuthHeaders(context, 'GET', url, undefined);
  const res = await fetchMcpDownstream(url, { method: 'GET', headers: { ...auth, 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(25_000) }, execution);
  await assertToolFetchOk(res, label);
  return res.json();
}

const TIERS = ['confirmed-image', 'likely-imaged', 'within-reach', 'capability-overhead', 'daily-mosaic', 'passed-overhead', 'opportunity'];

const POINT_PASS_SCHEMA = {
  type: 'object',
  properties: {
    noradId: { type: 'integer' },
    name: { type: 'string', description: 'Satellite name as published.' },
    profileId: { type: 'string', description: 'Sensor profile, e.g. sentinel-2, sentinel-1, landsat.' },
    category: { type: 'string', description: 'open-optical, open-radar, weather-polar, commercial-radar, military or crewed-station.' },
    timeMs: { type: 'integer', description: 'Closest approach, Unix epoch milliseconds.' },
    opportunity: { type: 'boolean', description: 'A future pass: a chance to image, never an image.' },
    groundDistanceKm: { type: 'number' },
    side: { type: 'string', enum: ['left', 'right'], description: 'Side of the ground track the point lies on.' },
    elevationDeg: { type: 'number' },
    incidenceDeg: { type: 'number' },
    sunElevationDeg: { type: 'number' },
    edgeOfSwath: { type: 'boolean', description: 'Within 5 km of the footprint edge, so imaging is uncertain.' },
    coverage: { type: 'boolean', description: 'The mission acquires over this point at all.' },
    tier: { type: 'string', enum: TIERS, description: 'Exactly one tier per pass. Military passes are capability-overhead, never an image.' },
    tierNote: { type: 'string', description: 'not-in-archive when the archive answered without this pass after its publication delay; geometry-disagreed when the archive holds the image although the modelled footprint, daylight or coverage said otherwise.' },
    orbitAgeDays: { type: 'number', description: 'Days between the pass and the epoch of the orbit elements used.' },
    acquisitionKey: { type: 'string', description: 'Key of the matched entry in acquisitions; empty when none.' },
  },
  required: ['noradId', 'name', 'profileId', 'category', 'timeMs', 'opportunity', 'tier'],
};

const ACQUISITION_SCHEMA = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    profileId: { type: 'string' },
    platform: { type: 'string', description: 'e.g. sentinel-2c, landsat-9.' },
    orbit: { type: 'integer', description: 'Relative orbit or WRS path; 0 when unknown.' },
    startMs: { type: 'integer' },
    endMs: { type: 'integer' },
    itemIds: { type: 'array', items: { type: 'string' } },
    archives: { type: 'array', items: { type: 'string' } },
    cloudCoverPct: { type: 'number', description: 'Scene cloud cover; absent when the archive gives none.' },
    resolutionM: { type: 'number' },
    imageUrl: { type: 'string', description: 'Public image: a crop around the point, else a whole-scene preview; empty when neither exists.' },
    passNoradId: { type: 'integer', description: '0 for an image no computed pass explains.' },
    passTimeMs: { type: 'integer' },
  },
  required: ['key', 'profileId', 'platform', 'startMs', 'endMs', 'itemIds', 'imageUrl'],
};

const SITE_SCHEMA = {
  type: 'object',
  properties: {
    siteId: { type: 'string' },
    name: { type: 'string' },
    lat: { type: 'number' },
    lon: { type: 'number' },
    surface: { type: 'string', description: 'land or maritime.' },
    originLists: { type: 'array', items: { type: 'string' } },
    evaluatedAt: { type: 'integer', description: 'Last evaluation, Unix epoch milliseconds.' },
    lastObservation: { type: 'object', description: 'Newest archive scene; absent when none.', properties: { itemId: { type: 'string' }, profileId: { type: 'string' }, datetime: { type: 'string' } } },
    nextWindow: { type: 'object', description: 'Next expected imaging pass; absent when none in 72 hours.', properties: { profileId: { type: 'string' }, time: { type: 'string' } } },
    operators: { type: 'array', items: { type: 'string' } },
    confirmedFlag: {
      type: 'object',
      description: 'Present only for a confirmed radar change; raised, retracted and shadow changes are never returned.',
      properties: { wording: { type: 'string' }, itemId: { type: 'string' }, datetime: { type: 'string' }, geometryKey: { type: 'string' }, updatedAt: { type: 'integer' } },
    },
  },
  required: ['siteId', 'name', 'lat', 'lon'],
};

export const ORBITAL_TOOLS: ToolDef[] = [
  {
    name: 'get_point_satellite_passes',
    title: 'Satellite passes and images for a point',
    _subscriptionOnly: true,
    // Measured 76 KB for 17 satellites over Denver on the 2026-11-13 fixture; leaves room for a larger catalog.
    _outputBudgetBytes: 262144,
    description: 'Return every imaging-satellite pass whose footprint covers a point over the last 7 days and the next 72 hours, each with exactly one tier (confirmed-image, likely-imaged, within-reach, capability-overhead, daily-mosaic, passed-overhead, opportunity), plus the Sentinel-2, Sentinel-1 and Landsat acquisitions found in the open archives with a public image URL. Tiers match the WorldMonitor point lookup. The point is rounded to 0.01 degrees and point names the one used. Military passes read capability-overhead, never an image. stale is true when the orbit catalog is missing or old; archiveStatus partial with failedSources means an archive failed and its passes keep geometry tiers. Requires a paid plan; one downstream fetch, weight 2 on API plans. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        lat: { type: 'number', minimum: -90, maximum: 90, description: 'Latitude in decimal degrees.' },
        lon: { type: 'number', minimum: -180, maximum: 180, description: 'Longitude in decimal degrees.' },
      },
      required: ['lat', 'lon'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        point: { type: 'object', description: 'The point used: the input rounded to 0.01 degrees.', properties: { lat: { type: 'number' }, lon: { type: 'number' } } },
        windowStartMs: { type: 'integer' },
        windowEndMs: { type: 'integer' },
        computedAt: { type: 'integer', description: 'When passes were computed; past and future are judged against it.' },
        inventoryVersion: { type: 'string' },
        catalogFetchedAt: { type: 'integer' },
        stale: { type: 'boolean' },
        passes: { type: 'array', items: POINT_PASS_SCHEMA, description: 'Passes covering the point, oldest first.' },
        outOfFootprintPasses: { type: 'integer', description: 'Passes in range whose footprint misses the point and that no archive image confirms; counted, not listed.' },
        acquisitions: { type: 'array', items: ACQUISITION_SCHEMA, description: 'Archive acquisitions at the point, newest first; tiles of one acquisition count once.' },
        archiveStatus: { type: 'string', enum: ['complete', 'partial'] },
        failedSources: { type: 'array', items: { type: 'object', properties: { archive: { type: 'string' }, reason: { type: 'string' }, httpStatus: { type: 'integer' } } } },
        unansweredProfiles: { type: 'array', items: { type: 'string' } },
      },
      required: ['point', 'computedAt', 'stale', 'passes', 'acquisitions', 'archiveStatus'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _validateArgs: (params) => { pointArgs(params); },
    _execute: async (params, base, context, execution) => {
      const { lat, lon } = pointArgs(params);
      return readOrbital(POINT_PASSES_PATH, new URLSearchParams({ lat: String(lat), lon: String(lon) }), 'get-point-passes', base, context, execution);
    },
    _coverageKeys: ['orbital:catalog:v1'],
    _apiPaths: [`GET ${POINT_PASSES_PATH}`],
  },
  {
    name: 'get_country_imagery_evidence',
    title: 'Watched-site satellite evidence for a country',
    _subscriptionOnly: true,
    _outputBudgetBytes: 196608,
    description: 'Return the watched sites in one country with each site\'s newest archive scene, next expected imaging pass, the operators whose satellites passed over it, and any confirmed change flag. A confirmed flag means radar backscatter statistics changed at the site and a second comparable scene confirmed it; it says that statistics changed, not what changed. Raised, retracted and unreleased changes are never returned. siteCount 0 with stale false means the country has no watched sites; stale true means the evidence is missing or older than 3 days and sites is empty. Requires a paid plan; one downstream fetch, weight 2 on API plans. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string', description: 'Country as an ISO 3166-1 alpha-2 or alpha-3 code or a country name, e.g. "UA", "UKR" or "Ukraine".' },
      },
      required: ['country_code'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        countryCode: { type: 'string' },
        asOf: { type: 'integer', description: 'Evaluation time of the least recently evaluated site; 0 when nothing is served.' },
        stale: { type: 'boolean' },
        siteCount: { type: 'integer' },
        confirmedFlagCount: { type: 'integer' },
        sites: { type: 'array', items: SITE_SCHEMA },
      },
      required: ['countryCode', 'stale', 'siteCount', 'confirmedFlagCount', 'sites'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _validateArgs: (params) => { requireCountryCode(params.country_code, 'get-country-imagery-evidence'); },
    _execute: async (params, base, context, execution) => {
      const countryCode = requireCountryCode(params.country_code, 'get-country-imagery-evidence');
      return readOrbital(COUNTRY_EVIDENCE_PATH, new URLSearchParams({ country_code: countryCode }), 'get-country-imagery-evidence', base, context, execution);
    },
    _coverageKeys: ['orbital:sites:v1'],
    _apiPaths: [`GET ${COUNTRY_EVIDENCE_PATH}`],
  },
];
