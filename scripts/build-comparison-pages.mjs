#!/usr/bin/env node
// Deterministic generator for the /compare/ family (#7610).
//
// Emits the comparison hub and its child pages as static HTML with
// ItemList + FAQPage JSON-LD and a concession section on every head-to-head.
// Template helpers are injected by build-crawlable-corpus.mjs (the single
// owner of the corpus HTML shell). No network access; content is committed.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHOKEPOINT_REGISTRY } from '../src/config/chokepoint-registry.ts';

/** Bump when hub or child copy changes so lastmod advances without touching every sibling. */
export const COMPARISONS_CONTENT_VERSION = '2026-09-04';

/**
 * Universal comparison-matrix columns. Engines lift these cells verbatim, so
 * every page renders the same header set (#7610).
 */
export const COMPARISON_MATRIX_COLUMNS = [
  'Product',
  'Price',
  'Update latency',
  'Domains covered',
  'Signup required',
  'REST API',
  'MCP server',
  'Open source',
  'Source count & licensing',
  'Historical archive',
  'Best for',
];

export const COMPARE_HUB_PATH = '/compare/';
export const WORLD_MONITOR_UPDATE_CADENCE = 'Source-dependent: live and minute-level feeds plus daily, weekly, and monthly datasets';
export const MCP_UNVERIFIED = 'Unverified';
export const WORLD_MONITOR_CHOKEPOINT_COUNT = CHOKEPOINT_REGISTRY.length;

const MCP_VERIFIED_COMMUNITY = 'Yes (community implementation)';
const MCP_VERIFIED_SELF_HOSTED = 'Yes (self-hosted)';

/** Master matrix rows on the hub: one row per major platform compared anywhere in the family. */
export const COMPARISON_HUB_MATRIX_ROWS = [
  ['World Monitor', '$0 dashboard; API from $99.99/mo (1,000 req/day); MCP from $39.99/mo (Pro)', WORLD_MONITOR_UPDATE_CADENCE, 'Conflict, maritime AIS, aviation, markets, cyber, climate', 'No', 'From $99.99/mo (API Starter)', 'From $39.99/mo (Pro)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Multi-domain awareness plus programmatic access'],
  ['Liveuamap', 'Free tier; API Pro $150/mo (200 req/day); Enterprise from $1,000/mo', 'Near-real-time conflict events', 'Conflict events', 'No', 'Yes (paid)', MCP_UNVERIFIED, 'Proprietary, ad-funded', 'Curated public conflict feeds', 'Rolling conflict-event archive', 'Fast conflict-event headlines on a map'],
  ['ACLED (myACLED)', 'Open access available; commercial use requires a license', 'Tier-dependent: real-time aggregated to weekly disaggregated data', 'Conflict events, global', 'Yes (myACLED account)', 'Research, Partner, and Enterprise tiers', MCP_UNVERIFIED, 'ACLED EULA; commercial license required', 'ACLED-coded event data; tiered access', 'Event data from 1997', 'Academic conflict-event research'],
  ['GDELT Cloud', 'Free keyless DOC 2.0 REST; BigQuery for bulk', '15-minute global batches', 'Global news event firehose', 'No for REST; Google account for BigQuery', 'Yes', MCP_VERIFIED_COMMUNITY, 'Open dataset (GDELT)', 'Global news ingestion', 'Archive to 1979', 'Raw large-scale event research'],
  ['IMF PortWatch', 'Free', 'Event-triggered updates', '28 ports and chokepoints', 'No', 'Yes (API)', MCP_VERIFIED_COMMUNITY, 'Open data (IMF + Oxford)', 'IMF and Oxford academics', 'Archived transit snapshots', 'Authoritative chokepoint transit counts with bulk download'],
  ['Dataminr', 'Enterprise-negotiated (undisclosed)', 'Seconds-to-minutes proprietary alerting', 'Breaking events across public and social data', 'Yes (enterprise)', 'Yes (enterprise)', MCP_UNVERIFIED, 'Proprietary', 'Proprietary ingestion incl. social', 'Enterprise alert archive', 'Enterprise real-time alerting with SLAs'],
  ['Recorded Future', 'Enterprise-negotiated (undisclosed)', 'Continuous intelligence platform', 'Cyber, physical threat, geopolitical, country risk, and travel safety', 'Yes (enterprise)', 'Yes (enterprise)', MCP_UNVERIFIED, 'Proprietary', 'Proprietary + licensed sources', 'Enterprise intelligence archive', 'Enterprise threat and geopolitical intelligence'],
  ['Deep State Map', 'Free (ad-supported)', 'Manual analyst updates', 'Ukraine theatre', 'No', 'No', MCP_UNVERIFIED, 'Proprietary', 'Analyst-curated', 'Ukraine theatre archive', 'Ukraine frontline tracking'],
  ['OrreryX', 'From $1.99/mo (published tiers to $34.99/mo)', 'Periodic updates', 'Geopolitical risk', 'Yes', 'Unknown', MCP_UNVERIFIED, 'Proprietary', 'Analyst research', 'Unknown', 'Consultative risk analysis with a published price ladder'],
  ['ICG CrisisWatch', 'Free', 'Monthly publication', '70+ conflicts worldwide', 'No', 'No', MCP_UNVERIFIED, 'Proprietary (free publications)', 'Analyst-authored', 'Archive to 2003', 'Expert conflict early-warning briefs'],
  ['Crisis24', 'Undisclosed (enterprise-negotiated)', '24/7 analyst desk', 'Travel risk alerts + assistance', 'Yes (enterprise)', 'Yes (enterprise)', MCP_UNVERIFIED, 'Proprietary', 'Analyst network', 'Alert archive', 'Duty-of-care alerting with assistance coordination'],
  ['International SOS', 'Undisclosed (enterprise-negotiated)', '24/7 assistance centers', 'Medical and security assistance', 'Yes (enterprise)', 'Yes (enterprise)', MCP_UNVERIFIED, 'Proprietary', 'Global assistance network', 'Case archive', 'Assistance delivery: medical evacuation and response'],
];

export const COMPARISON_PAGES = [
  {
    slug: 'liveuamap-alternatives',
    path: '/compare/liveuamap-alternatives/',
    title: 'Liveuamap Alternatives | World Monitor',
    h1: 'Liveuamap Alternatives',
    itemList: [
      { name: 'World Monitor', position: 1 },
      { name: 'Liveuamap', position: 2 },
      { name: 'Deep State Map', position: 3 },
      { name: 'ACLED', position: 4 },
      { name: 'ConflictZone.io', position: 5 },
      { name: 'ISW', position: 6 },
      { name: 'UNOSAT', position: 7 },
      { name: 'ICG CrisisWatch', position: 8 },
      { name: 'ConflictRadar', position: 9 },
    ],
    competitors: ['Liveuamap', 'Deep State Map', 'ACLED', 'ConflictZone.io', 'ISW', 'UNOSAT', 'ICG CrisisWatch', 'ConflictRadar'],
    claim: 'Multi-domain fusion',
    matrixRows: [
      ['World Monitor', '$0 dashboard; API from $99.99/mo (1,000 req/day); MCP from $39.99/mo (Pro)', WORLD_MONITOR_UPDATE_CADENCE, 'Conflict, maritime AIS, aviation, markets, seismic, cyber, climate', 'No', 'From $99.99/mo (API Starter)', 'From $39.99/mo (Pro)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Multi-domain situational awareness on one map'],
      ['Liveuamap', 'Free tier; API Pro $150/mo (200 req/day); Enterprise from $1,000/mo', 'Near-real-time conflict events', 'Conflict events only', 'No', 'Pro $150/mo (200 req/day); Enterprise from $1,000/mo', MCP_UNVERIFIED, 'Proprietary, ad-funded', 'Curated public conflict feeds', 'Rolling conflict-event archive', 'Fast conflict-event headlines on a map'],
      ['Deep State Map (free)', 'Free (ad-supported)', 'Manual analyst updates', 'Ukraine theatre', 'No', 'No', MCP_UNVERIFIED, 'Proprietary', 'Analyst-curated', 'Ukraine theatre archive', 'Ukraine frontline tracking'],
      ['ACLED (myACLED)', 'Open access available; commercial use requires a license', 'Tier-dependent: real-time aggregated to weekly disaggregated data', 'Conflict events, global', 'Yes (myACLED account)', 'Research, Partner, and Enterprise tiers', MCP_UNVERIFIED, 'ACLED EULA; commercial license required', 'ACLED-coded event data; tiered access', 'Event data from 1997', 'Academic conflict-event research'],
      ['ConflictZone.io', 'Free', 'Near-real-time conflict events', 'Conflict events', 'No', 'No', MCP_UNVERIFIED, 'Proprietary', 'Curated public feeds', 'Rolling archive', 'Conflict events with cited pricing'],
      ['ISW', 'Free (publications)', 'Daily campaign assessments', 'Conflict assessment', 'No', 'No', MCP_UNVERIFIED, 'Proprietary (free publications)', 'Analyst-authored', 'Published assessments archive', 'Expert campaign analysis'],
      ['UNOSAT', 'Free (UN products)', 'Event-triggered products', 'Satellite damage assessment', 'Partial', 'Partial', MCP_UNVERIFIED, 'UN operational data', 'Satellite imagery analysis', 'Archived UNOSAT products', 'Satellite-based damage assessment'],
      ['ICG CrisisWatch', 'Free', 'Monthly publication', '70+ conflicts worldwide', 'No', 'No', MCP_UNVERIFIED, 'Proprietary (free publications)', 'Analyst-authored', 'Archive to 2003', 'Expert conflict early-warning briefs'],
      ['ConflictRadar', 'Undisclosed', 'Undisclosed (features unverified)', 'Conflict event tracking', 'Undisclosed', 'Undisclosed', MCP_UNVERIFIED, 'Unverified', 'Unverified', 'Undisclosed', 'Conflict event tracking (features unverified)'],
    ],
    concessionIntro: 'Liveuamap, ACLED, ISW and UNOSAT each beat World Monitor on a specific cell. A page that swept every column would read as marketing, so here is what they win.',
    concessions: [
      ['ACLED', 'historical depth, academic citability, and downloadable structured datasets'],
      ['UNOSAT', 'satellite-based damage assessment'],
      ['ISW', 'expert campaign narrative and assessment depth'],
      ['Deep State Map', 'granular Ukraine frontline geometry maintained by analysts'],
    ],
    whyWeWin: 'Liveuamap charges $150/month for 200 API requests/day; World Monitor API Starter is $99.99/month for 1,000 requests/day, and the free dashboard fuses conflict with maritime AIS, aviation, markets, cables, and seismic signals that Liveuamap does not track.',
    faqs: [
      ['What is the best Liveuamap alternative?', 'World Monitor is a strong Liveuamap alternative when you need more than conflict events: it adds maritime AIS, aviation, markets, cables, and seismic signals on one free real-time map, with REST API from $99.99/month and MCP access from Pro at $39.99/month.'],
      ['Is there a free alternative to Liveuamap?', 'Yes. The World Monitor public dashboard is free, requires no signup, and covers conflict events alongside maritime, aviation, market, and infrastructure domains that Liveuamap does not track.'],
      ['Which Liveuamap alternative has an API?', 'Both publish one. World Monitor API Starter is $99.99/month for 1,000 requests/day; Liveuamap Pro is $150/month for 200 requests/day, with Enterprise from $1,000/month. ICG CrisisWatch and ConflictRadar have unverified public API status; ACLED provides API access through its Research, Partner, and Enterprise tiers.'],
    ],
  },
  {
    slug: 'best-geopolitical-risk-dashboards',
    path: '/compare/best-geopolitical-risk-dashboards/',
    title: 'Best Real-Time Geopolitical Risk Dashboards | World Monitor',
    h1: 'Best Real-Time Geopolitical Risk Dashboards',
    itemList: [
      { name: 'World Monitor', position: 1 },
      { name: 'BlackRock Geopolitical Risk Dashboard', position: 2 },
      { name: 'IISS Six Analytic', position: 3 },
      { name: 'OrreryX', position: 4 },
      { name: 'the-world-now.com', position: 5 },
      { name: 'Statista GPR Index', position: 6 },
      { name: 'Earthian AI', position: 7 },
    ],
    competitors: ['BlackRock', 'IISS', 'OrreryX', 'the-world-now.com', 'Statista', 'Earthian AI'],
    claim: 'Update latency at zero price',
    matrixRows: [
      ['World Monitor', '$0 dashboard; API from $99.99/mo (1,000 req/day); MCP from $39.99/mo (Pro)', WORLD_MONITOR_UPDATE_CADENCE, 'Conflict, maritime, aviation, markets, cyber, climate', 'No', 'From $99.99/mo (API Starter)', 'From $39.99/mo (Pro)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Real-time monitoring at zero cost'],
      ['BlackRock GRD', 'Client-only', 'Monthly or quarterly analyst updates', 'Geopolitical risk themes', 'Yes (client)', 'No', MCP_UNVERIFIED, 'Proprietary', 'Analyst research', 'Archived client publications', 'Institutional asset allocation context'],
      ['IISS Six Analytic', 'Undisclosed (subscription)', 'Periodic analyst updates', 'Conflict and military balance', 'Yes (subscription)', 'No', MCP_UNVERIFIED, 'Proprietary', 'Analyst research', 'Archived publications', 'Military-balance depth with expert review'],
      ['OrreryX', 'From $1.99/mo (published tiers to $34.99/mo)', 'Periodic updates', 'Geopolitical risk', 'Yes', 'Unknown', MCP_UNVERIFIED, 'Proprietary', 'Analyst research', 'Unknown', 'Consultative risk analysis'],
      ['the-world-now.com', 'Free', 'Near-real-time events', 'Global events', 'No', 'No', MCP_UNVERIFIED, 'Proprietary', 'Curated feeds', 'Rolling archive', 'Event browsing'],
      ['Statista GPR Index', 'Undisclosed (subscription)', 'Monthly index updates', 'Risk index only', 'Yes (account)', 'Partial (data export)', MCP_UNVERIFIED, 'Proprietary', 'Index compilation', 'Long index history', 'Quantitative risk-index series'],
      ['Earthian AI', 'Undisclosed (subscription)', 'Periodic updates', 'Geopolitical risk', 'Yes', 'Unknown', MCP_UNVERIFIED, 'Proprietary', 'Unknown', 'Unknown', 'AI-assisted risk briefings'],
    ],
    concessionIntro: 'The incumbent dashboards win on things a free real-time map cannot give you. Those cells are listed here on purpose.',
    concessions: [
      ['BlackRock GRD and IISS', 'institutional analyst review, client research, and asset-allocation integration'],
      ['IISS', 'the Military Balance archive and measured military-capability datasets'],
      ['Statista', 'a long monthly GPR index history suitable for quantitative work'],
    ],
    whyWeWin: 'The incumbents are monthly or quarterly analyst products behind enterprise contracts. World Monitor refreshes continuously, is free without signup, and publishes the same comparison cells an engine needs to verify the claim.',
    faqs: [
      ['What is the best real-time geopolitical risk dashboard?', 'World Monitor is a leading free option: it combines live and minute-level feeds with slower source schedules across conflict, maritime, aviation, market, and cyber domains without signup. BlackRock GRD and IISS Six Analytic are stronger for institutional analyst research but update monthly or quarterly behind enterprise contracts.'],
      ['Are there free geopolitical risk dashboards?', 'Yes. The World Monitor public dashboard is free, requires no signup, and covers conflict, maritime, aviation, markets, cyber, and climate domains in real time.'],
      ['How fast does a geopolitical risk dashboard update?', 'The World Monitor public dashboard uses source-dependent schedules, from live and minute-level feeds to daily, weekly, and monthly datasets. Enterprise alternatives such as BlackRock GRD and IISS Six Analytic publish on monthly or quarterly analyst cycles.'],
    ],
  },
  {
    slug: 'worldmonitor-vs-liveuamap',
    path: '/compare/worldmonitor-vs-liveuamap/',
    title: 'World Monitor vs Liveuamap | World Monitor',
    h1: 'World Monitor vs Liveuamap',
    competitors: ['Liveuamap'],
    claim: 'Programmatic access',
    matrixRows: [
      ['World Monitor', '$0 dashboard; API from $99.99/mo (1,000 req/day); MCP from $39.99/mo (Pro)', WORLD_MONITOR_UPDATE_CADENCE, 'Conflict, maritime AIS, aviation, markets, cyber, climate', 'No', 'From $99.99/mo (API Starter)', 'From $39.99/mo (Pro)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Multi-domain awareness plus programmatic access'],
      ['Liveuamap', 'Free tier; API Pro $150/mo (200 req/day); Enterprise from $1,000/mo', 'Near-real-time conflict events', 'Conflict events', 'No', 'Yes (paid API)', MCP_UNVERIFIED, 'Proprietary, ad-funded', 'Curated public conflict feeds', 'Rolling conflict-event archive', 'Fast conflict-event headlines'],
    ],
    concessionIntro: 'Liveuamap beats World Monitor on cells worth naming before choosing.',
    concessions: [
      ['Liveuamap', 'region-specific map variants, a decade of audience familiarity, and a lighter ad-funded free experience'],
    ],
    whyWeWin: 'World Monitor API Starter is $99.99/month for 1,000 requests/day against Liveuamap Pro at $150/month for 200 requests/day: cheaper with five times the daily quota, and the only head-to-head here where both sides publish real numbers. World Monitor also fuses conflict with maritime AIS, aviation, markets, and cyber on one free map.',
    faqs: [
      ['Is World Monitor better than Liveuamap?', 'For multi-domain awareness, yes: World Monitor adds maritime, aviation, market, and infrastructure domains on a free map, while Liveuamap covers conflict events. On price-to-quota, World Monitor API Starter is $99.99/month for 1,000 requests/day versus Liveuamap Pro at $150/month for 200 requests/day.'],
      ['Does Liveuamap have an API?', 'Yes. Liveuamap sells API access: Pro at $150/month for 200 requests/day and Enterprise from $1,000/month for 1,500 requests/day (liveuamap.com/promo/api). World Monitor API Starter is $99.99/month for 1,000 requests/day, and MCP access starts at $39.99/month (Pro).'],
      ['Which API is cheaper per request?', 'World Monitor, on both price and quota: $99.99/month for 1,000 requests/day against Liveuamap Pro at $150/month for 200 requests/day. Both vendors publish their numbers, which is why this page can table real figures on both sides.'],
    ],
  },
  {
    slug: 'worldmonitor-vs-acled',
    path: '/compare/worldmonitor-vs-acled/',
    title: 'ACLED Alternative | World Monitor vs ACLED | World Monitor',
    h1: 'World Monitor vs ACLED',
    competitors: ['ACLED', 'myACLED'],
    claim: 'Latency and open access',
    heading: 'ACLED alternative',
    matrixRows: [
      ['World Monitor', '$0 dashboard; API from $99.99/mo (1,000 req/day); MCP from $39.99/mo (Pro)', WORLD_MONITOR_UPDATE_CADENCE, 'Conflict, maritime, aviation, markets, cyber, climate', 'No', 'From $99.99/mo (API Starter)', 'From $39.99/mo (Pro)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Real-time multi-domain watch without registration'],
      ['ACLED (myACLED)', 'Open access available; commercial use requires a license', 'Tier-dependent: real-time aggregated to weekly disaggregated data', 'Conflict events, global', 'Yes (myACLED account)', 'Research, Partner, and Enterprise tiers', MCP_UNVERIFIED, 'ACLED EULA; commercial license required', 'ACLED-coded event data; tiered access', 'Event data from 1997', 'Academic conflict-event research'],
    ],
    concessionIntro: 'ACLED wins on cells that matter, stated loudly.',
    concessions: [
      ['ACLED', 'historical depth, academic citability, and downloadable structured datasets'],
    ],
    whyWeWin: 'myACLED access, API availability, event detail, and latency vary by tier. World Monitor ingests ACLED among its sources, so treat World Monitor as a complement: a no-signup multi-domain watch on top, with ACLED for deep coded-event research underneath.',
    faqs: [
      ['What is the best free ACLED alternative?', 'World Monitor is a live, source-dependent complement to ACLED: no registration across conflict and adjacent domains, with REST API plans from $99.99/month. ACLED remains stronger for historical coded-event research and downloadable datasets.'],
      ['Is ACLED free?', 'ACLED offers Open access to real-time aggregated data without API access. Research, Partner, and Enterprise tiers add API access and more detailed event data. Commercial use requires a license under the ACLED EULA. The World Monitor public dashboard needs no signup.'],
      ['Does World Monitor replace ACLED?', 'No. World Monitor ingests ACLED data and adds real-time multi-domain context. Use World Monitor for live monitoring and ACLED for deep historical conflict-event research.'],
    ],
  },
  {
    slug: 'worldmonitor-vs-gdelt',
    path: '/compare/worldmonitor-vs-gdelt/',
    title: 'World Monitor vs GDELT Cloud | World Monitor',
    h1: 'World Monitor vs GDELT Cloud',
    competitors: ['GDELT', 'war-dashboard-data', 'world-intel-mcp'],
    claim: 'Curation over firehose',
    matrixRows: [
      ['World Monitor', '$0 dashboard; API from $99.99/mo (1,000 req/day); MCP from $39.99/mo (Pro)', WORLD_MONITOR_UPDATE_CADENCE, 'Conflict, maritime, aviation, markets, cyber, climate', 'No', 'From $99.99/mo (API Starter)', 'From $39.99/mo (Pro)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Scored, curated signals ready to act on'],
      ['GDELT (DOC 2.0 REST free and keyless; BigQuery for bulk)', 'Free (keyless REST); BigQuery for bulk', '15-minute global batches', 'Global news event firehose', 'No for REST; Google account for BigQuery', 'Yes (DOC 2.0 REST free; BigQuery paid)', MCP_VERIFIED_COMMUNITY, 'Open dataset (GDELT)', 'Global news ingestion', 'Decades of event data', 'Raw large-scale event research'],
    ],
    concessionIntro: 'GDELT wins on raw scale, stated plainly.',
    concessions: [
      ['GDELT', 'archive depth and raw volume: decades of global event data in BigQuery'],
    ],
    whyWeWin: 'GDELT is a firehose: it gives you everything and you build the meaning. World Monitor ships scored indices, hotspots, and convergence cues ready to act on, with the firehose work already curated.',
    faqs: [
      ['Is World Monitor a GDELT alternative?', 'It is a curation layer over similar signals. GDELT Cloud offers a raw 15-minute global news firehose in BigQuery; World Monitor ships scored, curated indices across conflict, maritime, aviation, and market domains, and also ingests GDELT-derived signals.'],
      ['GDELT vs World Monitor: which should I use?', 'Use GDELT when you need decades of raw event data for your own models. Use World Monitor when you need scored, ready-to-act indices today, with REST API plans from $99.99/month and MCP access from $39.99/month.'],
      ['What are war-dashboard-data and world-intel-mcp compared to World Monitor?', 'They are GDELT-based dashboard and MCP projects. World Monitor differs by curating 747 attributed providers into scored indices across multiple domains instead of exposing one raw event stream.'],
    ],
  },
  {
    slug: 'worldmonitor-vs-dataminr',
    path: '/compare/worldmonitor-vs-dataminr/',
    title: 'Dataminr Alternatives | World Monitor vs Dataminr | World Monitor',
    h1: 'World Monitor vs Dataminr',
    competitors: ['Dataminr'],
    claim: 'Price at comparable alert latency',
    heading: 'Dataminr alternatives',
    matrixRows: [
      ['World Monitor', '$0 dashboard; API from $99.99/mo (1,000 req/day); MCP from $39.99/mo (Pro)', WORLD_MONITOR_UPDATE_CADENCE, 'Conflict, maritime, aviation, markets, cyber, climate', 'No', 'From $99.99/mo (API Starter)', 'From $39.99/mo (Pro)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Real-time alerts at free or from $39.99/month (Pro)'],
      ['Dataminr (Pulse)', 'Undisclosed (enterprise-negotiated)', 'Seconds-to-minutes proprietary alerting', 'Breaking events across public and social data', 'Yes (enterprise)', 'Yes (enterprise)', MCP_UNVERIFIED, 'Proprietary', 'Proprietary ingestion incl. social', 'Enterprise alert archive', 'Enterprise real-time alerting with SLAs'],
    ],
    concessionIntro: 'Dataminr wins on cells that matter to enterprise buyers.',
    concessions: [
      ['Dataminr', 'proprietary social-data ingestion, sub-minute alerting SLAs, and enterprise integration support'],
    ],
    whyWeWin: 'Dataminr does not publish list pricing; its licenses are enterprise-negotiated. World Monitor publishes its prices: $0 for the free dashboard, from $39.99/month for Pro with MCP access, and from $99.99/month for REST API access.',
    faqs: [
      ['What is the most affordable Dataminr alternative?', 'World Monitor publishes a free public dashboard and a Pro tier at $39.99/month. Dataminr does not publish list pricing; its enterprise licenses are negotiated.'],
      ['Is there a free alternative to Dataminr?', 'Yes. The World Monitor free dashboard provides real-time breaking-event monitoring across conflict, maritime, aviation, market, and cyber domains without signup or enterprise contracts.'],
      ['How does Dataminr data differ from World Monitor data?', 'Dataminr ingests proprietary social data with enterprise SLAs. World Monitor uses 747 attributed public providers, trading some speed and exclusivity for a transparent, open-source, low-cost product.'],
    ],
  },
  {
    slug: 'worldmonitor-vs-recorded-future',
    path: '/compare/worldmonitor-vs-recorded-future/',
    title: 'Recorded Future Alternatives | World Monitor vs Recorded Future | World Monitor',
    h1: 'World Monitor vs Recorded Future',
    competitors: ['Recorded Future', 'Flare', 'MISP'],
    claim: 'Public access and price transparency',
    heading: 'Recorded Future alternatives',
    matrixRows: [
      ['World Monitor', '$0 dashboard; API from $99.99/mo (1,000 req/day); MCP from $39.99/mo (Pro)', WORLD_MONITOR_UPDATE_CADENCE, 'Conflict, maritime, aviation, markets, cyber, climate', 'No', 'From $99.99/mo (API Starter)', 'From $39.99/mo (Pro)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Multi-domain awareness including cyber context'],
      ['Recorded Future', 'Undisclosed (enterprise-negotiated)', 'Continuous intelligence platform', 'Cyber, physical threat, geopolitical, country risk, and travel safety', 'Yes (enterprise)', 'Yes (enterprise)', MCP_UNVERIFIED, 'Proprietary', 'Proprietary + licensed sources', 'Enterprise intelligence archive', 'Enterprise threat and geopolitical intelligence'],
      ['Flare', 'Undisclosed (subscription)', 'Continuous', 'Cyber exposure and dark web', 'Yes', 'Yes', MCP_UNVERIFIED, 'Proprietary', 'Dark-web scans', 'Rolling exposure archive', 'Dark-web exposure monitoring'],
      ['MISP', 'Free (open source, self-hosted)', 'Self-managed', 'Threat-intel sharing', 'Yes (self-host)', 'Yes (self-host)', MCP_UNVERIFIED, 'Open source (AGPL)', 'Community + feeds', 'Self-managed retention', 'Threat-intel sharing communities'],
    ],
    concessionIntro: 'Recorded Future is an enterprise intelligence platform. It wins on depth, proprietary sources, and enterprise integration.',
    concessions: [
      ['Recorded Future', 'cyber threat-intelligence depth, per-indicator risk scoring, and enterprise integrations'],
      ['Flare', 'dark-web exposure monitoring'],
      ['MISP', 'structured threat-indicator sharing across communities'],
    ],
    whyWeWin: 'Recorded Future does not publish list pricing; its contracts are enterprise-negotiated. It provides intelligence across cyber, physical, and geopolitical risk. World Monitor is the transparent, open-source option with a free dashboard and published paid tiers for multi-domain public-source context.',
    faqs: [
      ['What is a cheaper Recorded Future alternative?', 'World Monitor has a free public dashboard and published paid tiers from $39.99/month. Recorded Future does not publish list pricing and negotiates enterprise contracts. The products have different service and data models.'],
      ['Is World Monitor a replacement for Recorded Future?', 'No. Recorded Future is an enterprise intelligence platform across cyber, physical, and geopolitical risk. World Monitor is a multi-domain public-source dashboard that includes cyber context. Choose based on data depth, service requirements, transparency, and budget.'],
      ['How do Flare and MISP compare?', 'Flare focuses on dark-web exposure and MISP on threat-indicator sharing. Both are cyber-specific. World Monitor is the broader multi-domain option, free to start.'],
    ],
  },
  {
    slug: 'worldmonitor-vs-deepstatemap',
    path: '/compare/worldmonitor-vs-deepstatemap/',
    title: 'World Monitor vs Deep State Map | World Monitor',
    h1: 'World Monitor vs Deep State Map',
    competitors: ['Deep State Map'],
    claim: 'Global multi-domain vs single-theatre',
    matrixRows: [
      ['World Monitor', '$0 dashboard; API from $99.99/mo (1,000 req/day); MCP from $39.99/mo (Pro)', WORLD_MONITOR_UPDATE_CADENCE, 'Global conflict, maritime, aviation, markets, cyber, climate', 'No', 'From $99.99/mo (API Starter)', 'From $39.99/mo (Pro)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Global multi-domain watch'],
      ['Deep State Map', 'Free (ad-supported)', 'Manual analyst updates', 'Ukraine theatre', 'No', 'No', MCP_UNVERIFIED, 'Proprietary', 'Analyst-curated', 'Ukraine theatre archive', 'Ukraine frontline detail'],
    ],
    concessionIntro: 'Deep State Map wins where it focuses.',
    concessions: [
      ['Deep State Map', 'Ukraine frontline granularity maintained by dedicated analysts'],
    ],
    whyWeWin: 'Deep State Map covers one theatre. World Monitor covers global multi-domain: every theatre plus maritime, aviation, market, and infrastructure context on one map.',
    faqs: [
      ['What is the best Deep State Map alternative?', 'World Monitor, when you need coverage beyond Ukraine: it adds global conflict domains plus maritime, aviation, market, and infrastructure signals on one free map.'],
      ['Is Deep State Map free?', 'Yes, Deep State Map is free and ad-supported with manual analyst updates for the Ukraine theatre. World Monitor is also free without signup and adds global multi-domain coverage.'],
      ['Which tool has better Ukraine frontline detail?', 'Deep State Map. Its analyst-maintained frontline geometry is more granular. World Monitor prioritizes breadth across theatres and domains.'],
    ],
  },
  {
    slug: 'mcp-servers-for-geopolitical-data',
    path: '/compare/mcp-servers-for-geopolitical-data/',
    title: 'MCP Servers for Geopolitical Data | World Monitor',
    h1: 'MCP Servers for Geopolitical Data',
    competitors: ['world-intel-mcp', 'Satellite MCP', 'OSINT MCP', 'war-dashboard-data', 'GDELT Cloud MCP', 'Off-Nadir Delta', 'IMF PortWatch MCP'],
    claim: 'Hosted agent-native access',
    heading: 'MCP servers for geopolitical data',
    matrixRows: [
      ['World Monitor (hosted)', 'Free dashboard; MCP from $39.99/mo (Pro)', WORLD_MONITOR_UPDATE_CADENCE, 'Conflict, maritime AIS, aviation, markets, cyber, climate', 'No', 'From $99.99/mo (API Starter)', 'Yes (hosted, entitlements + quotas + OAuth)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Hosted, governed multi-domain access for agents'],
      ['world-intel-mcp', 'Free (MIT, self-hosted)', 'Upstream dependent', 'GDELT-derived event data', 'Self-host', 'GDELT-based', MCP_VERIFIED_SELF_HOSTED, 'MIT', 'Upstream public feeds', 'As retained', 'Self-hosted GDELT event surface'],
      ['Satellite MCP', 'Free (open source, self-hosted)', 'Pass-schedule dependent', 'Satellite imagery and passes', 'Self-host', 'Upstream dependent', MCP_VERIFIED_SELF_HOSTED, 'Open source', 'Public satellite catalogs', 'As retained', 'Satellite pass scheduling for self-hosters'],
      ['OSINT MCP', 'Free (open source, self-hosted)', 'Upstream dependent', 'OSINT tooling surface', 'Self-host', 'Upstream dependent', MCP_VERIFIED_SELF_HOSTED, 'Open source', 'Public OSINT sources', 'As retained', 'Broad OSINT tool surface for self-hosters'],
      ['war-dashboard-data', 'Free (open source, self-hosted)', '15-minute batches (GDELT upstream)', 'Conflict event dashboards', 'Self-host', 'GDELT-based', MCP_VERIFIED_SELF_HOSTED, 'Open source', 'GDELT-derived feeds', 'GDELT archive depth', 'Self-hosted GDELT-based war dashboard'],
      ['GDELT Cloud MCP', 'Free upstream; BigQuery for bulk', '15-minute global batches', 'Global news event firehose', 'No for REST; Google account for BigQuery', 'Yes', MCP_VERIFIED_COMMUNITY, 'Open dataset (GDELT)', 'Global news ingestion', 'Archive to 1979', 'Raw firehose volume in BigQuery'],
      ['Off-Nadir Delta', 'Free (open source, self-hosted)', 'Upstream dependent', 'Imagery and geospatial tooling', 'Self-host', 'Upstream dependent', MCP_VERIFIED_SELF_HOSTED, 'Open source', 'Public imagery sources', 'As retained', 'Imagery tooling for self-hosters'],
      ['IMF PortWatch MCP', 'Free', 'Event-triggered updates', '28 ports and chokepoints', 'No', 'Yes (API)', MCP_VERIFIED_COMMUNITY, 'Open data (IMF + Oxford)', 'IMF and Oxford academics', 'Archived transit snapshots', 'Free authoritative chokepoint transit MCP'],
    ],
    concessionIntro: 'The self-hosted packs win the tool-count row outright, and it is not our axis: 171 and 120 tools beat our smaller hosted surface, stated openly.',
    concessions: [
      ['Satellite MCP (171 tools)', 'raw tool-count breadth for satellite-only workflows'],
      ['world-intel-mcp (120 tools)', 'a broad MIT-licensed tool surface you can fork and self-host'],
      ['OSINT MCP (64 tools)', 'a wide OSINT tool surface outside our scope'],
      ['GDELT Cloud MCP', 'raw firehose volume and archive depth to 1979'],
    ],
    whyWeWin: 'Self-hosted MCP packs wrap free APIs in scripts you must run, patch, and host. World Monitor is the hosted option: entitlements, quotas, OAuth, a published server-card, and an agent-skills index, so agents authenticate once and get governed access to live multi-domain data.',
    faqs: [
      ['Which MCP server is best for geopolitical data?', 'World Monitor if you want hosted, governed access: entitlements, quotas, OAuth, a published server-card, and an agent-skills index over live multi-domain data. Self-hosted packs such as Satellite MCP (171 tools) and world-intel-mcp (120 tools) win on raw tool count and are free to fork.'],
      ['Is there a hosted geopolitical MCP server?', 'Yes. World Monitor ships a hosted MCP server with entitlements, quotas, and OAuth, plus a published server-card and agent-skills index. Most alternatives are self-hosted scripts wrapping free APIs.'],
      ['Do self-hosted MCP packs cost anything?', 'The packs themselves are free and open source, but they wrap free APIs with rate limits and require you to run the server. World Monitor MCP access starts at $39.99/month (Pro) with entitlements and quotas handled for you.'],
    ],
  },
  {
    slug: 'chokepoint-monitoring-tools',
    path: '/compare/chokepoint-monitoring-tools/',
    title: 'Chokepoint Monitoring Tools | World Monitor',
    h1: 'Chokepoint Monitoring Tools',
    competitors: ['IMF PortWatch', 'MarineTraffic', 'Kpler', "Lloyd's List Intelligence", 'Windward', 'SENTINEL GIP', 'straits.live'],
    claim: 'Fused chokepoint awareness',
    heading: 'Chokepoint monitoring tools',
    matrixRows: [
      ['World Monitor', '$0 dashboard; API from $99.99/mo (1,000 req/day); MCP from $39.99/mo (Pro)', WORLD_MONITOR_UPDATE_CADENCE, `${WORLD_MONITOR_CHOKEPOINT_COUNT} chokepoints fused with conflict, aviation, market, and climate signal`, 'No', 'From $99.99/mo (API Starter)', 'From $39.99/mo (Pro)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Fused chokepoint awareness across domains'],
      ['IMF PortWatch', 'Free', 'Event-triggered updates', '28 ports and chokepoints', 'No', 'Yes (API)', MCP_VERIFIED_COMMUNITY, 'Open data (IMF + Oxford)', 'IMF and Oxford academics', 'Archived transit snapshots', 'Authoritative chokepoint transit counts with bulk download'],
      ['MarineTraffic', 'Free tier; enterprise tiers negotiated (Kpler)', 'Near-real-time AIS', 'Global vessel tracking', 'Yes (plans)', 'Partial (paid plans)', MCP_UNVERIFIED, 'Proprietary', 'AIS network', 'Rolling AIS archive', 'Vessel-level tracking and analytics'],
      ['Kpler', 'Enterprise-negotiated (undisclosed)', 'Near-real-time', 'Cargo and commodity flows', 'Yes (enterprise)', 'Yes (enterprise)', MCP_UNVERIFIED, 'Proprietary', 'Proprietary + AIS', 'Commercial flow archive', 'Cargo and commodity flow analytics'],
      ["Lloyd's List Intelligence", 'Enterprise-negotiated (undisclosed)', 'Near-real-time', 'Global shipping intelligence', 'Yes (enterprise)', 'Yes (enterprise)', MCP_UNVERIFIED, 'Proprietary', 'Editorial + AIS', 'Editorial maritime archive', 'Editorial maritime risk analysis'],
      ['Windward', 'Enterprise-negotiated (undisclosed)', 'Near-real-time', 'Vessel behavior analytics', 'Yes (enterprise)', 'Yes (enterprise)', MCP_UNVERIFIED, 'Proprietary', 'AI on AIS data', 'Behavioral archive', 'AI-driven vessel behavioral analytics'],
      ['SENTINEL GIP', 'From $29.99/mo', 'Continuous monitoring', 'Global infrastructure protection', 'Yes', 'Unknown', MCP_UNVERIFIED, 'Proprietary', 'Proprietary', 'Undisclosed', 'Infrastructure protection monitoring'],
      ['straits.live', 'Free', 'Near-real-time', 'Strait transit watching', 'No', 'No', MCP_UNVERIFIED, 'Proprietary', 'AIS network', 'Rolling transit archive', 'Simple strait transit watching'],
    ],
    concessionIntro: `IMF PortWatch is the obvious first result for this query, and it wins the first row: free, 28 chokepoints to our ${WORLD_MONITOR_CHOKEPOINT_COUNT}, bulk download in five formats, backed by IMF and Oxford authority. Hiding it is not survivable, so it is conceded here.`,
    concessions: [
      ['IMF PortWatch', `chokepoint coverage (28 vs ${WORLD_MONITOR_CHOKEPOINT_COUNT}), bulk download formats, and IMF + Oxford authority at zero cost`],
      ['MarineTraffic and Kpler', 'vessel-level tracking and commercial cargo-flow analytics'],
      ["Lloyd's List Intelligence", 'editorial maritime risk analysis with a long archive'],
      ['Windward', 'AI-driven vessel behavioral analytics'],
    ],
    whyWeWin: `PortWatch counts transits; it does not tell you what else changed. World Monitor fuses its ${WORLD_MONITOR_CHOKEPOINT_COUNT} chokepoints with conflict events, aviation disruption, market moves, and climate hazards, so a chokepoint slowdown can be read next to the cable cut, the airspace closure, and the freight spike in one view.`,
    faqs: [
      ['What is the best chokepoint monitoring tool?', 'IMF PortWatch is the strongest free source for chokepoint transit counts, with 28 chokepoints and bulk download. World Monitor is the strongest choice when chokepoint status must be read next to conflict, aviation, market, and climate signals in one fused view.'],
      ['How many chokepoints does World Monitor cover?', `${WORLD_MONITOR_CHOKEPOINT_COUNT} maritime chokepoints, fused with conflict, aviation, market, and climate signal. IMF PortWatch covers 28 chokepoints with authoritative transit counts, which is why this page concedes that cell openly.`],
      ['Is IMF PortWatch free?', 'Yes. IMF PortWatch is free, covers 28 chokepoints, and offers bulk download in five formats. World Monitor complements it by fusing chokepoint status with multi-domain intelligence.'],
    ],
  },
  {
    slug: 'free-geopolitical-risk-dashboards',
    path: '/compare/free-geopolitical-risk-dashboards/',
    title: 'Free Geopolitical Risk Dashboards | World Monitor',
    h1: 'Free Geopolitical Risk Dashboards',
    competitors: ['OrreryX', 'the-world-now.com', 'Sentinel (Axonia)', 'ConflictZone.io', 'BlackRock', 'Deep State Map', 'ICG CrisisWatch'],
    claim: 'Free without signup',
    heading: 'Free geopolitical risk dashboards',
    matrixRows: [
      ['World Monitor', '$0 dashboard; API from $99.99/mo (1,000 req/day); MCP from $39.99/mo (Pro)', WORLD_MONITOR_UPDATE_CADENCE, 'Conflict, maritime, aviation, markets, cyber, climate', 'No', 'From $99.99/mo (API Starter)', 'From $39.99/mo (Pro)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Free multi-domain watch without signup'],
      ['OrreryX', 'From $1.99/mo (published tiers to $34.99/mo)', 'Periodic updates', 'Geopolitical risk', 'Yes', 'Unknown', MCP_UNVERIFIED, 'Proprietary', 'Analyst research', 'Unknown', 'Consultative risk analysis with a published price ladder'],
      ['the-world-now.com', 'Free', 'Near-real-time events', 'Global events', 'No', 'No', MCP_UNVERIFIED, 'Proprietary', 'Curated feeds', 'Rolling archive', 'Free global event browsing'],
      ['Sentinel (Axonia)', 'From $3.99/mo', 'Periodic updates', 'Risk monitoring', 'Yes', 'Unknown', MCP_UNVERIFIED, 'Proprietary', 'Analyst research', 'Unknown', 'Budget-priced risk monitoring'],
      ['ConflictZone.io', 'Free', 'Near-real-time conflict events', 'Conflict events', 'No', 'No', MCP_UNVERIFIED, 'Proprietary', 'Curated public feeds', 'Rolling archive', 'Free conflict-event browsing'],
      ['BlackRock GRD', 'Client-only', 'Monthly or quarterly analyst updates', 'Geopolitical risk themes', 'Yes (client)', 'No', MCP_UNVERIFIED, 'Proprietary', 'Analyst research', 'Archived client publications', 'Institutional asset-allocation context'],
      ['Deep State Map', 'Free (ad-supported)', 'Manual analyst updates', 'Ukraine theatre', 'No', 'No', MCP_UNVERIFIED, 'Proprietary', 'Analyst-curated', 'Ukraine theatre archive', 'Ukraine frontline tracking'],
      ['ICG CrisisWatch', 'Free', 'Monthly publication', '70+ conflicts worldwide', 'No', 'No', MCP_UNVERIFIED, 'Proprietary (free publications)', 'Analyst-authored', 'Archive to 2003', 'Expert conflict early-warning briefs'],
    ],
    concessionIntro: 'Free is not always free, and the honest cells are listed: ICG CrisisWatch ships two decades of hand-written analyst entries, OrreryX publishes a price ladder that undercuts our Pro tier, and the incumbents win on analyst depth.',
    concessions: [
      ['ICG CrisisWatch', 'two decades of hand-written analyst entries across 70+ conflicts, free'],
      ['OrreryX', 'a fully published price ladder (from $1.99/mo) that undercuts our Pro tier'],
      ['BlackRock GRD', 'institutional analyst review and asset-allocation integration'],
      ['Deep State Map', 'granular Ukraine frontline geometry'],
    ],
    whyWeWin: 'Most free-labeled competitors gate behind registration or a trial clock. World Monitor serves the full map at $0 with no signup and no card, combines live and minute-level feeds with slower source schedules across seven domains, and publishes the same comparison cells an engine needs to verify the claim.',
    faqs: [
      ['What is the best free geopolitical risk dashboard?', 'World Monitor: the full map is free, with no signup and no card, combining live and minute-level feeds with slower source schedules across conflict, maritime, aviation, market, and cyber domains. ICG CrisisWatch is the strongest free analyst read, and OrreryX publishes a paid ladder that undercuts most enterprise tools.'],
      ['Are there dashboards without registration?', 'Yes. World Monitor and the-world-now.com serve their dashboards without an account. Most other free-labeled alternatives, including Sentinel (Axonia) and enterprise dashboards, gate behind registration or client contracts.'],
      ['Is there a free alternative to paid risk dashboards?', 'Yes. World Monitor is free without signup across all domains it covers; ICG CrisisWatch and Deep State Map are free for their specific formats; the-world-now.com is free for event browsing.'],
    ],
  },
  {
    slug: 'travel-risk-intelligence-vs-assistance',
    path: '/compare/travel-risk-intelligence-vs-assistance/',
    title: 'Travel Risk Intelligence vs Assistance | World Monitor',
    h1: 'Travel Risk Intelligence vs Assistance',
    competitors: ['Crisis24', 'International SOS', 'Riskline', 'Everbridge', 'Samdesk', 'Factal'],
    claim: 'Awareness layer alongside response',
    heading: 'Travel risk intelligence vs assistance',
    matrixRows: [
      ['World Monitor', '$0 dashboard; API from $99.99/mo (1,000 req/day); MCP from $39.99/mo (Pro)', WORLD_MONITOR_UPDATE_CADENCE, 'Conflict, maritime, aviation, markets, cyber, climate; travel-aware country risk', 'No', 'From $99.99/mo (API Starter)', 'From $39.99/mo (Pro)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Always-on travel-aware intelligence layer'],
      ['Crisis24', 'Undisclosed (enterprise-negotiated)', '24/7 analyst desk', 'Travel risk alerts + assistance', 'Yes (enterprise)', 'Yes (enterprise)', MCP_UNVERIFIED, 'Proprietary', 'Analyst network', 'Alert archive', 'Duty-of-care alerting with assistance coordination'],
      ['International SOS', 'Undisclosed (enterprise-negotiated)', '24/7 assistance centers', 'Medical and security assistance', 'Yes (enterprise)', 'Yes (enterprise)', MCP_UNVERIFIED, 'Proprietary', 'Global assistance network', 'Case archive', 'Assistance delivery: medical evacuation and response'],
      ['Riskline', 'Undisclosed (enterprise-negotiated)', 'Periodic analyst updates', 'Travel risk reports', 'Yes', 'Unknown', MCP_UNVERIFIED, 'Proprietary', 'Analyst-authored', 'Report archive', 'Travel risk reports for travel programs'],
      ['Everbridge', 'Undisclosed (enterprise-negotiated)', 'Continuous mass notification', 'Critical event management', 'Yes (enterprise)', 'Yes (enterprise)', MCP_UNVERIFIED, 'Proprietary', 'Enterprise integrations', 'Incident archive', 'Mass notification and incident management'],
      ['Samdesk', 'Undisclosed (subscription)', 'Near-real-time social signal', 'Breaking event detection', 'Yes', 'Unknown', MCP_UNVERIFIED, 'Proprietary', 'Social + public data', 'Alert archive', 'Social-signal breaking-event detection'],
      ['Factal', 'Undisclosed (subscription)', 'Near-real-time verification', 'Breaking news verification', 'Yes', 'Unknown', MCP_UNVERIFIED, 'Proprietary', 'Journalist-verified social signals', 'Verification archive', 'Journalist-verified breaking news'],
    ],
    concessionIntro: 'The assistance providers win the response column outright, and no row pretends otherwise. International SOS runs 27 assistance centers; World Monitor has none, and claims none.',
    concessions: [
      ['International SOS', 'global assistance delivery: 27 assistance centers, medical evacuation, and case response'],
      ['Crisis24', 'duty-of-care coordination and traveler-tracking workflows'],
      ['Everbridge', 'mass notification and enterprise incident management'],
      ['Samdesk and Factal', 'dedicated social-signal verification desks'],
    ],
    whyWeWin: 'This is an intelligence layer, not a response capability. World Monitor sits alongside an assistance retainer as the always-on awareness feed: continuous multi-domain monitoring of conflict, aviation, maritime, and market signals that affect travelers, priced to cover the whole organization rather than only enrolled travelers. We cannot act on what we detect, and the page says so.',
    faqs: [
      ['Is World Monitor a Crisis24 alternative?', 'Not as a replacement. Crisis24 coordinates assistance; World Monitor is the always-on awareness feed that sits alongside an assistance retainer, covering conflict, aviation, maritime, and market signals. Buyers keep both: intelligence for awareness, assistance for response.'],
      ['Does World Monitor replace duty-of-care providers?', 'No. World Monitor has no assistance centers, no medical evacuation, and no mass notification, and it does not claim them. It covers the awareness layer that duty-of-care programs usually lack.'],
      ['What does travel risk intelligence cost?', 'World Monitor is free without signup, with Pro from $39.99/month. Assistance providers such as International SOS and Crisis24 negotiate enterprise retainers with undisclosed list pricing.'],
    ],
  },
];

function renderMatrix(rows, escapeHtml) {
  for (const row of rows) {
    if (row.length !== COMPARISON_MATRIX_COLUMNS.length) {
      throw new Error(
        'matrix row for "' + row[0] + '" has ' + row.length +
        ' cells, expected ' + COMPARISON_MATRIX_COLUMNS.length
      );
    }
  }
  const header = COMPARISON_MATRIX_COLUMNS
    .map((column) => '<th>' + escapeHtml(column) + '</th>')
    .join('');
  const body = rows
    .map((row) => '<tr>' + row.map((cell) => '<td>' + escapeHtml(cell) + '</td>').join('') + '</tr>')
    .join('\n          ');
  return [
    '      <div class="table-scroll"><table>',
    '        <caption>Universal comparison matrix</caption>',
    '        <thead><tr>' + header + '</tr></thead>',
    '        <tbody>',
    '          ' + body,
    '        </tbody>',
    '      </table></div>',
  ].join('\n');
}

function faqPageLd(faqs) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(([name, text]) => ({
      '@type': 'Question',
      name,
      acceptedAnswer: { '@type': 'Answer', text },
    })),
  };
}

/** WebPage graph for comparison pages; ItemList/FAQPage ride as sibling graphs. */
function comparisonWebPageLd({ name, description, url, lastmod, faqId, baseUrl }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': url + '#webpage',
    name,
    description,
    url,
    inLanguage: 'en-US',
    dateModified: lastmod,
    isPartOf: { '@id': new URL('/#website', baseUrl).href },
    breadcrumb: { '@id': url + '#breadcrumb' },
    mainEntity: { '@id': faqId },
  };
}

function renderComparePage(page, { tpl, baseUrl, lastmod }) {
  const { escapeHtml, breadcrumbLd, pageDocument } = tpl;
  const pageUrl = new URL(page.path, baseUrl).href;
  const description = page.h1
    + ' - ' + page.claim
    + '. Full comparison matrix, honest concessions, and FAQs.';
  assertMetaDescription(description, page.slug);

  const jsonLd = [];
  if (page.itemList) {
    jsonLd.push({
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: page.h1,
      numberOfItems: page.itemList.length,
      itemListOrder: 'https://schema.org/ItemListOrderAscending',
      itemListElement: page.itemList.map((item) => ({
        '@type': 'ListItem',
        position: item.position,
        name: item.name,
      })),
    });
  }
  const faq = faqPageLd(page.faqs);
  faq['@id'] = pageUrl + '#faq';
  jsonLd.push(
    comparisonWebPageLd({
      name: page.h1,
      description,
      url: pageUrl,
      lastmod,
      faqId: pageUrl + '#faq',
      baseUrl,
    }),
    faq,
  );

  const body = [
    '      <p class="eyebrow">Compare</p>',
    '      <h1>' + escapeHtml(page.h1) + '</h1>',
    '      <p class="lede"><strong>Direct answer:</strong> ' + escapeHtml(page.whyWeWin) + '</p>',
    '',
    ...(page.heading
      ? ['      <h2>' + escapeHtml(page.heading) + '</h2>', '']
      : []),
    '      <h2>Comparison matrix</h2>',
    renderMatrix(page.matrixRows, escapeHtml),
    '',
    '      <h2>When to choose them instead</h2>',
    '      <p>' + escapeHtml(page.concessionIntro) + '</p>',
    '      <ul>',
    ...page.concessions.map(([name, cells]) =>
      '        <li><strong>' + escapeHtml(name) + '</strong> wins on ' + escapeHtml(cells) + '.</li>'),
    '      </ul>',
    '',
    '      <h2>Why World Monitor wins on ' + escapeHtml(page.claim) + '</h2>',
    '      <p>' + escapeHtml(page.whyWeWin) + '</p>',
    '',
    '      <h2>Frequently asked questions</h2>',
    ...page.faqs.flatMap(([question, answer]) => [
      '      <h3>' + escapeHtml(question) + '</h3>',
      '      <p>' + escapeHtml(answer) + '</p>',
    ]),
    '      <p class="source">Prices and capabilities were checked at publication time and can change. The <a href="/compare/">comparison hub</a> links every head-to-head page. Prices shown are from each vendor public pages or published reporting; enterprise figures marked undisclosed are negotiated and not published as list prices.</p>',
  ].join('\n');

  return pageDocument({
    baseUrl,
    path: page.path,
    title: page.title,
    description,
    lastmod,
    ogType: 'article',
    jsonLd,
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Compare', path: '/compare/' },
      { name: page.h1, path: page.path },
    ]),
    body,
    footerBody: 'World Monitor comparison corpus. Prices and capabilities are committed content, reviewed at publication time; live dashboard results belong on the product surfaces.',
  });
}

function assertMetaDescription(description, label) {
  const length = [...description].length;
  if (length < 90 || length > 160) {
    throw new Error(label + ' meta description must be 90-160 chars (got ' + length + ')');
  }
}

function renderCompareHub({ tpl, baseUrl, lastmod }) {
  const { escapeHtml, breadcrumbLd, pageDocument } = tpl;
  const path = '/compare/';
  const description =
    'Compare World Monitor with Liveuamap, ACLED, GDELT, Dataminr, Recorded Future, and more: one master matrix, honest concessions, and FAQs.';
  assertMetaDescription(description, 'compare hub');
  const cards = COMPARISON_PAGES
    .map((page) => '        <a class="card" href="' + escapeHtml(page.path) + '"><strong>' + escapeHtml(page.h1) + '</strong><br><span>' + escapeHtml(page.claim) + '</span></a>')
    .join('\n');
  const body = [
    '      <p class="eyebrow">Compare</p>',
    '      <h1>Compare World Monitor</h1>',
    '      <p class="lede">Every comparison page uses the same matrix columns, states what each competitor wins, and answers the questions engines lift verbatim.</p>',
    '',
    '      <h2>Master comparison matrix</h2>',
    renderMatrix(COMPARISON_HUB_MATRIX_ROWS, escapeHtml),
    '',
    '      <div class="grid">',
    cards,
    '      </div>',
    '      <h2>Editorial comparison</h2>',
    '      <p>The blog post <a href="/blog/posts/worldmonitor-vs-traditional-intelligence-tools/">World Monitor vs Bloomberg, Palantir, Dataminr, and Recorded Future</a> compares enterprise platforms with a full price matrix.</p>',
    '      <p class="source">Prices and capabilities were checked at publication time and can change.</p>',
  ].join('\n');
  return pageDocument({
    baseUrl,
    path,
    title: 'Compare World Monitor | World Monitor',
    description,
    lastmod,
    ogType: 'website',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'Compare World Monitor',
      description,
      url: new URL(path, baseUrl).href,
      inLanguage: 'en-US',
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Compare', path },
    ]),
    body,
    footerBody: 'World Monitor comparison corpus. Prices and capabilities are committed content, reviewed at publication time; live dashboard results belong on the product surfaces.',
  });
}

export function writeComparisonPages({ outDir, baseUrl, tpl, lastmod = COMPARISONS_CONTENT_VERSION }) {
  mkdirSync(join(outDir, 'compare'), { recursive: true });
  writeFileSync(
    join(outDir, 'compare', 'index.html'),
    renderCompareHub({ tpl, baseUrl, lastmod }),
  );
  for (const page of COMPARISON_PAGES) {
    mkdirSync(join(outDir, 'compare', page.slug), { recursive: true });
    writeFileSync(
      join(outDir, 'compare', page.slug, 'index.html'),
      renderComparePage(page, { tpl, baseUrl, lastmod }),
    );
  }
}

export const __test = {
  renderCompareHub,
  renderComparePage,
};
