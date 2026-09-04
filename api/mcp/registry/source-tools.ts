// U3 — `get_sources`: runtime discovery of what WorldMonitor actually covers.
//
// Two populations, deliberately NOT merged. They are keyed differently and
// describe different things, and a joined list would be a fabricated one:
//
//   providers — shared/source-attribution-manifest.json, keyed by HOST
//     ("acleddata.com"). Every upstream WorldMonitor fetches from: feeds,
//     structured APIs, operational-status endpoints. Carries licensing and
//     attribution obligations.
//   outlets   — the merged source-tier registry, keyed by DISPLAY NAME
//     ("Reuters", "IDF Official"). Named public source identities carrying an
//     editorial tier plus the propaganda-risk and source-type provenance the
//     news tools attach to stories. Platform identities remain explicit.
//
// Only 3 of 536 active provider records share a key with the outlet table, so
// presenting one inventory would mean inventing attribution for the other 533.
// Provenance honesty is the product's differentiator; faking the join here
// would undercut the thing this tool exists to advertise.
import attributionManifest from '../../../shared/source-attribution-manifest.json';
import { getSourceProvenanceState } from '../../../shared/source-provenance';
import { TELEGRAM_CHANNEL_TRUST } from '../../../shared/telegram-channel-trust';
import { SOURCE_TIERS } from '../../../server/_shared/source-tiers';
import { resolveSourceOrigin, sourceOriginFilterValue, sourceOriginLabel } from '../../../scripts/source-origin.mjs';
import { argNum, argStr, ciIncludes } from '../filters';
import type { ToolDef } from '../types';

interface ManifestEntry {
  host: string;
  provider?: string;
  kind?: string;
  status?: string;
  license?: string;
  observed?: boolean;
  catalogActive?: boolean;
}

const MANIFEST_ENTRIES = (attributionManifest as { entries: ManifestEntry[] }).entries;
const ACTIVE_PROVIDERS = MANIFEST_ENTRIES.filter((entry) => (
  entry.observed === true
  && entry.catalogActive !== false
  && (entry.status === 'reviewed' || entry.status === 'terms-review')
));
const EXCLUDED_COUNT = MANIFEST_ENTRIES.filter((entry) => entry.status === 'excluded').length;

const PROVIDER_HOSTS = new Map<string, string[]>();
for (const entry of ACTIVE_PROVIDERS) {
  const provider = entry.provider || entry.host;
  const hosts = PROVIDER_HOSTS.get(provider) || [];
  if (!hosts.includes(entry.host)) hosts.push(entry.host);
  PROVIDER_HOSTS.set(provider, hosts);
}

const PROVIDER_ORIGINS = new Map<string, string | null>();
for (const [provider, hosts] of PROVIDER_HOSTS) {
  PROVIDER_ORIGINS.set(provider, resolveSourceOrigin({ provider, hosts }));
}

function providerOrigin(entry: ManifestEntry): string | null {
  const provider = entry.provider || entry.host;
  const origin = PROVIDER_ORIGINS.get(provider);
  if (origin === undefined && !PROVIDER_ORIGINS.has(provider)) {
    throw new Error(`Missing publisher origin for provider: ${provider}`);
  }
  return origin ?? null;
}

const SOURCE_VIEWS = ['summary', 'providers', 'outlets'] as const;
const SOURCE_PLATFORMS = ['telegram'] as const;
const DEFAULT_ROW_LIMIT = 50;
const MAX_ROW_LIMIT = 200;

interface PlatformIdentity {
  platform: (typeof SOURCE_PLATFORMS)[number];
  handle: string;
}

const PLATFORM_IDENTITIES_BY_SOURCE = new Map<string, PlatformIdentity[]>();
for (const entry of TELEGRAM_CHANNEL_TRUST) {
  const identities = PLATFORM_IDENTITIES_BY_SOURCE.get(entry.name) || [];
  identities.push({ platform: 'telegram', handle: entry.handle });
  PLATFORM_IDENTITIES_BY_SOURCE.set(entry.name, identities);
}

function resolveRowLimit(value: unknown): { limit: number } | { error: string } {
  if (value === undefined) return { limit: DEFAULT_ROW_LIMIT };
  // The MCP schema carries integers, while the official CLI's generic
  // `--key value` path carries values as strings. Accept only the canonical
  // positive-integer string form so `--limit 5` works without widening the
  // contract to decimals, exponents, or whitespace-only values.
  const parsed = typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 1) {
    return { error: 'limit must be an integer of at least 1' };
  }
  return { limit: Math.min(parsed, MAX_ROW_LIMIT) };
}

function tally(values: Array<string | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    const key = v || 'unknown';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

// Exported for tests: the null-tier path is otherwise unobservable through
// `get_sources`, because the outlets population IS the tier table's key set, so
// every name it enumerates happens to carry a declared tier. A guard that can
// only be exercised by a caller that cannot exist is a vacuous guard — this
// export makes the undeclared-name branch directly testable.
export function outletRecord(name: string) {
  // SOURCE_TIERS is read directly rather than through getSourceTier(), which
  // defaults an unknown name to tier 4. A defaulted number is indistinguishable
  // from a declared one, and this tool's whole job is telling the caller what
  // WorldMonitor actually knows versus what it is guessing.
  const raw = SOURCE_TIERS[name];
  const tier = typeof raw === 'number' ? raw : null;
  const platformIdentities = PLATFORM_IDENTITIES_BY_SOURCE.get(name);
  return {
    name,
    tier,
    provenance: getSourceProvenanceState(name),
    ...(platformIdentities ? { platformIdentities } : {}),
  };
}

export const SOURCE_TOOLS: ToolDef[] = [
  {
    name: 'get_sources',
    _outputBudgetBytes: 65536,
    // U7 roster (R7). The selection criterion is cheap to serve, cacheable,
    // low value to bulk-scrape, AND reliably fresh. This tool satisfies all
    // four trivially: it is a committed-registry read with no network call, no
    // cache, and therefore no staleness mode at all — a data tool whose seed
    // runs late would hand an uncredentialed caller an empty envelope, which
    // reads as a dead server and defeats the point of having a free tier.
    //
    // The roster is deliberately one tool. Widening it needs per-tool
    // freshness evidence from production, not an assumption; the mechanism is
    // generic, so adding a screened tool later is this one line.
    _freeTier: true,
    description:
      "WorldMonitor's live source inventory, for deciding whether and how far to trust what the other tools return. Two separate populations: `providers` are upstream hosts data is fetched from (with licence and attribution status), and `outlets` are named public source identities carrying an editorial tier plus propaganda-risk and source-type provenance. Platform channels include stable platform identities instead of pretending every source is a newsroom masthead. Defaults to `summary` (counts only); pass a view to enumerate. Static registry read — no network, no cache, always current with the deployed build.",
    inputSchema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: [...SOURCE_VIEWS],
          description: 'summary (default) returns counts only and is small. providers enumerates upstream hosts; outlets enumerates named public source identities with tier and provenance.',
        },
        kind: { type: 'string', description: 'providers view only: restrict to one kind — feed, structured, feed+structured, or operational-status.' },
        country: { type: 'string', description: 'providers view only: restrict by publisher origin using a two-letter country code or intl for international sources. Case-insensitive.' },
        tier: { type: 'integer', minimum: 1, maximum: 4, description: 'outlets view only: restrict to one editorial tier. 1 is a wire or primary outlet. Outlets with no declared tier are never returned by this filter, because their tier is unknown rather than 4.' },
        risk: { type: 'string', enum: ['low', 'medium', 'high', 'unknown'], description: 'outlets view only: restrict to one declared propaganda-risk band.' },
        platform: { type: 'string', enum: [...SOURCE_PLATFORMS], description: 'outlets view only: restrict to source identities configured on a platform such as telegram.' },
        query: { type: 'string', description: 'Case-insensitive substring match — against host and provider in the providers view, against outlet name in the outlets view. Applied before limit.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_ROW_LIMIT, description: `Maximum rows in an enumerated view. Defaults to ${DEFAULT_ROW_LIMIT}, capped at ${MAX_ROW_LIMIT}. Ignored by the summary view. The full provider inventory does not fit one response, so a truncated result sets returned < matched.` },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      required: ['view', 'summary'],
      properties: {
        view: { type: 'string', enum: [...SOURCE_VIEWS] },
        summary: {
          type: 'object',
          description: 'Always present, in every view, so counts are available without a second call.',
          required: ['providerCount', 'outletCount', 'excludedProviderCount', 'providersByCountry'],
          properties: {
            providerCount: { type: 'number', description: 'Active upstream hosts. Excludes the excluded-status rows counted separately.' },
            excludedProviderCount: { type: 'number', description: 'Manifest rows deliberately excluded from the provider count (local transports and development-only URLs). Reported rather than silently dropped.' },
            outletCount: { type: 'number', description: 'Named news organisations carrying a declared editorial tier.' },
            providersByKind: { type: 'object', description: 'Active provider counts keyed by kind.' },
            providersByStatus: { type: 'object', description: 'Active provider counts keyed by attribution-review status.' },
            providersByCountry: { type: 'object', description: 'Active provider counts keyed by the lowercase country filter value, including intl.' },
            outletsByTier: { type: 'object', description: 'Outlet counts keyed by declared tier.' },
            outletsByRisk: { type: 'object', description: 'Outlet counts keyed by propaganda-risk band.' },
            outletsByPlatform: { type: 'object', description: 'Outlet counts keyed by an explicitly configured platform identity.' },
          },
        },
        providers: {
          type: 'array',
          description: 'Present only in the providers view.',
          items: {
            type: 'object',
            required: ['host', 'provider', 'originCountry', 'originLabel'],
            properties: {
              host: { type: 'string' },
              provider: { type: 'string' },
              kind: { type: 'string' },
              status: { type: 'string' },
              license: { type: 'string' },
              originCountry: { type: ['string', 'null'], description: 'Publisher-origin ISO 3166-1 alpha-2 code, or null for international sources.' },
              originLabel: { type: 'string', description: 'Human-readable publisher-origin label.' },
            },
          },
        },
        outlets: {
          type: 'array',
          description: 'Present only in the outlets view.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              tier: { type: ['number', 'null'], description: 'Declared editorial tier, or null when WorldMonitor has not declared one. Never defaulted to a number.' },
              provenance: { type: 'object', description: 'Same provenance shape the news tools attach to stories.' },
              platformIdentities: {
                type: 'array',
                description: 'Stable platform-specific identities for this source, when configured.',
                items: {
                  type: 'object',
                  required: ['platform', 'handle'],
                  properties: {
                    platform: { type: 'string', enum: [...SOURCE_PLATFORMS] },
                    handle: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        matched: { type: 'number', description: 'Rows matching the filters before the limit was applied. Present in enumerated views.' },
        returned: { type: 'number', description: 'Rows actually returned. Less than matched means the limit truncated the result.' },
        error: { type: 'string', description: 'Present when input validation fails. Required summary counts remain available.' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params) => {
      const view = (argStr(params.view) || 'summary') as (typeof SOURCE_VIEWS)[number];
      const outletNames = Object.keys(SOURCE_TIERS);
      const summary = {
        providerCount: ACTIVE_PROVIDERS.length,
        excludedProviderCount: EXCLUDED_COUNT,
        outletCount: outletNames.length,
        providersByKind: tally(ACTIVE_PROVIDERS.map((e) => e.kind)),
        providersByStatus: tally(ACTIVE_PROVIDERS.map((e) => e.status)),
        providersByCountry: tally(ACTIVE_PROVIDERS.map((e) => sourceOriginFilterValue(providerOrigin(e)))),
        outletsByTier: tally(outletNames.map((n) => String(SOURCE_TIERS[n]))),
        outletsByRisk: tally(outletNames.map((n) => getSourceProvenanceState(n).risk)),
        outletsByPlatform: tally(
          outletNames.flatMap((name) => (
            PLATFORM_IDENTITIES_BY_SOURCE.get(name)?.map((identity) => identity.platform) || []
          )),
        ),
      };

      if (!SOURCE_VIEWS.includes(view)) {
        return { view: 'summary', summary, error: `view must be one of: ${SOURCE_VIEWS.join(', ')}` };
      }

      if (view === 'summary') return { view, summary };

      const query = argStr(params.query);
      const resolvedLimit = resolveRowLimit(params.limit);
      if ('error' in resolvedLimit) return { view, summary, error: resolvedLimit.error };
      const { limit } = resolvedLimit;

      if (view === 'providers') {
        const kind = argStr(params.kind);
        const country = argStr(params.country)?.toLowerCase();
        if (country && !(country in summary.providersByCountry)) {
          return {
            view,
            summary,
            error: `country must be one of: ${Object.keys(summary.providersByCountry).sort().join(', ')}`,
          };
        }
        const matches = ACTIVE_PROVIDERS.filter((e) => (
          (!kind || argStr(e.kind) === kind)
          && (!country || sourceOriginFilterValue(providerOrigin(e)) === country)
          && (!query || ciIncludes(e.host, query) || ciIncludes(e.provider, query))
        ));
        const providers = matches.slice(0, limit).map((e) => {
          const originCountry = providerOrigin(e);
          return {
            host: e.host,
            provider: e.provider || e.host,
            kind: e.kind,
            status: e.status,
            license: e.license,
            originCountry,
            originLabel: sourceOriginLabel(originCountry),
          };
        });
        return {
          view,
          summary,
          matched: matches.length,
          returned: providers.length,
          providers,
        };
      }

      const tier = argNum(params.tier);
      const risk = argStr(params.risk);
      const platform = argStr(params.platform);
      const matches = outletNames
        .map(outletRecord)
        .filter((o) => (
          (tier === null || o.tier === tier)
          && (!risk || o.provenance.risk === risk)
          && (!platform || o.platformIdentities?.some((identity) => identity.platform === platform))
          && (!query || ciIncludes(o.name, query))
        ));
      const outlets = matches.slice(0, limit);
      return {
        view,
        summary,
        matched: matches.length,
        returned: outlets.length,
        outlets,
      };
    },
    // Static registry read — no HTTP endpoint. Same shape as get_commodity_geo,
    // which the RpcToolDef contract names as the valid empty-_apiPaths case.
    _apiPaths: [],
  },
];
