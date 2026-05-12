/**
 * International news RSS sources for the Live News feed.
 *
 * Curation principles:
 *   - **Authoritative wires first** (AP, Reuters, AFP via direct or Google):
 *     they break stories before everyone else and are usually the source
 *     other outlets are paraphrasing.
 *   - **International over US-domestic**: Live News is meant to feel like
 *     a global situational-awareness layer, not a US politics feed.
 *     Outlets focused mainly on US domestic politics are excluded.
 *   - **Quality over coverage**: ~15 sources is enough; more outlets just
 *     adds duplicate stories without adding new information.
 *   - **`priority`** orders dedup tie-breaks: when two outlets cover the
 *     same story, the entry from the lower-priority-number source wins.
 *
 * Adding a feed?
 *   1. Verify the URL returns valid RSS/Atom (curl + grep for `<rss` or `<feed`).
 *   2. Add the host to `api/_rss-allowed-domains.js` if not already present.
 *   3. Set `relayOnly: true` if the host blocks Vercel edge IPs.
 *   4. Pick `priority`: 1 for authoritative wires, 2 for top broadcasters,
 *      3 for major papers, 4 for analysis / specialist outlets.
 */

export interface NewsSource {
  /** Human-readable name surfaced in the iOS feed row. */
  name: string;
  /** RSS/Atom feed URL. */
  url: string;
  /**
   * Lower number = higher priority in dedup tie-breaks.
   *   1 = authoritative wires (AP, Reuters)
   *   2 = top international broadcasters (BBC, Al Jazeera, DW)
   *   3 = major newspapers (Guardian, NYT World)
   *   4 = analysis / regional specialists (Foreign Policy, The Diplomat)
   */
  priority: number;
  /**
   * If true, fetch via the Railway relay instead of direct.
   * Used for hosts that block Vercel edge IPs.
   */
  relayOnly?: boolean;
}

export const US_NEWS_SOURCES: readonly NewsSource[] = [
  // ── Tier 2 — Top international broadcasters ──────────────────────────
  // Removed for commercial-usage permissions: AP, Reuters (wires); BBC
  // (World, ME, Africa, Europe — BBC RSS ToS forbids commercial use);
  // CNN, Fox News, NYPost, Times of Israel, Defense News — all carry
  // explicit non-commercial RSS terms or aggressive enforcement history.
  { name: 'Al Jazeera English',   url: 'https://www.aljazeera.com/xml/rss/all.xml',                 priority: 2 },
  { name: 'Deutsche Welle',       url: 'https://rss.dw.com/rdf/rss-en-all',                         priority: 2 },
  { name: 'France 24',            url: 'https://www.france24.com/en/rss',                           priority: 2 },
  { name: 'NHK World',            url: 'https://www3.nhk.or.jp/nhkworld/en/news/feed/rss/',         priority: 2 },
  { name: 'CBC News World',       url: 'https://www.cbc.ca/cmlink/rss-world',                       priority: 2 },
  { name: 'NPR News',             url: 'https://feeds.npr.org/1001/rss.xml',                        priority: 2 },

  // ── Tier 3 — Major papers (international sections) ───────────────────
  // (NYT World removed for commercial-usage permissions.)
  { name: 'The Guardian World',   url: 'https://www.theguardian.com/world/rss',                     priority: 3 },

  // ── Tier 4 — Analysis / regional specialists ─────────────────────────
  // (Foreign Policy removed for commercial-usage permissions.)
  { name: 'The Diplomat',         url: 'https://thediplomat.com/feed/',                             priority: 4 },

  // ── Regional newsdesks (Tier-A conflict-signal lift) ─────────────────
  // Smoke-tested 2026-05-05: returns valid RSS, ~20–40 items each. These
  // give us the granular conflict reporting that the world-feed tier
  // doesn't carry — Gaza shellings, Ukraine front-line moves, Sahel ops.
  { name: 'Guardian Middle East', url: 'https://www.theguardian.com/world/middleeast/rss',           priority: 3 },
  { name: 'France 24 ME',         url: 'https://www.france24.com/en/middle-east/rss',                priority: 2 },

  // ── Regional newsdesks via relay (egress-blocked from Vercel IPs) ────
  // Returns 403 to direct fetches from cloud IPs. Routed through the
  // existing WS_RELAY_URL proxy. If the relay isn't configured for your
  // environment these silently no-op — no error, just an empty feed.
  { name: 'Al Arabiya English',   url: 'https://english.alarabiya.net/.mrss/en.xml',                 priority: 3, relayOnly: true },

  // ── Defense / militant-ops specialty (Tier-B) ────────────────────────
  // High signal-to-noise on conflict and military operations.
  { name: 'Long War Journal',     url: 'https://www.longwarjournal.org/feed',                        priority: 4 },
  { name: 'SOFREP',               url: 'https://sofrep.com/feed/',                                   priority: 4 },
  // SOFX is a Substack-style newsletter; standard `/feed` endpoint exposes
  // RSS. If the host returns non-RSS we'll see it in the feed health logs
  // and can drop the entry; user explicitly noted this one as "not really
  // important" so soft-fail is fine.
  { name: 'SOFX Newsletter',      url: 'https://newsletter.sofx.com/feed',                           priority: 4 },

  // (NYPost removed for commercial-usage permissions — News Corp aggressive.)

  // ── Aggregator backstop (catches breaking before direct feeds update) ─
  { name: 'Google News (World)',  url: 'https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en', priority: 4 },
] as const;

/**
 * Per-feed item cap before global dedup. Higher than before because the
 * source list shrank — each source contributes a larger slice.
 */
export const ITEMS_PER_FEED = 25;

/**
 * Hard cap on the assembled digest. Bumped to 500 (Task 4c) so the iOS
 * feed can show a deeper roster of stories now that filter chips slice
 * the feed by region + topic. The time filter still trims items older
 * than `MAX_AGE_MS`, so this cap only activates during news floods.
 */
export const MAX_ITEMS = 500;

/**
 * Maximum age of items considered fresh enough to appear, used purely as
 * a sanity safeguard against feeds emitting weeks-old archive content.
 *
 * The PRIMARY trim is the `MAX_ITEMS` cap on recency-sorted items — a
 * tight time window was too aggressive for a 180-slot feed and dropped
 * stories users wanted to see. 14 days lets even quieter feeds contribute
 * while still protecting against literal-archive reposts.
 */
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
