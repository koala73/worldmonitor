// Shortlist layout for the /compare/ family: a ranked buyer's guide with an
// author byline, "best for" entries, a use-case table, and a BlogPosting +
// ItemList + FAQPage graph. build-comparison-pages.mjs keeps the registry and
// injects its shared section renderers, so this module must not import it.
//
// World Monitor prices, quotas, and inventory counts are read from the
// generated catalog and docs stats. Competitor figures are authored copy with
// a cited source for every published price.

import { readFileSync } from 'node:fs';

import { ORGANIZATION_ID, PERSON_ID, SOFTWARE_SHARED_PROPERTIES } from '../src/config/schema-graph-ids.ts';
import { computeStats } from './docs-stats.mjs';

export const SHORTLIST_LAYOUT = 'shortlist';
export const UNPUBLISHED_PRICE_CELLS = ['Enterprise-negotiated (undisclosed)', 'Not published', 'Contact sales'];
export const USE_CASE_COLUMNS = ['Use case', 'Recommended', 'Why', 'Runner-up'];
export const CTA_HEADING = 'Try World Monitor for free (no credit card required)';
export const WORLD_MONITOR_UPDATE_CADENCE = 'Source-dependent: live and minute-level feeds plus daily, weekly, and monthly datasets';
const WORLD_MONITOR = 'World Monitor';
const UNVERIFIED = 'Unverified';
const NOT_PUBLISHED = 'Not published';
const ENTERPRISE_UNDISCLOSED = 'Enterprise-negotiated (undisclosed)';

/**
 * @typedef {object} ShortlistEntry  One ranked platform; rank is its index + 1.
 * @property {string} name
 * @property {string} bestFor          H3 reads "{rank}. {name}, best for {bestFor}".
 * @property {string} [vendorUrl]      Only hosts confirmed on the fact sheet.
 * @property {string[]} paragraphs     With bestSuitedFor, 200-300 words.
 * @property {string} bestSuitedFor
 * @property {{ cell: string, model: string, freeTier: string, published: boolean,
 *   offers?: object[], sources?: { label: string, url: string }[] }} pricing
 *   `published: false` means the cell is a placeholder and no Offer may exist.
 * @property {string} latency
 * @property {string} domains
 * @property {string} signup
 * @property {string} restApi
 * @property {string} mcp              Exactly 'Unverified' without public MCP docs.
 * @property {string} seats
 * @property {string} openSource
 * @property {string} sourceCount
 * @property {string} archive
 * @property {{ label: string, href: string }[]} links
 */

/** The first 11 labels are COMPARISON_MATRIX_COLUMNS; the registry asserts it at load. */
export const SHORTLIST_MATRIX_COLUMNS = [
  ['Product', (entry) => entry.name],
  ['Price', (entry) => entry.pricing.cell],
  ['Update latency', (entry) => entry.latency],
  ['Domains covered', (entry) => entry.domains],
  ['Signup required', (entry) => entry.signup],
  ['REST API', (entry) => entry.restApi],
  ['MCP server', (entry) => entry.mcp],
  ['Open source', (entry) => entry.openSource],
  ['Source count & licensing', (entry) => entry.sourceCount],
  ['Historical archive', (entry) => entry.archive],
  ['Best for', (entry) => entry.bestFor],
  ['Pricing model', (entry) => entry.pricing.model],
  ['Free tier or trial', (entry) => entry.pricing.freeTier],
  ['Seats / team plan', (entry) => entry.seats],
];
export const UNIVERSAL_COLUMN_COUNT = 11;

const readRepoJson = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const PRODUCT_FACTS = readRepoJson('shared/product-facts.generated.json');
const TIER_CONFIG = readRepoJson('shared/product-catalog.generated.json').tierConfig;
const STATS = computeStats();

function catalogPlan(planKey) {
  const plan = PRODUCT_FACTS.plans.find((candidate) => candidate.planKey === planKey);
  if (!Number.isFinite(plan?.price)) throw new Error(`product facts are missing a priced ${planKey} plan`);
  return plan;
}

function catalogLimit(tier, field) {
  const value = TIER_CONFIG[tier]?.planLimits?.[field];
  if (!Number.isInteger(value)) throw new Error(`product catalog is missing ${tier}.planLimits.${field}`);
  return value.toLocaleString('en-US');
}

const CATALOG_PRICES = new Set(PRODUCT_FACTS.plans.map((plan) => plan.price).filter(Number.isFinite));
// A currency amount in entry prose: $65,000, £40,500, $9.54.
const PROSE_AMOUNT_RE = /[$£€]\d[\d,]*(?:\.\d+)?/g;

const monthly = (planKey) =>`$${catalogPlan(planKey).price.toFixed(2)}/mo`;

function catalogOffer(planKey) {
  const plan = catalogPlan(planKey);
  return {
    '@type': 'Offer',
    name: plan.name,
    price: plan.price.toFixed(2),
    priceCurrency: plan.priceCurrency,
    availability: plan.availability,
    url: plan.url,
  };
}

const usdOffer = (name, price, url) => ({ '@type': 'Offer', name, price, priceCurrency: 'USD', url });

const WM = {
  pro: monthly('pro_monthly'),
  proBusiness: monthly('pro_business_monthly'),
  apiStarter: monthly('api_starter'),
  apiBusiness: monthly('api_business'),
  proMcpDaily: catalogLimit('pro', 'mcpCallsPerDay'),
  proBusinessMcpDaily: catalogLimit('pro_business', 'mcpCallsPerDay'),
  starterDaily: catalogLimit('api_starter', 'apiRequestsPerDay'),
  starterPerMinute: catalogLimit('api_starter', 'apiBurstRequestsPerMinute'),
  businessDaily: catalogLimit('api_business', 'apiRequestsPerDay'),
  businessPerMinute: catalogLimit('api_business', 'apiBurstRequestsPerMinute'),
  mcpTools: `${STATS.mcpToolCount.toLocaleString('en-US')} MCP tools`,
  sourceCountCell: `${STATS.sourceAttribution.providerCount.toLocaleString('en-US')} active providers, attributed public feeds`,
};

const CHECKED_ON = '16 October 2026';

const ENTRIES = [
  {
    name: WORLD_MONITOR,
    bestFor: 'self-serve real-time monitoring with an API and MCP server',
    vendorUrl: 'https://www.worldmonitor.app/',
    paragraphs: [
      'World Monitor is a real-time global intelligence dashboard. The public map tracks conflict, maritime AIS, aviation, markets, cyber and climate signals, and it opens without signup or a credit card. Update speed depends on the source. Some feeds are live or minute-level, and others publish daily, weekly or monthly. Signals come from attributed public feeds, and the [sources page](/sources/) lists their providers.',
      `Paid plans are self-serve. Pro costs ${WM.pro} for one named user on a personal license and includes MCP and SDK access with ${WM.proMcpDaily} MCP calls a day. Pro Business costs ${WM.proBusiness}, adds a commercial license and CSV, JSON and PDF export, and raises MCP calls to ${WM.proBusinessMcpDaily} a day. API Starter costs ${WM.apiStarter} for the REST API and official SDKs for npm, PyPI, RubyGems and Go, with ${WM.starterPerMinute} requests a minute and ${WM.starterDaily} requests a day shared between REST and MCP. API Business costs ${WM.apiBusiness} for redistribution rights, ${WM.businessPerMinute} requests a minute and ${WM.businessDaily} requests a day. Enterprise is contact sales.`,
      `The MCP server exposes ${WM.mcpTools} and is listed on the [official MCP Registry](https://registry.modelcontextprotocol.io/). The [MCP quickstart](/docs/mcp-quickstart) connects Claude Desktop or another AI client. The code is open source under AGPL-3.0 on [GitHub](https://github.com/koala73/worldmonitor). World Monitor has no analyst desk, no alerting SLA and no assistance service, so it does not replace Dataminr or Crisis24 where those matter.`,
    ],
    bestSuitedFor: 'analysts, small teams and developers who want a live multi-domain map today and an API or MCP server at a published price, without a sales call.',
    pricing: {
      cell: `$0 dashboard; Pro ${WM.pro}; API Starter ${WM.apiStarter} (${WM.starterDaily} req/day)`,
      model: 'Self-serve',
      freeTier: 'Free dashboard, no signup',
      published: true,
      offers: ['pro_monthly', 'pro_business_monthly', 'api_starter', 'api_business'].map(catalogOffer),
      sources: [{ label: 'World Monitor pricing', url: 'https://www.worldmonitor.app/pro#pricing' }],
    },
    latency: WORLD_MONITOR_UPDATE_CADENCE,
    domains: 'Conflict, maritime AIS, aviation, markets, cyber, climate',
    signup: 'No',
    restApi: `From ${WM.apiStarter} (API Starter)`,
    mcp: `From ${WM.pro} (Pro)`,
    seats: '1 named user per Pro seat; API plans per organization',
    openSource: 'AGPL-3.0',
    sourceCount: WM.sourceCountCell,
    archive: 'Live + rolling published snapshots',
    links: [
      { label: 'Give your AI agent eyes on the world with the MCP server', href: '/blog/posts/worldmonitor-mcp-server-ai-agents-real-time-intelligence/' },
      { label: 'World Monitor is not an open-source Palantir', href: '/blog/posts/worldmonitor-is-not-palantir/' },
    ],
  },
  {
    name: 'Dataminr',
    bestFor: 'enterprise real-time alerting',
    paragraphs: [
      'Dataminr sells proprietary real-time alerting built on public and social data. Its enterprise contracts come with a published [service-level agreement](https://www.dataminr.com/legal/sla/) that commits to 99% monthly availability and names alert delivery as a key service. Dataminr does not publish a latency figure. Real-time detection is the reason to buy it. A corporate security operations center that must brief executives soon after a first report is the typical fit.',
      'Dataminr does not publish list pricing, so the matrix marks it enterprise-negotiated. Two public figures help with a budget. An AWS Marketplace listing shows three Dataminr Pulse Team tiers, for Corporate Risk, Brand Risk and Cyber Risk, at $65,000 per 12 months each, and the listing notes that cost can vary and points buyers to custom pricing. Vendr shows a median buyer price of $22,000 a year, with a range of $15,000 to $62,500, and does not say how many purchases that covers. That is a third-party benchmark, not a list price.',
      'A REST API comes with enterprise contracts. We have not verified an MCP server for Dataminr, so the MCP cell says unverified. Dataminr does not publish seat terms, and no free tier is published. Analysts outside the security team who only need context can use a self-serve map alongside it.',
    ],
    bestSuitedFor: 'security and risk teams that need real-time alerts under a contractual SLA and have budget for an enterprise contract.',
    pricing: {
      cell: ENTERPRISE_UNDISCLOSED,
      model: 'Sales-led',
      freeTier: 'None published',
      published: false,
      sources: [
        { label: 'AWS Marketplace: Dataminr Pulse', url: 'https://aws.amazon.com/marketplace/pp/prodview-3tflfnrcskima' },
        { label: 'Vendr Dataminr benchmark', url: 'https://www.vendr.com/marketplace/dataminr' },
      ],
    },
    latency: 'Real-time alerting (no latency figure published)',
    domains: 'Breaking events across public and social data',
    signup: 'Yes (enterprise)',
    restApi: 'Yes (enterprise)',
    mcp: UNVERIFIED,
    seats: NOT_PUBLISHED,
    openSource: 'Proprietary',
    sourceCount: 'Proprietary ingestion incl. social',
    archive: NOT_PUBLISHED,
    links: [
      { label: 'World Monitor vs Dataminr', href: '/compare/worldmonitor-vs-dataminr/' },
      { label: 'Dataminr vs World Monitor guide', href: '/blog/vs/dataminr/' },
      { label: 'Dataminr alternatives', href: '/blog/alternatives/dataminr/' },
    ],
  },
  {
    name: 'Recorded Future',
    bestFor: 'threat intelligence at enterprise scale',
    paragraphs: [
      'Recorded Future is a threat intelligence platform. It covers cyber threats, physical threats, geopolitical risk, country risk and travel safety, and it collects intelligence continuously. The breadth is the reason to buy it, because one vendor can serve the security operations team and the geopolitical desk. Enterprise customers get a REST API documented in the [Recorded Future API reference](https://docs.recordedfuture.com/reference/get-started).',
      'There is no public list price. Vendr reports a median buyer price of $72,703 a year, based on 48 purchases. A UK G-Cloud 14 listing from the reseller ITogether prices the Recorded Future platform at £40,500 a licence a year. Other G-Cloud 14 reseller listings use different units and prices, such as £7,650 a user, £10,125 a user a year and £67,500 an instance a year, so that figure describes one listing and is not the price. Treat both numbers as context for a budget conversation, not as an offer.',
      "Recorded Future made a hosted MCP server generally available in September 2026, documented on its [support site](https://support.recordedfuture.com/hc/en-us/articles/55744099282963-Recorded-Future-MCP-Overview). It is included at no extra cost on packages with unlimited integration users, and each tool call is limited to the caller's entitlements. A [free browser extension](https://go.recordedfuture.com/browser-extension) is available, and the G-Cloud listing offers a 30-day sandbox trial on request. Seat terms are not published, so ask for them in the written quote. The contract size makes Recorded Future a hard first purchase for a small team. It fits an organization that already runs a threat intelligence program.",
    ],
    bestSuitedFor: 'enterprise security teams that want cyber and geopolitical threat intelligence from one vendor and can run a procurement cycle.',
    pricing: {
      cell: ENTERPRISE_UNDISCLOSED,
      model: 'Sales-led',
      freeTier: 'Free browser extension; sandbox trial on request',
      published: false,
      sources: [
        { label: 'Vendr Recorded Future benchmark', url: 'https://www.vendr.com/marketplace/recorded-future' },
        { label: 'UK G-Cloud 14 listing (ITogether)', url: 'https://www.applytosupply.digitalmarketplace.service.gov.uk/g-cloud/services/609101270005042' },
      ],
    },
    latency: 'Continuous intelligence platform',
    domains: 'Cyber, physical threat, geopolitical, country risk, and travel safety',
    signup: 'Yes (enterprise)',
    restApi: 'Yes (enterprise)',
    mcp: 'Yes (hosted, customers only)',
    seats: 'Not published; reseller listings price per user or per licence',
    openSource: 'Proprietary',
    sourceCount: 'Proprietary collection (sources not itemized)',
    archive: 'Enterprise intelligence archive',
    links: [
      { label: 'World Monitor vs Recorded Future', href: '/compare/worldmonitor-vs-recorded-future/' },
      { label: 'Recorded Future vs World Monitor guide', href: '/blog/vs/recorded-future/' },
      { label: 'Recorded Future alternatives', href: '/blog/alternatives/recorded-future/' },
    ],
  },
  {
    name: 'Seerist',
    bestFor: 'analyst teams',
    vendorUrl: 'https://seerist.com/',
    paragraphs: [
      'Seerist is a geopolitical and security risk analysis platform sold to corporate security, risk and intelligence teams. Its AWS Marketplace listing, Seerist Decision-Ready Intelligence Platform, prices a Seerist License (5) at $75,000 per 12 months for a minimum of five named users, with private offers available. Because that listing names a fixed price and a seat count, the matrix treats it as a published price. The Dataminr listing names prices too, but no seat count, and it says cost can vary.',
      'The listing sets a floor, and buyers should still expect a contract. Terms beyond five seats are not published, and no free tier is published either. The [Seerist API page](https://seerist.com/platform/api) describes REST endpoints and server-sent events. We have not verified an MCP server for Seerist, so the MCP cell says unverified. Update latency, source mix and archive depth are not published, so those cells say so.',
      'Choose Seerist when a team of five or more analysts needs one risk analysis platform and the budget is set per team. A single analyst, or a developer who wants to prototype an agent, would still pay for five seats on that listing, far more than a self-serve plan costs. The [corporate security buyer guide](/blog/best/risk-intelligence-platforms-for-corporate-security-teams/) covers how risk teams weigh that tradeoff.',
    ],
    bestSuitedFor: 'analyst teams of five or more that want a dedicated risk analysis workspace at a known marketplace price.',
    pricing: {
      cell: '$75,000/yr for 5 named users (AWS Marketplace listing)',
      model: 'Sales-led',
      freeTier: 'None published',
      published: true,
      sources: [{ label: 'AWS Marketplace: Seerist Decision-Ready Intelligence Platform', url: 'https://aws.amazon.com/marketplace/pp/prodview-rwny7yfqed4ey' }],
    },
    latency: NOT_PUBLISHED,
    domains: 'Geopolitical and security risk analysis',
    signup: 'Yes (contract)',
    restApi: 'Yes (documented on vendor site)',
    mcp: UNVERIFIED,
    seats: '5 named users minimum on the marketplace listing',
    openSource: 'Proprietary',
    sourceCount: NOT_PUBLISHED,
    archive: NOT_PUBLISHED,
    links: [],
  },
  {
    name: 'Crisis24',
    bestFor: 'duty-of-care and travel security',
    paragraphs: [
      'Crisis24 combines travel risk alerts with assistance. A 24/7 analyst desk writes the alerts, and the company coordinates assistance for travelers who need help on the ground. That pairing is the core of a duty-of-care program. The assistance half is what monitoring platforms do not offer, and World Monitor is one of them. The desk runs around the clock, so a traveler in another time zone is covered.',
      'Crisis24 does not publish prices, so the matrix marks it enterprise-negotiated. We found no reliable public figure to cite, and seat terms and free trials are not published. Ask for alert coverage, seat count and assistance terms in the written quote. A [developer portal](https://developer.crisis24.com/) documents its REST API. A September 2026 [press release](https://www.newswire.ca/news-releases/crisis24-ecam-and-gardaworld-security-to-showcase-intelligence-led-prevention-first-security-at-gsx-2026-813323179.html) announced a Horizon MCP that connects Crisis24 intelligence to AI platforms, but we found no public documentation for it, so the MCP cell says unverified.',
      'Buy Crisis24 for the response side of travel security. A travel team that also wants wider awareness of conflict, aviation and markets can run a self-serve dashboard alongside the retainer. World Monitor does not coordinate assistance, so it works next to Crisis24 rather than in place of it. [Travel risk intelligence vs assistance](/compare/travel-risk-intelligence-vs-assistance/) explains where the two jobs split, and the [travel manager buyer guide](/blog/best/travel-risk-tools-for-travel-managers/) compares the tools that travel programs shortlist.',
    ],
    bestSuitedFor: 'travel and security managers who must keep employees safe abroad and need assistance coordination behind the alerts.',
    pricing: {
      cell: ENTERPRISE_UNDISCLOSED,
      model: 'Sales-led',
      freeTier: NOT_PUBLISHED,
      published: false,
    },
    latency: '24/7 analyst desk',
    domains: 'Travel risk alerts + assistance',
    signup: 'Yes (enterprise)',
    restApi: 'Yes (developer portal)',
    mcp: UNVERIFIED,
    seats: NOT_PUBLISHED,
    openSource: 'Proprietary',
    sourceCount: 'Analyst network',
    archive: NOT_PUBLISHED,
    links: [
      { label: 'Crisis24 vs World Monitor guide', href: '/blog/vs/crisis24/' },
      { label: 'Crisis24 alternatives', href: '/blog/alternatives/crisis24/' },
    ],
  },
  {
    name: 'Factal',
    bestFor: 'NGOs and newsrooms',
    vendorUrl: 'https://www.factal.com/',
    paragraphs: [
      'Factal sells live incident data and notifications for a flat fee per team. The fee covers unlimited users, notifications and location assets, so a newsroom can add every editor without counting seats. A desk can also add every location it tracks without a per-asset charge. Eligible life-saving NGOs get unlimited service free, and other teams can start with a 30-day free trial.',
      'Factal does not publish a dollar figure on factal.com, so the price cell says not published and a sales conversation is the only way to learn the team fee. Ask for that fee in writing and confirm what counts as one team. Its [security and AI safety data page](https://www.factal.com/solutions/security-ai-safety-data/) describes REST endpoints for live and historical incident data back to 2018, and it labels the sample payload on that page as representative only. We have not verified an MCP server for Factal, and update latency and the source list are not published.',
      'The flat fee is the reason to shortlist Factal. Per-seat pricing gets expensive for a large desk, and a team fee removes that problem. The tradeoff is price discovery, because a small team cannot see the cost before the call. Newsrooms and humanitarian teams that already work from shared alerts get the most from the model.',
    ],
    bestSuitedFor: 'newsrooms and humanitarian teams with many users, and life-saving NGOs that qualify for free access.',
    pricing: {
      cell: NOT_PUBLISHED,
      model: 'Sales-led',
      freeTier: '30-day free trial; free for eligible life-saving NGOs',
      published: false,
      sources: [
        { label: 'Factal free trial', url: 'https://www.factal.com/' },
        { label: 'Factal flat team fee', url: 'https://www.factal.com/roi/' },
        { label: 'Factal for NGOs', url: 'https://www.factal.com/solutions/ngo/' },
      ],
    },
    latency: NOT_PUBLISHED,
    domains: 'Live and historical incident data',
    signup: 'Yes (contract)',
    restApi: 'Yes (described on vendor site)',
    mcp: UNVERIFIED,
    seats: 'Unlimited users per team (flat fee)',
    openSource: 'Proprietary',
    sourceCount: NOT_PUBLISHED,
    archive: 'Incident data back to 2018 (vendor statement)',
    links: [
      { label: 'Conflict monitoring tools for humanitarian teams', href: '/blog/best/conflict-monitoring-tools-for-humanitarian-teams/' },
      { label: 'Geopolitical monitoring tools for journalists', href: '/blog/best/geopolitical-monitoring-tools-for-journalists/' },
    ],
  },
  {
    name: 'Liveuamap',
    bestFor: 'cheap map access',
    vendorUrl: 'https://liveuamap.com/',
    paragraphs: [
      'Liveuamap is a live news map centered on conflict and security events, and it also reports protests, disasters and weather. The free map is funded by ads and needs no signup, so a reader can open it straight from a news link. PRO starts at $7 per month, and an ad-free tier costs $9.54 per half-year. Those are the lowest paid prices on this list.',
      `Liveuamap also sells API access. API Pro costs $150 per month for 200 requests per day, and Enterprise starts at $1,000 per month for 1,500 requests per day. Both prices are published on the [Liveuamap API page](https://liveuamap.com/promo/api). For comparison, World Monitor API Starter costs ${WM.apiStarter} for ${WM.starterDaily} requests a day and covers maritime, aviation and market data as well as conflict.`,
      'Liveuamap does not publish a latency figure. Recent events are free, and earlier history is on PRO. Coverage centers on conflict and security news, so a team that also watches shipping, flights or markets needs a second tool. We have not verified an MCP server for Liveuamap, so the MCP cell says unverified. The product is proprietary and funded by ads, and each plan applies per account. A reader who follows one conflict closely gets a fast, familiar map for little money.',
    ],
    bestSuitedFor: 'readers and students who want a familiar conflict map for a few dollars a month, or a small API quota at a published price.',
    pricing: {
      cell: 'Free; PRO from $7/mo; API Pro $150/mo (200 req/day); Enterprise from $1,000/mo',
      model: 'Self-serve',
      freeTier: 'Free map with ads',
      published: true,
      offers: [
        usdOffer('Liveuamap PRO (monthly, from)', '7.00', 'https://me.liveuamap.com/welcome'),
        usdOffer('Liveuamap API Pro (monthly)', '150.00', 'https://liveuamap.com/promo/api'),
        usdOffer('Liveuamap Enterprise API (monthly, from)', '1000.00', 'https://liveuamap.com/promo/api'),
      ],
      sources: [
        { label: 'Liveuamap plans', url: 'https://me.liveuamap.com/welcome' },
        { label: 'Liveuamap API pricing', url: 'https://liveuamap.com/promo/api' },
      ],
    },
    latency: 'Live news feed (no latency figure published)',
    domains: 'Conflict and security news, plus protests, disasters and weather',
    signup: 'No',
    restApi: 'Yes (paid)',
    mcp: UNVERIFIED,
    seats: 'Per account',
    openSource: 'Proprietary, ad-funded',
    sourceCount: 'Curated public and social media sources (count not published)',
    archive: 'Recent events free; earlier history on PRO',
    links: [
      { label: 'World Monitor vs Liveuamap', href: '/compare/worldmonitor-vs-liveuamap/' },
      { label: 'Liveuamap alternatives', href: '/compare/liveuamap-alternatives/' },
      { label: 'Liveuamap vs World Monitor guide', href: '/blog/vs/liveuamap/' },
    ],
  },
  {
    name: 'Off-Nadir Delta',
    bestFor: 'event intelligence with satellite evidence',
    vendorUrl: 'https://offnadir-delta.com/',
    paragraphs: [
      'Off-Nadir Delta, from Off-Nadir Lab, is a hosted event intelligence service. It turns news reporting and open data into geolocated events, and each event carries its source reports and whether a satellite could have observed it, using Sentinel-1, Sentinel-2, NISAR and VIIRS. It publishes every self-serve price. Free costs $0 with 200 tokens a month and shows events up to the previous day. Starter costs $19 per month ($190 a year) with 1,000 tokens, and Pro costs $59 per month ($590 a year) with 10,000 tokens. Team costs $199 per month for up to 6 members, and Team Plus costs $499 per month for up to 20 members.',
      'Commercial use needs Pro or a team plan, because the vendor licenses Free and Starter for personal, educational and non-commercial use. Paid plans show today\'s events as they come in, and on a paid plan a one-time token pack costs $15 for 2,000 tokens, $40 for 6,000 or $90 for 15,000. The REST API and a hosted MCP server are on every plan, Free included, and the vendor documents both on its site. That makes it the cheapest way on this list to give a personal AI agent MCP access to event data.',
      'The service is proprietary, and its MCP client and Python SDK are published on GitHub under Apache-2.0. The vendor [lists its data sources](https://offnadir-delta.com/data-sources), and look-back runs 30 days on Starter and the full record on Pro. [MCP servers for geopolitical data](/compare/mcp-servers-for-geopolitical-data/) compares it with other servers that AI agents can call.',
    ],
    bestSuitedFor: 'researchers and small teams that want satellite-linked events with API and MCP access at a published price, free for personal use and from $59 a month for commercial work.',
    pricing: {
      cell: 'Free (200 tokens/mo, non-commercial); Starter $19/mo; Pro $59/mo (commercial use); Team $199/mo (6 members); Team Plus $499/mo (20 members)',
      model: 'Self-serve',
      freeTier: 'Free plan with API and MCP (non-commercial)',
      published: true,
      offers: [
        usdOffer('Off-Nadir Delta Starter (monthly)', '19.00', 'https://offnadir-delta.com/pricing'),
        usdOffer('Off-Nadir Delta Pro (monthly)', '59.00', 'https://offnadir-delta.com/pricing'),
        usdOffer('Off-Nadir Delta Team (monthly)', '199.00', 'https://offnadir-delta.com/pricing'),
        usdOffer('Off-Nadir Delta Team Plus (monthly)', '499.00', 'https://offnadir-delta.com/pricing'),
      ],
      sources: [
        { label: 'Off-Nadir Delta pricing', url: 'https://offnadir-delta.com/pricing' },
        { label: 'Off-Nadir Delta API docs', url: 'https://offnadir-delta.com/docs/api' },
        { label: 'Off-Nadir Delta MCP docs', url: 'https://offnadir-delta.com/docs/mcp' },
      ],
    },
    latency: "Paid: today's events as they come in; Free: up to the previous day",
    domains: 'Geolocated events with satellite observability',
    signup: 'Yes (free account)',
    restApi: 'Yes (documented, all plans)',
    mcp: 'Yes (hosted, documented, all plans)',
    seats: 'Team 6 members; Team Plus 20 members',
    openSource: 'Proprietary (Apache-2.0 MCP client and SDK)',
    sourceCount: 'Published list: news, hazard feeds, Sentinel, NISAR, VIIRS, FIRMS',
    archive: 'Look-back: 30 days (Starter), full record (Pro)',
    links: [],
  },
];

export const SHORTLIST_PAGE_SEEDS = [
  {
    slug: 'best-geopolitical-risk-dashboards',
    path: '/compare/best-geopolitical-risk-dashboards/',
    layout: SHORTLIST_LAYOUT,
    h1: "Best Geopolitical Risk Intelligence Platforms in 2026: The Buyer's Shortlist",
    title: 'Best Geopolitical Risk Intel Platforms 2026 | World Monitor',
    metaDescription: 'Compare 8 geopolitical risk intelligence platforms for 2026 on price, update speed, API and MCP access, free tiers and seats. World Monitor is ranked first.',
    claim: 'Self-serve real-time monitoring with an API and MCP server',
    summary: "The 2026 buyer's shortlist of eight geopolitical risk intelligence platforms, from self-serve World Monitor to sales-led Dataminr, Recorded Future, Seerist and Crisis24, with cited prices and where each one wins.",
    competitors: ['Dataminr', 'Recorded Future', 'Seerist', 'Crisis24', 'Factal', 'Liveuamap', 'Off-Nadir Delta'],
    author: {
      name: 'Elie Habib',
      path: '/blog/authors/elie-habib/',
      id: PERSON_ID,
      profiles: [
        { label: 'LinkedIn', url: 'https://www.linkedin.com/in/eliashabib' },
        { label: 'X', url: 'https://x.com/eliehabib' },
      ],
    },
    datePublished: '2026-09-04',
    checkedOn: CHECKED_ON,
    intro: `This shortlist ranks eight geopolitical risk intelligence platforms for 2026 on what a buyer can check before a sales call. World Monitor ranks #1 because its dashboard is free without signup, Pro starts at ${WM.pro}, and it ships a REST API and an MCP server. Dataminr, Recorded Future, Seerist and Crisis24 are sales-led and win on depth, speed or assistance. Factal, Liveuamap and Off-Nadir Delta fill narrower jobs for newsrooms, map readers and satellite-linked event research.`,
    keyTakeaways: [
      `Entry prices span a free dashboard and five-figure annual contracts. World Monitor Pro costs ${WM.pro}, Liveuamap PRO starts at $7 per month, and Seerist's marketplace listing is $75,000 a year for five named users.`,
      'Choose a sales-led vendor when you need a contractual SLA, threat-intelligence depth or assistance on the ground. Dataminr, Recorded Future and Crisis24 sell those on negotiated contracts.',
      `Every platform here offers some REST access. World Monitor, Recorded Future and Off-Nadir Delta document hosted MCP servers, and Recorded Future's is for its enterprise customers. World Monitor's server exposes ${WM.mcpTools} from Pro.`,
      'World Monitor is the only platform here with a published open-source license, AGPL-3.0. The other seven are proprietary, though Off-Nadir Delta publishes its MCP client and SDK under Apache-2.0.',
      'Free plans exist at World Monitor, Liveuamap and Off-Nadir Delta. Factal offers a 30-day trial and free service for eligible life-saving NGOs, and Recorded Future offers a free browser extension. Dataminr, Seerist and Crisis24 publish no free tier.',
    ],
    definition: {
      heading: 'What geopolitical risk intelligence is (and what it is not)',
      paragraphs: [
        "Geopolitical risk intelligence tracks political, military, economic and infrastructure events that can change an organization's exposure, and it turns those events into a decision. A platform in this category collects signals from many sources and places them on a map or a timeline. It tells a team what changed, where it changed, and which source reported it. The output is a judgment about exposure for a named place, route or asset.",
        'It is not news aggregation. A feed reader shows what was published. An intelligence platform has to say which reports matter for your locations, and it should show the source behind each signal. It is not travel assistance either. Assistance providers arrange evacuations and medical care, and a monitoring platform can warn a traveler but cannot send help. Crisis24 sells both, which is why it appears here next to the monitoring platforms.',
        'It is not a forecast guarantee. A risk score summarizes evidence that is already in the data, and source delays still apply, so no platform can promise to see every event first. Judge a vendor on how it labels uncertainty. The [Country Instability Index methodology](/blog/posts/country-instability-index-methodology-explained/) shows how World Monitor builds one such score. To test any platform against a real event, run the free [72-hour geopolitical event retro template](/blog/posts/72-hour-geopolitical-event-retro-template-worldmonitor/) on its alerts.',
      ],
    },
    ranking: {
      heading: 'How we ranked these platforms',
      intro: 'World Monitor publishes this page and ranks itself first, so the criteria are stated up front and every rival gets a section on where it wins. Each platform was scored on seven criteria that a buyer can check from public pages. Where a vendor does not publish a number, the cell says so instead of guessing. The order favors teams that want to start without a procurement cycle, so deeper sales-led products rank lower.',
      criteria: [
        ['Published entry price', 'Can a buyer see the lowest paid price without a sales call? A named and linked marketplace listing counts.'],
        ['Update latency', 'How quickly new events reach the user, as the vendor describes it. Source-dependent schedules are labelled that way.'],
        ['Domains covered', 'Which kinds of events the product tracks, such as conflict, maritime, aviation, markets, cyber or travel risk.'],
        ['API and MCP access', 'Whether a REST API is documented, and whether an MCP server lets AI agents query the data directly.'],
        ['Free tier or trial', 'Whether a team can use the product before paying, and with what limits.'],
        ['Seat model', 'How the vendor counts users. Named seats, per team, per organization, or not published.'],
        ['Source transparency', 'Whether the product names its sources and licenses, so an analyst can check a signal at its origin.'],
      ],
    },
    entriesHeading: 'The best geopolitical risk intelligence platforms in 2026',
    entries: ENTRIES,
    useCaseIntro: 'Match the platform to the job before you compare prices. Each row links to a longer buyer guide for that audience. More guides cover [macro analysts](/blog/best/global-intelligence-dashboards-for-macro-analysts/), [supply-chain teams](/blog/best/geopolitical-risk-tools-for-supply-chain-teams/), [travel managers](/blog/best/travel-risk-tools-for-travel-managers/) and [conflict researchers](/blog/best/conflict-data-platforms-for-researchers/).',
    useCases: [
      {
        useCase: 'Corporate security and GSOC',
        recommended: 'Dataminr (sales-led real-time alerting under an SLA) or World Monitor for a self-serve layer',
        why: 'Dataminr sells real-time alerts under a contract with a published availability SLA, and World Monitor adds a free multi-domain map for everyone outside the security desk.',
        runnerUp: 'Recorded Future',
        href: '/blog/best/risk-intelligence-platforms-for-corporate-security-teams/',
      },
      {
        useCase: 'Energy and commodity traders',
        recommended: 'World Monitor (chokepoints, markets, live map)',
        why: `One map shows chokepoints, markets and conflict together, and API Starter adds ${WM.starterDaily} requests a day for ${WM.apiStarter}.`,
        runnerUp: 'Recorded Future',
        href: '/blog/best/geopolitical-monitoring-tools-for-energy-analysts/',
      },
      {
        useCase: 'Journalists and newsrooms',
        recommended: 'Factal (flat team fee)',
        why: 'A flat fee per team covers unlimited users, so every editor can receive notifications.',
        runnerUp: WORLD_MONITOR,
        href: '/blog/best/geopolitical-monitoring-tools-for-journalists/',
      },
      {
        useCase: 'NGOs and humanitarian teams',
        recommended: 'Factal (free for eligible life-saving NGOs)',
        why: 'Factal offers its service free and unlimited to eligible life-saving NGOs.',
        runnerUp: WORLD_MONITOR,
        href: '/blog/best/conflict-monitoring-tools-for-humanitarian-teams/',
      },
      {
        useCase: 'AI and agent developers',
        recommended: 'World Monitor (REST API, MCP server, official registry listing)',
        why: `The MCP server exposes ${WM.mcpTools} from Pro at ${WM.pro} and is listed on the official MCP Registry.`,
        runnerUp: 'Off-Nadir Delta',
        href: '/blog/best/intelligence-apis-for-developers/',
      },
      {
        useCase: 'Students and researchers',
        recommended: 'World Monitor free dashboard',
        why: 'The dashboard is free with no signup, so a class can use it without creating accounts.',
        runnerUp: 'Liveuamap PRO from $7/mo',
        href: '/blog/best/osint-dashboards-for-students/',
      },
    ],
    concessionIntro: 'World Monitor ranks first on the criteria above, and it still loses specific jobs. Choose one of these vendors when your job matches the cell it wins.',
    concessions: [
      ['Dataminr', 'real-time proprietary alerting under an enterprise SLA'],
      ['Recorded Future', 'threat-intelligence depth across cyber and physical risk at enterprise scale, with a hosted MCP server for customers'],
      ['Seerist', 'analyst-team workflow with a published marketplace price for five seats'],
      ['Crisis24', 'duty-of-care assistance coordination behind the alerts'],
      ['Factal', 'a flat team fee with unlimited users and free service for eligible NGOs'],
      ['Liveuamap', 'the lowest paid prices on this list, with PRO from $7 per month'],
      ['Off-Nadir Delta', 'satellite-linked events with MCP access on every plan, free for personal use'],
    ],
    faqs: [
      ['What is the cheapest geopolitical risk intelligence platform?', `World Monitor and Liveuamap both offer free maps, and Off-Nadir Delta has a free plan with 200 tokens a month for non-commercial use. The lowest paid prices on this list are Liveuamap's: an ad-free tier at $9.54 per half-year and PRO from $7 per month. World Monitor Pro costs ${WM.pro} and adds MCP access across more domains.`],
      ['How do Dataminr and World Monitor differ?', `Dataminr sells proprietary real-time alerting under enterprise contracts with a published availability SLA, and its prices are negotiated per contract. World Monitor is a self-serve dashboard that is free without signup, with Pro at ${WM.pro} and API Starter at ${WM.apiStarter}. Choose Dataminr when an SLA matters and World Monitor when published prices and API access matter.`],
      ['What does an MCP server add to a risk platform?', `An MCP server lets an AI agent such as Claude Desktop query the platform's data directly instead of scraping pages. World Monitor's server exposes ${WM.mcpTools} from Pro, Off-Nadir Delta includes MCP on every plan, and Recorded Future offers a hosted MCP server to its customers. MCP support for the other five vendors is unverified.`],
      ['How fast do updates arrive?', 'Speed depends on the source as much as the platform. GDELT news data arrives in 15-minute batches, World Monitor refreshes IMF PortWatch history every 6 hours, and UCDP Candidate conflict data is released monthly. Dataminr describes its alerts as real time, Off-Nadir Delta shows paid users today\'s events as they come in, and most vendors describe their speed without a number.'],
      ['What can I use for free?', "World Monitor's dashboard is free with no signup and no credit card. Liveuamap has a free map with ads, and Off-Nadir Delta has a free plan with API and MCP access for non-commercial use. Factal offers a 30-day trial and is free for eligible life-saving NGOs, and Recorded Future offers a free browser extension. [Free geopolitical risk dashboards](/compare/free-geopolitical-risk-dashboards/) compares the free options in more depth."],
      ['How should I compare sales-led prices?', "Ask each vendor for a written quote with seat count, contract length and API limits, because Dataminr, Recorded Future and Crisis24 do not publish list prices. Vendr's public benchmarks report a $22,000 median for Dataminr and $72,703 for Recorded Future. Treat those as third-party figures, not prices you will be offered."],
      ['What is the difference between a self-serve and a sales-led platform?', 'A self-serve platform publishes its prices and lets you sign up and pay online. A sales-led platform sells through a contract with negotiated seats and terms. On this list World Monitor, Liveuamap and Off-Nadir Delta are self-serve, and Dataminr, Recorded Future, Seerist, Crisis24 and Factal are sales-led.'],
      ['What platforms on this list are open source?', 'World Monitor is open source under AGPL-3.0, with its code on GitHub. The other seven platforms are proprietary. Off-Nadir Delta publishes its MCP client and Python SDK under Apache-2.0, but the hosted service itself is closed.'],
    ],
    cta: {
      heading: CTA_HEADING,
      paragraphs: [
        `Open the live map and watch conflict, shipping, aviation and markets on one screen. The dashboard needs no account and no credit card. When you need more, Pro costs ${WM.pro} and adds MCP access for AI clients. API Starter costs ${WM.apiStarter} for the REST API and official SDKs. Compare every plan on the pricing page, or connect an agent with the MCP quickstart.`,
      ],
      links: [
        { label: 'Compare plans', href: '/pro#pricing' },
        { label: 'MCP quickstart', href: '/docs/mcp-quickstart' },
        { label: 'Open the live map, free', href: '/dashboard' },
      ],
    },
  },
];

const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const DASH_RE = /[\u2013\u2014]/;
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+/;

export const plainText = (value) => String(value ?? '').replace(LINK_RE, '$1');
const wordCount = (value) => plainText(value).trim().split(/\s+/).filter(Boolean).length;
const sentenceCount = (value) => plainText(value).trim().split(SENTENCE_SPLIT_RE).filter(Boolean).length;

/** Every reader-facing string, for the dash ban and the link check. */
function pageProse(seed) {
  return [
    seed.title, seed.metaDescription, seed.h1, seed.intro, ...seed.keyTakeaways,
    seed.definition.heading, ...seed.definition.paragraphs,
    seed.ranking.heading, seed.ranking.intro, ...seed.ranking.criteria.flat(),
    seed.entriesHeading,
    ...seed.entries.flatMap((entry) => [entry.bestFor, ...entry.paragraphs, entry.bestSuitedFor]),
    seed.useCaseIntro, ...seed.useCases.flatMap((row) => [row.recommended, row.why, row.runnerUp]),
    seed.concessionIntro, ...seed.concessions.flat(), ...seed.faqs.flat(), ...seed.cta.paragraphs,
  ];
}

/** Validates a shortlist seed against the brief and derives the family fields. Throws on violation. */
export function shortlistPage(seed) {
  const fail = (message) => {
    throw new Error(`${seed.slug}: ${message}`);
  };
  const titleLength = [...seed.title].length;
  if (titleLength >= 60) fail(`title must be under 60 characters, got ${titleLength}`);
  if (!seed.title.includes(WORLD_MONITOR)) fail('title must include World Monitor');
  const descriptionLength = [...seed.metaDescription].length;
  if (descriptionLength < 150 || descriptionLength > 160) fail(`meta description must be 150-160 characters, got ${descriptionLength}`);
  for (const value of pageProse(seed)) {
    if (DASH_RE.test(value)) fail(`copy must not contain an em or en dash: "${value.slice(0, 60)}"`);
    for (const [, , href] of String(value).matchAll(LINK_RE)) {
      if (!href.startsWith('/') && !href.startsWith('https://')) fail(`link "${href}" must be a site path or https URL`);
    }
  }
  const introWords = wordCount(seed.intro);
  if (introWords > 95) fail(`intro must be 95 words or fewer, got ${introWords}`);
  if (!seed.intro.includes(WORLD_MONITOR)) fail('intro must name World Monitor as the #1 entry');
  if (!/geopolitical risk intelligence platforms/i.test(seed.intro)) fail('intro must say "geopolitical risk intelligence platforms"');
  if (seed.keyTakeaways.length !== 5) fail(`needs exactly 5 key takeaways, got ${seed.keyTakeaways.length}`);
  const definitionWords = wordCount(seed.definition.paragraphs.join(' '));
  if (definitionWords < 200 || definitionWords > 300) fail(`definition must be 200-300 words, got ${definitionWords}`);
  if (seed.ranking.criteria.length < 4) fail(`needs at least 4 ranking criteria, got ${seed.ranking.criteria.length}`);

  if (seed.entries.length < 2) fail('needs at least 2 ranked entries');
  if (seed.entries[0].name !== WORLD_MONITOR) fail(`World Monitor must be the first entry, got ${seed.entries[0].name}`);
  for (const entry of seed.entries) {
    const words = wordCount([...entry.paragraphs, entry.bestSuitedFor].join(' '));
    if (words < 200 || words > 300) fail(`${entry.name} entry must be 200-300 words, got ${words}`);
    for (const [label, cell] of SHORTLIST_MATRIX_COLUMNS) {
      const value = cell(entry);
      if (typeof value !== 'string' || !value.trim()) fail(`${entry.name} is missing its "${label}" cell`);
    }
    const { pricing } = entry;
    const proseAmounts = [...entry.paragraphs, entry.bestSuitedFor].flatMap((value) => String(value).match(PROSE_AMOUNT_RE) ?? []);
    if (entry.name === WORLD_MONITOR) {
      const stray = proseAmounts.filter((amount) => !CATALOG_PRICES.has(Number(amount.slice(1).replaceAll(',', ''))));
      if (stray.length) fail(`World Monitor prose prices must come from the product catalog, got ${stray.join(', ')}`);
    } else if (proseAmounts.length && !pricing.sources?.length) {
      fail(`${entry.name} quotes ${proseAmounts.join(', ')} in prose without a cited price source`);
    }
    if (pricing.published) {
      if (!pricing.sources?.length) fail(`${entry.name} needs a cited source for its published price`);
    } else {
      if (!UNPUBLISHED_PRICE_CELLS.includes(pricing.cell)) {
        fail(`${entry.name} price is not published, so its cell must be one of ${UNPUBLISHED_PRICE_CELLS.join(' | ')}, got "${pricing.cell}"`);
      }
      if (pricing.offers !== undefined) fail(`${entry.name} cannot carry offers without a published price`);
    }
    for (const source of pricing.sources ?? []) {
      if (!source.url.startsWith('https://')) fail(`${entry.name} price source must be an https URL`);
    }
  }

  if (seed.useCases.length !== 6) fail(`needs 6 use cases, got ${seed.useCases.length}`);
  for (const row of seed.useCases) {
    if (!/^\/blog\/best\/[a-z0-9-]+\/$/.test(row.href)) fail(`use case "${row.useCase}" must link a /blog/best/ guide`);
  }
  if (seed.faqs.length < 6 || seed.faqs.length > 8) fail(`needs 6-8 FAQs, got ${seed.faqs.length}`);
  const questions = new Set(seed.faqs.map(([question]) => question.trim().toLowerCase()));
  if (questions.size !== seed.faqs.length) fail('FAQ questions must be unique');
  if (seed.cta.heading !== CTA_HEADING) fail(`CTA heading must be "${CTA_HEADING}"`);
  const ctaSentences = seed.cta.paragraphs.reduce((total, paragraph) => total + sentenceCount(paragraph), 0);
  if (ctaSentences < 5 || ctaSentences > 6) fail(`CTA must be 5-6 sentences, got ${ctaSentences}`);

  return {
    ...seed,
    itemList: seed.entries.map((entry, index) => ({ name: entry.name, position: index + 1 })),
    matrixRows: seed.entries.map((entry) => SHORTLIST_MATRIX_COLUMNS.slice(0, UNIVERSAL_COLUMN_COUNT).map(([, cell]) => cell(entry))),
  };
}

function renderInline(value, escapeHtml) {
  let html = '';
  let cursor = 0;
  for (const match of String(value).matchAll(LINK_RE)) {
    const [whole, label, href] = match;
    const rel = href.startsWith('https://') ? ' rel="noopener noreferrer"' : '';
    html += escapeHtml(value.slice(cursor, match.index)) + `<a href="${escapeHtml(href)}"${rel}>${escapeHtml(label)}</a>`;
    cursor = match.index + whole.length;
  }
  return html + escapeHtml(value.slice(cursor));
}

const joinLinks = (links, render) => links.map(render).join(', ');

function renderEntry(entry, rank, checkedOn, escapeHtml) {
  const inline = (value) => renderInline(value, escapeHtml);
  const sources = entry.pricing.sources ?? [];
  return [
    `      <h3 data-rank="${rank}">${rank}. ${escapeHtml(entry.name)}, best for ${escapeHtml(entry.bestFor)}</h3>`,
    ...entry.paragraphs.map((paragraph) => `      <p>${inline(paragraph)}</p>`),
    `      <p><strong>Best suited for:</strong> ${inline(entry.bestSuitedFor)}</p>`,
    ...(sources.length
      ? [`      <p class="source" data-price-source>${sources.length > 1 ? 'Price sources' : 'Price source'}: ${joinLinks(sources, (source) => `<a href="${escapeHtml(source.url)}" rel="noopener noreferrer">${escapeHtml(source.label)}</a>`)}. Checked ${escapeHtml(checkedOn)}.</p>`]
      : []),
    ...(entry.links.length
      ? [`      <p>Read next: ${joinLinks(entry.links, (link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`)}.</p>`]
      : []),
  ];
}

function renderTable({ attribute, caption, headers, rows }) {
  return [
    `      <div class="table-scroll"><table ${attribute}>`,
    ...(caption ? [`        <caption>${caption}</caption>`] : []),
    `        <thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead>`,
    '        <tbody>',
    ...rows.map((cells) => `          <tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`),
    '        </tbody>',
    '      </table></div>',
  ].join('\n');
}

function renderByline(page, lastmod, escapeHtml) {
  const { author } = page;
  const profiles = joinLinks(author.profiles, (profile) => `<a href="${escapeHtml(profile.url)}" rel="me noopener noreferrer">${escapeHtml(profile.label)}</a>`);
  return `      <p class="author-byline" data-author="elie-habib">By <a href="${escapeHtml(author.path)}" rel="author">${escapeHtml(author.name)}</a> (${profiles}). Published <time datetime="${escapeHtml(page.datePublished)}">${escapeHtml(page.datePublished)}</time>. Updated <time datetime="${escapeHtml(lastmod)}" data-updated>${escapeHtml(lastmod)}</time>.</p>`;
}

export function shortlistJsonLd(page, { baseUrl, lastmod, faqPageLd }) {
  const pageUrl = new URL(page.path, baseUrl).href;
  const author = {
    '@type': 'Person',
    '@id': page.author.id,
    name: page.author.name,
    url: new URL(page.author.path, baseUrl).href,
  };
  const listItem = (entry, index) => {
    const offers = entry.pricing.offers;
    const item = entry.name === WORLD_MONITOR
      ? { ...SOFTWARE_SHARED_PROPERTIES, offers }
      : { '@type': 'SoftwareApplication', name: entry.name, ...(entry.vendorUrl ? { url: entry.vendorUrl } : {}), ...(offers ? { offers } : {}) };
    return { '@type': 'ListItem', position: index + 1, name: entry.name, ...(entry.vendorUrl ? { url: entry.vendorUrl } : {}), item };
  };
  const faq = faqPageLd(page.faqs.map(([question, answer]) => [question, plainText(answer)]));
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      '@id': `${pageUrl}#webpage`,
      name: page.h1,
      description: page.metaDescription,
      url: pageUrl,
      inLanguage: 'en-US',
      datePublished: page.datePublished,
      dateModified: lastmod,
      isPartOf: { '@id': new URL('/#website', baseUrl).href },
      breadcrumb: { '@id': `${pageUrl}#breadcrumb` },
      mainEntity: { '@id': `${pageUrl}#article` },
      author,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      '@id': `${pageUrl}#article`,
      headline: page.h1,
      description: page.metaDescription,
      url: pageUrl,
      inLanguage: 'en-US',
      isAccessibleForFree: true,
      datePublished: page.datePublished,
      dateModified: lastmod,
      author,
      publisher: { '@id': ORGANIZATION_ID },
      mainEntityOfPage: { '@id': `${pageUrl}#webpage` },
      image: new URL('/favico/og-image.png', baseUrl).href,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: page.h1,
      numberOfItems: page.entries.length,
      itemListOrder: 'https://schema.org/ItemListOrderAscending',
      itemListElement: page.entries.map(listItem),
    },
    { ...faq, '@id': `${pageUrl}#faq`, author },
  ];
}

export function renderShortlistPage(page, { tpl, baseUrl, lastmod, snapshotDate, relatedReading = [], helpers }) {
  const { escapeHtml, breadcrumbLd, pageDocument } = tpl;
  const inline = (value) => renderInline(value, escapeHtml);
  const paragraphs = (values) => values.map((value) => `      <p>${inline(value)}</p>`);
  const matrix = renderTable({
    attribute: 'data-shortlist-matrix',
    caption: 'Side-by-side comparison',
    headers: SHORTLIST_MATRIX_COLUMNS.map(([label]) => escapeHtml(label)),
    rows: page.entries.map((entry) => SHORTLIST_MATRIX_COLUMNS.map(([, cell]) => escapeHtml(cell(entry)))),
  });
  const useCases = renderTable({
    attribute: 'data-use-case-table',
    headers: USE_CASE_COLUMNS.map(escapeHtml),
    rows: page.useCases.map((row) => [
      `<a href="${escapeHtml(row.href)}">${escapeHtml(row.useCase)}</a>`,
      escapeHtml(row.recommended),
      escapeHtml(row.why),
      escapeHtml(row.runnerUp),
    ]),
  });
  const ctaLinks = page.cta.links
    .map((link, index) => `<a${index === 0 ? ' class="cta"' : ''} href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`)
    .join(' · ');

  const body = [
    '      <p class="eyebrow">Compare</p>',
    `      <h1>${escapeHtml(page.h1)}</h1>`,
    renderByline(page, lastmod, escapeHtml),
    `      <p class="lede" data-intro>${inline(page.intro)}</p>`,
    '',
    '      <h2>Key takeaways</h2>',
    '      <ul data-key-takeaways>',
    ...page.keyTakeaways.map((item) => `        <li>${inline(item)}</li>`),
    '      </ul>',
    '',
    `      <h2>${escapeHtml(page.definition.heading)}</h2>`,
    ...paragraphs(page.definition.paragraphs),
    '',
    `      <h2>${escapeHtml(page.ranking.heading)}</h2>`,
    `      <p>${inline(page.ranking.intro)}</p>`,
    '      <ol data-ranking-criteria>',
    ...page.ranking.criteria.map(([name, description]) => `        <li><strong>${escapeHtml(name)}.</strong> ${inline(description)}</li>`),
    '      </ol>',
    '',
    ...helpers.renderMeasurement(page.slug, snapshotDate, escapeHtml),
    '',
    `      <h2>${escapeHtml(page.entriesHeading)}</h2>`,
    ...page.entries.flatMap((entry, index) => renderEntry(entry, index + 1, page.checkedOn, escapeHtml)),
    '',
    '      <h2>Side-by-side comparison</h2>',
    matrix,
    `      <p class="source">Prices and capabilities were checked on ${escapeHtml(page.checkedOn)} and can change. Enterprise figures marked undisclosed are negotiated, not list prices. Third-party marketplace or procurement figures are cited inline where used.</p>`,
    '',
    '      <h2>Which platform fits your use case</h2>',
    `      <p>${inline(page.useCaseIntro)}</p>`,
    useCases,
    '',
    '      <h2>When to choose them instead</h2>',
    `      <p>${inline(page.concessionIntro)}</p>`,
    '      <ul>',
    ...page.concessions.map(([name, cells]) => `        <li><strong>${escapeHtml(name)}</strong> wins on ${escapeHtml(cells)}.</li>`),
    '      </ul>',
    '',
    helpers.renderRelatedReading(relatedReading, escapeHtml),
    helpers.renderSiblingComparisons(page.slug, escapeHtml),
    '      <h2>Frequently asked questions</h2>',
    ...page.faqs.flatMap(([question, answer]) => [`      <h3>${escapeHtml(question)}</h3>`, `      <p>${inline(answer)}</p>`]),
    '',
    `      <h2 data-cta>${escapeHtml(page.cta.heading)}</h2>`,
    ...paragraphs(page.cta.paragraphs),
    `      <p class="cta-links">${ctaLinks}</p>`,
  ].join('\n');

  return pageDocument({
    baseUrl,
    path: page.path,
    title: page.title,
    description: page.metaDescription,
    lastmod,
    ogType: 'article',
    jsonLd: shortlistJsonLd(page, { baseUrl, lastmod, faqPageLd: helpers.faqPageLd }),
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Compare', path: '/compare/' },
      { name: page.h1, path: page.path },
    ]),
    body,
    footerBody: 'World Monitor comparison corpus. Prices and capabilities are committed content, reviewed at publication time; live dashboard results belong on the product surfaces.',
  });
}
