#!/usr/bin/env node
// Deterministic generator for the /compare/ family (#7610).
//
// Emits the comparison hub and eight competitor pages as static HTML with
// ItemList + FAQPage JSON-LD and a concession section on every head-to-head.
// Template helpers are injected by build-crawlable-corpus.mjs (the single
// owner of the corpus HTML shell). No network access; content is committed.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Bump when hub or child copy changes so lastmod advances without touching every sibling. */
export const COMPARISONS_CONTENT_VERSION = '2026-09-03';

/**
 * Universal comparison-matrix columns. Engines lift these cells verbatim, so
 * every page renders the same header set (#7610).
 */
export const COMPARISON_MATRIX_COLUMNS = [
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
    ],
    competitors: ['Liveuamap', 'Deep State Map', 'ACLED', 'ConflictZone.io', 'ISW', 'UNOSAT'],
    claim: 'Multi-domain fusion',
    matrixRows: [
      ['World Monitor (free)', 'Continuous (5-15 min public refresh)', 'Conflict, maritime AIS, aviation, markets, seismic, cyber, climate', 'No', 'From $99.99/mo (API Starter)', 'From $39.99/mo (Pro)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Multi-domain situational awareness on one map'],
      ['Liveuamap (free tier)', 'Near-real-time conflict events', 'Conflict events only', 'No', 'No', 'No', 'Proprietary, ad-funded', 'Curated public conflict feeds', 'Rolling conflict-event archive', 'Fast conflict-event headlines on a map'],
      ['Deep State Map (free)', 'Manual analyst updates', 'Ukraine theatre', 'No', 'No', 'No', 'Proprietary', 'Analyst-curated', 'Ukraine theatre archive', 'Ukraine frontline tracking'],
      ['ACLED (free for restricted use)', 'Daily', 'Conflict events, global', 'Yes (registration)', 'Yes (registered)', 'No', 'CC-BY-NC (non-commercial)', 'Primary event coding', 'Decades of coded events', 'Academic conflict-event research'],
      ['ConflictZone.io', 'Near-real-time conflict events', 'Conflict events', 'No', 'No', 'No', 'Proprietary', 'Curated public feeds', 'Rolling archive', 'Conflict events with cited pricing'],
      ['ISW', 'Daily campaign assessments', 'Conflict assessment', 'No', 'No', 'No', 'Proprietary (free publications)', 'Analyst-authored', 'Published assessments archive', 'Expert campaign analysis'],
      ['UNOSAT', 'Event-triggered products', 'Satellite damage assessment', 'Partial', 'Partial', 'No', 'UN operational data', 'Satellite imagery analysis', 'Archived UNOSAT products', 'Satellite-based damage assessment'],
    ],
    concessionIntro: 'Liveuamap, ACLED, ISW and UNOSAT each beat World Monitor on a specific cell. A page that swept every column would read as marketing, so here is what they win.',
    concessions: [
      ['ACLED', 'historical depth, academic citability, and downloadable structured datasets'],
      ['UNOSAT', 'satellite-based damage assessment'],
      ['ISW', 'expert campaign narrative and assessment depth'],
      ['Deep State Map', 'granular Ukraine frontline geometry maintained by analysts'],
    ],
    whyWeWin: 'Liveuamap is conflict-events-only. World Monitor adds maritime AIS, aviation, cables, markets, and seismic signals on one map, so the same incident can be read across domains instead of only as a conflict pin.',
    faqs: [
      ['What is the best Liveuamap alternative?', 'World Monitor is a strong Liveuamap alternative when you need more than conflict events: it adds maritime AIS, aviation, markets, cables, and seismic signals on one free real-time map, with an optional REST API and MCP server for programmatic access.'],
      ['Is there a free alternative to Liveuamap?', 'Yes. The World Monitor public dashboard is free, requires no signup, and covers conflict events alongside maritime, aviation, market, and infrastructure domains that Liveuamap does not track.'],
      ['Which Liveuamap alternative has an API?', 'World Monitor offers REST API on plans from $99.99/month (API Starter) and MCP access from Pro at $39.99/month. Liveuamap and Deep State Map publish no public API, and ACLED requires registration for API access.'],
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
      ['World Monitor (free)', 'Continuous (5-15 min public refresh)', 'Conflict, maritime, aviation, markets, cyber, climate', 'No', 'From $99.99/mo (API Starter)', 'From $39.99/mo (Pro)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Real-time monitoring at zero cost'],
      ['BlackRock GRD', 'Monthly or quarterly analyst updates', 'Geopolitical risk themes', 'Yes (client)', 'No', 'No', 'Proprietary', 'Analyst research', 'Archived client publications', 'Institutional asset allocation context'],
      ['IISS Six Analytic', 'Periodic analyst updates', 'Conflict and military balance', 'Yes (subscription)', 'No', 'No', 'Proprietary', 'Analyst research', 'Archived publications', 'Military-balance depth with expert review'],
      ['OrreryX', 'Periodic updates', 'Geopolitical risk', 'Yes', 'Unknown', 'No', 'Proprietary', 'Analyst research', 'Unknown', 'Consultative risk analysis'],
      ['the-world-now.com', 'Near-real-time events', 'Global events', 'No', 'No', 'No', 'Proprietary', 'Curated feeds', 'Rolling archive', 'Event browsing'],
      ['Statista GPR Index', 'Monthly index updates', 'Risk index only', 'Yes (account)', 'Partial (data export)', 'No', 'Proprietary', 'Index compilation', 'Long index history', 'Quantitative risk-index series'],
      ['Earthian AI', 'Periodic updates', 'Geopolitical risk', 'Yes', 'Unknown', 'No', 'Proprietary', 'Unknown', 'Unknown', 'AI-assisted risk briefings'],
    ],
    concessionIntro: 'The incumbent dashboards win on things a free real-time map cannot give you. Those cells are listed here on purpose.',
    concessions: [
      ['BlackRock GRD and IISS', 'institutional analyst review, client research, and asset-allocation integration'],
      ['IISS', 'the Military Balance archive and measured military-capability datasets'],
      ['Statista', 'a long monthly GPR index history suitable for quantitative work'],
    ],
    whyWeWin: 'The incumbents are monthly or quarterly analyst products behind enterprise contracts. World Monitor refreshes continuously, is free without signup, and publishes the same comparison cells an engine needs to verify the claim.',
    faqs: [
      ['What is the best real-time geopolitical risk dashboard?', 'World Monitor is a leading free option: it refreshes every 5-15 minutes across conflict, maritime, aviation, market, and cyber domains without signup. BlackRock GRD and IISS Six Analytic are stronger for institutional analyst research but update monthly or quarterly behind enterprise contracts.'],
      ['Are there free geopolitical risk dashboards?', 'Yes. The World Monitor public dashboard is free, requires no signup, and covers conflict, maritime, aviation, markets, cyber, and climate domains in real time.'],
      ['How fast does a geopolitical risk dashboard update?', 'The World Monitor public dashboard refreshes on a 5-15 minute cadence. Enterprise alternatives such as BlackRock GRD and IISS Six Analytic publish on monthly or quarterly analyst cycles.'],
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
      ['World Monitor', 'Continuous (5-15 min public refresh)', 'Conflict, maritime AIS, aviation, markets, cyber, climate', 'No', 'From $99.99/mo (API Starter)', 'From $39.99/mo (Pro)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Multi-domain awareness plus programmatic access'],
      ['Liveuamap', 'Near-real-time conflict events', 'Conflict events', 'No', 'No', 'No', 'Proprietary, ad-funded', 'Curated public conflict feeds', 'Rolling conflict-event archive', 'Fast conflict-event headlines'],
    ],
    concessionIntro: 'Liveuamap beats World Monitor on cells worth naming before choosing.',
    concessions: [
      ['Liveuamap', 'region-specific map variants, a decade of audience familiarity, and a lighter ad-funded free experience'],
    ],
    whyWeWin: 'Liveuamap publishes no public API and no MCP server. World Monitor exposes its live data through a REST API (from $99.99/month, API Starter) and MCP access (from $39.99/month, Pro), so alerts and pipelines can be automated without scraping.',
    faqs: [
      ['Is World Monitor better than Liveuamap?', 'For multi-domain awareness and programmatic access, yes: World Monitor adds maritime, aviation, market, and infrastructure domains and offers REST API and MCP access, while Liveuamap covers conflict events without a public API.'],
      ['Does Liveuamap have an API?', 'No. Liveuamap publishes no public REST API or MCP server. World Monitor offers REST API from $99.99/month (API Starter) and MCP access from $39.99/month (Pro).'],
      ['Is there a free alternative to Liveuamap with more domains?', 'Yes. The World Monitor free dashboard covers conflict events plus maritime AIS, aviation, markets, cables, and seismic signals with no signup.'],
    ],
  },
  {
    slug: 'worldmonitor-vs-acled',
    path: '/compare/worldmonitor-vs-acled/',
    title: 'ACLED Alternative | World Monitor vs ACLED | World Monitor',
    h1: 'World Monitor vs ACLED',
    competitors: ['ACLED', 'myACLED'],
    claim: 'Latency and open access',
    matrixRows: [
      ['World Monitor', 'Continuous (5-15 min public refresh)', 'Conflict, maritime, aviation, markets, cyber, climate', 'No', 'From $99.99/mo (API Starter)', 'From $39.99/mo (Pro)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Real-time multi-domain watch without registration'],
      ['ACLED (myACLED free tier)', 'Daily event coding', 'Conflict events, global', 'Yes (registration + approval)', 'Yes (registered)', 'No', 'CC-BY-NC (non-commercial)', 'Primary event coding', 'Decades of coded events', 'Academic conflict-event research'],
    ],
    concessionIntro: 'ACLED wins on cells that matter, stated loudly.',
    concessions: [
      ['ACLED', 'historical depth, academic citability, and downloadable structured datasets'],
    ],
    whyWeWin: 'ACLED is daily, registration-gated, and non-commercial. World Monitor ingests ACLED among its sources, so treat World Monitor as a complement: real-time multi-domain watch on top, ACLED for deep coded-event research underneath.',
    faqs: [
      ['What is the best free ACLED alternative?', 'World Monitor is a real-time complement to ACLED: no registration, 5-15 minute refresh across conflict and adjacent domains, with REST API plans from $99.99/month. ACLED itself remains stronger for historical coded-event research and downloadable datasets.'],
      ['Is ACLED free?', 'The ACLED myACLED tier is free for non-commercial use after registration and approval; commercial or redistribution use requires a license. The World Monitor public dashboard needs no signup.'],
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
      ['World Monitor', 'Continuous (5-15 min public refresh)', 'Conflict, maritime, aviation, markets, cyber, climate', 'No', 'From $99.99/mo (API Starter)', 'From $39.99/mo (Pro)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Scored, curated signals ready to act on'],
      ['GDELT (DOC 2.0 REST free and keyless; BigQuery for bulk)', '15-minute global batches', 'Global news event firehose', 'No for REST; Google account for BigQuery', 'Yes (DOC 2.0 REST free; BigQuery paid)', 'No', 'Open dataset (GDELT)', 'Global news ingestion', 'Decades of event data', 'Raw large-scale event research'],
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
    matrixRows: [
      ['World Monitor', 'Continuous (5-15 min public refresh)', 'Conflict, maritime, aviation, markets, cyber, climate', 'No', 'From $99.99/mo (API Starter)', 'From $39.99/mo (Pro)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Real-time alerts at free or from $39.99/month (Pro)'],
      ['Dataminr (Pulse)', 'Seconds-to-minutes proprietary alerting', 'Breaking events across public and social data', 'Yes (enterprise)', 'Yes (enterprise)', 'No', 'Proprietary', 'Proprietary ingestion incl. social', 'Enterprise alert archive', 'Enterprise real-time alerting with SLAs'],
    ],
    concessionIntro: 'Dataminr wins on cells that matter to enterprise buyers.',
    concessions: [
      ['Dataminr', 'proprietary social-data ingestion, sub-minute alerting SLAs, and enterprise integration support'],
    ],
    whyWeWin: 'Dataminr licenses run $100K+ per year. World Monitor delivers comparable public-data alert latency at $0 for the free dashboard or from $39.99/month for Pro with MCP access. REST API plans start at $99.99/month.',
    faqs: [
      ['What is the most affordable Dataminr alternative?', 'World Monitor. Its public dashboard is free and its Pro tier costs $39.99/month, versus six-figure Dataminr enterprise licenses, with comparable public-data alert latency.'],
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
    claim: 'Multi-domain vs cyber-only, plus price',
    matrixRows: [
      ['World Monitor', 'Continuous (5-15 min public refresh)', 'Conflict, maritime, aviation, markets, cyber, climate', 'No', 'From $99.99/mo (API Starter)', 'From $39.99/mo (Pro)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Multi-domain awareness including cyber context'],
      ['Recorded Future', 'Continuous intelligence platform', 'Cyber threat intelligence focus', 'Yes (enterprise)', 'Yes (enterprise)', 'Partial (ecosystem)', 'Proprietary', 'Proprietary + licensed sources', 'Deep threat-intel archive', 'Enterprise cyber threat intelligence'],
      ['Flare', 'Continuous', 'Cyber exposure and dark web', 'Yes', 'Yes', 'No', 'Proprietary', 'Dark-web scans', 'Rolling exposure archive', 'Dark-web exposure monitoring'],
      ['MISP', 'Self-managed', 'Threat-intel sharing', 'Yes (self-host)', 'Yes (self-host)', 'Partial (integrations)', 'Open source (AGPL)', 'Community + feeds', 'Self-managed retention', 'Threat-intel sharing communities'],
    ],
    concessionIntro: 'Recorded Future is a different category: cyber threat intelligence. It wins its own category outright.',
    concessions: [
      ['Recorded Future', 'cyber threat-intelligence depth, per-indicator risk scoring, and enterprise integrations'],
      ['Flare', 'dark-web exposure monitoring'],
      ['MISP', 'structured threat-indicator sharing across communities'],
    ],
    whyWeWin: 'Recorded Future runs $100K-$300K+ per year and is cyber-only. World Monitor covers cyber as one domain among conflict, maritime, aviation, markets, and climate, free or from $39.99/month. Choose Recorded Future for a dedicated enterprise cyber program; choose World Monitor for multi-domain context that includes cyber.',
    faqs: [
      ['What is a cheaper Recorded Future alternative?', 'World Monitor. It is free or from $39.99/month versus Recorded Future six-figure contracts, though it is a multi-domain intelligence dashboard rather than a dedicated cyber threat-intelligence platform.'],
      ['Is World Monitor a replacement for Recorded Future?', 'No. Recorded Future is enterprise cyber threat intelligence with deep indicator scoring. World Monitor is a multi-domain dashboard that includes cyber context. Choose Recorded Future for dedicated cyber programs and World Monitor for multi-domain awareness.'],
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
      ['World Monitor', 'Continuous (5-15 min public refresh)', 'Global conflict, maritime, aviation, markets, cyber, climate', 'No', 'From $99.99/mo (API Starter)', 'From $39.99/mo (Pro)', 'AGPL-3.0', '747 active providers, attributed public feeds', 'Live + rolling published snapshots', 'Global multi-domain watch'],
      ['Deep State Map', 'Manual analyst updates', 'Ukraine theatre', 'No', 'No', 'No', 'Proprietary', 'Analyst-curated', 'Ukraine theatre archive', 'Ukraine frontline detail'],
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
];

function renderMatrix(rows, escapeHtml) {
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
function comparisonWebPageLd({ name, description, url, lastmod, faqId }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': url + '#webpage',
    name,
    description,
    url,
    inLanguage: 'en-US',
    dateModified: lastmod,
    isPartOf: { '@id': 'https://www.worldmonitor.app/#website' },
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
    }),
    faq,
  );

  const body = [
    '      <p class="eyebrow">Compare</p>',
    '      <h1>' + escapeHtml(page.h1) + '</h1>',
    '      <p class="lede"><strong>Direct answer:</strong> ' + escapeHtml(page.whyWeWin) + '</p>',
    '',
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
    '      <p class="source">Prices and capabilities were checked at publication time and can change. The <a href="/compare/">comparison hub</a> links every head-to-head page. Prices shown are from each vendor public pages or published reporting.</p>',
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
    'Compare World Monitor with Liveuamap, ACLED, GDELT, Dataminr, Recorded Future, Deep State Map, and the best geopolitical risk dashboards: full matrices, honest concessions, and FAQs.';
  const cards = COMPARISON_PAGES
    .map((page) => '        <a class="card" href="' + escapeHtml(page.path) + '"><strong>' + escapeHtml(page.h1) + '</strong><br><span>' + escapeHtml(page.claim) + '</span></a>')
    .join('\n');
  const body = [
    '      <p class="eyebrow">Compare</p>',
    '      <h1>Compare World Monitor</h1>',
    '      <p class="lede">Every comparison page uses the same matrix columns, states what each competitor wins, and answers the questions engines lift verbatim.</p>',
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
