/**
 * Live tariff lookups: thin wrappers over the three Pro trade routes that
 * answer "what does country A charge on goods from country B".
 *
 *   get_tariff_averages  -> GET /api/trade/v1/get-tariff-trends
 *   get_bilateral_tariff -> GET /api/trade/v1/get-bilateral-tariff
 *   get_us_import_duty   -> GET /api/trade/v1/get-us-import-duty
 *
 * Each tool signs one gateway fetch and adds a `coverage` object to the route's
 * answer. Fault and caching rules live in the handlers only. The US MFN
 * series is served here only: the free-account `get_price_and_debt_indicators`
 * bundle (formerly get_tariff_trends) dropped it (#9301).
 *
 * Upstream budget: these routes read WITS or USITC on a cache miss. Over MCP
 * that work is bounded by the caller's own metering (Pro daily quota, or 2
 * units per call on an API plan) plus the per-principal rate limit, the same
 * budget their REST callers spend.
 */
import { resolveCountryCode } from '../../../shared/country-code-resolve';
import UN_TO_ISO2 from '../../../shared/un-to-iso2.json';
import { M49_TO_WTO_CODE, PRODUCT_GROUPS } from '../../../server/worldmonitor/trade/v1/_tradestats-tariff';
import { COUNTRY_ARG_HINT, echoCountryInput } from '../_country-args';
import { buildAuthHeaders } from '../auth';
import { RpcValidationError } from '../billing-denial';
import { assertMcpToolFetchOk, fetchMcpDownstream } from '../downstream';
import type { ToolDef } from '../types';

const WORLD_CODE = '000';
const EU_CODE = '918';

const ISO2_TO_UN: ReadonlyMap<string, string> = new Map(
  Object.entries(UN_TO_ISO2 as Record<string, string>).map(([un, iso2]) => [iso2, un]),
);

const COUNTRY_CODE_HINT = `A 3-digit UN M49 code ("840") is passed through unchanged. ${COUNTRY_ARG_HINT}`;

/**
 * The 3-digit code a trade route expects. Three digits pass through, so WTO
 * codes (699 India, 251 France) and the EU (918) still work; anything else is
 * resolved as a country designator and mapped to UN M49.
 */
export function tradeCountryCode(
  raw: unknown,
  operation: string,
  field: string,
  opts: { allowWorld?: boolean; allowEu?: boolean } = {},
): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (/^[0-9]{3}$/.test(text)) return text;
  const lower = text.toLowerCase();
  if (opts.allowWorld && (lower === 'world' || lower === 'wld')) return WORLD_CODE;
  if (opts.allowEu && (lower === 'eu' || lower === 'eun' || lower === 'european union')) return EU_CODE;
  const iso2 = text ? resolveCountryCode(text) : null;
  const un = iso2 ? ISO2_TO_UN.get(iso2) : undefined;
  if (un) return un;
  throw new RpcValidationError(operation, [{
    field,
    description: `Could not resolve ${JSON.stringify(echoCountryInput(raw))} to a country. ${COUNTRY_CODE_HINT}`,
  }]);
}

/** Digits of an HS code, with the dots and spaces people write it with removed. */
export function hsDigits(raw: unknown, operation: string, pattern: RegExp, expected: string): string {
  const digits = typeof raw === 'string' || typeof raw === 'number'
    ? String(raw).replace(/[\s.]/g, '')
    : '';
  if (pattern.test(digits)) return digits;
  throw new RpcValidationError(operation, [{
    field: 'hs_code',
    description: `hs_code must be ${expected}; got ${JSON.stringify(echoCountryInput(typeof raw === 'number' ? String(raw) : raw))}.`,
  }]);
}

function optionalInt(raw: unknown, operation: string, field: string, min: number, max: number): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isInteger(n) && n >= min && n <= max) return n;
  throw new RpcValidationError(operation, [{
    field,
    description: `${field} must be an integer from ${min} to ${max}.`,
  }]);
}

const RATE_DETAIL_SCHEMA = {
  type: 'object',
  properties: {
    rate: { type: 'number', description: 'Simple average ad valorem rate over the lines, percent.' },
    minRate: { type: 'number' },
    maxRate: { type: 'number' },
    tariffLines: { type: 'number', description: 'National tariff lines under the HS6 code. 0 means this rate is absent.' },
    nonAdValoremLines: { type: 'number', description: 'Lines with a specific or compound duty that the average leaves out.' },
  },
};

const PRODUCT_GROUP_VALUES = ['all', ...PRODUCT_GROUPS];
const PRODUCT_GROUP_BY_LOWER = new Map(PRODUCT_GROUP_VALUES.map((g) => [g.toLowerCase(), g]));

/**
 * get-tariff-trends serves the MFN series from a seed keyed by WTO codes, which
 * differ from UN M49 for France, Norway, India and Switzerland. The WITS path
 * accepts both, so the WTO code is safe on either series.
 */
function tariffTrendsCountryCode(
  raw: unknown,
  operation: string,
  field: string,
  opts: { allowWorld?: boolean; allowEu?: boolean },
): string {
  const code = tradeCountryCode(raw, operation, field, opts);
  return M49_TO_WTO_CODE[code] ?? code;
}

/** WITS's spelling of a product group, '' for every product, or Invalid params. */
function productGroupParam(raw: unknown, operation: string): string {
  if (raw === undefined || raw === null || raw === '') return '';
  const group = typeof raw === 'string' ? PRODUCT_GROUP_BY_LOWER.get(raw.trim().toLowerCase()) : undefined;
  if (group === undefined) {
    throw new RpcValidationError(operation, [{
      field: 'product_group',
      description: `product_group must be "all" or a WITS product group such as "84-85_MachElec" or "Textiles"; got ${JSON.stringify(echoCountryInput(raw))}.`,
    }]);
  }
  return group === 'all' ? '' : group;
}

// ---------------------------------------------------------------------------
// coverage: what answered and where it stops, in data rather than prose.
//
// The two schedule tools answer from WTO/WITS schedules with dataset-specific
// coverage and never carry Section 301 or 232 duties; get_us_import_duty answers from
// the live HTS with them. An agent that reads only the payload must still be
// able to tell those apart, so every answer except an upstream outage
// (upstreamUnavailable: true, which answers nothing) carries `coverage`.
// It is added here, at the MCP layer, because the route bodies are shared
// with REST callers whose OpenAPI contract does not include it.
// ---------------------------------------------------------------------------

const US_CODE = '840';
const SCHEDULE_EXCLUDED_DUTIES = ['SECTION_301', 'SECTION_232', 'IEEPA', 'ANTI_DUMPING', 'COUNTERVAILING'];
const US_DUTY_EXCLUDED_DUTIES = ['IEEPA', 'ANTI_DUMPING', 'COUNTERVAILING'];
const US_SEE_ALSO = {
  tool: 'get_us_import_duty',
  reason: 'Schedule rates leave out Section 301 and 232 duties; get_us_import_duty returns the US duty in force, including them.',
};

type CoverageRequest =
  | { tool: 'get_tariff_averages'; reporter: string; partner: string; productGroup: string }
  | { tool: 'get_bilateral_tariff'; reporter: string }
  | { tool: 'get_us_import_duty' };

function positiveYear(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function newestDatapointYear(datapoints: unknown): number | undefined {
  if (!Array.isArray(datapoints)) return undefined;
  let newest: number | undefined;
  for (const point of datapoints) {
    const year = positiveYear((point as { year?: unknown } | null)?.year);
    if (year !== undefined && (newest === undefined || year > newest)) newest = year;
  }
  return newest;
}

/** The `coverage` object for one successful tariff answer. */
export function buildCoverage(request: CoverageRequest, body: Record<string, unknown>): Record<string, unknown> {
  if (request.tool === 'get_us_import_duty') {
    const asOf = typeof body.htsRelease === 'string' && body.htsRelease !== '' ? body.htsRelease : undefined;
    // Chapter 99 duties are joined from a seeded catalog; unless the route
    // confirms it was read, the answer is base rates only and must not claim them.
    const loaded = body.additionalDutiesLoaded === true;
    return {
      dataset: 'USITC_HTS',
      rateBasis: 'CURRENT_DUTY',
      includesUnilateralDuties: loaded,
      excludedDutyTypes: loaded ? [...US_DUTY_EXCLUDED_DUTIES] : ['SECTION_301', 'SECTION_232', ...US_DUTY_EXCLUDED_DUTIES],
      ...(asOf !== undefined ? { asOf } : {}),
    };
  }
  let dataset = 'WITS_TRAINS';
  let latestYear: number | undefined;
  if (request.tool === 'get_tariff_averages') {
    if ((request.partner === '' || request.partner === WORLD_CODE) && request.productGroup === '') dataset = 'WTO_MFN';
    latestYear = positiveYear(body.coverageEndYear) ?? newestDatapointYear(body.datapoints);
  } else {
    latestYear = positiveYear(body.year);
  }
  return {
    dataset,
    rateBasis: 'SCHEDULE',
    includesUnilateralDuties: false,
    excludedDutyTypes: [...SCHEDULE_EXCLUDED_DUTIES],
    ...(latestYear !== undefined ? { latestYear } : {}),
    ...(request.reporter === US_CODE ? { seeAlso: { ...US_SEE_ALSO } } : {}),
  };
}

function coverageSchema(vintage: 'latestYear' | 'asOf'): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    dataset: { type: 'string', enum: vintage === 'asOf' ? ['USITC_HTS'] : ['WTO_MFN', 'WITS_TRAINS'], description: 'Dataset consulted; check unavailableReason before trusting the rates.' },
    rateBasis: { type: 'string', enum: vintage === 'asOf' ? ['CURRENT_DUTY'] : ['SCHEDULE'], description: 'SCHEDULE: a tariff schedule rate. CURRENT_DUTY: the duty in force today.' },
    includesUnilateralDuties: { type: 'boolean', description: 'Whether Section 301 and 232 duties are in the answer.' },
    excludedDutyTypes: { type: 'array', items: { type: 'string' }, description: 'Duty types the answer leaves out, e.g. SECTION_301, IEEPA, ANTI_DUMPING.' },
  };
  if (vintage === 'asOf') {
    properties.asOf = { type: 'string', description: 'HTS revision that answered. Absent when the route named none.' };
  } else {
    properties.latestYear = { type: 'number', description: 'Newest year in the answer. Absent when no year answered.' };
    properties.seeAlso = {
      type: 'object',
      description: 'Present when the reporter is the United States: the tool that returns the current US duty.',
      properties: { tool: { type: 'string' }, reason: { type: 'string' } },
      required: ['tool', 'reason'],
      additionalProperties: false,
    };
  }
  return {
    type: 'object',
    description: 'What answered and where it stops. Added by the MCP server on every answer except upstream outages.',
    properties,
    required: ['dataset', 'rateBasis', 'includesUnilateralDuties', 'excludedDutyTypes'],
    additionalProperties: false,
  };
}

export const TARIFF_TOOLS: ToolDef[] = [
  {
    name: 'get_tariff_averages',
    _validateArgs: params => {
      if (params.reporter !== undefined && params.reporter !== '') tradeCountryCode(params.reporter, 'get-tariff-averages', 'reporter', { allowEu: true });
      if (params.partner !== undefined && params.partner !== '') tradeCountryCode(params.partner, 'get-tariff-averages', 'partner', { allowWorld: true });
    },
    title: 'Average tariff rates',
    _outputBudgetBytes: 65536,
    description: 'Average tariff a country applies by year: schedule rates, no Section 301/232 duties. Read coverage.dataset and coverage.latestYear for the answering series and its latest year. With no partner and no product group it is the WTO MFN average over all products (TP_A_0010). With a partner other than World, or a product group, it is the effectively applied average from UNCTAD TRAINS via World Bank WITS: tariffRate is the simple average (AHS-SMPL-AVRG, preferences counted), weightedRate the import-weighted one. WTO MFN years follow the seeded provider series. WITS coverage varies by reporter, starting around 1990; US preferences are reported only through 2021. These are schedule rates: Section 301, 232 and other unilateral duties are NOT included. unavailableReason NOT_COVERED is a coverage answer; UPSTREAM_UNAVAILABLE is a fault worth retrying later.',
    inputSchema: {
      type: 'object',
      properties: {
        reporter: { type: 'string', description: `Importing country. Defaults to the United States (840). The EU ("EU" or 918) is accepted. France, Norway, India and Switzerland are sent as their WTO codes (251, 579, 699, 757), which key the MFN series. ${COUNTRY_CODE_HINT}` },
        partner: { type: 'string', description: `Exporting country whose goods are averaged. Omit, or pass "World" (000), for all partners. The EU is not a partner in this dataset. ${COUNTRY_CODE_HINT}` },
        product_group: {
          type: 'string',
          enum: PRODUCT_GROUP_VALUES,
          description: 'WITS product group: an HS section range such as "84-85_MachElec" or "50-63_TextCloth", or an aggregate such as "Textiles", "Food", "Fuels", "manuf". "all" or omitted means every product.',
        },
        years: { type: 'integer', minimum: 0, maximum: 30, description: 'Years to return, newest kept. 0 or omitted means the route default (10).' },
      },
      required: [],
    },
    // Mirrors GetTariffTrendsResponse; _execute adds only `coverage`.
    outputSchema: {
      type: 'object',
      properties: {
        datapoints: { type: 'array', items: { type: 'object', properties: {
          reportingCountry: { type: 'string' },
          partnerCountry: { type: 'string', description: 'The partner code, or "World".' },
          productSector: { type: 'string', description: '"All products", or the WITS product group.' },
          year: { type: 'number' },
          tariffRate: { type: 'number', description: 'Simple average, percent.' },
          boundRate: { type: 'number', description: 'Always 0: bound rates are not served.' },
          indicatorCode: { type: 'string', description: 'TP_A_0010 (WTO MFN) or AHS-SMPL-AVRG (WITS applied).' },
          weightedRate: { type: 'number', description: 'Import-weighted applied average, percent. 0 on the MFN series and where there were no imports.' },
        } } },
        fetchedAt: { type: 'string' },
        upstreamUnavailable: { type: 'boolean' },
        effectiveTariffRate: { type: 'object', description: 'US customs duties over goods imports (FRED). Only on the US MFN series.', properties: {
          sourceName: { type: 'string' },
          sourceUrl: { type: 'string' },
          observationPeriod: { type: 'string' },
          updatedAt: { type: 'string' },
          tariffRate: { type: 'number' },
        } },
        unavailableReason: { type: 'string', description: 'Empty or TARIFF_TREND_UNAVAILABLE_REASON_UNSPECIFIED when served; otherwise why not.' },
        coverageStartYear: { type: 'number' },
        coverageEndYear: { type: 'number' },
        coverage: coverageSchema('latestYear'),
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _execute: async (params, base, context, execution) => {
      const operation = 'get-tariff-trends';
      const reporter = params.reporter === undefined || params.reporter === ''
        ? US_CODE
        : tariffTrendsCountryCode(params.reporter, operation, 'reporter', { allowEu: true });
      const query = new URLSearchParams({ reporting_country: reporter });
      const partner = params.partner === undefined || params.partner === ''
        ? ''
        : tariffTrendsCountryCode(params.partner, operation, 'partner', { allowWorld: true });
      if (partner) query.set('partner_country', partner);
      const group = productGroupParam(params.product_group, operation);
      if (group) query.set('product_sector', group);
      const years = optionalInt(params.years, operation, 'years', 0, 30);
      if (years) query.set('years', String(years));

      const url = `${base}/api/trade/v1/get-tariff-trends?${query}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);
      const response = await fetchMcpDownstream(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(12_000),
      }, execution);
      await assertMcpToolFetchOk(response, { operation, tool: 'get_tariff_averages', auth: context, execution });
      const body = await response.json() as Record<string, unknown>;
      return { ...body, ...(body.upstreamUnavailable !== true ? { coverage: buildCoverage({ tool: 'get_tariff_averages', reporter, partner, productGroup: group }, body) } : {}) };
    },
    _apiPaths: [
      'GET /api/trade/v1/get-tariff-trends',
    ],
  },
  {
    name: 'get_bilateral_tariff',
    _validateArgs: params => {
      tradeCountryCode(params.reporter, 'get-bilateral-tariff', 'reporter', { allowEu: true });
      tradeCountryCode(params.partner, 'get-bilateral-tariff', 'partner');
      hsDigits(params.hs_code, 'get-bilateral-tariff', /^[0-9]{6}$/, '6 digits');
    },
    title: 'Product tariff between two countries',
    _outputBudgetBytes: 65536,
    description: 'Tariff on one HS6 product between two countries: schedule rate through 2023, no Section 301/232 duties. The rate one country applies to one 6-digit HS product from one partner, for one year, from UNCTAD TRAINS via World Bank WITS. appliedRate is what the partner pays: the best preferential rate it qualifies for, else MFN (basis says which). mfnRate and preferentialRate are reported separately, with mfnAveRate an ad valorem equivalent where the MFN duty is specific. EU members answer from the EU schedule (filingReporter 918). Year 0 means the latest year with data. Schedule rates only: Section 301, 232, anti-dumping and other unilateral duties are NOT included, and TRAINS has no US preferences after 2021 and no US data after 2023. NOT_COVERED is a coverage answer; UPSTREAM_UNAVAILABLE is a fault.',
    inputSchema: {
      type: 'object',
      properties: {
        reporter: { type: 'string', description: `Importing country. ${COUNTRY_CODE_HINT}` },
        partner: { type: 'string', description: `Exporting country. ${COUNTRY_CODE_HINT}` },
        hs_code: { type: 'string', description: '6-digit HS code, e.g. "870380" (dots are ignored: "8703.80").' },
        year: { type: 'integer', minimum: 0, maximum: 2100, description: 'Tariff year. 0 or omitted means the latest year with data.' },
      },
      required: ['reporter', 'partner', 'hs_code'],
    },
    // Mirrors GetBilateralTariffResponse; _execute adds only `coverage`.
    outputSchema: {
      type: 'object',
      properties: {
        reportingCountry: { type: 'string' },
        partnerCountry: { type: 'string' },
        hsCode: { type: 'string' },
        year: { type: 'number', description: 'The year that answered.' },
        nomenclature: { type: 'string', description: 'HS revision the reporter filed in, e.g. H6.' },
        basis: { type: 'string', description: 'APPLIED_TARIFF_BASIS_PREFERENTIAL, _MFN, or _MFN_PREFERENCES_NOT_REPORTED (no preferences on file for that year, so a preference may be missed).' },
        appliedRate: RATE_DETAIL_SCHEMA,
        mfnRate: RATE_DETAIL_SCHEMA,
        preferentialRate: RATE_DETAIL_SCHEMA,
        mfnAveRate: RATE_DETAIL_SCHEMA,
        groupPreferences: { type: 'array', items: { type: 'object', properties: {
          groupCode: { type: 'string' },
          groupName: { type: 'string' },
          rate: RATE_DETAIL_SCHEMA,
        } } },
        source: { type: 'string' },
        sourceUrl: { type: 'string' },
        upstreamUnavailable: { type: 'boolean' },
        unavailableReason: { type: 'string' },
        filingReporter: { type: 'string', description: 'Code whose schedule answered, e.g. 918 for an EU member.' },
        coverage: coverageSchema('latestYear'),
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _execute: async (params, base, context, execution) => {
      const operation = 'get-bilateral-tariff';
      const reporter = tradeCountryCode(params.reporter, operation, 'reporter', { allowEu: true });
      const query = new URLSearchParams({
        reporting_country: reporter,
        partner_country: tradeCountryCode(params.partner, operation, 'partner'),
        hs_code: hsDigits(params.hs_code, operation, /^[0-9]{6}$/, '6 digits'),
      });
      const year = optionalInt(params.year, operation, 'year', 0, 2100);
      if (year) query.set('year', String(year));

      const url = `${base}/api/trade/v1/get-bilateral-tariff?${query}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);
      // The route may read availability, the tariff rows and an AVE series in
      // turn on a cold cache.
      const response = await fetchMcpDownstream(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(25_000),
      }, execution);
      await assertMcpToolFetchOk(response, { operation, tool: 'get_bilateral_tariff', auth: context, execution });
      const body = await response.json() as Record<string, unknown>;
      return { ...body, ...(body.upstreamUnavailable !== true ? { coverage: buildCoverage({ tool: 'get_bilateral_tariff', reporter }, body) } : {}) };
    },
    _apiPaths: [
      'GET /api/trade/v1/get-bilateral-tariff',
    ],
  },
  {
    name: 'get_us_import_duty',
    _validateArgs: params => {
      tradeCountryCode(params.partner, 'get-us-import-duty', 'partner');
      hsDigits(params.hs_code, 'get-us-import-duty', /^[0-9]{6}([0-9]{2}){0,2}$/, '6, 8 or 10 digits');
    },
    title: 'US import duty for a product',
    _outputBudgetBytes: 131072,
    description: 'Return the current US import duty for one product from one country: the live USITC Harmonized Tariff Schedule rates for each 8-digit line under hs_code, plus the chapter 99 Section 301 and 232 duties in force. Each additional duty has a status of APPLIES, CONDITIONAL (condition says what decides it), EXEMPT or SCHEDULED; estimatedRate adds only APPLIES duties to the base rate, and estimateComplete is false when a specific duty, a condition or an unresolved preference program leaves it open. IEEPA, anti-dumping and countervailing duties are not included; additionalDutiesLoaded=false means only base rates were available. Requires a paid plan; one live USITC lookup, weight 2 on API plans. hs_code is 6, 8 or 10 digits; partner is an alpha-2, alpha-3, M49 code or country name. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        hs_code: { type: 'string', description: 'HTS code of 6, 8 or 10 digits, e.g. "870380" or "8703.80.00" (dots are ignored).' },
        partner: { type: 'string', description: `Country of origin. ${COUNTRY_CODE_HINT}` },
      },
      required: ['hs_code', 'partner'],
    },
    // Mirrors GetUsImportDutyResponse; _execute adds only `coverage`.
    outputSchema: {
      type: 'object',
      properties: {
        hsCode: { type: 'string' },
        partnerCountry: { type: 'string' },
        htsRelease: { type: 'string', description: 'HTS revision that answered, e.g. "2026 Revision 21".' },
        lines: { type: 'array', items: { type: 'object', properties: {
          htsCode: { type: 'string' },
          description: { type: 'string' },
          generalRate: { type: 'string' },
          specialRate: { type: 'string' },
          column2Rate: { type: 'string' },
          basis: { type: 'string', description: 'US_DUTY_BASIS_MFN, _PREFERENTIAL or _COLUMN_2.' },
          baseRate: { type: 'string' },
          baseAdValorem: { type: 'number' },
          baseNonAdValorem: { type: 'boolean' },
          preferenceProgram: { type: 'string', description: 'Special-column code that applies, e.g. "S" for USMCA.' },
          unresolvedPrograms: { type: 'array', items: { type: 'string' } },
          additionalDuties: { type: 'array', items: { type: 'object', properties: {
            heading: { type: 'string', description: 'Chapter 99 heading, e.g. 9903.91.03.' },
            authority: { type: 'string' },
            program: { type: 'string' },
            addedRate: { type: 'number' },
            topUpTo: { type: 'number', description: 'For a floor duty: the combined rate it raises the line to.' },
            status: { type: 'string' },
            condition: { type: 'string' },
            legalNote: { type: 'string' },
            effectiveFrom: { type: 'string' },
          } } },
          estimatedRate: { type: 'number' },
          estimateComplete: { type: 'boolean' },
        } } },
        additionalDutiesLoaded: { type: 'boolean' },
        source: { type: 'string' },
        sourceUrl: { type: 'string' },
        upstreamUnavailable: { type: 'boolean' },
        unavailableReason: { type: 'string' },
        coverage: coverageSchema('asOf'),
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _execute: async (params, base, context, execution) => {
      const operation = 'get-us-import-duty';
      const query = new URLSearchParams({
        hs_code: hsDigits(params.hs_code, operation, /^[0-9]{6}([0-9]{2}){0,2}$/, '6, 8 or 10 digits'),
        partner_country: tradeCountryCode(params.partner, operation, 'partner'),
      });
      const url = `${base}/api/trade/v1/get-us-import-duty?${query}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);
      const response = await fetchMcpDownstream(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(15_000),
      }, execution);
      await assertMcpToolFetchOk(response, { operation, tool: 'get_us_import_duty', auth: context, execution });
      const body = await response.json() as Record<string, unknown>;
      return { ...body, ...(body.upstreamUnavailable !== true ? { coverage: buildCoverage({ tool: 'get_us_import_duty' }, body) } : {}) };
    },
    // The seeded chapter 99 catalog the route joins with each live HTS read.
    _coverageKeys: [
      'trade:us-hts:catalog:v1',
    ],
    _apiPaths: [
      'GET /api/trade/v1/get-us-import-duty',
    ],
  },
];
