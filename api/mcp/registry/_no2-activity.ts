// get_no2_activity: RPC proxy over GET /api/economic/v1/get-no2-activity. The
// handler owns filtering, validation and miss classification, so an agent
// sees exactly what the route serves; this module maps arguments to the
// route's query, compacts each record to the fields agents read, and attaches
// the method constants the methodVersion pins.
import { COUNTRY_ARG_HINT, echoCountryInput } from '../_country-args';
import { resolveCountryCode } from '../../../shared/country-code-resolve';
import { buildAuthHeaders } from '../auth';
import { RpcValidationError } from '../billing-denial';
import { assertMcpToolFetchOk, fetchMcpDownstream } from '../downstream';
import type { RpcToolDef } from '../types';
import type {
  GetNo2ActivityResponse,
  No2ActivityRegion,
  No2Direction,
  No2RegionExclusion,
  No2RegionKind,
} from '../../../src/generated/server/worldmonitor/economic/v1/service_server';
import {
  NO2_ACTIVITY_KEY,
  NO2_ACTIVITY_METHOD,
  NO2_ACTIVITY_METHOD_VERSION,
  NO2_ACTIVITY_SEED_META_KEY,
  NO2_DIRECTIONS,
  NO2_REGION_EXCLUSIONS,
  signalFor,
} from '../../../scripts/shared/no2-activity.mjs';
import { NO2_ATTRIBUTION_EXPRESSION } from '../../../shared/attribution-rider';

const OPERATION = 'get-no2-activity';
const REGION_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

const KIND_ARG: Record<string, No2RegionKind> = {
  country: 'NO2_REGION_KIND_COUNTRY',
  cluster: 'NO2_REGION_KIND_CLUSTER',
};

const KIND_LABEL: Record<No2RegionKind, 'country' | 'cluster' | null> = {
  NO2_REGION_KIND_UNSPECIFIED: null,
  NO2_REGION_KIND_COUNTRY: 'country',
  NO2_REGION_KIND_CLUSTER: 'cluster',
};

const DIRECTION_LABEL: Record<No2Direction, 'strengthening' | 'weakening' | 'unchanged' | null> = {
  NO2_DIRECTION_UNSPECIFIED: null,
  NO2_DIRECTION_STRENGTHENING: 'strengthening',
  NO2_DIRECTION_WEAKENING: 'weakening',
  NO2_DIRECTION_UNCHANGED: 'unchanged',
};

const EXCLUSION_LABEL: Record<No2RegionExclusion, string | null> = {
  NO2_REGION_EXCLUSION_UNSPECIFIED: null,
  NO2_REGION_EXCLUSION_REQUEST_FAILED: 'request_failed',
  NO2_REGION_EXCLUSION_BASELINE_BACKFILL_PENDING: 'baseline_backfill_pending',
  NO2_REGION_EXCLUSION_INSUFFICIENT_VALID_DAYS: 'insufficient_valid_days',
  NO2_REGION_EXCLUSION_INSUFFICIENT_BASELINE_YEARS: 'insufficient_baseline_years',
};

const UNAVAILABLE_REASONS = [
  'NO2_ACTIVITY_UNAVAILABLE_REASON_UNSPECIFIED',
  'NO2_ACTIVITY_UNAVAILABLE_REASON_INVALID_REQUEST',
  'NO2_ACTIVITY_UNAVAILABLE_REASON_NOT_COVERED',
  'NO2_ACTIVITY_UNAVAILABLE_REASON_SEED_MISSING',
  'NO2_ACTIVITY_UNAVAILABLE_REASON_INVALID_DATASET',
  'NO2_ACTIVITY_UNAVAILABLE_REASON_CACHE_UNAVAILABLE',
] as const;

/** The constants the served methodVersion pins; an unknown version carries none. */
export function no2MethodSummary(methodVersion: string) {
  const known = methodVersion === NO2_ACTIVITY_METHOD_VERSION;
  return {
    methodVersion,
    windowDays: known ? NO2_ACTIVITY_METHOD.windowDays : 0,
    windowEndLagDays: known ? NO2_ACTIVITY_METHOD.windowEndLagDays : 0,
    baselineYears: known ? NO2_ACTIVITY_METHOD.baselineYears : 0,
    minBaselineYears: known ? NO2_ACTIVITY_METHOD.minBaselineYears : 0,
    minValidDays: known ? NO2_ACTIVITY_METHOD.minValidDays : 0,
    minValidFraction: known ? NO2_ACTIVITY_METHOD.minValidFraction : 0,
    deadBandPercent: known ? NO2_ACTIVITY_METHOD.deadBandPercent : 0,
  };
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function compactRegion(region: No2ActivityRegion, knownMethod: boolean) {
  const changePercent = number(region.changePercent);
  return {
    id: region.id,
    kind: KIND_LABEL[region.kind] ?? null,
    label: region.label,
    countryCode: region.countryCode === '' ? null : region.countryCode,
    bbox: region.bbox,
    windowStart: region.current?.windowStart ?? '',
    windowEnd: region.current?.windowEnd ?? '',
    validDays: region.current?.validDays ?? 0,
    meanNo2MolM2: number(region.current?.meanNo2MolM2),
    baselineYears: Array.isArray(region.baselineYears) ? region.baselineYears : [],
    baselineMeanNo2MolM2: number(region.baselineMeanNo2MolM2),
    changePercent,
    signalValue: changePercent === null || !knownMethod ? null : signalFor(changePercent).signalValue,
    direction: DIRECTION_LABEL[region.direction] ?? null,
    exclusion: EXCLUSION_LABEL[region.exclusion] ?? null,
  };
}

function queryFor(params: Record<string, unknown>): URLSearchParams {
  const query = new URLSearchParams();
  const rawCountry = params.country_code;
  if (rawCountry !== undefined && rawCountry !== null && rawCountry !== '') {
    const resolved = resolveCountryCode(rawCountry);
    if (!resolved) {
      throw new RpcValidationError(OPERATION, [{
        field: 'country_code',
        description: `Could not resolve ${JSON.stringify(echoCountryInput(rawCountry))} to a country. ${COUNTRY_ARG_HINT}`,
      }]);
    }
    query.set('country_code', resolved);
  }
  const rawRegion = params.region_id;
  if (rawRegion !== undefined && rawRegion !== null && rawRegion !== '') {
    if (typeof rawRegion !== 'string' || !REGION_ID_PATTERN.test(rawRegion)) {
      throw new RpcValidationError(OPERATION, [{
        field: 'region_id',
        description: 'Pass a registry id such as "country-cn" or "yangtze-river-delta" (lowercase letters, digits and hyphens).',
      }]);
    }
    query.set('region_id', rawRegion);
  }
  const rawKind = params.kind;
  if (rawKind !== undefined && rawKind !== null && rawKind !== '') {
    const kind = typeof rawKind === 'string' && Object.prototype.hasOwnProperty.call(KIND_ARG, rawKind) ? KIND_ARG[rawKind] : undefined;
    if (!kind) {
      throw new RpcValidationError(OPERATION, [{
        field: 'kind',
        description: 'Pass "country" or "cluster", or omit it for both.',
      }]);
    }
    query.set('kind', kind);
  }
  return query;
}

const NULLABLE_NUMBER = { type: ['number', 'null'] };

export const NO2_ACTIVITY_TOOL: RpcToolDef = {
  name: 'get_no2_activity',
  title: 'Sentinel-5P NO2 activity',
  _outputBudgetBytes: 131072,
  _attribution: NO2_ATTRIBUTION_EXPRESSION,
  // Reject malformed arguments before the caller's quota is charged.
  _validateArgs: (params) => { queryFor(params); },
  description: 'Industrial activity direction from Sentinel-5P tropospheric NO2 for 167 countries and 32 industrial clusters: the latest 56-day window against the same dates in the prior three years, as changePercent and a direction after a 10% dead band. A region with no reading carries an exclusion; baseline_backfill_pending is expected while prior years are still being fetched, not a fault. Filter by country_code (the country plus its clusters), region_id or kind. Daily seed, never a live Copernicus call; reproduce attribution. Requires a paid plan; one downstream fetch, weight 2 on API plans. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      country_code: {
        type: 'string',
        description: `Optional. ${COUNTRY_ARG_HINT} Returns the country region and every cluster inside it; clusters spanning several countries (gulf-states, rotterdam-antwerp) carry no code.`,
      },
      region_id: {
        type: 'string',
        description: 'Optional registry id, for example "country-cn" or "yangtze-river-delta". Combine with the other filters as AND.',
      },
      kind: {
        type: 'string',
        enum: Object.keys(KIND_ARG),
        description: 'Optional. "country" for country polygons, "cluster" for named industrial clusters; omit for both.',
      },
    },
    required: [],
  },
  outputSchema: {
    type: 'object',
    required: ['regions', 'generatedAt', 'stale', 'method', 'attribution', 'unavailableReason', 'upstreamUnavailable'],
    properties: {
      regions: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'kind', 'label', 'countryCode', 'bbox', 'windowStart', 'windowEnd', 'validDays', 'meanNo2MolM2', 'baselineYears', 'baselineMeanNo2MolM2', 'changePercent', 'signalValue', 'direction', 'exclusion'],
          properties: {
            id: { type: 'string', description: 'Registry id, for example "country-cn" or "yangtze-river-delta".' },
            kind: { type: ['string', 'null'], enum: ['country', 'cluster', null] },
            label: { type: 'string' },
            countryCode: { type: ['string', 'null'], description: 'ISO 3166-1 alpha-2; null for a cluster spanning several countries.' },
            bbox: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: 'West, south, east, north in degrees.' },
            windowStart: { type: 'string', description: 'First UTC date of the current window, inclusive.' },
            windowEnd: { type: 'string', description: 'Last UTC date of the current window, inclusive.' },
            validDays: { type: 'integer', description: 'Days in the current window with enough cloud-free, quality-filtered pixels.' },
            meanNo2MolM2: { ...NULLABLE_NUMBER, description: 'Mean tropospheric NO2 column over the valid days, mol/m2; null with no valid day.' },
            baselineYears: { type: 'array', items: { type: 'integer' }, description: 'Prior years whose same-date window entered the baseline, newest first; empty while the backfill is pending.' },
            baselineMeanNo2MolM2: { ...NULLABLE_NUMBER, description: 'Mean of the baseline windows, mol/m2; null while pending.' },
            changePercent: { ...NULLABLE_NUMBER, description: 'Current window against the baseline mean, percent; null when excluded.' },
            signalValue: { ...NULLABLE_NUMBER, description: 'changePercent outside the dead band, 0 inside it; null when excluded or when methodVersion is one this server does not know.' },
            direction: { type: ['string', 'null'], enum: [...NO2_DIRECTIONS, null], description: 'null when excluded.' },
            exclusion: { type: ['string', 'null'], enum: [...NO2_REGION_EXCLUSIONS, null], description: 'Why there is no reading; null when the region has one. baseline_backfill_pending is expected for a new region, not a fault.' },
          },
        },
      },
      generatedAt: { type: 'string', description: 'When the seeder produced the dataset; empty when no regions are served.' },
      stale: { type: 'boolean', description: 'True when generatedAt is older than the 72 h health budget for this dataset.' },
      method: {
        type: 'object',
        required: ['methodVersion', 'windowDays', 'windowEndLagDays', 'baselineYears', 'minBaselineYears', 'minValidDays', 'minValidFraction', 'deadBandPercent'],
        properties: {
          methodVersion: { type: 'string', description: 'Pins the constants below; they read 0 for a version this server does not know.' },
          windowDays: { type: 'integer' },
          windowEndLagDays: { type: 'integer' },
          baselineYears: { type: 'integer' },
          minBaselineYears: { type: 'integer' },
          minValidDays: { type: 'integer' },
          minValidFraction: { type: 'number' },
          deadBandPercent: { type: 'number' },
        },
      },
      attribution: { type: 'string', description: 'Required credit, for example "Contains modified Copernicus Sentinel data 2023-2026"; empty when no regions are served.' },
      unavailableReason: {
        type: 'string',
        enum: [...UNAVAILABLE_REASONS],
        description: 'UNSPECIFIED when regions are served. NOT_COVERED is a contract answer (the filters name no registered region); the rest name faults.',
      },
      upstreamUnavailable: { type: 'boolean', description: 'True when a fault prevented serving; false both when served and when the filters are simply not covered.' },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _execute: async (params, base, context, execution) => {
    const query = queryFor(params);
    const suffix = query.toString();
    const url = `${base}/api/economic/v1/${OPERATION}${suffix ? `?${suffix}` : ''}`;
    const auth = await buildAuthHeaders(context, 'GET', url, null);
    const response = await fetchMcpDownstream(url, {
      headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
      signal: AbortSignal.timeout(12_000),
    }, execution);
    await assertMcpToolFetchOk(response, {
      operation: OPERATION,
      tool: 'get_no2_activity',
      auth: context,
      execution,
    });
    const wire = await response.json() as GetNo2ActivityResponse;
    const knownMethod = wire.methodVersion === NO2_ACTIVITY_METHOD_VERSION;
    const unavailableReason = UNAVAILABLE_REASONS.find((reason) => reason === wire.unavailableReason)
      ?? 'NO2_ACTIVITY_UNAVAILABLE_REASON_UNSPECIFIED';
    return {
      regions: Array.isArray(wire.regions) ? wire.regions.map((region) => compactRegion(region, knownMethod)) : [],
      generatedAt: typeof wire.generatedAt === 'string' ? wire.generatedAt : '',
      stale: wire.stale === true,
      method: no2MethodSummary(typeof wire.methodVersion === 'string' ? wire.methodVersion : ''),
      attribution: typeof wire.attribution === 'string' ? wire.attribution : '',
      unavailableReason,
      upstreamUnavailable: wire.upstreamUnavailable === true,
    };
  },
  _coverageKeys: [NO2_ACTIVITY_KEY, NO2_ACTIVITY_SEED_META_KEY],
  _apiPaths: ['GET /api/economic/v1/get-no2-activity'],
};
