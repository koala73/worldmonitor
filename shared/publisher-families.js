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
 * Cross-publisher syndication (#6430): the server ingest parser may carry the
 * RSS `<source>` element — the originating publisher Google News stamps per
 * item — as `originPublisher`. Corroboration consumers must call
 * `publisherFamilyForItem`, which accepts that origin only when the parser
 * marked the feed as an explicitly configured trusted aggregator. Ordinary
 * feeds fall back to their server-configured label, so upstream text cannot
 * manufacture independent families. To let a trusted origin NAME ("Reuters",
 * "Associated Press") land in the same family as the feed labels it
 * syndicates through, each curated family's `publisher` name is indexed
 * alongside its labels. An unknown origin name stays its own singleton family
 * — same fail-closed direction as an unmapped label.
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
  'matichon': { publisher: 'Matichon Group', labels: ['Matichon', 'Khaosod English'] },
  "n1-danas": { publisher: "N1 and Danas", labels: ["N1 Croatia", "N1 Bosna i Hercegovina", "N1 Info", "N1 Slovenia", "Danas"] },
  "alpha-media-zimbabwe": { publisher: "Alpha Media Holdings", labels: ["NewsDay Zimbabwe", "The Zimbabwe Independent"] },
  "rjr-gleaner": { publisher: "RJRGLEANER", labels: ["The Gleaner", "Radio Jamaica News"] },
  "guardian-media-tt": { publisher: "Guardian Media Trinidad and Tobago", labels: ["Trinidad Guardian", "CNC3"] },
  'times-of-malta': { publisher: "Times of Malta", labels: ["Times of Malta"] },
  'straits-times': { publisher: "The Straits Times", labels: ["Straits Times"] },
  'gma': { publisher: "GMA News", labels: ["GMA News"] },
  'reporter-taiwan': { publisher: "The Reporter", labels: ["The Reporter"] },
  'jyllands-posten': { publisher: "Jyllands-Posten", labels: ["Jyllands-Posten"] },
  'rtvslo': { publisher: "RTV Slovenija", labels: ["RTV Slovenija"] },
  'kyodo': { publisher: "Kyodo News", labels: ["Japan Wire by Kyodo News"] },
  'orf': { publisher: "ORF", labels: ["ORF.at"] },
  'der-standard': { publisher: "Der Standard", labels: ["Der Standard"] },
  'rtbf': { publisher: "RTBF", labels: ["RTBF Info"] },
  'expresso': { publisher: "Expresso", labels: ["Expresso"] },
  'prachatai': { publisher: "Prachatai", labels: ["Prachatai"] },
  'scroll': { publisher: "Scroll.in", labels: ["Scroll.in"] },
  'sofia-globe': { publisher: "The Sofia Globe", labels: ["The Sofia Globe"] },
  'biobio': { publisher: "BioBioChile", labels: ["BioBioChile"] },
  'rferl': { publisher: "Radio Free Europe/Radio Liberty", labels: ["RFE/RL Central Asia", "Azadliq Radiosu (RFE/RL - Azerbaijan)", "Radio Azattyk", "Radio Azattyq", "Radio Ozodi", "Radio Azatlyk"] },
  'aljazeera': { publisher: "Al Jazeera", labels: ["Al Jazeera", "Al Jazeera — Micronesia"] },
  'al-arabiya': { publisher: "Al Arabiya English", labels: ["Al Arabiya"] },
  'miit': { publisher: "MIIT (China)", labels: [] },
  'a16z': { publisher: "Andreessen Horowitz", labels: ["a16z Blog", "a16z Insights", "a16z Podcast"] },
  'abc-news': { publisher: "ABC News", labels: [] },
  'acquired': { publisher: "Acquired", labels: ["Acquired Episodes", "Acquired Podcast"] },
  'ap-news': { publisher: "Associated Press", labels: ["AP Mexico", "AP News", "AP — Bahrain", "AP — Comoros", "AP — Denmark", "AP — Dominica", "AP — El Salvador", "AP — Equatorial Guinea", "AP — Eritrea", "AP — Eswatini", "AP — Guinea-Bissau", "AP — Kiribati", "AP — Liechtenstein", "AP — Marshall Islands", "AP — Micronesia", "AP — Montenegro", "AP — Myanmar (Burma)", "AP — Nauru", "AP — North Macedonia", "AP — Palau", "AP — Panama", "AP — Paraguay", "AP — Seychelles", "AP — St. Kitts & Nevis", "AP — St. Vincent & Grenadines", "AP — Suriname", "AP — Tonga", "AP — Trinidad & Tobago", "AP — Tuvalu", "AP — Vanuatu", "AP — Vatican City", "AP — Zambia"] },
  'ars-technica': { publisher: "Ars Technica", labels: [] },
  'arxiv': { publisher: "arXiv", labels: ["ArXiv AI", "ArXiv ML"] },
  'asharq': { publisher: "Asharq News", labels: ["Asharq Business", "Asharq News"] },
  'axios': { publisher: "Axios", labels: [] },
  'bbc': {
    publisher: "BBC",
    labels: ["BBC Africa", "BBC Afrique", "BBC Asia", "BBC Hindi", "BBC Latin America", "BBC Middle East", "BBC Mundo", "BBC Persian", "BBC Russian", "BBC Northern Ireland", "BBC Science", "BBC Turkce", "BBC UK", "BBC World", "BBC — Angola", "BBC — Barbados", "BBC — Central African Republic", "BBC — Comoros", "BBC — Côte d’Ivoire", "BBC — El Salvador", "BBC — Equatorial Guinea", "BBC — Eswatini", "BBC — Kiribati", "BBC — Laos", "BBC — Liechtenstein", "BBC — Micronesia", "BBC — Nauru", "BBC — Tonga", "BBC — Tuvalu", "BBC — Vanuatu", "BBC — Vatican City", "BBC Korean", "BBC News", "BBC News Brasil"],
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
  'business-wire': { publisher: "Business Wire", labels: [] },
  'cb-insights': { publisher: "CB Insights", labels: ["CB Insights", "CB Insights Unicorn"] },
  'chatham-house': { publisher: "Chatham House", labels: ["Chatham House", "Chatham House Tech"] },
  'cnbc': { publisher: "CNBC", labels: ["CNBC", "CNBC Commodities", "CNBC Markets", "CNBC Tech"] },
  'cnn': { publisher: "CNN", labels: ["CNN World"] },
  'csis': { publisher: "CSIS", labels: ["CSIS", "CSIS Tech"] },
  'die-zeit': { publisher: "Die Zeit", labels: [] },
  // feed.koreatimes.co.kr serves items on www.koreatimes.co.kr.
  'korea-times': { publisher: "Korea Times", labels: [] },
  'deutschlandradio': { publisher: "Deutschlandradio", labels: ["Deutschlandfunk"] },
  'dw': { publisher: "Deutsche Welle", labels: ["DW News", "DW Turkish", "DW Brasil"] },
  'eia': { publisher: "US Energy Information Administration", labels: ["EIA Press Room", "EIA Reports"] },
  'el-mundo': { publisher: "El Mundo", labels: [] },
  'el-pais': { publisher: "El País", labels: [] },
  'fao': { publisher: "UN Food and Agriculture Organization", labels: ["FAO GIEWS", "FAO News"] },
  'fast-company': { publisher: "Fast Company", labels: [] },
  'financial-times': { publisher: "Financial Times", labels: ["FT Energy", "Financial Times"] },
  'fox-business': { publisher: "Fox Business", labels: [] },
  'fox-news': { publisher: "Fox News", labels: [] },
  'france-24': { publisher: "France 24", labels: ["France 24", "France 24 Africa", "France 24 Asia Pacific", "France 24 LatAm", "France 24 Français"] },
  'grupo-globo': { publisher: "Grupo Globo", labels: ["G1 Política", "O Globo", "g1", "g1 Mundo"] },
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
    labels: ["Guardian Africa", "Guardian Americas", "Guardian Australia", "Guardian Brazil", "Guardian Caribbean", "Guardian ME", "Guardian Pacific", "Guardian Science", "Guardian World", "Guardian — Angola", "Guardian — Paraguay", "Guardian — Barbados", "Guardian — Bolivia", "Guardian — Kiribati", "Guardian — Laos", "Guardian — Liechtenstein", "Guardian — Marshall Islands", "Guardian — Micronesia", "Guardian — Nauru", "Guardian — Palau", "Guardian — Tuvalu", "Guardian UK"],
  },
  'hacker-news': { publisher: "Hacker News", labels: ["Hacker News", "Show HN", "YC News"] },
  'hromadske': { publisher: "Hromadske", labels: ["Hromadske", "Hromadske EN"] },
  'infoq': { publisher: "InfoQ", labels: [] },
  'interfax': { publisher: "Interfax", labels: ["Interfax EN", "Interfax RU"] },
  'iea': { publisher: "International Energy Agency", labels: ["IEA Critical Minerals", "IEA News"] },
  'kitco': { publisher: "Kitco", labels: ["Kitco Gold", "Kitco News"] },
  'kyiv-independent': { publisher: "The Kyiv Independent", labels: ["Kyiv Independent"] },
  'marketwatch': { publisher: "MarketWatch", labels: ["MarketWatch", "MarketWatch Tech"] },
  'mehr-news': { publisher: "Mehr News Agency", labels: ["Mehr News"] },
  'mit-technology-review': {
    publisher: "MIT Technology Review",
    labels: [
      "MIT Tech Review",
      "MIT Tech Review AI",
    ],
  },
  'nbc-news': { publisher: "NBC News", labels: [] },
  'ndtv': { publisher: "NDTV", labels: ["NDTV", "NDTV India"] },
  'sky-news': { publisher: "Sky News", labels: ["Sky News"] },
  'washington-post': { publisher: "The Washington Post", labels: ["Washington Post World"] },
  'new-york-times': { publisher: "The New York Times", labels: ["Hard Fork (NYT)", "New York Times World"] },
  'new-voice-of-ukraine': { publisher: "The New Voice of Ukraine", labels: ["NV EN"] },
  'ukrainska-pravda': { publisher: "Ukrainska Pravda", labels: ["Ukrainska Pravda", "Ukrainska Pravda EN", "Українська правда"] },
  'propublica': { publisher: "ProPublica", labels: ["ProPublica"] },
  'the-atlantic': { publisher: "The Atlantic", labels: ["The Atlantic"] },
  'channel-4-news': { publisher: "Channel 4 News", labels: ["Channel 4 News"] },
  'nexo-jornal': { publisher: "Nexo Jornal", labels: ["Nexo Jornal"] },
  'le-figaro': { publisher: "Le Figaro", labels: ["Le Figaro"] },
  'lexpress': { publisher: "L'Express", labels: ["L'Express"] },
  'tv5monde': { publisher: "TV5Monde", labels: ["TV5Monde Info"] },
  'news24': { publisher: "News24", labels: [] },
  'nikkei': { publisher: "Nikkei", labels: ["Nikkei Asia", "Nikkei Tech"] },
  'nos': { publisher: "NOS Nieuws", labels: [] },
  'npr': { publisher: "NPR News", labels: ["NPR News", "NPR World"] },
  'pivot': { publisher: "Pivot (Vox Media)", labels: ["Pivot (Vox)", "Pivot Podcast"] },
  'politico': { publisher: "Politico", labels: ["Politico", "Politico Tech"] },
  'reuters': {
    publisher: "Reuters",
    labels: ["Reuters", "Reuters Asia", "Reuters Business", "Reuters Commodities", "Reuters Crypto", "Reuters Energy", "Reuters India", "Reuters LatAm", "Reuters Markets", "Reuters Nasdaq Futures", "Reuters Science", "Reuters US", "Reuters World", "Reuters — Algeria", "Reuters — Andorra", "Reuters — Mali", "Reuters — Benin", "Reuters — Bhutan", "Reuters — Angola", "Reuters — Bahrain", "Reuters — Bolivia", "Reuters — Botswana", "Reuters — Brunei", "Reuters — Bulgaria", "Reuters — Burkina Faso", "Reuters — Burundi", "Reuters — Cameroon", "Reuters — Central African Republic", "Reuters — Chad", "Reuters — Comoros", "Reuters — Congo - Brazzaville", "Reuters — Congo - Kinshasa", "Reuters — Costa Rica", "Reuters — Cuba", "Reuters — Denmark", "Reuters — Djibouti", "Reuters — Dominica", "Reuters — Dominican Republic", "Reuters — Equatorial Guinea", "Reuters — Eritrea", "Reuters — Estonia", "Reuters — Grenada", "Reuters — Guatemala", "Reuters — Guinea", "Reuters — Guinea-Bissau", "Reuters — Guyana", "Reuters — Honduras", "Reuters — Iceland", "Reuters — Jordan", "Reuters — Kiribati", "Reuters — Kuwait", "Reuters — Laos", "Reuters — Lesotho", "Reuters — Liberia", "Reuters — Libya", "Reuters — Maldives", "Reuters — Marshall Islands", "Reuters — Mauritania", "Reuters — Mauritius", "Reuters — Mexico", "Reuters — Monaco", "Reuters — Montenegro", "Reuters — Myanmar (Burma)", "Reuters — Namibia", "Reuters — Nauru", "Reuters — North Korea", "Reuters — Palau", "Reuters — Palestinian Territories", "Reuters — Panama", "Reuters — Papua New Guinea", "Reuters — Paraguay", "Reuters — Portugal", "Reuters — Rwanda", "Reuters — Samoa", "Reuters — Saudi Arabia", "Reuters — Seychelles", "Reuters — Sierra Leone", "Reuters — St. Kitts & Nevis", "Reuters — Sudan", "Reuters — Timor-Leste", "Reuters — Togo", "Reuters — Tonga", "Reuters — Tuvalu", "Reuters — United Arab Emirates", "Reuters — Vatican City", "Reuters — Yemen", "Reuters — Zambia", "Reuters — Zimbabwe"],
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
  // Two titles, one owner: Sightline Media Group (owned by Regent) publishes
  // both Defense News and Military Times, per each site's About page.
  'sightline-media': { publisher: "Sightline Media", labels: ["Defense News", "Military Times"] },
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
  'the-hacker-news': { publisher: "The Hacker News", labels: [] },
  'the-independent': { publisher: "The Independent", labels: ["The Independent"] },
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
  'ukrinform': { publisher: "Ukrinform", labels: ["Ukrinform"] },
  'venturebeat': { publisher: "VentureBeat", labels: ["VentureBeat", "VentureBeat AI"] },
  'white-house': { publisher: "The White House", labels: ["White House", "White House Actions"] },
  // #8398: the feed URL is a Dow Jones delivery host
  // (feeds.content.dowjones.io) but item links point at the publisher apex
  // (wsj.com, per the Dow Jones Investor Select RSS docs). Without this
  // mapping the ingest gate blanks every WSJ link. Domain-only by design:
  // the bare feed label ("Wall Street Journal") keeps its own singleton
  // (failing closed on labels), while the wsj.com domain allowance is
  // declared explicitly in PUBLISHER_FAMILY_DOMAINS below and the ingest
  // gate composes the feed-host leg (dowjones.io) separately. Domain-only
  // families are exempt from the two-label minimum (that rule targets label
  // folding; a domain table entry cannot merge two publishers' counts).
  // Exempted in tests/publisher-families.test.mjs via DOMAIN_ONLY_FAMILIES.
  'wsj': { publisher: "Wall Street Journal", labels: [] },
  // The feed host (feeds.folha.uol.com.br) is not the article host
  // (www1.folha.uol.com.br), so the ingest gate needs the folha.uol.com.br
  // domain for every Folha desk.
  'folha': { publisher: "Folha de S.Paulo", labels: ["Folha de S.Paulo", "Folha Mundo"] },
  'estadao': { publisher: "O Estado de S. Paulo", labels: ["Estadão Política", "Estadão Internacional"] },
  // France Médias Monde runs RFI and France 24 as separate newsrooms; RFI's
  // French feed also lists France 24 pages (catalog linkHosts).
  'rfi': { publisher: "RFI", labels: ["RFI", "RFI Afrique", "RFI Brasil"] },
  // Le Monde Libre controls Le Monde, Courrier international and Le Nouvel Obs.
  'groupe-le-monde': { publisher: "Groupe Le Monde", labels: ["Le Monde", "Le Monde à la une", "Le Monde International", "Courrier international", "Le Nouvel Obs"] },
  'y-combinator': { publisher: "Y Combinator", labels: ["YC Launches", "Y Combinator Blog"] },
  'yahoo-finance': { publisher: "Yahoo Finance", labels: ["Yahoo Finance", "Yahoo Finance Commodities"] },
  'zdf': { publisher: "ZDF", labels: ["ZDFheute"] },
  'kalkine': { publisher: "Kalkine Media", labels: [] },
};

export const PUBLISHER_FAMILIES = Object.freeze(PUBLISHER_FAMILY_DATA);

/**
 * Curated family -> the registrable domains that newsroom publishes on.
 *
 * Feed labels identify a publisher on the digest path; an article that
 * arrives by URL alone (the per-country GDELT index, #7748) carries only its
 * domain, so "BBC World" and bbc.co.uk would otherwise count as two
 * newsrooms for any "N independent publishers" rule. Exact registrable
 * domains only, no fuzzy matching (same fail-closed direction as labels): an
 * unlisted domain stays its own singleton family. Multi-tenant hosts
 * (yahoo.com, ycombinator.com) are deliberately absent because a domain
 * that several publishers share cannot name one.
 */
const PUBLISHER_FAMILY_DOMAINS = Object.freeze({
  'matichon': ['matichon.co.th', 'khaosodenglish.com', 'khaosod.co.th'],
  'n1-danas': ['n1info.hr', 'n1info.ba', 'n1info.rs', 'n1info.si', 'danas.rs'],
  'alpha-media-zimbabwe': ['newsday.co.zw', 'theindependent.co.zw'],
  'rjr-gleaner': ['jamaica-gleaner.com', 'radiojamaicanewsonline.com'],
  'guardian-media-tt': ['guardian.co.tt', 'cnc3.co.tt'],
  'times-of-malta': ['timesofmalta.com'],

  'straits-times': ['straitstimes.com'],

  'gma': ['gmanetwork.com', 'gmanews.tv'],

  'reporter-taiwan': ['twreporter.org'],

  'jyllands-posten': ['jyllands-posten.dk'],

  'rtvslo': ['rtvslo.si'],

  'kyodo': ['kyodonews.net'],

  'orf': ['orf.at'],

  'der-standard': ['derstandard.at'],

  'rtbf': ['rtbf.be'],

  'expresso': ['expresso.pt'],

  'prachatai': ['prachatai.com'],

  'scroll': ['scroll.in'],

  'sofia-globe': ['sofiaglobe.com'],

  'biobio': ['biobiochile.cl'],

  'rferl': ['rferl.org', 'azadliq.org', 'azattyk.org', 'azattyq.org', 'ozodi.org', 'azathabar.com'],

  'aljazeera': ['aljazeera.com'],
  'al-arabiya': ['alarabiya.net'],

  'miit': ['miit.gov.cn'],
  'a16z': ['a16z.com'],
  'abc-news': ['abcnews.com'],
  'ap-news': ['apnews.com'],
  'ars-technica': ['arstechnica.com'],
  'arxiv': ['arxiv.org'],
  'axios': ['axios.com'],
  'bbc': ['bbc.com', 'bbc.co.uk'],
  'bloomberg': ['bloomberg.com'],
  'brookings': ['brookings.edu'],
  'business-wire': ['businesswire.com'],
  'cb-insights': ['cbinsights.com'],
  'chatham-house': ['chathamhouse.org'],
  'cnbc': ['cnbc.com'],
  'cnn': ['cnn.com'],
  'csis': ['csis.org'],
  'die-zeit': ['zeit.de'],
  'korea-times': ['koreatimes.co.kr'],
  'deutschlandradio': ['deutschlandfunk.de'],
  'zdf': ['zdfheute.de', 'zdf.de'],
  'kalkine': ['kalkine.ca'],
  'dw': ['dw.com'],
  'eia': ['eia.gov'],
  'el-mundo': ['elmundo.es'],
  'el-pais': ['elpais.com'],
  'fao': ['fao.org'],
  'fast-company': ['fastcompany.com'],
  'folha': ['folha.uol.com.br'],
  'estadao': ['estadao.com.br'],
  'rfi': ['rfi.fr'],
  'groupe-le-monde': ['lemonde.fr', 'courrierinternational.com', 'nouvelobs.com'],
  'financial-times': ['ft.com'],
  'fox-business': ['foxbusiness.com'],
  'fox-news': ['foxnews.com'],
  'france-24': ['france24.com'],
  'grupo-globo': ['g1.globo.com', 'oglobo.globo.com'],
  'good-news-network': ['goodnewsnetwork.org'],
  'guardian': ['theguardian.com'],
  'hromadske': ['hromadske.ua'],
  'iea': ['iea.org'],
  'infoq': ['infoq.com'],
  'interfax': ['interfax.com', 'interfax.ru'],
  'kitco': ['kitco.com'],
  'kyiv-independent': ['kyivindependent.com'],
  'marketwatch': ['marketwatch.com'],
  'mehr-news': ['mehrnews.com'],
  'mit-technology-review': ['technologyreview.com'],
  'nbc-news': ['nbcnews.com', 'today.com'],
  'ndtv': ['ndtv.com', 'ndtv.in'],
  'sky-news': ['news.sky.com'],
  'washington-post': ['washingtonpost.com'],
  'new-york-times': ['nytimes.com'],
  'new-voice-of-ukraine': ['nv.ua'],
  'ukrainska-pravda': ['pravda.com.ua'],
  'propublica': ['propublica.org'],
  'the-atlantic': ['theatlantic.com'],
  'channel-4-news': ['channel4.com'],
  'nexo-jornal': ['nexojornal.com.br'],
  'le-figaro': ['lefigaro.fr'],
  'lexpress': ['lexpress.fr'],
  'tv5monde': ['tv5monde.com'],
  'news24': ['news24.com'],
  'nikkei': ['nikkei.com'],
  'nos': ['nos.nl'],
  'npr': ['npr.org'],
  'politico': ['politico.com', 'politico.eu'],
  'reuters': ['reuters.com'],
  'rt': ['rt.com', 'rt-english.com'],
  'seeking-alpha': ['seekingalpha.com'],
  'sightline-media': ['defensenews.com', 'militarytimes.com'],
  'sp-global': ['spglobal.com'],
  'techcrunch': ['techcrunch.com'],
  'the-hacker-news': ['thehackernews.com'],
  'the-independent': ['independent.co.uk'],
  'the-verge': ['theverge.com'],
  'ukrinform': ['ukrinform.net', 'ukrinform.ua'],
  'venturebeat': ['venturebeat.com'],
  'white-house': ['whitehouse.gov'],
  // #8398: see the 'wsj' family entry above — the Dow Jones delivery host
  // is not the article host.
  'wsj': ['wsj.com'],
});
export const PUBLISHER_FAMILY_DOMAIN_TABLE = PUBLISHER_FAMILY_DOMAINS;

const familyByDomain = new Map();
for (const [familyId, domains] of Object.entries(PUBLISHER_FAMILY_DOMAINS)) {
  for (const domain of domains) familyByDomain.set(domain, familyId);
}

/**
 * Curated family id for an article host, or '' when no family lists it.
 * Matches the host itself and every parent domain with at least two labels
 * ("www.bbc.co.uk" -> "bbc.co.uk"), so a subdomain edition folds into its
 * newsroom without a public-suffix list.
 *
 * @param {unknown} hostname
 * @returns {string}
 */
export function publisherFamilyForDomain(hostname) {
  if (typeof hostname !== 'string') return '';
  const labels = hostname.trim().toLowerCase().replace(/\.+$/, '').split('.').filter(Boolean);
  for (let start = 0; start <= labels.length - 2; start += 1) {
    const family = familyByDomain.get(labels.slice(start).join('.'));
    if (family) return family;
  }
  return '';
}

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
 * Resolve the publisher family for one parsed digest item.
 *
 * RSS <source> is upstream content and can be forged by a feed. The parser
 * marks it trusted only for an explicitly configured aggregator (currently
 * Google News). All other items use the server-configured feed label, so one
 * hostile feed cannot manufacture independent families by emitting different
 * <source> values.
 *
 * @param {{ source?: unknown; originPublisher?: unknown; originPublisherTrusted?: unknown }} item
 * @returns {string}
 */
export function publisherFamilyForItem(item) {
  const sourceFamily = publisherFamilyFor(item?.source);
  if (item?.originPublisherTrusted !== true) return sourceFamily;
  const originFamily = publisherFamilyFor(item?.originPublisher);
  return originFamily || sourceFamily;
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
