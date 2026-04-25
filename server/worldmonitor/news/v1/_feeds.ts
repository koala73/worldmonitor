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
      { name: 'AP News', url: gn('site:apnews.com when:1d') },
      { name: 'Reuters World', url: gn('site:reuters.com world when:1d') },
      { name: 'CNN World', url: gn('site:cnn.com world news when:1d') },
    ],
    us: [
      { name: 'Reuters US', url: gn('site:reuters.com US when:1d') },
      { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml' },
      { name: 'PBS NewsHour', url: 'https://www.pbs.org/newshour/feeds/rss/headlines' },
      { name: 'ABC News', url: 'https://feeds.abcnews.com/abcnews/topstories' },
      { name: 'CBS News', url: 'https://www.cbsnews.com/latest/rss/main' },
      { name: 'NBC News', url: 'https://feeds.nbcnews.com/nbcnews/public/news' },
      { name: 'Wall Street Journal', url: 'https://feeds.content.dowjones.io/public/rss/RSSUSnews' },
      { name: 'Politico', url: 'https://rss.politico.com/politics-news.xml' },
      { name: 'The Hill', url: 'https://thehill.com/news/feed' },
      { name: 'Axios', url: 'https://api.axios.com/feed/' },
    ],
    europe: [
      { name: 'France 24', url: 'https://www.france24.com/en/rss' },
      { name: 'EuroNews', url: 'https://www.euronews.com/rss?format=xml' },
      { name: 'Le Monde', url: 'https://www.lemonde.fr/en/rss/une.xml' },
      { name: 'DW News', url: 'https://rss.dw.com/xml/rss-en-all' },
      { name: 'Tagesschau', url: 'https://www.tagesschau.de/xml/rss2/', lang: 'de' },
      { name: 'ANSA', url: 'https://www.ansa.it/sito/ansait_rss.xml', lang: 'it' },
      { name: 'NOS Nieuws', url: 'https://feeds.nos.nl/nosnieuwsalgemeen', lang: 'nl' },
      { name: 'SVT Nyheter', url: 'https://www.svt.se/nyheter/rss.xml', lang: 'sv' },
    ],
    middleeast: [
      { name: 'BBC Middle East', url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml' },
      { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
      { name: 'Guardian ME', url: 'https://www.theguardian.com/world/middleeast/rss' },
      { name: 'Oman Observer', url: 'https://www.omanobserver.om/rssFeed/1' },
      { name: 'BBC Persian', url: 'https://feeds.bbci.co.uk/persian/rss.xml', lang: 'fa' },
      { name: 'The National', url: 'https://www.thenationalnews.com/arc/outboundfeeds/rss/?outputType=xml' },
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
      { name: 'Reuters Business', url: gn('site:reuters.com business markets when:1d') },
    ],
    gov: [
      { name: 'White House', url: gn('site:whitehouse.gov when:1d') },
      { name: 'State Dept', url: gn('(site:state.gov OR "State Department") when:1d') },
      { name: 'Pentagon', url: gn('(site:defense.gov OR Pentagon) when:1d') },
      { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
      { name: 'SEC', url: 'https://www.sec.gov/news/pressreleases.rss' },
      { name: 'UN News', url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml' },
      { name: 'CISA', url: 'https://www.cisa.gov/cybersecurity-advisories/all.xml' },
      { name: 'Treasury', url: gn('site:treasury.gov when:1d') },
      { name: 'DOJ', url: gn('site:justice.gov when:1d') },
    ],
    africa: [
      { name: 'BBC Africa', url: 'https://feeds.bbci.co.uk/news/world/africa/rss.xml' },
      { name: 'News24', url: 'https://feeds.news24.com/articles/news24/TopStories/rss' },
      { name: 'Africanews', url: 'https://www.africanews.com/feed/' },
      { name: 'Jeune Afrique', url: 'https://www.jeuneafrique.com/feed/', lang: 'fr' },
      { name: 'Premium Times', url: 'https://www.premiumtimesng.com/feed' },
    ],
    latam: [
      { name: 'BBC Latin America', url: 'https://feeds.bbci.co.uk/news/world/latin_america/rss.xml' },
      { name: 'Guardian Americas', url: 'https://www.theguardian.com/world/americas/rss' },
      { name: 'Primicias', url: 'https://www.primicias.ec/feed/', lang: 'es' },
      { name: 'Infobae Americas', url: 'https://www.infobae.com/arc/outboundfeeds/rss/', lang: 'es' },
      { name: 'El Universo', url: 'https://www.eluniverso.com/arc/outboundfeeds/rss/category/noticias/?outputType=xml', lang: 'es' },
      { name: 'Clarín', url: 'https://www.clarin.com/rss/lo-ultimo/', lang: 'es' },
      { name: 'InSight Crime', url: 'https://insightcrime.org/feed/' },
    ],
    asia: [
      { name: 'BBC Asia', url: 'https://feeds.bbci.co.uk/news/world/asia/rss.xml' },
      { name: 'The Diplomat', url: 'https://thediplomat.com/feed/' },
      { name: 'Nikkei Asia', url: gn('site:asia.nikkei.com when:3d') },
      { name: 'CNA', url: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml' },
      { name: 'NDTV', url: 'https://feeds.feedburner.com/ndtvnews-top-stories' },
      { name: 'South China Morning Post', url: gn('site:scmp.com when:2d') },
      { name: 'The Hindu', url: 'https://www.thehindu.com/feeder/default.rss' },
      { name: 'Asia News', url: gn('site:asianews.it when:3d') },
    ],
    energy: [
      { name: 'Oil & Gas', url: gn('(oil price OR OPEC OR "natural gas" OR pipeline OR LNG) when:2d') },
      { name: 'Reuters Energy', url: gn('site:reuters.com energy when:2d') },
      { name: 'Nuclear Energy', url: gn('("nuclear energy" OR "nuclear power" OR "nuclear reactor") when:3d') },
    ],
    thinktanks: [
      { name: 'Foreign Policy', url: 'https://foreignpolicy.com/feed/' },
      { name: 'Atlantic Council', url: 'https://www.atlanticcouncil.org/feed/' },
      { name: 'Foreign Affairs', url: 'https://www.foreignaffairs.com/rss.xml' },
      { name: 'War on the Rocks', url: 'https://warontherocks.com/feed/' },
      { name: 'CSIS', url: 'https://www.csis.org/rss.xml' },
    ],
    crisis: [
      { name: 'CrisisWatch', url: 'https://www.crisisgroup.org/rss' },
      { name: 'IAEA', url: 'https://www.iaea.org/feeds/topnews' },
      { name: 'WHO', url: 'https://www.who.int/rss-feeds/news-english.xml' },
    ],
    layoffs: [
      { name: 'Layoffs.fyi', url: gn('tech+company+layoffs+announced when:3d') },
      { name: 'TechCrunch Layoffs', url: 'https://techcrunch.com/tag/layoffs/feed/' },
      { name: 'Layoffs News', url: gn('(layoffs OR "job cuts" OR "workforce reduction") when:3d') },
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
    vcblogs: [
      { name: 'Y Combinator Blog', url: 'https://www.ycombinator.com/blog/rss/' },
      { name: 'a16z Blog', url: 'https://www.a16z.news/feed' },
      { name: 'First Round Review', url: 'https://review.firstround.com/articles/rss' },
      { name: 'Sequoia Blog', url: 'https://www.sequoiacap.com/feed/' },
      { name: 'Stratechery', url: 'https://stratechery.com/feed/' },
    ],
    regionalStartups: [
      { name: 'EU Startups', url: 'https://www.eu-startups.com/feed/' },
      { name: 'Tech.eu', url: 'https://tech.eu/feed/' },
      { name: 'Sifted (Europe)', url: 'https://sifted.eu/feed' },
      { name: 'Tech in Asia', url: 'https://www.techinasia.com/feed' },
      { name: 'TechCabal (Africa)', url: 'https://techcabal.com/feed/' },
      { name: 'Inc42 (India)', url: 'https://inc42.com/feed/' },
    ],
    unicorns: [
      { name: 'Unicorn News', url: gn('("unicorn startup" OR "unicorn valuation" OR "$1 billion valuation") when:7d') },
      { name: 'Decacorn News', url: gn('("decacorn" OR "$10 billion valuation") startup when:14d') },
    ],
    accelerators: [
      { name: 'YC News', url: 'https://news.ycombinator.com/rss' },
      { name: 'YC Blog', url: 'https://www.ycombinator.com/blog/rss/' },
      { name: 'Demo Day News', url: gn('("demo day" OR "YC batch" OR "accelerator batch") startup when:7d') },
    ],
    security: [
      { name: 'Krebs Security', url: 'https://krebsonsecurity.com/feed/' },
      { name: 'Dark Reading', url: 'https://www.darkreading.com/rss.xml' },
    ],
    policy: [
      { name: 'Politico Tech', url: 'https://rss.politico.com/technology.xml' },
      { name: 'AI Regulation', url: gn('AI regulation OR "artificial intelligence" law OR policy when:7d') },
      { name: 'Tech Antitrust', url: gn('tech antitrust OR FTC Google OR FTC Apple OR FTC Amazon when:7d') },
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
      { name: 'Layoffs.fyi', url: gn('tech+layoffs+when:7d') },
      { name: 'TechCrunch Layoffs', url: 'https://techcrunch.com/tag/layoffs/feed/' },
    ],
    finance: [
      { name: 'CNBC Tech', url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html' },
      { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/rss/topstories' },
    ],
    dev: [
      { name: 'Dev.to', url: 'https://dev.to/feed' },
      { name: 'Lobsters', url: 'https://lobste.rs/rss' },
      { name: 'Changelog', url: 'https://changelog.com/feed' },
      { name: 'Show HN', url: 'https://hnrss.org/show' },
    ],
    ipo: [
      { name: 'IPO News', url: gn('(IPO OR "initial public offering" OR SPAC) tech when:7d') },
      { name: 'Tech IPO News', url: gn('tech IPO OR "tech company" IPO when:7d') },
    ],
    producthunt: [
      { name: 'Product Hunt', url: 'https://www.producthunt.com/feed' },
    ],
    hardware: [
      { name: "Tom's Hardware", url: 'https://www.tomshardware.com/feeds/all' },
      { name: 'SemiAnalysis', url: 'https://www.semianalysis.com/feed' },
      { name: 'Semiconductor News', url: gn('semiconductor OR chip OR TSMC OR NVIDIA OR Intel when:3d') },
    ],
    outages: [
      { name: 'AWS Status', url: gn('AWS outage OR "Amazon Web Services" down when:1d') },
      { name: 'Cloud Outages', url: gn('(Azure outage OR "Google Cloud" outage OR Cloudflare outage OR Slack down OR GitHub down) when:1d') },
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
      { name: 'The Block', url: 'https://news.google.com/rss/search?q=site:theblock.co+when:1d&hl=en-US&gl=US&ceid=US:en' },
      { name: 'Decrypt', url: 'https://decrypt.co/feed' },
      { name: 'Blockworks', url: 'https://blockworks.co/feed' },
      { name: 'The Defiant', url: 'https://thedefiant.io/feed' },
      { name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/feed' },
      { name: 'DL News', url: 'https://news.google.com/rss/search?q=site:dlnews.com+when:3d&hl=en-US&gl=US&ceid=US:en' },
      { name: 'CryptoSlate', url: 'https://cryptoslate.com/feed/' },
      { name: 'Unchained', url: 'https://unchainedcrypto.com/feed/' },
      { name: 'DeFi News', url: 'https://news.google.com/rss/search?q=(DeFi+OR+"decentralized+finance")+when:3d&hl=en-US&gl=US&ceid=US:en' },
      { name: 'Bloomberg Crypto', url: 'https://news.google.com/rss/search?q=bloomberg+crypto+when:1d&hl=en-US&gl=US&ceid=US:en' },
      { name: 'Reuters Crypto', url: 'https://news.google.com/rss/search?q=reuters+crypto+when:1d&hl=en-US&gl=US&ceid=US:en' },
      { name: 'Wu Blockchain', url: 'https://news.google.com/rss/search?q=site:wublockchain.com+when:7d&hl=en-US&gl=US&ceid=US:en' },
      { name: 'Messari', url: 'https://news.google.com/rss/search?q=site:messari.io+when:3d&hl=en-US&gl=US&ceid=US:en' },
      { name: 'NFT News', url: 'https://news.google.com/rss/search?q=(NFT+OR+"non-fungible")+when:3d&hl=en-US&gl=US&ceid=US:en' },
      { name: 'Stablecoin Policy', url: 'https://news.google.com/rss/search?q=(stablecoin+regulation+OR+"stablecoin+bill")+when:7d&hl=en-US&gl=US&ceid=US:en' },
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
    derivatives: [
      { name: 'Options Market', url: gn('("options market" OR "options trading" OR "put call ratio" OR VIX) when:2d') },
      { name: 'Futures Trading', url: gn('("futures trading" OR "S&P 500 futures" OR "Nasdaq futures") when:1d') },
    ],
    fintech: [
      { name: 'Fintech News', url: gn('(fintech OR "payment technology" OR neobank OR "digital banking") when:3d') },
      { name: 'Trading Tech', url: gn('("algorithmic trading" OR "trading platform" OR "quantitative finance") when:7d') },
      { name: 'Blockchain Finance', url: gn('("blockchain finance" OR tokenization OR "digital securities" OR CBDC) when:7d') },
    ],
    regulation: [
      { name: 'SEC', url: 'https://www.sec.gov/news/pressreleases.rss' },
      { name: 'Financial Regulation', url: gn('(SEC OR CFTC OR FINRA OR FCA) regulation OR enforcement when:3d') },
      { name: 'Banking Rules', url: gn('(Basel OR "capital requirements" OR "banking regulation") when:7d') },
      { name: 'Crypto Regulation', url: gn('(crypto regulation OR "digital asset" regulation OR stablecoin regulation) when:7d') },
    ],
    institutional: [
      { name: 'Hedge Fund News', url: gn('("hedge fund" OR Bridgewater OR Citadel OR Renaissance) when:7d') },
      { name: 'Private Equity', url: gn('("private equity" OR Blackstone OR KKR OR Apollo OR Carlyle) when:3d') },
      { name: 'Sovereign Wealth', url: gn('("sovereign wealth fund" OR "pension fund" OR "institutional investor") when:7d') },
    ],
    analysis: [
      { name: 'Market Outlook', url: gn('("market outlook" OR "stock market forecast" OR "bull market" OR "bear market") when:3d') },
      { name: 'Risk & Volatility', url: gn('(VIX OR "market volatility" OR "risk off" OR "market correction") when:3d') },
      { name: 'Bank Research', url: gn('("Goldman Sachs" OR JPMorgan OR "Morgan Stanley") forecast OR outlook when:3d') },
    ],
    gccNews: [
      { name: 'Arabian Business', url: gn('site:arabianbusiness.com (Saudi Arabia OR UAE OR GCC) when:7d') },
      { name: 'The National', url: gn('site:thenationalnews.com (Abu Dhabi OR UAE OR Saudi) when:7d') },
      { name: 'Arab News', url: gn('site:arabnews.com (Saudi Arabia OR investment OR infrastructure) when:7d') },
      { name: 'Gulf FDI', url: gn('(PIF OR "DP World" OR Mubadala OR ADNOC OR Masdar OR "ACWA Power") infrastructure when:7d') },
      { name: 'Gulf Investments', url: gn('("Saudi Arabia" OR UAE OR "Abu Dhabi") investment infrastructure when:7d') },
      { name: 'Vision 2030', url: gn('"Vision 2030" (project OR investment OR announced) when:14d') },
    ],
  },

  // ── Commodity variant (Mining, Metals, Energy) ─────────────────────────────
  commodity: {
    'commodity-news': [
      { name: 'Kitco News', url: gn('site:kitco.com gold OR silver OR commodity OR metals when:1d') },
      { name: 'Mining.com', url: 'https://www.mining.com/feed/' },
      { name: 'Bloomberg Commodities', url: gn('site:bloomberg.com commodities OR metals OR mining when:1d') },
      { name: 'Reuters Commodities', url: gn('site:reuters.com commodities OR metals OR mining when:1d') },
      { name: 'S&P Global Commodity', url: gn('site:spglobal.com commodities metals when:3d') },
      { name: 'Commodity Trade Mantra', url: gn('commodities trading metals energy gold silver when:1d') },
      { name: 'CNBC Commodities', url: gn('site:cnbc.com (commodities OR metals OR gold OR copper) when:1d') },
    ],
    'gold-silver': [
      { name: 'Kitco Gold', url: gn('site:kitco.com gold price OR "gold market" OR "silver price" when:2d') },
      { name: 'Gold Price News', url: gn('(gold price OR "gold market" OR bullion OR LBMA) when:1d') },
      { name: 'Silver Price News', url: gn('(silver price OR "silver market" OR "silver futures") when:2d') },
      { name: 'Precious Metals', url: gn('("precious metals" OR platinum OR palladium OR "gold ETF" OR GLD OR SLV) when:2d') },
      { name: 'World Gold Council', url: gn('"World Gold Council" OR "central bank gold" OR "gold reserves" when:7d') },
    ],
    energy: [
      { name: 'OilPrice.com', url: 'https://oilprice.com/rss/main' },
      { name: 'Rigzone', url: 'https://www.rigzone.com/news/rss/rigzone_latest.aspx' },
      { name: 'EIA Reports', url: gn('site:eia.gov energy oil gas when:14d') },
      { name: 'OPEC News', url: gn('(OPEC OR "oil price" OR "crude oil" OR WTI OR Brent OR "oil production") when:1d') },
      { name: 'Natural Gas News', url: gn('("natural gas" OR LNG OR "gas price" OR "Henry Hub") when:1d') },
      { name: 'Energy Intel', url: gn('(energy commodities OR "energy market" OR "energy prices") when:2d') },
      { name: 'Reuters Energy', url: gn('site:reuters.com (oil OR gas OR energy) when:1d') },
    ],
    'mining-news': [
      { name: 'Mining Journal', url: gn('site:mining-journal.com when:7d') },
      { name: 'Northern Miner', url: gn('site:northernminer.com when:7d') },
      { name: 'Mining Weekly', url: gn('site:miningweekly.com when:7d') },
      { name: 'Mining Technology', url: 'https://www.mining-technology.com/feed/' },
      { name: 'Australian Mining', url: 'https://www.australianmining.com.au/feed/' },
      { name: 'Mine Web (SNL)', url: gn('("mining company" OR "mine production" OR "mining operations") when:2d') },
      { name: 'Resource World', url: gn('("mining project" OR "mineral exploration" OR "mine development") when:3d') },
    ],
    'critical-minerals': [
      { name: 'Benchmark Mineral', url: gn('("critical minerals" OR "battery metals" OR lithium OR cobalt OR "rare earths") when:2d') },
      { name: 'Lithium Market', url: gn('(lithium price OR "lithium market" OR "lithium supply" OR spodumene OR LCE) when:2d') },
      { name: 'Cobalt Market', url: gn('(cobalt price OR "cobalt market" OR "DRC cobalt" OR "battery cobalt") when:3d') },
      { name: 'Rare Earths News', url: gn('("rare earth" OR "rare earths" OR REE OR neodymium OR praseodymium) when:3d') },
      { name: 'EV Battery Supply', url: gn('("EV battery" OR "battery supply chain" OR "battery materials") when:3d') },
      { name: 'IEA Critical Minerals', url: gn('site:iea.org (minerals OR critical OR battery) when:14d') },
      { name: 'Uranium Market', url: gn('(uranium price OR "uranium market" OR U3O8 OR nuclear fuel) when:3d') },
    ],
    'base-metals': [
      { name: 'LME Metals', url: gn('(LME OR "London Metal Exchange") copper OR aluminum OR zinc OR nickel when:2d') },
      { name: 'Copper Market', url: gn('(copper price OR "copper market" OR "copper supply" OR COMEX copper) when:2d') },
      { name: 'Nickel News', url: gn('(nickel price OR "nickel market" OR "nickel supply" OR Indonesia nickel) when:3d') },
      { name: 'Aluminum & Zinc', url: gn('(aluminum price OR aluminium OR zinc price OR "base metals") when:3d') },
      { name: 'Iron Ore Market', url: gn('("iron ore" price OR "iron ore market" OR "steel raw materials") when:2d') },
      { name: 'Metals Bulletin', url: gn('("metals market" OR "base metals" OR SHFE OR "Shanghai Futures") when:2d') },
    ],
    'mining-companies': [
      { name: 'BHP News', url: gn('BHP (mining OR production OR results OR copper OR "iron ore") when:7d') },
      { name: 'Rio Tinto News', url: gn('"Rio Tinto" (mining OR production OR results OR Pilbara) when:7d') },
      { name: 'Glencore & Vale', url: gn('(Glencore OR Vale) (mining OR production OR cobalt OR "iron ore") when:7d') },
      { name: 'Gold Majors', url: gn('(Newmont OR Barrick OR AngloGold OR Agnico) (gold mine OR production OR results) when:7d') },
      { name: 'Freeport & Copper Miners', url: gn('(Freeport McMoRan OR Southern Copper OR Teck OR Antofagasta) when:7d') },
      { name: 'Critical Mineral Companies', url: gn('(Albemarle OR SQM OR "MP Materials" OR Lynas OR Cameco) when:7d') },
    ],
    'supply-chain': [
      { name: 'Shipping & Freight', url: gn('("bulk carrier" OR "dry bulk" OR "commodity shipping" OR "Port Hedland" OR "Strait of Hormuz") when:3d') },
      { name: 'Trade Routes', url: gn('("trade route" OR "supply chain" OR "commodity export" OR "mineral export") when:3d') },
      { name: 'China Commodity Imports', url: gn('China imports copper OR "iron ore" OR lithium OR cobalt OR "rare earth" when:3d') },
      { name: 'Port & Logistics', url: gn('("iron ore port" OR "copper port" OR "commodity port" OR "mineral logistics") when:7d') },
    ],
    'commodity-regulation': [
      { name: 'Mining Regulation', url: gn('("mining regulation" OR "mining policy" OR "mining permit" OR "mining ban") when:7d') },
      { name: 'ESG in Mining', url: gn('("mining ESG" OR "responsible mining" OR "mine closure" OR tailings) when:7d') },
      { name: 'Trade & Tariffs', url: gn('("mineral tariff" OR "metals tariff" OR "critical mineral policy" OR "mining export ban") when:7d') },
      { name: 'Indonesia Nickel Policy', url: gn('(Indonesia nickel OR "nickel export" OR "nickel ban" OR "nickel processing") when:7d') },
      { name: 'China Mineral Policy', url: gn('China "rare earth" OR "mineral export" OR "critical mineral" policy OR restriction when:7d') },
    ],
    markets: [
      { name: 'Yahoo Finance Commodities', url: 'https://finance.yahoo.com/rss/topstories' },
      { name: 'CNBC Markets', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
      { name: 'Seeking Alpha Metals', url: gn('site:seekingalpha.com (gold OR silver OR copper OR mining) when:2d') },
      { name: 'Commodity Futures', url: gn('(COMEX OR NYMEX OR "commodity futures" OR CME commodities) when:2d') },
    ],
    finance: [
      { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
      { name: 'MarketWatch', url: gn('site:marketwatch.com markets when:1d') },
      { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex' },
      { name: 'Financial Times', url: 'https://www.ft.com/rss/home' },
      { name: 'Reuters Business', url: gn('site:reuters.com business markets when:1d') },
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
      { name: 'Human Progress', url: 'https://humanprogress.org/feed/' },
    ],
    nature: [
      { name: 'Mongabay', url: 'https://news.mongabay.com/feed/' },
      { name: 'Conservation Optimism', url: 'https://conservationoptimism.org/feed/' },
    ],
    inspiring: [
      { name: 'GNN Heroes', url: 'https://www.goodnewsnetwork.org/category/news/inspiring/feed/' },
      { name: 'GNN Health', url: 'https://www.goodnewsnetwork.org/category/news/health/feed/' },
    ],
    community: [
      { name: 'Yes! Magazine', url: 'https://www.yesmagazine.org/feed' },
      { name: 'Shareable', url: 'https://www.shareable.net/feed/' },
    ],
  },
};

export const INTEL_SOURCES: ServerFeed[] = [
  { name: 'Defense One', url: 'https://www.defenseone.com/rss/all/' },
  { name: 'The War Zone', url: 'https://www.twz.com/feed' },
  { name: 'Defense News', url: 'https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml' },
  { name: 'Military Times', url: 'https://www.militarytimes.com/arc/outboundfeeds/rss/?outputType=xml' },
  { name: 'Task & Purpose', url: 'https://taskandpurpose.com/feed/' },
  { name: 'USNI News', url: 'https://news.google.com/rss/search?q=site:news.usni.org+when:3d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'gCaptain', url: 'https://gcaptain.com/feed/' },
  { name: 'Oryx OSINT', url: 'https://www.oryxspioenkop.com/feeds/posts/default?alt=rss' },
  { name: 'Foreign Policy', url: 'https://foreignpolicy.com/feed/' },
  { name: 'Foreign Affairs', url: 'https://www.foreignaffairs.com/rss.xml' },
  { name: 'Atlantic Council', url: 'https://www.atlanticcouncil.org/feed/' },
  { name: 'Bellingcat', url: gn('site:bellingcat.com when:7d') },
  { name: 'Krebs Security', url: 'https://krebsonsecurity.com/feed/' },
  { name: 'Arms Control Assn', url: gn('site:armscontrol.org when:7d') },
  { name: 'Bulletin of Atomic Scientists', url: gn('site:thebulletin.org when:7d') },
  { name: 'FAO News', url: 'https://www.fao.org/feeds/fao-newsroom-rss' },
];
