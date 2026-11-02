import type { Feed } from '@/types';
import { SITE_VARIANT } from './variant';
import { rssProxyUrl } from '@/utils';
import { mergeCanonicalFeeds } from './feed-resolution';
import {
  browserCategoryFeeds,
  browserIntelSources,
  digestEditionsForCategory,
  type BrowserCatalogFeed,
} from '../../shared/news-catalog-browser';
import { BROWSER_NEWS_CATALOG as BROWSER_CATALOG } from './news-catalog.browser.generated';
import {
  getSourceProvenanceState,
  type SourceProvenanceState,
} from '../../shared/source-provenance';

// Feeds are declared once in shared/news-catalog.json; these maps are its
// browser view, built from the generated browser slice so the bundle carries
// no server-only fields. Absolute URLs go through the RSS proxy; same-origin
// API routes (e.g. /api/miit-news) are fetched as-is.
const proxyCatalogUrl = (url: string): string => (/^https?:\/\//.test(url) ? rssProxyUrl(url) : url);

function proxied(feed: BrowserCatalogFeed): Feed {
  const url = typeof feed.url === 'string'
    ? proxyCatalogUrl(feed.url)
    : Object.fromEntries(Object.entries(feed.url).map(([lang, href]) => [lang, proxyCatalogUrl(href)]));
  return { ...feed, url };
}

/** Editions whose server digest carries `category` (for cross-edition panels). */
export function digestEditionsFor(category: string): string[] {
  return digestEditionsForCategory(BROWSER_CATALOG, category);
}

function browserFeeds(edition: string): Record<string, Feed[]> {
  return Object.fromEntries(
    Object.entries(browserCategoryFeeds(BROWSER_CATALOG, edition)).map(([category, feeds]) => [category, feeds.map(proxied)]),
  );
}

// Source tier system — canonical definition lives in server/_shared/source-tiers.ts
// so server-side code can import it without pulling in client-only modules.
export { SOURCE_TIERS, declaredSourceTier, getSourceTier } from '../../server/_shared/source-tiers';
export {
  PERSPECTIVE_LABEL_CAVEAT,
  SOURCE_PROPAGANDA_RISK,
  SOURCE_TYPES,
  UNREVIEWED_SOURCE_RISK,
  composeProvenanceSummary,
  describePropagandaBadge,
  getProvenanceFacts,
  getSourcePropagandaRisk,
  getSourceProvenanceState,
  getSourceTierBadgeTitle,
  getSourceType,
  hasDeclaredPropagandaRisk,
  hasDeclaredSourceType,
  hasReviewedPropagandaRisk,
  hasReviewedSourceType,
  isStateAffiliatedSource,
} from '../../shared/source-provenance';
export {
  resolveRegisteredTelegramSourceName,
  resolveTelegramSourceName,
} from '../../shared/telegram-channel-trust';
export { computeCredibilityScore } from '../../shared/news-credibility.js';
export type {
  PropagandaRisk,
  ProvenanceFact,
  SourceProvenanceState,
  SourceRiskProfile,
  SourceType,
} from '../../shared/source-provenance';

let _sourcePanelMap: Map<string, string> | null = null;
export function getSourcePanelId(sourceName: string): string {
  if (!_sourcePanelMap) {
    _sourcePanelMap = new Map();
    // Seed with CANONICAL_FEEDS first so a source belonging to a cross-variant
    // custom panel still resolves to its real panel. The active-variant FEEDS
    // pass below then overwrites, so the active preset wins any collision.
    for (const [category, feeds] of Object.entries(CANONICAL_FEEDS)) {
      for (const feed of feeds) _sourcePanelMap.set(feed.name, category);
    }
    for (const [category, feeds] of Object.entries(FEEDS)) {
      for (const feed of feeds) _sourcePanelMap.set(feed.name, category);
    }
    for (const feed of INTEL_SOURCES) _sourcePanelMap.set(feed.name, 'intel');
  }
  return _sourcePanelMap.get(sourceName) ?? 'politics';
}

// Exported for the geographic coverage audit (scripts/geo-coverage-health.mjs,
// #5957) — the full-variant news catalog is the reference set the audit counts.
export const FULL_FEEDS: Record<string, Feed[]> = browserFeeds('full');

// Tech/AI variant feeds
const TECH_FEEDS: Record<string, Feed[]> = browserFeeds('tech');

// Finance/Trading variant feeds (all free RSS / Google News proxies)
const FINANCE_FEEDS: Record<string, Feed[]> = browserFeeds('finance');

const HAPPY_FEEDS: Record<string, Feed[]> = browserFeeds('happy');

// Commodity variant feeds (from commodity.ts)
const COMMODITY_FEEDS: Record<string, Feed[]> = browserFeeds('commodity');

// Energy variant feeds — energy.worldmonitor.app
// Keys are matched against panel IDs in src/config/panels.ts ENERGY_PANELS +
// brief news-category overrides in src/app/data-loader.ts. Keep in sync when
// ENERGY_PANELS changes.
const ENERGY_FEEDS: Record<string, Feed[]> = browserFeeds('energy');

// Variant-aware exports
export const FEEDS = SITE_VARIANT === 'tech'
  ? TECH_FEEDS
  : SITE_VARIANT === 'finance'
    ? FINANCE_FEEDS
    : SITE_VARIANT === 'happy'
      ? HAPPY_FEEDS
      : SITE_VARIANT === 'commodity'
        ? COMMODITY_FEEDS
        : SITE_VARIANT === 'energy'
          ? ENERGY_FEEDS
          : FULL_FEEDS;

// Canonical category→feeds map: the union of every variant's feed set.
// `FEEDS` (above) is just the active variant's PRESET; users freely customize
// their panel set, so any enabled news panel must be able to resolve its feeds
// regardless of which variant it "belongs" to. Consumers:
//  • data-loader `loadNews()` — loads preset categories + custom enabled panels
//  • panel-layout — creates a NewsPanel for any enabled category, not just preset
// See src/config/feed-resolution.ts for the merge + resolution helpers.
// On-demand categories are in the canonical registry so an enabled matching
// panel can resolve feeds, but they are NOT part of any variant FEEDS preset.
export const ON_DEMAND_FEEDS: Record<string, Feed[]> = browserFeeds('ondemand');

export const CANONICAL_FEEDS: Record<string, Feed[]> = mergeCanonicalFeeds([
  FULL_FEEDS,
  TECH_FEEDS,
  FINANCE_FEEDS,
  COMMODITY_FEEDS,
  ENERGY_FEEDS,
  HAPPY_FEEDS,
  ON_DEMAND_FEEDS,
]);

export const SOURCE_REGION_MAP: Record<string, { labelKey: string; feedKeys: string[] }> = {
  // Full (geopolitical) variant regions
  worldwide: { labelKey: 'header.sourceRegionWorldwide', feedKeys: ['politics', 'crisis'] },
  us: { labelKey: 'header.sourceRegionUS', feedKeys: ['us', 'gov'] },
  europe: { labelKey: 'header.sourceRegionEurope', feedKeys: ['europe'] },
  middleeast: { labelKey: 'header.sourceRegionMiddleEast', feedKeys: ['middleeast'] },
  africa: { labelKey: 'header.sourceRegionAfrica', feedKeys: ['africa'] },
  latam: { labelKey: 'header.sourceRegionLatAm', feedKeys: ['latam'] },
  asia: { labelKey: 'header.sourceRegionAsiaPacific', feedKeys: ['asia'] },
  topical: { labelKey: 'header.sourceRegionTopical', feedKeys: ['energy', 'tech', 'ai', 'finance', 'layoffs', 'thinktanks', 'science'] },
  intel: { labelKey: 'header.sourceRegionIntel', feedKeys: [] },

  // Tech variant regions
  techNews: { labelKey: 'header.sourceRegionTechNews', feedKeys: ['tech', 'hardware'] },
  aiMl: { labelKey: 'header.sourceRegionAiMl', feedKeys: ['ai'] },
  startupsVc: { labelKey: 'header.sourceRegionStartupsVc', feedKeys: ['startups', 'vcblogs', 'funding', 'unicorns', 'accelerators', 'ipo'] },
  regionalTech: { labelKey: 'header.sourceRegionRegionalTech', feedKeys: ['regionalStartups'] },
  developer: { labelKey: 'header.sourceRegionDeveloper', feedKeys: ['github', 'cloud', 'dev', 'producthunt', 'outages'] },
  cybersecurity: { labelKey: 'header.sourceRegionCybersecurity', feedKeys: ['security'] },
  techPolicy: { labelKey: 'header.sourceRegionTechPolicy', feedKeys: ['policy', 'thinktanks'] },
  techMedia: { labelKey: 'header.sourceRegionTechMedia', feedKeys: ['podcasts', 'layoffs', 'finance'] },

  // Finance variant regions
  marketsAnalysis: { labelKey: 'header.sourceRegionMarkets', feedKeys: ['markets', 'analysis', 'ipo'] },
  fixedIncomeFx: { labelKey: 'header.sourceRegionFixedIncomeFx', feedKeys: ['forex', 'bonds'] },
  commoditiesRegion: { labelKey: 'header.sourceRegionCommodities', feedKeys: ['commodities'] },
  cryptoDigital: { labelKey: 'header.sourceRegionCryptoDigital', feedKeys: ['crypto', 'fintech'] },
  centralBanksEcon: { labelKey: 'header.sourceRegionCentralBanks', feedKeys: ['centralbanks', 'economic'] },
  dealsCorpFin: { labelKey: 'header.sourceRegionDeals', feedKeys: ['institutional', 'derivatives'] },
  finRegulation: { labelKey: 'header.sourceRegionFinRegulation', feedKeys: ['fin-regulation'] },
  gulfMena: { labelKey: 'header.sourceRegionGulfMena', feedKeys: ['gccNews'] },
};

export const INTEL_SOURCES: Feed[] = browserIntelSources(BROWSER_CATALOG).map(proxied);

/** Unique configured feed names across every variant map + intel sources. */
export function listConfiguredFeedNames(): string[] {
  const names = new Set<string>();
  for (const feeds of Object.values(CANONICAL_FEEDS)) {
    for (const feed of feeds) names.add(feed.name);
  }
  for (const feed of INTEL_SOURCES) names.add(feed.name);
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Provenance state for a configured feed.
 * `reviewed` = present in SOURCE_PROPAGANDA_RISK (any risk including explicit low).
 * `unknown` = not yet reviewed — API still returns a definite profile via getSourcePropagandaRisk.
 */
export function getFeedProvenanceState(sourceName: string): SourceProvenanceState {
  return getSourceProvenanceState(sourceName);
}

/**
 * Ukraine-war frontline + UA/RU balance sources that free-tier source-cap
 * must not strip (#5949, #5950). Passed to `selectSourcesUnderCap` as
 * `protectedNames` so round-robin late-in-bucket ordering cannot drop the
 * dedicated UA primary / independent RU / PL frontline set for free EN users.
 * Keep in sync with DEFAULT_ENABLED_SOURCES.europe frontline additions and
 * the one-shot migration in App.ts (`worldmonitor-frontline-europe-enable-v1`).
 */
export const FRONTLINE_EUROPE_PROTECTED_SOURCES = [
  'Kyiv Independent',
  'TVN24',
  'Rzeczpospolita',
  'Meduza',
  'Moscow Times',
  'Ukrainska Pravda EN',
  'NV EN',
] as const;

const EASTERN_FLANK_EN_DEFAULT_SOURCES = [
  'Daily Sabah',
  'ERR News',
] as const;

const AFRICA_DEPTH_EN_DEFAULT_SOURCES = [
  'Hiiraan Online',
  'RFI Afrique',
] as const;

const CAUCASUS_EN_DEFAULT_SOURCES = [
  'Civil.ge',
  'OC Media',
] as const;

const CENTRAL_ASIA_EN_DEFAULT_SOURCES = [
  'Eurasianet',
  'The Astana Times',
] as const;

const INDO_PACIFIC_EN_DEFAULT_SOURCES = [
  'Focus Taiwan',
  'Dawn',
  'Rappler',
] as const;

/** Validated English crisis-floor defaults (#6813-#6828). */
export const CRISIS_FLOOR_EN_DEFAULT_SOURCES = [
  'Yemen Online',
  'Syria Direct',
  '+972 Magazine',
  'HaitiLibre English',
  'Amu TV',
  'Naharnet Lebanon',
  'Caracas Chronicles',
  'Havana Times',
  'Libya Herald',
  'Egypt Independent',
  'The Daily Star',
  'Daily Nation',
  'The Guardian Post',
] as const;

/** Non-English sources approved as global strategic floor defaults. */
export const CRISIS_FLOOR_STRATEGIC_DEFAULT_SOURCES = [
  'Annahar',
  'Studio Tamani',
  'leFaso.net',
  'ActuNiger',
] as const;

/** Validated depth, backup, and locale-primary sources that remain opt-in globally. */
export const CRISIS_FLOOR_OPT_IN_SOURCES = [
  "Sana'a Center",
  'Enab Baladi English',
  'WAFA English',
  'AyiboPost',
  'Pajhwok Afghan News',
  "L'Orient Today",
  'Aïr Info',
  'Efecto Cocuyo',
  '14ymedio',
  'Mada Masr',
  'Dhaka Tribune',
  'Tchadinfos',
  'Alwihda Info',
  'Radio Ndeke Luka',
] as const;

/** Complete selected crisis-desk pack used by migration and mapping checks. */
export const CRISIS_DESK_ROLLOUT_SOURCES = [
  ...CRISIS_FLOOR_EN_DEFAULT_SOURCES,
  ...CRISIS_FLOOR_STRATEGIC_DEFAULT_SOURCES,
  ...CRISIS_FLOOR_OPT_IN_SOURCES,
] as const;

/** Current editorial defaults introduced by the four regional feed PRs. */
export const REGIONAL_FEED_ROLLOUT_DEFAULT_SOURCES = [
  ...EASTERN_FLANK_EN_DEFAULT_SOURCES,
  ...CAUCASUS_EN_DEFAULT_SOURCES,
  ...CENTRAL_ASIA_EN_DEFAULT_SOURCES,
  ...INDO_PACIFIC_EN_DEFAULT_SOURCES,
  ...AFRICA_DEPTH_EN_DEFAULT_SOURCES,
] as const;

/**
 * Current opt-in sources introduced by the same rollout wave. Persisted
 * denylist profiles need these names inserted by the schema-5 migration;
 * otherwise a newly cataloged source is implicitly enabled for every returner.
 */
export const REGIONAL_FEED_ROLLOUT_OPT_IN_SOURCES = [
  'Seznam Zprávy', 'Digi24', 'HotNews', 'G4Media', 'Dnevnik',
  'LRT English', 'LSM English',
  'JAMnews', 'Azertag', 'Armenpress', 'Zerkalo', 'NewsMaker', 'Ziarul de Gardă',
  'Radio Tamazuj', 'The Reporter Ethiopia', 'Actualite.cd', 'Radio Okapi',
  'MyJoyOnline', 'Le Quotidien', 'RFE/RL Central Asia', 'The Times of Central Asia',
  'Taipei Times', 'Taiwan News', 'Geo News', 'Jakarta Post',
  'The Star (Malaysia)', 'Irrawaddy',
  'Ethiopia Insight', 'Dabanga Sudan', 'Citi Newsroom',
] as const;

/** Canada pack (#5960/#6604/#6605) — EN default-on for North America keyCountry CA.
 * CTV News GNews probe returned items, so floors.CA = 3: CBC + CTV + Toronto Star. */
export const CANADA_EN_DEFAULT_SOURCES = [
  'CBC News',
  'CTV News',
  'Toronto Star',
] as const;

/**
 * Catalog opt-in sources from the Canada + Arctic/Nordic pack (#5960).
 * Persisted denylist profiles must insert these on first boot after the pack
 * lands — otherwise newly cataloged names are implicitly enabled for every
 * returner (denylist semantics). CBC stays out so default-on can enable it.
 */
export const CANADA_ARCTIC_OPT_IN_SOURCES = [
  'Globe and Mail',
  'Global News',
  'Yle News',
  'NRK',
  'Aftenposten',
  'DR Nyheder',
  'Arctic Today',
] as const;

/**
 * Catalog opt-in sources from the Canada depth pack (#6604/#6605).
 * Globe/Global stay only in CANADA_ARCTIC_OPT_IN_SOURCES — do not duplicate.
 * Persisted denylist profiles must insert these on first boot after the pack
 * lands — otherwise newly cataloged names are implicitly enabled for every
 * returner. Toronto Star and CTV News stay out so default-on can enable them. National Post is opt-in.
 */
export const CANADA_DEPTH_OPT_IN_SOURCES = [
  'National Post',
  'Financial Post',
  'iPolitics',
  'The Narwhal',
  'The Tyee',
  'Radio-Canada',
  'La Presse',
  'Le Devoir',
  'TVA Nouvelles',
  'Vancouver Sun',
  'Calgary Herald',
  'Winnipeg Free Press',
  'Ottawa Citizen',
  'Edmonton Journal',
  "Maclean's",
  'The Province',
  'CP24',
  'Montreal Gazette',
] as const;

/** New regional desks remain opt-in for returning denylist profiles (#7748). */
export const CURATED_REGIONAL_OPT_IN_SOURCES = [
  'Guardian Africa',
  'France 24 Africa',
  'Guardian Caribbean',
  'Guardian Pacific',
  'France 24 Asia Pacific',
] as const;

/**
 * Major publishers Google News World leads with and no feed carried
 * (2026-10-16 audit). EN default-on; listed last in their categories and not
 * cap-protected, so the free-tier cap keeps every source it kept before.
 */
export const MAJOR_PUBLISHER_DEFAULT_SOURCES = [
  'New York Times World',
  'Washington Post World',
  'The Economist',
  'The Independent',
  'Sky News',
  'Times of Israel',
  'Middle East Eye',
  'Japan Times',
] as const;

/**
 * The BBC's UK desk (2026-10-17 audit), default-on in EN like the major
 * publishers above and, like them, listed last and not cap-protected.
 * BBC Northern Ireland is in the catalog but opt-in.
 */
export const BBC_UK_DEFAULT_SOURCES = ['BBC UK'] as const;

/**
 * The Science panel's sources (2026-10-17 audit). The panel is opt-in, but its
 * sources are EN default-on so it has content when enabled. The free-tier cap
 * picks round-robin across categories, so a default free profile keeps Reuters
 * Science and Nature News in place of Layoffs News and Foreign Affairs.
 */
export const SCIENCE_DEFAULT_SOURCES = [
  'Reuters Science',
  'Nature News',
  'BBC Science',
  'Guardian Science',
  'ScienceDaily',
] as const;

/** Chronological feed introductions used to reconstruct untouched cap states. */
export const REGIONAL_FEED_ROLLOUT_STAGES = [
  {
    introducedNames: [
      'Civil.ge', 'OC Media', 'JAMnews', 'Azertag', 'Armenpress', 'Zerkalo',
      'NewsMaker', 'Ziarul de Gardă', 'Radio Tamazuj', 'The Reporter Ethiopia',
      'Actualite.cd', 'Radio Okapi', 'MyJoyOnline', 'Le Quotidien',
      'Eurasianet', 'RFE/RL Central Asia', 'The Astana Times', 'The Times of Central Asia',
    ],
    protectedNames: [...FRONTLINE_EUROPE_PROTECTED_SOURCES],
  },
  {
    introducedNames: [
      'Focus Taiwan', 'Taipei Times', 'Taiwan News', 'Dawn', 'Geo News',
      'Jakarta Post', 'Rappler', 'The Star (Malaysia)', 'Irrawaddy',
    ],
    protectedNames: [...FRONTLINE_EUROPE_PROTECTED_SOURCES],
  },
  {
    introducedNames: [
      'Daily Sabah', 'Seznam Zprávy', 'Digi24', 'HotNews', 'G4Media',
      'Dnevnik', 'ERR News', 'LRT English', 'LSM English',
    ],
    protectedNames: [
      ...FRONTLINE_EUROPE_PROTECTED_SOURCES,
      ...EASTERN_FLANK_EN_DEFAULT_SOURCES,
    ],
  },
  {
    introducedNames: [
      'Ethiopia Insight', 'Dabanga Sudan', 'Hiiraan Online', 'Citi Newsroom', 'RFI Afrique',
    ],
    protectedNames: [
      ...FRONTLINE_EUROPE_PROTECTED_SOURCES,
      ...EASTERN_FLANK_EN_DEFAULT_SOURCES,
      ...AFRICA_DEPTH_EN_DEFAULT_SOURCES,
    ],
  },
  {
    // #5960 is newer than the schema-5 regional wave. Keeping its names in a
    // chronological stage removes them from every pre-pack fingerprint
    // while still allowing current-cap states to be reconstructed after it.
    // Freeze CBC as the historical default-on name so expanding
    // CANADA_EN_DEFAULT_SOURCES does not rewrite this stage.
    introducedNames: [
      'CBC News',
      ...CANADA_ARCTIC_OPT_IN_SOURCES,
    ],
    protectedNames: [
      ...FRONTLINE_EUROPE_PROTECTED_SOURCES,
      ...REGIONAL_FEED_ROLLOUT_DEFAULT_SOURCES,
      'CBC News',
    ],
  },
  {
    // Canada depth pack (#6604/#6605). Introduces the remaining national,
    // francophone, and regional names after the #5960 trio.
    introducedNames: [
      'Toronto Star',
      'CTV News',
      ...CANADA_DEPTH_OPT_IN_SOURCES,
    ],
    protectedNames: [
      ...FRONTLINE_EUROPE_PROTECTED_SOURCES,
      ...REGIONAL_FEED_ROLLOUT_DEFAULT_SOURCES,
      ...CANADA_EN_DEFAULT_SOURCES,
    ],
  },
  {
    // Validated crisis desks (#6813-#6830): defaults, strategic defaults, and opt-ins.
    introducedNames: [
      ...CRISIS_DESK_ROLLOUT_SOURCES,
    ],
    protectedNames: [
      ...FRONTLINE_EUROPE_PROTECTED_SOURCES,
      ...REGIONAL_FEED_ROLLOUT_DEFAULT_SOURCES,
      ...CANADA_EN_DEFAULT_SOURCES,
      ...CRISIS_FLOOR_EN_DEFAULT_SOURCES,
      ...CRISIS_FLOOR_STRATEGIC_DEFAULT_SOURCES,
    ],
  },
  {
    introducedNames: [...CURATED_REGIONAL_OPT_IN_SOURCES],
    protectedNames: [
      ...FRONTLINE_EUROPE_PROTECTED_SOURCES,
      ...REGIONAL_FEED_ROLLOUT_DEFAULT_SOURCES,
      ...CANADA_EN_DEFAULT_SOURCES,
      ...CRISIS_FLOOR_EN_DEFAULT_SOURCES,
      ...CRISIS_FLOOR_STRATEGIC_DEFAULT_SOURCES,
    ],
  },
  {
    introducedNames: [...MAJOR_PUBLISHER_DEFAULT_SOURCES],
    protectedNames: [
      ...FRONTLINE_EUROPE_PROTECTED_SOURCES,
      ...REGIONAL_FEED_ROLLOUT_DEFAULT_SOURCES,
      ...CANADA_EN_DEFAULT_SOURCES,
      ...CRISIS_FLOOR_EN_DEFAULT_SOURCES,
      ...CRISIS_FLOOR_STRATEGIC_DEFAULT_SOURCES,
    ],
  },
  {
    introducedNames: [...BBC_UK_DEFAULT_SOURCES],
    protectedNames: [
      ...FRONTLINE_EUROPE_PROTECTED_SOURCES,
      ...REGIONAL_FEED_ROLLOUT_DEFAULT_SOURCES,
      ...CANADA_EN_DEFAULT_SOURCES,
      ...CRISIS_FLOOR_EN_DEFAULT_SOURCES,
      ...CRISIS_FLOOR_STRATEGIC_DEFAULT_SOURCES,
    ],
  },
  {
    introducedNames: [...SCIENCE_DEFAULT_SOURCES],
    protectedNames: [
      ...FRONTLINE_EUROPE_PROTECTED_SOURCES,
      ...REGIONAL_FEED_ROLLOUT_DEFAULT_SOURCES,
      ...CANADA_EN_DEFAULT_SOURCES,
      ...CRISIS_FLOOR_EN_DEFAULT_SOURCES,
      ...CRISIS_FLOOR_STRATEGIC_DEFAULT_SOURCES,
    ],
  },
] as const;

/**
 * Editorially required EN defaults that must survive the free-tier source cap.
 * Keep the narrower frontline set above for its one-shot migration contract;
 * this broader set is only for current cap selection.
 */
export const FREE_CAP_PROTECTED_SOURCES = [
  ...FRONTLINE_EUROPE_PROTECTED_SOURCES,
  ...REGIONAL_FEED_ROLLOUT_DEFAULT_SOURCES,
  ...CANADA_EN_DEFAULT_SOURCES,
  ...CRISIS_FLOOR_EN_DEFAULT_SOURCES,
  ...CRISIS_FLOOR_STRATEGIC_DEFAULT_SOURCES,
] as const;

/**
 * Sources that are default-enabled for every UI language.
 *
 * This is derived from the feed declarations so a strategic source cannot be
 * added to the client reachability path without also entering the canonical
 * default-enabled set and the free-tier protection path.
 */
export function getStrategicDefaultSources(): Set<string> {
  const strategic = new Set<string>();
  for (const feeds of Object.values(FULL_FEEDS)) {
    for (const feed of feeds) {
      if (feed.strategicDefault) strategic.add(feed.name);
    }
  }
  for (const feed of INTEL_SOURCES) {
    if (feed.strategicDefault) strategic.add(feed.name);
  }
  return strategic;
}

/**
 * Default sources enabled for every user on first boot.
 *
 * Two separate concepts control whether a feed is visible to a user:
 *
 * **Locale boost** — feeds tagged with `lang: <code>` are auto-enabled for
 * users whose UI language matches that code (e.g. Hungarian users see Telex).
 * This is the `getLocaleBoostedSources()` mechanism. It only fires for non-EN
 * locales — English is the baseline, not "boosted".
 *
 * **Strategic defaults** — feeds tagged `strategicDefault: true` are always
 * default-enabled regardless of UI language. These carry local-depth coverage
 * of active wars, frontline NATO states, and Tier-1 Indo-Pacific flashpoints
 * that every intel audience should see (e.g. Asahi Shimbun for Japan, Yonhap
 * for Korea, Jeune Afrique for the Sahel). They are declared on the feed
 * config itself and collected by `getStrategicDefaultSources()` so the
 * bootstrap, cap, and fetch-language paths share one source of truth.
 *
 * A feed can be both locale-boosted AND a strategic default (e.g. a Polish
 * source is boosted for PL users and strategic-default for every locale).
 * The `strategicDefault` flag also makes the feed bypass `filterFeedsByLanguage`
 * so it is fetched regardless of the user's UI language.
 */
export const DEFAULT_ENABLED_SOURCES: Record<string, string[]> = {
  politics: ['BBC World', 'Guardian World', 'AP News', 'Reuters World', 'CNN World',
    'New York Times World', 'Washington Post World', 'The Economist', 'The Independent'],
  // Canada pack (#5960/#6604/#6605): CBC News + CTV News + Toronto Star
  // default-on for North America keyCountry CA (floors.CA = 3). Globe and Mail
  // + Global News remain catalog opt-in (arctic pack). Remaining depth names
  // are catalog opt-in. FR sources are locale-boosted only. CTV is GNews-only.
  us: ['Reuters US', 'NPR News', 'PBS NewsHour', 'ABC News', 'CBS News', 'NBC News', 'Wall Street Journal', 'Politico', 'The Hill', 'CBC News', 'CTV News', 'Toronto Star'],
  // Europe defaults — Ukraine war frontline (#5949) + UA/RU balance rule (#5950):
  // ≥1 dedicated UA primary (Kyiv Independent) + ≥1 independent RU (Meduza, Moscow Times).
  // PL frontline: TVN24 + Rzeczpospolita (not all three PL; noise control).
  // TASS/RT never default-on. Extra UA outlets deferred to #5951.
  // HU/EL locale packs remain locale-boosted only, not EN default-on.
  // Eastern flank (#5952): Daily Sabah (EN Turkey) + ERR News (EN Baltic) as
  // default-on; RO/BG/CS feeds stay locale-boosted (lang tags).
  europe: [
    'France 24', 'EuroNews', 'Le Monde', 'DW News', 'Tagesschau', 'ANSA', 'NOS Nieuws', 'SVT Nyheter', 'Balkan Insight',
    ...EASTERN_FLANK_EN_DEFAULT_SOURCES,
    ...FRONTLINE_EUROPE_PROTECTED_SOURCES,
    // Periphery packs (#5953) — Caucasus, Belarus/Moldova
    ...CAUCASUS_EN_DEFAULT_SOURCES,
    'Sky News',
    ...BBC_UK_DEFAULT_SOURCES,
  ],

  middleeast: ['BBC Middle East', 'Al Jazeera', 'Al Arabiya', 'Guardian ME', 'BBC Persian', 'Iran International', 'IRNA', 'Mehr News', 'Haaretz', 'Jerusalem Post', 'Ynetnews', 'Asharq News', 'The National', 'Yemen Online', 'Syria Direct', '+972 Magazine', 'Naharnet Lebanon', 'Libya Herald', 'Egypt Independent', 'Times of Israel', 'Middle East Eye'],
  africa: [
    'BBC Africa', 'News24', 'Africanews', 'Jeune Afrique', 'Africa News',
    'Premium Times', 'Channels TV', 'Sahel Crisis',
    ...AFRICA_DEPTH_EN_DEFAULT_SOURCES,
    'Daily Nation', 'The Guardian Post',
  ],
  latam: ['BBC Latin America', 'Reuters LatAm', 'InSight Crime', 'Mexico News Daily', 'Clarín', 'Primicias', 'Infobae Americas', 'El Universo', 'HaitiLibre English', 'Caracas Chronicles', 'Havana Times'],
  asia: ['BBC Asia', 'The Diplomat', 'South China Morning Post', 'Reuters Asia', 'Reuters India', 'Nikkei Asia', 'CNA', 'Asia News', 'The Hindu',
    ...CENTRAL_ASIA_EN_DEFAULT_SOURCES,
    ...INDO_PACIFIC_EN_DEFAULT_SOURCES,
    'Amu TV', 'The Daily Star', 'Japan Times',
  ],
  tech: ['Hacker News', 'Ars Technica', 'The Verge', 'MIT Tech Review'],
  ai: ['AI News', 'VentureBeat AI', 'The Verge AI', 'MIT Tech Review', 'ArXiv AI'],
  finance: ['CNBC', 'MarketWatch', 'Yahoo Finance', 'Financial Times', 'Reuters Business'],
  gov: ['White House', 'State Dept', 'Pentagon', 'UN News', 'CISA', 'Treasury', 'DOJ', 'CDC'],
  layoffs: ['Layoffs.fyi', 'TechCrunch Layoffs', 'Layoffs News'],
  thinktanks: ['Foreign Policy', 'Atlantic Council', 'Foreign Affairs', 'CSIS', 'RAND', 'Brookings', 'Carnegie', 'War on the Rocks', 'ISW'],
  crisis: ['CrisisWatch', 'IAEA', 'WHO', 'UNHCR'],
  energy: ['Oil & Gas', 'Nuclear Energy', 'Reuters Energy', 'Mining & Resources'],
  science: [...SCIENCE_DEFAULT_SOURCES],
};

export const DEFAULT_ENABLED_INTEL: string[] = [
  'Defense One', 'Breaking Defense', 'The War Zone', 'Defense News',
  'Military Times', 'USNI News', 'Bellingcat', 'Krebs Security',
];

function getExplicitDefaultEnabledSources(): Set<string> {
  const s = new Set<string>();
  for (const names of Object.values(DEFAULT_ENABLED_SOURCES)) names.forEach(n => s.add(n));
  DEFAULT_ENABLED_INTEL.forEach(n => s.add(n));
  return s;
}

export function getAllDefaultEnabledSources(): Set<string> {
  const s = getExplicitDefaultEnabledSources();
  for (const name of getStrategicDefaultSources()) s.add(name);
  return s;
}

/**
 * Sources selected strictly by a non-English language match. Kept separate
 * from strategic-default policy so historical preference migrations can
 * reconstruct pre-rollout locale states deterministically. In particular, an
 * English locale lookup must not implicitly enable every ordinary multi-URL
 * feed that happens to expose an `en` URL.
 */
export function getLanguageMatchedSources(locale: string): Set<string> {
  const lang = (locale.split('-')[0] ?? 'en').toLowerCase();
  const boosted = new Set<string>();
  if (lang === 'en') return boosted;
  const allFeeds = [...Object.values(FULL_FEEDS).flat(), ...INTEL_SOURCES];
  for (const f of allFeeds) {
    if (f.lang === lang) boosted.add(f.name);
    if (typeof f.url === 'object' && lang in f.url) boosted.add(f.name);
  }
  return boosted;
}

/** Sources boosted by locale (feeds tagged with matching `lang` or multi-URL key). */
export function getLocaleBoostedSources(locale: string): Set<string> {
  return getLanguageMatchedSources(locale);
}

export function computeDefaultDisabledSources(locale?: string): string[] {
  const enabled = getAllDefaultEnabledSources();
  if (locale) {
    for (const name of getLocaleBoostedSources(locale)) enabled.add(name);
  }
  const all = new Set<string>();
  for (const feeds of Object.values(FULL_FEEDS)) for (const f of feeds) all.add(f.name);
  for (const f of INTEL_SOURCES) all.add(f.name);
  return [...all].filter(name => !enabled.has(name));
}

/**
 * Sources that were removed from DEFAULT_ENABLED_SOURCES during the regional
 * feed rollout reconciliation (PR #6031). They were historically default-on
 * and must remain in the reconstructed pre-strategic fingerprint so exact-set
 * migration matching finds them in the enabled (not disabled) set.
 */
const PRE_ROLLOUT_RECONCILIATION_DEFAULTS = [
  'Ukrainska Pravda EN',
  'NV EN',
  'NewsMaker',
] as const;

/**
 * Reconstruct the source-reduction defaults from before strategic defaults
 * became part of the canonical default-enabled set. This is used only by the
 * exact-set migrations that repair profiles created before PR #6000.
 */
export function computePreStrategicDefaultDisabledSources(locale?: string): string[] {
  const enabled = getExplicitDefaultEnabledSources();
  for (const name of PRE_ROLLOUT_RECONCILIATION_DEFAULTS) enabled.add(name);
  if (locale) {
    for (const name of getLanguageMatchedSources(locale)) enabled.add(name);
  }
  const all = new Set<string>();
  for (const feeds of Object.values(FULL_FEEDS)) for (const feed of feeds) all.add(feed.name);
  for (const feed of INTEL_SOURCES) all.add(feed.name);
  return [...all].filter((name) => !enabled.has(name));
}

/**
 * Reconstruct the untouched default denylist immediately before PR #5976.
 * Every later regional source is removed because it did not exist in that
 * catalog; the remaining set can be compared exactly without hard-coding a
 * large, brittle list of unrelated feed names.
 */
export function computePreRegionalFeedRolloutDefaultDisabledSources(locale?: string): string[] {
  const introduced = new Set<string>(
    REGIONAL_FEED_ROLLOUT_STAGES.flatMap((stage) => [...stage.introducedNames]),
  );
  return computePreStrategicDefaultDisabledSources(locale)
    .filter((name) => !introduced.has(name));
}

/**
 * The v3 source-reduction migration's pre-#5949 disabled set. This is used
 * only for a conservative one-time frontline migration: an exact match means
 * the profile still has the old untouched defaults, while any extra or
 * missing entry is treated as a user-customized preference and left alone.
 */
export function computeLegacyDefaultDisabledSources(): string[] {
  const disabled = new Set(computePreStrategicDefaultDisabledSources());
  for (const name of FRONTLINE_EUROPE_PROTECTED_SOURCES) disabled.add(name);
  return [...disabled];
}

export function getTotalFeedCount(): number {
  const all = new Set<string>();
  for (const feeds of Object.values(FULL_FEEDS)) for (const f of feeds) all.add(f.name);
  for (const f of INTEL_SOURCES) all.add(f.name);
  return all.size;
}

if (import.meta.env.DEV) {
  const allFeedNames = new Set<string>();
  for (const feeds of Object.values(FULL_FEEDS)) for (const f of feeds) allFeedNames.add(f.name);
  for (const f of INTEL_SOURCES) allFeedNames.add(f.name);
  const defaultEnabled = getAllDefaultEnabledSources();
  for (const name of defaultEnabled) {
    if (!allFeedNames.has(name)) console.error(`[feeds] DEFAULT_ENABLED name "${name}" not found in FULL_FEEDS!`);
  }
  console.log(`[feeds] ${defaultEnabled.size} unique default-enabled sources / ${allFeedNames.size} total`);
}

// Keywords that trigger alert status - must be specific to avoid false positives
export const ALERT_KEYWORDS = [
  'war', 'invasion', 'military', 'nuclear', 'sanctions', 'missile',
  'airstrike', 'drone strike', 'troops deployed', 'armed conflict', 'bombing', 'casualties',
  'ceasefire', 'peace treaty', 'nato', 'coup', 'martial law',
  'assassination', 'terrorist', 'terror attack', 'cyber attack', 'hostage', 'evacuation order',
];

// Patterns that indicate non-alert content (lifestyle, entertainment, etc.)
export const ALERT_EXCLUSIONS = [
  'protein', 'couples', 'relationship', 'dating', 'diet', 'fitness',
  'recipe', 'cooking', 'shopping', 'fashion', 'celebrity', 'movie',
  'tv show', 'sports', 'game', 'concert', 'festival', 'wedding',
  'vacation', 'travel tips', 'life hack', 'self-care', 'wellness',
];
