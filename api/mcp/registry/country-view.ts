import { z } from 'zod';
import { RAW_SIGNAL_READS, RAW_SIGNAL_FAMILIES, RAW_SIGNAL_BODY_BYTES, RAW_SIGNAL_ENVELOPE_BYTES, failedRawSignal, validateRawSignal, assembleRawSignals, type RawSignalsValue } from '../../../shared/country-raw-signals';
import { COUNTRY_READERS, countryReaderSchema, countryViewSchema, panelAdmissionSchema } from '../../../shared/country-brief-host';
import { BRIEF_TOPICS } from '../../../shared/country-brief-sections';
import { resolveCountryCode } from '../../../shared/country-code-resolve';
import { buildAuthHeaders } from '../auth';
import { assertToolFetchOk, BillingDenialError, RpcValidationError, throwIfBillingDenial } from '../billing-denial';
import { readBoundedResponseBody } from '../bounded-body';
import { fetchMcpDownstream } from '../downstream';
import type { ToolDef } from '../types';
import { COUNTRY_VIEW_UI_URI } from '../ui/news-dashboard-app';

const COUNTRY_SECTION_BUDGET_BYTES = 524288;

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
  title: 'WorldMonitor country brief',
  _subscriptionOnly: true,
  description: 'Open the interactive WorldMonitor country brief with its assessment, source evidence, resilience, energy, trade and security sections. Use for country brief requests and follow-up topic navigation. On dedicated paid MCP plans, one country request includes its internal section loads. Same-country opens reuse the request for five minutes. Explicit refresh starts a new request. API plans retain per-tool weighted billing. The interface loads sections progressively through the authenticated connection. Section availability and dates are shown in the view. Use get_country_brief only when the user explicitly wants a text assessment.',
  _uiResourceUri: COUNTRY_VIEW_UI_URI,
  _openaiEntrypoints: [{ type: 'global' }, { type: 'thread' }],
  _outputBudgetBytes: 4096,
  _apiPaths: [],
  inputSchema: {
    type: 'object',
    properties: {
      country_code: { type: 'string', minLength: 2, maxLength: 100, description: 'Country name or ISO2 code.' },
      topic: { type: 'string', enum: Object.keys(BRIEF_TOPICS) },
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
  _execute: async (params, _base, _context, execution) => {
    const parsed = countryViewSchema.safeParse(Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'jmespath')));
    const countryCode = parsed.success ? resolveCountryCode(parsed.data.country_code) : null;
    if (!parsed.success || !countryCode) throw new RpcValidationError('open_country_brief', [{ field: 'country_code', description: 'Supply a recognized country and topic.' }]);
    return { countryCode, topic: parsed.data.topic, ...(execution?.panelRequest ? { panelRequest: execution.panelRequest } : {}) };
  },
}, {
  name: 'get_country_brief_section',
  description: 'Read a fixed country-view dataset for the embedded country brief. Reviewed readers include military flights, AIS, fleet reports and Atlas assets. signalsRaw requires a verified same-country paid panel receipt and returns attributed earthquake, Internet outage, travel advisory and thermal samples through four fixed authorized GETs. Unavailable evidence is unknown, not zero; sample scope and unknown clocks remain explicit. Flight coverage follows provider redistribution permissions. Returns a ready, locked or unavailable state. Native dates remain in value; retrievedAt records retrieval. Does not accept URLs, headers or arbitrary RPC paths.',
  _subscriptionOnly: true,
  _weight: 2,
  _outputBudgetBytes: COUNTRY_SECTION_BUDGET_BYTES,
  _apiPaths: [...new Set([...Object.entries(COUNTRY_READERS).filter(([section, reader]) => section !== 'signalsRaw' && reader.path !== '/api/bootstrap').map(([, reader]) => `GET ${reader.path}`), ...Object.values(RAW_SIGNAL_READS).map(path => `GET ${path.split('?')[0]}`)])],
  _attribution: 'value.sources.*.{attribution: attribution}',
  inputSchema: {
    type: 'object',
    properties: {
      panel_request: { type: 'string', maxLength: 160, description: 'Server-issued paid country-panel request token. Only the embedded country view supplies this.' },
      section: { type: 'string', enum: Object.keys(COUNTRY_READERS), description: 'Closed country reader name. signalsRaw requires a verified paid country-panel receipt and matching arguments.country_code.' },
      arguments: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
    },
    required: ['section'],
    oneOf: Object.entries(COUNTRY_READERS).map(([section, reader]) => ({
      properties: { section: { const: section }, arguments: z.toJSONSchema(reader.args) },
    })),
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
      } } },
    ],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  _execute: async (params, base, context, execution) => {
    const parsed = countryReaderSchema.safeParse(Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'jmespath')));
    if (!parsed.success) throw new RpcValidationError('get_country_brief_section', [{ field: 'section', description: 'Unknown country section reader.' }]);
    const { section } = parsed.data;
    const reader = COUNTRY_READERS[section];
    const args = reader.args.safeParse(parsed.data.arguments);
    if (!args.success) throw new RpcValidationError('get_country_brief_section', [{ field: 'arguments', description: 'Invalid arguments for this country section.' }]);
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
