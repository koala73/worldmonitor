/**
 * Publisher-family resolution for corroboration counting (#6428).
 *
 * A cluster's `sources` array holds FEED LABELS, and a feed label is not a
 * publisher: `BBC World`, `BBC Africa` and `BBC Persian` are three labels for
 * one newsroom, and `Reuters World` + `Reuters US` + `Reuters Business` are
 * three labels for one wire. Counting labels let a single story reprinted
 * across one publisher's own editions clear a "two independent sources" gate.
 * Every corroboration gate must count families instead.
 *
 * FAIL CLOSED, in the direction that never invents independence:
 *   - an unmapped label is its OWN family. A new feed is never silently
 *     folded into an existing publisher, and it never disappears from the
 *     count either — it just cannot claim to corroborate anything but itself.
 *   - singleton family ids are namespaced (`label:<name>`) so they can never
 *     collide with a curated family id.
 *
 * Cross-publisher syndication (#6430): the server ingest parser now carries
 * the RSS `<source>` element — the originating publisher Google News stamps
 * per item — as `originPublisher`, and the digest's corroboration counts
 * resolve THAT through this map when present, falling back to the feed
 * label. To let an origin NAME ("Reuters", "Associated Press") land in the
 * same family as the feed labels it syndicates through, each curated
 * family's `publisher` name is indexed alongside its labels. An unknown
 * origin name stays its own singleton family — same fail-closed direction
 * as an unmapped label.
 *
 * REMAINING LIMIT — origin names outside the curated set. "BBC News" from a
 * Google News <source> does not fold into the 'bbc' family unless curated
 * (no fuzzy matching, by design), and direct non-Google-News feeds mostly
 * carry no <source> element at all — for those the feed label remains the
 * best available publisher signal.
 */
/**
 * Curated label -> publisher family. Only families with 2+ labels appear; an
 * unmapped label is its own family by construction (see publisherFamilyFor).
 *
 * INLINE ON PURPOSE — do not move this table back into a .json.
 * This module is reached by four runtimes: the Railway seeder (nixpacks,
 * rootDirectory=scripts), the Vercel handler bundle via
 * server/worldmonitor/news/v1/list-feed-digest.ts, the Vite browser bundle,
 * and plain `node --test`. The two JSON-import forms are mutually
 * incompatible across them — `with { type: 'json' }` breaks the Vercel
 * bundle, and a bare JSON import throws ERR_IMPORT_ATTRIBUTE_MISSING under
 * Node 22+. shared/ticker-extract.js:20-30 records that burn, and
 * tests/no-json-import-attributes-on-edge-path.test.mjs now enforces it.
 * A literal is the one form that works everywhere.
 */
const PUBLISHER_FAMILY_DATA = {
  'a16z': { publisher: "Andreessen Horowitz", labels: ["a16z Blog", "a16z Insights", "a16z Podcast"] },
  'acquired': { publisher: "Acquired", labels: ["Acquired Episodes", "Acquired Podcast"] },
  'ap-news': { publisher: "Associated Press", labels: ["AP Mexico", "AP News"] },
  'arxiv': { publisher: "arXiv", labels: ["ArXiv AI", "ArXiv ML"] },
  'asharq': { publisher: "Asharq News", labels: ["Asharq Business", "Asharq News"] },
  'bbc': {
    publisher: "BBC",
    labels: [
      "BBC Africa",
      "BBC Afrique",
      "BBC Asia",
      "BBC Hindi",
      "BBC Latin America",
      "BBC Middle East",
      "BBC Mundo",
      "BBC Persian",
      "BBC Russian",
      "BBC Turkce",
      "BBC World",
    ],
  },
  'bloomberg': {
    publisher: "Bloomberg",
    labels: [
      "Bloomberg",
      "Bloomberg Commodities",
      "Bloomberg Crypto",
      "Bloomberg Energy",
      "Bloomberg Markets",
    ],
  },
  'brookings': { publisher: "Brookings Institution", labels: ["Brookings", "Brookings Tech"] },
  'cb-insights': { publisher: "CB Insights", labels: ["CB Insights", "CB Insights Unicorn"] },
  'chatham-house': { publisher: "Chatham House", labels: ["Chatham House", "Chatham House Tech"] },
  'cnbc': { publisher: "CNBC", labels: ["CNBC", "CNBC Commodities", "CNBC Markets", "CNBC Tech"] },
  'csis': { publisher: "CSIS", labels: ["CSIS", "CSIS Tech"] },
  'dw': { publisher: "Deutsche Welle", labels: ["DW News", "DW Turkish"] },
  'eia': { publisher: "US Energy Information Administration", labels: ["EIA Press Room", "EIA Reports"] },
  'fao': { publisher: "UN Food and Agriculture Organization", labels: ["FAO GIEWS", "FAO News"] },
  'financial-times': { publisher: "Financial Times", labels: ["FT Energy", "Financial Times"] },
  'france-24': { publisher: "France 24", labels: ["France 24", "France 24 LatAm"] },
  'good-news-network': {
    publisher: "Good News Network",
    labels: [
      "GNN Animals",
      "GNN Earth",
      "GNN Health",
      "GNN Heroes",
      "GNN Heroes Spotlight",
      "GNN Science",
      "Good News Network",
    ],
  },
  'guardian': {
    publisher: "The Guardian",
    labels: [
      "Guardian Americas",
      "Guardian Australia",
      "Guardian ME",
      "Guardian World",
    ],
  },
  'hacker-news': { publisher: "Hacker News", labels: ["Hacker News", "Show HN", "YC News"] },
  'hromadske': { publisher: "Hromadske", labels: ["Hromadske", "Hromadske EN"] },
  'interfax': { publisher: "Interfax", labels: ["Interfax EN", "Interfax RU"] },
  'iea': { publisher: "International Energy Agency", labels: ["IEA Critical Minerals", "IEA News"] },
  'kitco': { publisher: "Kitco", labels: ["Kitco Gold", "Kitco News"] },
  'marketwatch': { publisher: "MarketWatch", labels: ["MarketWatch", "MarketWatch Tech"] },
  'mit-technology-review': {
    publisher: "MIT Technology Review",
    labels: [
      "MIT Tech Review",
      "MIT Tech Review AI",
    ],
  },
  'ndtv': { publisher: "NDTV", labels: ["NDTV", "NDTV India"] },
  'nikkei': { publisher: "Nikkei", labels: ["Nikkei Asia", "Nikkei Tech"] },
  'pivot': { publisher: "Pivot (Vox Media)", labels: ["Pivot (Vox)", "Pivot Podcast"] },
  'politico': { publisher: "Politico", labels: ["Politico", "Politico Tech"] },
  'reuters': {
    publisher: "Reuters",
    labels: [
      "Reuters",
      "Reuters Asia",
      "Reuters Business",
      "Reuters Commodities",
      "Reuters Crypto",
      "Reuters Energy",
      "Reuters India",
      "Reuters LatAm",
      "Reuters Markets",
      "Reuters US",
      "Reuters World",
    ],
  },
  'rt': { publisher: "RT", labels: ["RT", "RT Russia"] },
  'seeking-alpha': {
    publisher: "Seeking Alpha",
    labels: [
      "Seeking Alpha",
      "Seeking Alpha Metals",
      "Seeking Alpha Tech",
    ],
  },
  'sp-global': { publisher: "S&P Global", labels: ["S&P Global Commodity", "S&P Global Platts"] },
  'techcrunch': {
    publisher: "TechCrunch",
    labels: [
      "TechCrunch",
      "TechCrunch Layoffs",
      "TechCrunch Startups",
      "TechCrunch Venture",
    ],
  },
  'the-verge': {
    publisher: "The Verge",
    labels: [
      "Decoder (Verge)",
      "The Verge",
      "The Verge AI",
      "The Vergecast",
      "Verge Shows",
    ],
  },
  'venturebeat': { publisher: "VentureBeat", labels: ["VentureBeat", "VentureBeat AI"] },
  'white-house': { publisher: "The White House", labels: ["White House", "White House Actions"] },
  'y-combinator': { publisher: "Y Combinator", labels: ["YC Launches", "Y Combinator Blog"] },
  'yahoo-finance': { publisher: "Yahoo Finance", labels: ["Yahoo Finance", "Yahoo Finance Commodities"] },
};

export const PUBLISHER_FAMILIES = Object.freeze(PUBLISHER_FAMILY_DATA);

/**
 * How many distinct publishers make a story corroborated.
 *
 * One constant for every gate that asks the question — the brief-lead gate in
 * scripts/_clustering.mjs and the entity-corroboration buckets in both
 * scripts/_clustering.mjs and server/worldmonitor/news/v1/list-feed-digest.ts.
 * They were three separate literal `2`s and could drift apart silently.
 *
 * The value is 2, re-measured for #6428 rather than inherited: two genuinely
 * independent publishers is a stronger bar than the two feed LABELS this used
 * to mean, so the same number rejects more. See
 * docs/solutions/best-practices/corroboration-counts-publisher-families.md for
 * the replay measurement behind it (families >= 2 removes 33.5% of false
 * corroboration for 0.1pp of publication rate; >= 3 buys no headroom and
 * shrinks the eligible pool 3.4x further).
 */
export const MIN_CORROBORATING_PUBLISHERS = 2;

/** Namespace for a label that no curated family claims. */
const SINGLETON_PREFIX = 'label:';

const familyByLabel = new Map();
const familyByLowerLabel = new Map();
for (const [familyId, entry] of Object.entries(PUBLISHER_FAMILY_DATA)) {
  for (const label of entry.labels) {
    familyByLabel.set(label, familyId);
    familyByLowerLabel.set(label.toLowerCase(), familyId);
  }
}
// The publisher NAME resolves to its family too, so an origin publisher
// recovered from the RSS <source> element ("Reuters", "Associated Press")
// joins the family of the labels it syndicates through (#6430). Set-if-absent:
// a curated LABEL always wins over a same-spelling publisher name, so label
// resolution is unchanged by construction.
for (const [familyId, entry] of Object.entries(PUBLISHER_FAMILY_DATA)) {
  const lowerName = entry.publisher.toLowerCase();
  if (!familyByLowerLabel.has(lowerName)) familyByLowerLabel.set(lowerName, familyId);
}

/**
 * Family id for one feed label. Returns '' for a blank/non-string label so
 * callers can drop it rather than counting an empty source.
 *
 * The lowercase fallback still resolves to a CURATED label — it absorbs
 * casing drift between the client and server feed configs without ever
 * fuzzy-matching an unknown label into a family.
 *
 * @param {unknown} label
 * @returns {string}
 */
export function publisherFamilyFor(label) {
  if (typeof label !== 'string') return '';
  const trimmed = label.trim();
  if (trimmed.length === 0) return '';
  const lower = trimmed.toLowerCase();
  // The singleton id is lowercased too, or "Brand New Feed" and "brand new
  // feed" would resolve to two families and manufacture a second publisher out
  // of one feed whose casing drifted between the client and server configs.
  // Case-only collisions between genuinely different publishers do not occur
  // in a feed config, and folding them would fail in the safe direction anyway.
  return familyByLabel.get(trimmed)
    ?? familyByLowerLabel.get(lower)
    ?? `${SINGLETON_PREFIX}${lower}`;
}

/**
 * Distinct publisher families across a list of feed labels.
 *
 * @param {unknown} labels
 * @returns {Set<string>}
 */
export function publisherFamiliesFor(labels) {
  const families = new Set();
  if (!Array.isArray(labels)) return families;
  for (const label of labels) {
    const family = publisherFamilyFor(label);
    if (family) families.add(family);
  }
  return families;
}

/**
 * How many distinct publishers a list of feed labels actually represents.
 * This is the number every corroboration gate is allowed to reason about.
 *
 * @param {unknown} labels
 * @returns {number}
 */
export function countPublisherFamilies(labels) {
  return publisherFamiliesFor(labels).size;
}

/**
 * Human-readable publisher name for a family id, for user-facing copy.
 * A singleton family renders as the feed label it was derived from.
 *
 * @param {unknown} familyId
 * @returns {string}
 */
export function publisherNameForFamily(familyId) {
  if (typeof familyId !== 'string' || familyId.length === 0) return '';
  if (familyId.startsWith(SINGLETON_PREFIX)) return familyId.slice(SINGLETON_PREFIX.length);
  return PUBLISHER_FAMILY_DATA[familyId]?.publisher ?? familyId;
}
