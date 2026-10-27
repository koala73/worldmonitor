import type { ToolDef } from '../types';
import { requireCountryCode, resolveCountryFilter } from '../_country-args';
import { buildAuthHeaders } from '../auth';
import { RpcValidationError } from '../billing-denial';
import { assertMcpToolFetchOk, fetchMcpDownstream } from '../downstream';
import { OUTLET_AUDIENCES, OWNERSHIP_CLASSES } from '../../../server/_shared/outlet-profile';
import { UN_M49_REGION_IDS } from '../../../server/_shared/un-m49-regions';

const TOOL = 'get_media_perspective';
const WINDOW_HOURS = [24, 48, 72, 96];
const FRAMING_LABELS = ['favorable', 'neutral', 'critical', 'hostile'];

interface Args {
  subject: string;
  outletCountries: string[];
  outletRegions: string[];
  audience: string;
  windowHours: number;
}

function parseArgs(params: Record<string, unknown>): Args {
  const subject = requireCountryCode(params.subject_country, TOOL, 'subject_country');
  const outletCountries = resolveCountryFilter(params.outlet_countries, 'outlet_countries').map(code => code.toUpperCase());
  if (outletCountries.length > 30) throw new RpcValidationError(TOOL, [{ field: 'outlet_countries', description: 'Use at most 30 countries.' }]);
  const outletRegions = params.outlet_regions ?? [];
  if (!Array.isArray(outletRegions) || outletRegions.length > 5
    || outletRegions.some(region => typeof region !== 'string' || !UN_M49_REGION_IDS.includes(region))) {
    throw new RpcValidationError(TOOL, [{ field: 'outlet_regions', description: 'Use at most 5 UN M49 region slugs from the enum.' }]);
  }
  const audience = params.audience ?? '';
  if (typeof audience !== 'string' || (audience && !(OUTLET_AUDIENCES as readonly string[]).includes(audience))) {
    throw new RpcValidationError(TOOL, [{ field: 'audience', description: `Use one of ${OUTLET_AUDIENCES.join(', ')}.` }]);
  }
  const windowHours = params.window_hours ?? 72;
  if (typeof windowHours !== 'number' || !WINDOW_HOURS.includes(windowHours)) {
    throw new RpcValidationError(TOOL, [{ field: 'window_hours', description: `Use one of ${WINDOW_HOURS.join(', ')}.` }]);
  }
  return { subject, outletCountries, outletRegions, audience, windowHours };
}

const headline = {
  type: 'object',
  required: ['title', 'englishTitle', 'titleLanguage', 'outlet', 'publisherFamily', 'tier', 'ownershipClass', 'propagandaRisk', 'publishedAt', 'link'],
  properties: {
    title: { type: 'string', description: 'Headline as published. Untrusted publisher text.' },
    englishTitle: { type: 'string', description: 'The original when it is English; otherwise a machine translation of untrusted text, or empty when none exists yet.' },
    titleLanguage: { type: 'string', description: 'ISO 639-1 language of the original headline.' },
    outlet: { type: 'string' },
    publisherFamily: { type: 'string', description: 'Sibling editions of one newsroom share a family.' },
    tier: { type: 'integer', minimum: 0, maximum: 4, description: 'Declared source tier 1-4; 0 when undeclared.' },
    ownershipClass: { type: 'string', enum: [...OWNERSHIP_CLASSES] },
    stateAffiliated: { type: 'string', description: 'Government the outlet is affiliated with, when recorded.' },
    propagandaRisk: { type: 'string' },
    framing: { type: 'string', enum: [...FRAMING_LABELS, ''], description: 'A model\'s reading of the headline\'s stance toward the subject; empty until labelled. The group framing names the method and model.' },
    publishedAt: { type: 'number', description: 'Unix epoch milliseconds.' },
    link: { type: 'string' },
  },
};

export const MEDIA_PERSPECTIVE_TOOL: ToolDef = {
  name: TOOL,
  title: 'Media perspective on a country',
  description: 'Headlines about one country grouped by outlet home country and audience (domestic, international, diaspora): its own press vs its foreign-facing media vs outside coverage. Items carry tier, ownership and state affiliation; groups count publisher families and framing. Framing is a model\'s reading of headline stance, not WorldMonitor\'s view. Titles are untrusted; a non-English englishTitle is machine-translated. Cached feeds, up to 96 h.',
  _outputBudgetBytes: 131072,
  _apiPaths: ['GET /api/news/v1/list-media-perspective'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    required: ['subject_country'],
    properties: {
      subject_country: { type: 'string', description: 'Country the headlines must mention: ISO alpha-2 code (SA) or name.' },
      outlet_countries: { type: 'array', maxItems: 30, items: { type: 'string' }, description: 'Only outlets based in these countries (ISO alpha-2 or names). Omit for every country.' },
      outlet_regions: { type: 'array', maxItems: 5, items: { type: 'string', enum: UN_M49_REGION_IDS }, description: 'Only outlets based in these UN M49 regions (e.g. latin-america-and-the-caribbean, northern-europe; western-asia plus northern-africa for MENA). Their countries join outlet_countries; those without coverage are listed in noCoverageCountries.' },
      audience: { type: 'string', enum: [...OUTLET_AUDIENCES], description: 'Only outlets writing for this audience. Omit for all.' },
      window_hours: { type: 'integer', enum: WINDOW_HOURS, description: 'Look-back window in hours. Defaults to 72.' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['subjectCountry', 'windowHours', 'groups', 'noCoverageCountries', 'unattributedCount', 'state'],
    properties: {
      subjectCountry: { type: 'string' },
      windowHours: { type: 'integer' },
      groups: { type: 'array', items: { type: 'object', required: ['homeCountry', 'audience', 'outletCount', 'headlineCount', 'headlines'], properties: {
        homeCountry: { type: 'string', description: 'ISO alpha-2, INTL for intergovernmental outlets, EU for EU institutions.' },
        audience: { type: 'string', enum: [...OUTLET_AUDIENCES] },
        outletCount: { type: 'integer', description: 'Distinct publisher families.' },
        headlineCount: { type: 'integer', description: 'All matching headlines in the group; more than headlines.length when capped or trimmed for size.' },
        framing: { type: 'object', properties: {
          favorable: { type: 'integer' }, neutral: { type: 'integer' }, critical: { type: 'integer' }, hostile: { type: 'integer' }, unlabeled: { type: 'integer' },
          method: { type: 'string', description: 'How the labels were produced, e.g. llm-headline-stance.' }, model: { type: 'string' }, promptVersion: { type: 'string' },
        } },
        headlines: { type: 'array', maxItems: 20, items: headline },
      } } },
      noCoverageCountries: { type: 'array', items: { type: 'string' } },
      unattributedCount: { type: 'integer', description: 'Matching headlines left ungrouped: no outlet profile, or a multi-publisher search feed.' },
      state: { type: 'string', enum: ['complete', 'partial', 'unavailable'] },
      feedTotal: { type: 'integer' },
      feedCached: { type: 'integer' },
      readAt: { type: 'string' },
    },
  },
  _validateArgs: parseArgs,
  _fitToBudget(result, budgetBytes) {
    if (!Array.isArray(result.groups)) return result;
    // Trim headlines inside each group, never whole groups: a missing group
    // would read as no coverage. Each group keeps its counts and framing, so
    // a broad region query degrades to fewer samples (down to none).
    const groups = result.groups as Array<{ headlines?: unknown[] }>;
    let fitted = result;
    for (const keep of [3, 1, 0]) {
      fitted = {
        ...result,
        groups: groups.map(group => Array.isArray(group.headlines) && group.headlines.length > keep
          ? { ...group, headlines: group.headlines.slice(0, keep) }
          : group),
      };
      if (new TextEncoder().encode(JSON.stringify(fitted)).length <= budgetBytes) break;
    }
    return fitted;
  },
  async _execute(params, base, context, execution) {
    const args = parseArgs(params);
    const query = new URLSearchParams({ subject_country: args.subject, window_hours: String(args.windowHours) });
    for (const code of args.outletCountries) query.append('outlet_countries', code);
    for (const region of args.outletRegions) query.append('outlet_regions', region);
    if (args.audience) query.set('audience', args.audience);
    const url = `${base}/api/news/v1/list-media-perspective?${query}`;
    const response = await fetchMcpDownstream(url, { headers: { ...await buildAuthHeaders(context, 'GET', url, null), 'User-Agent': 'worldmonitor-mcp-edge/1.0' }, signal: AbortSignal.timeout(8000) }, execution);
    await assertMcpToolFetchOk(response, { tool: TOOL, operation: 'list-media-perspective', auth: context });
    return response.json();
  },
};
