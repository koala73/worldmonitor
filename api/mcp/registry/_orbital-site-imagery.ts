import { isOrbitalWatchEnabled } from '../../../server/worldmonitor/orbital/v1/dark-launch';
import { countrySiteImagery, imageryCredits } from '../../../server/worldmonitor/orbital/v1/site-imagery';
import type { GetCountryImageryEvidenceResponse } from '../../../src/generated/server/worldmonitor/orbital/v1/service_server';
import { requireCountryCode } from '../_country-args';
import { RpcValidationError } from '../billing-denial';
import type { ToolDef } from '../types';
import { COUNTRY_EVIDENCE_PATH, ORBITAL_MCP_TOOLS_PUBLISHED, readOrbital } from './_orbital';

const TOOL = 'get-watched-site-imagery';
const MAX_SITE_QUERY = 80;

function siteQuery(params: Record<string, unknown>): string {
  const value = params.site;
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.trim().length > MAX_SITE_QUERY) {
    throw new RpcValidationError(TOOL, [{ field: 'site', description: `site must be a name or id of at most ${MAX_SITE_QUERY} characters.` }]);
  }
  return value.trim().toLowerCase();
}

const IMAGE_SCHEMA = {
  type: 'object',
  description: 'Newest archive image; null when none is on record.',
  properties: {
    itemId: { type: 'string' },
    profileId: { type: 'string', description: 'Sensor profile, e.g. "sentinel-2".' },
    datetime: { type: 'string', description: 'Acquisition time, ISO 8601 UTC.' },
    credit: { type: 'string', description: 'Credit line owed when citing this image.' },
  },
};

const PASS_SCHEMA = {
  type: 'object',
  description: 'Next expected imaging pass; null when none in 72 hours.',
  properties: {
    profileId: { type: 'string' },
    time: { type: 'string', description: 'ISO 8601 UTC.' },
  },
};

export const WATCHED_SITE_IMAGERY_TOOL: ToolDef = {
  name: 'get_watched_site_imagery',
  title: 'Latest image and next pass for watched sites',
  _subscriptionOnly: true,
  _outputBudgetBytes: 131072,
  description: 'Return the watched sites in one country, newest image first, each with its latest archive image (scene id, sensor, date and the credit line owed when citing it) and its next expected imaging pass, plus every credit the listed sites owe. Pass site to keep only sites whose name or id contains it. Same evidence and currency rule as get_country_imagery_evidence: stale true means the evidence is missing or older than 3 days and sites is empty. Requires a paid plan; one downstream fetch. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      country_code: { type: 'string', description: 'Country as an ISO 3166-1 alpha-2 or alpha-3 code or a country name, e.g. "IR", "IRN" or "Iran".' },
      site: { type: 'string', description: 'Optional part of a site name or id, e.g. "Bandar Abbas".' },
    },
    required: ['country_code'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      countryCode: { type: 'string' },
      asOf: { type: 'integer', description: 'Evaluation time of the least recently evaluated site; 0 when nothing is served.' },
      stale: { type: 'boolean' },
      siteCount: { type: 'integer', description: 'Watched sites in the country, before the site filter.' },
      sites: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            siteId: { type: 'string' },
            name: { type: 'string' },
            latestImage: { ...IMAGE_SCHEMA, type: ['object', 'null'] },
            nextPass: { ...PASS_SCHEMA, type: ['object', 'null'] },
          },
          required: ['siteId', 'name', 'latestImage', 'nextPass'],
        },
      },
      credits: { type: 'array', items: { type: 'string' } },
    },
    required: ['countryCode', 'stale', 'siteCount', 'sites', 'credits'],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _validateArgs: (params) => { requireCountryCode(params.country_code, TOOL); siteQuery(params); },
  _execute: async (params, base, context, execution) => {
    const countryCode = requireCountryCode(params.country_code, TOOL);
    const query = siteQuery(params);
    const evidence = await readOrbital(COUNTRY_EVIDENCE_PATH, new URLSearchParams({ country_code: countryCode }), TOOL, base, context, execution) as GetCountryImageryEvidenceResponse;
    const imagery = countrySiteImagery({ ...evidence, sites: Array.isArray(evidence?.sites) ? evidence.sites : [] });
    if (!query) return imagery;
    const sites = imagery.sites.filter((site) => site.name.toLowerCase().includes(query) || site.siteId.toLowerCase().includes(query));
    return { ...imagery, sites, credits: imageryCredits(sites) };
  },
  _coverageKeys: ['orbital:sites:v1'],
  _apiPaths: [`GET ${COUNTRY_EVIDENCE_PATH}`],
};

/**
 * Listed with the other orbital tools once they are published (#10729), and only while
 * ORBITAL_WATCH_ENABLED=true. Dark, the tool is absent from tools/list and cannot be called.
 */
export function orbitalSiteImageryTools(
  env: Record<string, string | undefined> = process.env,
  published: boolean = ORBITAL_MCP_TOOLS_PUBLISHED,
): ToolDef[] {
  return published && isOrbitalWatchEnabled(env) ? [WATCHED_SITE_IMAGERY_TOOL] : [];
}
