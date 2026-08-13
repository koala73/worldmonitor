#!/usr/bin/env node
/**
 * Source attribution inventory.
 *
 * The runtime source tree is the authority for which upstream hosts are
 * fetched.  The committed manifest supplies the human-facing provider name,
 * license posture, and required credit for each discovered host.  Keeping the
 * discovery pass deliberately lexical makes this gate runnable in a bare Node
 * checkout (and prevents a credentials-dependent import graph from becoming a
 * documentation check).
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = 'shared/source-attribution-manifest.json';
// Byte-identical copy for services whose rootDirectory is scripts/ (they cannot
// reach ../shared). tests/edge-functions.test.mjs asserts the two match.
const MIRROR_PATH = 'scripts/shared/source-attribution-manifest.json';
const DOCS_PATH = 'docs/source-attribution.mdx';
// MDX comments, not HTML ones: Mintlify parses docs/source-attribution.mdx as MDX v3,
// which rejects `<!--` ("Unexpected character `!` before name") and fails the
// whole deployment. The markers are interpolated into RegExp below, and `{`,
// `*`, `}` are metacharacters, so every interpolation must go through
// escapeRegExp — writing them raw silently stops the generator finding its own
// block.
const BEGIN_MARKER = '{/* BEGIN GENERATED SOURCE ATTRIBUTION */}';
const END_MARKER = '{/* END GENERATED SOURCE ATTRIBUTION */}';
const MANIFEST_STATUSES = new Set(['terms-review', 'reviewed', 'excluded']);
const CREDIT_BEARING_STATUSES = new Set(['terms-review', 'reviewed']);
const ERROR_PRINT_LIMIT = 20;
const REGENERATE_HINT = 'run node scripts/source-attribution.mjs --write';
const REFERENCE_DISPLAY_LIMIT = 4;
const MANIFEST_KIND_RE = /^(?:structured|feed|operational-status)(?:\+(?:structured|feed|operational-status))*$/;
const LOGICAL_KIND_RE = /^(?:candidate|structured|feed|operational-status)(?:\+(?:structured|feed|operational-status))*$/;

const SOURCE_ROOTS = ['scripts', 'server', 'api', 'src'];
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.mjs', '.ts', '.tsx']);
const FEED_FILES = new Set([
  'src/config/feeds.ts',
  // LiveNewsPanel owns optional native-video HLS feeds. They are observed for
  // completeness, but their playback transport is excluded from the data
  // provider count below.
  'src/components/LiveNewsPanel.ts',
  'server/worldmonitor/news/v1/_feeds.ts',
]);
const PRESENTATION_ONLY_FILES = new Set(['src/components/LiveNewsPanel.ts']);
const STATUS_FILE = 'server/worldmonitor/infrastructure/v1/list-service-statuses.ts';

// URL literals are intentionally parsed before classification.  This catches
// both quoted URLs and template literals such as the CFTC dataset endpoint.
const URL_LITERAL_RE = /https?:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(?::\d+)?(?:\/[^\s"'`<>)}\]]*)?/gi;
const SOURCE_HINT_RE = /\b(?:fetch\w*|new\s+URL|axios|rss|feed|statusPage|endpoint|dataUrl|downloadUrl|csvUrl)\b|(?:\b(?:url|base|endpoint)\s*[:=])|(?:\b[A-Z][A-Z0-9_]*(?:URL|BASE|ENDPOINT|FEED|SOURCE|HOST|API)[A-Z0-9_]*\s*=)/i;
// Uppercase URL constants do not always carry a semantic suffix (for example
// BASE_V2), so retain the declaration context separately from the narrower
// source-hint matcher. This keeps the lexical pass fail-closed for fetched
// hosts without treating every ordinary string literal as an upstream source.
const DECLARATION_RE = /\b(?:const|let|var)\s+[A-Z][A-Z0-9_]*\s*=\s*$/;

const PROVIDER_OVERRIDES = {
  'api.elections.kalshi.com': {
    provider: 'Kalshi',
    license: 'Kalshi API terms; commercial-use and redistribution terms require review',
    attribution: 'Kalshi prediction markets; link to the relevant market/API response.',
    status: 'terms-review',
  },
  'api.hyperliquid.xyz': {
    provider: 'Hyperliquid',
    license: 'Hyperliquid API terms',
    attribution: 'Hyperliquid; link to the relevant market/API response.',
    status: 'terms-review',
  },
  'apps.fas.usda.gov': {
    provider: 'USDA FAS PSD',
    license: 'U.S. government public-domain PSD Open Data',
    attribution: 'USDA Foreign Agricultural Service, Production, Supply and Distribution (PSD).',
    status: 'reviewed',
  },
  'api.fas.usda.gov': {
    provider: 'USDA FAS PSD',
    license: 'U.S. government public-domain PSD Open Data',
    attribution: 'USDA Foreign Agricultural Service, Production, Supply and Distribution (PSD).',
    status: 'reviewed',
  },
  'fenixservices.fao.org': {
    provider: 'FAOSTAT',
    license: 'FAOSTAT CC-BY; attribution to FAO required',
    attribution: 'FAO. FAOSTAT. https://www.fao.org/faostat/',
    status: 'reviewed',
  },
  'publicreporting.cftc.gov': {
    provider: 'CFTC Commitments of Traders',
    license: 'U.S. government public data; endpoint terms apply',
    attribution: 'U.S. Commodity Futures Trading Commission (CFTC), Commitments of Traders.',
    status: 'reviewed',
  },
  'www.sciencebase.gov': {
    provider: 'USGS ScienceBase (Mineral Commodity Summaries)',
    license: 'U.S. government public-domain mineral statistics (USGS MCS data release)',
    attribution: 'U.S. Geological Survey Mineral Commodity Summaries; link to the ScienceBase data release (https://doi.org/10.5066/P1WKQ63T).',
    status: 'reviewed',
  },
  'ogcapi.bgs.ac.uk': {
    provider: 'British Geological Survey World Mineral Statistics',
    license: 'BGS mineral statistics terms; attribution required; redistribution restricted',
    attribution: 'British Geological Survey (BGS) World Mineral Production; credit BGS and link to https://www.bgs.ac.uk/mineralsuk/statistics/world-mineral-statistics/.',
    status: 'reviewed',
  },
  'feeds.finra.org': {
    provider: 'FINRA',
    license: 'FINRA feed terms',
    attribution: 'Financial Industry Regulatory Authority (FINRA); link to the original notice.',
    status: 'terms-review',
  },
  'data.sec.gov': {
    provider: 'SEC EDGAR',
    license: 'U.S. government public data; SEC terms apply',
    attribution: 'U.S. Securities and Exchange Commission (SEC) EDGAR.',
    status: 'reviewed',
  },
  'efts.sec.gov': {
    provider: 'SEC EDGAR Full-Text Search',
    license: 'U.S. government public data; SEC terms apply',
    attribution: 'U.S. Securities and Exchange Commission (SEC) EDGAR full-text search.',
    status: 'reviewed',
  },
  'www.sec.gov': {
    provider: 'SEC',
    license: 'U.S. government public data; SEC terms apply',
    attribution: 'U.S. Securities and Exchange Commission (SEC).',
    status: 'reviewed',
  },
  'api.uspto.gov': {
    provider: 'USPTO Open Data Portal',
    license: 'U.S. government public data; USPTO terms apply',
    attribution: 'U.S. Patent and Trademark Office (USPTO) Open Data Portal.',
    status: 'reviewed',
  },
  'data.uspto.gov': {
    provider: 'USPTO Open Data Portal',
    license: 'U.S. government public data; USPTO terms apply',
    attribution: 'U.S. Patent and Trademark Office (USPTO) Open Data.',
    status: 'reviewed',
  },
  'api.openaq.org': {
    provider: 'OpenAQ',
    license: 'CC BY 4.0 (dataset/API terms may vary by measurement source)',
    attribution: 'OpenAQ, https://openaq.org/.',
    status: 'reviewed',
  },
  'api.waqi.info': {
    provider: 'World Air Quality Index (WAQI)',
    license: 'WAQI API terms; attribution required',
    attribution: 'World Air Quality Index (WAQI); link to the station/API response.',
    status: 'terms-review',
  },
  'api.safecast.org': {
    provider: 'Safecast',
    license: 'Safecast data/API terms; verify dataset license by endpoint',
    attribution: 'Safecast; link to the measurement/API response.',
    status: 'terms-review',
  },
  'radnet.epa.gov': {
    provider: 'EPA RadNet',
    license: 'U.S. government public data; EPA terms apply',
    attribution: 'U.S. Environmental Protection Agency (EPA) RadNet.',
    status: 'reviewed',
  },
  'web-api.tp.entsoe.eu': {
    provider: 'ENTSO-E Transparency Platform',
    license: 'ENTSO-E Transparency Platform terms',
    attribution: 'ENTSO-E Transparency Platform; link to the returned dataset.',
    status: 'terms-review',
  },
  'storage.googleapis.com': {
    provider: 'Ember electricity data',
    license: 'CC BY 4.0 (Ember dataset)',
    attribution: 'Ember; link to the Ember dataset and preserve its license notice.',
    status: 'reviewed',
  },
  'ourworldindata.org': {
    provider: 'Our World in Data',
    license: 'CC BY 4.0 for the dataset unless the dataset page states otherwise',
    attribution: 'Our World in Data; link to the dataset page.',
    status: 'reviewed',
  },
  'owid-public.owid.io': {
    provider: 'Our World in Data',
    license: 'CC BY 4.0 for the dataset unless the dataset page states otherwise',
    attribution: 'Our World in Data; link to the dataset page.',
    status: 'reviewed',
  },
  'globalenergymonitor.org': {
    provider: 'Global Energy Monitor',
    license: 'CC BY 4.0 for published datasets unless the dataset page states otherwise',
    attribution: 'Global Energy Monitor; link to the dataset page.',
    status: 'reviewed',
  },
  'www.tenders.gov.au': {
    provider: 'AusTender',
    license: 'Australian Government data and feed terms',
    attribution: 'Australian Government AusTender; link to the original notice/feed.',
    status: 'terms-review',
  },
  'hdr.undp.org': {
    provider: 'UNDP Human Development Report',
    license: 'UNDP data terms; dataset-specific license applies',
    attribution: 'United Nations Development Programme (UNDP) Human Development Report.',
    status: 'terms-review',
  },
  'rsf.org': {
    provider: 'Reporters Without Borders (RSF)',
    license: 'RSF terms; attribution required',
    attribution: 'Reporters Without Borders (RSF) World Press Freedom Index.',
    status: 'terms-review',
  },
  'www.visionofhumanity.org': {
    provider: 'Vision of Humanity / Global Peace Index',
    license: 'Vision of Humanity terms; attribution required',
    attribution: 'Institute for Economics & Peace, Global Peace Index / Vision of Humanity.',
    status: 'terms-review',
  },
  'www.fatf-gafi.org': {
    provider: 'Financial Action Task Force (FATF)',
    license: 'FATF website and publication terms',
    attribution: 'Financial Action Task Force (FATF); link to the original publication.',
    status: 'terms-review',
  },
  'api.opensanctions.org': {
    provider: 'OpenSanctions',
    license: 'OpenSanctions terms; dataset-specific license varies by source',
    attribution: 'OpenSanctions; link to the matching entity/dataset.',
    status: 'terms-review',
  },
  'earth-search.aws.element84.com': {
    provider: 'Element84 Earth Search STAC',
    license: 'AWS Open Data and dataset-specific collection licenses',
    attribution: 'Element84 Earth Search; preserve the collection license and link to the item.',
    status: 'terms-review',
  },
  'www.submarinecablemap.com': {
    provider: 'TeleGeography Submarine Cable Map',
    license: 'TeleGeography proprietary/provider terms',
    attribution: 'TeleGeography Submarine Cable Map; link to the source map.',
    status: 'terms-review',
  },
  'api.firecrawl.dev': {
    provider: 'Firecrawl',
    license: 'Firecrawl API terms',
    attribution: 'Firecrawl; link to the retrieved source page.',
    status: 'terms-review',
  },
  'api.search.brave.com': {
    provider: 'Brave Search API',
    license: 'Brave Search API terms',
    attribution: 'Brave Search; link to the result and original publisher.',
    status: 'terms-review',
  },
  'serpapi.com': {
    provider: 'SerpAPI',
    license: 'SerpAPI terms',
    attribution: 'SerpAPI; link to the result and original publisher.',
    status: 'terms-review',
  },
  'api.coinpaprika.com': {
    provider: 'CoinPaprika',
    license: 'CoinPaprika API terms',
    attribution: 'CoinPaprika; link to the market/API response.',
    status: 'terms-review',
  },
  'www.barchart.com': {
    provider: 'Barchart',
    license: 'Barchart terms; redistribution requires review',
    attribution: 'Barchart; link to the source quote or page.',
    status: 'terms-review',
  },
  'api.reliefweb.int': {
    provider: 'ReliefWeb (UN OCHA)',
    license: 'UN OCHA/ReliefWeb terms',
    attribution: 'ReliefWeb, United Nations Office for the Coordination of Humanitarian Affairs (OCHA).',
    status: 'terms-review',
  },
  'noaadata.apps.nsidc.org': {
    provider: 'NSIDC',
    license: 'U.S. government/public dataset terms; collection-specific license applies',
    attribution: 'National Snow and Ice Data Center (NSIDC); link to the dataset.',
    status: 'terms-review',
  },
  'www.cftc.gov': {
    provider: 'CFTC public notices',
    license: 'U.S. government public data; CFTC terms apply',
    attribution: 'U.S. Commodity Futures Trading Commission (CFTC); link to the original notice/feed.',
    status: 'reviewed',
  },
  'api.alternative.me': {
    provider: 'Alternative.me Fear & Greed Index',
    license: 'Alternative.me API terms; attribution and redistribution require review',
    attribution: 'Alternative.me Crypto Fear & Greed Index; link to the API response and methodology.',
    status: 'terms-review',
  },
  'mempool.space': {
    provider: 'mempool.space',
    license: 'mempool.space API terms; underlying Bitcoin data is public but endpoint terms apply',
    attribution: 'mempool.space; link to the mining/hashrate API response.',
    status: 'terms-review',
  },
  'api.travelpayouts.com': {
    provider: 'Travelpayouts flight-price data',
    license: 'Travelpayouts API terms; commercial use and redistribution require review',
    attribution: 'Travelpayouts; link to the returned flight-price response.',
    status: 'terms-review',
  },
  'www.swfinstitute.org': {
    provider: 'SWF Institute',
    license: 'Provider terms; attribution and redistribution require review',
    attribution: 'SWF Institute; link to the source publication.',
    status: 'terms-review',
  },
  'www.ifswf.org': {
    provider: 'International Forum of Sovereign Wealth Funds',
    license: 'Provider terms; attribution and redistribution require review',
    attribution: 'International Forum of Sovereign Wealth Funds (IFSWF); link to the source.',
    status: 'terms-review',
  },
  'api.axiom.co': {
    provider: 'Axiom telemetry',
    license: 'Excluded: World Monitor operational telemetry, not an external data provider',
    attribution: 'Excluded from the provider count: internal usage telemetry.',
    status: 'excluded',
  },
  'api.clerk.com': {
    provider: 'Clerk identity service',
    license: 'Excluded: authentication/control-plane service',
    attribution: 'Excluded from the provider count: identity-control-plane request.',
    status: 'excluded',
  },
  'api.resend.com': {
    provider: 'Resend email service',
    license: 'Excluded: transactional email/control-plane service',
    attribution: 'Excluded from the provider count: transactional email delivery.',
    status: 'excluded',
  },
  'browser.mcp.cloudflare.com': {
    provider: 'Cloudflare Browser MCP',
    license: 'Excluded: optional rendering/automation connector',
    attribution: 'Excluded from the provider count: user-configured MCP connector.',
    status: 'excluded',
  },
  'radar.mcp.cloudflare.com': {
    provider: 'Cloudflare Radar MCP',
    license: 'Excluded: optional user-configured MCP connector',
    attribution: 'Excluded from the provider count: user-configured MCP connector.',
    status: 'excluded',
  },
  'mcp.airtable.com': {
    provider: 'Airtable MCP',
    license: 'Excluded: optional user-configured MCP connector',
    attribution: 'Excluded from the provider count: user-configured MCP connector.',
    status: 'excluded',
  },
  'mcp.linear.app': {
    provider: 'Linear MCP',
    license: 'Excluded: optional user-configured MCP connector',
    attribution: 'Excluded from the provider count: user-configured MCP connector.',
    status: 'excluded',
  },
  'mcp.robtex.com': {
    provider: 'Robtex MCP',
    license: 'Excluded: optional user-configured MCP connector',
    attribution: 'Excluded from the provider count: user-configured MCP connector.',
    status: 'excluded',
  },
  'api.example.com': {
    provider: 'Example API placeholder',
    license: 'Excluded: documentation/test placeholder',
    attribution: 'Excluded from the provider count: placeholder URL.',
    status: 'excluded',
  },
  'example.com': {
    provider: 'Example domain placeholder',
    license: 'Excluded: documentation/test placeholder',
    attribution: 'Excluded from the provider count: placeholder URL.',
    status: 'excluded',
  },
  'internal.example.com': {
    provider: 'Internal example placeholder',
    license: 'Excluded: documentation/test placeholder',
    attribution: 'Excluded from the provider count: placeholder URL.',
    status: 'excluded',
  },
  'localhost': {
    provider: 'Local development transport',
    license: 'Excluded: local development/test transport',
    attribution: 'Excluded from the provider count: local-only URL.',
    status: 'excluded',
  },
  '127.0.0.1': {
    provider: 'Local loopback transport',
    license: 'Excluded: local development/desktop transport',
    attribution: 'Excluded from the provider count: local-only loopback URL.',
    status: 'excluded',
  },
  'worldmonitor.invalid': {
    provider: 'WorldMonitor test origin',
    license: 'Excluded: test-only origin',
    attribution: 'Excluded from the provider count: test-only URL.',
    status: 'excluded',
  },
  'user': {
    provider: 'Proxy URL placeholder',
    license: 'Excluded: URL-format example',
    attribution: 'Excluded from the provider count: credentials placeholder.',
    status: 'excluded',
  },
  'api.worldmonitor.app': {
    provider: 'World Monitor hosted API',
    license: 'Excluded: World Monitor own service/control plane',
    attribution: 'Excluded from the external-provider count: first-party API endpoint.',
    status: 'excluded',
  },
  'proxy.worldmonitor.app': {
    provider: 'World Monitor proxy',
    license: 'Excluded: World Monitor own service/control plane',
    attribution: 'Excluded from the external-provider count: first-party proxy endpoint.',
    status: 'excluded',
  },
  'worldmonitor.app': {
    provider: 'World Monitor web app',
    license: 'Excluded: World Monitor own web application',
    attribution: 'Excluded from the external-provider count: first-party web origin.',
    status: 'excluded',
  },
  'www.worldmonitor.app': {
    provider: 'World Monitor web app',
    license: 'Excluded: World Monitor own web application',
    attribution: 'Excluded from the external-provider count: first-party web origin.',
    status: 'excluded',
  },
  'chatgpt.com': {
    provider: 'ChatGPT link',
    license: 'Excluded: documentation/UI link',
    attribution: 'Excluded from the provider count: UI link, not an ingested source.',
    status: 'excluded',
  },
  'claude.ai': {
    provider: 'Claude link',
    license: 'Excluded: documentation/UI link',
    attribution: 'Excluded from the provider count: UI link, not an ingested source.',
    status: 'excluded',
  },
  'claude.com': {
    provider: 'Claude link',
    license: 'Excluded: documentation/UI link',
    attribution: 'Excluded from the provider count: UI link, not an ingested source.',
    status: 'excluded',
  },
  'accounts.google.com': {
    provider: 'Google account sign-in',
    license: 'Excluded: authentication/UI link',
    attribution: 'Excluded from the provider count: user sign-in redirect, not an ingested source.',
    status: 'excluded',
  },
  'cdn.jsdelivr.net': {
    provider: 'jsDelivr asset CDN',
    license: 'Excluded: presentation asset/CDN',
    attribution: 'Excluded from the provider count: browser asset, not an ingested source.',
    status: 'excluded',
  },
  'purl.org': {
    provider: 'PURL namespace',
    license: 'Excluded: schema/namespace reference',
    attribution: 'Excluded from the provider count: namespace reference, not an ingested source.',
    status: 'excluded',
  },
  'www.w3.org': {
    provider: 'W3C schema reference',
    license: 'Excluded: schema/standards reference',
    attribution: 'Excluded from the provider count: standards reference, not an ingested source.',
    status: 'excluded',
  },
  'tsimobile.viarail.ca': {
    provider: 'VIA Rail Tracker (unofficial)',
    license: 'Unofficial undocumented JSON used by the VIA Rail Tracker; no published licence, schema, or SLA. Terms require review.',
    attribution: 'VIA Rail Canada; unofficial live train JSON at tsimobile.viarail.ca. Not GTFS-Realtime; best-effort only.',
    status: 'terms-review',
  },
};

const LOGICAL_ENTRIES = [
  {
    provider: 'Fintraffic Digitraffic',
    host: 'not-currently-wired',
    kind: 'candidate',
    observed: false,
    license: 'Not applicable: no live fetch is present in this checkout',
    attribution: 'Excluded from the live-provider count: issue audit named Digitraffic, but no current source call was found.',
    status: 'excluded',
  },
];

// A few seeders build a URL from a classification/configuration document and
// therefore do not contain the provider host beside the eventual fetch call.
// Keep those dynamic hosts explicit so the lexical pass still provides a
// reviewable reference and the CI gate cannot silently drop them.  The file is
// pinned but the line deliberately is not: a line pin hard-fails the whole scan
// the moment an unrelated edit shifts it.
const DYNAMIC_HOSTS = [
  { host: 'www.swfinstitute.org', kind: 'structured', path: 'scripts/seed-sovereign-wealth.mjs' },
  { host: 'www.ifswf.org', kind: 'structured', path: 'scripts/seed-sovereign-wealth.mjs' },
  { host: 'www.visionofhumanity.org', kind: 'structured', path: 'scripts/seed-resilience-static.mjs' },
  { host: 'earth-search.aws.element84.com', kind: 'structured', path: 'server/worldmonitor/imagery/v1/search-imagery.ts' },
];

const EXCLUDED_HOSTS = new Set([
  'test',
  'test.dodopayments.com',
  'live.dodopayments.com',
  'customer.dodopayments.com',
  'worldmonitor.mintlify.dev',
  'discord.com',
  'discord.gg',
  'slack.com',
  'workos.com',
  'twitter.com',
  'x.com',
  'www.linkedin.com',
  'www.facebook.com',
  'wa.me',
  't.me',
  'reddit.com',
  'openrouter.ai',
  'api.groq.com',
  'tts.baidu.com',
  'api.indexnow.org',
  'data.worldbank.org',
  'jmespath.org',
  'site.financialmodelingprep.com',
  'web.cbr.ru',
  'search.seznam.cz',
  'searchadvisor.naver.com',
  'www.bing.com',
  'yandex.com',
  'cloudflare-dns.com',
  'challenges.cloudflare.com',
  // Browser presentation, telemetry, documentation, and namespace URLs are
  // observed for drift but are not ingested upstream datasets.
  'basemaps.cartocdn.com',
  'cdn.debugbear.com',
  'fonts.googleapis.com',
  'schemas.agentskills.io',
  'search.yahoo.com',
  'tiles.openfreemap.org',
  'webcams.windy.com',
  'openstreetmap.org',
  'protomaps.com',
  // Video-page URLs and embeds are presentation transport, not ingested
  // upstream datasets; keep them out of the provider count like native HLS.
  'www.youtube.com',
  // Release links, documentation links, and repository links are control/UI
  // surfaces; GitHub API and raw-content hosts remain tracked separately.
  'github.com',
  // Provider landing-page link in MapPopup; the ingested Wingbits endpoints
  // are tracked as customer-api.wingbits.com and ecs-api.wingbits.com.
  'wingbits.com',
]);

function read(rootDir, path) {
  return readFileSync(join(rootDir, path), 'utf8');
}

function walkSourceFiles(rootDir) {
  const files = [];
  const visit = (relativeDir) => {
    const absoluteDir = join(rootDir, relativeDir);
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = join(relativeDir, entry.name).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'generated', 'e2e', 'fixtures', '__fixtures__', 'test', 'tests'].includes(entry.name)) continue;
        visit(relativePath);
      } else if (SOURCE_EXTENSIONS.has(extname(entry.name)) && !/\.(test|spec)\./.test(entry.name)) {
        files.push(relativePath);
      }
    }
  };
  for (const root of SOURCE_ROOTS) visit(root);
  return files.sort();
}

function hostFromUrl(raw) {
  const match = raw.match(/^https?:\/\/([^/?#"'`<>)}\]]+)/i);
  if (!match) return null;
  const host = match[1].replace(/:\d+$/, '').toLowerCase();
  if (!host || host.length < 3 || host.includes('${') || host.includes('[') || host.includes(']') || host.includes('{')) return null;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) return null;
  return host;
}

export function scanUpstreamHosts(rootDir = ROOT) {
  const hosts = new Map();
  // References are recorded per file, never per line. A line number is not part
  // of the attribution (which records license posture and required credit), and
  // pinning one made every unrelated edit rewrite the committed manifest.
  const recordHost = (host, kind, path) => {
    const current = hosts.get(host) || { host, kinds: new Set(), references: [] };
    current.kinds.add(kind);
    if (!current.references.some((reference) => reference.path === path)) current.references.push({ path });
    hosts.set(host, current);
  };
  for (const relativePath of walkSourceFiles(rootDir)) {
    const source = read(rootDir, relativePath);
    const lineStarts = [0];
    for (let offset = source.indexOf('\n'); offset !== -1; offset = source.indexOf('\n', offset + 1)) {
      lineStarts.push(offset + 1);
    }
    const lineNumberAt = (index) => {
      let low = 0;
      let high = lineStarts.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (lineStarts[middle] <= index) low = middle + 1;
        else high = middle;
      }
      return low - 1;
    };
    let pendingDeclaration = false;
    for (const match of source.matchAll(URL_LITERAL_RE)) {
      const index = match.index ?? 0;
      const lineNumberIndex = lineNumberAt(index);
      const lineStart = lineStarts[lineNumberIndex];
      const lineEnd = lineStarts[lineNumberIndex + 1] === undefined ? source.length : lineStarts[lineNumberIndex + 1] - 1;
      const line = source.slice(lineStart, lineEnd);
      const declarationBefore = source.slice(Math.max(0, index - 280), index).match(/(?:const|let|var)\s+[A-Z][A-Z0-9_]*\s*=\s*['"`]?\s*$/);
      const preceding = source.slice(Math.max(0, index - 260), index);
      const candidate = FEED_FILES.has(relativePath)
        || SOURCE_HINT_RE.test(line)
        || SOURCE_HINT_RE.test(preceding)
        || pendingDeclaration
        || Boolean(declarationBefore);
      pendingDeclaration = DECLARATION_RE.test(line);
      if (!candidate) continue;
      const host = hostFromUrl(match[0]);
      if (!host) continue;
      const kind = relativePath === STATUS_FILE
        ? 'operational-status'
        : FEED_FILES.has(relativePath)
          ? 'feed'
          : 'structured';
      recordHost(host, kind, relativePath);
    }
  }
  for (const dynamic of DYNAMIC_HOSTS) {
    if (!existsSync(join(rootDir, dynamic.path))) continue;
    const source = read(rootDir, dynamic.path);
    // Require the host in URL position rather than anywhere in the file, so a
    // leftover mention in a comment or changelog note cannot keep a provider we
    // stopped fetching in the active inventory.
    if (!source.toLowerCase().includes(`//${dynamic.host.toLowerCase()}`)) {
      throw new Error(`source-attribution: dynamic reference ${dynamic.path} no longer builds a URL for ${dynamic.host}`);
    }
    recordHost(dynamic.host, dynamic.kind, dynamic.path);
  }
  return [...hosts.values()]
    .map((entry) => ({ ...entry, kinds: [...entry.kinds].sort(), references: entry.references.sort((a, b) => a.path.localeCompare(b.path)) }))
    .sort((a, b) => a.host.localeCompare(b.host));
}

function defaultEntry(observed) {
  const provider = observed.host;
  const kindLabel = observed.kinds.includes('operational-status') ? 'service-status endpoint' : observed.kinds.includes('feed') ? 'feed publisher' : 'upstream API/dataset';
  return {
    host: observed.host,
    provider,
    kind: observed.kinds.join('+'),
    observed: true,
    license: `Provider terms for this ${kindLabel}; verify before redistribution`,
    attribution: `Credit ${provider} and link to the original ${kindLabel}.`,
    status: 'terms-review',
  };
}

/**
 * Every `excluded` row the generator writes itself carries one of these, so a
 * row still wearing the text after its rule stopped applying is stale rather
 * than curated. Human-written exclusions (PROVIDER_OVERRIDES) never match.
 */
const GENERATED_EXCLUSIONS = [
  {
    license: 'Excluded: live-video playback transport; channel/provider terms apply separately',
    attribution: 'Excluded from the external-provider count: presentation-only HLS stream, not an ingested dataset.',
    status: 'excluded',
  },
  {
    license: 'Excluded: first-party, control-plane, UI, or rendering transport',
    attribution: 'Excluded from the external-provider count: not an ingested upstream dataset.',
    status: 'excluded',
  },
];

/**
 * Return the previous row to review status when its `excluded` no longer has a
 * rule behind it. Two ways that happens: a host retired by an earlier
 * regeneration is observed again, and a host excluded by a scanner rule (a
 * playback-only origin, say) gains a real ingest reference. Both leave an
 * active provider marked excluded, which drops it from the published count and
 * from license review while every gate stays green — so exclusion is cleared
 * unless a rule still asserts it.
 */
function clearStaleExclusion(previous, observed, override) {
  const retired = previous.observed === false;
  if (!retired && (previous.status !== 'excluded' || override.status === 'excluded')) return previous;
  const fallback = defaultEntry(observed);
  const wasGenerated = GENERATED_EXCLUSIONS.some(
    (text) => text.license === previous.license && text.attribution === previous.attribution,
  );
  // The generator's own exclusion copy describes a surface this host no longer
  // is, so it goes too. A curated credit is the reviewer's and survives.
  return wasGenerated
    ? { ...previous, status: fallback.status, license: fallback.license, attribution: fallback.attribution }
    : { ...previous, status: fallback.status };
}

/**
 * Fields this script owns for a host, which therefore cannot be curated in the
 * manifest — `--write` reasserts them on every run. Kept separate from
 * mergeEntry so the validator can tell a reviewer *where* to make an edit
 * stick instead of sending them to a command that would discard it.
 */
function overrideFor(observed) {
  if (PROVIDER_OVERRIDES[observed.host]) return PROVIDER_OVERRIDES[observed.host];
  const presentationOnly = observed.references.length > 0
    && observed.references.every((reference) => PRESENTATION_ONLY_FILES.has(reference.path));
  if (presentationOnly) return { provider: observed.host, ...GENERATED_EXCLUSIONS[0] };
  if (EXCLUDED_HOSTS.has(observed.host) || observed.host.endsWith('.worldmonitor.app')) {
    return { provider: observed.host, ...GENERATED_EXCLUSIONS[1] };
  }
  return {};
}

function mergeEntry(observed, previous) {
  const override = overrideFor(observed);
  const base = previous ? clearStaleExclusion(previous, observed, override) : defaultEntry(observed);
  return {
    ...base,
    ...override,
    host: observed.host,
    kind: observed.kinds.join('+'),
    observed: true,
    references: observed.references,
  };
}

export function loadManifest(rootDir = ROOT) {
  const path = join(rootDir, MANIFEST_PATH);
  if (!existsSync(path)) return { version: 1, entries: [], logicalEntries: [] };
  const raw = readFileSync(path, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    // A bare "Unexpected end of JSON input" names no file; say which one.
    throw new Error(`source-attribution: ${MANIFEST_PATH} is not valid JSON (${error.message})`);
  }
  return {
    version: manifest.version || 1,
    entries: Array.isArray(manifest.entries) ? manifest.entries : [],
    logicalEntries: Array.isArray(manifest.logicalEntries) ? manifest.logicalEntries : [],
  };
}

function retirementRequiredMessage(host) {
  return `${host} left the scan; confirm removal with --retire ${host} or restore a discoverable reference`;
}

export function buildManifest(
  inventory,
  previous = { entries: [], logicalEntries: [] },
  { retireHosts = [] } = {},
) {
  const previousByHost = new Map((previous.entries || []).map((entry) => [entry.host, entry]));
  const entries = inventory.map((observed) => mergeEntry(observed, previousByHost.get(observed.host)));
  const observedHosts = new Set(inventory.map((entry) => entry.host));
  const retireHostSet = new Set(retireHosts);
  for (const host of retireHostSet) {
    const previousEntry = previousByHost.get(host);
    if (!previousEntry) throw new Error(`source-attribution: cannot retire unknown host ${host}`);
    if (observedHosts.has(host)) {
      throw new Error(`source-attribution: cannot retire ${host} because the scanner still finds it`);
    }
    if (previousEntry.observed === false) {
      throw new Error(`source-attribution: cannot retire ${host} because it is already retired`);
    }
  }
  // Retain retired rows as explicit exclusions rather than silently deleting a
  // credit. This makes removals reviewable and keeps historical attribution
  // visible while ensuring only currently observed hosts count as active.
  // Rows retired by an earlier run are carried through unchanged: skipping them
  // made a second regeneration delete the credit the first one preserved, which
  // also stopped --write from being a fixpoint the check could compare against.
  for (const oldEntry of previous.entries || []) {
    if (observedHosts.has(oldEntry.host)) continue;
    // A retired row keeps its credit but loses its references: the scanner no
    // longer finds the host in those files, so publishing them would assert a
    // source path that does not contain it. The docs cell falls back to
    // "No current fetch observed", which is what is actually true.
    const { references, ...retained } = oldEntry;
    if (retained.observed !== false && !MANIFEST_STATUSES.has(retained.status)) {
      throw new Error(`source-attribution: cannot retire ${retained.host} because its manifest status is invalid`);
    }
    if (
      retained.observed !== false
      && CREDIT_BEARING_STATUSES.has(retained.status)
      && !retireHostSet.has(retained.host)
    ) {
      throw new Error(`source-attribution: ${retirementRequiredMessage(retained.host)}`);
    }
    entries.push(retained.observed === false
      ? retained
      : {
        ...retained,
        observed: false,
        status: 'excluded',
        attribution: retained.attribution || `Excluded: ${retained.host} is no longer observed in the source tree.`,
      });
  }
  const logicalEntries = [...LOGICAL_ENTRIES, ...(previous.logicalEntries || [])]
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.provider === entry.provider && candidate.host === entry.host) === index)
    .sort((a, b) => a.provider.localeCompare(b.provider));
  return { version: 1, entries: entries.sort((a, b) => a.host.localeCompare(b.host)), logicalEntries };
}

export function validateManifest(inventory, manifest) {
  const errors = [];
  const observedByHost = new Map(inventory.map((entry) => [entry.host, entry]));
  const manifestEntries = manifest.entries || [];
  const manifestByHost = new Map();
  for (const entry of manifestEntries) {
    const label = entry?.host || '(unknown host)';
    if (!entry || typeof entry !== 'object') {
      errors.push(`manifest entry ${label} must be an object`);
      continue;
    }
    if (typeof entry.host !== 'string' || !entry.host || /\s/.test(entry.host)) errors.push(`invalid manifest host ${label}`);
    if (typeof entry.observed !== 'boolean') errors.push(`manifest entry ${label} observed must be boolean`);
    if (typeof entry.kind !== 'string' || !MANIFEST_KIND_RE.test(entry.kind)) errors.push(`invalid manifest kind for ${label}`);
    if (typeof entry.status !== 'string' || !MANIFEST_STATUSES.has(entry.status)) errors.push(`invalid manifest status for ${label}`);
    if (entry.references !== undefined && !Array.isArray(entry.references)) {
      errors.push(`manifest entry ${label} references must be an array`);
    }
    const references = Array.isArray(entry.references) ? entry.references : [];
    if (entry.observed === true && references.length === 0) {
      errors.push(`manifest entry ${label} observed rows need at least one reference`);
    }
    for (const reference of references) {
      if (!reference || typeof reference.path !== 'string' || !reference.path.trim()) {
        errors.push(`manifest entry ${label} has an invalid source reference`);
      } else if (Object.keys(reference).length !== 1) {
        // A line number here is the drift the rest of this validator exists to
        // stop: it changes on every unrelated edit and credits nobody.
        errors.push(`manifest entry ${label} reference ${reference.path} carries fields beyond path`);
      }
    }
    if (manifestByHost.has(entry.host)) errors.push(`duplicate manifest entry for ${entry.host}`);
    manifestByHost.set(entry.host, entry);
  }
  for (const entry of inventory) {
    if (!Array.isArray(entry.references) || !Array.isArray(entry.kinds)) {
      // mergeEntry below reads both. Report the bad row instead of letting a
      // caller of this error-collecting function receive a raw TypeError.
      errors.push(`inventory entry ${entry.host || '(unknown host)'} must carry kinds and references arrays`);
      continue;
    }
    const manifestEntry = manifestByHost.get(entry.host);
    if (!manifestEntry) {
      errors.push(`missing manifest entry for ${entry.host}`);
      continue;
    }
    if (manifestEntry.observed !== true) {
      errors.push(`manifest must mark current host ${entry.host} observed; excluded rows need an explicit exclusion reason`);
      continue;
    }
    // Host-set membership alone cannot see a row whose scan-derived fields have
    // gone stale, which is how a committed manifest drifted from the source tree
    // while this gate stayed green. Every observed row must already equal what
    // --write would produce for it, so the check and the generator agree.
    const rebuilt = mergeEntry(entry, manifestEntry);
    const stale = Object.keys(rebuilt).filter((field) => !isDeepStrictEqual(rebuilt[field], manifestEntry[field]));
    if (!stale.length) continue;
    // Sending a reviewer to --write for a field this script owns would discard
    // the edit they just made to a compliance artifact. Name the real owner.
    const owned = stale.filter((field) => field in overrideFor(entry));
    errors.push(owned.length
      ? `manifest entry ${entry.host} disagrees with this script on ${owned.join(', ')}; those fields are set in scripts/source-attribution.mjs (PROVIDER_OVERRIDES or an exclusion rule) and --write will overwrite the manifest — edit the script instead`
      : `stale manifest entry for ${entry.host}: ${stale.join(', ')} no longer match the source tree; ${REGENERATE_HINT}`);
  }
  for (const entry of manifestEntries) {
    if (typeof entry.provider !== 'string' || !entry.provider.trim() || typeof entry.license !== 'string' || !entry.license.trim() || typeof entry.attribution !== 'string' || !entry.attribution.trim()) {
      errors.push(`incomplete attribution metadata for ${entry.host || '(unknown host)'}`);
    }
    if (entry.observed && !observedByHost.has(entry.host)) {
      // Two very different causes, one of which --write resolves destructively:
      // the provider really was removed, or the scanner simply lost sight of a
      // URL that moved somewhere lexical discovery cannot see. Say both, because
      // regenerating on the second retires a provider the code still fetches.
      errors.push(`manifest marks ${entry.host} observed but scanner found no current reference — ${retirementRequiredMessage(entry.host)} or add it to DYNAMIC_HOSTS`);
    }
  }
  for (const entry of manifest.logicalEntries || []) {
    const label = entry?.provider || '(unknown provider)';
    if (!entry || typeof entry !== 'object') {
      errors.push(`logical attribution entry ${label} must be an object`);
      continue;
    }
    if (typeof entry.host !== 'string' || !entry.host || /\s/.test(entry.host)) errors.push(`invalid logical attribution host ${label}`);
    if (typeof entry.observed !== 'boolean') errors.push(`logical attribution entry ${label} observed must be boolean`);
    if (typeof entry.kind !== 'string' || !LOGICAL_KIND_RE.test(entry.kind)) errors.push(`invalid logical attribution kind for ${label}`);
    if (typeof entry.status !== 'string' || !MANIFEST_STATUSES.has(entry.status)) errors.push(`invalid logical attribution status for ${label}`);
    if (typeof entry.provider !== 'string' || !entry.provider.trim() || typeof entry.license !== 'string' || !entry.license.trim() || typeof entry.attribution !== 'string' || !entry.attribution.trim()) {
      errors.push(`incomplete logical attribution metadata for ${label}`);
    }
  }
  return errors;
}

export function sourceAttributionStats(inventory, manifest) {
  const validationErrors = validateManifest(inventory, manifest);
  if (validationErrors.length) throw new Error(`source-attribution: invalid manifest (${validationErrors.join('; ')})`);
  const active = (manifest.entries || []).filter((entry) => entry.observed === true && entry.status !== 'excluded');
  const structured = active.filter((entry) => entry.kind.split('+').includes('structured'));
  const feeds = active.filter((entry) => entry.kind.split('+').includes('feed'));
  const status = active.filter((entry) => entry.kind.split('+').includes('operational-status'));
  return {
    activeHosts: active.length,
    structuredHosts: structured.length,
    feedHosts: feeds.length,
    operationalStatusHosts: status.length,
    providerCount: new Set(active.map((entry) => entry.provider)).size,
    observedHosts: inventory.length,
    reviewNeeded: active.filter((entry) => entry.status === 'terms-review').length,
  };
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function renderAttributionSection(inventory, manifest) {
  const stats = sourceAttributionStats(inventory, manifest);
  const entries = [...(manifest.entries || []), ...(manifest.logicalEntries || [])]
    .sort((a, b) => (a.provider || '').localeCompare(b.provider || '') || a.host.localeCompare(b.host));
  const rows = entries.map((entry) => {
    const references = entry.references || [];
    // Say when the list is cut. A reader auditing where a provider is used
    // otherwise reads four paths as the complete answer.
    const refs = references.length > REFERENCE_DISPLAY_LIMIT
      ? `${references.slice(0, REFERENCE_DISPLAY_LIMIT).map((reference) => reference.path).join(', ')}, +${references.length - REFERENCE_DISPLAY_LIMIT} more`
      : references.map((reference) => reference.path).join(', ');
    const surface = entry.observed === false ? 'Excluded / candidate' : entry.kind;
    const sourceRef = refs || (entry.observed === false ? 'No current fetch observed' : 'Manifest-only review row');
    return `| ${markdownCell(entry.provider)} (${markdownCell(entry.host)}) | ${markdownCell(surface)} — ${markdownCell(sourceRef)} | ${markdownCell(entry.license)} | ${markdownCell(entry.attribution)} | ${markdownCell(entry.status)} |`;
  });
  return [
    '## Observed Upstream Inventory',
    BEGIN_MARKER,
    `This generated inventory covers **${stats.activeHosts} active upstream hosts** representing **${stats.providerCount} active providers** (**${stats.structuredHosts} structured/API**, **${stats.feedHosts} feed**, and **${stats.operationalStatusHosts} operational-status** hosts). It is derived from URL literals in \`scripts/\`, \`server/\`, \`api/\`, and \`src/\`; the manifest records a license posture and the credit required for every observed host. ${stats.reviewNeeded} entries remain marked \`terms-review\` and should be confirmed before a redistribution or commercial-use claim.`,
    '',
    '| Provider | Observed surface | License posture | Required attribution or exclusion reason | Status |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    END_MARKER,
  ].join('\n');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inventoryMarkerPattern(leadingNewline) {
  return new RegExp(
    `${leadingNewline ? '\\n' : ''}## (?:Audited|Observed) Upstream Inventory\\n` +
      `${escapeRegExp(BEGIN_MARKER)}[\\s\\S]*?${escapeRegExp(END_MARKER)}`,
  );
}

/** Single source of truth for locating the generated block, shared with the test. */
export function matchGeneratedAttributionSection(docs) {
  return docs.match(inventoryMarkerPattern(false))?.[0];
}

function updateDocs(rootDir, section) {
  const path = join(rootDir, DOCS_PATH);
  const current = readFileSync(path, 'utf8');
  const markerPattern = inventoryMarkerPattern(true);
  const updated = markerPattern.test(current)
    // Function replacement: `section` is generated from manifest text that can
    // contain `$&`/`$'`, which String.replace would otherwise expand.
    ? current.replace(markerPattern, () => `\n${section}`)
    : `${current.trimEnd()}\n\n${section}\n`;
  writeFileSync(path, updated);
}

export function buildSourceAttributionStats({ rootDir = ROOT } = {}) {
  const inventory = scanUpstreamHosts(rootDir);
  const manifest = loadManifest(rootDir);
  return sourceAttributionStats(inventory, manifest);
}

function printStats(stats, log = console.log) {
  log(`source-attribution: ${stats.activeHosts} active hosts across ${stats.providerCount} providers (${stats.structuredHosts} structured/API, ${stats.feedHosts} feed, ${stats.operationalStatusHosts} operational-status; ${stats.reviewNeeded} terms-review)`);
}

function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * The whole `--check` verdict, exported so a test can prove each way it fails
 * rather than only that it currently passes. Returns every error it found and,
 * when clean, the stats the CLI prints.
 */
export function checkSourceAttribution(rootDir = ROOT) {
  // Before anything else, because an absent manifest otherwise surfaces as one
  // "missing manifest entry" per host and never names the real cause.
  const manifestPath = join(rootDir, MANIFEST_PATH);
  if (!existsSync(manifestPath)) return { errors: [`${MANIFEST_PATH} is missing; ${REGENERATE_HINT}`] };
  const docsPath = join(rootDir, DOCS_PATH);
  if (!existsSync(docsPath)) return { errors: [`${DOCS_PATH} is missing; ${REGENERATE_HINT}`] };
  const inventory = scanUpstreamHosts(rootDir);
  const previous = loadManifest(rootDir);
  const errors = validateManifest(inventory, previous);
  if (errors.length) return { errors };
  // Compare the committed manifest against a rebuild, not against itself. The
  // per-row validation above covers observed hosts; this catches the rest —
  // retired rows, logical entries, and formatting — so --check and --write can
  // no longer disagree about what the committed artifact should contain.
  const rebuilt = serializeManifest(buildManifest(inventory, previous));
  if (readFileSync(manifestPath, 'utf8') !== rebuilt) {
    return { errors: [`${MANIFEST_PATH} is out of date; ${REGENERATE_HINT}`] };
  }
  const mirrorPath = join(rootDir, MIRROR_PATH);
  if (!existsSync(mirrorPath) || readFileSync(mirrorPath, 'utf8') !== rebuilt) {
    return { errors: [`${MIRROR_PATH} is out of sync with ${MANIFEST_PATH}; ${REGENERATE_HINT}`] };
  }
  const actual = matchGeneratedAttributionSection(readFileSync(docsPath, 'utf8'));
  if (actual !== renderAttributionSection(inventory, previous)) {
    return { errors: [`${DOCS_PATH} is out of date; ${REGENERATE_HINT}`] };
  }
  return { errors: [], stats: sourceAttributionStats(inventory, previous) };
}

function parseRetireHosts(args) {
  const retireHosts = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--retire') continue;
    const host = args[index + 1];
    if (!host || host.startsWith('--')) {
      throw new Error('source-attribution: --retire requires a host');
    }
    retireHosts.push(host);
    index += 1;
  }
  return [...new Set(retireHosts)];
}

export function runSourceAttribution({
  rootDir = ROOT,
  args = [],
  log = console.log,
  warn = console.warn,
  reportError = console.error,
} = {}) {
  let retireHosts;
  try {
    retireHosts = parseRetireHosts(args);
  } catch (error) {
    reportError(error.message);
    return 1;
  }
  if (retireHosts.length && !args.includes('--write')) {
    reportError('source-attribution: --retire requires --write');
    return 1;
  }
  if (args.includes('--write')) {
    try {
      const inventory = scanUpstreamHosts(rootDir);
      const previous = loadManifest(rootDir);
      const manifest = buildManifest(inventory, previous, { retireHosts });
      // Render and count before writing anything. Both throw on a manifest row
      // that no longer validates, and a row retired by an earlier run is now kept
      // rather than dropped — so writing first would leave the manifest rewritten,
      // the docs stale, and every rerun repeating it.
      const section = renderAttributionSection(inventory, manifest);
      const stats = sourceAttributionStats(inventory, manifest);
      const serialized = serializeManifest(manifest);
      writeFileSync(join(rootDir, MANIFEST_PATH), serialized);
      // The mirror is what `scripts/`-rooted Railway services read. Writing it
      // here keeps a manual `cp` from being the only thing holding them equal.
      writeFileSync(join(rootDir, MIRROR_PATH), serialized);
      updateDocs(rootDir, section);
      const retired = manifest.entries.filter((entry) => entry.observed === false).map((entry) => entry.host);
      const newlyRetired = retired.filter(
        (host) => (previous.entries || []).some((entry) => entry.host === host && entry.observed !== false),
      );
      if (newlyRetired.length) {
        warn(`source-attribution: retired ${newlyRetired.length} host(s): ${newlyRetired.join(', ')}`);
      }
      printStats(stats, log);
    } catch (error) {
      reportError(error.message);
      return 1;
    }
    return 0;
  }
  const { errors, stats } = checkSourceAttribution(rootDir);
  if (errors.length) {
    reportError(`source-attribution: ${errors.length} manifest error(s)`);
    // A single stale scan can fault every row, so cap the listing: an unbounded
    // dump buries the first (and usually only) cause the reader needs.
    for (const error of errors.slice(0, ERROR_PRINT_LIMIT)) reportError(`- ${error}`);
    if (errors.length > ERROR_PRINT_LIMIT) reportError(`- ...and ${errors.length - ERROR_PRINT_LIMIT} more`);
    return 1;
  }
  printStats(stats, log);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('scripts/source-attribution.mjs')) {
  process.exitCode = runSourceAttribution({ args: process.argv.slice(2) });
}
