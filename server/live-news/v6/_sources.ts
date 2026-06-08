/**
 * v6 RSS source list — broader corpus than v1, for the
 * "RSS + Gemini embeddings" pipeline only.
 *
 * # Why a separate list
 *
 * v1's source list is intentionally narrow (15 feeds) because the
 * legacy pipeline runs LLM dedup over every cross-feed item — cost
 * scales with feed count. v6 uses cheap Gemini embedding clustering,
 * so we can afford ~130 feeds without blowing the budget. The wider
 * corpus also produces tighter clusters (more outlets covering the
 * same story → richer `sources[]` arrays for iOS).
 *
 * # Inclusion rules
 *
 * Sourced from /Users/ozan/Downloads/world_monitor_rss_feeds.md:
 *   - Outlets with EXPLICIT RSS-specific non-commercial clauses
 *     (CNN, NPR, Fox News, Al Jazeera) are EXCLUDED.
 *   - Outlets with boilerplate "personal use" language in their
 *     general site TOS are INCLUDED (the MD's pragmatic stance).
 *   - Paywalled outlets (NYT, WaPo, WSJ, FT, etc.) are INCLUDED at
 *     priority 5 so they contribute to clustering signal but never
 *     become the visible cluster canonical — iOS users see the free
 *     outlet's headline instead. The paywall is the publisher's
 *     concern when users tap through.
 *
 * # Priority tiers (lower number = preferred canonical)
 *
 *   2 = Top broadcasters (BBC, DW, France 24, major US/UK/CA TV)
 *   3 = Major newspapers + national digital (Guardian, Sky News,
 *       Independent, USA Today, ABC AU, CTV, Global News, etc.)
 *   4 = Regional / specialist / digital natives (Politico, Axios,
 *       ProPublica, regional Canadian papers, smaller outlets)
 *   5 = Paywalled — never canonical
 *
 * # Per-feed concerns
 *
 *   - Daily Mail / Telegraph / some CBC require a real User-Agent —
 *     handled by _normalize.ts (we send a browser-ish UA).
 *   - Atom vs RSS 2.0 — handled by the regex parser (both flows).
 *   - 5–10 % of feeds may 403/404 at any moment; per-feed try/catch
 *     means one broken feed doesn't sink the refresh.
 *
 * # 2026-05-15 cleanup
 *
 * Dropped 40 feeds after a description-quality + reachability audit
 * + Vercel egress observation:
 *   - Non-XML / Cloudflare HTML interstitials: USA Today (×3), Halifax
 *     Chronicle Herald
 *   - HTTP-403 to cloud egress: Maclean's, Politico (×3), Telegraph
 *     World, The Tyee, Toronto Star, Axios
 *   - HTTP-404 (URLs gone): CTV (×5), Global News Business, ABC News
 *     (AU) World, NYT National, ITV News, NZ Herald, Washington Post
 *     Tech, Newsweek
 *   - JUNK content for clustering: Google News (multi-outlet concat),
 *     The Telegraph (/rss.xml — title==description repeat)
 *   - TITLE-ONLY (paywalled, empty descriptions): Globe and Mail
 *     World, The Economist
 *   - Montreal Gazette /feed/ — GlobeNewswire PR firehose, not editorial
 *   - Hang-on-Vercel-egress (always abort at 30s budget cap):
 *     Washington Post (×4), CBC (×7). Bring back via the Railway
 *     relay if v6's _normalize.ts gets relayOnly support.
 *
 * # 2026-05-15 entertainment cleanup
 *
 * Dropped 10 feeds whose celebrity/lifestyle content was polluting
 * the news-tier clusters (entertainment stories share semantic space
 * with politics-of-celebrities content, dragging unrelated items
 * together):
 *   - 100% entertainment: BBC Entertainment
 *   - UK red-tops / celeb-heavy tabloids: The Sun, Daily Mirror (×2),
 *     Daily Mail (×2), Metro UK
 *   - US tabloids: The Daily Beast, NY Post
 *   - Canadian tabloid: Toronto Sun News
 */

export interface NewsSource {
  /** Human-readable name surfaced in the iOS feed row. */
  name: string;
  /** RSS/Atom feed URL. */
  url: string;
  /**
   * Lower number = higher priority in cluster canonical tie-breaks.
   *   2 = top broadcasters
   *   3 = major newspapers / national digital
   *   4 = regional / specialist / digital native
   *   5 = paywalled (never canonical — clustering signal only)
   */
  priority: number;
}

/** Per-feed cap on items parsed each refresh. v1's value, sized for
 *  typical major-outlet feeds (BBC ~30/day, Guardian ~45/day). */
export const ITEMS_PER_FEED = 25;

/** Drop items older than 30h before they enter the pipeline. The digest's
 *  rolling window is 24h, so anything older is embedded + clustered and then
 *  thrown away at merge — wasted Gemini calls, CPU, and Redis embedding
 *  churn. 30h aligns ingest with the digest window plus a 6h buffer (lets a
 *  slightly-older item still corroborate a live cluster) while cutting the
 *  per-run item count. */
export const MAX_AGE_MS = 30 * 60 * 60 * 1000;

/**
 * The v6 corpus. ~145 feeds across world/US/UK/Canada/AU-NZ-IE plus
 * specialist intel-category feeds and paywalled premium tier. See header
 * comment for inclusion rules.
 */
export const V6_NEWS_SOURCES: readonly NewsSource[] = [
  // ────────────────────────────────────────────────────────────────────
  // World / International — broadcasters
  // ────────────────────────────────────────────────────────────────────
  { name: 'BBC World',              url: 'https://feeds.bbci.co.uk/news/world/rss.xml',                       priority: 2 },
  { name: 'BBC International',      url: 'https://feeds.bbci.co.uk/news/rss.xml?edition=int',                 priority: 2 },
  { name: 'BBC Africa',             url: 'https://feeds.bbci.co.uk/news/world/africa/rss.xml',                priority: 2 },
  { name: 'BBC Asia',               url: 'https://feeds.bbci.co.uk/news/world/asia/rss.xml',                  priority: 2 },
  { name: 'BBC Europe',             url: 'https://feeds.bbci.co.uk/news/world/europe/rss.xml',                priority: 2 },
  { name: 'BBC Latin America',      url: 'https://feeds.bbci.co.uk/news/world/latin_america/rss.xml',         priority: 2 },
  { name: 'BBC Middle East',        url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml',           priority: 2 },
  { name: 'BBC US & Canada',        url: 'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml',         priority: 2 },
  { name: 'BBC Australia',          url: 'https://feeds.bbci.co.uk/news/world/australia/rss.xml',             priority: 2 },
  { name: 'BBC Business',           url: 'https://feeds.bbci.co.uk/news/business/rss.xml',                    priority: 2 },
  { name: 'BBC Technology',         url: 'https://feeds.bbci.co.uk/news/technology/rss.xml',                  priority: 2 },
  { name: 'BBC Science',            url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',     priority: 2 },
  { name: 'BBC Health',             url: 'https://feeds.bbci.co.uk/news/health/rss.xml',                      priority: 2 },

  
  { name: 'France 24',              url: 'https://www.france24.com/en/rss',                                   priority: 2 },
  { name: 'DW (all English)',       url: 'https://rss.dw.com/rdf/rss-en-all',                                 priority: 2 },
  { name: 'DW Top Stories',         url: 'https://rss.dw.com/xml/rss-en-top',                                 priority: 2 },
  { name: 'DW World',               url: 'https://rss.dw.com/rdf/rss-en-world',                               priority: 2 },
  { name: 'Euronews',               url: 'https://www.euronews.com/rss?level=theme&name=news',                priority: 2 },
  { name: 'Der Spiegel International', url: 'https://www.spiegel.de/international/index.rss',                 priority: 2 },
  { name: 'RFI English International', url: 'https://www.rfi.fr/en/international/rss',                        priority: 2 },
  { name: 'Sky News World',         url: 'https://feeds.skynews.com/feeds/rss/world.xml',                     priority: 2 },
  { name: 'ABC News International', url: 'https://abcnews.go.com/abcnews/internationalheadlines',             priority: 2 },

  { name: 'The Guardian World',     url: 'https://www.theguardian.com/world/rss',                             priority: 3 },
  { name: 'The Guardian International', url: 'https://www.theguardian.com/international/rss',                 priority: 3 },
  { name: 'The Diplomat',           url: 'https://thediplomat.com/feed/',                                     priority: 4 },

  // ────────────────────────────────────────────────────────────────────
  // United States — network broadcasters + national digital
  // ────────────────────────────────────────────────────────────────────
  { name: 'NBC News',               url: 'https://feeds.nbcnews.com/nbcnews/public/news',                     priority: 2 },
  { name: 'NBC World',              url: 'https://feeds.nbcnews.com/feeds/worldnews',                         priority: 2 },
  { name: 'CBS News',               url: 'https://www.cbsnews.com/latest/rss/main',                           priority: 2 },
  { name: 'CBS US',                 url: 'https://www.cbsnews.com/latest/rss/us',                             priority: 2 },
  { name: 'CBS World',              url: 'https://www.cbsnews.com/latest/rss/world',                          priority: 2 },
  { name: 'CBS Politics',           url: 'https://www.cbsnews.com/latest/rss/politics',                       priority: 2 },
  { name: 'ABC News (US)',          url: 'https://abcnews.go.com/abcnews/topstories',                         priority: 2 },
  { name: 'ABC Politics (US)',      url: 'https://abcnews.go.com/abcnews/politicsheadlines',                  priority: 2 },
  { name: 'ABC US Headlines',       url: 'https://abcnews.go.com/abcnews/usheadlines',                        priority: 2 },
  { name: 'PBS NewsHour',           url: 'https://www.pbs.org/newshour/feeds/rss/headlines',                  priority: 2 },
  { name: 'PBS Politics',           url: 'https://www.pbs.org/newshour/feeds/rss/politics',                   priority: 2 },

  { name: 'LA Times Local',         url: 'https://www.latimes.com/local/rss2.0.xml',                          priority: 3 },
  { name: 'LA Times World',         url: 'https://www.latimes.com/world/rss2.0.xml',                          priority: 3 },
  { name: 'HuffPost US',            url: 'https://chaski.huffpost.com/us/auto/vertical/us-news',              priority: 4 },
  { name: 'HuffPost World',         url: 'https://chaski.huffpost.com/us/auto/vertical/world-news',           priority: 4 },
  { name: 'The Hill',               url: 'https://thehill.com/homenews/feed/',                                priority: 4 },
  { name: 'Vox World Politics',     url: 'https://www.vox.com/rss/world-politics/index.xml',                  priority: 4 },
  { name: 'Slate News & Politics',  url: 'https://slate.com/feeds/news-and-politics.rss',                     priority: 4 },
  { name: 'Time',                   url: 'https://feeds.feedburner.com/time/topstories',                      priority: 3 },
  { name: 'ProPublica',             url: 'https://www.propublica.org/feeds/propublica/main',                  priority: 4 },
  { name: 'The Intercept',          url: 'https://theintercept.com/feed/?lang=en',                            priority: 4 },

  // ────────────────────────────────────────────────────────────────────
  // United Kingdom
  // ────────────────────────────────────────────────────────────────────
  { name: 'BBC UK',                 url: 'https://feeds.bbci.co.uk/news/uk/rss.xml',                          priority: 2 },
  { name: 'BBC UK Politics',        url: 'https://feeds.bbci.co.uk/news/politics/rss.xml',                    priority: 2 },
  { name: 'BBC England',            url: 'https://feeds.bbci.co.uk/news/england/rss.xml',                     priority: 2 },
  { name: 'BBC Scotland',           url: 'https://feeds.bbci.co.uk/news/scotland/rss.xml',                    priority: 2 },
  { name: 'BBC Wales',              url: 'https://feeds.bbci.co.uk/news/wales/rss.xml',                       priority: 2 },
  { name: 'BBC Northern Ireland',   url: 'https://feeds.bbci.co.uk/news/northern_ireland/rss.xml',            priority: 2 },

  { name: 'The Guardian UK',        url: 'https://www.theguardian.com/uk/rss',                                priority: 3 },
  { name: 'The Guardian Politics',  url: 'https://www.theguardian.com/politics/rss',                          priority: 3 },
  { name: 'The Guardian Business',  url: 'https://www.theguardian.com/uk/business/rss',                       priority: 3 },
  { name: 'The Guardian Tech',      url: 'https://www.theguardian.com/uk/technology/rss',                     priority: 3 },
  { name: 'The Guardian Science',   url: 'https://www.theguardian.com/science/rss',                           priority: 3 },

  { name: 'Sky News',               url: 'https://feeds.skynews.com/feeds/rss/home.xml',                      priority: 2 },
  { name: 'Sky News UK',            url: 'https://feeds.skynews.com/feeds/rss/uk.xml',                        priority: 2 },
  { name: 'Sky News Politics',      url: 'https://feeds.skynews.com/feeds/rss/politics.xml',                  priority: 2 },
  { name: 'Sky News Business',      url: 'https://feeds.skynews.com/feeds/rss/business.xml',                  priority: 2 },

  { name: 'The Independent UK',     url: 'https://www.independent.co.uk/news/uk/rss',                         priority: 3 },
  { name: 'The Independent World',  url: 'https://www.independent.co.uk/news/world/rss',                      priority: 3 },
  { name: 'The Independent Politics', url: 'https://www.independent.co.uk/news/uk/politics/rss',              priority: 3 },
  { name: 'Daily Express',          url: 'https://www.express.co.uk/posts/rss/1/news',                        priority: 4 },
  { name: 'Evening Standard',       url: 'https://www.standard.co.uk/news/rss',                               priority: 4 },
  { name: 'Channel 4 News',         url: 'https://www.channel4.com/news/feed',                                priority: 3 },
  { name: 'Politics.co.uk',         url: 'https://www.politics.co.uk/feed/',                                  priority: 4 },

  // ────────────────────────────────────────────────────────────────────
  // Canada
  //
  // CBC dropped 2026-05-15 — Vercel egress consistently times out on
  // every CBC sub-feed (TLS or origin-side bot detection). Routing
  // through the Railway relay would bring them back but the v6
  // normalizer doesn't honor relayOnly yet.
  // ────────────────────────────────────────────────────────────────────

  { name: 'Global News',            url: 'https://globalnews.ca/feed/',                                       priority: 3 },
  { name: 'Global News World',      url: 'https://globalnews.ca/world/feed/',                                 priority: 3 },
  { name: 'Global News Canada',     url: 'https://globalnews.ca/canada/feed/',                                priority: 3 },
  { name: 'Global News Politics',   url: 'https://globalnews.ca/politics/feed/',                              priority: 3 },

  { name: 'National Post',          url: 'https://nationalpost.com/feed/',                                    priority: 3 },
  { name: 'Ottawa Citizen',         url: 'https://ottawacitizen.com/feed/',                                   priority: 4 },
  { name: 'Vancouver Sun',          url: 'https://vancouversun.com/feed/',                                    priority: 4 },
  { name: 'The Province',           url: 'https://theprovince.com/feed/',                                     priority: 4 },
  { name: 'Calgary Herald',         url: 'https://calgaryherald.com/feed/',                                   priority: 4 },
  { name: 'Edmonton Journal',       url: 'https://edmontonjournal.com/feed/',                                 priority: 4 },
  { name: 'Winnipeg Free Press',    url: 'https://www.winnipegfreepress.com/rss/',                            priority: 4 },
  { name: 'Times Colonist',         url: 'https://www.timescolonist.com/rss',                                 priority: 4 },
  { name: 'National Observer',      url: 'https://www.nationalobserver.com/front/rss',                        priority: 4 },

  // ────────────────────────────────────────────────────────────────────
  // Australia / NZ / Ireland — non-Anglo angles for true "world" coverage
  // ────────────────────────────────────────────────────────────────────
  { name: 'ABC News (AU)',          url: 'https://www.abc.net.au/news/feed/45910/rss.xml',                    priority: 2 },
  { name: 'ABC News (AU) Just In',  url: 'https://www.abc.net.au/news/feed/51120/rss.xml',                    priority: 2 },
  { name: 'Sydney Morning Herald',  url: 'https://www.smh.com.au/rss/feed.xml',                               priority: 3 },
  { name: 'The Age',                url: 'https://www.theage.com.au/rss/feed.xml',                            priority: 3 },
  { name: 'The Guardian Australia', url: 'https://www.theguardian.com/au/rss',                                priority: 3 },
  { name: 'News.com.au',            url: 'https://www.news.com.au/content-feeds/latest-news-world/',          priority: 4 },
  { name: 'Stuff NZ',               url: 'https://www.stuff.co.nz/rss',                                       priority: 3 },
  { name: 'RNZ',                    url: 'https://www.rnz.co.nz/rss/news.xml',                                priority: 3 },
  { name: 'RTÉ News',               url: 'https://www.rte.ie/news/rss/news-headlines.xml',                    priority: 3 },
  { name: 'The Journal (IE)',       url: 'https://www.thejournal.ie/feed/',                                   priority: 4 },

  // ────────────────────────────────────────────────────────────────────
  // Asia / Pacific
  //
  // Skipped 2026-05-15 audit failures:
  //   - Channel News Asia (TITLE-ONLY — empty descriptions on first 2 items)
  //   - Today Online (HTTP-404)
  // ────────────────────────────────────────────────────────────────────
  { name: 'South China Morning Post', url: 'https://www.scmp.com/rss/91/feed/',                                priority: 2 },
  { name: 'Asia Times',             url: 'https://asiatimes.com/category/world/feed/',                        priority: 3 },

  // ────────────────────────────────────────────────────────────────────
  // India
  //
  // Skipped 2026-05-15 audit failures (all TITLE-ONLY — descriptions empty):
  //   - The Indian Express World
  //   - Times of India World
  // ────────────────────────────────────────────────────────────────────
  { name: 'NDTV World',             url: 'https://feeds.feedburner.com/ndtvnews-world-news',                  priority: 2 },
  { name: 'The Hindu World',        url: 'https://www.thehindu.com/news/international/feeder/default.rss',    priority: 3 },
  { name: 'ThePrint World',         url: 'https://theprint.in/category/world/feed/',                          priority: 4 },
  { name: 'Firstpost World',        url: 'https://www.firstpost.com/commonfeeds/v1/mfp/rss/world.xml',        priority: 4 },

  // ────────────────────────────────────────────────────────────────────
  // Africa / MENA — long-tail regional coverage the world-tier feeds miss
  //
  // Anadolu Agency is Turkey's state-affiliated wire — priority 3 to
  // match other national wire-tier outlets. We only use `cat=guncel`
  // (current — the firehose) instead of every topical sub-endpoint:
  // running multiple AA category feeds had the same story appear
  // 2-3 times under different `source` names, artificially inflating
  // cluster source counts against the WM_V6_MIN_SOURCES gate.
  //
  // Skipped 2026-05-15 audit failures:
  //   - Morocco World News (HTTP-403 from cloud IPs)
  // ────────────────────────────────────────────────────────────────────
  { name: 'News24 World',           url: 'https://feeds.24.com/articles/news24/World/rss',                    priority: 2 },
  { name: 'Anadolu Agency',         url: 'https://www.aa.com.tr/en/rss/default?cat=guncel',                   priority: 3 },

  // ────────────────────────────────────────────────────────────────────
  // Paywalled — priority 5 keeps them out of the canonical pick but
  // still uses them for cluster signal + multi-source counts. iOS
  // users see the free-outlet headline as the visible row; the
  // paywalled article appears in sources[] for the curious.
  // ────────────────────────────────────────────────────────────────────
  { name: 'NYT Homepage',           url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',         priority: 5 },
  { name: 'NYT US',                 url: 'https://rss.nytimes.com/services/xml/rss/nyt/US.xml',               priority: 5 },
  { name: 'NYT World',              url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',            priority: 5 },
  { name: 'NYT Politics',           url: 'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml',         priority: 5 },
  { name: 'NYT Business',           url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml',         priority: 5 },
  { name: 'NYT Technology',         url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',       priority: 5 },
  { name: 'NYT Science',            url: 'https://rss.nytimes.com/services/xml/rss/nyt/Science.xml',          priority: 5 },
  { name: 'NYT Health',             url: 'https://rss.nytimes.com/services/xml/rss/nyt/Health.xml',           priority: 5 },

  // Washington Post dropped 2026-05-15 — every WaPo sub-feed hangs on
  // Vercel egress until the 30s budget cap aborts the request.
  // Cloudflare bot-detection variant served to cloud IPs. The Mac
  // audit returned them fine; only Vercel sees the block.

  { name: 'WSJ World',              url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml',                       priority: 5 },
  { name: 'WSJ US Business',        url: 'https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml',                   priority: 5 },
  { name: 'WSJ Markets',            url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',                     priority: 5 },
  { name: 'WSJ Tech',               url: 'https://feeds.a.dj.com/rss/RSSWSJD.xml',                            priority: 5 },

  { name: 'The Atlantic',           url: 'https://www.theatlantic.com/feed/all/',                             priority: 5 },
  { name: 'The Atlantic National',  url: 'https://feeds.feedburner.com/AtlanticNational',                     priority: 5 },
  { name: 'New Yorker News',        url: 'https://www.newyorker.com/feed/news',                               priority: 5 },
  { name: 'Foreign Affairs',        url: 'https://www.foreignaffairs.com/rss.xml',                            priority: 5 },

  { name: 'Financial Times',        url: 'https://www.ft.com/rss/home',                                       priority: 5 },
  { name: 'FT World',               url: 'https://www.ft.com/world?format=rss',                               priority: 5 },
  { name: 'The Telegraph News',     url: 'https://www.telegraph.co.uk/news/rss.xml',                          priority: 5 },

  { name: 'Financial Post',         url: 'https://financialpost.com/feed',                                    priority: 5 },

  // ────────────────────────────────────────────────────────────────────
  // 2026-05-20 expansion — broader regional coverage
  //
  // Multi-feed outlets (Daily Sabah, Straits Times, RTHK, Korea Herald,
  // Bangkok Post, Rappler) have their sub-feeds collapsed into a single
  // publisher entry by `publisherOf` in _cluster.ts — without that, the
  // same story appearing in N sub-feeds inflates the cluster source count.
  //
  // RFE/RL is included as-is per the source list (URL is `/api/`) — verify
  // it parses as RSS on first refresh; swap to a `/rss/...` feed if not.
  // ────────────────────────────────────────────────────────────────────

  // ── Türkiye — Daily Sabah ──
  { name: 'Daily Sabah Home',         url: 'https://www.dailysabah.com/rss/home-page',                          priority: 3 },
  { name: 'Daily Sabah Türkiye',      url: 'https://www.dailysabah.com/rss/turkiye',                            priority: 3 },
  { name: 'Daily Sabah Politics',     url: 'https://www.dailysabah.com/rss/politics',                           priority: 3 },
  { name: 'Daily Sabah World',        url: 'https://www.dailysabah.com/rss/world',                              priority: 3 },
  { name: 'Daily Sabah Mid-East',     url: 'https://www.dailysabah.com/rss/world/mid-east',                     priority: 3 },
  { name: 'Daily Sabah Europe',       url: 'https://www.dailysabah.com/rss/world/europe',                       priority: 3 },
  { name: 'Daily Sabah Americas',     url: 'https://www.dailysabah.com/rss/world/americas',                     priority: 3 },
  { name: 'Daily Sabah Asia Pacific', url: 'https://www.dailysabah.com/rss/world/asia-pacific',                 priority: 3 },
  { name: 'Daily Sabah Africa',       url: 'https://www.dailysabah.com/rss/world/africa',                       priority: 3 },
  { name: 'Daily Sabah Business',     url: 'https://www.dailysabah.com/rss/business',                           priority: 3 },

  // ── Asia / Pacific — additions ──
  { name: 'The Straits Times World',  url: 'https://www.straitstimes.com/news/world/rss.xml',                   priority: 3 },
  { name: 'The Straits Times Asia',   url: 'https://www.straitstimes.com/news/asia/rss.xml',                    priority: 3 },
  { name: 'The Straits Times Singapore', url: 'https://www.straitstimes.com/news/singapore/rss.xml',            priority: 3 },
  { name: 'RTHK World',               url: 'https://rthk.hk/rthk/news/rss/e_expressnews_einternational.xml',    priority: 2 },
  { name: 'RTHK Local',               url: 'https://rthk.hk/rthk/news/rss/e_expressnews_elocal.xml',            priority: 2 },
  { name: 'Hong Kong Free Press',     url: 'https://hongkongfp.com/feed',                                       priority: 4 },
  { name: 'The Japan Times',          url: 'https://www.japantimes.co.jp/feed/',                                priority: 3 },
  { name: 'Japan Today',              url: 'https://japantoday.com/feed',                                       priority: 4 },
  { name: 'Kyodo News English',       url: 'https://english.kyodonews.net/rss/all.xml',                         priority: 2 },
  { name: 'Korea Herald All',         url: 'https://www.koreaherald.com/rss/newsAll',                           priority: 3 },
  { name: 'Korea Herald National',    url: 'https://www.koreaherald.com/rss/kh_National',                       priority: 3 },
  { name: 'Korea Herald World',       url: 'https://www.koreaherald.com/rss/kh_World',                          priority: 3 },
  { name: 'Korea Herald Business',    url: 'https://www.koreaherald.com/rss/kh_Business',                       priority: 3 },
  { name: 'Yonhap News English',      url: 'https://en.yna.co.kr/RSS/news.xml',                                 priority: 3 },
  { name: 'Taipei Times',             url: 'https://www.taipeitimes.com/xml/index.rss',                         priority: 3 },
  { name: 'Bangkok Post Top Stories', url: 'https://www.bangkokpost.com/rss/data/topstories.xml',               priority: 3 },
  { name: 'Bangkok Post Thailand',    url: 'https://www.bangkokpost.com/rss/data/thailand.xml',                 priority: 3 },
  { name: 'Bangkok Post World',       url: 'https://www.bangkokpost.com/rss/data/world.xml',                    priority: 3 },
  { name: 'Inquirer.net',             url: 'https://www.inquirer.net/fullfeed',                                 priority: 3 },
  { name: 'Rappler',                  url: 'https://www.rappler.com/feed',                                      priority: 3 },
  { name: 'Rappler World',            url: 'https://www.rappler.com/world/feed',                                priority: 3 },
  { name: 'Antara News English',     url: 'https://en.antaranews.com/rss/news.xml',                             priority: 3 },
  { name: 'VnExpress International',  url: 'https://e.vnexpress.net/rss/news.rss',                              priority: 3 },
  { name: 'Vietnam News Society',     url: 'https://vietnamnews.vn/rss/society.rss',                            priority: 3 },
  { name: 'Dawn',                     url: 'https://www.dawn.com/feeds/home',                                   priority: 3 },
  { name: 'The Daily Star (BD)',      url: 'https://www.thedailystar.net/frontpage/rss.xml',                    priority: 3 },
  { name: 'Express Tribune',          url: 'https://tribune.com.pk/feed/home',                                  priority: 3 },

  // ── United States — additions ──
  { name: 'Semafor',                  url: 'https://semafor.com/rss.xml',                                       priority: 4 },

  // ── United Kingdom — additions ──
  { name: 'Belfast Telegraph',        url: 'https://www.belfasttelegraph.co.uk/rss/',                           priority: 4 },

  // ── Australia — additions ──
  { name: 'PerthNow',                 url: 'https://www.perthnow.com.au/news/feed',                             priority: 4 },
  { name: 'The Canberra Times',       url: 'https://www.canberratimes.com.au/rss.xml',                          priority: 3 },

  // ── Europe — national outlets ──
  { name: 'El País English',          url: 'https://elpais.com/rss/elpais/inenglish.xml',                       priority: 3 },
  { name: 'Kyiv Post',                url: 'https://www.kyivpost.com/feed',                                     priority: 3 },
  { name: 'RFE/RL',                   url: 'https://www.rferl.org/api/',                                        priority: 2 },
  { name: 'The Local Spain',          url: 'https://feeds.thelocal.com/rss/es',                                 priority: 4 },
  { name: 'NL Times',                 url: 'https://nltimes.nl/rssfeed2',                                       priority: 4 },
  { name: 'DutchNews.nl',             url: 'https://www.dutchnews.nl/feed',                                     priority: 4 },
  { name: 'The Bulletin (BE)',       url: 'https://thebulletin.be/rss.xml',                                     priority: 4 },
  { name: 'Brussels Morning',         url: 'https://brusselsmorning.com/feed',                                  priority: 4 },
  { name: 'Ekathimerini English',     url: 'http://www.ekathimerini.com/rss',                                   priority: 3 },
  { name: 'Greek Reporter',           url: 'https://greekreporter.com/greece/feed',                             priority: 4 },
  { name: 'Hungary Today',            url: 'https://hungarytoday.hu/feed',                                      priority: 4 },
  { name: 'Budapest Times',           url: 'https://www.budapesttimes.hu/feed',                                 priority: 4 },

  // ── Africa / MENA — additions ──
  { name: 'Middle East Eye',          url: 'https://www.middleeasteye.net/rss',                                 priority: 4 },
  { name: 'Mail & Guardian',          url: 'https://mg.co.za/feed',                                             priority: 3 },
  { name: 'Daily Maverick',           url: 'https://www.dailymaverick.co.za/dmrss',                             priority: 3 },
  { name: 'IOL',                      url: 'https://rss.iol.io/iol/news',                                       priority: 3 },
  { name: 'Premium Times',            url: 'https://www.premiumtimesng.com/feed',                               priority: 3 },
  { name: 'Punch',                    url: 'https://rss.punchng.com/v1/category/latest_news',                   priority: 3 },
  { name: 'Daily Nation',             url: 'https://nation.africa/kenya/rss.xml',                               priority: 3 },
  { name: 'Egypt Independent',        url: 'https://www.egyptindependent.com/feed',                             priority: 3 },
  { name: 'Daily News Egypt',         url: 'https://www.dailynewsegypt.com/feed',                               priority: 3 },

  // ── Latin America ──
  { name: 'Buenos Aires Times',       url: 'https://www.batimes.com.ar/feed',                                   priority: 3 },

  // ── Cyber / infosec ──
  { name: 'Krebs on Security',        url: 'https://krebsonsecurity.com/feed/',                                 priority: 4 },
  { name: 'The Hacker News',          url: 'https://feeds.feedburner.com/TheHackersNews',                       priority: 4 },
  { name: 'Dark Reading',             url: 'https://www.darkreading.com/rss.xml',                               priority: 4 },
  { name: 'Schneier on Security',     url: 'https://www.schneier.com/feed/',                                    priority: 4 },
  { name: 'CISA Advisories',          url: 'https://www.cisa.gov/cybersecurity-advisories/all.xml',              priority: 4 },
  { name: 'Ransomware.live',          url: 'https://www.ransomware.live/rss.xml',                               priority: 4 },
  { name: 'BleepingComputer',         url: 'https://www.bleepingcomputer.com/feed/',                            priority: 4 },
  { name: 'The Record',               url: 'https://therecord.media/feed/',                                     priority: 4 },

  // ── Maritime / naval ──
  { name: 'USNI News',                url: 'https://news.usni.org/feed',                                        priority: 4 },
  { name: 'gCaptain',                 url: 'https://gcaptain.com/feed/',                                        priority: 4 },
  { name: 'Naval News',               url: 'https://www.navalnews.com/feed/',                                   priority: 4 },


  // ── Nuclear / arms control (site-scoped GN — direct NTI RSS 403s) ──
  { name: 'IAEA Top News',            url: 'https://www.iaea.org/feeds/topnews',                                priority: 4 },
  { name: 'Nuclear Energy (GN)',      url: 'https://news.google.com/rss/search?q=(%22nuclear+energy%22+OR+%22nuclear+power%22+OR+uranium+OR+IAEA)+when:3d&hl=en-US&gl=US&ceid=US:en', priority: 4 },
  { name: 'Arms Control Assn (GN)',   url: 'https://news.google.com/rss/search?q=site:armscontrol.org+when:7d&hl=en-US&gl=US&ceid=US:en', priority: 4 },
  { name: 'Bulletin of Atomic Scientists (GN)', url: 'https://news.google.com/rss/search?q=site:thebulletin.org+when:7d&hl=en-US&gl=US&ceid=US:en', priority: 4 },
  { name: 'FAS Nuclear Security (GN)', url: 'https://news.google.com/rss/search?q=site:fas.org+nuclear+weapons+security&hl=en&gl=US&ceid=US:en', priority: 4 },
  { name: 'NTI (GN)',                 url: 'https://news.google.com/rss/search?q=site:nti.org+when:30d&hl=en-US&gl=US&ceid=US:en', priority: 4 },

  // ── Sanctions / trade restrictions ──
  { name: 'Baker McKenzie Sanctions', url: 'https://sanctionsnews.bakermckenzie.com/feed/',                    priority: 4 },
  { name: 'WorldECR',                 url: 'https://www.worldecr.com/news/feed/',                              priority: 4 },
  { name: 'Global Trade & Sanctions Law', url: 'https://www.globaltradeandsanctionslaw.com/feed/',             priority: 4 },
  { name: 'Trade & Tariffs (GN)',     url: 'https://news.google.com/rss/search?q=(tariff+OR+%22trade+war%22+OR+%22trade+deficit%22+OR+sanctions)+when:2d&hl=en-US&gl=US&ceid=US:en', priority: 4 },
  { name: 'Treasury Dept (GN)',       url: 'https://news.google.com/rss/search?q=site:treasury.gov+OR+%22Treasury+Department%22&hl=en-US&gl=US&ceid=US:en', priority: 4 },
];
