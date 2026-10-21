import { z } from 'zod';
import { COUNTRY_SIGNAL_BYTES, countrySignalResponseSchema, countrySignalOutcomeSchema } from '../../../shared/country-signal-observations';
import { RAW_SIGNAL_READS, RAW_SIGNAL_FAMILIES, RAW_SIGNAL_BODY_BYTES, RAW_SIGNAL_ENVELOPE_BYTES, failedRawSignal, validateRawSignal, assembleRawSignals, type RawSignalsValue } from '../../../shared/country-raw-signals';
import { COUNTRY_READERS, countryReaderSchema, countryViewSchema, panelAdmissionSchema, type CountryReader } from '../../../shared/country-brief-host';
import { BRIEF_TOPICS } from '../../../shared/country-brief-sections';
import { resolveCountryCode } from '../../../shared/country-code-resolve';
import { normalizeFoodStocksCommodity } from '../../../server/worldmonitor/resilience/v1/_food-stocks-query';
import { buildAuthHeaders } from '../auth';
import { assertToolFetchOk, BillingDenialError, RpcValidationError, throwIfBillingDenial } from '../billing-denial';
import { readBoundedResponseBody } from '../bounded-body';
import { fetchMcpDownstream } from '../downstream';
import type { ToolDef } from '../types';
import { COUNTRY_VIEW_UI_URI } from '../ui/news-dashboard-app';

const COUNTRY_SECTION_BUDGET_BYTES = 524288;

function countryViewArguments(params: Record<string, unknown>) {
  const parsed = countryViewSchema.safeParse(Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'jmespath')));
  const countryCode = parsed.success ? resolveCountryCode(parsed.data.country_code) : null;
  if (!parsed.success || !countryCode) throw new RpcValidationError('open_country_brief', [{ field: 'country_code', description: 'Supply a recognized country and topic.' }]);
  return { countryCode, topic: parsed.data.topic };
}

function countrySectionArguments(params: Record<string, unknown>) {
  const parsed = countryReaderSchema.safeParse(Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'jmespath')));
  if (!parsed.success) throw new RpcValidationError('get_country_brief_section', [{ field: 'section', description: 'Unknown country section reader.' }]);
  const { section } = parsed.data;
  const reader = COUNTRY_READERS[section];
  const args = reader.args.safeParse(parsed.data.arguments);
  if (!args.success) throw new RpcValidationError('get_country_brief_section', [{ field: 'arguments', description: 'Invalid arguments for this country section.' }]);
  if (section === 'food' && 'commodity' in args.data && normalizeFoodStocksCommodity(args.data.commodity) === null) {
    throw new RpcValidationError('get_country_brief_section', [{ field: 'arguments.commodity', description: 'Supply a supported food commodity.' }]);
  }
  return { parsed, section, reader, args };
}

// What each section reader returns and what its arguments mean. The zod
// schemas in shared/country-brief-host.ts carry the constraints; the prose
// here is what tools/list advertises on every nested `arguments` property, so
// an agent can fill a branch without a failed call first. The module-load
// guard below fails when a reader gains an argument this map does not cover.
const ISO2 = 'Uppercase ISO 3166-1 alpha-2 country code, e.g. "DE".';
const M49 = 'UN M49 numeric country code with 1-3 digits, e.g. "840" for the United States.';
const HS2 = 'Two-digit HS chapter: 10 cereals, 27 fuels, 29 organic chemicals, 30 pharmaceuticals, 39 plastics, 62 apparel, 72 iron and steel, 84 machinery, 85 electrical equipment, 87 vehicles.';
const CHOKEPOINT_ID = 'Chokepoint registry id as a lowercase slug, e.g. "hormuz_strait".';
const FIXED_EMPTY = 'Fixed to the empty string: this reader returns every value and accepts no narrowing.';
const COUNTRY_SECTION_DOCS: Record<CountryReader, { summary: string; args: Record<string, string> }> = {
  countrySignals: { summary: 'One bounded country-qualified source family or eligible flight page. Requires a verified same-country panel.', args: { country_code: ISO2, family: 'Fixed source family enum; one source per request.', window_index: 'Country-derived flight window index, 0 or 1; otherwise 0.', cursor: 'Prior eligible flight page cursor, at most 200 characters; otherwise empty.' } },
  signalsRaw: { summary: 'Attributed raw signal samples for one country: earthquakes, Internet outages, travel advisories and thermal escalations, each with scope, snapshot time and attribution. Needs a verified same-country paid panel token.', args: { country_code: `${ISO2} Must equal the country of the verified panel token.` } },
  flights: { summary: 'Military flight observations inside a bounding box, 100 per page, with provider attribution.', args: { ne_lat: 'North-east corner latitude of the bounding box in degrees (-90 to 90).', ne_lon: 'North-east corner longitude of the bounding box in degrees (-180 to 180).', sw_lat: 'South-west corner latitude of the bounding box in degrees (-90 to 90).', sw_lon: 'South-west corner longitude of the bounding box in degrees (-180 to 180).', page_size: 'Fixed page size of 100 rows.', operator: 'Fixed to the unspecified operator filter; no operator narrowing is available.', aircraft_type: 'Fixed to the unspecified aircraft-type filter; no type narrowing is available.', cursor: 'Opaque cursor from the previous page\'s pagination block; empty string for the first page.' } },
  vessels: { summary: 'Live AIS vessel snapshot with connection status, snapshot time, density zones and disruptions; unavailable when the snapshot is older than one hour.', args: { ne_lat: 'Fixed to 0: the reader returns the global snapshot rather than a box query.', ne_lon: 'Fixed to 0: the reader returns the global snapshot rather than a box query.', sw_lat: 'Fixed to 0: the reader returns the global snapshot rather than a box query.', sw_lon: 'Fixed to 0: the reader returns the global snapshot rather than a box query.', include_candidates: 'Fixed to "true": candidate vessel matches are included in the snapshot.' } },
  fleet: { summary: 'The latest USNI fleet and marine tracker report; takes no arguments.', args: {} },
  facts: { summary: 'Reference facts about the country.', args: { country_code: ISO2 } },
  energy: { summary: 'The country\'s energy profile.', args: { country_code: ISO2 } },
  maritime: { summary: 'Port activity for the country\'s monitored ports.', args: { country_code: ISO2 } },
  risk: { summary: 'Country risk: Composite Instability Index with components, travel-advisory level and sanctions exposure.', args: { country_code: ISO2 } },
  stock: { summary: 'The country\'s benchmark stock index quote.', args: { country_code: ISO2 } },
  food: { summary: 'Food stock observations for one country or the WORLD aggregate, optionally narrowed to one commodity.', args: { countryCode: 'Uppercase ISO 3166-1 alpha-2 code, or WORLD for the global aggregate.', commodity: 'Commodity name to narrow to, up to 40 characters; empty string for every commodity.' } },
  demographics: { summary: 'Demographic capability observations: age structure, education and industrial workforce.', args: { countryCode: ISO2 } },
  resilience: { summary: 'The country\'s resilience score with its domain breakdown.', args: { countryCode: ISO2 } },
  factors: { summary: 'The five-factor scorecard with provenance and raw observations.', args: { countryCode: ISO2 } },
  debt: { summary: 'National debt levels for every country; takes no arguments.', args: {} },
  flows: { summary: 'UN COMTRADE trade flows reported by one country, optionally narrowed to one commodity or to anomalies.', args: { reporter_code: M49, cmd_code: 'HS commodity code of up to 6 digits; empty string for every commodity.', anomalies_only: '"true" keeps only flows flagged as anomalous; "false" (default) returns every flow.' } },
  tariffs: { summary: 'Applied tariff trend series for one reporting country.', args: { reporting_country: M49, product_sector: 'Product sector code of up to 20 characters; empty string for all products.', years: 'Trailing years of history to return, 1-10 (default 10).', partner_country: 'UN M49 numeric partner code; empty string for all partners.' } },
  products: { summary: 'The country\'s supply-chain product profile, optionally narrowed to one HS heading.', args: { iso2: ISO2, hs4: 'Optional 4-digit HS heading to narrow to one product group.' } },
  commodities: { summary: 'Commodity supply vulnerabilities for the country.', args: { iso2: ISO2 } },
  exposure: { summary: 'Chokepoint exposure index for one country and HS chapter.', args: { iso2: ISO2, hs2: HS2 } },
  dependency: { summary: 'Sector dependency on maritime chokepoints for one country and HS chapter.', args: { iso2: ISO2, hs2: HS2 } },
  bypass: { summary: 'Rerouting options when one chokepoint closes, by cargo type and closure share.', args: { chokepointId: CHOKEPOINT_ID, cargoType: 'Cargo type: container (default), tanker or bulk.', closurePct: 'Share of the chokepoint closed, 0-100 percent (default 0).' } },
  chokepoints: { summary: 'Current status of every monitored chokepoint; takes no arguments.', args: {} },
  cost: { summary: 'Multi-sector cost shock for one country from a chokepoint closure of a given length.', args: { iso2: ISO2, chokepointId: CHOKEPOINT_ID, closureDays: 'Closure length in days, 1-365 (default 30).' } },
  pipelines: { summary: 'The pipeline registry.', args: { commodityType: FIXED_EMPTY } },
  facilities: { summary: 'The energy storage facility registry.', args: { facilityType: FIXED_EMPTY } },
  shortages: { summary: 'Current fuel shortages.', args: { country: FIXED_EMPTY, product: FIXED_EMPTY, severity: FIXED_EMPTY } },
  pipelineDetail: { summary: 'One pipeline\'s detail; unavailable when the pipeline does not originate in, end in or transit the country.', args: { country_code: `${ISO2} The pipeline must originate in, end in or transit this country.`, pipelineId: 'Pipeline id as listed by the pipelines section.' } },
  facilityDetail: { summary: 'One storage facility\'s detail; unavailable when the facility is not in the country.', args: { country_code: `${ISO2} The facility must be located in this country.`, facilityId: 'Facility id as listed by the facilities section.' } },
  shortageDetail: { summary: 'One fuel shortage\'s detail; unavailable when the shortage is not in the country.', args: { country_code: `${ISO2} The shortage must be located in this country.`, shortageId: 'Shortage id as listed by the shortages section.' } },
  disruptions: { summary: 'Energy disruption events, optionally only those still ongoing.', args: { assetId: FIXED_EMPTY, assetType: FIXED_EMPTY, ongoingOnly: '"true" keeps only disruptions still ongoing; "false" (default) includes resolved ones.' } },
  scenario: { summary: 'Energy supply shock scenario for one country and chokepoint at a chosen disruption share and fuel.', args: { country_code: ISO2, chokepoint_id: CHOKEPOINT_ID, disruption_pct: 'Share of the chokepoint flow disrupted, 0-100 percent (default 0).', fuel_mode: 'Fuel scope: oil (default), gas or both.' } },
  defense: { summary: 'Defense industrial base indicators and arms-supplier shares for the country.', args: { country_code: ISO2 } },
  markets: { summary: 'Prediction markets list with optional title and category narrowing.', args: { page_size: 'Markets per page, 1-100 (default 50).', query: 'Case-insensitive title substring, up to 100 characters; empty string for every market.', category: 'Category bucket name, up to 40 characters; empty string for every category.', cursor: 'Fixed to the empty string: only the first page is readable here.' } },
  china: { summary: 'China decision signals; takes no arguments.', args: {} },
  production: { summary: 'Mine and refinery production for one commodity across countries and stages.', args: { commodity: 'Commodity slug in lowercase, e.g. "copper".', iso2: FIXED_EMPTY, stage: FIXED_EMPTY } },
  housing: { summary: 'BIS housing datasets: debt-service ratio and residential and commercial property prices.', args: { keys: 'Fixed list of the bootstrap keys this reader fetches.' } },
  imf: { summary: 'IMF macro datasets: macro, growth, labor and external accounts.', args: { keys: 'Fixed list of the bootstrap keys this reader fetches.' } },
};

function describedSectionArguments(section: CountryReader): Record<string, unknown> {
  const schema = z.toJSONSchema(COUNTRY_READERS[section].args, { io: 'input' }) as Record<string, unknown>;
  const docs = COUNTRY_SECTION_DOCS[section];
  const properties = { ...((schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {}) };
  for (const field of Object.keys(properties)) {
    const text = docs.args[field];
    if (!text) throw new Error(`api/mcp/registry/country-view.ts: section "${section}" argument "${field}" has no description in COUNTRY_SECTION_DOCS`);
    properties[field] = { ...properties[field], description: text };
  }
  return { ...schema, description: `Arguments for the ${section} section.`, properties };
}

// One shared deadline covers signing, waiting for a slot, fetch and body reads.
async function beforeSignalsDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function collectRawSignals(countryCode: string, base: string, context: Parameters<typeof buildAuthHeaders>[0], execution: Parameters<typeof fetchMcpDownstream>[2]) {
  const cancellation = new AbortController();
  const deadline = AbortSignal.any([cancellation.signal, AbortSignal.timeout(15_000)]);
  const sources = {} as RawSignalsValue['sources'];
  let next = 0;
  const worker = async () => {
    while (next < RAW_SIGNAL_FAMILIES.length) {
      const family = RAW_SIGNAL_FAMILIES[next++]!;
      try {
        deadline.throwIfAborted();
        const url = `${base}${RAW_SIGNAL_READS[family]}`;
        const headers = await beforeSignalsDeadline(buildAuthHeaders(context, 'GET', url, null), deadline);
        deadline.throwIfAborted();
        const responsePromise = fetchMcpDownstream(url, { headers: { ...headers, 'User-Agent': 'WorldMonitor-MCP/1.0' }, signal: deadline }, execution);
        void responsePromise.then(response => { if (deadline.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
        const response = await beforeSignalsDeadline(responsePromise, deadline);
        throwIfBillingDenial(response, family);
        if (response.status === 401 || response.status === 403) {
          void response.body?.cancel().catch(() => {});
          sources[family] = failedRawSignal(family, 'locked', new Date().toISOString(), 'This connection is not authorized for this source.') as never;
          continue;
        }
        const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal: deadline });
        await beforeSignalsDeadline(assertToolFetchOk({ ok: response.ok, status: response.status, headers: response.headers, body }, family, { preserveBackoff: true }), deadline);
        const bytes = await beforeSignalsDeadline(readBoundedResponseBody({ headers: response.headers, body }, RAW_SIGNAL_BODY_BYTES), deadline);
        deadline.throwIfAborted();
        sources[family] = validateRawSignal(family, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), new Date().toISOString()) as never;
      } catch (error) {
        if (error instanceof BillingDenialError) { cancellation.abort(error); throw error; }
        sources[family] = failedRawSignal(family, 'unavailable', new Date().toISOString(), deadline.aborted ? 'The shared source deadline expired. Retry or refresh to recover.' : 'Source observations are unavailable or malformed. Retry or refresh to recover.') as never;
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const retrievedAt = new Date().toISOString();
  const result = assembleRawSignals(countryCode, sources, retrievedAt);
  if (new TextEncoder().encode(JSON.stringify(result)).length <= RAW_SIGNAL_ENVELOPE_BYTES) return result;
  // No positive original can be saved when attribution-bearing evidence overflows.
  for (const family of RAW_SIGNAL_FAMILIES) {
    if (sources[family].state !== 'locked') sources[family] = failedRawSignal(family, 'unavailable', retrievedAt, 'The assembled source evidence exceeds the country section limit.') as never;
  }
  return assembleRawSignals(countryCode, sources, retrievedAt);
}

export const COUNTRY_VIEW_TOOLS: ToolDef[] = [{
  name: 'open_country_brief',
  title: 'Open the interactive country brief view',
  _subscriptionOnly: true,
  description: 'Open the interactive WorldMonitor country brief for one country and return {countryCode, topic, panelRequest}; the host renders the embedded view, which then loads its assessment, source evidence, resilience, security, economy, resources and society sections progressively over the authenticated connection. The tool itself returns only the resolved country and topic: no assessment text, scores or section data reach the caller. topic (default overview) selects which section group the view opens on. Requires a paid plan; weight 2 on API plans. On dedicated paid plans one country request covers the view\'s internal section loads, same-country opens reuse it for five minutes, and refresh with request_id starts a new request. Read-only.',
  _uiResourceUri: COUNTRY_VIEW_UI_URI,
  _openaiEntrypoints: [{ type: 'global' }, { type: 'thread' }],
  _outputBudgetBytes: 4096,
  _apiPaths: [],
  inputSchema: {
    type: 'object',
    properties: {
      country_code: { type: 'string', minLength: 2, maxLength: 100, description: 'Country name or ISO2 code.' },
      topic: { type: 'string', enum: Object.keys(BRIEF_TOPICS), description: 'Section group the view opens on: overview (default), all, resilience, security, economy (economy and trade), resources (resources and infrastructure), society or sources.' },
      request_id: { type: 'string', format: 'uuid', description: 'Stable ID for an explicit refresh. Retries with the same ID share one paid admission.' },
      refresh: { type: 'boolean', description: 'Start a new paid panel request and refresh loaded observations. Default false reuses the current same-country request.' },
    },
    required: ['country_code'],
  },
  outputSchema: {
    type: 'object',
    properties: { countryCode: { type: 'string' }, topic: { type: 'string', enum: Object.keys(BRIEF_TOPICS) }, panelRequest: z.toJSONSchema(panelAdmissionSchema) },
    required: ['countryCode', 'topic'],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _validateArgs: countryViewArguments,
  _execute: async (params, _base, _context, execution) => {
    return { ...countryViewArguments(params), ...(execution?.panelRequest ? { panelRequest: execution.panelRequest } : {}) };
  },
}, {
  name: 'get_country_brief_section',
  title: 'Structured country data, one section',
  description: 'Read one named structured data section for a country, raw values without narrative, and return {state: ready|locked|unavailable, section, value, retrievedAt, reason}. 37 readers selected by section: country facts and risk, energy and maritime, markets, trade, supply chain, resilience and demographics, defense, China signals, housing and IMF macro, military flights, AIS vessels, the USNI fleet report and signalsRaw; each oneOf branch documents one section. Each section takes its own arguments object (key names differ: country_code, countryCode or iso2; numeric M49 codes for trade; HS codes for products) and rejects unknown keys. flights pages 100 rows at a time through cursor. signalsRaw returns attributed earthquake, Internet-outage, travel-advisory and thermal samples and needs a verified same-country paid panel token; every other section works with an ordinary paid credential. Unavailable evidence is unknown, not zero. Requires a paid plan; one downstream read, weight 2 on API plans.',
  _subscriptionOnly: true,
  _weight: 2,
  _outputBudgetBytes: COUNTRY_SECTION_BUDGET_BYTES,
  _apiPaths: [...new Set([...Object.entries(COUNTRY_READERS).filter(([section, reader]) => section !== 'signalsRaw' && reader.path !== '/api/bootstrap').map(([, reader]) => `GET ${reader.path}`), ...Object.values(RAW_SIGNAL_READS).map(path => `GET ${path.split('?')[0]}`)])],
  _attribution: 'value.sources.*.{attribution: attribution}',
  inputSchema: {
    type: 'object',
    properties: {
      panel_request: { type: 'string', maxLength: 160, description: 'Server-issued paid country-panel request token. Only the embedded country view supplies this.' },
      section: { type: 'string', enum: Object.keys(COUNTRY_READERS), description: 'Which of the 37 fixed readers to run; each oneOf branch below documents one. signalsRaw requires a verified paid country-panel receipt and a matching arguments.country_code.' },
      arguments: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] }, description: 'Arguments for the chosen section, as the matching oneOf branch defines them (key names differ per section and unknown keys are rejected). Omit for sections that take none.' },
    },
    required: ['section'],
    oneOf: (Object.keys(COUNTRY_READERS) as CountryReader[]).map((section) => {
      const args = describedSectionArguments(section);
      return {
        properties: { section: { const: section, description: COUNTRY_SECTION_DOCS[section].summary }, arguments: args },
        ...((args.required as string[] | undefined)?.length ? { required: ['arguments'] } : {}),
      };
    }),
  },
  outputSchema: {
    type: 'object',
    properties: {
      state: { type: 'string', enum: ['ready', 'locked', 'unavailable'] },
      section: { type: 'string', enum: Object.keys(COUNTRY_READERS) },
      value: { type: 'object' }, retrievedAt: { type: 'string' }, reason: { type: 'string' },
    },
    required: ['state', 'section'],
    anyOf: [
      { properties: { section: { not: { const: 'signalsRaw' } } } },
      { properties: { value: {
        type: 'object',
        properties: {
          countryCode: { type: 'string', pattern: '^[A-Z]{2}$' },
          sources: {
            type: 'object',
            propertyNames: { enum: [...RAW_SIGNAL_FAMILIES] },
            additionalProperties: {
              type: 'object',
              properties: {
                state: { type: 'string', enum: ['observed', 'locked', 'unavailable'] },
                records: { type: ['array', 'null'], items: { type: 'object' } },
                partial: { type: 'boolean' }, scope: { type: 'string' }, attribution: { type: 'string' },
                snapshotAt: { type: ['string', 'null'] }, computationAt: { type: ['string', 'null'] },
                observationWindow: { type: ['string', 'null'] }, sourceVersion: { type: ['string', 'null'] },
                retrievedAt: { type: 'string' }, reason: { type: 'string' },
              },
              required: ['state', 'records', 'partial', 'scope', 'attribution', 'snapshotAt', 'computationAt', 'observationWindow', 'sourceVersion', 'retrievedAt'],
            },
            required: [...RAW_SIGNAL_FAMILIES],
          },
          missing: { type: 'array', items: { type: 'string', enum: [...RAW_SIGNAL_FAMILIES] }, maxItems: 4 },
        },
        required: ['countryCode', 'sources', 'missing'],
      } }, required: ['value'] },
    ],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  _validateArgs: countrySectionArguments,
  _execute: async (params, base, context, execution) => {
    const { parsed, section, reader, args } = countrySectionArguments(params);
    if (section === 'countrySignals') {
      const values = args.data as { country_code: string; family: string; window_index: number; cursor: string };
      if (execution?.countryPanelCode !== values.country_code) throw new RpcValidationError('get_country_brief_section', [{ field: 'panel_request', description: 'Country Signals require a verified same-country panel read.' }]);
      const deadline = AbortSignal.timeout(15_000);
      const query = new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)]));
      const url = `${base}${reader.path}?${query}`;
      const headers = await beforeSignalsDeadline(buildAuthHeaders(context, 'GET', url, null), deadline);
      deadline.throwIfAborted();
      const pending = fetchMcpDownstream(url, { headers: { ...headers, 'User-Agent': 'WorldMonitor-MCP/1.0' }, signal: deadline }, execution);
      void pending.then(response => { if (deadline.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
      const response = await beforeSignalsDeadline(pending, deadline);
      throwIfBillingDenial(response, section);
      if (response.status === 401 || response.status === 403) {
        void response.body?.cancel().catch(() => {});
        return { state: 'locked', section, reason: 'This connection is not authorized for this section.' };
      }
      const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal: deadline });
      const bytes = await beforeSignalsDeadline(readBoundedResponseBody({ headers: response.headers, body }, COUNTRY_SIGNAL_BYTES), deadline);
      deadline.throwIfAborted();
      if (!response.ok) throw new Error(`Country Signals HTTP ${response.status}`);
      const value = countrySignalResponseSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (value.countryCode !== values.country_code || value.family !== values.family || value.windowIndex !== values.window_index) throw new Error('Country signal response identity mismatch');
      if (values.family === 'COUNTRY_SIGNAL_FAMILY_FLIGHT_PAGE') { if (!value.flightPage || value.outcomeJson) throw new Error('Invalid flight page'); }
      else { const outcome = countrySignalOutcomeSchema.parse(JSON.parse(value.outcomeJson)); if (outcome.countryCode !== values.country_code || `COUNTRY_SIGNAL_FAMILY_${outcome.family.toUpperCase()}` !== values.family) throw new Error('Country family identity mismatch'); }
      deadline.throwIfAborted();
      return { section, state: 'ready', value, retrievedAt: new Date().toISOString() };
    }
    if (section === 'signalsRaw') {
      const countryCode = (args.data as { country_code: string }).country_code;
      if (execution?.countryPanelCode !== countryCode) throw new RpcValidationError('get_country_brief_section', [{ field: 'panel_request', description: 'Raw Signals require a verified paid country panel read.' }]);
      return collectRawSignals(countryCode, base, context, execution);
    }
    const bootstrapKeys = reader.path === '/api/bootstrap' && 'keys' in args.data ? args.data.keys.split(',') : undefined;
    const queries = bootstrapKeys
      ? bootstrapKeys.map(key => new URLSearchParams({ keys: key, public: '1' }))
      : [new URLSearchParams(Object.entries(args.data).map(([key, value]) => [key, String(value)]))];
    const results = await Promise.allSettled(queries.map(async query => {
      if (['pipelineDetail', 'facilityDetail', 'shortageDetail'].includes(section)) query.delete('country_code');
      const url = `${base}${reader.path}${query.size ? `?${query}` : ''}`;
      const headers = bootstrapKeys ? {} : await buildAuthHeaders(context, 'GET', url, null);
      const response = await fetchMcpDownstream(url, { headers: { ...headers, 'User-Agent': 'WorldMonitor-MCP/1.0' }, signal: AbortSignal.timeout(15_000) }, execution);
      throwIfBillingDenial(response, section);
      if (response.status === 401 || response.status === 403) return null;
      await assertToolFetchOk(response, section, { preserveBackoff: true });
      return bootstrapKeys
        ? z.object({ data: z.record(z.string(), z.unknown()), missing: z.array(z.string()) }).parse(JSON.parse(new TextDecoder().decode(await readBoundedResponseBody(response, COUNTRY_SECTION_BUDGET_BYTES))))
        : ['pipelines', 'facilities', 'shortages', 'pipelineDetail', 'facilityDetail', 'shortageDetail'].includes(section)
          ? JSON.parse(new TextDecoder().decode(await readBoundedResponseBody(response, COUNTRY_SECTION_BUDGET_BYTES)))
          : response.json();
    }));
    const denial = results.find(result => result.status === 'rejected' && result.reason instanceof BillingDenialError);
    if (denial?.status === 'rejected') throw denial.reason;
    if (results.some(result => result.status === 'fulfilled' && result.value === null)) return { state: 'locked', section, reason: 'This connection is not authorized for this section.' };
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected' && (!bootstrapKeys || results.every(result => result.status === 'rejected'))) throw failure.reason;
    const values = results.map(result => result.status === 'fulfilled' ? result.value : undefined);
    const retrievedAt = new Date().toISOString();
    let value = values[0];
    if (bootstrapKeys) {
      const data: Record<string, unknown> = {};
      const missing: string[] = [];
      values.forEach((body, index) => {
        const key = bootstrapKeys[index]!;
        if (body === undefined) { missing.push(key); return; }
        const result = body;
        if (result.missing.includes(key) || result.data[key] === undefined || result.data[key] === null) missing.push(key);
        else {
          const candidate = { ...data, [key]: result.data[key] };
          const candidateMissing = bootstrapKeys.filter(name => !(name in candidate));
          const candidateResult = { state: 'ready', section, value: { data: candidate, missing: candidateMissing }, retrievedAt };
          if (new TextEncoder().encode(JSON.stringify(candidateResult)).byteLength > COUNTRY_SECTION_BUDGET_BYTES) missing.push(key);
          else data[key] = result.data[key];
        }
      });
      if (!Object.keys(data).length) {
        if (failure?.status === 'rejected') throw failure.reason;
        return { state: 'unavailable', section, reason: 'These country datasets are currently unavailable.' };
      }
      value = { data, missing };
    }
    if (['pipelineDetail', 'facilityDetail', 'shortageDetail'].includes(section)) {
      const country = parsed.data.arguments?.country_code;
      const asset = section === 'pipelineDetail' ? value?.pipeline : section === 'facilityDetail' ? value?.facility : value?.shortage;
      const belongs = section === 'pipelineDetail' ? asset && (asset.fromCountry === country || asset.toCountry === country || asset.transitCountries?.includes(country)) : asset?.country === country;
      const requestedId = parsed.data.arguments?.pipelineId ?? parsed.data.arguments?.facilityId ?? parsed.data.arguments?.shortageId;
      if (!asset || asset.id !== requestedId || value?.unavailable || !belongs) return { state: 'unavailable', section, reason: 'This asset detail is unavailable for the selected country.' };
    }
    if (section === 'flights' && (!Array.isArray(value?.flights) || (!value.flights.length && !(parsed.data.arguments?.cursor && value.pagination?.totalCount > 0)))) return { state: 'unavailable', section, reason: 'Flight observations are unavailable or unconfirmed. An empty provider response is not evidence of zero activity.' };
    if (section === 'fleet' && !value?.report) return { state: 'unavailable', section, reason: 'The reported fleet roster is unavailable.' };
    if (section === 'vessels' && (!value?.dataAvailable || !value.snapshot?.status?.connected || !Number.isFinite(value.snapshot.snapshotAt) || value.snapshot.snapshotAt <= 0 || Date.now() - value.snapshot.snapshotAt > 3_600_000 || value.snapshot.snapshotAt > Date.now() + 300_000)) return { state: 'unavailable', section, reason: 'The live AIS snapshot is unavailable or stale.' };
    return { state: 'ready', section, value, retrievedAt };
  },
}];
