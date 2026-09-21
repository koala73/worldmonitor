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
// the relay only ever sees item-scoped fields, so it gates on the curated
// family table alone and fails closed (blank link) when the family names no
// domains.
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
  'a16z': ['a16z.com'],
  'ap-news': ['apnews.com'],
  'arxiv': ['arxiv.org'],
  'bbc': ['bbc.com', 'bbc.co.uk'],
  'bloomberg': ['bloomberg.com'],
  'brookings': ['brookings.edu'],
  'cb-insights': ['cbinsights.com'],
  'chatham-house': ['chathamhouse.org'],
  'cnbc': ['cnbc.com'],
  'csis': ['csis.org'],
  'dw': ['dw.com'],
  'eia': ['eia.gov'],
  'fao': ['fao.org'],
  'financial-times': ['ft.com'],
  'france-24': ['france24.com'],
  'good-news-network': ['goodnewsnetwork.org'],
  'guardian': ['theguardian.com'],
  'hromadske': ['hromadske.ua'],
  'iea': ['iea.org'],
  'interfax': ['interfax.com', 'interfax.ru'],
  'kitco': ['kitco.com'],
  'marketwatch': ['marketwatch.com'],
  'mit-technology-review': ['technologyreview.com'],
  'ndtv': ['ndtv.com'],
  'nikkei': ['nikkei.com'],
  'politico': ['politico.com', 'politico.eu'],
  'reuters': ['reuters.com'],
  'rt': ['rt.com'],
  'seeking-alpha': ['seekingalpha.com'],
  'sp-global': ['spglobal.com'],
  'techcrunch': ['techcrunch.com'],
  'the-verge': ['theverge.com'],
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
  "bbc persian": "bbc",
  "bbc russian": "bbc",
  "bbc turkce": "bbc",
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
  "csis": "csis",
  "csis tech": "csis",
  "dw news": "dw",
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
  "guardian caribbean": "guardian",
  "guardian me": "guardian",
  "guardian pacific": "guardian",
  "guardian world": "guardian",
  "the guardian": "guardian",
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
  "marketwatch": "marketwatch",
  "marketwatch tech": "marketwatch",
  "mit tech review": "mit-technology-review",
  "mit tech review ai": "mit-technology-review",
  "mit technology review": "mit-technology-review",
  "ndtv": "ndtv",
  "ndtv india": "ndtv",
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
  "reuters us": "reuters",
  "reuters world": "reuters",
  "rt": "rt",
  "rt russia": "rt",
  "seeking alpha": "seeking-alpha",
  "seeking alpha metals": "seeking-alpha",
  "seeking alpha tech": "seeking-alpha",
  "s&p global commodity": "sp-global",
  "s&p global platts": "sp-global",
  "s&p global": "sp-global",
  "techcrunch": "techcrunch",
  "techcrunch layoffs": "techcrunch",
  "techcrunch startups": "techcrunch",
  "techcrunch venture": "techcrunch",
  "decoder (verge)": "the-verge",
  "the verge": "the-verge",
  "the verge ai": "the-verge",
  "the vergecast": "the-verge",
  "verge shows": "the-verge",
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
