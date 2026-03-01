export interface ServerFeed {
  name: string;
  url: string;
  lang?: string;
}

const gn = (q: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

export const VARIANT_FEEDS: Record<string, Record<string, ServerFeed[]>> = {
  full: {
    politics: [
      { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
      { name: 'Guardian World', url: 'https://www.theguardian.com/world/rss' },
      { name: 'AP News', url: gn('site:apnews.com') },
      { name: 'Reuters World', url: gn('site:reuters.com world') },
      { name: 'CNN World', url: gn('site:cnn.com world news when:1d') },
    ],
    us: [
      { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml' },
      { name: 'Politico', url: gn('site:politico.com when:1d') },
      { name: 'Axios', url: 'https://api.axios.com/feed/' },
    ],
    europe: [
      { name: 'France 24', url: 'https://www.france24.com/en/rss' },
      { name: 'EuroNews', url: 'https://www.euronews.com/rss?format=xml' },
      { name: 'Le Monde', url: 'https://www.lemonde.fr/en/rss/une.xml' },
      { name: 'DW News', url: 'https://rss.dw.com/xml/rss-en-all' },
    ],
    middleeast: [
      { name: 'BBC Middle East', url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml' },
      { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
      { name: 'Guardian ME', url: 'https://www.theguardian.com/world/middleeast/rss' },
      { name: 'Oman Observer', url: 'https://www.omanobserver.om/rssFeed/1' },
    ],
    asia: [
      { name: 'NDTV', url: 'https://feeds.feedburner.com/ndtvnews-top-stories' },
    ],
    tech: [
      { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
      { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab' },
      { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
      { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/feed/' },
    ],
    ai: [
      { name: 'AI News', url: gn('(OpenAI OR Anthropic OR Google AI OR "large language model" OR ChatGPT) when:2d') },
      { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/' },
      { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
      { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed' },
      { name: 'ArXiv AI', url: 'https://export.arxiv.org/rss/cs.AI' },
    ],
    finance: [
      { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
      { name: 'MarketWatch', url: gn('site:marketwatch.com markets when:1d') },
      { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex' },
      { name: 'Financial Times', url: 'https://www.ft.com/rss/home' },
      { name: 'Reuters Business', url: gn('site:reuters.com business markets') },
    ],
    gov: [
      { name: 'White House', url: gn('site:whitehouse.gov') },
      { name: 'State Dept', url: gn('site:state.gov OR "State Department"') },
      { name: 'Pentagon', url: gn('site:defense.gov OR Pentagon') },
      { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
      { name: 'SEC', url: 'https://www.sec.gov/news/pressreleases.rss' },
      { name: 'UN News', url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml' },
      { name: 'CISA', url: 'https://www.cisa.gov/cybersecurity-advisories/all.xml' },
    ],
    africa: [
      { name: 'BBC Africa', url: 'https://feeds.bbci.co.uk/news/world/africa/rss.xml' },
      { name: 'News24', url: 'https://feeds.news24.com/articles/news24/TopStories/rss' },
    ],
    latam: [
      { name: 'BBC Latin America', url: 'https://feeds.bbci.co.uk/news/world/latin_america/rss.xml' },
      { name: 'Guardian Americas', url: 'https://www.theguardian.com/world/americas/rss' },
    ],
    asia: [
      { name: 'BBC Asia', url: 'https://feeds.bbci.co.uk/news/world/asia/rss.xml' },
      { name: 'The Diplomat', url: 'https://thediplomat.com/feed/' },
      { name: 'Nikkei Asia', url: gn('site:asia.nikkei.com when:3d') },
      { name: 'CNA', url: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml' },
    ],
    energy: [
      { name: 'Oil & Gas', url: gn('(oil price OR OPEC OR "natural gas" OR pipeline OR LNG) when:2d') },
    ],
    thinktanks: [
      { name: 'Foreign Policy', url: 'https://foreignpolicy.com/feed/' },
      { name: 'Atlantic Council', url: 'https://www.atlanticcouncil.org/feed/' },
      { name: 'Foreign Affairs', url: 'https://www.foreignaffairs.com/rss.xml' },
    ],
    crisis: [
      { name: 'CrisisWatch', url: 'https://www.crisisgroup.org/rss' },
      { name: 'IAEA', url: 'https://www.iaea.org/feeds/topnews' },
      { name: 'WHO', url: 'https://www.who.int/rss-feeds/news-english.xml' },
    ],
    layoffs: [
      { name: 'TechCrunch Layoffs', url: 'https://techcrunch.com/tag/layoffs/feed/' },
    ],
  },

  tech: {
    tech: [
      { name: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
      { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
      { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab' },
      { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
    ],
    ai: [
      { name: 'AI News', url: gn('(OpenAI OR Anthropic OR Google AI OR "large language model" OR ChatGPT) when:2d') },
      { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/' },
      { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
      { name: 'ArXiv AI', url: 'https://export.arxiv.org/rss/cs.AI' },
    ],
    startups: [
      { name: 'TechCrunch Startups', url: 'https://techcrunch.com/category/startups/feed/' },
      { name: 'VentureBeat', url: 'https://venturebeat.com/feed/' },
      { name: 'Crunchbase News', url: 'https://news.crunchbase.com/feed/' },
    ],
    security: [
      { name: 'Krebs Security', url: 'https://krebsonsecurity.com/feed/' },
      { name: 'Dark Reading', url: 'https://www.darkreading.com/rss.xml' },
    ],
    github: [
      { name: 'GitHub Blog', url: 'https://github.blog/feed/' },
    ],
    funding: [
      { name: 'VC News', url: gn('("Series A" OR "Series B" OR "Series C" OR "venture capital" OR "funding round") when:2d') },
    ],
    cloud: [
      { name: 'InfoQ', url: 'https://feed.infoq.com/' },
      { name: 'The New Stack', url: 'https://thenewstack.io/feed/' },
    ],
    layoffs: [
      { name: 'TechCrunch Layoffs', url: 'https://techcrunch.com/tag/layoffs/feed/' },
    ],
    finance: [
      { name: 'CNBC Tech', url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html' },
      { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/rss/topstories' },
    ],
  },

  finance: {
    markets: [
      { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
      { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/rss/topstories' },
      { name: 'Seeking Alpha', url: 'https://seekingalpha.com/market_currents.xml' },
    ],
    forex: [
      { name: 'Forex News', url: gn('(forex OR currency OR "exchange rate" OR FX OR "US dollar") when:2d') },
    ],
    bonds: [
      { name: 'Bond Market', url: gn('("bond market" OR "treasury yield" OR "bond yield" OR "fixed income") when:2d') },
    ],
    commodities: [
      { name: 'Oil & Gas', url: gn('(oil price OR OPEC OR "natural gas" OR pipeline OR LNG) when:2d') },
      { name: 'Gold & Metals', url: gn('("gold price" OR "silver price" OR "precious metals" OR "copper price") when:2d') },
    ],
    crypto: [
      { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
      { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
    ],
    centralbanks: [
      { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
    ],
    economic: [
      { name: 'Economic Data', url: gn('(CPI OR inflation OR GDP OR "economic data" OR "jobs report") when:2d') },
    ],
    ipo: [
      { name: 'IPO News', url: gn('(IPO OR "initial public offering" OR "stock market debut") when:2d') },
    ],
  },

  happy: {
    positive: [
      { name: 'Good News Network', url: 'https://www.goodnewsnetwork.org/feed/' },
      { name: 'Positive.News', url: 'https://www.positive.news/feed/' },
      { name: 'Reasons to be Cheerful', url: 'https://reasonstobecheerful.world/feed/' },
      { name: 'Optimist Daily', url: 'https://www.optimistdaily.com/feed/' },
    ],
    science: [
      { name: 'ScienceDaily', url: 'https://www.sciencedaily.com/rss/all.xml' },
      { name: 'Nature News', url: 'https://feeds.nature.com/nature/rss/current' },
      { name: 'Singularity Hub', url: 'https://singularityhub.com/feed/' },
    ],
  },
};

export const INTEL_SOURCES: ServerFeed[] = [
  { name: 'Defense One', url: 'https://www.defenseone.com/rss/all/' },
  { name: 'Breaking Defense', url: 'https://breakingdefense.com/feed/' },
  { name: 'The War Zone', url: 'https://www.twz.com/feed' },
  { name: 'Defense News', url: 'https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml' },
  { name: 'Military Times', url: 'https://www.militarytimes.com/arc/outboundfeeds/rss/?outputType=xml' },
  { name: 'Task & Purpose', url: 'https://taskandpurpose.com/feed/' },
  { name: 'USNI News', url: 'https://news.usni.org/feed' },
  { name: 'gCaptain', url: 'https://gcaptain.com/feed/' },
  { name: 'Oryx OSINT', url: 'https://www.oryxspioenkop.com/feeds/posts/default?alt=rss' },
  { name: 'Foreign Policy', url: 'https://foreignpolicy.com/feed/' },
  { name: 'Foreign Affairs', url: 'https://www.foreignaffairs.com/rss.xml' },
  { name: 'Atlantic Council', url: 'https://www.atlanticcouncil.org/feed/' },
  { name: 'Bellingcat', url: gn('site:bellingcat.com') },
  { name: 'Krebs Security', url: 'https://krebsonsecurity.com/feed/' },
  { name: 'Arms Control Assn', url: gn('site:armscontrol.org') },
  { name: 'Bulletin of Atomic Scientists', url: gn('site:thebulletin.org') },
  { name: 'FAO News', url: 'https://www.fao.org/feeds/fao-newsroom-rss' },
];
