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
 * Dropped 28 feeds after a description-quality + reachability audit
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

/** Drop items older than 3 days before they enter the pipeline.
 *  Matches the project-wide 3-day retention cap; also redundant with
 *  the digest's 24h rolling window but cheap defense-in-depth. */
export const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The v6 corpus. ~130 feeds across world/US/UK/Canada/AU-NZ-IE plus
 * paywalled premium tier. See header comment for inclusion rules.
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
  { name: 'BBC Entertainment',      url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml',      priority: 2 },

  { name: 'France 24',              url: 'https://www.france24.com/en/rss',                                   priority: 2 },
  { name: 'DW (all English)',       url: 'https://rss.dw.com/rdf/rss-en-all',                                 priority: 2 },
  { name: 'DW Top Stories',         url: 'https://rss.dw.com/xml/rss-en-top',                                 priority: 2 },
  { name: 'DW World',               url: 'https://rss.dw.com/rdf/rss-en-world',                               priority: 2 },
  { name: 'Euronews',               url: 'https://www.euronews.com/rss?level=theme&name=news',                priority: 2 },
  { name: 'Sky News World',         url: 'https://feeds.skynews.com/feeds/rss/world.xml',                     priority: 2 },
  { name: 'ABC News International', url: 'https://abcnews.go.com/abcnews/internationalheadlines',             priority: 2 },
  { name: 'CBC World',              url: 'https://rss.cbc.ca/lineup/world.xml',                               priority: 2 },

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
  { name: 'NY Post',                url: 'https://nypost.com/feed/',                                          priority: 3 },
  { name: 'HuffPost US',            url: 'https://chaski.huffpost.com/us/auto/vertical/us-news',              priority: 4 },
  { name: 'HuffPost World',         url: 'https://chaski.huffpost.com/us/auto/vertical/world-news',           priority: 4 },
  { name: 'The Hill',               url: 'https://thehill.com/homenews/feed/',                                priority: 4 },
  { name: 'Vox World Politics',     url: 'https://www.vox.com/rss/world-politics/index.xml',                  priority: 4 },
  { name: 'Slate News & Politics',  url: 'https://slate.com/feeds/news-and-politics.rss',                     priority: 4 },
  { name: 'Time',                   url: 'https://feeds.feedburner.com/time/topstories',                      priority: 3 },
  { name: 'The Daily Beast',        url: 'https://feeds.feedburner.com/thedailybeast/articles',               priority: 4 },
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
  { name: 'Daily Mail',             url: 'https://www.dailymail.co.uk/home/index.rss',                        priority: 4 },
  { name: 'Daily Mail News',        url: 'https://www.dailymail.co.uk/news/index.rss',                        priority: 4 },
  { name: 'Daily Express',          url: 'https://www.express.co.uk/posts/rss/1/news',                        priority: 4 },
  { name: 'Daily Mirror News',      url: 'https://www.mirror.co.uk/news/?service=rss',                        priority: 4 },
  { name: 'Daily Mirror World',     url: 'https://www.mirror.co.uk/news/world-news/?service=rss',             priority: 4 },
  { name: 'Evening Standard',       url: 'https://www.standard.co.uk/news/rss',                               priority: 4 },
  { name: 'Channel 4 News',         url: 'https://www.channel4.com/news/feed',                                priority: 3 },
  { name: 'Metro UK',               url: 'https://metro.co.uk/feed/',                                         priority: 4 },
  { name: 'The Sun',                url: 'https://www.thesun.co.uk/feed/',                                    priority: 4 },
  { name: 'Politics.co.uk',         url: 'https://www.politics.co.uk/feed/',                                  priority: 4 },

  // ────────────────────────────────────────────────────────────────────
  // Canada
  // ────────────────────────────────────────────────────────────────────
  { name: 'CBC Top Stories',        url: 'https://www.cbc.ca/cmlink/rss-topstories',                          priority: 2 },
  { name: 'CBC Canada',             url: 'https://rss.cbc.ca/lineup/canada.xml',                              priority: 2 },
  { name: 'CBC Politics',           url: 'https://rss.cbc.ca/lineup/politics.xml',                            priority: 2 },
  { name: 'CBC Business',           url: 'https://rss.cbc.ca/lineup/business.xml',                            priority: 2 },
  { name: 'CBC Health',             url: 'https://rss.cbc.ca/lineup/health.xml',                              priority: 2 },
  { name: 'CBC Tech & Science',     url: 'https://rss.cbc.ca/lineup/technology.xml',                          priority: 2 },

  { name: 'Global News',            url: 'https://globalnews.ca/feed/',                                       priority: 3 },
  { name: 'Global News World',      url: 'https://globalnews.ca/world/feed/',                                 priority: 3 },
  { name: 'Global News Canada',     url: 'https://globalnews.ca/canada/feed/',                                priority: 3 },
  { name: 'Global News Politics',   url: 'https://globalnews.ca/politics/feed/',                              priority: 3 },

  { name: 'National Post',          url: 'https://nationalpost.com/feed/',                                    priority: 3 },
  { name: 'Toronto Sun News',       url: 'https://torontosun.com/category/news/feed',                         priority: 4 },
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

  { name: 'Washington Post National', url: 'https://feeds.washingtonpost.com/rss/national',                   priority: 5 },
  { name: 'Washington Post World',  url: 'http://feeds.washingtonpost.com/rss/world',                         priority: 5 },
  { name: 'Washington Post Politics', url: 'https://feeds.washingtonpost.com/rss/politics',                   priority: 5 },
  { name: 'Washington Post Business', url: 'https://feeds.washingtonpost.com/rss/business',                   priority: 5 },

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
];
