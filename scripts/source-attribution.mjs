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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = 'shared/source-attribution-manifest.json';
const DOCS_PATH = 'docs/data-sources.mdx';
// MDX comments, not HTML ones: Mintlify parses docs/data-sources.mdx as MDX v3,
// which rejects `<!--` ("Unexpected character `!` before name") and fails the
// whole deployment. The markers are interpolated into RegExp below, and `{`,
// `*`, `}` are metacharacters, so every interpolation must go through
// escapeRegExp — writing them raw silently stops the generator finding its own
// block.
const BEGIN_MARKER = '{/* BEGIN GENERATED SOURCE ATTRIBUTION */}';
const END_MARKER = '{/* END GENERATED SOURCE ATTRIBUTION */}';
const MANIFEST_STATUSES = new Set(['terms-review', 'reviewed', 'excluded']);
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
  'publicreporting.cftc.gov': {
    provider: 'CFTC Commitments of Traders',
    license: 'U.S. government public data; endpoint terms apply',
    attribution: 'U.S. Commodity Futures Trading Commission (CFTC), Commitments of Traders.',
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
// reviewable reference and the CI gate cannot silently drop them.
const DYNAMIC_HOSTS = [
  { host: 'www.swfinstitute.org', kind: 'structured', path: 'scripts/seed-sovereign-wealth.mjs', line: 24 },
  { host: 'www.ifswf.org', kind: 'structured', path: 'scripts/seed-sovereign-wealth.mjs', line: 291 },
  { host: 'www.visionofhumanity.org', kind: 'structured', path: 'scripts/seed-resilience-static.mjs', line: 614 },
  { host: 'earth-search.aws.element84.com', kind: 'structured', path: 'server/worldmonitor/imagery/v1/search-imagery.ts', line: 10 },
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
  const recordHost = (host, kind, reference) => {
    const current = hosts.get(host) || { host, kinds: new Set(), references: [] };
    current.kinds.add(kind);
    if (!current.references.some((ref) => ref.path === reference.path && ref.line === reference.line)) {
      current.references.push(reference);
    }
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
      const lineNumber = lineNumberIndex + 1;
      const kind = relativePath === STATUS_FILE
        ? 'operational-status'
        : FEED_FILES.has(relativePath)
          ? 'feed'
          : 'structured';
      recordHost(host, kind, { path: relativePath, line: lineNumber });
    }
  }
  for (const dynamic of DYNAMIC_HOSTS) {
    if (!existsSync(join(rootDir, dynamic.path))) continue;
    const source = read(rootDir, dynamic.path);
    const line = source.split('\n')[dynamic.line - 1] || '';
    if (!line.toLowerCase().includes(dynamic.host.toLowerCase())) {
      throw new Error(`source-attribution: dynamic reference ${dynamic.path}:${dynamic.line} no longer mentions ${dynamic.host}`);
    }
    recordHost(dynamic.host, dynamic.kind, { path: dynamic.path, line: dynamic.line });
  }
  return [...hosts.values()]
    .map((entry) => ({ ...entry, kinds: [...entry.kinds].sort(), references: entry.references.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line) }))
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

function mergeEntry(observed, previous) {
  const presentationOnly = observed.references.length > 0
    && observed.references.every((reference) => PRESENTATION_ONLY_FILES.has(reference.path));
  const override = PROVIDER_OVERRIDES[observed.host]
    || (presentationOnly
      ? {
        provider: observed.host,
        license: 'Excluded: live-video playback transport; channel/provider terms apply separately',
        attribution: 'Excluded from the external-provider count: presentation-only HLS stream, not an ingested dataset.',
        status: 'excluded',
      }
      : EXCLUDED_HOSTS.has(observed.host) || observed.host.endsWith('.worldmonitor.app')
      ? {
        provider: observed.host,
        license: 'Excluded: first-party, control-plane, UI, or rendering transport',
        attribution: 'Excluded from the external-provider count: not an ingested upstream dataset.',
        status: 'excluded',
      }
      : {});
  const base = previous || defaultEntry(observed);
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
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  return {
    version: manifest.version || 1,
    entries: Array.isArray(manifest.entries) ? manifest.entries : [],
    logicalEntries: Array.isArray(manifest.logicalEntries) ? manifest.logicalEntries : [],
  };
}

export function buildManifest(inventory, previous = { entries: [], logicalEntries: [] }) {
  const previousByHost = new Map((previous.entries || []).map((entry) => [entry.host, entry]));
  const entries = inventory.map((observed) => mergeEntry(observed, previousByHost.get(observed.host)));
  const observedHosts = new Set(inventory.map((entry) => entry.host));
  // Retain retired rows as explicit exclusions rather than silently deleting a
  // credit. This makes removals reviewable and keeps historical attribution
  // visible while ensuring only currently observed hosts count as active.
  for (const oldEntry of previous.entries || []) {
    if (!observedHosts.has(oldEntry.host) && oldEntry.observed !== false) {
      entries.push({
        ...oldEntry,
        observed: false,
        status: 'excluded',
        attribution: oldEntry.attribution || `Excluded: ${oldEntry.host} is no longer observed in the source tree.`,
      });
    }
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
    if (entry.observed === true) {
      if (!Array.isArray(entry.references) || entry.references.length === 0) {
        errors.push(`manifest entry ${label} observed rows need at least one reference`);
      } else {
        for (const reference of entry.references) {
          if (!reference || typeof reference.path !== 'string' || !reference.path.trim() || !Number.isInteger(reference.line) || reference.line < 1) {
            errors.push(`manifest entry ${label} has an invalid source reference`);
          }
        }
      }
    }
    if (manifestByHost.has(entry.host)) errors.push(`duplicate manifest entry for ${entry.host}`);
    manifestByHost.set(entry.host, entry);
  }
  for (const entry of inventory) {
    const manifestEntry = manifestByHost.get(entry.host);
    if (!manifestEntry) errors.push(`missing manifest entry for ${entry.host}`);
    else if (manifestEntry.observed !== true) {
      errors.push(`manifest must mark current host ${entry.host} observed; excluded rows need an explicit exclusion reason`);
    }
  }
  for (const entry of manifestEntries) {
    if (typeof entry.provider !== 'string' || !entry.provider.trim() || typeof entry.license !== 'string' || !entry.license.trim() || typeof entry.attribution !== 'string' || !entry.attribution.trim()) {
      errors.push(`incomplete attribution metadata for ${entry.host || '(unknown host)'}`);
    }
    if (entry.observed && !observedByHost.has(entry.host)) errors.push(`manifest marks ${entry.host} observed but scanner found no current reference`);
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
    const refs = (entry.references || []).slice(0, 4).map((ref) => `${ref.path}:${ref.line}`).join(', ');
    const surface = entry.observed === false ? 'Excluded / candidate' : entry.kind;
    const sourceRef = refs || (entry.observed === false ? 'No current fetch observed' : 'Manifest-only review row');
    return `| ${markdownCell(entry.provider)} (${markdownCell(entry.host)}) | ${markdownCell(surface)} — ${markdownCell(sourceRef)} | ${markdownCell(entry.license)} | ${markdownCell(entry.attribution)} | ${markdownCell(entry.status)} |`;
  });
  return [
    '## Observed Upstream Inventory',
    BEGIN_MARKER,
    `This generated inventory covers **${stats.activeHosts} active upstream hosts** (**${stats.structuredHosts} structured/API**, **${stats.feedHosts} feed**, and **${stats.operationalStatusHosts} operational-status** hosts). It is derived from URL literals in \`scripts/\`, \`server/\`, \`api/\`, and \`src/\`; the manifest records a license posture and the credit required for every observed host. ${stats.reviewNeeded} entries remain marked \`terms-review\` and should be confirmed before a redistribution or commercial-use claim.`,
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

function printStats(stats) {
  console.log(`source-attribution: ${stats.activeHosts} active hosts (${stats.structuredHosts} structured/API, ${stats.feedHosts} feed, ${stats.operationalStatusHosts} operational-status; ${stats.reviewNeeded} terms-review)`);
}

function main() {
  const write = process.argv.includes('--write');
  const inventory = scanUpstreamHosts(ROOT);
  const previous = loadManifest(ROOT);
  if (write) {
    const manifest = buildManifest(inventory, previous);
    writeFileSync(join(ROOT, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
    updateDocs(ROOT, renderAttributionSection(inventory, manifest));
    printStats(sourceAttributionStats(inventory, manifest));
    return;
  }
  const errors = validateManifest(inventory, previous);
  if (errors.length) {
    console.error(`source-attribution: ${errors.length} manifest error(s)`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  const expectedSection = renderAttributionSection(inventory, previous);
  const docs = read(ROOT, DOCS_PATH);
  const markerPattern = inventoryMarkerPattern(false);
  const actual = docs.match(markerPattern)?.[0];
  if (actual !== expectedSection) {
    console.error('source-attribution: docs/data-sources.mdx is out of date; run node scripts/source-attribution.mjs --write');
    process.exitCode = 1;
    return;
  }
  printStats(sourceAttributionStats(inventory, previous));
}

if (process.argv[1] && process.argv[1].endsWith('scripts/source-attribution.mjs')) main();
