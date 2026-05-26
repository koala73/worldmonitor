// Hierarchical geography for the Regional Intelligence Model.
// Layers (aggregate upward): Display Region -> Theater -> Corridor -> Node.
//
// Used by:
//   - scripts/seed-regional-snapshots.mjs (snapshot writer)
//   - scripts/regional-snapshot/* (compute modules)
//   - server/worldmonitor/intelligence/v1/* (Phase 1+ RPC handlers)
//   - src/components/RegionalIntelligenceBoard (Phase 1 UI)
//
// Region taxonomy is anchored to World Bank region codes (EAS/ECS/LCN/MEA/NAC/SAS/SSF)
// with strategic overrides applied to shared/iso2-to-region.json (built once from
// https://api.worldbank.org/v2/country?format=json&per_page=300).
//
// Strategic overrides (deviations from raw WB classification):
//   - AF, PK: WB has them in MEA; we put them in south-asia (geographic/strategic)
//   - TR:     WB has it in ECS;  we put it in mena (Levant/Syria/refugee policy frame)
//   - MX:     WB has it in LCN;  we put it in north-america (USMCA strategic frame)
//   - TW:     WB does not list Taiwan; manually added to east-asia
//
// Country and corridor criticality weights match the formulas in
// docs/internal/pro-regional-intelligence-appendix-scoring.md.

import iso2ToRegionData from './iso2-to-region.json' with { type: 'json' };

/** @type {import('./regions.types.js').RegionId[]} */
export const REGION_IDS = [
  'mena',
  'east-asia',
  'europe',
  'north-america',
  'south-asia',
  'latam',
  'sub-saharan-africa',
  'global',
];

export const GEOGRAPHY_VERSION = '1.0.0';

/**
 * Eight display regions. `forecastLabel` matches the free-text region strings
 * the existing forecast handler does substring matching against, so the same
 * label flows end-to-end without taxonomy mismatch.
 */
// `signalAliases` holds broad display labels that cross-source feeds emit
// which do NOT substring-match any fine-grained theater ID. Example:
// scripts/seed-cross-source-signals.mjs normalizes raw values to "Middle East"
// or "Sub-Saharan Africa", and these would silently drop out of region
// matching if we only checked `theaters`. Kept lowercased so the matching
// helper can compare directly.
export const REGIONS = [
  {
    id: 'mena',
    label: 'Middle East & North Africa',
    forecastLabel: 'Middle East',
    wbCode: 'MEA',
    theaters: ['levant', 'persian-gulf', 'red-sea', 'north-africa'],
    signalAliases: ['middle east', 'mena'],
    feedRegion: 'middleeast',
    mapView: 'mena',
    keyCountries: ['SA', 'IR', 'IL', 'AE', 'EG', 'IQ', 'TR'],
  },
  {
    id: 'east-asia',
    label: 'East Asia & Pacific',
    forecastLabel: 'East Asia',
    wbCode: 'EAS',
    theaters: ['east-asia', 'southeast-asia'],
    signalAliases: ['asia pacific', 'apac'],
    feedRegion: 'asia',
    mapView: 'asia',
    keyCountries: ['CN', 'JP', 'KR', 'TW', 'AU', 'SG', 'ID'],
  },
  {
    id: 'europe',
    label: 'Europe & Central Asia',
    forecastLabel: 'Europe',
    wbCode: 'ECS',
    theaters: ['eastern-europe', 'western-europe', 'baltic', 'arctic'],
    // 'europe' is long enough to avoid substring false-positives; bare 'eu' was
    // removed because it would match 'fuel', 'neutral zone', etc. under the
    // substring-includes matching in isSignalInRegion.
    signalAliases: ['europe', 'european union'],
    feedRegion: 'europe',
    mapView: 'eu',
    keyCountries: ['DE', 'FR', 'GB', 'UA', 'RU', 'PL', 'IT'],
  },
  {
    id: 'north-america',
    label: 'North America',
    forecastLabel: 'North America',
    wbCode: 'NAC',
    theaters: ['north-america'],
    signalAliases: [],
    feedRegion: 'us',
    mapView: 'america',
    keyCountries: ['US', 'CA', 'MX'],
  },
  {
    id: 'south-asia',
    label: 'South Asia',
    forecastLabel: 'South Asia',
    wbCode: 'SAS',
    theaters: ['south-asia'],
    signalAliases: [],
    feedRegion: 'asia',
    mapView: 'asia',
    keyCountries: ['IN', 'PK', 'BD', 'LK', 'AF'],
  },
  {
    id: 'latam',
    label: 'Latin America & Caribbean',
    forecastLabel: 'Latin America',
    wbCode: 'LCN',
    theaters: ['latin-america', 'caribbean'],
    signalAliases: ['latam'],
    feedRegion: 'latam',
    mapView: 'latam',
    keyCountries: ['BR', 'AR', 'CO', 'CL', 'VE', 'PE'],
  },
  {
    id: 'sub-saharan-africa',
    label: 'Sub-Saharan Africa',
    forecastLabel: 'Africa',
    wbCode: 'SSF',
    theaters: ['horn-of-africa', 'sahel', 'southern-africa', 'central-africa'],
    signalAliases: ['sub-saharan africa', 'subsaharan africa'],
    feedRegion: 'africa',
    mapView: 'africa',
    keyCountries: ['NG', 'ZA', 'KE', 'ET', 'SD', 'CD'],
  },
  {
    id: 'global',
    label: 'Global',
    forecastLabel: '',
    wbCode: '1W',
    theaters: ['global-markets'],
    signalAliases: ['global'],
    feedRegion: 'worldwide',
    mapView: 'global',
    keyCountries: ['US', 'CN', 'RU', 'DE', 'JP', 'IN', 'GB', 'SA'],
  },
];

/**
 * Theaters group countries into geopolitical-strategic units smaller than
 * regions. Cross-source signals and military posture data already use these
 * theater names where applicable.
 */
export const THEATERS = [
  // MENA
  { id: 'levant', label: 'Levant', regionId: 'mena', corridorIds: [] },
  { id: 'persian-gulf', label: 'Persian Gulf', regionId: 'mena', corridorIds: ['hormuz'] },
  { id: 'red-sea', label: 'Red Sea', regionId: 'mena', corridorIds: ['babelm', 'suez'] },
  { id: 'north-africa', label: 'North Africa', regionId: 'mena', corridorIds: [] },
  // East Asia
  { id: 'east-asia', label: 'East Asia', regionId: 'east-asia', corridorIds: ['taiwan-strait'] },
  { id: 'southeast-asia', label: 'Southeast Asia', regionId: 'east-asia', corridorIds: ['malacca', 'south-china-sea'] },
  // Europe
  { id: 'eastern-europe', label: 'Eastern Europe', regionId: 'europe', corridorIds: ['bosphorus'] },
  { id: 'western-europe', label: 'Western Europe', regionId: 'europe', corridorIds: ['english-channel'] },
  { id: 'baltic', label: 'Baltic', regionId: 'europe', corridorIds: ['danish'] },
  { id: 'arctic', label: 'Arctic', regionId: 'europe', corridorIds: [] },
  // North America
  { id: 'north-america', label: 'North America', regionId: 'north-america', corridorIds: ['panama'] },
  // South Asia
  { id: 'south-asia', label: 'South Asia', regionId: 'south-asia', corridorIds: [] },
  // LatAm
  { id: 'latin-america', label: 'Latin America', regionId: 'latam', corridorIds: [] },
  { id: 'caribbean', label: 'Caribbean', regionId: 'latam', corridorIds: ['panama'] },
  // SSA
  { id: 'horn-of-africa', label: 'Horn of Africa', regionId: 'sub-saharan-africa', corridorIds: ['babelm'] },
  { id: 'sahel', label: 'Sahel', regionId: 'sub-saharan-africa', corridorIds: [] },
  { id: 'southern-africa', label: 'Southern Africa', regionId: 'sub-saharan-africa', corridorIds: ['cape-of-good-hope'] },
  { id: 'central-africa', label: 'Central Africa', regionId: 'sub-saharan-africa', corridorIds: [] },
  // Global
  { id: 'global-markets', label: 'Global Markets', regionId: 'global', corridorIds: [] },
];

/**
 * Corridors are the chokepoint and trade-route layer where transmission
 * mechanics actually live. `chokepointId` links to the existing seeded data
 * at `supply_chain:chokepoints:v4` and `scripts/seed-chokepoint-baselines.mjs`.
 *
 * Tier and weight match the criticality table in the scoring appendix.
 */
export const CORRIDORS = [
  // Tier 1 (~20% of global oil transit, top trade volume)
  { id: 'hormuz',          label: 'Strait of Hormuz',     theaterId: 'persian-gulf',     chokepointId: 'hormuz',       tier: 1, weight: 1.0 },
  { id: 'suez',            label: 'Suez Canal',           theaterId: 'red-sea',          chokepointId: 'suez',         tier: 1, weight: 1.0 },
  { id: 'babelm',          label: 'Bab el-Mandeb',        theaterId: 'red-sea',          chokepointId: 'babelm',       tier: 1, weight: 0.9 },
  { id: 'taiwan-strait',   label: 'Taiwan Strait',        theaterId: 'east-asia',        chokepointId: 'taiwan_strait',tier: 1, weight: 0.9 },
  { id: 'bosphorus',       label: 'Bosphorus',            theaterId: 'eastern-europe',   chokepointId: 'bosphorus',    tier: 1, weight: 0.7 },
  // Tier 2
  { id: 'malacca',         label: 'Strait of Malacca',    theaterId: 'southeast-asia',   chokepointId: 'malacca',      tier: 2, weight: 0.8 },
  { id: 'panama',          label: 'Panama Canal',         theaterId: 'north-america',    chokepointId: 'panama',       tier: 2, weight: 0.6 },
  { id: 'danish',          label: 'Danish Straits',       theaterId: 'baltic',           chokepointId: 'danish',       tier: 2, weight: 0.5 },
  // Tier 3 (reroute paths and secondary)
  { id: 'cape-of-good-hope', label: 'Cape of Good Hope',  theaterId: 'southern-africa',  chokepointId: null,           tier: 3, weight: 0.4 },
  { id: 'south-china-sea', label: 'South China Sea',      theaterId: 'southeast-asia',   chokepointId: null,           tier: 3, weight: 0.6 },
  { id: 'english-channel', label: 'English Channel',      theaterId: 'western-europe',   chokepointId: null,           tier: 3, weight: 0.4 },
];

/**
 * Country criticality weights for the weighted-tail domestic fragility score.
 * Higher weight = country dominates region risk.
 *
 * Methodology (per scoring appendix):
 *   1.0: controls a tier-1 corridor, OR top-10 oil/gas producer, OR top-5 region GDP
 *   0.6: controls a tier-2 corridor, OR top-20 oil/gas producer, OR top-10 region GDP
 *   0.3: default for other countries
 */
export const COUNTRY_CRITICALITY = {
  // Tier-1 corridor controllers + top-10 producers + top-5 region GDP
  IR: 1.0, // Hormuz controller
  OM: 1.0, // Hormuz controller (other side)
  AE: 1.0, // Persian Gulf, top oil producer
  SA: 1.0, // Top oil producer
  EG: 1.0, // Suez controller
  YE: 1.0, // Bab el-Mandeb controller
  CN: 1.0, // Taiwan Strait, top region GDP
  TW: 1.0, // Taiwan Strait
  TR: 1.0, // Bosphorus controller
  US: 1.0, // Top-10 producer, dominant region GDP
  RU: 1.0, // Top oil/gas producer
  CA: 1.0, // Top oil producer
  // Tier-2 corridor controllers + top-20 producers + top-10 region GDP
  MY: 0.6, // Malacca
  SG: 0.6, // Malacca
  ID: 0.6, // Malacca, regional GDP
  PA: 0.6, // Panama
  DK: 0.6, // Danish Straits
  DE: 0.6, // Top region GDP
  FR: 0.6,
  GB: 0.6,
  JP: 0.6,
  IN: 0.6, // Top region GDP, growing producer
  BR: 0.6, // Top region GDP, top-20 producer
  MX: 0.6,
  KR: 0.6,
  IL: 0.6, // Strategic significance in MENA
  IQ: 0.6, // Top-20 producer
  KW: 0.6, // Top-20 producer
  QA: 0.6, // Top-20 LNG producer
  NG: 0.6, // Top-20 oil producer
  AU: 0.6, // Top LNG producer, regional GDP
  // Everything else defaults to 0.3
};

export const DEFAULT_COUNTRY_CRITICALITY = 0.3;

// ────────────────────────────────────────────────────────────────────────────
// Helper functions
// ────────────────────────────────────────────────────────────────────────────

/** @type {Record<string, string>} */
const ISO2_TO_REGION = iso2ToRegionData;

/** @param {string} regionId */
export function getRegion(regionId) {
  return REGIONS.find((r) => r.id === regionId) ?? null;
}

/** @param {string} regionId */
export function getRegionCountries(regionId) {
  const out = [];
  for (const [iso, rid] of Object.entries(ISO2_TO_REGION)) {
    if (rid === regionId) out.push(iso);
  }
  return out;
}

/** @param {string} iso2 */
export function regionForCountry(iso2) {
  return ISO2_TO_REGION[iso2] ?? null;
}

/** @param {string} regionId */
export function getRegionTheaters(regionId) {
  return THEATERS.filter((t) => t.regionId === regionId);
}

/** @param {string} theaterId */
export function getTheaterCorridors(theaterId) {
  return CORRIDORS.filter((c) => c.theaterId === theaterId);
}

/**
 * Corridors owned by a region. Derived from TWO sources so shared chokepoints
 * surface for every region they actually touch geographically:
 *
 *   1. Direct: corridors whose primary `theaterId` lives in this region.
 *   2. Indirect: corridors explicitly listed in any of this region's
 *      `theaters[].corridorIds` — this is how a chokepoint that primarily
 *      belongs to another region can still be claimed by a secondary region.
 *
 * Example: Bab el-Mandeb (`babelm`) has `theaterId: 'red-sea'` (MENA), but
 * it physically borders Djibouti and Eritrea as well, so the SSA theater
 * `horn-of-africa` declares `corridorIds: ['babelm']` and picks it up here.
 * Same for Panama → caribbean (LatAm) alongside its primary north-america
 * theater (NA).
 *
 * De-duplicated by corridor id, so a corridor owned directly + indirectly
 * (none today, but possible if a theater lists its own primary corridors)
 * is still returned once.
 *
 * @param {string} regionId
 */
export function getRegionCorridors(regionId) {
  const theaters = getRegionTheaters(regionId);
  const theaterIds = new Set(theaters.map((t) => t.id));
  const indirectIds = new Set(theaters.flatMap((t) => t.corridorIds ?? []));
  const seen = new Map();
  for (const c of CORRIDORS) {
    if (theaterIds.has(c.theaterId) || indirectIds.has(c.id)) {
      seen.set(c.id, c);
    }
  }
  return [...seen.values()];
}

/** @param {string} iso2 */
export function countryCriticality(iso2) {
  return COUNTRY_CRITICALITY[iso2] ?? DEFAULT_COUNTRY_CRITICALITY;
}

/**
 * Tests whether a raw theater label from a cross-source signal belongs to
 * the given region. Case-insensitive substring match against both the
 * fine-grained theater IDs (after kebab-to-space transform) and the region's
 * `signalAliases` for broad labels the seed feeds actually emit.
 *
 * Example: `isSignalInRegion('Middle East', 'mena')` returns true via alias;
 * `isSignalInRegion('persian-gulf', 'mena')` returns true via theater ID.
 *
 * @param {string | undefined | null} theater - raw theater label (free-text)
 * @param {string | { id?: string, theaters?: string[], signalAliases?: string[] }} regionOrId
 * @returns {boolean}
 */
export function isSignalInRegion(theater, regionOrId) {
  const region = typeof regionOrId === 'string' ? getRegion(regionOrId) : regionOrId;
  if (!region) return false;
  // Normalize both sides: lowercase, trim, collapse dashes to spaces so that
  // 'persian-gulf' and 'Persian Gulf' are treated as the same token.
  const t = String(theater ?? '').toLowerCase().trim().replace(/-/g, ' ');
  if (!t) return false;
  const theaters = Array.isArray(region.theaters) ? region.theaters : [];
  for (const label of theaters) {
    if (t.includes(String(label).toLowerCase().replace(/-/g, ' '))) return true;
  }
  const aliases = Array.isArray(region.signalAliases) ? region.signalAliases : [];
  for (const alias of aliases) {
    if (t.includes(String(alias).toLowerCase().replace(/-/g, ' '))) return true;
  }
  return false;
}
