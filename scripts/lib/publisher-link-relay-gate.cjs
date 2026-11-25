'use strict';

// Publisher-link gate for relay-emitted RSS events (#8398).
//
// An attacker-controlled RSS item reaches every subscribed user's
// notifications with no account: the platform ingests the item's link
// verbatim, a Railway cron scans it, and the relay fans matching items out
// to every user's rule. Validating at /api/notify does not cover this path
// (relay-emitted events never pass through that endpoint), so the gate also
// lives at each relay-emission site.
//
// Policy: a story link must resolve to the publisher the item claims. The
// link's registrable host must equal the item's feed-label family domain(s)
// or a subdomain of one. The feed URL host (the strongest signal — the
// publisher domain as registered) is composed by the digest-side caller
// (server/worldmonitor/news/v1/list-feed-digest.ts, which knows the feed);
// the relay only ever sees item-scoped fields, so this table gates on the
// curated family domains alone and fails closed (blank link) when the family
// names no domains.
//
// Who still gates on this table:
//   - rss_alert candidates whose digest item carries no `linkVerified` stamp
//     (digest-stale-gate.cjs candidateLinkFor). A stamped item is trusted as
//     the digest verified it; the table is the fallback for a digest or
//     cached feed row built before the stamp shipped, and for a relay
//     deployed ahead of the API.
//   - watchlist story alerts (watchlist-story-events.mjs,
//     watchlist-story-scan.mjs), which read story:track rows, not the digest.
//
// Self-contained on purpose: ais-relay.cjs boots on require, so anything it
// needs must be a dependency-free CJS module importable without side
// effects (same reason digest-stale-gate.cjs lives here). Pure logic is in
// shared/publisher-link-gate.js; this file only wires the curated domain
// table. The family table itself is duplicated from
// shared/publisher-families.js PUBLISHER_FAMILY_DOMAINS — that module is ESM
// (`export`), which the relay's CJS `requireShared` cannot load. The subset
// below covers the families whose feeds emit relay alerts; an unlisted
// family fails closed (blank link, title still alerts).
//
// Keep in sync with PUBLISHER_FAMILY_DOMAINS in shared/publisher-families.js
// (guarded by tests/publisher-link-relay-gate.test.mjs).

const PUBLISHER_LINK_DOMAINS = {
  'matichon': ['matichon.co.th', 'khaosodenglish.com', 'khaosod.co.th'],
  "n1-danas": ["n1info.hr", "n1info.ba", "n1info.rs", "n1info.si", "danas.rs"],
  "alpha-media-zimbabwe": ["newsday.co.zw", "theindependent.co.zw"],
  "rjr-gleaner": ["jamaica-gleaner.com", "radiojamaicanewsonline.com"],
  "guardian-media-tt": ["guardian.co.tt", "cnc3.co.tt"],
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
  'good-news-network': ['goodnewsnetwork.org'],
  'guardian': ['theguardian.com'],
  'grupo-globo': ['g1.globo.com', 'oglobo.globo.com'],
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
  // #8398: Dow Jones delivery host (feeds.content.dowjones.io) serves the
  // feed, but item links point at the publisher apex (wsj.com). Mirrors the
  // domain-only 'wsj' family in shared/publisher-families.js.
  'wsj': ['wsj.com'],
};

function normalizeLinkHostname(hostname) {
  if (typeof hostname !== 'string') return '';
  const cleaned = hostname.trim().toLowerCase().replace(/\.+$/, '');
  if (cleaned.length === 0 || !cleaned.includes('.')) return '';
  return cleaned.replace(/^www\./, '');
}

function linkHostname(link) {
  if (typeof link !== 'string') return '';
  const value = link.trim();
  if (!/^https?:\/\//i.test(value)) return '';
  try {
    return normalizeLinkHostname(new URL(value).hostname);
  } catch {
    return '';
  }
}

function isPublisherLink(link, expectedHosts) {
  const host = linkHostname(link);
  if (!host) return false;
  if (expectedHosts == null || typeof expectedHosts[Symbol.iterator] !== 'function') return false;
  for (const raw of expectedHosts) {
    const expected = normalizeLinkHostname(raw);
    if (!expected) continue;
    if (host === expected || host.endsWith(`.${expected}`)) return true;
  }
  return false;
}

// Curated label -> family id, mirrored from the ESM-only
// shared/publisher-families.js PUBLISHER_FAMILY_DATA (same sync rule as the
// domain table above — guarded by tests/publisher-link-relay-gate.test.mjs).
// Labels are matched exact then case-insensitive; anything else resolves to
// the `label:<name>` singleton namespace, which names no domains and
// therefore blanks at the gate (fail-closed).
const PUBLISHER_LINK_LABELS = {
  "bbc news": "bbc",
  "bbc news brasil": "bbc",
  "dw brasil": "dw",
  "guardian uk": "guardian",
  "g1": "grupo-globo",
  "g1 mundo": "grupo-globo",
  "france 24 français": "france-24",
  "npr world": "npr",
  "folha mundo": "folha",
  "o estado de s. paulo": "estadao",
  "estadão política": "estadao",
  "estadão internacional": "estadao",
  "rfi": "rfi",
  "rfi afrique": "rfi",
  "rfi brasil": "rfi",
  "groupe le monde": "groupe-le-monde",
  "le monde": "groupe-le-monde",
  "le monde à la une": "groupe-le-monde",
  "le monde international": "groupe-le-monde",
  "courrier international": "groupe-le-monde",
  "le nouvel obs": "groupe-le-monde",
  'matichon': 'matichon',
  'matichon group': 'matichon',
  'khaosod english': 'matichon',
  "guardian — paraguay": "guardian",
  "reuters — mali": "reuters",
  "reuters — benin": "reuters",
  "reuters — bhutan": "reuters",
  "n1 and danas": "n1-danas",
  "n1 croatia": "n1-danas",
  "n1 bosna i hercegovina": "n1-danas",
  "n1 info": "n1-danas",
  "n1 slovenia": "n1-danas",
  "danas": "n1-danas",

  "alpha media holdings": "alpha-media-zimbabwe",
  "newsday zimbabwe": "alpha-media-zimbabwe",
  "the zimbabwe independent": "alpha-media-zimbabwe",

  "rjrgleaner": "rjr-gleaner",
  "the gleaner": "rjr-gleaner",
  "radio jamaica news": "rjr-gleaner",

  "guardian media trinidad and tobago": "guardian-media-tt",
  "trinidad guardian": "guardian-media-tt",
  "cnc3": "guardian-media-tt",

  "times of malta": "times-of-malta",
  "straits times": "straits-times",
  "the straits times": "straits-times",
  "gma news": "gma",
  "the reporter": "reporter-taiwan",
  "jyllands-posten": "jyllands-posten",
  "rtv slovenija": "rtvslo",
  "japan wire by kyodo news": "kyodo",
  "kyodo news": "kyodo",
  "orf.at": "orf",
  "orf": "orf",
  "der standard": "der-standard",
  "rtbf info": "rtbf",
  "rtbf": "rtbf",
  "expresso": "expresso",
  "prachatai": "prachatai",
  "scroll.in": "scroll",
  "the sofia globe": "sofia-globe",
  "biobiochile": "biobio",
  "radio azatlyk": "rferl",
  "radio ozodi": "rferl",
  "radio azattyq": "rferl",
  "radio azattyk": "rferl",
  "azadliq radiosu (rfe/rl - azerbaijan)": "rferl",
  "rfe/rl central asia": "rferl",
  "radio free europe/radio liberty": "rferl",
  "al jazeera": "aljazeera",
  "al arabiya": "al-arabiya",
  "al arabiya english": "al-arabiya",
  "reuters — zimbabwe": "reuters",
  "reuters — zambia": "reuters",
  "reuters — yemen": "reuters",
  "reuters — vatican city": "reuters",
  "reuters — united arab emirates": "reuters",
  "reuters — tuvalu": "reuters",
  "reuters — tonga": "reuters",
  "reuters — togo": "reuters",
  "reuters — timor-leste": "reuters",
  "reuters — sudan": "reuters",
  "reuters — st. kitts & nevis": "reuters",
  "reuters — sierra leone": "reuters",
  "reuters — seychelles": "reuters",
  "reuters — saudi arabia": "reuters",
  "reuters — samoa": "reuters",
  "reuters — rwanda": "reuters",
  "reuters — portugal": "reuters",
  "reuters — paraguay": "reuters",
  "reuters — papua new guinea": "reuters",
  "reuters — panama": "reuters",
  "reuters — palestinian territories": "reuters",
  "reuters — palau": "reuters",
  "reuters — north korea": "reuters",
  "reuters — nauru": "reuters",
  "reuters — namibia": "reuters",
  "reuters — myanmar (burma)": "reuters",
  "reuters — montenegro": "reuters",
  "reuters — monaco": "reuters",
  "reuters — mexico": "reuters",
  "reuters — mauritius": "reuters",
  "reuters — mauritania": "reuters",
  "reuters — marshall islands": "reuters",
  "reuters — maldives": "reuters",
  "reuters — libya": "reuters",
  "reuters — liberia": "reuters",
  "reuters — lesotho": "reuters",
  "reuters — laos": "reuters",
  "reuters — kuwait": "reuters",
  "reuters — kiribati": "reuters",
  "reuters — jordan": "reuters",
  "reuters — iceland": "reuters",
  "reuters — honduras": "reuters",
  "reuters — guyana": "reuters",
  "reuters — guinea-bissau": "reuters",
  "reuters — guinea": "reuters",
  "reuters — guatemala": "reuters",
  "reuters — grenada": "reuters",
  "reuters — estonia": "reuters",
  "reuters — eritrea": "reuters",
  "reuters — equatorial guinea": "reuters",
  "reuters — dominican republic": "reuters",
  "reuters — dominica": "reuters",
  "reuters — djibouti": "reuters",
  "reuters — denmark": "reuters",
  "reuters — cuba": "reuters",
  "reuters — costa rica": "reuters",
  "reuters — congo - kinshasa": "reuters",
  "reuters — congo - brazzaville": "reuters",
  "reuters — comoros": "reuters",
  "reuters — chad": "reuters",
  "reuters — central african republic": "reuters",
  "reuters — cameroon": "reuters",
  "reuters — burundi": "reuters",
  "reuters — burkina faso": "reuters",
  "reuters — bulgaria": "reuters",
  "reuters — brunei": "reuters",
  "reuters — botswana": "reuters",
  "reuters — bolivia": "reuters",
  "reuters — bahrain": "reuters",
  "reuters — angola": "reuters",
  "reuters — andorra": "reuters",
  "reuters — algeria": "reuters",
  "guardian — tuvalu": "guardian",
  "guardian — palau": "guardian",
  "guardian — nauru": "guardian",
  "guardian — micronesia": "guardian",
  "guardian — marshall islands": "guardian",
  "guardian — liechtenstein": "guardian",
  "guardian — laos": "guardian",
  "guardian — kiribati": "guardian",
  "guardian — bolivia": "guardian",
  "guardian — barbados": "guardian",
  "guardian — angola": "guardian",
  "bbc korean": "bbc",
  "bbc — vatican city": "bbc",
  "bbc — vanuatu": "bbc",
  "bbc — tuvalu": "bbc",
  "bbc — tonga": "bbc",
  "bbc — nauru": "bbc",
  "bbc — micronesia": "bbc",
  "bbc — liechtenstein": "bbc",
  "bbc — laos": "bbc",
  "bbc — kiribati": "bbc",
  "bbc — eswatini": "bbc",
  "bbc — equatorial guinea": "bbc",
  "bbc — el salvador": "bbc",
  "bbc — côte d’ivoire": "bbc",
  "bbc — comoros": "bbc",
  "bbc — central african republic": "bbc",
  "bbc — barbados": "bbc",
  "bbc — angola": "bbc",
  "al jazeera — micronesia": "aljazeera",
  "ap — zambia": "ap-news",
  "ap — vatican city": "ap-news",
  "ap — vanuatu": "ap-news",
  "ap — tuvalu": "ap-news",
  "ap — trinidad & tobago": "ap-news",
  "ap — tonga": "ap-news",
  "ap — suriname": "ap-news",
  "ap — st. vincent & grenadines": "ap-news",
  "ap — st. kitts & nevis": "ap-news",
  "ap — seychelles": "ap-news",
  "ap — paraguay": "ap-news",
  "ap — panama": "ap-news",
  "ap — palau": "ap-news",
  "ap — north macedonia": "ap-news",
  "ap — nauru": "ap-news",
  "ap — myanmar (burma)": "ap-news",
  "ap — montenegro": "ap-news",
  "ap — micronesia": "ap-news",
  "ap — marshall islands": "ap-news",
  "ap — liechtenstein": "ap-news",
  "ap — kiribati": "ap-news",
  "ap — guinea-bissau": "ap-news",
  "ap — eswatini": "ap-news",
  "ap — eritrea": "ap-news",
  "ap — equatorial guinea": "ap-news",
  "ap — el salvador": "ap-news",
  "ap — dominica": "ap-news",
  "ap — denmark": "ap-news",
  "ap — comoros": "ap-news",
  "ap — bahrain": "ap-news",
  "miit (china)": "miit",
  "a16z blog": "a16z",
  "a16z insights": "a16z",
  "a16z podcast": "a16z",
  "andreessen horowitz": "a16z",
  "acquired episodes": "acquired",
  "acquired podcast": "acquired",
  "acquired": "acquired",
  "ap mexico": "ap-news",
  "ap news": "ap-news",
  "associated press": "ap-news",
  "arxiv ai": "arxiv",
  "arxiv ml": "arxiv",
  "arxiv": "arxiv",
  "asharq business": "asharq",
  "asharq news": "asharq",
  "bbc africa": "bbc",
  "bbc afrique": "bbc",
  "bbc asia": "bbc",
  "bbc hindi": "bbc",
  "bbc latin america": "bbc",
  "bbc middle east": "bbc",
  "bbc mundo": "bbc",
  "bbc northern ireland": "bbc",
  "bbc persian": "bbc",
  "bbc russian": "bbc",
  "bbc science": "bbc",
  "bbc turkce": "bbc",
  "bbc uk": "bbc",
  "bbc world": "bbc",
  "bbc": "bbc",
  "bloomberg": "bloomberg",
  "bloomberg commodities": "bloomberg",
  "bloomberg crypto": "bloomberg",
  "bloomberg energy": "bloomberg",
  "bloomberg markets": "bloomberg",
  "brookings": "brookings",
  "brookings tech": "brookings",
  "brookings institution": "brookings",
  "cb insights": "cb-insights",
  "cb insights unicorn": "cb-insights",
  "chatham house": "chatham-house",
  "chatham house tech": "chatham-house",
  "cnbc": "cnbc",
  "cnbc commodities": "cnbc",
  "cnbc markets": "cnbc",
  "cnbc tech": "cnbc",
  "cnn": "cnn",
  "cnn world": "cnn",
  "csis": "csis",
  "csis tech": "csis",
  "dw news": "dw",
  "deutschlandfunk": "deutschlandradio",
  "zdfheute": "zdf",
  "dw turkish": "dw",
  "deutsche welle": "dw",
  "eia press room": "eia",
  "eia reports": "eia",
  "us energy information administration": "eia",
  "fao giews": "fao",
  "fao news": "fao",
  "un food and agriculture organization": "fao",
  "ft energy": "financial-times",
  "financial times": "financial-times",
  "france 24": "france-24",
  "france 24 africa": "france-24",
  "france 24 asia pacific": "france-24",
  "france 24 latam": "france-24",
  "gnn animals": "good-news-network",
  "gnn earth": "good-news-network",
  "gnn health": "good-news-network",
  "gnn heroes": "good-news-network",
  "gnn heroes spotlight": "good-news-network",
  "gnn science": "good-news-network",
  "good news network": "good-news-network",
  "guardian africa": "guardian",
  "guardian americas": "guardian",
  "guardian australia": "guardian",
  "guardian brazil": "guardian",
  "guardian caribbean": "guardian",
  "guardian me": "guardian",
  "guardian pacific": "guardian",
  "guardian science": "guardian",
  "guardian world": "guardian",
  "the guardian": "guardian",
  "g1 política": "grupo-globo",
  "o globo": "grupo-globo",
  "grupo globo": "grupo-globo",
  "hacker news": "hacker-news",
  "show hn": "hacker-news",
  "yc news": "hacker-news",
  "hromadske": "hromadske",
  "hromadske en": "hromadske",
  "interfax en": "interfax",
  "interfax ru": "interfax",
  "interfax": "interfax",
  "iea critical minerals": "iea",
  "iea news": "iea",
  "international energy agency": "iea",
  "kitco gold": "kitco",
  "kitco news": "kitco",
  "kitco": "kitco",
  "kyiv independent": "kyiv-independent",
  "the kyiv independent": "kyiv-independent",
  "marketwatch": "marketwatch",
  "marketwatch tech": "marketwatch",
  "mehr news": "mehr-news",
  "mehr news agency": "mehr-news",
  "mit tech review": "mit-technology-review",
  "mit tech review ai": "mit-technology-review",
  "mit technology review": "mit-technology-review",
  "ndtv": "ndtv",
  "ndtv india": "ndtv",
  "sky news": "sky-news",
  "the washington post": "washington-post",
  "washington post world": "washington-post",
  "hard fork (nyt)": "new-york-times",
  "new york times world": "new-york-times",
  "the new york times": "new-york-times",
  "nv en": "new-voice-of-ukraine",
  "the new voice of ukraine": "new-voice-of-ukraine",
  "ukrainska pravda": "ukrainska-pravda",
  "ukrainska pravda en": "ukrainska-pravda",
  "propublica": "propublica",
  "the atlantic": "the-atlantic",
  "channel 4 news": "channel-4-news",
  "nexo jornal": "nexo-jornal",
  "le figaro": "le-figaro",
  "l'express": "lexpress",
  "tv5monde info": "tv5monde",
  "nikkei asia": "nikkei",
  "nikkei tech": "nikkei",
  "nikkei": "nikkei",
  "pivot (vox)": "pivot",
  "pivot podcast": "pivot",
  "pivot (vox media)": "pivot",
  "politico": "politico",
  "politico tech": "politico",
  "reuters": "reuters",
  "reuters asia": "reuters",
  "reuters business": "reuters",
  "reuters commodities": "reuters",
  "reuters crypto": "reuters",
  "reuters energy": "reuters",
  "reuters india": "reuters",
  "reuters latam": "reuters",
  "reuters markets": "reuters",
  "reuters nasdaq futures": "reuters",
  "reuters science": "reuters",
  "reuters us": "reuters",
  "reuters world": "reuters",
  "rt": "rt",
  "rt russia": "rt",
  "seeking alpha": "seeking-alpha",
  "seeking alpha metals": "seeking-alpha",
  "seeking alpha tech": "seeking-alpha",
  "defense news": "sightline-media",
  "military times": "sightline-media",
  "sightline media": "sightline-media",
  "s&p global commodity": "sp-global",
  "s&p global platts": "sp-global",
  "s&p global": "sp-global",
  "techcrunch": "techcrunch",
  "techcrunch layoffs": "techcrunch",
  "techcrunch startups": "techcrunch",
  "techcrunch venture": "techcrunch",
  "the independent": "the-independent",
  "decoder (verge)": "the-verge",
  "the verge": "the-verge",
  "the verge ai": "the-verge",
  "the vergecast": "the-verge",
  "verge shows": "the-verge",
  "ukrinform": "ukrinform",
  "venturebeat": "venturebeat",
  "venturebeat ai": "venturebeat",
  "white house": "white-house",
  "white house actions": "white-house",
  "the white house": "white-house",
  "yc launches": "y-combinator",
  "y combinator blog": "y-combinator",
  "y combinator": "y-combinator",
  "yahoo finance": "yahoo-finance",
  "yahoo finance commodities": "yahoo-finance",
  // #8398: publisher-name index for the domain-only 'wsj' family (mirrors
  // the #6430 publisher-name indexing in shared/publisher-families.js).
  // The bare feed label "Wall Street Journal" intentionally stays a
  // singleton — only the publisher NAME resolves here.
  "wall street journal": "wsj",
  // Domain-only 'folha' family: feed host feeds.folha.uol.com.br, article
  // host www1.folha.uol.com.br.
  "folha de s.paulo": "folha",
  // Publisher-name index for the domain-only families whose feeds come from a
  // delivery host (feeds.npr.org, moxie.foxnews.com, feeds.feedburner.com ...).
  "abc news": "abc-news",
  "ars technica": "ars-technica",
  "axios": "axios",
  "business wire": "business-wire",
  "die zeit": "die-zeit",
  "korea times": "korea-times",
  "el mundo": "el-mundo",
  "el país": "el-pais",
  "fast company": "fast-company",
  "fox business": "fox-business",
  "fox news": "fox-news",
  "infoq": "infoq",
  "nbc news": "nbc-news",
  "news24": "news24",
  "nos nieuws": "nos",
  "npr news": "npr",
  "the hacker news": "the-hacker-news",
};

/**
 * Resolve a feed label (or family id, or publisher name) to a curated
 * family id, mirroring publisherFamilyFor's fail-closed contract: exact,
 * then case-insensitive, else the `label:<name>` singleton (which names no
 * domains). A curated family id passes through unchanged.
 *
 * @param {unknown} label
 * @returns {string} '' for blank/non-string input
 */
function familyForLabel(label) {
  if (typeof label !== 'string') return '';
  const trimmed = label.trim();
  if (trimmed.length === 0) return '';
  if (Object.hasOwn(PUBLISHER_LINK_DOMAINS, trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  return PUBLISHER_LINK_LABELS[lower] ?? `label:${lower}`;
}

/**
 * Gate a relay-emitted story link to the item's publisher family domains.
 * Returns the link unchanged when it belongs to the publisher, '' otherwise
 * (fail-closed: the title still alerts, but no hostile link rides along).
 * Unlisted families and empty links both yield '' — an unmapped label is
 * never silently folded into an existing publisher (same fail-closed
 * direction as publisherFamilyFor).
 *
 * `familyId` accepts the curated family id, a feed LABEL (resolved through
 * the label map — the relay only ever sees labels, not family ids), or a
 * `label:` singleton. Unknown labels resolve to their singleton namespace,
 * which names no domains, so they blank — fail-closed.
 *
 * @param {unknown} link the story's article URL
 * @param {unknown} familyOrLabel curated family id or feed label
 * @returns {string}
 */
function gateRelayStoryLink(link, familyOrLabel) {
  if (typeof link !== 'string' || link.length === 0) return '';
  const family = familyForLabel(familyOrLabel);
  if (!family) return '';
  const domains = PUBLISHER_LINK_DOMAINS[family];
  if (!Array.isArray(domains) || domains.length === 0) return '';
  return isPublisherLink(link, domains) ? link : '';
}

module.exports = {
  gateRelayStoryLink,
  familyForLabel,
  PUBLISHER_LINK_DOMAINS,
  PUBLISHER_LINK_LABELS,
  // Exposed for unit tests (contract parity with shared/publisher-link-gate.js).
  normalizeLinkHostname,
  linkHostname,
  isPublisherLink,
};
