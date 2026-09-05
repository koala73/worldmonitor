// Narrative copy for the /compare/ family (#7743).
//
// Matrix rows, concessions, and the Direct-answer lede stay in
// build-comparison-pages.mjs. This module supplies the missing body:
// per-competitor prose, evaluation frameworks, switch triggers,
// methodology, unique Why-we-win copy, and extra FAQs.

import { CHOKEPOINT_REGISTRY } from '../src/config/chokepoint-registry.ts';

const CHECKED_ON = '5 September 2026';
const CHOKEPOINT_COUNT = CHOKEPOINT_REGISTRY.length;

function methodology(focus) {
  return [
    `Prices and capability cells on this page were checked on ${CHECKED_ON} from each named vendor's public pricing, product, or API documentation and from World Monitor's published catalog at /pricing, /mcp, and /compare/. ${focus} Where a vendor publishes a list price or quota, the matrix uses that figure. Where a vendor does not publish list pricing, the cell is "Undisclosed (enterprise-negotiated)". This family never substitutes a third-party estimate for a missing list price.`,
    'World Monitor prices on every row are the public catalog: $0 for the dashboard with no signup, Pro from $39.99/month including MCP access, and API Starter from $99.99/month for 1,000 requests/day. Third-party MCP status is Yes only when a public server or community implementation is documented; otherwise it is Unverified. Signup walls, archive depth, and domain coverage were read from product or docs pages. This page is committed copy with a dated lastmod. Vendors change SKUs, so re-check the linked vendor page before you buy.',
  ];
}

export const COMPARE_HUB_NARRATIVE = {
  lede: 'This hub is the index for World Monitor comparison pages: one shared matrix, named concessions, and the questions engines lift verbatim. Use it to pick a head-to-head, not as a substitute for the child pages.',
  howToRead: {
    heading: 'How to read this comparison family',
    paragraphs: [
      'Every child page uses the same columns: Price, Update latency, Domains covered, Signup required, REST API, MCP server, Open source, Source count and licensing, Historical archive, and Best for. That is deliberate. A comparison that changes axes per vendor is a brochure. A comparison that keeps the axes fixed lets you see who actually publishes a number, who hides behind an enterprise desk, and who wins a cell we would rather not concede.',
      'Read the Direct answer first. It is the extractable one-sentence claim for the page. Then read the competitor prose — what the named product is, who runs it, what it genuinely does better, and who should still buy it. The matrix is evidence, not the argument. The concession list is the argument we are willing to lose in public. If a page cannot name what the other product wins, it is not a comparison.',
      'Head-to-head pages (the vs-* URLs) are for a single named incumbent. Multi-product pages are for category queries: Liveuamap alternatives, best dashboards, MCP servers, chokepoint tools, free dashboards, and travel-risk intelligence versus assistance. The hub matrix is the union of the major platforms that appear anywhere in the family, so a row here may be thicker than the row on a child page that only needs two products.',
      'Do not treat this hub as a price list for enterprise vendors. Palantir, Dataminr, Recorded Future, Crisis24, International SOS, and Everbridge do not publish list pricing on the pages we can cite. Their cells stay undisclosed. World Monitor, Liveuamap, OrreryX, IMF PortWatch, GDELT Cloud, and ACLED are the vendors that give the public something to quote, and those are the numbers we quote.',
    ],
  },
  concessions: {
    heading: 'What we concede on purpose',
    paragraphs: [
      'ACLED wins historical coded-event depth, academic citability, and downloadable structured datasets. GDELT wins raw archive volume back to 1979. Deep State Map wins Ukraine frontline granularity maintained by analysts. Dataminr wins proprietary social ingestion and sub-minute alerting SLAs. Recorded Future wins enterprise threat-intelligence depth across cyber, physical, and geopolitical risk. IMF PortWatch wins chokepoint coverage (28 to our ' + CHOKEPOINT_COUNT + '), bulk download, and IMF plus Oxford authority at zero cost. International SOS wins assistance delivery: 27 centers, medical evacuation, and case response. World Monitor has no assistance centers, no medical evacuation, and no case response, and the travel page says so.',
      'Those concessions are the credibility argument. A page that swept every column would read as marketing, and marketing is the thing this family is built not to be. If you need the cell they win, buy them. If you need a no-signup multi-domain watch with published prices, REST from $99.99/month, and MCP from Pro at $39.99/month, stay on the child page and read the rest of the matrix.',
    ],
  },
  methodology: {
    heading: 'How these figures were checked',
    paragraphs: methodology(
      'The hub row-set is the union of platforms compared on the child pages, checked on the same date against the same public sources.',
    ),
  },
  editorial: [
    'That editorial post is a narrative companion, not a second matrix. Pricing claims on the blog are required to use the same undisclosed language this family uses for vendors without list prices. If a sentence on either surface invents a competitor number, treat the published catalog here as the correction.',
  ],
};

export const COMPARISON_NARRATIVES = {
  'liveuamap-alternatives': {
    heading: 'Who these Liveuamap alternatives actually are',
    headingProse: [
      'A Liveuamap alternative is not automatically a Liveuamap replacement. Some of these products are conflict maps. Some are coded-event datasets. Some are campaign assessments. One is a satellite damage shop. Ranking them on a single "best map" axis hides the actual job each one does. The blocks below say what each product is, who it is for, and when it should beat World Monitor.',
    ],
    competitorProfiles: [
      {
        name: 'Liveuamap',
        paragraphs: [
          'Liveuamap is a conflict-event map with a long public audience and region-specific variants. The free, ad-funded map is the product most people mean by the name. The paid API is a separate SKU: Pro at $150/month for 200 requests/day and Enterprise from $1,000/month for 1,500 requests/day, published at liveuamap.com/promo/api. It is fast at headlines. It is not a multi-domain watch.',
          'Pick Liveuamap when you want a familiar conflict map and you do not need maritime AIS, aviation, markets, cables, or seismic context on the same canvas. Pick something else when the API quota or the missing domains are the reason you searched for alternatives.',
        ],
      },
      {
        name: 'Deep State Map',
        paragraphs: [
          'Deep State Map is an analyst-maintained Ukraine frontline product. It is free and ad-supported. Updates are manual. The geometry is the point: unit-level lines that a global dashboard will not match. It is not a worldwide conflict map and it does not pretend to be.',
          'Pick it for Ukraine theatre detail. Do not pick it as a Liveuamap alternative for global coverage; that is a category error this page refuses to make.',
        ],
      },
      {
        name: 'ACLED',
        paragraphs: [
          'ACLED is a coded conflict-event dataset with a public research franchise and a commercial license wall. Open access covers real-time aggregated data without API access. Research, Partner, and Enterprise tiers add API access and more detailed event data. Event coverage runs from 1997. Commercial use requires a license under the ACLED EULA.',
          'Pick ACLED when you need citable, downloadable structured events for research or a model. It is a complement to a live map, not a map alternative, and World Monitor ingests ACLED among its sources rather than trying to replace the archive.',
        ],
      },
      {
        name: 'ConflictZone.io',
        paragraphs: [
          'ConflictZone.io is a free conflict-event browser. It publishes enough of a product to put on a matrix: no signup, near-real-time conflict events, no public API we can verify. It is a lightweight watch, not a dataset and not a multi-domain fusion layer.',
          'Pick it when you want a simple conflict feed with no account. It will not give you AIS, aviation, or a documented API quota.',
        ],
      },
      {
        name: 'ISW',
        paragraphs: [
          'The Institute for the Study of War publishes daily campaign assessments, not a live event firehose. The product is expert narrative: what happened, why it matters, what to watch. It is free as publications. There is no API cell we can honestly fill with a yes.',
          'Pick ISW when you need campaign analysis written by people who own a theatre. Do not pick it when you need a streaming map or programmatic access.',
        ],
      },
      {
        name: 'UNOSAT',
        paragraphs: [
          'UNOSAT is the UN satellite damage-assessment shop. Products are event-triggered, not a continuous map. Access is partial. The output is imagery analysis for humanitarian and disaster operations, which no conflict-headline map on this page reproduces.',
          'Pick UNOSAT for satellite-based damage evidence. It is not a Liveuamap alternative in the map sense; it wins a different job, which is why it is on the list instead of being ignored.',
        ],
      },
      {
        name: 'ICG CrisisWatch',
        paragraphs: [
          'International Crisis Group CrisisWatch is a monthly early-warning brief covering 70+ conflicts, with an archive to 2003. It is free, analyst-authored, and slow on purpose. The cadence is the method: a human writes the status, not a scraper.',
          'Pick CrisisWatch when you want two decades of hand-written entries and can wait for the monthly cycle. It will not replace a live map, and it should not be scored as if it were one.',
        ],
      },
      {
        name: 'ConflictRadar',
        paragraphs: [
          'ConflictRadar appears in this category in public search, but the features we would need to score — price, API, cadence, archive — are unverified from public pages. The matrix marks those cells Undisclosed or Unverified rather than inventing a product.',
          'Do not pick it from this page. If you already use it, verify the cells yourself. A comparison that fabricates a competitor is worse than a comparison that admits it could not check.',
        ],
      },
    ],
    evaluationHeading: 'What to look for in a Liveuamap alternative',
    evaluationProse: [
      'Start with the job, not the logo. If the job is "see conflict headlines on a map," Liveuamap and ConflictZone.io are in-category. If the job is "cite structured events in a paper," ACLED is the category and the maps are a distraction. If the job is "know when a strait, a cable, and an airspace closure moved together," you are no longer shopping for a Liveuamap alternative; you are shopping for fusion.',
      'Score five axes that survive a sales call. Latency: live and minute-level feeds versus daily, weekly, or monthly publications. Domain coverage: conflict only versus conflict plus maritime, aviation, markets, and infrastructure. Access: signup wall, license, or none. Programmatic surface: a published REST quota, a hosted MCP server, or neither. Archive: a rolling headline window versus a citable dataset with a start year.',
      'Then score honesty. A vendor that publishes API prices can be compared on price. A vendor that does not must be marked undisclosed. A vendor whose MCP status is a community wrapper must be labelled as such. The matrix on this page is the checklist. If a candidate cannot fill a cell from a public page, the cell stays empty of invention.',
    ],
    switchHeading: 'Why teams look for Liveuamap alternatives',
    switchProse: [
      'The search is usually a quota problem, a domain problem, or a procurement problem. Liveuamap Pro is $150/month for 200 requests/day. Teams that need more calls, or that need those calls to include AIS and aviation rather than conflict pins only, hit the ceiling and start typing "alternatives." Free-map users hit a different ceiling: ads, missing domains, and no programmatic path without paying.',
      'A second trigger is workflow. Analysts who outgrew headlines want coded events (ACLED), campaign narrative (ISW), or a fused watch they can put next to markets. Developers who outgrew the browser want an API with a published quota or a hosted MCP server with entitlements. None of those jobs is "a nicer Liveuamap." Naming the trigger keeps the rest of the page from pretending they are.',
    ],
    methodologyProse: methodology(
      'Liveuamap API prices were read from liveuamap.com/promo/api. ACLED access rules were read from the public myACLED and EULA pages. CrisisWatch, ISW, and UNOSAT cells were read from their public product and publication pages.',
    ),
    usageHeading: 'How to use this Liveuamap alternatives list',
    usageProse: [
      'Print the job on a sticky note before you rank logos. If the note says "conflict headlines on a familiar map," Liveuamap is still the default and the rest of this list is optional. If it says "citable events from 1997," stop scrolling at ACLED. If it says "Ukraine lines," stop at Deep State Map. If it says "satellite damage," stop at UNOSAT. If it says "monthly analyst status on 70 conflicts," stop at CrisisWatch. Only if the note says "conflict plus shipping, aviation, and markets, with a published API" should World Monitor be the first row you argue for.',
      'Keep two tabs open when the job is mixed. A fusion dashboard does not make ACLED\'s EULA go away. A coded dataset does not draw AIS. The failure mode for this query is buying one product to do four jobs. Use the concession list as the shopping list for the jobs you are not buying from us.',
    ],
    whyWeWinBody: [
      'The fusion claim is the one Liveuamap cannot match by adding a SKU. World Monitor puts conflict next to maritime AIS, aviation, markets, cables, and seismic signals on one free map, then sells the same picture programmatically: API Starter at $99.99/month for 1,000 requests/day, MCP from Pro at $39.99/month. That is five times Liveuamap Pro\'s daily quota at a lower list price, with domains Liveuamap does not track.',
      'We still lose cells on purpose. ACLED remains the citable archive. ISW remains the campaign narrator. UNOSAT remains the satellite damage shop. Deep State Map remains the Ukraine geometry. The win is the no-signup multi-domain watch plus a published programmatic path, not a sweep of every column.',
    ],
    extraFaqs: [
      ['Is Liveuamap still worth using?', 'Yes, when you want a familiar conflict-headline map and region-specific variants. Use World Monitor when you also need maritime, aviation, market, or infrastructure context, or when you need a cheaper published API quota.'],
      ['Does World Monitor show the same conflict events as Liveuamap?', 'Not as a mirror. World Monitor fuses attributed public feeds, including conflict sources, with other domains. Treat it as a multi-domain watch, not as a pixel-for-pixel Liveuamap clone.'],
      ['Which alternative is best for academic citation?', 'ACLED, for coded events with a documented archive from 1997 and a license path. World Monitor is a live watch, not a citable event dataset in the ACLED sense.'],
      ['Which alternative is best for Ukraine frontline detail?', 'Deep State Map. Its analyst-maintained geometry is more granular than a global dashboard. World Monitor covers Ukraine as one theatre among many.'],
      ['Do any of these alternatives include maritime and aviation data?', 'World Monitor does, on the free dashboard. Liveuamap, ConflictZone.io, ISW, CrisisWatch, and UNOSAT do not fuse those domains into the same product.'],
      ['Is there an open-source Liveuamap alternative?', 'World Monitor is AGPL-3.0. ACLED is a licensed dataset, not open source. Liveuamap is proprietary. Open source is the wrong axis if what you need is Liveuamap\'s headline map specifically.'],
      ['How often should I re-check these prices?', 'Whenever you buy. This page was checked on 5 September 2026. Liveuamap and World Monitor publish list prices; those can move. Enterprise rows stay undisclosed until the vendor publishes a number.'],
    ],
  },

  'best-geopolitical-risk-dashboards': {
    heading: 'Who these geopolitical risk dashboards are for',
    headingProse: [
      'Best-of lists fail when they score an asset-allocation memo and a live map as if they were the same product. BlackRock GRD and IISS are analyst publications. World Monitor is a real-time dashboard. OrreryX is a priced consultative ladder. Statista is an index series. The blocks below keep those jobs separate so the ranking is a ranking of fit, not of brand weight.',
      'A useful ranking also says who should not be on it. Bloomberg Terminal is a market professional product, not a geopolitical-risk dashboard in this sense, so it is not a row here. Palantir is an enterprise platform without list pricing, so it is not a row here either. This page is the public, checkable set: live maps, analyst publications with a public description, a priced consultative ladder, an index series, and an AI briefing vendor that still has not filled its public cells. If a vendor cannot fill Price, latency, and access from a public page, it does not get a trophy on this list; it gets a missing cell.',
    ],
    competitorProfiles: [
      {
        name: 'BlackRock Geopolitical Risk Dashboard',
        paragraphs: [
          'BlackRock GRD is a client research product. Updates are monthly or quarterly analyst cycles. Access is client-only. There is no public REST or MCP cell. The output is thematic risk for asset allocation, written for people who already have a BlackRock relationship.',
          'Pick it if you are that client and you need the memo in the allocation process. Do not pick it if you need a no-signup live map; it is not built to be one, and treating it as a dashboard alternative is how these lists go wrong.',
        ],
      },
      {
        name: 'IISS Six Analytic',
        paragraphs: [
          'IISS Six Analytic sits on top of the Military Balance franchise: measured military-capability datasets and expert review. Cadence is periodic analyst updates. Pricing is an undisclosed subscription. There is no public API we can quote.',
          'Pick IISS when the question is force structure, inventory, and military balance. Pick a live dashboard when the question is what moved in the last hour across conflict, maritime, and aviation feeds.',
        ],
      },
      {
        name: 'OrreryX',
        paragraphs: [
          'OrreryX is the rare competitor that publishes a price ladder: from $1.99/month to $34.99/month. That undercuts World Monitor Pro on list price. The product is consultative geopolitical risk analysis with periodic updates, not a multi-domain live map, and MCP status is unverified.',
          'Pick OrreryX when you want a cheap, published-price analyst product and you do not need live AIS or aviation. The published ladder is a genuine win and this page says so in the concession list.',
        ],
      },
      {
        name: 'the-world-now.com',
        paragraphs: [
          'the-world-now.com is a free global event browser with no signup. It is near-real-time for events, not a scored index and not a programmatic platform. No API cell is verified.',
          'Pick it for casual event browsing. It is in the free-without-signup set with World Monitor; it is not in the fusion or API set.',
        ],
      },
      {
        name: 'Statista GPR Index',
        paragraphs: [
          'Statista\'s geopolitical risk index is a quantitative series with monthly updates and a long history. Access is a Statista account. Export exists; a live dashboard and MCP server do not. The job is time-series work in a spreadsheet or a model, not situational awareness.',
          'Pick Statista when you need a GPR index history. Do not pick it as a real-time dashboard; the cadence and the output format are the tell.',
        ],
      },
      {
        name: 'Earthian AI',
        paragraphs: [
          'Earthian AI markets AI-assisted geopolitical risk briefings. Pricing is undisclosed. Cadence is periodic. Source inventory and MCP status are unverified from public pages, so those cells stay unknown rather than guessed.',
          'If you already evaluate it, demand the same cells this matrix requires. Until those pages exist, it cannot win a comparison that is built on public evidence.',
        ],
      },
    ],
    evaluationHeading: 'What to look for in a geopolitical risk dashboard',
    evaluationProse: [
      'Separate publications from dashboards before you rank anything. A monthly analyst note can be excellent and still lose a real-time query. A live map can be excellent and still lose an asset-allocation query. The "best" dashboard is the one whose update latency, access model, and output format match the decision you have to make this week.',
      'Weight five criteria. Latency: live and minute-level versus monthly or quarterly. Price transparency: a public catalog versus client-only or undisclosed. Access friction: signup, contract, or none. Coverage: a single index or theme versus multiple live domains. Programmatic path: REST, MCP, export, or a PDF.',
      'Then require evidence. If a vendor will not publish a price, do not invent one. If a vendor will not show a live canvas, do not score it as a dashboard. If a vendor\'s advantage is expert review, concede that cell and stop trying to beat it with a map. The matrix is the rubric; the concession list is the sanity check.',
    ],
    switchHeading: 'Why teams shop for a new geopolitical risk dashboard',
    switchProse: [
      'The trigger is usually latency or access. Institutional products update on analyst cycles and sit behind client contracts. Teams that need to see a strait, an airspace, and a market move in the same hour cannot wait for the next memo. Teams that do not have a BlackRock or IISS seat cannot log in at all.',
      'A second trigger is price opacity. When the incumbent will not publish a number, procurement stalls or a cheaper published ladder (OrreryX) or a free live map (World Monitor, the-world-now.com) enters the bake-off. The search query is "best dashboards" because the current tool failed a cycle-time or access test, not because a logo went stale.',
    ],
    methodologyProse: methodology(
      'BlackRock GRD and IISS cells were taken from public product descriptions, not from client portals we cannot cite. OrreryX prices were read from its published tier list. Statista was scored as an index product, not as a live map.',
    ),
    usageHeading: 'How to use this best-dashboards ranking',
    usageProse: [
      'Treat "best" as best for a named output. If the output is an asset-allocation memo, BlackRock GRD is the product and a live map is a side feed. If the output is military-balance context, IISS is the product. If the output is a GPR time series, Statista is the product. If the output is a cheap analyst subscription with a public price ladder, OrreryX is the product. If the output is a canvas a stranger can open during an incident, World Monitor is the product and the-world-now.com is the lightweight cousin.',
      'Do not average those jobs into a single score. Averaging is how a monthly memo "loses" to a live map on latency and a live map "loses" to IISS on the Military Balance, and everyone walks away thinking the comparison was biased. Use the concession list as the jobs we are not ranking first. Use the matrix to verify access and price. Use this section to pick the job before you pick the row.',
      'If you are in procurement, write two requirements: one for analyst publications, one for real-time monitoring. Vendors that blur them should be asked which module they are bidding. Earthian AI, in particular, should be asked to fill the same public cells as everyone else before it gets a score. Unknown source mix and undisclosed price are not a mysterious advantage; they are missing evidence.',
      'Latency numbers on this page are not a single SLA. World Monitor is source-dependent: live and minute-level feeds sit next to daily, weekly, and monthly datasets. BlackRock GRD and IISS publish on analyst cycles. Statista is monthly by design. Ranking them on one "speed" trophy is a category error. Rank them on whether their cycle matches the decision you have to make this afternoon versus this quarter.',
    ],
    whyWeWinBody: [
      'World Monitor is the live, no-signup end of this list. It is not the analyst-review end. The dashboard is free, the cadence is source-dependent from live feeds to monthly datasets, and the programmatic path is published: Pro from $39.99/month with MCP, API Starter from $99.99/month. That is the product you can actually open without a relationship manager.',
      'BlackRock and IISS still win institutional review. Statista still wins index history. OrreryX still wins a cheaper published analyst ladder. The ranking puts World Monitor first for real-time monitoring at zero cost because that is the axis the page is about, not because those other products are worse at their own jobs.',
    ],
    extraFaqs: [
      ['Is BlackRock GRD free?', 'No. It is a client-only research product. World Monitor\'s public dashboard is free without signup.'],
      ['Does IISS replace a live dashboard?', 'No. IISS wins military-balance depth. It does not replace live conflict, maritime, or aviation monitoring.'],
      ['Why is OrreryX cheaper than World Monitor Pro?', 'OrreryX publishes tiers from $1.99/month. That is a real concession. World Monitor Pro is $39.99/month because it includes hosted MCP access and the live multi-domain dashboard, not because the list price is the lowest on the page.'],
      ['Which dashboard is best for quantitative backtests?', 'Statista\'s GPR index, for a long monthly series. World Monitor is a live watch with rolling snapshots, not a decades-long single index.'],
      ['Can I use these dashboards without a credit card?', 'World Monitor and the-world-now.com yes. BlackRock GRD, IISS, Statista, and Earthian AI no, on the public evidence we have.'],
      ['Do any of these publish an MCP server?', 'World Monitor does, from Pro. The others are unverified or not applicable. Do not assume an "AI briefing" product speaks MCP.'],
      ['How is "best" decided on this page?', 'Fit to a real-time, no-signup, multi-domain watch with published prices. Analyst publications can outrank us on review depth and still lose this query.'],
    ],
  },

  'worldmonitor-vs-liveuamap': {
    heading: 'Liveuamap alternatives',
    headingProse: [
      'This head-to-head is the programmatic one. Both products publish API prices, which is rare in this category and is why the page can table real numbers on both sides instead of hiding behind "enterprise." Liveuamap remains a strong conflict-headline map. World Monitor is the alternative when the job is quota, price, or domains beyond conflict.',
    ],
    competitorProfiles: [
      {
        name: 'Liveuamap',
        paragraphs: [
          'Liveuamap runs a public conflict-event map and sells API access as Pro at $150/month for 200 requests/day and Enterprise from $1,000/month for 1,500 requests/day. The free map is ad-funded. Coverage is conflict events. MCP status is unverified. The company has a decade of audience familiarity and region-specific map variants that a newer multi-domain dashboard will not copy.',
          'It wins on familiarity and on being the default conflict-headline canvas. It loses on API quota-per-dollar and on every domain it does not track. Teams that only need conflict pins should stay. Teams that need AIS, aviation, markets, or five times the daily API quota should not.',
        ],
      },
    ],
    evaluationHeading: 'What to look for in a Liveuamap alternative',
    evaluationProse: [
      'Demand published numbers. A Liveuamap alternative that will not quote an API price is not competing on the axis that makes this page possible. Compare list price, daily quota, and whether the free canvas requires signup. Then compare domain coverage: conflict only, or conflict plus the infrastructure and market layers that turn a headline into a decision.',
      'Score latency honestly. Liveuamap is near-real-time for conflict events. World Monitor is source-dependent: live and minute-level feeds plus slower datasets. If your only feed is conflict pins, Liveuamap\'s cadence is enough. If you also watch transits and airspace, a single conflict timer is the wrong SLA.',
      'Keep the concession in view. Region-specific variants and a lighter ad-funded free experience are real Liveuamap wins. An alternative that cannot name them is selling, not comparing. The right alternative is the one that beats Liveuamap on the cell you actually failed — quota, price, or domains — without pretending to beat it on nostalgia.',
    ],
    switchHeading: 'Why teams switch from Liveuamap',
    switchProse: [
      'The API math is the clean trigger. $150/month for 200 requests/day is a hard ceiling for anyone polling a watch. World Monitor API Starter is $99.99/month for 1,000 requests/day. That comparison only exists because both vendors publish. Teams that hit 200 calls stop arguing about the map and start arguing about the invoice.',
      'The other trigger is a missing layer. A conflict pin without the strait, the airspace, or the market move is an incomplete desk. Liveuamap does not fuse those domains. When a desk is asked "what else moved," the map that only does conflict becomes the thing they search to replace, even if they keep it open in another tab.',
    ],
    methodologyProse: methodology(
      'Liveuamap API Pro and Enterprise figures were read from liveuamap.com/promo/api on the check date. World Monitor API Starter figures were read from the public catalog.',
    ),
    usageHeading: 'How to use this Liveuamap head-to-head',
    usageProse: [
      'If you only need conflict headlines and you already know the Liveuamap UI, this page is not a reason to churn. Bookmark the API numbers, keep the map, and come back when quota or missing domains actually hurt. If you are choosing an API this quarter, ignore brand familiarity and compare $99.99 for 1,000 requests/day against $150 for 200. That arithmetic is the whole head-to-head.',
    ],
    whyWeWinBody: [
      'The programmatic cell is the one this page is willing to argue. World Monitor API Starter undercuts Liveuamap Pro on price and multiplies the daily quota by five, and the free dashboard adds maritime AIS, aviation, markets, and cyber that Liveuamap does not track. That is a comparison with numbers on both sides, not a slogan.',
      'Liveuamap still wins familiarity, region-specific variants, and a lighter ad-funded free map. Keep it if those cells are the job. Switch when the job is quota, price, or multi-domain context, which is the only win this page claims.',
    ],
    extraFaqs: [
      ['Can I keep Liveuamap and add World Monitor?', 'Yes. Many desks keep Liveuamap for conflict headlines and add World Monitor for fusion and API quota. This page is a comparison, not an ultimatum.'],
      ['Does World Monitor have region-specific map variants like Liveuamap?', 'No. That is a Liveuamap win, listed in the concession. World Monitor is a global multi-domain canvas.'],
      ['Is the World Monitor dashboard really free?', 'Yes. No signup and no card for the public dashboard. Paid tiers are Pro (MCP from $39.99/month) and API Starter ($99.99/month for 1,000 requests/day).'],
      ['Does Liveuamap offer MCP access?', 'Not that we can verify from public pages. The cell is Unverified. World Monitor MCP access starts at Pro.'],
      ['Which product is better for a public website embed?', 'Depends on the story. Liveuamap is the familiar conflict embed. World Monitor is the embed when the story includes shipping, aviation, or markets next to the conflict pin.'],
      ['Are these prices monthly or annual?', 'The figures quoted here are the published monthly list prices as of 5 September 2026. Confirm the vendor page for annual discounts before you buy.'],
    ],
  },

  'worldmonitor-vs-acled': {
    headingProse: [
      'ACLED is the named company on this URL, and it is not a mapping startup. It is a coded conflict-event dataset with academic citability, a license wall for commercial use, and an archive from 1997. World Monitor is a live multi-domain watch that ingests ACLED among its sources. The honest product relationship is complement, not replacement, and the rest of the page is written to that fact.',
    ],
    competitorProfiles: [
      {
        name: 'ACLED',
        paragraphs: [
          'The Armed Conflict Location & Event Data Project codes political violence and protest events for researchers, international organizations, and commercial subscribers. Open access provides real-time aggregated data without API access. Research, Partner, and Enterprise tiers add API access and more detailed event data. myACLED is the account wall. Commercial use requires a license under the ACLED EULA. Latency is tier-dependent: real-time aggregated down to weekly disaggregated data.',
          'ACLED wins on three cells World Monitor will not pretend to own: historical depth from 1997, academic citability, and downloadable structured datasets. If your output is a paper, a model, or a licensed commercial product that needs ACLED\'s event ontology, you should buy ACLED. If your output is a no-signup watch across conflict plus maritime, aviation, and markets, you should not uninstall ACLED to get that — you should put World Monitor on top.',
          'Who should pick ACLED: researchers, NGOs, and firms that need citable coded events and can satisfy the EULA. Who should not: teams that only needed a live map and got sent to a dataset. The failure mode is treating ACLED as a dashboard alternative. It is a dataset. This page keeps it in that job.',
        ],
      },
    ],
    evaluationHeading: 'What to look for in an ACLED alternative',
    evaluationProse: [
      'First decide whether you need an alternative at all. ACLED alternatives in search results are often live maps that cannot produce a citable event table. If the job is citation and download, there is no alternative on this page — there is a complement. If the job is live monitoring without a myACLED account, then you are shopping for a different product category that happens to share some upstream events.',
      'Score licensing before features. Open access, research, partner, and enterprise are different products. Commercial use is a license question, not a pricing-page question. An "alternative" that ignores the EULA is not ready for procurement. Then score API access by tier, event ontology, archive start year, and whether you are allowed to redistribute.',
      'Only after that, score the live layer: signup friction, domain coverage beyond conflict, and whether the product ingests ACLED or tries to re-code the world. Ingesting ACLED and adding context is a complement. Re-coding ACLED\'s events without the archive or the license is a downgrade dressed up as a substitute.',
    ],
    switchHeading: 'Why teams look for an ACLED alternative',
    switchProse: [
      'The search is often access, not quality. myACLED requires an account. API access sits on paid tiers. Commercial use needs a license. Teams that wanted a live map hit a dataset wall and typed "ACLED alternative" when what they needed was a no-signup watch. That query is real. Answering it with "just pirate the CSV" is not.',
      'The other trigger is latency and domain. Disaggregated ACLED data can be weekly depending on tier. Desks watching a strait or an airspace in the same hour need a live layer ACLED is not trying to be. They keep ACLED for the archive and add a watch for the next hour. The switch, when it is a switch at all, is adding a complement, not cancelling a dataset.',
    ],
    methodologyProse: methodology(
      'ACLED access, API availability, and commercial-use rules were read from public myACLED and EULA pages. This page does not invent a complimentary access SKU or a Creative Commons non-commercial license; those are not the current public terms we can cite.',
    ),
    whyWeWinBody: [
      'World Monitor\'s job on this page is the live layer ACLED is not selling: no signup, conflict plus adjacent domains, REST from $99.99/month, MCP from Pro. It ingests ACLED rather than asking you to delete ACLED. That is the only win that does not insult the archive.',
      'If you need 1997–present coded events, a downloadable dataset, and a citation that survives peer review, ACLED still wins and should. The complement framing is the product. A replacement framing would be a lie, and it would not survive the concession list.',
    ],
    extraFaqs: [
      ['Does World Monitor include ACLED data?', 'Yes. ACLED is among the attributed sources World Monitor ingests. That is why this page calls World Monitor a complement, not a replacement.'],
      ['Can I download ACLED-style event tables from World Monitor?', 'No. Downloadable structured ACLED datasets are an ACLED product, behind ACLED terms. World Monitor is a live watch and API, not an ACLED redistribution.'],
      ['Does ACLED require an account?', 'myACLED does. Open access and the paid tiers have different rules. The World Monitor public dashboard does not require an account.'],
      ['Is ACLED open source?', 'No. ACLED data is under the ACLED EULA. World Monitor the software is AGPL-3.0; that license does not make ACLED data open.'],
      ['Who should not switch away from ACLED?', 'Anyone whose output is a citable event dataset or a commercial product that depends on ACLED\'s ontology. Keep the license. Add a live watch if you need one.'],
      ['What does "tier-dependent latency" mean?', 'ACLED\'s real-time aggregated versus weekly disaggregated access depends on the tier you are on. Read the current myACLED terms; this page will not flatten them into one SLA.'],
    ],
  },

  'worldmonitor-vs-gdelt': {
    heading: 'GDELT alternatives',
    headingProse: [
      'GDELT Cloud is a firehose. It gives you global news event data in 15-minute batches, a keyless DOC 2.0 REST path, and BigQuery for bulk, with an archive to 1979. World Monitor is a curation layer: scored indices, hotspots, and convergence cues across conflict, maritime, aviation, and markets. The comparison is raw volume versus ready-to-act context, not two dashboards with different skins.',
    ],
    competitorProfiles: [
      {
        name: 'GDELT Cloud',
        paragraphs: [
          'The GDELT Project ingests global news and emits event data. DOC 2.0 REST is free and keyless. BigQuery is the bulk path and needs a Google account. Community MCP implementations exist and are labelled as such. The archive is the headline win: decades of event data, conventionally cited to 1979.',
          'Pick GDELT when you have the engineering time to turn a firehose into meaning — models, counts, your own ontology. Do not pick it when you needed a scored dashboard this morning. The product is the stream. Meaning is your job.',
        ],
      },
      {
        name: 'war-dashboard-data and world-intel-mcp',
        paragraphs: [
          'These are GDELT-based dashboard and MCP projects. They wrap the firehose in a UI or a tool surface you host. They inherit GDELT\'s cadence (15-minute batches) and GDELT\'s volume. They are not a second event ontology; they are packaging.',
          'Pick them when you want to self-host a GDELT surface. Pick World Monitor when you want 747 attributed providers curated into scored indices, including GDELT-derived signals, without running the wrapper yourself.',
        ],
      },
    ],
    evaluationHeading: 'What to look for in a GDELT alternative',
    evaluationProse: [
      'Decide whether you need the firehose or the interpretation. GDELT alternatives that only re-skin the same 15-minute news events are not alternatives; they are clients. A real fork in the road is scored, multi-domain context versus raw global news volume. If you cannot say which output you will ship this week — a model on BigQuery or a hotspot on a map — you cannot pick.',
      'Score archive depth, batch cadence, access (keyless REST versus cloud account), and whether someone has already built the meaning layer. Then score cost of ownership: GDELT REST is free; BigQuery is not "free" once query volume shows up; self-hosted MCP packs are free to clone and expensive to keep alive.',
      'Be suspicious of products that claim to replace GDELT\'s archive. Decades of global news events are not a weekend scrape. An honest alternative either uses GDELT or admits it is doing a different job with a shorter memory.',
    ],
    switchHeading: 'Why teams look for a GDELT alternative',
    switchProse: [
      'The firehose is the feature and the complaint. Teams drown in 15-minute global batches and go looking for something that already scored, filtered, and fused the stream with non-news domains. That search is "GDELT alternative" even when the right product is a curation layer that still ingests GDELT.',
      'The other trigger is operations. BigQuery, quotas, and self-hosted wrappers have a staff cost. A hosted dashboard with published API and MCP prices is a different procurement conversation: you are buying the meaning layer, not the raw archive. Keep GDELT if you still need 1979. Add the watch if you need today.',
    ],
    methodologyProse: methodology(
      'GDELT access paths (keyless DOC 2.0 REST and BigQuery) were read from public GDELT Cloud documentation. Community MCP implementations are labelled community, not as a GDELT-hosted product.',
    ),
    usageHeading: 'How to use this GDELT comparison',
    usageProse: [
      'Keep GDELT if you have a BigQuery workflow and you need 1979. Add World Monitor if you need a scored watch today. Replace GDELT only if you have measured that you never query the archive — most teams that think they can replace it still come back for a historical pull. Self-hosted wrappers are a third path: they do not add a new dataset, they add a process you have to run.',
    ],
    whyWeWinBody: [
      'World Monitor ships the meaning layer: scored indices, hotspots, and convergence cues across conflict, maritime, aviation, and markets, with GDELT-derived signals in the mix. You do not have to build that interpretation on top of a 15-minute firehose to get a watch you can act on.',
      'GDELT still wins archive depth and raw volume. war-dashboard-data and world-intel-mcp still win a self-hosted GDELT surface. The win here is curation and multi-domain context, with REST from $99.99/month and MCP from $39.99/month, not a bigger news dump.',
    ],
    extraFaqs: [
      ['Is GDELT free?', 'DOC 2.0 REST is free and keyless. BigQuery for bulk needs a Google account and is billed as Google Cloud usage. World Monitor\'s dashboard is free; its API and MCP are paid catalog SKUs.'],
      ['Does World Monitor replace GDELT BigQuery?', 'No. If you need decades of raw events in BigQuery, stay on GDELT. World Monitor is the scored, current watch.'],
      ['How often does GDELT update?', '15-minute global batches. World Monitor cadence is source-dependent and includes live and minute-level feeds plus slower datasets.'],
      ['What is world-intel-mcp in this comparison?', 'A GDELT-based MCP project you self-host. It is packaging for the firehose, not a separate event universe.'],
      ['Does World Monitor ingest GDELT?', 'It ingests GDELT-derived signals among 747 attributed providers. That is curation, not a full GDELT mirror.'],
      ['Should I use both?', 'Yes, when you need both the archive and the live scored layer. This page is written for that split.'],
    ],
  },

  'worldmonitor-vs-dataminr': {
    headingProse: [
      'Dataminr is an enterprise alerting company. It ingests proprietary social and public data, sells seconds-to-minutes alerting with SLAs, and does not publish list pricing. World Monitor is the public-source, published-price end of the same "tell me when something breaks" query. The page names what Dataminr wins, then names the only cells a transparent product can win: price, access, and an open catalog.',
    ],
    competitorProfiles: [
      {
        name: 'Dataminr',
        paragraphs: [
          'Dataminr (Pulse and related enterprise products) sells real-time alerting to newsrooms, corporations, and the public sector. The distinctive cells are proprietary social-data ingestion, sub-minute alerting SLAs, and enterprise integration support. Those cells are why it wins procurement in rooms that already have a security budget. The company does not publish list pricing; licenses are negotiated. This page will not invent a number to fill that silence.',
          'Who should pick Dataminr: organizations that need proprietary social firehoses, contractual SLAs, and a vendor that will sit in the incident channel. Who should pick something else: teams that cannot or will not sign an undisclosed enterprise contract, and teams that need a transparent public-source watch they can open without a salesperson. World Monitor is in the second set. It is not a Dataminr clone at a lower SLA.',
          'The category error is treating "alerting" as one product. Dataminr alerts from a proprietary stack. World Monitor alerts from 747 attributed public providers. Speed and exclusivity versus transparency and price is the trade, and both sides of the trade are real.',
        ],
      },
    ],
    evaluationHeading: 'What to look for in a Dataminr alternative',
    evaluationProse: [
      'Ask for the SLA and the source mix in writing. A Dataminr alternative that cannot say whether it ingests proprietary social data is not competing on Dataminr\'s axis. A product that only watches public feeds can still be the right buy, but it is a different buy. Name the difference before you rank.',
      'Then ask for a price you can cite. If the incumbent is undisclosed, the alternative\'s advantage is a public catalog, not a made-up discount to a number neither of you can see. Score signup friction, whether a free canvas exists, REST and MCP availability, and whether sources are attributed. Those are cells a public product can win.',
      'Finally, ask who shows up when the alert is wrong. Enterprise alerting is a service as much as a feed. If you need that service, Dataminr\'s integration and SLA cells matter more than a free map. If you do not, paying for them is how desks overbuy this category.',
    ],
    switchHeading: 'Why teams look for Dataminr alternatives',
    switchProse: [
      'Procurement is the usual trigger. Dataminr does not publish list pricing. Deals take time, legal, and a budget line that a lot of newsrooms, NGOs, and smaller security teams do not have. The search query is "Dataminr alternatives" because the demo was convincing and the quote never became a number they could take to finance — or because the number that finally arrived was a relationship, not a SKU.',
      'The second trigger is scope. Some teams do not need proprietary social ingestion. They need a public-source watch with an API, an MCP server, and no signup wall for the canvas. Those teams are not "settling." They are refusing to buy a cell they will not use. This page is for that refusal, with Dataminr\'s actual wins left on the table.',
    ],
    methodologyProse: methodology(
      'Dataminr pricing is marked undisclosed because no public list price was found on the check date. No third-party estimate is used. World Monitor prices are the public catalog only.',
    ),
    whyWeWinBody: [
      'World Monitor publishes the prices Dataminr does not: $0 for the dashboard, Pro from $39.99/month with MCP, API Starter from $99.99/month. The data is 747 attributed public providers rather than a proprietary social stack. That is the transparency trade: you can verify the cells, and you give up Dataminr\'s exclusivity and SLA.',
      'Dataminr still wins proprietary ingestion, sub-minute SLAs, and enterprise integration. If those cells are the job, this page is not a reason to churn. If the job is a public-source watch you can buy from a catalog, it is.',
    ],
    extraFaqs: [
      ['How much does Dataminr cost?', 'Dataminr does not publish list pricing. This page will not guess. World Monitor publishes $0 / $39.99 / $99.99 catalog SKUs.'],
      ['Is World Monitor as fast as Dataminr?', 'Not as an SLA. Dataminr sells seconds-to-minutes proprietary alerting with enterprise SLAs. World Monitor cadence is source-dependent across public feeds.'],
      ['Does World Monitor ingest social media the way Dataminr does?', 'No. Dataminr\'s proprietary social ingestion is a conceded cell. World Monitor uses attributed public providers.'],
      ['Can a newsroom use World Monitor instead of Dataminr?', 'For a public-source watch, yes. For contractual alerting SLAs and proprietary social detection, no. Many rooms will keep Dataminr and add a public canvas.'],
      ['Does World Monitor require an enterprise contract?', 'No. The dashboard is free without signup. Dataminr licenses are enterprise-negotiated. That is a different access model, not a free Dataminr.'],
      ['Why is Dataminr\'s price cell undisclosed?', 'Because we could not cite a vendor list price on 5 September 2026. Undisclosed is the honest cell. A fabricated dollar figure would contradict this site\'s own comparison rules.'],
    ],
  },

  'worldmonitor-vs-recorded-future': {
    headingProse: [
      'Recorded Future is an enterprise intelligence platform across cyber, physical threat, geopolitical, country risk, and travel safety. It is not a shop that stops at cyber, and this page will not describe it that way. Flare and MISP sit on the same table because "Recorded Future alternatives" in search is a mixed bag of dark-web exposure tools and threat-intel sharing. World Monitor is the public-source, published-price, multi-domain dashboard in that mix — not a replacement for an enterprise intelligence platform.',
    ],
    competitorProfiles: [
      {
        name: 'Recorded Future',
        paragraphs: [
          'Recorded Future sells a continuous intelligence platform to enterprises. Coverage includes cyber threat intelligence, physical threat, geopolitical and country risk, and travel safety. Sources are proprietary plus licensed. Integrations and per-indicator risk scoring are the enterprise cells. List pricing is not published; contracts are negotiated.',
          'Pick Recorded Future when you need that platform: indicator scoring, analyst workflow, and a vendor that will contract for it. Pick it for depth, not for a free map. Who should not pick it as a first tool: teams that needed a transparent public-source watch and got sent into an enterprise RFQ by a search result.',
        ],
      },
      {
        name: 'Flare',
        paragraphs: [
          'Flare focuses on cyber exposure and dark-web monitoring. Pricing is an undisclosed subscription. It is not a geopolitical dashboard. It wins the dark-web cell that neither World Monitor nor a general news map is trying to own.',
          'Pick Flare for exposure monitoring. Do not pick it as a Recorded Future geopolitical substitute; that is a different module of a different platform.',
        ],
      },
      {
        name: 'MISP',
        paragraphs: [
          'MISP is open-source threat-intel sharing you self-host. It is free as software, costly as operations. The job is structured indicator sharing across communities, not a multi-domain situational picture and not a hosted SaaS SLA.',
          'Pick MISP when you need to share IOCs with a community and can run the stack. It is AGPL-family open source, like World Monitor the software, but the products are not interchangeable.',
        ],
      },
    ],
    evaluationHeading: 'What to look for in a Recorded Future alternative',
    evaluationProse: [
      'Split the platform before you shop. Recorded Future alternatives might mean cheaper cyber TI, a dark-web scanner, a sharing community, or a public geopolitical dashboard. Those are four buys. A page that ranks them as one ladder is how enterprises overpay and how startups overclaim.',
      'For the intelligence-platform job, score source mix (proprietary and licensed versus public attributed), indicator scoring, integrations, travel and physical coverage, and whether list pricing exists. For the dashboard job, score signup, live domains, REST, MCP, and license. Do not let a strong cyber module win a geopolitical-map query, and do not let a free map win an indicator-scoring query.',
      'Require the vendor to say what they are not. Recorded Future is not a free canvas. World Monitor is not a per-indicator TI platform. Flare is not a country-risk desk. MISP is not hosted alerting. Alternatives that cannot utter a negative sentence are not ready to be compared.',
    ],
    switchHeading: 'Why teams search for Recorded Future alternatives',
    switchProse: [
      'Price opacity and package size. Recorded Future does not publish list pricing, and the platform spans more modules than a lot of searchers need. A team that wanted geopolitical context and a public API gets a full enterprise TI suite in the demo. The leftover feeling is "this is more than we can buy," which Google hears as "alternatives."',
      'The other trigger is openness. Security teams that already run MISP, or that need AGPL software they can audit, are not trying to become Recorded Future customers. They are trying to keep sharing infrastructure and add a public watch. Naming that trigger keeps World Monitor in the public-source lane instead of a fake TI-platform lane.',
    ],
    methodologyProse: methodology(
      'Recorded Future is scored from public product descriptions as a multi-domain intelligence platform, not as a product that stops at cyber. No list price was found. Flare and MISP cells were read from public product and project pages.',
    ),
    whyWeWinBody: [
      'World Monitor wins the cells a public catalog can win: a free dashboard, published Pro and API prices, AGPL-3.0 software, and multi-domain public-source context including cyber alongside conflict, maritime, and aviation. It does not win indicator scoring, licensed TI depth, or enterprise integrations.',
      'Recorded Future remains the enterprise platform. Flare remains the dark-web specialist. MISP remains the sharing community. Use this page to decide whether you needed that platform or you needed a transparent watch. If you needed the platform, the concession list is your stop sign.',
    ],
    extraFaqs: [
      ['Is Recorded Future only a cyber tool?', 'No. Public product copy covers cyber, physical threat, geopolitical, country risk, and travel safety. Reducing it to cyber would be wrong on this page.'],
      ['How much does Recorded Future cost?', 'It does not publish list pricing. Contracts are enterprise-negotiated. World Monitor publishes catalog prices.'],
      ['Is World Monitor a TI platform?', 'No. It is a multi-domain public-source dashboard and API that includes cyber context. It does not replace per-indicator enterprise TI.'],
      ['Should I use MISP or World Monitor?', 'MISP for sharing indicators with a community you can host. World Monitor for a hosted multi-domain watch. Many teams will run both.'],
      ['Does Flare cover geopolitics?', 'Not as its primary job. Flare is scored here for dark-web exposure. Geopolitical context is World Monitor\'s lane, and Recorded Future\'s platform lane.'],
      ['Can I try Recorded Future without a contract?', 'Not from any public self-serve catalog we can cite. World Monitor\'s dashboard is usable without signup.'],
      ['Why are Flare and MISP on a Recorded Future page?', 'Because "Recorded Future alternatives" queries mix TI platforms, exposure tools, and sharing software. Leaving them off would hide the mix. Ranking them as the same product would hide the differences.'],
    ],
  },

  'worldmonitor-vs-deepstatemap': {
    heading: 'Deep State Map alternatives',
    headingProse: [
      'Deep State Map is a Ukraine frontline product. World Monitor is a global multi-domain watch. The comparison is theatre granularity versus global fusion, and Deep State Map wins the theatre. Anyone shopping for a "Deep State Map alternative" because they needed Ukraine lines should stay. Anyone shopping because they needed the rest of the world should not treat Ukraine geometry as the category.',
    ],
    competitorProfiles: [
      {
        name: 'Deep State Map',
        paragraphs: [
          'Deep State Map is free and ad-supported. Analysts maintain frontline geometry for the Ukraine theatre by hand. There is no REST API cell and no MCP cell we can verify. The archive is a Ukraine archive. The product is the line on the map, not a multi-domain index. Cadence is manual: the line moves when an analyst draws it, not when a scraper ticks.',
          'Who should pick it: anyone whose question is where the front is in Ukraine today at a granularity a global dashboard will not match. Who should pick something else: desks that need global conflict plus maritime, aviation, and markets, or that need a published API. Those are different jobs that happen to share a war.',
          'The honest dual-tab desk is common. Keep Deep State Map for the line. Add a global canvas when the whiteboard has more than one theatre. This page exists because the search query uses Deep State Map\'s name even when the new job is the rest of the world. Answering that query by claiming better Ukraine geometry would be the wrong win.',
        ],
      },
    ],
    evaluationHeading: 'What to look for in a Deep State Map alternative',
    evaluationProse: [
      'If the requirement is Ukraine frontline geometry, score analyst maintenance, update honesty (manual versus automated), and whether the product is actually a theatre map. Most "alternatives" fail that test because they are worldwide canvases. Worldwide is not a superset of theatre granularity; it is a different resolution.',
      'If the requirement is global coverage, score domains, signup, API, and whether Ukraine is one theatre among many rather than the whole product. Then stop trying to make the global canvas win a geometry fight. Concede the line. Win the rest of the world.',
      'Price is the easy cell here — both products have a free canvas — so it should not decide the bake-off. Resolution and scope should. An alternative that only undercuts Deep State Map on ads or branding is not an alternative; it is a reskin that still loses the line.',
    ],
    switchHeading: 'Why teams look for a Deep State Map alternative',
    switchProse: [
      'Usually they outgrew the theatre. A desk that started on Ukraine now has to watch the Red Sea, Taiwan, and a cable cut in the same hour. Deep State Map will not become that desk. The search query keeps the old name because that is the map they trust, even when the new job is global.',
      'Sometimes they need an API or a map without ads. Deep State Map does not publish a REST quota. World Monitor does. That is a real switch trigger, and it still does not make World Monitor better at Ukraine geometry. Hold both thoughts or you will buy the wrong product.',
    ],
    methodologyProse: methodology(
      'Deep State Map is scored from its public map product: free, ad-supported, Ukraine theatre, manual analyst updates. No public API was found.',
    ),
    usageHeading: 'How to use this Deep State Map comparison',
    usageProse: [
      'If your standing question is "where is the front in Ukraine," keep Deep State Map and ignore the rest of this URL. Global coverage will not make the line more precise. If your standing question is "what else in the world moved," open World Monitor and keep Deep State Map in a second window. If you need an API, only one of these products publishes one. Those three questions are the whole decision; brand preference is not a fourth.',
      'Do not evaluate this as a Ukraine-versus-Ukraine fight. World Monitor will lose it, as the concession says. Evaluate it as theatre-versus-planet. The search query uses Deep State Map\'s name because that is the map people trust. The comparison uses that name to route you to the right resolution, including back to the incumbent. Ads versus no-ads is a real but secondary cell; both canvases are free, so resolution still decides.',
    ],
    whyWeWinBody: [
      'World Monitor wins global multi-domain coverage: every theatre plus maritime, aviation, market, and infrastructure context, with a free canvas and a published API. That is the product you open when Ukraine is not the only line on the whiteboard, including theatres and domains Deep State Map does not draw.',
      'Deep State Map still wins Ukraine frontline granularity. If that is the question, this page\'s job is to send you back. If the question is the rest of the world, it is to stop you from using a theatre map as a global OS.',
    ],
    extraFaqs: [
      ['Does Deep State Map cover theatres besides Ukraine?', 'No. It is a Ukraine frontline product. World Monitor covers Ukraine as one theatre among many, plus other domains.'],
      ['Does World Monitor have better Ukraine frontline detail?', 'No. Deep State Map does. The concession is explicit.'],
      ['Does Deep State Map have an API?', 'Not that we can verify from public pages. World Monitor API Starter is $99.99/month for 1,000 requests/day.'],
      ['Can I use both?', 'Yes. Theatre geometry plus a global fused watch is a normal desk. This comparison does not require a breakup.'],
      ['Does World Monitor cover Ukraine at all?', 'Yes, as one theatre in a global conflict layer, not as an analyst-maintained frontline product.'],
      ['Why compare them if the jobs differ?', 'Because the search query exists. A comparison that refuses the query is useless; a comparison that pretends the jobs are the same is dishonest.'],
    ],
  },

  'mcp-servers-for-geopolitical-data': {
    headingProse: [
      'Most "MCP servers for geopolitical data" are self-hosted wrappers around free upstreams. World Monitor is the hosted option: entitlements, quotas, OAuth, a published server-card, and an agent-skills index. Tool count is not our axis. Satellite MCP\'s 171 tools and world-intel-mcp\'s 120 tools beat us on that row, and the concession list says so before the rest of the page argues hosted access.',
    ],
    competitorProfiles: [
      {
        name: 'world-intel-mcp',
        paragraphs: [
          'world-intel-mcp is a MIT-licensed, self-hosted MCP surface over GDELT-derived events. It is free to clone. You run it, patch it, and absorb upstream rate limits. The win is a broad tool surface — on the order of 120 tools in public materials — and a license you can fork.',
          'Pick it when you want to own the process and you are already in the GDELT universe. Pick a hosted server when you want OAuth, quotas, and someone else to keep the lights on.',
        ],
      },
      {
        name: 'Satellite MCP',
        paragraphs: [
          'Satellite MCP is the tool-count winner: on the order of 171 tools for imagery and passes, open source, self-hosted, cadence tied to pass schedules. It is not a multi-domain geopolitical server. It is a satellite workstation that speaks MCP.',
          'Pick it for satellite-only agent workflows. Do not pick it as a hosted conflict-plus-AIS server; that is a different machine.',
        ],
      },
      {
        name: 'OSINT MCP',
        paragraphs: [
          'OSINT MCP exposes a wide OSINT tool surface (on the order of 64 tools) for self-hosters. Upstream dependent, open source, not a governed multi-domain data plane. The win is breadth of tools outside World Monitor\'s scope.',
          'Pick it to give an agent a grab-bag of OSINT utilities. Pick World Monitor to give an agent one authenticated path into live scored feeds.',
        ],
      },
      {
        name: 'war-dashboard-data',
        paragraphs: [
          'A GDELT-based war dashboard you host, with MCP packaging in the same family as the firehose wrappers. Cadence follows GDELT\'s 15-minute batches. It is a conflict-event surface, not a fusion layer.',
          'Pick it to self-host a GDELT war view. It will not give you entitlements, OAuth, or maritime and aviation in the same governed session.',
        ],
      },
      {
        name: 'GDELT Cloud MCP',
        paragraphs: [
          'Community MCP implementations on top of GDELT Cloud. The upstream is the 15-minute global news firehose and the 1979 archive. The MCP is not a GDELT-hosted product with a published enterprise SLA; it is community plumbing, labelled that way in the matrix.',
          'Pick it for raw volume in an agent loop. Pick World Monitor for scored multi-domain access with a server-card you can point an agent at.',
        ],
      },
      {
        name: 'Off-Nadir Delta',
        paragraphs: [
          'Open-source, self-hosted imagery and geospatial tooling over public sources. Upstream dependent. The job is imagery workflows, not a hosted geopolitical data plane.',
          'Pick it when the agent needs imagery tools you will run. It is not competing for the hosted multi-domain cell.',
        ],
      },
      {
        name: 'IMF PortWatch MCP',
        paragraphs: [
          'PortWatch is the free, authoritative chokepoint transit source (28 ports and chokepoints, IMF and Oxford). Community MCP implementations exist. The data is the win; hosting is still your problem unless you only consume the public API.',
          'Pick PortWatch MCP for transit counts. Pick World Monitor when those counts have to sit next to conflict, aviation, and markets in one authenticated agent session.',
        ],
      },
    ],
    evaluationHeading: 'What to look for in a geopolitical MCP server',
    evaluationProse: [
      'Separate hosted from self-hosted before you count tools. A 171-tool process you have to patch is not the same product as a smaller hosted surface with OAuth, quotas, and a server-card. If your team cannot run Node on a box, tool count is a vanity metric.',
      'Score auth (OAuth versus a local stdio process), entitlements, documented quotas, whether the server-card is published, whether skills are indexed, and whether the upstream is one firehose or many attributed providers. Then score license and who files the bug when the wrapper breaks.',
      'Demand an honest Unverified cell. Most third-party geopolitical MCP mentions are community wrappers. Labelling them "Yes" without "community" or "self-hosted" is how this category lies. World Monitor\'s cell is hosted with entitlements. The others on this page are self-hosted or community except where noted.',
      'Skills and server-cards are not decoration. An agent that cannot discover the server will not use it. World Monitor publishes a server-card and an agent-skills index so discovery is a document, not a Slack message. Self-hosted packs publish READMEs, which is a different discovery path and a valid one if your team reads READMEs. Choose the discovery path you will actually maintain. A tool surface nobody can find is a 171-tool graveyard.',
    ],
    switchHeading: 'Why teams look for a hosted geopolitical MCP server',
    switchProse: [
      'Agents showed up at work. A pile of stdio wrappers that each talk to one free API is fine for a weekend. It is not fine for a desk that needs one OAuth login, a quota, and a server-card an agent can discover. The search starts as "MCP servers for geopolitical data" because that is the protocol, not because the team wants 171 satellite tools.',
      'The second trigger is operations. Someone has to patch the GDELT wrapper when the schema moves. Hosted access moves that job to a vendor with a catalog price. You pay $39.99/month at Pro and you lose the 171-tool row. That trade is the whole page.',
    ],
    methodologyProse: methodology(
      'Tool counts for Satellite MCP, world-intel-mcp, and OSINT MCP are the public figures used in this family\'s concessions. MCP cells are Yes (hosted), Yes (self-hosted), Yes (community implementation), or Unverified — never an unqualified Yes for a wrapper we did not verify.',
    ),
    usageHeading: 'How to use this MCP comparison',
    usageProse: [
      'Inventory the agents first. If the agent needs satellite passes and imagery tools, Satellite MCP is the row and World Monitor is a sidecar. If it needs a GDELT firehose on a box you control, world-intel-mcp or war-dashboard-data is the row. If it needs chokepoint transits with IMF authority, PortWatch is the row. If it needs one OAuth login into scored conflict, maritime, aviation, and market feeds, World Monitor MCP is the row. Tool count is how you lose this bake-off: you will pick 171 tools and still not have entitlements.',
      'Write the operations question into the RFP: who patches the wrapper when upstream schema moves. Self-hosted packs answer "we do." Hosted Pro answers "the vendor does, for $39.99/month." Both answers are legitimate. Mixing them up is how a demo full of tools becomes an unowned process in production. Keep Unverified cells unverified until a public server-card exists; do not let a README screenshot count as a hosted product.',
      'Auth is the other split. A local stdio process with a personal API key is not OAuth with entitlements. Agents that will be shared across a team need the second. Agents that live on one laptop can use the first. World Monitor MCP is built for the shared case. Satellite MCP and OSINT MCP are built for the laptop-and-fork case. GDELT community MCP is built for the firehose case. If your proof-of-concept used stdio, do not assume production can keep that shape once two more people join the desk.',
    ],
    whyWeWinBody: [
      'World Monitor is the hosted geopolitical MCP: entitlements, quotas, OAuth, a published server-card, and an agent-skills index over live multi-domain data. Agents authenticate once. You do not run the process. That is the cell self-hosted packs are not selling.',
      'They still win tool count and the ability to fork for free. If your requirement is 171 satellite tools on a box you control, take Satellite MCP. If your requirement is governed multi-domain access, take the hosted server and stop scoring this as a hammer-versus-hammer fight.',
      'The hosted cell also includes a documented quota. Self-hosted packs inherit whatever the upstream API will tolerate today, which is not a quota you can put in a contract. Agents that retry aggressively will discover that difference in production. Pro at $39.99/month is the price of not discovering it that way, plus OAuth and the server-card. It is not the price of 171 tools, and this page will not sell it as that. If you need both, run the satellite pack locally and authenticate the multi-domain session against the hosted server.',
    ],
    extraFaqs: [
      ['Is World Monitor MCP free?', 'No. MCP access starts at Pro, $39.99/month. The dashboard is free. Self-hosted packs are free as software and cost you operations.'],
      ['Why concede 171 tools?', 'Because it is true. Satellite MCP\'s tool-count breadth is a real win for satellite-only workflows. We do not compete on that row.'],
      ['Does World Monitor wrap GDELT only?', 'No. It curates 747 attributed providers across domains. GDELT-derived signals are in the mix, not the whole mix.'],
      ['Can I point Claude or another agent at World Monitor MCP?', 'Yes. That is what a published server-card and OAuth are for. Confirm current auth docs at /mcp; this page is the comparison, not the live protocol spec.'],
      ['Is a community GDELT MCP official?', 'No. It is labelled community implementation. GDELT Cloud is the upstream data; the MCP is plumbing.'],
      ['Should I self-host and also buy Pro?', 'You can. Self-host the satellite or OSINT packs you need, and use World Monitor MCP for the governed multi-domain session. The page is a comparison, not a monopoly.'],
      ['What does "Unverified" mean in the MCP column?', 'We could not cite a public MCP server or community implementation on the check date. It is not a "No." It is a refusal to guess.'],
    ],
  },

  'chokepoint-monitoring-tools': {
    headingProse: [
      'IMF PortWatch is the first result for this query, and it should be. It is free, it covers 28 ports and chokepoints, it offers bulk download, and it is backed by IMF and Oxford. World Monitor covers ' + CHOKEPOINT_COUNT + ' chokepoints and wins only if you need those transits fused with conflict, aviation, markets, and climate. Hiding PortWatch is not survivable, so the concession leads.',
      'Vessel platforms in the same search — MarineTraffic, Kpler, Windward, Lloyd\'s List Intelligence — answer "where is the ship" and "what is the cargo risk," not "what is the strait total." They belong on this list so a procurement team does not think AIS is a PortWatch substitute. straits.live is the simple public window. SENTINEL GIP is a priced infrastructure monitor that still has to earn PortWatch\'s citation. Read the profiles as a stack, not as a single-winner podium.',
    ],
    competitorProfiles: [
      {
        name: 'IMF PortWatch',
        paragraphs: [
          'PortWatch publishes chokepoint and port transit indicators with an API, community MCP implementations, and bulk download in multiple formats. Coverage is 28 ports and chokepoints. The authority cell is the point: IMF plus Oxford, open data, zero cost. Event-triggered updates, not a fused world picture.',
          'Pick PortWatch when the question is "how many transits." It wins that question against everyone on this page, including us. Pick World Monitor when the next sentence is "and what else moved." The API and bulk-download cells are PortWatch wins as well; we do not relabel fusion as a download format.',
        ],
      },
      {
        name: 'MarineTraffic',
        paragraphs: [
          'MarineTraffic is vessel-level AIS tracking, with a free tier and enterprise plans under Kpler. The product is ships, not chokepoint indices. Partial API on paid plans. MCP unverified.',
          'Pick it to follow a vessel. Do not pick it as a chokepoint fusion layer; you will rebuild PortWatch and still lack conflict and aviation context.',
        ],
      },
      {
        name: 'Kpler',
        paragraphs: [
          'Kpler sells cargo and commodity flow analytics on an enterprise-negotiated contract. Near-real-time, proprietary plus AIS. No list price we can cite.',
          'Pick Kpler for commercial flow analytics. It is not a free chokepoint watch and not a multi-domain intelligence canvas.',
        ],
      },
      {
        name: "Lloyd's List Intelligence",
        paragraphs: [
          "Lloyd's List Intelligence is editorial maritime risk plus AIS, sold as enterprise. The archive and the byline are the win. List pricing is undisclosed.",
          'Pick it for editorial maritime risk. Pick PortWatch for open transit counts. Pick World Monitor for fusion across domains.',
        ],
      },
      {
        name: 'Windward',
        paragraphs: [
          'Windward applies AI to AIS for vessel behavioral analytics — dark activity, spoofing, risk scores on ships. Enterprise-negotiated. Not a chokepoint index and not a conflict-fusion map.',
          'Pick Windward for behavioral vessel risk. It wins that cell; it does not win "what happened to the strait plus the airspace."',
        ],
      },
      {
        name: 'SENTINEL GIP',
        paragraphs: [
          'SENTINEL GIP publishes a price (from $29.99/month) for global infrastructure protection monitoring. MCP unverified. Public evidence for chokepoint methodology is thinner than PortWatch, so this page does not treat it as an IMF substitute.',
          'Pick it if you already evaluated the product. Demand the same cells PortWatch fills for free before you pay.',
        ],
      },
      {
        name: 'straits.live',
        paragraphs: [
          'straits.live is a free, no-signup strait transit watcher on AIS. Simple on purpose. No API we can verify. It is a window, not a platform.',
          'Pick it for a lightweight public strait view. It will not fuse conflict or aviation, and it will not give you PortWatch\'s bulk download.',
        ],
      },
    ],
    evaluationHeading: 'What to look for in a chokepoint monitoring tool',
    evaluationProse: [
      'Split counts from context. Transit counts are a time series with an authority and a download button. Context is what else in the world moved when the count broke. PortWatch is the counts product. World Monitor is the context product. Vessel platforms (MarineTraffic, Kpler, Windward, Lloyd\'s) are a third job: the ship, not the strait index.',
      'Score coverage (how many chokepoints, named), cost, bulk download, API, whether AIS is vessel-level or aggregated, and whether conflict, aviation, and markets sit on the same canvas. Then score who stands behind the number. IMF plus Oxford is a citation. A startup dashboard is a dashboard. Both can be useful; they are not equal evidence.',
      'If a vendor will not publish a price, mark it undisclosed. If a vendor has fewer named chokepoints than PortWatch, say so — we do, ' + CHOKEPOINT_COUNT + ' versus 28. A chokepoint tool that cannot survive that sentence should not be in the category.',
      'Name the chokepoints. A coverage number without names is a press release. World Monitor\'s count is the committed registry used elsewhere on this site. PortWatch names ports and chokepoints in public data products. If a vendor says "global infrastructure" without a list you can audit, treat the coverage cell as unverified even if the marketing site is confident. Fusion without a named set is not fusion; it is a vibe.',
    ],
    switchHeading: 'Why teams look past PortWatch',
    switchProse: [
      'They do not, at first. PortWatch is free and authoritative. The search for alternatives starts when a transit count is not enough: a cable cut, an airspace closure, a freight spike, and a conflict pin have to be read together. PortWatch will not become that canvas. That is not a knock. It is the product boundary.',
      'The other trigger is vessel-level work. Analysts who need a ship, not a strait total, leave PortWatch for MarineTraffic, Kpler, or Windward. That is a different fork than World Monitor. This page keeps both forks visible so "chokepoint tools" does not collapse into a single winner.',
    ],
    methodologyProse: methodology(
      `World Monitor chokepoint coverage is the committed registry (${CHOKEPOINT_COUNT} chokepoints), not a marketing round-up. PortWatch's 28 coverage figure is from its public product. Enterprise maritime vendors without list prices stay undisclosed.`,
    ),
    usageHeading: 'How to use this chokepoint tools list',
    usageProse: [
      'Buy PortWatch first if you do not already have it. It is free, it is authoritative, and it wins the count cell. Then ask whether counts are the whole question. If yes, stop. If the next sentence in the incident is about airspace, cables, conflict, or freight, add World Monitor. If the next sentence is about a specific vessel, add MarineTraffic or Windward. If it is about cargo flows as a commercial product, add Kpler. If it is about editorial maritime risk, add Lloyd\'s List Intelligence.',
      'Do not let a fusion demo talk you out of PortWatch\'s bulk download. Do not let a vessel platform talk you out of a strait index. Chokepoint monitoring is three jobs that share a waterway: the count, the ship, and the rest of the world. This page lists vendors for all three so you can stack them instead of declaring a false winner. Our coverage number is ' + CHOKEPOINT_COUNT + ' because that is the registry, not because a larger number would look better next to 28.',
      'Enterprise maritime vendors without list prices — Kpler, Lloyd\'s List Intelligence, Windward — belong in a negotiated bake-off, not in a "which free tool" argument. SENTINEL GIP does publish a floor price, which is useful, but it does not inherit PortWatch\'s IMF plus Oxford citation. straits.live is the simple public window. Stack, do not average. A desk that buys fusion and skips counts, or buys AIS and skips the strait index, will rebuild the missing layer under incident pressure.',
    ],
    whyWeWinBody: [
      'World Monitor fuses ' + CHOKEPOINT_COUNT + ' named chokepoints with conflict events, aviation disruption, market moves, and climate hazards. A slowdown can be read next to the cable cut, the airspace closure, and the freight spike. PortWatch will give you the transit count. We give you the rest of the hour.',
      'We still lose coverage (28 versus ' + CHOKEPOINT_COUNT + '), bulk download formats, and IMF plus Oxford authority. Those losses are the first thing on the page because a fusion story that hides PortWatch is not survivable. Buy PortWatch for counts. Add World Monitor when counts are not the whole question.',
      'Fusion here means a named chokepoint next to conflict, aviation, market, and climate layers on one canvas, not a promise that we re-derived PortWatch\'s transit model. We do not out-IMF the IMF. We put the strait in the same view as the rest of the incident. That is a narrower claim than "best chokepoint tool," and it is the only claim that survives the 28-versus-' + CHOKEPOINT_COUNT + ' sentence. Download PortWatch\'s bulk files for the time series; keep this canvas for the hour the series breaks.',
    ],
    extraFaqs: [
      ['Why does World Monitor have fewer chokepoints than PortWatch?', `Because the committed registry has ${CHOKEPOINT_COUNT} named chokepoints and PortWatch publishes 28. This page concedes the coverage cell instead of inflating our count.`],
      ['Does World Monitor replace PortWatch bulk download?', 'No. PortWatch wins bulk download formats and IMF plus Oxford authority. World Monitor is the fused canvas next to those counts.'],
      ['Does World Monitor replace MarineTraffic?', 'No. MarineTraffic is vessel-level tracking. World Monitor is fused chokepoint awareness plus other domains, not a full AIS fleet platform.'],
      ['Can I use PortWatch data with World Monitor?', 'Yes in the analytical sense: PortWatch for counts, World Monitor for fusion. This page does not claim a bulk-import productized integration; it claims a desk that can read both.'],
      ['Which tool is best for commodity flows?', 'Kpler, for commercial cargo-flow analytics. World Monitor will show market context next to a chokepoint, not a Kpler-style flow model.'],
      ['Does straits.live have an API?', 'Not that we can verify. World Monitor API Starter is $99.99/month for 1,000 requests/day; PortWatch also publishes an API.'],
      ['Why is Windward on a chokepoint page?', 'Because vessel-behavior platforms show up in the same procurement. They win a different cell (behavioral AIS). Listing them prevents a false "all of these count transits" ranking.'],
    ],
  },

  'free-geopolitical-risk-dashboards': {
    headingProse: [
      'Free is not a price. It is a stack of walls: signup, trial clocks, client-only portals, and "free" products that start charging at $1.99. This page keeps the word for canvases you can open without an account. World Monitor and the-world-now.com clear that bar. OrreryX publishes a cheap ladder but is not free. BlackRock GRD is client-only. ICG CrisisWatch is free as a monthly brief, not as a live map.',
      'ConflictZone.io is the other genuine no-signup conflict canvas. Sentinel (Axonia) is budget paid from $3.99/month. Deep State Map is free for Ukraine geometry. Putting all of them under one H1 is only honest if the profiles keep the jobs apart. This page would be shorter if we omitted the paid and gated rows; it would also be easier for those rows to pose as free on someone else\'s list.',
    ],
    competitorProfiles: [
      {
        name: 'OrreryX',
        paragraphs: [
          'OrreryX publishes tiers from $1.99/month to $34.99/month. That is cheaper than World Monitor Pro and is conceded. It is consultative geopolitical risk with periodic updates, not a no-signup live map. Calling it free because the floor is low is how this category cheats.',
          'Pick OrreryX when you want a published-price analyst product and you can create an account. Do not pick it as a free dashboard. The ladder is the honesty; the word "free" is not.',
        ],
      },
      {
        name: 'the-world-now.com',
        paragraphs: [
          'A free global event browser with no signup. Near-real-time events, no API we can verify, not a scored multi-domain index. It is in the genuine free-canvas set.',
          'Pick it for event browsing without an account. Pick World Monitor when you need fusion, an API, or MCP on top of a free canvas. Both pass the stranger test; only one of them is a multi-domain scored watch with a published programmatic path.',
        ],
      },
      {
        name: 'Sentinel (Axonia)',
        paragraphs: [
          'Sentinel (Axonia) starts at $3.99/month. That is a budget paid product, not a free dashboard. Signup required. MCP unverified.',
          'Pick it as a cheap paid monitor if you evaluated the product. It does not belong in a "no signup, $0" bake-off except as a cautionary row.',
        ],
      },
      {
        name: 'ConflictZone.io',
        paragraphs: [
          'Free conflict-event browsing, no signup, no verified API. A genuine free canvas in a narrow domain.',
          'Pick it for conflict headlines without an account. It will not cover maritime, aviation, or markets.',
        ],
      },
      {
        name: 'BlackRock GRD',
        paragraphs: [
          'Client-only, monthly or quarterly analyst updates. Not free, not a dashboard you can open from this page, included so "institutional free research" does not sneak onto the list unlabelled.',
          'If you are a client, use it. If you are googling free dashboards, it is not your row.',
        ],
      },
      {
        name: 'Deep State Map',
        paragraphs: [
          'Free, ad-supported, Ukraine theatre, analyst-maintained geometry. A genuine free canvas with a theatre limit.',
          'Pick it for Ukraine lines. It is free. It is not a global risk dashboard.',
        ],
      },
      {
        name: 'ICG CrisisWatch',
        paragraphs: [
          'Free monthly analyst briefs on 70+ conflicts, archive to 2003. Two decades of hand-written entries, no live map, no signup for the publications.',
          'Pick it as the strongest free analyst read on this list. Do not pick it as a real-time dashboard; the cadence is monthly on purpose.',
        ],
      },
    ],
    evaluationHeading: 'What to look for in a free geopolitical risk dashboard',
    evaluationProse: [
      'Define free as "no account, no card, no trial clock." Anything else is a paid product with a marketing adjective. Score the canvas first: can a stranger load it. Then score cadence, domains, and whether a paid upgrade exists as a catalog SKU rather than a surprise paywall.',
      'Watch for category laundering. Monthly briefs, theatre maps, and $1.99 ladders are useful. They are not free live dashboards. A comparison that dumps them in one column labelled Free is how search pages lie. This matrix keeps the price cell honest even when the H1 contains the word.',
      'Then score what you lose by not paying. Free canvases often lack APIs, exports, and SLAs. That is acceptable if the job is a human looking at a map. It is not acceptable if the job was programmatic access all along — in which case you were never shopping for free, you were shopping for a catalog.',
      'Cadence still applies when the price is zero. CrisisWatch is free and monthly. Deep State Map is free and manual. World Monitor is free and source-dependent, including live feeds. the-world-now.com is free and near-real-time for events. Ranking all four as "free dashboards" without cadence is how a monthly brief wins a live-map query on price and loses the user in the first incident. Put cadence next to the stranger test before you declare a winner.',
    ],
    switchHeading: 'Why teams search for a free geopolitical risk dashboard',
    switchProse: [
      'Budget and procurement friction. Enterprise dashboards want a contract. "Free" tools want a card and a 14-day clock. The remaining query is a canvas you can open on a new laptop during an incident without waiting for IT. That is a real requirement, not a cheapness hobby.',
      'The second trigger is honesty about the wall. Teams bounced from a registration gate go looking for whoever will actually show the map. World Monitor\'s claim on this page is that the full public map loads without signup. If that claim ever needs an account, this page should be rewritten, not footnoted.',
    ],
    methodologyProse: methodology(
      'Free is scored from public access: whether a stranger can load the canvas without an account. OrreryX and Sentinel prices are published paid tiers, not free. BlackRock GRD is client-only.',
    ),
    usageHeading: 'How to use this free-dashboards list',
    usageProse: [
      'Apply the stranger test. Open a private window. If the canvas loads without an account, it is a candidate for this query. If it asks for a card, a trial, or a client login, it is a paid or gated product and belongs in a different bake-off even if the marketing site says free. World Monitor and the-world-now.com pass. OrreryX, Sentinel (Axonia), and BlackRock GRD fail. CrisisWatch passes as a publication, not as a live map. Deep State Map passes as a theatre map.',
      'After the stranger test, apply the job test. Free live map is not free analyst history, is not free Ukraine geometry, is not a $1.99 consultative ladder. Write the job down. Then look at the concession list and buy the free or cheap product that actually does that job. The reason this page exists is that "free geopolitical risk dashboard" is several queries, and mixing them is how a monthly brief gets scored as if it were a live AIS canvas.',
      'Paid SKUs on a free canvas are allowed. World Monitor Pro and API are catalog upgrades, not the key to the map. OrreryX and Sentinel (Axonia) are paid from the first login. That distinction is the whole honesty argument. If a vendor\'s free tier is a clock, it is a trial, and it should not be in the no-signup column. If you need programmatic access, you were never in the free-dashboard query; you were in the API query, and the $99.99 API Starter row is the one to read.',
    ],
    whyWeWinBody: [
      'World Monitor serves the full public map at $0 with no signup and no card, across conflict, maritime, aviation, markets, cyber, and climate, with source-dependent live and slower feeds. The paid SKUs are optional catalog items (Pro, API), not the key to the canvas. That is the free-dashboard claim, and it is the one most "free" rows on this list cannot match.',
      'ICG CrisisWatch still wins two decades of analyst entries. OrreryX still wins a cheaper published paid ladder. Deep State Map still wins Ukraine geometry. the-world-now.com still matches us on no-signup event browsing. The win is the no-signup multi-domain live map, not a monopoly on the word free.',
      'If a vendor needs your email to show the map, it failed the stranger test even if the invoice is $0. If a vendor shows the map and then gates AIS, aviation, or history behind a trial clock, it failed the full-canvas test. World Monitor\'s public dashboard is the full canvas at $0. Paid SKUs add MCP and REST, not the right to look. That split is the product, and it is why this row can sit on a free-dashboards page without a footnote that takes it back. A clock is a trial. A catalog upgrade is a catalog upgrade. Mixing the two is how "free" pages lose the reader.',
    ],
    extraFaqs: [
      ['Is OrreryX free?', 'No. It publishes paid tiers from $1.99/month. It is on this page because "free dashboard" queries mix cheap paid tools with actual free canvases.'],
      ['Does World Monitor stay free if I need an API?', 'The dashboard stays free. The API is a paid SKU from $99.99/month. MCP is a paid SKU from Pro at $39.99/month.'],
      ['Which free option is best for analyst narrative?', 'ICG CrisisWatch, monthly, 70+ conflicts, archive to 2003. It is not real-time.'],
      ['Which free option is best for Ukraine?', 'Deep State Map, for frontline geometry. World Monitor for Ukraine as one theatre in a global watch.'],
      ['Is BlackRock GRD free for the public?', 'No. Client-only.'],
      ['Do I need to register for World Monitor?', 'Not for the public dashboard. Registration is not the key to the canvas this page is about.'],
      ['Why include paid rows on a free page?', 'Because the query mixes them. Labelling paid rows as paid is the point. Omitting them would let them pose as free elsewhere.'],
    ],
  },

  'travel-risk-intelligence-vs-assistance': {
    headingProse: [
      'Travel-risk shopping collapses two products into one query: intelligence (what is happening) and assistance (who comes to get you). International SOS runs 27 assistance centers. World Monitor runs none. Crisis24 coordinates duty-of-care. World Monitor does not. This page exists so a security lead does not cancel an assistance retainer because a free map looked comprehensive. Keep the retainer. Add an awareness layer if you need one.',
      'Riskline is the report module: programmed travel-risk writing, not a 24/7 center. Everbridge is the notification module: reaching everyone, not watching a strait. Samdesk and Factal are verification modules for breaking social signals. They show up in the same security stack, so they show up here. Ranking them as assistance substitutes would be as wrong as ranking World Monitor as an evacuation substitute.',
    ],
    competitorProfiles: [
      {
        name: 'Crisis24',
        paragraphs: [
          'Crisis24 sells travel risk alerts plus assistance coordination: traveler tracking, duty-of-care workflows, a 24/7 analyst desk. Pricing is undisclosed and enterprise-negotiated. It is a response product with an intelligence feed attached, not a public dashboard.',
          'Pick Crisis24 when you need someone to coordinate the human. Do not pick World Monitor as a Crisis24 replacement. The page\'s first FAQ says so because that is the dangerous confusion: a map that cannot dispatch is not cheaper assistance, it is a missing phone tree.',
        ],
      },
      {
        name: 'International SOS',
        paragraphs: [
          'International SOS is assistance delivery: 27 assistance centers, medical evacuation, case response. Pricing undisclosed. There is no public canvas. The cell they win is the one that matters when a person is in trouble.',
          'Pick International SOS to evacuate and treat. World Monitor cannot act on what it detects, and the lede on this page is written to make that impossible to miss.',
        ],
      },
      {
        name: 'Riskline',
        paragraphs: [
          'Riskline sells travel risk reports for travel programs. Analyst-authored, periodic, enterprise-negotiated, MCP unverified. It is a report product, not a 24/7 assistance center and not a live multi-domain map.',
          'Pick Riskline for programmed travel reports. Pick an assistance vendor for response. Pick World Monitor for always-on public-source context.',
        ],
      },
      {
        name: 'Everbridge',
        paragraphs: [
          'Everbridge is mass notification and critical event management for enterprises. Pricing undisclosed. The job is to reach everyone, not to watch a strait.',
          'Pick Everbridge to send the message. It does not replace intelligence or medical evacuation, and this page will not rank it as if it did.',
        ],
      },
      {
        name: 'Samdesk',
        paragraphs: [
          'Samdesk detects breaking events from social and public signals for newsrooms and security desks. Subscription pricing, not published as a simple list we can cite as a catalog SKU. Dedicated social-signal detection is the cell.',
          'Pick Samdesk for that desk. It is not assistance and not a fused AIS-plus-aviation travel canvas.',
        ],
      },
      {
        name: 'Factal',
        paragraphs: [
          'Factal is journalist-verified breaking news from social signals. Subscription, verification archive, a newsroom product. The win is verification labor, not evacuation.',
          'Pick Factal to verify a clip. Pick International SOS to move a person. Pick World Monitor to watch public domains continuously.',
        ],
      },
    ],
    evaluationHeading: 'What to look for in travel risk intelligence versus assistance',
    evaluationProse: [
      'Draw the line on a whiteboard: awareness versus response. Awareness is continuous monitoring of conflict, aviation, maritime, and market signals that affect travelers. Response is assistance centers, evacuation, medical casework, mass notification, and traveler tracking. If a vendor sells both, score the modules separately. If a vendor sells one, do not let a demo imply the other.',
      'For assistance, score centers, medical capability, who is on the phone, and contractual duty-of-care. Price will be undisclosed; do not invent one. For intelligence, score cadence, domains, whether the canvas is public, API, and whether the product claims to act. A feed that cannot act should say so in the first paragraph, not in a footnote.',
      'Then score coverage versus enrollment. Assistance retainers often cover enrolled travelers. An always-on public watch covers the world and lets the whole organization look, including people who are not on the trip roster. That is not better than evacuation. It is a different layer that assistance programs usually lack.',
      'Ask who is on the hook when the information is wrong. Assistance vendors sell a phone tree and a contractual duty. Intelligence vendors sell a feed. If the feed is wrong, you still have the phone tree — if you bought one. If you only bought the feed, you have a correction, not a rescue. That is why this page refuses to rank World Monitor against International SOS on a single "travel risk" trophy. The trophy is two trophies.',
    ],
    switchHeading: 'Why teams look for travel-risk alternatives',
    switchProse: [
      'They are usually over-indexed on response and under-indexed on awareness, or the reverse. A company with a strong International SOS retainer still gets surprised by an airspace closure they would have seen on a public map. A company with a lot of dashboards still cannot evacuate. The search query mixes "Crisis24 alternative" with "travel risk intelligence" because procurement language does not keep the line.',
      'Cost opacity is the other trigger. Assistance retainers are negotiated. Teams look for something they can actually price. A free awareness layer is a reasonable add. It is not a reasonable replacement. This page is written to make the replacement path fail.',
    ],
    methodologyProse: methodology(
      'International SOS\'s 27 assistance centers figure is from public company materials. Crisis24, Everbridge, Riskline, Samdesk, and Factal prices are undisclosed or not published as a catalog SKU we can cite. World Monitor has zero assistance centers; that is a product fact, not a concession we had to research.',
    ),
    usageHeading: 'How to use this travel-risk comparison',
    usageProse: [
      'Split the budget line before you split the vendor list. One line is assistance: who comes, who evacuates, who calls the hospital. That line is International SOS and Crisis24, and it will be a negotiated retainer. The other line is awareness: who sees the airspace, the strait, and the conflict pin before the traveler is enrolled in a case. That line can be a public canvas. Mixing the lines is how a free map gets asked to do medical evacuation, and how an assistance company gets asked to be a live AIS product.',
      'If you already have assistance, do not put this page in a replacement RFP. Put it in an awareness RFP. If you have neither, buy assistance first. A map without a phone tree is not a travel-risk program. World Monitor will still be here after the retainer is signed, which is the only order that does not get someone hurt. Everbridge, Samdesk, and Factal are additional modules — notification and verification — not substitutes for either line.',
      'Enrollment is the quiet requirement. Assistance retainers cover people who are in the system. A public awareness canvas covers the country, the airspace, and the strait whether or not a given employee is enrolled today. That is why awareness is priced to the organization (or free to look at) rather than to a headcount of travelers. It is also why awareness cannot replace enrollment: the unenrolled person is visible on a map and still has no one to call. Write both requirements. Score vendors on the line they bid, not on the line the demo implied.',
    ],
    whyWeWinBody: [
      'World Monitor is the always-on awareness feed: conflict, aviation, maritime, and market signals that affect travelers, free to look at, priced as Pro or API if you need programmatic access for the whole organization rather than only enrolled travelers. It sits beside an assistance retainer. It does not become one.',
      'International SOS still wins evacuation. Crisis24 still wins duty-of-care coordination. Everbridge still wins mass notification. Samdesk and Factal still win social-signal verification. If a sentence on this page ever sounded like we could replace those cells, it would be a defect. The win is the layer they do not sell.',
      'Price transparency is the secondary win, not the primary one. Assistance retainers are undisclosed because that is how those vendors sell. World Monitor publishes $0 / $39.99 / $99.99 because that is how a public awareness layer should sell. Do not use our catalog to "save money" by cancelling evacuation. Use it to give the whole organization a canvas while the retainer covers the people who need a phone tree. That stack is the recommendation. If finance asks which vendor to cut, cut a duplicate awareness feed, not the assistance center.',
    ],
    extraFaqs: [
      ['How many assistance centers does World Monitor run?', 'Zero. International SOS publishes 27. This is not a close comparison on response, and it is not trying to be.'],
      ['Can World Monitor evacuate a traveler?', 'No.'],
      ['Should I cancel Crisis24 if I use World Monitor?', 'No. Keep assistance. Add awareness if you need it. Cancelling response because a map is free is the failure this page is here to prevent.'],
      ['Is travel risk intelligence the same as duty of care?', 'No. Intelligence watches. Duty of care includes the obligation and the machinery to act. Score them apart.'],
      ['Does World Monitor track individual travelers?', 'No. Crisis24-style traveler tracking is an assistance-coordination cell, not a public map cell.'],
      ['Why are Samdesk and Factal on a travel page?', 'Because breaking-event verification shows up in the same security stack. They win verification, not evacuation and not fused travel-aware monitoring.'],
      ['What does travel-aware country risk mean here?', 'Country and domain signals (conflict, aviation, maritime, markets) that affect travel decisions, on a public canvas. It is not a medical-assistance product.'],
      ['How should procurement write the RFP?', 'Two lines: one for assistance delivery, one for awareness. Vendors that blur the line should be asked which module they are bidding. World Monitor bids awareness only.'],
    ],
  },
};
