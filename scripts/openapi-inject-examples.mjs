#!/usr/bin/env node
/**
 * Inject generated request/response examples into the OpenAPI specs.
 *
 * protoc-gen-openapiv3 currently emits only shapes. Until the upstream plugin
 * grows proto message-level example support, this post-generation step derives
 * deterministic, schema-valid examples from the generated OpenAPI contract and
 * writes them into the generated artifacts. See umbrella issue #4599 and
 * workstream #4610.
 *
 * Artifacts:
 *   1. docs/api/<Service>.openapi.json - full examples, reserialized with the
 *      same sorted, Go-escaped JSON strategy used by openapi-inject-security.
 *   2. docs/api/<Service>.openapi.yaml - surgical example insertions so the
 *      Mintlify per-service docs carry request/response examples without
 *      reformatting the whole generated YAML file.
 *   3. docs/api/worldmonitor.openapi.yaml - same surgical insertion for the
 *      unified bundle copied to /openapi.yaml at build time.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sortRec, serialize, eq, normalizeKey } from './lib/openapi-codegen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const bundlePath = resolve(apiDir, 'worldmonitor.openapi.yaml');
const CHECK = process.argv.includes('--check');

const JSON_MEDIA = 'application/json';
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);
const MAX_OBJECT_DEPTH = 6;
const MAX_OPTIONAL_PROPERTIES = 5;

// ── Curated per-parameter example overrides ───────────────────────────────
// The field-name heuristic in stringExample() picks structurally-valid but
// semantically WRONG string examples for a handful of parameters whose accepted
// values the handlers enforce against server-side allowlists (chokepoint
// registry, scenario templates) or external providers (FRED series, Mode-S
// addresses). Those examples make the published request samples un-runnable —
// the handlers reject them. This map pins each to a real accepted value and
// takes precedence over the heuristic.
//
// Values are sourced from the same constants the handlers use wherever a
// machine-readable one exists, so the examples can't silently drift; only the
// two with no importable allowlist (a FRED series id, a sample Mode-S address)
// are literals. This script runs under plain `node` in the `make generate`
// codegen context, so it can't import the TypeScript modules — it reads the
// committed source/JSON directly. Every lookup falls back to a documented
// literal so codegen never breaks on a refactor.
function readRepoText(rel) {
  try {
    return readFileSync(resolve(root, rel), 'utf8');
  } catch {
    return '';
  }
}

const GIVING_PUBLISHED_ESTIMATE_CLAIMS = JSON.parse(
  readRepoText('scripts/shared/giving-published-estimate-claims.json'),
);

// chokepointId / chokepointIds: get-bypass-options & siblings (SupplyChain) and
// register-webhook (ShippingV2) validate against the chokepoint registry
// (VALID_CHOKEPOINT_IDS = CHOKEPOINT_REGISTRY ids). `intelligenceChokepointIds`
// in the shared filter contract is a machine-readable subset that always
// carries the canonical 'suez' id — use it as the drift-anchored source.
const CHOKEPOINT_EXAMPLE_ID = (() => {
  try {
    const contract = JSON.parse(readRepoText('shared/openapi-filter-param-contracts.json'));
    const ids = Array.isArray(contract.intelligenceChokepointIds) ? contract.intelligenceChokepointIds : [];
    return ids.includes('suez') ? 'suez' : (ids[0] ?? 'suez');
  } catch {
    return 'suez';
  }
})();

// scenarioId: run-scenario only accepts a registered SCENARIO_TEMPLATES id.
// scenario-templates.ts is a .ts module (uncompilable under plain node), so
// extract its ids from source text. The `id: '...'` shape only appears on the
// template literals (the interface uses `id: string;`, no quotes).
const SCENARIO_EXAMPLE_ID = (() => {
  const src = readRepoText('server/worldmonitor/supply-chain/v1/scenario-templates.ts');
  const ids = [...src.matchAll(/\bid:\s*['"`]([a-z0-9-]+)['"`]/g)].map((m) => m[1]);
  return ids.includes('hormuz-tanker-blockade') ? 'hormuz-tanker-blockade' : (ids[0] ?? 'hormuz-tanker-blockade');
})();

const SCENARIO_RESULT_AFFECTED_CHOKEPOINT_IDS = (() => {
  const src = readRepoText('server/worldmonitor/supply-chain/v1/scenario-templates.ts');
  const idMatch = src.match(new RegExp(`\\bid:\\s*['"\`]${SCENARIO_EXAMPLE_ID}['"\`]`));
  const start = idMatch ? src.lastIndexOf('{', idMatch.index) : -1;
  const end = start >= 0 ? src.indexOf('\n  },', start) : -1;
  const block = start >= 0 && end > start ? src.slice(start, end) : '';
  const affected = block.match(/affectedChokepointIds:\s*\[([^\]]*)\]/)?.[1] ?? '';
  const ids = [...affected.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  return ids;
})();

const SCENARIO_RESULT_TEMPLATE_NAME =
  SCENARIO_RESULT_AFFECTED_CHOKEPOINT_IDS.length > 0
    ? SCENARIO_RESULT_AFFECTED_CHOKEPOINT_IDS.join('+')
    : 'tariff_shock';

// FRED series id: get-fred-series reads a seeded series by id; the OpenAPI
// description lists GDP/UNRATE/CPIAUCSL. No importable allowlist (series live in
// the seed cache) — pin a real, well-known series. BLS get-bls-series carries a
// schema enum, so its series_id resolves upstream and never reaches this map.
const FRED_SERIES_EXAMPLE_ID = 'GDP';

// icao24 / icao24s: a 24-bit Mode-S address as lowercase 6-hex;
// get-wingbits-live-flight enforces /^[0-9a-f]{6}$/ and the aircraft-detail
// handlers lowercase it. No allowlist — pin a realistic sample address.
const ICAO24_EXAMPLE = 'a835af';

// baseline `type`: record-baseline-snapshot's BaselineUpdate.type is a bare
// string (no schema enum), so stringExample()'s endsWith('type') heuristic emits
// the literal 'all' — which record-baseline-snapshot.ts rejects (VALID_BASELINE_TYPES
// has no 'all'), silently skipping the update. Pin the first real accepted type,
// drift-anchored to the same contract the handler reads and matching the sibling
// GetTemporalBaseline enum example.
const BASELINE_TYPE_EXAMPLE_ID = (() => {
  try {
    const contract = JSON.parse(readRepoText('shared/openapi-filter-param-contracts.json'));
    const ids = Array.isArray(contract.infrastructureTemporalBaselineTypes) ? contract.infrastructureTemporalBaselineTypes : [];
    return ids.includes('military_flights') ? 'military_flights' : (ids[0] ?? 'military_flights');
  } catch {
    return 'military_flights';
  }
})();

const CONSUMER_PRICE_BASKET_EXAMPLE_ID = (() => {
  const src = readRepoText('server/worldmonitor/consumer-prices/v1/get-consumer-price-basket-series.ts');
  const match = src.match(/\bDEFAULT_BASKET\s*=\s*['"`]([^'"`]+)['"`]/);
  return match?.[1] ?? 'essentials-ae';
})();

const CONSUMER_PRICE_RANGE_EXAMPLE_ID = (() => {
  const src = readRepoText('server/worldmonitor/consumer-prices/v1/get-consumer-price-basket-series.ts');
  const match = src.match(/VALID_RANGES\s*=\s*new Set\(\[([^\]]+)\]\)/);
  const ranges = match ? [...match[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]) : [];
  return ranges.includes('7d') ? '7d' : (ranges[0] ?? '7d');
})();

const REGIONAL_INTELLIGENCE_EXAMPLE_ID = (() => {
  const src = readRepoText('scripts/shared/geography.js');
  const match = src.match(/\bREGION_IDS\s*=\s*\[([\s\S]*?)\]/);
  const ids = match ? [...match[1].matchAll(/['"`]([a-z0-9-]+)['"`]/g)].map((m) => m[1]) : [];
  return ids.includes('mena') ? 'mena' : (ids.find((id) => id !== 'global') ?? 'mena');
})();

const GDELT_TOPIC_EXAMPLE_ID = (() => {
  const src = readRepoText('scripts/seed-gdelt-intel.mjs');
  const ids = [...src.matchAll(/\bid:\s*['"`]([a-z0-9-]+)['"`]/g)].map((m) => m[1]);
  return ids.includes('military') ? 'military' : (ids[0] ?? 'military');
})();

// key = normalizeKey(paramName); context carries { operationId, path, method }.
// Returns a curated example that overrides the field-name heuristic, or
// undefined to fall through. `series_id` / `series_ids` is shared by FRED (no
// enum, needs an override) and BLS (enum-resolved upstream) — disambiguate by
// operation.
function overrideStringExample(key, context = {}) {
  const where = `${context.operationId ?? ''} ${context.path ?? ''}`.toLowerCase();
  if (key === 'jmespath') return 'keys(@)';
  // RunScenario's async-job envelope (202 Accepted, see
  // openapi-inject-async-jobs.mjs): status is ALWAYS "pending" at enqueue
  // time, and statusUrl is the server-computed GetScenarioStatus poll URL —
  // the heuristic defaults ('example' / a generic https URL) contradict the
  // fields' own descriptions. The statusUrl value must mirror the Location
  // header example in openapi-inject-async-jobs.mjs (contract-tested).
  if (key === 'status' || key === 'statusurl') {
    if (where.includes('runscenario') || where.includes('run-scenario')) {
      return key === 'status'
        ? 'pending'
        : '/api/scenario/v1/get-scenario-status?jobId=scenario%3A1717200000000%3Aabcd1234';
    }
  }
  if (key === 'period' && where.includes('getsectorsummary')) return '1d';
  if (key === 'timespan' && where.includes('searchgdeltdocuments')) return '15min';
  if (key === 'measuretype' && where.includes('gettradebarriers')) return 'SPS';
  if (key === 'mode' && where.includes('getpopulationexposure')) return 'countries';
  if (key === 'theater' && where.includes('gettheaterposture')) return 'indo-pacific';
  if (key.includes('hs2')) return '27';
  if (key === 'provider') {
    if (where.includes('summarizearticle') || where.includes('summarize-article')) return 'openrouter';
  }
  if (key === 'topic') {
    if (where.includes('getgdelttopictimeline') || where.includes('get-gdelt-topic-timeline')) return GDELT_TOPIC_EXAMPLE_ID;
  }
  if (key === 'basketslug') return CONSUMER_PRICE_BASKET_EXAMPLE_ID;
  if (key === 'range') {
    if (where.includes('consumerprice') || where.includes('consumer-prices')) return CONSUMER_PRICE_RANGE_EXAMPLE_ID;
  }
  if (key === 'regionid') return REGIONAL_INTELLIGENCE_EXAMPLE_ID;
  if (key === 'airlines') return 'BA';
  if (key === 'departurewindow') return '6-20';
  if (key.includes('chokepointid')) {
    if (where.includes('computeenergyshockscenario') || where.includes('compute-energy-shock')) return 'hormuz_strait';
    return CHOKEPOINT_EXAMPLE_ID;
  }
  if (key.includes('scenarioid')) return SCENARIO_EXAMPLE_ID;
  if (key.includes('icao24')) return ICAO24_EXAMPLE;
  // BatchOperation.path: the heuristic emits the literal 'example', which the
  // execute-batch handler rejects (paths must match a documented GET RPC).
  // Pin a parameterless GET so the published sample is runnable verbatim.
  if (key === 'path') {
    if (where.includes('executebatch') || where.includes('batch/v1/execute')) {
      return '/api/market/v1/get-fear-greed-index';
    }
  }
  if (key === 'type') {
    if (where.includes('baseline')) return BASELINE_TYPE_EXAMPLE_ID;
  }
  if (key === 'seriesid' || key === 'seriesids') {
    if (where.includes('fred')) return FRED_SERIES_EXAMPLE_ID;
  }
  return undefined;
}

function normalizeDescriptionValue(value) {
  return String(value)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/[),.;:]+$/g, '')
    .trim();
}

function candidateLooksLikeClosedValue(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

function firstClosedValue(candidates) {
  for (const raw of candidates) {
    const value = normalizeDescriptionValue(raw);
    if (/\bdefault\b/i.test(String(raw)) && value.toLowerCase() !== 'default' && candidateLooksLikeClosedValue(value)) return value;
  }
  for (const raw of candidates) {
    const value = normalizeDescriptionValue(raw);
    if (!value || value.toLowerCase() === 'default') continue;
    if (candidateLooksLikeClosedValue(value)) return value;
  }
  return undefined;
}

function extractDelimitedValues(text) {
  return [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

function splitValueList(text) {
  return text
    .replace(/\bor\b/g, ',')
    .replace(/\band\b/g, ',')
    .split(',')
    .map((part) => normalizeDescriptionValue(part))
    .filter(Boolean);
}

function closedValueFromSegment(segment) {
  const quoted = extractDelimitedValues(segment);
  return firstClosedValue(quoted.length > 0 ? quoted : splitValueList(segment));
}

function descriptionClosedValueExample(description) {
  const text = String(description ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;

  const closedListMatch = text.match(
    /\b(?:one of|supported values?|valid values?|allowed values?|accepted values?)\b(?:\s*(?:are|is|:))?\s*([^.;]+)/i,
  );
  if (closedListMatch) {
    return closedValueFromSegment(closedListMatch[1] ?? '');
  }

  const labeledSetMatch = text.match(
    /\b(?:cabin class|stop filter|sort order|sort mode|summarization mode|fuel mode|policy category|status)\s*:\s*([^.;]+)/i,
  );
  if (labeledSetMatch) {
    return closedValueFromSegment(labeledSetMatch[1] ?? '');
  }

  const topicMatch = text.match(/\bTopic ID\s*\(([^)]+)\)/i);
  if (topicMatch) return firstClosedValue(splitValueList(topicMatch[1] ?? ''));

  return undefined;
}

function shouldUseDescriptionClosedValue(context = {}) {
  return context.exampleSurface === 'parameter' || context.exampleSurface === 'request';
}

function getScenarioStatusExample() {
  return {
    result: {
      affectedChokepointIds: SCENARIO_RESULT_AFFECTED_CHOKEPOINT_IDS,
      template: {
        name: SCENARIO_RESULT_TEMPLATE_NAME,
        disruptionPct: 100,
        durationDays: 14,
        costShockMultiplier: 2.1,
      },
      topImpactCountries: [
        {
          iso2: 'US',
          totalImpact: 42.5,
          impactPct: 100,
        },
      ],
    },
    status: 'done',
  };
}

function getGivingSummaryExample() {
  const generatedAt = '2026-07-24T12:00:00.000Z';
  const annualizedPlatformValueUsd = (claim) => {
    if (
      !claim.platform
      || !claim.includedInHighlightedAggregate
      || claim.status !== 'verified'
      || claim.reportedUnit !== 'USD'
      || !Number.isFinite(claim.reportedValue)
      || claim.reportedValue <= 0
    ) {
      return 0;
    }
    if (claim.denominator === 'year') return claim.reportedValue;
    if (claim.denominator === 'week') return claim.reportedValue * 52;
    return 0;
  };
  const platforms = [
    ['GoFundMe', 'annual'],
    ['GlobalGiving', 'annual'],
    ['JustGiving', 'cumulative'],
  ].map(([platform, dataFreshness]) => {
    const platformClaims = GIVING_PUBLISHED_ESTIMATE_CLAIMS
      .filter((claim) => claim.platform === platform);
    const annualizedUsd = platformClaims
      .reduce((total, claim) => total + annualizedPlatformValueUsd(claim), 0);
    const lastUpdated = platformClaims.find((claim) =>
      claim.status === 'verified' && claim.sourcePublishedAt?.trim())?.sourcePublishedAt ?? '';
    return {
      platform,
      dailyVolumeUsd: annualizedUsd / 365,
      dataFreshness,
      lastUpdated,
    };
  });
  const verifiedContextValue = (metric) => {
    const claim = GIVING_PUBLISHED_ESTIMATE_CLAIMS.find((entry) =>
      entry.contextMetric === metric && entry.status === 'verified');
    return claim?.reportedValue ?? 0;
  };
  const publicProvenance = GIVING_PUBLISHED_ESTIMATE_CLAIMS.map((claim) =>
    Object.fromEntries(
      Object.entries(claim).filter(([key]) => key !== 'platform' && key !== 'contextMetric'),
    ));
  const oecdOdaAnnualUsdBn = verifiedContextValue('oecd_oda_usd_bn');
  const dataMode = GIVING_PUBLISHED_ESTIMATE_CLAIMS.some((claim) =>
    claim.status === 'unverified' || claim.status === 'partially_verified')
    ? 'partial_estimate'
    : 'published_estimate';
  const categories = [
    'Medical & Health',
    'Disaster Relief',
    'Education',
    'Community',
    'Memorials',
    'Animals & Pets',
    'Environment',
    'Hunger & Food',
    'Other',
  ].map((category) => ({
    category,
    share: 0,
    change24h: 0,
    activeCampaigns: 0,
    trending: false,
  }));

  return {
    summary: {
      generatedAt,
      activityIndex: 0,
      trend: 'stable',
      estimatedDailyFlowUsd: platforms.reduce(
        (total, platform) => total + platform.dailyVolumeUsd,
        0,
      ),
      platforms,
      categories,
      crypto: {
        dailyInflowUsd: 0,
        trackedWallets: 0,
        transactions24h: 0,
        topReceivers: [],
        pctOfTotal: 0,
      },
      institutional: {
        oecdOdaAnnualUsdBn,
        oecdDataYear: oecdOdaAnnualUsdBn > 0 ? 2023 : 0,
        cafWorldGivingIndex: 0,
        cafDataYear: 0,
        candidGrantsTracked: verifiedContextValue('candid_grants'),
        dataLag: 'Annual published context',
      },
      dataMode,
      trendAvailable: false,
      provenance: publicProvenance,
      activityIndexAvailable: false,
    },
    fetchedAt: Date.parse(generatedAt),
    dataAvailable: true,
  };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function refName(ref) {
  if (!ref || !ref.startsWith('#/components/schemas/')) return null;
  return decodeURIComponent(ref.slice('#/components/schemas/'.length));
}

function resolveRef(schema, spec) {
  const name = refName(schema?.$ref);
  if (!name) return schema;
  const resolved = spec.components?.schemas?.[name];
  if (!resolved) throw new Error(`missing schema ref ${schema.$ref}`);
  return resolved;
}

// Honeypot fields are hidden anti-bot inputs: the handlers silently discard any
// non-empty value (server/worldmonitor/leads/v1/{register-interest,submit-contact}.ts),
// so a populated example is a fake-success trap — a developer copying the sample
// gets a 200 but nothing is registered/emailed, and the value contradicts the
// field's own "real submissions leave it empty" description. They're detected by
// the schema-description marker (general — auto-covers any future honeypot) and
// DROPPED from the generated example object entirely. An empty-string override is
// insufficient: constrainedString('') coerces '' back to the 'example' placeholder.
function isHoneypotField(propSchema, spec) {
  if (!propSchema || typeof propSchema !== 'object') return false;
  const resolved = propSchema.$ref ? resolveRef(propSchema, spec) : propSchema;
  const description = String(resolved?.description ?? propSchema.description ?? '').toLowerCase();
  return description.includes('honeypot');
}

function schemaType(schema) {
  if (!schema || typeof schema !== 'object') return undefined;
  const t = Array.isArray(schema.type) ? schema.type.find((v) => v !== 'null') : schema.type;
  if (t) return t;
  if (schema.properties || schema.additionalProperties) return 'object';
  if (schema.items) return 'array';
  return undefined;
}


function constrainedString(value, schema) {
  const min = Number.isFinite(schema?.minLength) ? schema.minLength : 0;
  const max = Number.isFinite(schema?.maxLength) ? schema.maxLength : Infinity;
  let out = String(value);
  if (out.length < min) out = out + 'x'.repeat(min - out.length);
  if (out.length > max) out = out.slice(0, max);
  return out || 'example';
}

function patternString(pattern, key) {
  if (!pattern) return null;
  const simpleAlternation = pattern.match(/^\^\(([^)]+)\)\$/);
  if (simpleAlternation) return simpleAlternation[1].split('|')[0];
  if (/scenario:\[0-9\]\{13\}:\[a-z0-9\]\{8\}/.test(pattern) || pattern.includes('scenario:')) {
    return 'scenario:1717200000000:abcd1234';
  }
  if (pattern.includes('summary:v\\d+:')) return 'summary:v1:example-cache';
  if (/^\^?\[A-Z\]\{3\}\$?$/.test(pattern)) return 'USA';
  if (/^\^?\[A-Z\]\{2\}\$?$/.test(pattern)) return 'US';
  if (pattern.includes('[0-9]{13}')) return '1717200000000';
  if (pattern.includes('[a-z0-9]')) return 'example1';
  if (key.includes('email')) return 'analyst@example.com';
  return null;
}

function stringExample(name, schema = {}, context = {}) {
  const key = normalizeKey(name || context.name || context.operationId);
  const description = String(schema.description ?? context.description ?? '').toLowerCase();
  const where = `${context.operationId ?? ''} ${context.path ?? ''}`.toLowerCase();
  // The ODP Patent File Wrapper source cannot populate this compatibility
  // field. Keep the generated response example truthful instead of emitting
  // the generic non-empty string placeholder.
  if (key === 'abstract' && (where.includes('listdefensepatents') || where.includes('list-defense-patents'))) return '';
  const override = overrideStringExample(key, context);
  if (override !== undefined) return constrainedString(override, schema);
  if (shouldUseDescriptionClosedValue(context)) {
    const closed = descriptionClosedValueExample(schema.description ?? context.description);
    if (closed !== undefined) return constrainedString(closed, schema);
  }
  if (schema.format === 'int64' || schema.format === 'uint64') return constrainedString('1717200000000', schema);
  if (key === 'lastupdated' || description.includes('iso-8601 datetime')) return constrainedString('2026-01-15T12:00:00.000Z', schema);
  if (schema.format === 'date-time') return constrainedString('2026-01-15T12:00:00Z', schema);
  if (schema.format === 'date') return constrainedString('2026-01-15', schema);
  const pattern = patternString(schema.pattern, key);
  if (pattern) return constrainedString(pattern, schema);
  if (key.includes('email')) return constrainedString('analyst@example.com', schema);
  if (key.includes('callbackurl')) return constrainedString('https://example.com/worldmonitor-webhook', schema);
  if (key.includes('url') || key.includes('link')) return constrainedString('https://example.com/worldmonitor', schema);
  if (key.includes('jobid')) return constrainedString('scenario:1717200000000:abcd1234', schema);
  if (key.includes('pipelineid')) return constrainedString('transmed-pipeline', schema);
  if (key.includes('facilityid')) return constrainedString('rough-storage', schema);
  if (key.includes('assetid')) return constrainedString('asset-example-1', schema);
  if (key.includes('vessel') || key.includes('mmsi')) return constrainedString('123456789', schema);
  if (key.includes('ticker') || key.includes('symbol')) return constrainedString('AAPL', schema);
  if (key.includes('fullname')) return constrainedString('koala73/worldmonitor', schema);
  if (key.includes('provider')) return constrainedString('worldmonitor', schema);
  if (description.includes('iata')) return constrainedString(key.includes('destination') || key.includes('arrival') ? 'LHR' : 'JFK', schema);
  if (description.includes('iso 4217') || key.includes('currency')) return constrainedString('USD', schema);
  if (description.includes('iso 639') || key === 'lang' || key.includes('locale')) return constrainedString('en', schema);
  if (description.includes('iso 3166') || key.includes('marketcode')) return constrainedString('US', schema);
  if (description.includes('wto member code')) return constrainedString(key.includes('partner') ? '156' : '840', schema);
  if (description.includes('world bank indicator code')) return constrainedString('NY.GDP.MKTP.CD', schema);
  if (description.includes('cpc category')) return constrainedString('H04B', schema);
  if (description.includes('un comtrade reporter code')) return constrainedString('842', schema);
  if (description.includes('hs commodity code') || key.includes('cmdcode')) return constrainedString('2709', schema);
  if (key.includes('fromiso')) return constrainedString('CN', schema);
  if (key.includes('toiso')) return constrainedString('US', schema);
  if (key.includes('iso3')) return constrainedString('USA', schema);
  if (key.includes('iso2') || key.includes('country') || key.includes('countrycode')) return constrainedString('US', schema);
  if (key.includes('bbox')) return constrainedString('-74.10,40.60,-73.70,40.90', schema);
  if (key.includes('lat')) return constrainedString('40.7128', schema);
  if (key.includes('lng') || key.includes('lon')) return constrainedString('-74.0060', schema);
  if (key.includes('date') || key.endsWith('day')) return constrainedString('2026-01-15', schema);
  if (key.includes('time') || key.endsWith('at')) return constrainedString('2026-01-15T12:00:00Z', schema);
  if (key.includes('cursor')) return constrainedString('next-page-token', schema);
  if (key.includes('query') || key.includes('search')) return constrainedString('supply chain risk', schema);
  if (key.includes('language')) return constrainedString('typescript', schema);
  if (key.includes('category')) return constrainedString('cs.AI', schema);
  if (key.includes('feedtype')) return constrainedString('top', schema);
  if (key.includes('period')) return constrainedString('daily', schema);
  if (key.includes('cargotype')) return constrainedString('container', schema);
  if (key.includes('commoditytype')) return constrainedString('oil', schema);
  if (key.includes('facilitytype')) return constrainedString('ugs', schema);
  if (key.includes('assettype')) return constrainedString('pipeline', schema);
  if (key.includes('product')) return constrainedString('diesel', schema);
  if (key.includes('severity')) return constrainedString('watch', schema);
  if (key === 'type' || key.endsWith('type')) {
    if (description.includes('conference')) return constrainedString('conference', schema);
    if (description.includes('pipeline')) return constrainedString('pipeline', schema);
    return constrainedString('all', schema);
  }
  if (key.includes('name')) return constrainedString('WorldMonitor Analyst', schema);
  if (key.includes('message') || key.includes('summary') || key.includes('description')) {
    return constrainedString('Example WorldMonitor observation.', schema);
  }
  if (key === 'id' || key.endsWith('id') || key.includes('identifier')) return constrainedString('example-id', schema);
  return constrainedString('example', schema);
}

function numberExample(name, schema = {}, integer = false) {
  const key = normalizeKey(name);
  let value = integer ? 1 : 1.5;
  if (key.includes('page') || key.includes('limit')) value = 25;
  else if (key.includes('days')) value = 7;
  else if (key.includes('closuredays')) value = 30;
  else if (key === 'lat' || key.endsWith('lat') || key.includes('latitude')) value = 40.7128;
  else if (key === 'lng' || key === 'lon' || key.endsWith('lng') || key.endsWith('lon') || key.includes('longitude')) value = -74.006;
  else if (key.includes('time') || key.endsWith('at')) value = 1717200000000;
  else if (key.includes('percent') || key.includes('ratio') || key.includes('score')) value = 42.5;
  else if (key.includes('confidence')) value = 0.82;
  else if (key.includes('price') || key.includes('cost') || key.includes('rate')) value = 75.25;
  else if (key.includes('count') || key.includes('total')) value = 1;

  if (Number.isFinite(schema.minimum) && value < schema.minimum) value = schema.minimum;
  if (Number.isFinite(schema.maximum) && value > schema.maximum) value = schema.maximum;
  if (integer) value = Math.trunc(value);
  if (integer && Number.isFinite(schema.minimum) && value < schema.minimum) value = Math.ceil(schema.minimum);
  if (integer && Number.isFinite(schema.maximum) && value > schema.maximum) value = Math.floor(schema.maximum);
  return value;
}

function mergeObjects(a, b) {
  return a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)
    ? { ...a, ...b }
    : b;
}

function exampleForSchema(schema, spec, context = {}, depth = 0, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return 'example';
  const original = schema;
  schema = resolveRef(schema, spec);
  if (
    depth === 0
    && String(context.operationId ?? '').toLowerCase() === 'getgivingsummary'
    && String(context.name ?? '').toLowerCase().endsWith('response')
  ) {
    return getGivingSummaryExample();
  }
  if (
    depth === 0
    && String(context.operationId ?? '').toLowerCase() === 'getscenariostatus'
    && String(context.name ?? '').toLowerCase().endsWith('response')
  ) {
    return getScenarioStatusExample();
  }
  const ref = original.$ref;
  if (ref) {
    if (seen.has(ref)) return {};
    seen = new Set([...seen, ref]);
  }

  if (schema.example !== undefined) return clone(schema.example);
  if (schema.default !== undefined) return clone(schema.default);
  if (schema.const !== undefined) return clone(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const value = schema.enum.find((item) => !(typeof item === 'string' && item.endsWith('_UNSPECIFIED')));
    return clone(value ?? schema.enum[0]);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.reduce(
      (acc, part) => mergeObjects(acc, exampleForSchema(part, spec, context, depth + 1, seen)),
      {},
    );
  }
  const union = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(union) && union.length > 0) {
    return exampleForSchema(union[0], spec, context, depth + 1, seen);
  }

  const type = schemaType(schema);
  const name = context.name ?? '';
  if (depth > MAX_OBJECT_DEPTH && (type === 'object' || type === 'array')) return type === 'array' ? [] : {};

  if (type === 'array') {
    return [exampleForSchema(schema.items ?? {}, spec, { ...context, name }, depth + 1, seen)];
  }
  if (type === 'object') {
    const props = schema.properties ?? {};
    // Drop honeypot fields before slot selection so they never appear in the
    // example and never consume a MAX_OPTIONAL_PROPERTIES slot from a real field.
    const isHoneypot = (key) => isHoneypotField(props[key], spec);
    const required = new Set((Array.isArray(schema.required) ? schema.required : []).filter((key) => !isHoneypot(key)));
    const optional = Object.keys(props)
      .filter((key) => !required.has(key) && !isHoneypot(key))
      .slice(0, MAX_OPTIONAL_PROPERTIES);
    const keys = [...required, ...optional];
    if (keys.length === 0) {
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        return {
          exampleKey: exampleForSchema(schema.additionalProperties, spec, { ...context, name: 'exampleKey' }, depth + 1, seen),
        };
      }
      return {};
    }
    const out = {};
    for (const key of keys) {
      out[key] = exampleForSchema(props[key], spec, { ...context, name: key }, depth + 1, seen);
    }
    return out;
  }
  if (type === 'integer') return numberExample(name, schema, true);
  if (type === 'number') return numberExample(name, schema, false);
  if (type === 'boolean') return true;
  return stringExample(name, schema, context);
}

function setExample(holder, example) {
  let changed = false;
  if (!eq(holder.example, example)) {
    holder.example = example;
    changed = true;
  }
  if (holder.examples !== undefined) {
    delete holder.examples;
    changed = true;
  }
  return changed;
}

function successResponses(op) {
  return Object.entries(op.responses ?? {}).filter(([code, response]) =>
    /^2\d\d$/.test(code) && response?.content?.[JSON_MEDIA]?.schema,
  );
}

function injectSpecExamples(spec) {
  let changed = false;
  let operations = 0;
  let requestBearingOperations = 0;
  let responseOperations = 0;

  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(ops ?? {})) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      operations++;
      const context = { operationId: op.operationId, path, method };
      let hasRequestExample = false;

      if (Array.isArray(op.parameters) && op.parameters.length > 0) {
        hasRequestExample = true;
        for (const param of op.parameters) {
          if (!param || typeof param !== 'object' || !param.schema) continue;
          // Header params (e.g. Idempotency-Key, injected by
          // openapi-inject-idempotency.mjs) carry their own curated example;
          // a name-heuristic value is meaningless for an opaque client token,
          // and clobbering it would fight that injector. That injector owns
          // header-param examples.
          if (param.in === 'header') continue;
          const example = exampleForSchema(param.schema, spec, {
            ...context,
            name: param.name,
            description: param.description,
            exampleSurface: 'parameter',
          });
          changed = setExample(param, example) || changed;
        }
      }

      const requestMedia = op.requestBody?.content?.[JSON_MEDIA];
      if (requestMedia?.schema) {
        hasRequestExample = true;
        const example = exampleForSchema(requestMedia.schema, spec, {
          ...context,
          name: `${op.operationId ?? 'operation'}Request`,
          exampleSurface: 'request',
        });
        changed = setExample(requestMedia, example) || changed;
      }

      if (hasRequestExample) requestBearingOperations++;

      const responses = successResponses(op);
      if (responses.length > 0) responseOperations++;
      for (const [, response] of responses) {
        const media = response.content[JSON_MEDIA];
        const example = exampleForSchema(media.schema, spec, {
          ...context,
          name: `${op.operationId ?? 'operation'}Response`,
          exampleSurface: 'response',
        });
        changed = setExample(media, example) || changed;
      }
    }
  }

  return { changed, operations, requestBearingOperations, responseOperations };
}

function countIndent(line) {
  return line.match(/^ */)?.[0].length ?? 0;
}

function blockEnd(lines, start, indent) {
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && countIndent(line) <= indent) break;
    end++;
  }
  return end;
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function findOperation(lines, path, method, label) {
  for (let i = 0; i < lines.length; i++) {
    if (countIndent(lines[i]) !== 4 || lines[i].trim() !== `${path}:`) continue;
    const pathEnd = blockEnd(lines, i, 4);
    for (let j = i + 1; j < pathEnd; j++) {
      if (countIndent(lines[j]) === 8 && lines[j].trim() === `${method}:`) {
        return { start: j, end: blockEnd(lines, j, 8) };
      }
    }
  }
  throw new Error(`${label}: could not locate ${method.toUpperCase()} ${path} in YAML artifact`);
}

function isScalar(value) {
  return value === null || typeof value !== 'object';
}

function yamlScalar(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null) return 'null';
  return JSON.stringify(value);
}

function yamlKey(key) {
  return JSON.stringify(String(key));
}

function renderYamlNode(value, indent) {
  const prefix = ' '.repeat(indent);
  if (isScalar(value)) return [`${prefix}${yamlScalar(value)}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}[]`];
    const lines = [];
    for (const item of value) {
      if (isScalar(item)) {
        lines.push(`${prefix}- ${yamlScalar(item)}`);
      } else if (Array.isArray(item)) {
        if (item.length === 0) {
          lines.push(`${prefix}- []`);
        } else {
          lines.push(`${prefix}-`);
          lines.push(...renderYamlNode(item, indent + 4));
        }
      } else {
        const keys = Object.keys(item);
        if (keys.length === 0) {
          lines.push(`${prefix}- {}`);
          continue;
        }
        keys.forEach((key, index) => {
          const child = item[key];
          const propPrefix = index === 0 ? `${prefix}- ` : `${prefix}  `;
          if (isScalar(child)) {
            lines.push(`${propPrefix}${yamlKey(key)}: ${yamlScalar(child)}`);
          } else {
            lines.push(`${propPrefix}${yamlKey(key)}:`);
            lines.push(...renderYamlNode(child, indent + (index === 0 ? 4 : 6)));
          }
        });
      }
    }
    return lines;
  }

  const keys = Object.keys(value);
  if (keys.length === 0) return [`${prefix}{}`];
  const lines = [];
  for (const key of keys) {
    const child = value[key];
    if (isScalar(child)) {
      lines.push(`${prefix}${yamlKey(key)}: ${yamlScalar(child)}`);
    } else {
      lines.push(`${prefix}${yamlKey(key)}:`);
      lines.push(...renderYamlNode(child, indent + 4));
    }
  }
  return lines;
}

function renderExampleBlock(example, indent) {
  const prefix = ' '.repeat(indent);
  if (example === null || typeof example !== 'object') {
    return [`${prefix}example: ${JSON.stringify(example)}`];
  }
  return [`${prefix}example:`, ...renderYamlNode(sortRec(example), indent + 4)];
}

function removeSiblingBlocks(lines, start, end, indent) {
  let i = start;
  while (i < end) {
    const trimmed = lines[i].trim();
    if (countIndent(lines[i]) === indent && (trimmed === 'example:' || trimmed.startsWith('example: ') || trimmed === 'examples:' || trimmed.startsWith('examples: '))) {
      const rmEnd = blockEnd(lines, i, indent);
      lines.splice(i, rmEnd - i);
      end -= rmEnd - i;
      continue;
    }
    i++;
  }
  return end;
}

function replaceParamExample(lines, opStart, opEnd, name, example) {
  for (let i = opStart + 1; i < opEnd; i++) {
    const match = lines[i].match(/^(\s*)-\s+name:\s+(.+)$/);
    if (!match || countIndent(lines[i]) !== 16) continue;
    if (unquoteYamlScalar(match[2]) !== name) continue;
    const propIndent = 18;
    let end = blockEnd(lines, i, 16);
    end = removeSiblingBlocks(lines, i + 1, end, propIndent);
    const insertAt = (() => {
      for (let j = i + 1; j < end; j++) {
        if (countIndent(lines[j]) === propIndent && lines[j].trim() === 'schema:') return j;
      }
      return end;
    })();
    lines.splice(insertAt, 0, ...renderExampleBlock(example, propIndent));
    return;
  }
  throw new Error(`could not locate YAML parameter ${name}`);
}

function findChildLine(lines, start, end, indent, text) {
  for (let i = start + 1; i < end; i++) {
    if (countIndent(lines[i]) === indent && lines[i].trim() === text) return i;
  }
  return -1;
}

function replaceMediaExample(lines, mediaStart, example) {
  const mediaIndent = countIndent(lines[mediaStart]);
  const childIndent = mediaIndent + 4;
  let end = blockEnd(lines, mediaStart, mediaIndent);
  end = removeSiblingBlocks(lines, mediaStart + 1, end, childIndent);
  let insertAt = end;
  for (let i = mediaStart + 1; i < end; i++) {
    if (countIndent(lines[i]) === childIndent && lines[i].trim() === 'schema:') {
      insertAt = i;
      break;
    }
  }
  lines.splice(insertAt, 0, ...renderExampleBlock(example, childIndent));
}

function replaceRequestBodyExample(lines, opStart, opEnd, example) {
  const requestStart = findChildLine(lines, opStart, opEnd, 12, 'requestBody:');
  if (requestStart === -1) return;
  const requestEnd = blockEnd(lines, requestStart, 12);
  let mediaStart = -1;
  for (let i = requestStart + 1; i < requestEnd; i++) {
    if (lines[i].trim() === JSON_MEDIA + ':') {
      mediaStart = i;
      break;
    }
  }
  if (mediaStart === -1) throw new Error('requestBody missing application/json in YAML artifact');
  replaceMediaExample(lines, mediaStart, example);
}

function replaceResponseExample(lines, opStart, opEnd, code, example) {
  const responsesStart = findChildLine(lines, opStart, opEnd, 12, 'responses:');
  if (responsesStart === -1) return;
  const responsesEnd = blockEnd(lines, responsesStart, 12);
  let codeStart = -1;
  for (let i = responsesStart + 1; i < responsesEnd; i++) {
    if (countIndent(lines[i]) !== 16) continue;
    const trimmed = lines[i].trim();
    if (trimmed === `${code}:` || trimmed === `"${code}":`) {
      codeStart = i;
      break;
    }
  }
  if (codeStart === -1) return;
  const codeEnd = blockEnd(lines, codeStart, 16);
  const mediaStart = findChildLine(lines, codeStart, codeEnd, 24, `${JSON_MEDIA}:`);
  if (mediaStart === -1) return;
  replaceMediaExample(lines, mediaStart, example);
}

function patchYamlExamples(raw, spec, label) {
  const lines = raw.split('\n');
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(ops ?? {})) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;

      for (const param of op.parameters ?? []) {
        if (param?.example === undefined) continue;
        // Header-param examples are owned by openapi-inject-idempotency.mjs
        // (see the JSON pass above); leave them untouched here too.
        if (param.in === 'header') continue;
        const loc = findOperation(lines, path, method, label);
        replaceParamExample(lines, loc.start, loc.end, param.name, param.example);
      }

      const requestExample = op.requestBody?.content?.[JSON_MEDIA]?.example;
      if (requestExample !== undefined) {
        const loc = findOperation(lines, path, method, label);
        replaceRequestBodyExample(lines, loc.start, loc.end, requestExample);
      }

      for (const [code, response] of successResponses(op)) {
        const example = response.content?.[JSON_MEDIA]?.example;
        if (example === undefined) continue;
        const loc = findOperation(lines, path, method, label);
        replaceResponseExample(lines, loc.start, loc.end, code, example);
      }
    }
  }
  return lines.join('\n');
}

function processServiceSpec(file) {
  const jsonPath = resolve(apiDir, file);
  const spec = sortRec(JSON.parse(readFileSync(jsonPath, 'utf8')));
  const stats = injectSpecExamples(spec);
  const serialized = serialize(spec);
  const jsonChanged = readFileSync(jsonPath, 'utf8') !== serialized;
  if (jsonChanged && !CHECK) writeFileSync(jsonPath, serialized);

  const yamlFile = file.replace(/\.json$/, '.yaml');
  const yamlPath = resolve(apiDir, yamlFile);
  const yamlRaw = readFileSync(yamlPath, 'utf8');
  const yamlText = patchYamlExamples(yamlRaw, spec, yamlFile);
  const yamlChanged = yamlRaw !== yamlText;
  if (yamlChanged && !CHECK) writeFileSync(yamlPath, yamlText);

  return { ...stats, changed: jsonChanged || yamlChanged, jsonChanged, yamlChanged, spec };
}

function processBundle(serviceSpecs) {
  let text = readFileSync(bundlePath, 'utf8');
  const raw = text;
  for (const spec of serviceSpecs) {
    text = patchYamlExamples(text, spec, 'worldmonitor.openapi.yaml');
  }
  const changed = raw !== text;
  if (changed && !CHECK) writeFileSync(bundlePath, text);
  return { changed };
}

const specFiles = readdirSync(apiDir).filter((f) => /Service\.openapi\.json$/.test(f)).sort();
let operations = 0;
let requestBearingOperations = 0;
let responseOperations = 0;

function processAllSpecs(countStats = false) {
  let touched = 0;
  let bundleChanged = false;
  const serviceSpecs = [];
  for (const file of specFiles) {
    const result = processServiceSpec(file);
    serviceSpecs.push(result.spec);
    if (result.changed) touched++;
    if (countStats) {
      operations += result.operations;
      requestBearingOperations += result.requestBearingOperations;
      responseOperations += result.responseOperations;
    }
  }
  const bundleResult = processBundle(serviceSpecs);
  if (bundleResult.changed) {
    touched++;
    bundleChanged = true;
  }
  return { touched, bundleChanged };
}

const firstPass = processAllSpecs(true);
const bundleChanged = firstPass.bundleChanged;
const touched = firstPass.touched;

if (CHECK) {
  if (touched > 0) {
    console.error(`x ${touched} OpenAPI artifact set(s) missing generated examples`);
    console.error('  Run: npm run gen:openapi:examples');
    process.exit(1);
  }
  console.log(`ok ${specFiles.length} specs + bundle carry generated examples (${operations} operations)`);
} else {
  console.log(
    `openapi-inject-examples: updated ${touched} artifact set(s) - ${specFiles.length} specs, ${operations} operations, ${requestBearingOperations} request operation(s), ${responseOperations} response example target(s), bundle ${bundleChanged ? 'updated' : 'unchanged'}`,
  );
}
