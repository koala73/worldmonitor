/**
 * Glossary of global-intelligence / OSINT terms rendered as crawlable
 * DefinedTerm pages under /blog/glossary (#4960 — content corpus).
 *
 * Every definition is sourced from WorldMonitor's own methodology docs or
 * product surfaces — do NOT invent capabilities here. In particular, no term
 * may claim forecast calibration / Brier scoring, which does not exist yet
 * (see issue #4930). This file is pure TypeScript (no `astro:` imports) so the
 * main test suite can import and validate it via tsx.
 */

export interface GlossaryLink {
  label: string;
  href: string;
}

export const GLOSSARY_CATEGORIES = [
  'Scoring & Indices',
  'Signals & Detection',
  'Maritime & Chokepoints',
  'OSINT & Methodology',
] as const;

export type GlossaryCategory = (typeof GLOSSARY_CATEGORIES)[number];

export interface GlossaryTerm {
  /** URL slug under /blog/glossary/<slug>. */
  slug: string;
  /** Full display term. */
  term: string;
  /** Abbreviation, if the term is commonly cited by acronym. */
  abbr?: string;
  /** Grouping key — one of GLOSSARY_CATEGORIES (compile-time checked). */
  category: GlossaryCategory;
  /**
   * One-sentence definition. Used verbatim as the DefinedTerm `description`,
   * the list-page blurb, and the meta description — so it must read as a
   * complete, standalone answer ("X is …").
   */
  short: string;
  /** Body paragraphs. First paragraph should restate the crisp definition. */
  body: string[];
  /** Slugs of related terms (must resolve to another entry). */
  related: string[];
  /** Authoritative "learn more" pointers (methodology docs, dashboard, blog). */
  learnMore?: GlossaryLink[];
}

export const GLOSSARY_TERMS: GlossaryTerm[] = [
  // ── Scoring & Indices ─────────────────────────────────────────────
  {
    slug: 'country-instability-index',
    term: 'Country Instability Index',
    abbr: 'CII',
    category: 'Scoring & Indices',
    short:
      'The Country Instability Index (CII) is a high-frequency instability score that WorldMonitor maintains for 31 Tier-1 countries by blending an editorial baseline with live event pressure.',
    body: [
      'The Country Instability Index (CII) is a high-frequency instability score that WorldMonitor maintains for the 31 Tier-1 countries tracked by its Strategic Risk system. Rather than relying on static ratings, CII blends a curated editorial baseline with live event pressure — unrest, conflict, security, and information signals — and publishes a signed 24-hour movement delta so operators can see which direction a country is moving.',
      'Tier-1 membership is curated rather than algorithmic: a country is included when it has sustained global-risk relevance, active or recent armed conflict, severe domestic instability, or high regional escalation potential. The score is computed server-side and exposed through the GetRiskScores RPC and the get_country_risk MCP tool.',
    ],
    related: ['country-resilience-index', 'strategic-risk', 'focal-point-detection'],
    learnMore: [
      { label: 'CII methodology', href: 'https://www.worldmonitor.app/docs/country-instability-index' },
      { label: 'CII methodology explainer (blog)', href: 'https://www.worldmonitor.app/blog/posts/country-instability-index-methodology-explained/' },
    ],
  },
  {
    slug: 'country-resilience-index',
    term: 'Country Resilience Index',
    abbr: 'CRI',
    category: 'Scoring & Indices',
    short:
      'The Country Resilience Index (CRI) is a composite 0–100 score of a country’s structural ability to absorb and recover from shocks, refreshed every six hours across six weighted domains and 20 active dimensions for a fixed 196-country rankable universe.',
    body: [
      'The Country Resilience Index (CRI) is a composite 0–100 score of a country’s structural ability to absorb and recover from shocks. Where the CII measures short-term instability, the CRI measures durable capacity — economic, infrastructure, energy, social-governance, health-and-food, and recovery strength — refreshed every six hours from official sources with full coverage and imputation provenance.',
      'The six domains carry design weights — economic 0.17, infrastructure 0.15, energy 0.11, social-governance 0.19, health-food 0.13, recovery 0.25 (sum 1.00) — and are regrouped into three pillars (structural readiness, live-shock exposure, recovery capacity) that combine into the headline score through a non-compensatory formula with a min-pillar penalty. Recovery carries the largest single-domain weight, which is the mechanical reason fiscally strong smaller states cluster near the top while fragile states separate cleanly at the bottom.',
      'CRI covers a fixed 196-country public rankable universe (a committed UN-member and SAR whitelist); low-confidence or headline-ineligible countries are routed to a separate greyed-out list rather than dropped, and every response exposes per-dimension coverage plus a four-class imputation taxonomy so an analyst can see how much of a score is real data. Scores are served through the get-resilience-score and get-resilience-ranking endpoints and the get_country_risk MCP tool.',
    ],
    related: ['country-instability-index', 'dimension-coverage', 'strategic-risk'],
    learnMore: [
      { label: 'CRI methodology (full reference)', href: 'https://www.worldmonitor.app/docs/methodology/country-resilience-index' },
      { label: 'CRI methodology explainer (blog)', href: 'https://www.worldmonitor.app/blog/posts/country-resilience-index-methodology-explained/' },
    ],
  },
  {
    slug: 'strategic-risk',
    term: 'Strategic Risk',
    category: 'Scoring & Indices',
    short:
      'Strategic Risk is WorldMonitor’s composite triage layer that synthesizes instability, convergence, infrastructure, theater posture, sanctions, and breaking-news signals into a single headline risk read.',
    body: [
      'Strategic Risk is WorldMonitor’s composite triage layer for global risk. Its server-published headline score is a top-five Country Instability Index roll-up, around which the panel layers additional convergence, infrastructure cascade, theater posture, breaking-news, sanctions, and radiation-watch context.',
      'The purpose is fast triage: rather than reading each intelligence module separately, an operator sees one fused assessment that flags where multiple independent signals are pointing at the same place at the same time.',
    ],
    related: ['country-instability-index', 'geographic-convergence', 'infrastructure-cascade', 'pentagon-pizza-index'],
    learnMore: [
      { label: 'Strategic Risk methodology', href: 'https://www.worldmonitor.app/docs/strategic-risk' },
    ],
  },
  {
    slug: 'dimension-coverage',
    term: 'Dimension Coverage',
    category: 'Scoring & Indices',
    short:
      'Dimension coverage is the share of a country’s resilience dimensions backed by real observed data rather than imputed — the mean of the 20 active per-dimension coverage values, used to gauge how much of a CRI score is real.',
    body: [
      'Dimension coverage is the share of a country’s resilience dimensions that are backed by real observed data rather than imputed, reported as the mean of the 20 active per-dimension coverage values (structurally-retired dimensions are excluded from the average). It is deliberately labelled "dimension coverage" rather than "data coverage" to be precise about what is measured.',
      'Coverage drives a confidence gate: when a country’s average dimension coverage falls below 0.55 — or too much of its score is imputed — the Country Resilience Index marks that score low-confidence, and countries that also fail the headline-eligibility thresholds are routed to a separate greyed-out list rather than the public ranking. Thin-data countries are never presented as if they were confidently scored.',
    ],
    related: ['country-resilience-index'],
    learnMore: [
      { label: 'CRI methodology (coverage & imputation)', href: 'https://www.worldmonitor.app/docs/methodology/country-resilience-index' },
    ],
  },
  {
    slug: 'pentagon-pizza-index',
    term: 'Pentagon Pizza Index',
    category: 'Scoring & Indices',
    short:
      'The Pentagon Pizza Index is an open-source-intelligence activity proxy that watches late-night demand signals near key government facilities as a rough tell for unusual operational tempo.',
    body: [
      'The Pentagon Pizza Index is an open-source-intelligence activity proxy — a light-hearted but long-observed heuristic that unusual late-night food-delivery demand near defense and government facilities can correlate with elevated operational tempo before any official signal appears.',
      'In WorldMonitor it is one of several ambient indicators fused into the Strategic Risk context rather than a standalone forecast. It illustrates the platform’s broader thesis: correlating many weak, independent signals surfaces convergence earlier than any single authoritative source.',
    ],
    related: ['strategic-risk', 'osint'],
  },

  // ── Signals & Detection ───────────────────────────────────────────
  {
    slug: 'focal-point-detection',
    term: 'Focal Point Detection',
    category: 'Signals & Detection',
    short:
      'Focal point detection is the synthesis layer that correlates news entities with live map signals to identify the "main characters" — the people, places, and organizations driving current events.',
    body: [
      'Focal point detection is WorldMonitor’s intelligence-synthesis layer. A focal point is an entity — a person, place, or organization — that appears in both news coverage and map signals at the same time. Surfacing those overlaps identifies the "main characters" driving the current situation.',
      'The detector enriches AI analysis with this cross-referenced context, so a generated brief reasons about entities that are simultaneously in the headlines and on the map, rather than treating text and geospatial signals as separate worlds.',
    ],
    related: ['geographic-convergence', 'world-brief', 'threat-classification'],
    learnMore: [
      { label: 'AI intelligence methodology', href: 'https://www.worldmonitor.app/docs/ai-intelligence' },
    ],
  },
  {
    slug: 'geographic-convergence',
    term: 'Geographic Convergence',
    category: 'Signals & Detection',
    short:
      'Geographic convergence is when three or more distinct event types co-occur inside the same one-degree map cell within 24 hours, which fires a convergence alert flagging an area where separate signals are stacking up.',
    body: [
      'Geographic convergence detection bins events — protests, military flights, vessels, earthquakes, and more — into 1°×1° geographic cells over a rolling 24-hour window. When three or more distinct event types converge in a single cell, a convergence alert fires.',
      'Alert severity is driven by type diversity (about 25 points per unique event type) plus event-count bonuses (capped at 25). Four converging types, or a score of 90 or above, is treated as critical; three-type alerts below 90 are high priority. Each alert is reverse-geocoded to a human-readable place name using conflict-zone, waterway, and hotspot databases.',
    ],
    related: ['focal-point-detection', 'infrastructure-cascade', 'strategic-risk', 'hotspot'],
  },
  {
    slug: 'infrastructure-cascade',
    term: 'Infrastructure Cascade',
    category: 'Signals & Detection',
    short:
      'An infrastructure cascade is a modeled chain reaction in which the disruption of one critical node — a cable, pipeline, port, or chokepoint — propagates through its dependency graph to threaten downstream systems.',
    body: [
      'An infrastructure cascade is a chain reaction across dependent critical systems. WorldMonitor models the dependency graph linking cables, pipelines, ports, and chokepoints so that damage or disruption at one node can be traced to the downstream nodes it puts at risk.',
      'Cascade incidents feed the Strategic Risk score and the alert-fusion pipeline: cascade alerts are merged with convergence alerts, CII spikes, sanctions pressure, and radiation watch when they occur close together in time and space, so a single fused alert captures a multi-domain event.',
    ],
    related: ['geographic-convergence', 'strategic-risk', 'maritime-chokepoint'],
    learnMore: [
      { label: 'Infrastructure cascade methodology', href: 'https://www.worldmonitor.app/docs/infrastructure-cascade' },
    ],
  },
  {
    slug: 'hotspot',
    term: 'Hotspot',
    category: 'Signals & Detection',
    short:
      'A hotspot is a watched location whose displayed activity level is computed in real time from news correlation, rather than being a fixed, static threat rating.',
    body: [
      'A hotspot is a location WorldMonitor watches continuously. Crucially, a hotspot’s activity level is not a static threat rating — it is calculated in real time based on how strongly current news correlates with the keywords that define that location.',
      'This keeps the map honest: a normally quiet location lights up only when live coverage says something is actually happening there, and a chronically tense location can read as calm during a genuine lull.',
    ],
    related: ['geographic-convergence', 'focal-point-detection'],
    learnMore: [
      { label: 'Hotspots methodology', href: 'https://www.worldmonitor.app/docs/hotspots' },
    ],
  },
  {
    slug: 'threat-classification',
    term: 'Threat Classification',
    category: 'Signals & Detection',
    short:
      'Threat classification is the hybrid AI step that labels incoming events by type and severity, combining fast rule-based tagging with model-based analysis to keep the live feed structured.',
    body: [
      'Threat classification is the step that turns raw incoming events into a structured, labelled feed. WorldMonitor uses a hybrid approach: fast rule-based tagging handles the common, unambiguous cases, while model-based classification handles nuance and ambiguity.',
      'Consistent type and severity labels are what make downstream correlation possible — convergence detection, focal-point synthesis, and Strategic Risk all depend on events already being classified into comparable categories.',
    ],
    related: ['focal-point-detection', 'world-brief'],
  },

  // ── Maritime & Chokepoints ────────────────────────────────────────
  {
    slug: 'maritime-chokepoint',
    term: 'Maritime Chokepoint',
    category: 'Maritime & Chokepoints',
    short:
      'A maritime chokepoint is a narrow passage through which a large share of global trade, energy, food, or military movement must pass, so a disruption there removes optionality from the whole system.',
    body: [
      'A maritime chokepoint is a narrow passage where a large share of global trade, energy, food, or military movement must pass through a small physical space. If ships can choose among several similar routes, a disruption is manageable; when many routes collapse into one narrow passage, the same disruption can become systemic.',
      'The essential idea is that a chokepoint is where geography removes optionality — the risk is not just today’s traffic, but how little room the system has when that traffic changes. WorldMonitor tracks 13 waterways, of which seven currently publish live flow estimates.',
    ],
    related: ['strait-of-hormuz', 'strait-of-malacca', 'suez-canal', 'ais', 'chokepoint-congestion'],
    learnMore: [
      { label: 'What is a maritime chokepoint? (blog)', href: 'https://www.worldmonitor.app/blog/posts/what-is-a-maritime-chokepoint/' },
      { label: 'Maritime intelligence methodology', href: 'https://www.worldmonitor.app/docs/maritime-intelligence' },
    ],
  },
  {
    slug: 'strait-of-hormuz',
    term: 'Strait of Hormuz',
    category: 'Maritime & Chokepoints',
    short:
      'The Strait of Hormuz is the maritime chokepoint between the Persian Gulf and the Gulf of Oman through which a large share of the world’s seaborne crude oil and LNG must transit.',
    body: [
      'The Strait of Hormuz is the narrow waterway connecting the Persian Gulf to the Gulf of Oman and the open ocean. It is the single most closely watched energy chokepoint on Earth because a very large share of seaborne crude oil and liquefied natural gas has no alternative route out of the Gulf.',
      'In WorldMonitor, Hormuz is one of the chokepoints with live flow estimates: vessel activity, congestion, and disruption signals are correlated against energy markets so an operator can see whether a Gulf tension event has a plausible transmission path into oil and gas prices.',
    ],
    related: ['maritime-chokepoint', 'ais', 'chokepoint-congestion'],
    learnMore: [
      { label: 'Energy shock monitoring (blog)', href: 'https://www.worldmonitor.app/blog/posts/energy-shock-monitoring-chokepoints-worldmonitor/' },
    ],
  },
  {
    slug: 'strait-of-malacca',
    term: 'Strait of Malacca',
    category: 'Maritime & Chokepoints',
    short:
      'The Strait of Malacca is the primary shipping lane between the Indian and Pacific Oceans, carrying a large share of container traffic and energy imports bound for East Asia.',
    body: [
      'The Strait of Malacca runs between the Malay Peninsula and Sumatra, linking the Indian Ocean to the South China Sea and the Pacific. It is one of the busiest shipping lanes in the world and the main artery for energy and container flows into East Asia.',
      'Its width and traffic density make it a textbook chokepoint: alternative routes exist but are longer and lower-capacity, so congestion or disruption in Malacca reverberates through Asian supply chains and freight costs.',
    ],
    related: ['maritime-chokepoint', 'suez-canal', 'ais'],
  },
  {
    slug: 'suez-canal',
    term: 'Suez Canal',
    category: 'Maritime & Chokepoints',
    short:
      'The Suez Canal is the artificial waterway linking the Mediterranean and the Red Sea that lets shipping move between Europe and Asia without rounding Africa.',
    body: [
      'The Suez Canal connects the Mediterranean Sea to the Red Sea, providing the shortest maritime route between Europe and Asia and removing the need to sail around the Cape of Good Hope. Its southern approach runs through the Bab-el-Mandeb strait, so instability in the Red Sea affects both.',
      'As a chokepoint, Suez concentrates a large share of Europe–Asia trade into a single canal; a blockage or a security threat that reroutes traffic around Africa adds days of transit and materially raises freight costs, which WorldMonitor tracks alongside the physical disruption signals.',
    ],
    related: ['maritime-chokepoint', 'strait-of-malacca', 'chokepoint-congestion'],
    learnMore: [
      { label: 'Tracking global trade routes (blog)', href: 'https://www.worldmonitor.app/blog/posts/tracking-global-trade-routes-chokepoints-freight-costs/' },
    ],
  },
  {
    slug: 'ais',
    term: 'Automatic Identification System',
    abbr: 'AIS',
    category: 'Maritime & Chokepoints',
    short:
      'AIS (Automatic Identification System) is the transponder standard that broadcasts a ship’s identity, position, and course, and is the primary data source for tracking vessel traffic through chokepoints.',
    body: [
      'The Automatic Identification System (AIS) is a maritime transponder standard that continuously broadcasts a vessel’s identity, position, speed, and course. It exists for collision avoidance, but it also makes near-real-time ship tracking possible for anyone receiving the signals.',
      'WorldMonitor uses AIS positions to watch tanker and cargo movement inside chokepoint bounding boxes, detect congestion, and flag disruptions such as coverage gaps. Because AIS can be switched off or spoofed, sudden gaps are themselves treated as a signal worth surfacing.',
    ],
    related: ['maritime-chokepoint', 'chokepoint-congestion', 'strait-of-hormuz'],
  },
  {
    slug: 'chokepoint-congestion',
    term: 'Chokepoint Congestion',
    category: 'Maritime & Chokepoints',
    short:
      'Chokepoint congestion is an above-normal build-up of vessel traffic waiting to transit a strait or canal, detected from AIS activity and used as an early sign of disruption.',
    body: [
      'Chokepoint congestion is an above-baseline accumulation of ships waiting to transit a strait or canal. WorldMonitor detects it from AIS activity inside each chokepoint’s bounding box and treats a congestion spike as one of its AIS disruption types.',
      'Congestion is an early-warning signal: queues often build before a disruption becomes headline news, so a rising congestion reading at Hormuz, Suez, or Malacca can precede the trade and energy-price effects that follow.',
    ],
    related: ['maritime-chokepoint', 'ais', 'strait-of-hormuz'],
  },

  // ── OSINT & Methodology ───────────────────────────────────────────
  {
    slug: 'osint',
    term: 'Open-Source Intelligence',
    abbr: 'OSINT',
    category: 'OSINT & Methodology',
    short:
      'Open-source intelligence (OSINT) is intelligence produced from publicly available sources — news, social media, satellite imagery, transponder feeds, and public records — rather than from classified collection.',
    body: [
      'Open-source intelligence (OSINT) is intelligence derived entirely from publicly available information: news reporting, social media, satellite and aerial imagery, ship and aircraft transponders, and public records. Its power comes not from secrecy but from correlation — combining many open signals into a picture no single source shows.',
      'WorldMonitor is an OSINT platform by construction: every layer is sourced from public feeds with documented provenance, which is what lets it publish source-attributed briefs and scores that a reader can trace back to the underlying evidence.',
    ],
    related: ['provenance', 'world-brief', 'focal-point-detection'],
    learnMore: [
      { label: 'OSINT for everyone (blog)', href: 'https://www.worldmonitor.app/blog/posts/osint-for-everyone-open-source-intelligence-democratized/' },
    ],
  },
  {
    slug: 'provenance',
    term: 'Provenance & Source Attribution',
    category: 'OSINT & Methodology',
    short:
      'Provenance is the documented chain from a published score or brief back to the specific public sources it was built from, so any claim can be traced to its underlying evidence.',
    body: [
      'Provenance, or source attribution, is the discipline of keeping a documented chain from every published output back to the specific public sources behind it. For an OSINT product it is the difference between an assertion and a citation.',
      'WorldMonitor carries provenance through its briefs, scores, and cached operational data with documented methodology, so a reader — or an AI agent consuming the API — can see not just what the platform concluded but which sources support it.',
    ],
    related: ['osint', 'world-brief'],
  },
  {
    slug: 'world-brief',
    term: 'World Brief',
    category: 'OSINT & Methodology',
    short:
      'The World Brief is WorldMonitor’s AI-generated, source-attributed summary of the current global situation, synthesized from correlated live signals rather than a single news feed.',
    body: [
      'The World Brief is a source-attributed situational summary generated from WorldMonitor’s correlated live signals — news, map events, focal points, and classified threats. It answers "what is happening right now, globally" in a form an operator or an agent can consume directly.',
      'It is available through the get_world_brief MCP tool and the dashboard, and it draws on the same focal-point and classification layers that power the map, so the narrative and the geospatial view stay consistent.',
    ],
    related: ['focal-point-detection', 'threat-classification', 'provenance', 'osint'],
  },
  {
    slug: 'prediction-market',
    term: 'Prediction Market',
    category: 'OSINT & Methodology',
    short:
      'A prediction market is a marketplace where participants trade contracts on the outcome of future events, and the market price acts as a crowd-sourced probability estimate.',
    body: [
      'A prediction market is a marketplace in which participants buy and sell contracts tied to the outcome of a future event. Because a contract pays out based on what actually happens, its trading price behaves as a continuously updated, crowd-sourced probability for that outcome.',
      'WorldMonitor surfaces prediction-market context — for example via the get_prediction_markets tool — as an external probability signal to sit alongside its own scenario forecasts, giving a market-implied read on geopolitical questions next to the platform’s analysis.',
    ],
    related: ['world-brief', 'strategic-risk'],
    learnMore: [
      { label: 'Prediction markets & AI forecasting (blog)', href: 'https://www.worldmonitor.app/blog/posts/prediction-markets-ai-forecasting-geopolitics/' },
    ],
  },
];
