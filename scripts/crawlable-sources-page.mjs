// Source catalog classification and the dedicated /sources/ marketing page.
// This stays separate from the shared corpus generator so the large page-specific
// template does not obscure the corpus orchestration and other page families.

import {
  catalogCoverageCountryOptions,
  catalogCountryOptions,
  resolveSourceOrigin,
  sourceOriginFilterValue,
  sourceOriginLabel,
} from './source-origin.mjs';
import {
  isSyndicationTransportEntry,
  uniqueSorted,
} from './source-catalog-identity.mjs';

// Hand-authored marketing copy for the /sources/ catalog page. Domains and
// their docs anchors mirror docs/data-sources.mdx section headings; the
// aggregate counts are computed from the committed attribution manifest, so
// the page cannot drift from the tracked inventory.
const SOURCE_DOMAINS = [
  {
    id: 'geopolitics',
    name: 'Geopolitics & Conflict',
    anchor: 'geopolitics-%26-conflict',
    blurb: 'Conflict events, protests, displacement, travel advisories, and rocket alerts — from academically curated databases to real-time sirens.',
    providers: ['ACLED', 'UCDP', 'GDELT', 'UN OCHA HAPI', 'Polymarket', 'US / UK / AU travel advisories'],
  },
  {
    id: 'military',
    name: 'Military & Strategic',
    anchor: 'military-%26-strategic',
    blurb: 'Military bases, live ADS-B military flights, naval activity, tracked satellites, and GPS jamming detected from transponder anomalies.',
    providers: ['adsb.lol', 'Wingbits', 'CelesTrak', 'gpsjam.org', 'LiveUAMap'],
  },
  {
    id: 'news',
    name: 'News & OSINT',
    anchor: 'news-%26-osint',
    blurb: 'Tiered news feeds across every product variant, a curated Telegram OSINT lane with public trust badges, live TV, and webcam grids — every source disclosed and bias-tagged.',
    providers: ['Reuters', 'BBC', 'AP', 'Al Jazeera', 'Bellingcat', 'ISW', 'Telegram OSINT'],
  },
  {
    id: 'finance',
    name: 'Finance & Economics',
    anchor: 'finance-%26-economics',
    blurb: 'Official macro series from central banks and statistical agencies, live market and crypto data, and global trade flows.',
    providers: ['FRED', 'ECB', 'BIS', 'Eurostat', 'World Bank', 'UN Comtrade', 'CoinGecko'],
  },
  {
    id: 'energy',
    name: 'Energy & Commodities',
    anchor: 'energy-%26-commodities',
    blurb: 'EU gas storage, US crude inventories, IEA oil stocks, gold reserves and ETF flows, fuel prices, and trader positioning.',
    providers: ['GIE AGSI+', 'U.S. EIA', 'IEA', 'CFTC', 'IMF'],
  },
  {
    id: 'infrastructure',
    name: 'Infrastructure & Cyber',
    anchor: 'infrastructure-%26-cyber',
    blurb: 'Undersea cables, pipelines, strategic ports, AI datacenters, internet outages, and live threat-intelligence feeds.',
    providers: ['Cloudflare Radar', 'Submarine Cable Map', 'abuse.ch', 'AbuseIPDB', 'Epoch AI'],
  },
  {
    id: 'environment',
    name: 'Environment & Disasters',
    anchor: 'environment-%26-disasters',
    blurb: 'Earthquakes, UN-coordinated disaster alerts, satellite fire detection, Pacific cyclones, and climate anomalies over conflict-prone zones.',
    providers: ['USGS', 'GDACS', 'NASA FIRMS', 'NASA EONET', 'Open-Meteo'],
  },
  {
    id: 'aviation',
    name: 'Aviation & Airspace',
    anchor: 'aviation-%26-airspace',
    blurb: '115 monitored airports with delay and NOTAM closure detection, live flight tracking, and airline operations intelligence.',
    providers: ['FAA', 'ICAO', 'AviationStack', 'adsb.lol', 'OpenSky Network'],
  },
  {
    id: 'china',
    name: 'China Coverage',
    anchor: 'china-coverage',
    blurb: 'Source-attributed official lanes: NBS and SAFE macro, ministry policy documents, exchange disclosures, and cross-strait activity claims.',
    providers: ['NBS', 'SAFE', "People's Bank of China", 'SSE / SZSE', 'Taiwan MND'],
  },
  {
    id: 'technology',
    name: 'Tech Ecosystem',
    anchor: 'tech-ecosystem',
    blurb: 'Company HQs, startup hubs, cloud regions, accelerators, and research signals from repository analytics to conference calendars.',
    providers: ['Crunchbase News', 'GitHub', 'OSS Insight', 'Product Hunt'],
  },
];

const SOURCE_DOMAIN_MATCHERS = [
  ['china', /china|cross-strait|taiwan.mnd|pbo[cC]|safe\.gov|stats\.gov\.cn|sse\.com|szse\.cn/],
  ['military', /military|defen[cs]e|gpsjam|wingbits|oref|pizzint|mirta|airplanes\.live|adsb\.lol|celestrak/],
  ['aviation', /aviation|airline|airspace|airport|flight|notam|opensky|travelpayouts/],
  ['environment', /climate|natural|earthquake|wildfire|fire-detection|weather|cyclone|disaster|air-quality|radiation|disease|eonet|firms/],
  ['energy', /energy|fuel|gas-storage|petroleum|oil-stock|electricity|gold|commodity|mineral|jodi|eia\.gov|gie\.eu|ember|low-carbon|power-reliability|fossil/],
  ['infrastructure', /infrastructure|cyber|cable|cloudflare|service-status|pipeline|internet-outage|portwatch|chokepoint|maritime|navigational-warning|abuseipdb|abuse\.ch/],
  ['finance', /econom|market|finance|stock|crypto|coin|exchange-rate|\bfx\b|yield|central-bank|trade|supply-chain|grocery|bigmac|debt|bis-|ecb-|eurostat|world-bank|comtrade|fao-food|treasury|fiscaldata/],
  ['technology', /research|company|github|agentskills|technology|regulatory|tender|patent|startup|product-hunt|ossinsight|exa\.ai|firecrawl/],
  ['geopolitics', /conflict|unrest|acled|ucdp|gdelt|security-advisor|sanction|travel-advisor|displacement|resilience|country-fact|prediction-market|forecast-market|hapi/],
];

// The manifest records providers and code references, not a marketing domain.
// Keep ambiguous structured providers explicit so a new unmatched provider
// fails the build instead of silently becoming "geopolitics".
const SOURCE_DOMAIN_OVERRIDES = new Map([
  ['Alberta Emergency Alert', 'environment'],
  ['B.C. Evacuation Orders and Alerts', 'environment'],
  ['SaskAlert', 'environment'],
  ['Hyperliquid', 'finance'],
  ['api.rainviewer.com', 'environment'],
  ['api.scrapecreators.com', 'news'],
  ['api.telegram.org', 'news'],
  ['api.tzevaadom.co.il', 'military'],
  ['api.usaspending.gov', 'finance'],
  ['api.windy.com', 'environment'],
  ['archive-api.open-meteo.com', 'environment'],
  ['British Geological Survey World Mineral Statistics', 'energy'],
  ['Bank of Canada', 'finance'],
  ['bothsidesofthetable.com', 'technology'],
  ['City of Toronto Open Data', 'infrastructure'],
  ['Toronto Police Service Open Data', 'geopolitics'],
  ['GTA Update', 'geopolitics'],
  ['contxto.com', 'technology'],
  ['corridorrisk.io', 'infrastructure'],
  ['CWFIS / CWFIF (NRCan)', 'environment'],
  ['BC Wildfire Service (OpenMaps)', 'environment'],
  ['data.ecb.europa.eu', 'finance'],
  ['SEC EDGAR', 'finance'],
  ['datalab.wto.org', 'finance'],
  ['disrupt-africa.com', 'technology'],
  ['Element84 Earth Search STAC', 'environment'],
  ['Earthquakes Canada (NRCan)', 'environment'],
  ['en.sge.com.cn', 'finance'],
  ['Environment and Climate Change Canada (ECCC)', 'environment'],
  ['SEC EDGAR Full-Text Search', 'finance'],
  ['fc.yahoo.com', 'finance'],
  ['gml.noaa.gov', 'environment'],
  ['kr-asia.com', 'news'],
  ['lavca.org', 'technology'],
  ['news.usni.org', 'military'],
  ['Ontario 511', 'infrastructure'],
  ['Alberta 511', 'infrastructure'],
  ['Manitoba 511', 'infrastructure'],
  ['BC Open511', 'infrastructure'],
  ['oauth.reddit.com', 'news'],
  ['overpass-api.de', 'military'],
  ['pitchbook.com', 'technology'],
  ['production.dataviz.cnn.io', 'finance'],
  ['schema.org', 'technology'],
  ['Statistics Canada', 'finance'],
  ['wabi-europe-north-b-api.analysis.windows.net', 'infrastructure'],
  ['web.archive.org', 'geopolitics'],
  ['www.aaii.com', 'finance'],
  ['www.aaronsw.com', 'technology'],
  ['www.cbr.ru', 'finance'],
  ['Financial Action Task Force (FATF)', 'geopolitics'],
  ['Global Affairs Canada (SEMA consolidated sanctions)', 'geopolitics'],
  ['www.fwdstart.me', 'technology'],
  ['International Forum of Sovereign Wealth Funds', 'finance'],
  ['ILOSTAT', 'finance'],
  ['www.newyorkfed.org', 'finance'],
  ['www.nfx.com', 'technology'],
  ['www.reddit.com', 'news'],
  ['www.sequoiacap.com', 'technology'],
  ['SWF Institute', 'finance'],
  ['Toronto Transit Commission (TTC) GTFS-RT', 'infrastructure'],
  ['Toronto Fire Services', 'environment'],
  ['Toronto Police Service', 'environment'],
  ['United Nations Population Division', 'finance'],
  ['USGS ScienceBase (Mineral Commodity Summaries)', 'energy'],
  ['VIA Rail Tracker (unofficial)', 'infrastructure'],
  ['www.techstars.com', 'technology'],
  ['www.windy.com', 'environment'],
  ['your-app.convex.site', 'infrastructure'],
]);

// Attribution is host-oriented because licensing and URL discovery happen at
// that boundary. The marketing catalog needs the public name people recognize.
// Keep the hostname as the traceability link, but never make it do double duty
// as the visible provider title.
const SOURCE_NAME_OVERRIDES = new Map([
  ['acleddata.com', 'ACLED'],
  ['adsb.lol', 'ADSB.lol'],
  ['aerotime.aero', 'AeroTime'],
  ['agentskills.io', 'Agent Skills'],
  ['agsi.gie.eu', 'GIE AGSI+'],
  ['airlinegeeks.com', 'AirlineGeeks'],
  ['airplanes.live', 'Airplanes.live'],
  ['api.abuseipdb.com', 'AbuseIPDB'],
  ['api.aviationstack.com', 'AviationStack'],
  ['api.coingecko.com', 'CoinGecko'],
  ['api.data.gov.my', 'Malaysia Open Data'],
  ['api.datos.gob.mx', 'Mexico Open Data'],
  ['api.eia.gov', 'U.S. Energy Information Administration (EIA)'],
  ['api.fiscaldata.treasury.gov', 'U.S. Treasury Fiscal Data'],
  ['api.gdeltproject.org', 'GDELT'],
  ['api.iea.org', 'International Energy Agency (IEA)'],
  ['api.imd.gov.in', 'India Meteorological Department'],
  ['api.imf.org', 'International Monetary Fund (IMF)'],
  ['api.ossinsight.io', 'OSS Insight'],
  ['en.sge.com.cn', 'Shanghai Gold Exchange (SGE)'],
  ['api.planespotters.net', 'Planespotters.net'],
  ['api.sam.gov', 'SAM.gov'],
  ['api.spdrgoldshares.com', 'SPDR Gold Shares'],
  ['api.stlouisfed.org', 'Federal Reserve Economic Data (FRED)'],
  ['api.ted.europa.eu', 'Tenders Electronic Daily (TED)'],
  ['api.tzevaadom.co.il', 'Tzeva Adom'],
  ['api.unhcr.org', 'UNHCR'],
  ['api.usaspending.gov', 'USAspending.gov'],
  ['api.weather.gc.ca', 'Environment and Climate Change Canada (ECCC)'],
  ['api.weather.gov', 'U.S. National Weather Service'],
  ['severeweather.wmo.int', 'WMO Severe Weather Information Centre'],
  ['api.worldbank.org', 'World Bank'],
  ['api.wto.org', 'World Trade Organization (WTO)'],
  ['arxiv.org', 'arXiv'],
  ['auth.opensky-network.org', 'OpenSky Network'],
  ['budgetlab.yale.edu', 'The Budget Lab at Yale'],
  ['celestrak.org', 'CelesTrak'],
  ['comtradeapi.un.org', 'UN Comtrade'],
  ['customer-api.wingbits.com', 'Wingbits'],
  ['data-api.ecb.europa.eu', 'European Central Bank (ECB)'],
  ['data.ecb.europa.eu', 'European Central Bank (ECB)'],
  ['data.humdata.org', 'Humanitarian Data Exchange (HDX)'],
  ['data.weather.gov.hk', 'Hong Kong Observatory'],
  ['datalab.wto.org', 'WTO Data Lab'],
  ['dataservices.icao.int', 'International Civil Aviation Organization (ICAO)'],
  ['drmkc.jrc.ec.europa.eu', 'EU Disaster Risk Management Knowledge Centre'],
  ['e00-elmundo.uecdn.es', 'El Mundo'],
  ['earthobservatory.nasa.gov', 'NASA Earth Observatory'],
  ['earthquake.usgs.gov', 'U.S. Geological Survey (USGS)'],
  ['ecs-api.wingbits.com', 'Wingbits'],
  ['en.sse.net.cn', 'Shanghai Stock Exchange'],
  ['en.wikipedia.org', 'Wikipedia'],
  ['eonet.gsfc.nasa.gov', 'NASA EONET'],
  ['ec.europa.eu', 'European Commission'],
  ['energy.ec.europa.eu', 'European Commission Directorate-General for Energy'],
  ['export.arxiv.org', 'arXiv'],
  ['fc.yahoo.com', 'Yahoo Finance'],
  ['feed.infoq.com', 'InfoQ'],
  ['feeds.abcnews.com', 'ABC News'],
  ['feeds.arstechnica.com', 'Ars Technica'],
  ['feeds.bbci.co.uk', 'BBC'],
  ['feeds.content.dowjones.io', 'The Wall Street Journal'],
  ['feeds.elpais.com', 'El País'],
  ['feeds.feedburner.com', 'FeedBurner-hosted publishers'],
  ['feeds.folha.uol.com.br', 'Folha de S.Paulo'],
  ['feeds.megaphone.fm', 'Pivot Podcast'],
  ['feeds.nbcnews.com', 'NBC News'],
  ['feeds.news24.com', 'News24'],
  ['feeds.nos.nl', 'NOS Nieuws'],
  ['feeds.npr.org', 'NPR'],
  ['feodotracker.abuse.ch', 'Feodo Tracker'],
  ['finance.yahoo.com', 'Yahoo Finance'],
  ['firms.modaps.eosdis.nasa.gov', 'NASA FIRMS'],
  ['gain.nd.edu', 'Notre Dame Global Adaptation Initiative'],
  ['gamma-api.polymarket.com', 'Polymarket'],
  ['geospatial-usace.opendata.arcgis.com', 'U.S. Army Corps of Engineers'],
  ['ghoapi.azureedge.net', 'World Health Organization (WHO)'],
  ['github.blog', 'GitHub Blog'],
  ['gml.noaa.gov', 'NOAA Global Monitoring Laboratory'],
  ['hacker-news.firebaseio.com', 'Hacker News'],
  ['hapi.humdata.org', 'UN OCHA Humanitarian API (HAPI)'],
  ['health.aws.amazon.com', 'AWS Health'],
  ['hnrss.org', 'Hacker News RSS'],
  ['mausam.imd.gov.in', 'India Meteorological Department'],
  ['mapservices.weather.noaa.gov', 'NOAA Weather'],
  ['moxie.foxnews.com', 'Fox News'],
  ['msi.nga.mil', 'NGA Maritime Safety Information'],
  ['nasstatus.faa.gov', 'Federal Aviation Administration (FAA)'],
  ['news.crunchbase.com', 'Crunchbase News'],
  ['news.google.com', 'Google News'],
  ['apnews.com', 'AP News'],
  ['arabianbusiness.com', 'Arabian Business'],
  ['arabnews.com', 'Arab News'],
  ['arctictoday.com', 'Arctic Today'],
  ['armscontrol.org', 'Arms Control Association'],
  ['asianews.it', 'AsiaNews'],
  ['bangkokpost.com', 'Bangkok Post'],
  ['bihus.info', 'Bihus.Info'],
  ['citinewsroom.com', 'Citi Newsroom'],
  ['cp24.com', 'CP24'],
  ['ctvnews.ca', 'CTV News'],
  ['dlnews.com', 'DL News'],
  ['euromaidanpress.com', 'Euromaidan Press'],
  ['focustaiwan.tw', 'Focus Taiwan'],
  ['gmfus.org', 'German Marshall Fund'],
  ['hiiraan.com', 'Hiiraan Online'],
  ['hirado.hu', 'Híradó'],
  ['iranintl.com', 'Iran International'],
  ['iseas.edu.sg', 'ISEAS – Yusof Ishak Institute'],
  ['iss.europa.eu', 'EU Institute for Security Studies'],
  ['justice.gov', 'U.S. Department of Justice'],
  ['kyivindependent.com', 'Kyiv Independent'],
  ['lowyinstitute.org', 'Lowy Institute'],
  ['marketwatch.com', 'MarketWatch'],
  ['miningweekly.com', 'Mining Weekly'],
  ['montrealgazette.com', 'Montreal Gazette'],
  ['oglobo.globo.com', 'O Globo'],
  ['pravda.com.ua', 'Ukrainska Pravda'],
  ['rferl.org', 'RFE/RL'],
  ['rieti.go.jp', 'RIETI'],
  ['spglobal.com', 'S&P Global'],
  ['state.gov', 'U.S. Department of State'],
  ['taipeitimes.com', 'Taipei Times'],
  ['taiwannews.com.tw', 'Taiwan News'],
  ['theblock.co', 'The Block'],
  ['thebulletin.org', 'Bulletin of the Atomic Scientists'],
  ['theinformation.com', 'The Information'],
  ['thejakartapost.com', 'The Jakarta Post'],
  ['thenextweb.com', 'The Next Web'],
  ['thestar.com.my', 'The Star (Malaysia)'],
  ['understandingwar.org', 'Institute for the Study of War'],
  ['unhcr.org', 'UNHCR'],
  ['whitehouse.gov', 'The White House'],
  ['wilsoncenter.org', 'Wilson Center'],
  ['wublockchain.com', 'Wu Blockchain'],
  ['xinhuanet.com', 'Xinhua'],
  ['zn.ua', 'ZN.UA'],
  ['news.mit.edu', 'MIT News'],
  ['news.un.org', 'UN News'],
  ['news.usni.org', 'USNI News'],
  ['news.ycombinator.com', 'Hacker News'],
  ['nominatim.openstreetmap.org', 'OpenStreetMap Nominatim'],
  ['otx.alienvault.com', 'AlienVault Open Threat Exchange'],
  ['overpass-api.de', 'OpenStreetMap Overpass API'],
  ['patents.google.com', 'Google Patents'],
  ['portwatch.imf.org', 'IMF PortWatch'],
  ['pro-api.coingecko.com', 'CoinGecko'],
  ['production.dataviz.cnn.io', 'CNN'],
  ['public.govdelivery.com', 'GovDelivery'],
  ['publicacionexterna.azurewebsites.net', 'Mexico Energy Regulatory Commission (CRE)'],
  ['qevdnlpgjxpwusesmtpx.supabase.co', 'Supabase'],
  ['query.sse.com.cn', 'Shanghai Stock Exchange'],
  ['query.wikidata.org', 'Wikidata'],
  ['query1.finance.yahoo.com', 'Yahoo Finance'],
  ['raw.githubusercontent.com', 'GitHub'],
  ['rsmcnewdelhi.imd.gov.in', 'India Meteorological Department'],
  ['rss.art19.com', 'ART19-hosted podcasts'],
  ['rss.dw.com', 'Deutsche Welle'],
  ['rss.libsyn.com', 'Libsyn-hosted podcasts'],
  ['rss.politico.com', 'POLITICO'],
  ['sanctionslistservice.ofac.treas.gov', 'U.S. Treasury OFAC'],
  ['sedeaplicaciones.minetur.gob.es', 'Spain Ministry of Industry and Tourism'],
  ['search.worldbank.org', 'World Bank'],
  ['services7.arcgis.com', 'ArcGIS'],
  ['services9.arcgis.com', 'ArcGIS'],
  ['stats.bis.org', 'Bank for International Settlements (BIS)'],
  ['tools.cdc.gov', 'U.S. Centers for Disease Control and Prevention'],
  ['travel.state.gov', 'U.S. Department of State'],
  ['ucdpapi.pcr.uu.se', 'Uppsala Conflict Data Program (UCDP)'],
  ['urlhaus-api.abuse.ch', 'URLhaus'],
  ['wabi-europe-north-b-api.analysis.windows.net', 'Microsoft Power BI'],
  ['web.archive.org', 'Internet Archive'],
  ['www.cbr.ru', 'Bank of Russia'],
  ['www.contractsfinder.service.gov.uk', 'UK Contracts Finder'],
  ['www.ecb.europa.eu', 'European Central Bank (ECB)'],
  ['www.ecdc.europa.eu', 'European Centre for Disease Prevention and Control'],
  ['www.eia.gov', 'U.S. Energy Information Administration (EIA)'],
  ['www.fao.org', 'UN Food and Agriculture Organization (FAO)'],
  ['www.federalreserve.gov', 'U.S. Federal Reserve'],
  ['www.gdacs.org', 'Global Disaster Alert and Coordination System (GDACS)'],
  ['www.gov.uk', 'UK Government'],
  ['www.gov.br', 'Brazilian Government'],
  ['www.iaea.org', 'International Atomic Energy Agency (IAEA)'],
  ['www.iea.org', 'International Energy Agency (IEA)'],
  ['www.jodidata.org', 'Joint Organisations Data Initiative (JODI)'],
  ['www.gets.govt.nz', 'New Zealand Government Electronic Tenders Service'],
  ['www.mbie.govt.nz', 'New Zealand Ministry of Business, Innovation and Employment'],
  ['www.mnd.gov.tw', 'Taiwan Ministry of National Defense'],
  ['www.mod.go.jp', 'Japan Ministry of Defense'],
  ['www.ncei.noaa.gov', 'NOAA National Centers for Environmental Information'],
  ['www.newyorkfed.org', 'Federal Reserve Bank of New York'],
  ['www.opec.org', 'OPEC'],
  ['www.oref.org.il', 'Israel Home Front Command'],
  ['www.pbc.gov.cn', "People's Bank of China"],
  ['www.safe.gov.cn', 'State Administration of Foreign Exchange (SAFE)'],
  ['www.samr.gov.cn', 'China State Administration for Market Regulation'],
  ['www.smartraveller.gov.au', 'Australia Smartraveller'],
  ['www.stats.gov.cn', 'National Bureau of Statistics of China'],
  ['www.szse.cn', 'Shenzhen Stock Exchange'],
  ['www.unep.org', 'UN Environment Programme (UNEP)'],
  ['www.war.gov', 'Pentagon'],
  ['www.weather.gov.hk', 'Hong Kong Observatory'],
  ['www.whitehouse.gov', 'The White House'],
  ['www.who.int', 'World Health Organization (WHO)'],
  ['www.abc.net.au', 'ABC Australia'],
  ['www.afro.who.int', 'WHO Regional Office for Africa'],
  ['wwwnc.cdc.gov', 'U.S. Centers for Disease Control and Prevention'],
]);

const US_EMBASSY_COUNTRIES = new Map([
  ['ae', 'the United Arab Emirates'],
  ['bd', 'Bangladesh'],
  ['co', 'Colombia'],
  ['de', 'Germany'],
  ['do', 'the Dominican Republic'],
  ['in', 'India'],
  ['it', 'Italy'],
  ['mm', 'Myanmar'],
  ['mx', 'Mexico'],
  ['pk', 'Pakistan'],
  ['pl', 'Poland'],
  ['th', 'Thailand'],
  ['ua', 'Ukraine'],
]);

const BRAND_TOKEN_OVERRIDES = new Map([
  ['24', '24.hu'],
  ['444', '444.hu'],
  ['actualite', 'Actualité.cd'],
  ['aaii', 'American Association of Individual Investors (AAII)'],
  ['africanews', 'Africanews'],
  ['aftenposten', 'Aftenposten'],
  ['aljazeera', 'Al Jazeera'],
  ['alarabiya', 'Al Arabiya'],
  ['alphavantage', 'Alpha Vantage'],
  ['amarujala', 'Amar Ujala'],
  ['ansa', 'ANSA'],
  ['arxiv', 'arXiv'],
  ['asharqbusiness', 'Asharq Business'],
  ['astanatimes', 'The Astana Times'],
  ['atlanticcouncil', 'Atlantic Council'],
  ['australianmining', 'Australian Mining'],
  ['aviationpros', 'Aviation Pros'],
  ['aviationweek', 'Aviation Week'],
  ['balkaninsight', 'Balkan Insight'],
  ['bild', 'BILD'],
  ['bitcoinmagazine', 'Bitcoin Magazine'],
  ['bothsidesofthetable', 'Both Sides of the Table'],
  ['brasilparalelo', 'Brasil Paralelo'],
  ['breakingdefense', 'Breaking Defense'],
  ['carbonbrief', 'Carbon Brief'],
  ['cbinsights', 'CB Insights'],
  ['channelnewsasia', 'Channel NewsAsia'],
  ['channelstv', 'Channels Television'],
  ['chinamoney', 'China Money'],
  ['circleci', 'CircleCI'],
  ['climatecentral', 'Climate Central'],
  ['cloudflarestatus', 'Cloudflare Status'],
  ['cointelegraph', 'Cointelegraph'],
  ['collisionconf', 'Collision Conference'],
  ['conservationoptimism', 'Conservation Optimism'],
  ['correctiv', 'CORRECTIV'],
  ['corridorrisk', 'Corridor Risk'],
  ['crisisgroup', 'International Crisis Group'],
  ['cryptoslate', 'CryptoSlate'],
  ['dabangasudan', 'Dabanga Sudan'],
  ['dailygood', 'DailyGood'],
  ['dailysabah', 'Daily Sabah'],
  ['dailytrust', 'Daily Trust'],
  ['darkreading', 'Dark Reading'],
  ['defensenews', 'Defense News'],
  ['defenseone', 'Defense One'],
  ['devops', 'DevOps.com'],
  ['dfrlab', 'DFRLab'],
  ['discordstatus', 'Discord Status'],
  ['dockerstatus', 'Docker Status'],
  ['eluniverso', 'El Universo'],
  ['euronews', 'Euronews'],
  ['finnhub', 'Finnhub'],
  ['firstround', 'First Round Review'],
  ['flightglobal', 'FlightGlobal'],
  ['foreignaffairs', 'Foreign Affairs'],
  ['foreignpolicy', 'Foreign Policy'],
  ['freeipapi', 'FreeIPAPI'],
  ['gcaptain', 'gCaptain'],
  ['github', 'GitHub'],
  ['githubstatus', 'GitHub Status'],
  ['globalinitiative', 'Global Initiative Against Transnational Organized Crime'],
  ['globalnews', 'Global News'],
  ['goldsilverworlds', 'Gold Silver Worlds'],
  ['goodgoodgood', 'Good Good Good'],
  ['goodnewsnetwork', 'Good News Network'],
  ['gpsjam', 'GPSJam'],
  ['handybulk', 'HandyBulk'],
  ['humanprogress', 'Human Progress'],
  ['indianexpress', 'The Indian Express'],
  ['insideclimatenews', 'Inside Climate News'],
  ['insightcrime', 'InSight Crime'],
  ['islandtimes', 'Island Times'],
  ['japantoday', 'Japan Today'],
  ['jeuneafrique', 'Jeune Afrique'],
  ['krebsonsecurity', 'Krebs on Security'],
  ['lasillavacia', 'La Silla Vacía'],
  ['lennysnewsletter', "Lenny's Newsletter"],
  ['lequotidien', 'Le Quotidien'],
  ['lighthousereports', 'Lighthouse Reports'],
  ['linearstatus', 'Linear Status'],
  ['livescience', 'Live Science'],
  ['militarytimes', 'Military Times'],
  ['mempool', 'mempool.space'],
  ['mexiconewsdaily', 'Mexico News Daily'],
  ['myjoyonline', 'MyJoyOnline'],
  ['naftemporiki', 'Naftemporiki'],
  ['netlifystatus', 'Netlify Status'],
  ['newscientist', 'New Scientist'],
  ['newsmaker', 'Newsmaker'],
  ['northernminer', 'The Northern Miner'],
  ['novayagazeta', 'Novaya Gazeta Europe'],
  ['omanobserver', 'Oman Observer'],
  ['oilprice', 'OilPrice.com'],
  ['onemileatatime', 'One Mile at a Time'],
  ['opensky-network', 'OpenSky Network'],
  ['optimistdaily', 'The Optimist Daily'],
  ['oryxspioenkop', 'Oryx'],
  ['outbreaknewstoday', 'Outbreak News Today'],
  ['pitchbook', 'PitchBook'],
  ['polsatnews', 'Polsat News'],
  ['premiumtimesng', 'Premium Times'],
  ['producthunt', 'Product Hunt'],
  ['phys', 'Phys.org'],
  ['radiookapi', 'Radio Okapi'],
  ['radiotamazuj', 'Radio Tamazuj'],
  ['rainviewer', 'RainViewer'],
  ['ransomware', 'Ransomware.live'],
  ['reasonstobecheerful', 'Reasons to Be Cheerful'],
  ['reliefweb', 'ReliefWeb'],
  ['replicatestatus', 'Replicate Status'],
  ['repubblica', 'la Repubblica'],
  ['restcountries', 'REST Countries'],
  ['responsiblestatecraft', 'Responsible Statecraft'],
  ['sciencedaily', 'ScienceDaily'],
  ['scrapecreators', 'ScrapeCreators'],
  ['seekingalpha', 'Seeking Alpha'],
  ['semianalysis', 'SemiAnalysis'],
  ['sequoiacap', 'Sequoia Capital'],
  ['seznamzpravy', 'Seznam Zprávy'],
  ['silverseek', 'SilverSeek'],
  ['simpleflying', 'Simple Flying'],
  ['singularityhub', 'Singularity Hub'],
  ['spdrgoldshares', 'SPDR Gold Shares'],
  ['taskandpurpose', 'Task & Purpose'],
  ['techinasia', 'Tech in Asia'],
  ['techcabal', 'TechCabal'],
  ['techcrunch', 'TechCrunch'],
  ['technologyreview', 'MIT Technology Review'],
  ['techstars', 'Techstars'],
  ['thebetterindia', 'The Better India'],
  ['thedefiant', 'The Defiant'],
  ['thediplomat', 'The Diplomat'],
  ['thehill', 'The Hill'],
  ['thenewstack', 'The New Stack'],
  ['thepointsguy', 'The Points Guy'],
  ['thesentry', 'The Sentry'],
  ['theglobeandmail', 'The Globe and Mail'],
  ['theguardian', 'The Guardian'],
  ['themoscowtimes', 'The Moscow Times'],
  ['thenationalnews', 'The National'],
  ['thereporterethiopia', 'The Reporter Ethiopia'],
  ['thisdaylive', 'THISDAY'],
  ['timesca', 'The Times of Central Asia'],
  ['token2049', 'TOKEN2049'],
  ['tomshardware', "Tom's Hardware"],
  ['trumpstruth', 'Truth Social'],
  ['unchainedcrypto', 'Unchained'],
  ['vanguardngr', 'Vanguard News'],
  ['venturebeat', 'VentureBeat'],
  ['viewfromthewing', 'View from the Wing'],
  ['vnexpress', 'VnExpress'],
  ['warontherocks', 'War on the Rocks'],
  ['websummit', 'Web Summit'],
  ['ycombinator', 'Y Combinator'],
  ['yesmagazine', 'YES! Magazine'],
  ['yonhapnewstv', 'Yonhap News TV'],
  ['yourstory', 'YourStory'],
  ['zdnet', 'ZDNET'],
  ['zoomstatus', 'Zoom Status'],
]);

const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  'co.il', 'co.kr', 'co.uk', 'com.au', 'com.br', 'com.cn', 'com.tr',
  'gov.au', 'gov.cn', 'gov.hk', 'gov.my', 'gob.mx', 'net.cn', 'org.uk',
]);

function hostnameBrandToken(host) {
  const labels = host.toLowerCase().split('.');
  const suffix = labels.slice(-2).join('.');
  const countrySecondLevel = labels.at(-1)?.length === 2
    && /^(?:ac|co|com|edu|gov|net|org)$/.test(labels.at(-2) || '');
  const offset = MULTI_LABEL_PUBLIC_SUFFIXES.has(suffix) || countrySecondLevel ? 3 : 2;
  return labels.at(-offset) || labels[0] || host;
}

function titleCaseBrandToken(token) {
  const override = BRAND_TOKEN_OVERRIDES.get(token);
  if (override) return override;
  return token
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.length <= 4 && /^[a-z]+$/.test(part) ? part.toUpperCase() : `${part[0]?.toUpperCase() || ''}${part.slice(1)}`)
    .join(' ');
}

export function sourceProviderDisplayName(provider, hosts = []) {
  if (!/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/i.test(provider)) return provider;

  const primaryHost = hosts[0] || provider;
  const exact = SOURCE_NAME_OVERRIDES.get(primaryHost) || SOURCE_NAME_OVERRIDES.get(provider);
  if (exact) return exact;

  const embassy = primaryHost.match(/^([a-z]{2})\.usembassy\.gov$/i);
  if (embassy) {
    const country = US_EMBASSY_COUNTRIES.get(embassy[1].toLowerCase());
    if (country) return `U.S. Embassy & Consulates in ${country}`;
  }

  if (primaryHost.endsWith('.euronews.com')) return 'Euronews';
  if (primaryHost.endsWith('.status.atlassian.com')) return 'Atlassian Status';
  if (primaryHost.startsWith('status.')) {
    return `${titleCaseBrandToken(hostnameBrandToken(primaryHost))} Status`;
  }

  return titleCaseBrandToken(hostnameBrandToken(primaryHost));
}

function sourceDomainIdForEntries(entries) {
  const kinds = new Set(entries.flatMap((entry) => entry.kind.split('+')));
  if (kinds.has('operational-status')) return 'infrastructure';
  if (kinds.has('feed')) return 'news';

  const provider = entries[0]?.provider;
  const override = SOURCE_DOMAIN_OVERRIDES.get(provider);
  if (override) return override;

  const searchText = entries.flatMap((entry) => [
    entry.provider,
    entry.host,
    ...(entry.references || []).map((reference) => reference.path),
  ]).join(' ').toLowerCase();
  const match = SOURCE_DOMAIN_MATCHERS.find(([, matcher]) => matcher.test(searchText));
  if (!match) {
    throw new Error(`Source provider needs a catalog domain: ${provider}`);
  }
  return match[0];
}

export function buildSourceCatalog(entries, { logicalProviders = [] } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Source catalog cannot be empty');
  }
  const entriesByProvider = new Map();
  for (const entry of entries) {
    if (isSyndicationTransportEntry(entry)) continue;
    const providerEntries = entriesByProvider.get(entry.provider) || [];
    providerEntries.push(entry);
    entriesByProvider.set(entry.provider, providerEntries);
  }

  const catalog = [...entriesByProvider.entries()].map(([provider, providerEntries]) => {
    const hosts = uniqueSorted(providerEntries.map((entry) => entry.host));
    return {
      provider,
      displayName: sourceProviderDisplayName(provider, hosts),
      domainId: sourceDomainIdForEntries(providerEntries),
      originCountry: resolveSourceOrigin({ provider, hosts }),
      hosts,
      kinds: uniqueSorted(providerEntries.flatMap((entry) => String(entry.kind || '').split('+'))),
      coveredCountries: [],
      transportHosts: [],
    };
  });

  for (const logical of logicalProviders) {
    if (!logical?.provider || entriesByProvider.has(logical.provider)) continue;
    const hosts = uniqueSorted([
      ...(logical.editorialHosts || []),
      ...(logical.transportHosts || []),
    ]);
    catalog.push({
      provider: logical.provider,
      displayName: sourceProviderDisplayName(logical.provider, hosts),
      domainId: 'news',
      originCountry: logical.originCountry ?? resolveSourceOrigin({
        provider: logical.provider,
        hosts: logical.editorialHosts || [],
      }),
      hosts,
      kinds: ['feed'],
      coveredCountries: uniqueSorted(logical.coveredCountries),
      transportHosts: uniqueSorted(logical.transportHosts),
    });
  }

  if (catalog.length === 0) {
    throw new Error('Source catalog cannot be empty');
  }

  return catalog.sort((left, right) => left.displayName.localeCompare(right.displayName, 'en', { sensitivity: 'base' }));
}

export function renderSourcesIndex({ sourceStats, sourceCatalog, baseUrl, lastmod, helpers }) {
  const { absoluteUrl, breadcrumbLd, escapeHtml, pageDocument, withUtmSource } = helpers;
  const path = '/sources/';
  const description = `Explore ${sourceStats.providerCount} active providers and ${sourceStats.activeHosts} source hosts across World Monitor's global intelligence, markets, energy, cyber, aviation, climate and news coverage.`;
  // Query precedes the fragment — withUtmSource() would append after the
  // anchor and push the query into the fragment, so build these by hand.
  const docsHref = (anchor) => `/docs/data-sources?utm_source=seo-sources${anchor ? `#${anchor}` : ''}`;
  const domainCounts = new Map(SOURCE_DOMAINS.map((domain) => [domain.id, 0]));
  for (const provider of sourceCatalog) {
    domainCounts.set(provider.domainId, (domainCounts.get(provider.domainId) || 0) + 1);
  }
  const domainById = new Map(SOURCE_DOMAINS.map((domain) => [domain.id, domain]));
  const kindLabels = {
    feed: 'News / feed',
    structured: 'Structured data',
    'operational-status': 'Operational status',
  };
  const domainCards = SOURCE_DOMAINS.map((domain, index) => `        <article class="source-domain-card">
          <button type="button" data-source-filter="${domain.id}" aria-controls="source-catalog" aria-pressed="false">
            <span class="domain-index">${String(index + 1).padStart(2, '0')}</span>
            <span class="domain-count">${domainCounts.get(domain.id)} providers</span>
            <strong>${escapeHtml(domain.name)}</strong>
            <span class="domain-blurb">${escapeHtml(domain.blurb)}</span>
            <span class="domain-examples">${domain.providers.slice(0, 4).map((provider) => `<span>${escapeHtml(provider)}</span>`).join('')}</span>
          </button>
          <a class="domain-docs" href="${docsHref(domain.anchor)}">Methodology &amp; coverage <span aria-hidden="true">↗</span></a>
        </article>`).join('\n');
  const countryOptions = catalogCountryOptions(sourceCatalog);
  const coverageOptions = catalogCoverageCountryOptions(sourceCatalog);
  const providerCards = sourceCatalog.map((provider) => {
    const domain = domainById.get(provider.domainId);
    const countryLabel = sourceOriginLabel(provider.originCountry);
    const countryFilter = sourceOriginFilterValue(provider.originCountry);
    const coveredCountries = provider.coveredCountries || [];
    const coverageFilter = coveredCountries.map((code) => sourceOriginFilterValue(code)).join(' ');
    const coverageLabel = coveredCountries.map((code) => sourceOriginLabel(code)).join(', ');
    const hostLinks = provider.hosts.map((host) => (
      `<a href="https://${escapeHtml(host)}/" target="_blank" rel="noreferrer">${escapeHtml(host)}</a>`
    )).join('');
    const kindBadges = provider.kinds.map((kind) => (
      `<span class="kind-badge">${escapeHtml(kindLabels[kind] || kind)}</span>`
    )).join('');
    return `        <article class="provider-card" data-provider="${escapeHtml(provider.provider)}" data-provider-name="${escapeHtml(provider.displayName)}" data-source-domain="${provider.domainId}" data-source-kind="${provider.kinds.join(' ')}" data-source-country="${countryFilter}" data-source-coverage="${escapeHtml(coverageFilter)}">
          <div class="provider-heading">
            <span class="provider-domain">${escapeHtml(domain.name)}</span>
            <h3>${escapeHtml(provider.displayName)}</h3>
            <span class="provider-country">Origin: ${escapeHtml(countryLabel)}</span>
            ${coverageLabel ? `<span class="provider-coverage">Covers: ${escapeHtml(coverageLabel)}</span>` : ''}
          </div>
          <div class="kind-badges">${kindBadges}</div>
          <div class="provider-hosts" aria-label="Provider hosts">${hostLinks}</div>
        </article>`;
  }).join('\n');
  const sourceNav = `        <a class="source-brand" href="/" aria-label="World Monitor home">
          <span class="source-logo" aria-hidden="true"><span></span></span>
          <span><strong>WORLD MONITOR</strong><small>GLOBAL INTELLIGENCE</small></span>
        </a>
        <span class="source-nav-links">
          <a href="/sources/" aria-current="page">Sources</a>
          <a href="/blog/">Blog</a>
          <a href="/docs">Docs</a>
          <a href="https://github.com/koala73/worldmonitor" target="_blank" rel="noreferrer">GitHub</a>
        </span>
        <a class="source-nav-cta" href="${withUtmSource('/dashboard', 'sources-nav')}">Launch dashboard <span aria-hidden="true">→</span></a>`;
  const sourceFooter = `<div class="source-footer-inner">
      <span><strong>WORLD MONITOR</strong><small>Open-source global intelligence</small></span>
      <span class="source-footer-links"><a href="/sources/">Sources</a><a href="${docsHref('')}">Data docs</a><a href="${withUtmSource('/docs/source-attribution', 'seo-sources')}">Attribution ledger</a><a href="/docs/terms">Terms</a></span>
    </div>`;
  const body = `      <section class="sources-hero">
        <div class="hero-copy">
          <p class="eyebrow"><span></span> Live provider inventory</p>
          <h1>See every source behind World Monitor.</h1>
          <p class="lede">The map is only as useful as the signals behind it. World Monitor combines ${sourceStats.providerCount} active providers across ${sourceStats.activeHosts} observed source hosts spanning news, conflict, markets, military, climate, aviation, infrastructure and technology — with every provider listed below.</p>
          <div class="hero-actions">
            <a class="cta" href="#catalog">Browse all ${sourceStats.providerCount} providers <span aria-hidden="true">↓</span></a>
            <a class="secondary-cta" href="${withUtmSource('/dashboard', 'sources-hero')}">Open the live dashboard <span aria-hidden="true">→</span></a>
          </div>
          <p class="trust-line"><span>Manifest-derived</span><span>Build-checked</span><span>Source-attributed</span></p>
        </div>
        <div class="signal-console" aria-label="Source inventory summary">
          <div class="console-bar"><span><i></i><i></i><i></i></span><strong>source_graph.live</strong><em>ACTIVE</em></div>
          <div class="console-map" aria-hidden="true"><span class="orbit one"></span><span class="orbit two"></span><span class="pulse p1"></span><span class="pulse p2"></span><span class="pulse p3"></span><span class="pulse p4"></span><span class="pulse p5"></span></div>
          <div class="console-stats">
            <span><strong>${sourceStats.providerCount}</strong><small>active providers</small></span>
            <span><strong>${sourceStats.activeHosts}</strong><small>source hosts</small></span>
            <span><strong>${SOURCE_DOMAINS.length}</strong><small>signal domains</small></span>
          </div>
          <p><span></span> Inventory reconciled with the URLs used by the codebase</p>
        </div>
      </section>
      <section class="proof-rail" aria-label="Source types">
        <span><strong>${sourceStats.providerCount}</strong><small>Active providers</small></span>
        <span><strong>${sourceStats.activeHosts}</strong><small>Source hosts</small></span>
        <span><strong>${sourceStats.structuredHosts}</strong><small>Structured endpoints</small></span>
        <span><strong>${sourceStats.feedHosts}</strong><small>News &amp; OSINT feeds</small></span>
      </section>
      <section class="domain-section" aria-labelledby="domains-heading">
        <div class="section-heading">
          <p class="eyebrow">Coverage architecture</p>
          <h2 id="domains-heading">Ten domains. One operating picture.</h2>
          <p>Each domain is a different way to see pressure building. Select one to jump into its providers, or open the methodology for the full coverage model.</p>
        </div>
        <div class="source-domains">
${domainCards}
        </div>
      </section>
      <section class="trust-section" aria-labelledby="trust-heading">
        <div><p class="eyebrow">Trust through traceability</p><h2 id="trust-heading">The count follows the code.</h2></div>
        <div>
          <p>This inventory is generated from the source-attribution manifest and checked against the external URLs that World Monitor uses. Adding or removing a source changes this page at build time.</p>
          <p>An active listing confirms use and attribution tracking. It does not claim that a provider's redistribution terms have completed review. The <a href="${withUtmSource('/docs/source-attribution', 'seo-sources')}">attribution ledger</a> records that posture, and the <a href="${docsHref('source-credibility-%26-feed-tiering')}">credibility methodology</a> explains feed tiers and bias metadata.</p>
        </div>
      </section>
      <section class="catalog-section" id="catalog" aria-labelledby="catalog-heading">
        <div class="section-heading catalog-heading">
          <p class="eyebrow">Complete catalog</p>
          <h2 id="catalog-heading">All ${sourceStats.providerCount} active providers.</h2>
          <p>Search by provider or host. Filter by signal domain, source type, country of origin, or country covered. Every provider remains in the static HTML for people, search engines and no-script browsers.</p>
        </div>
        <div class="catalog-controls">
          <label class="search-control" for="source-search"><span>Search providers</span><input id="source-search" type="search" placeholder="Reuters, USGS, coingecko…" autocomplete="off"></label>
          <label for="source-domain"><span>Domain</span><select id="source-domain"><option value="all">All domains</option>${SOURCE_DOMAINS.map((domain) => `<option value="${domain.id}">${escapeHtml(domain.name)}</option>`).join('')}</select></label>
          <label for="source-kind"><span>Source type</span><select id="source-kind"><option value="all">All types</option><option value="structured">Structured data</option><option value="feed">News / feed</option><option value="operational-status">Operational status</option></select></label>
          <label for="source-country"><span>Country of origin</span><select id="source-country"><option value="all">All origins</option>${countryOptions.map((country) => `<option value="${country.code}">${escapeHtml(country.name)}</option>`).join('')}</select></label>
          <label for="source-coverage"><span>Country covered</span><select id="source-coverage"><option value="all">All coverage</option>${coverageOptions.map((country) => `<option value="${country.code}">${escapeHtml(country.name)}</option>`).join('')}</select></label>
          <button type="button" class="reset-filter" data-source-filter="all">Reset</button>
        </div>
        <div class="catalog-meta"><p id="source-results" aria-live="polite">${sourceStats.providerCount} providers shown</p><a href="${withUtmSource('/docs/source-attribution', 'seo-sources')}">Open the host-by-host ledger <span aria-hidden="true">↗</span></a></div>
        <p class="catalog-country-note" id="source-country-note" aria-live="polite" hidden></p>
        <div class="provider-grid" id="source-catalog" data-source-catalog>
${providerCards}
        </div>
        <p class="no-results" id="source-no-results" hidden>No providers match those filters.</p>
        <noscript><p class="noscript-note">Filtering needs JavaScript. The complete catalog is already shown above.</p></noscript>
      </section>
      <section class="sources-final-cta">
        <p class="eyebrow">From source to signal</p>
        <h2>Now watch the signals converge.</h2>
        <p>Open the live map to follow the providers above as one real-time global operating picture.</p>
        <a class="cta" href="${withUtmSource('/dashboard', 'sources-footer')}">Launch World Monitor <span aria-hidden="true">→</span></a>
      </section>`;
  const extraStyles = `      .sources-page { --bg: #030504; --panel: #090d0b; --panel-2: #0d1410; --text: #f1f7f2; --muted: #8e9b92; --line: #1d2921; --accent: #4ade80; background: radial-gradient(circle at 50% 0, rgba(74,222,128,.09), transparent 27rem), var(--bg); }
      .sources-page header, .sources-page main, .sources-page footer { max-width: none; padding-left: 0; padding-right: 0; }
      .sources-page header { position: sticky; top: 0; z-index: 20; padding: 0; border-color: rgba(255,255,255,.07); background: rgba(3,5,4,.84); backdrop-filter: blur(18px); }
      .sources-page nav { max-width: 1240px; min-height: 68px; margin: 0 auto; padding: 0 24px; display: flex; align-items: center; gap: 28px; }
      .sources-page nav a { min-height: 0; }
      .source-brand { margin-right: auto; display: flex; align-items: center; gap: 10px; color: var(--text); }
      .source-brand:hover { text-decoration: none; opacity: .85; }
      .source-brand > span:last-child { display: grid; line-height: 1; }
      .source-brand strong { font-size: 13px; letter-spacing: .02em; }
      .source-brand small { margin-top: 4px; color: var(--muted); font: 8px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .16em; }
      .source-logo { position: relative; width: 32px; height: 32px; border: 1px solid #304237; border-radius: 50%; background: radial-gradient(circle at center, rgba(74,222,128,.18), transparent 55%); }
      .source-logo::before, .source-logo::after, .source-logo span { content: ''; position: absolute; inset: 6px; border: 1px solid rgba(96,165,250,.48); border-radius: 50%; }
      .source-logo::after { inset: 14px 4px; border-left: 0; border-right: 0; border-radius: 0; }
      .source-logo span { inset: 5px 14px; border-top: 0; border-bottom: 0; border-radius: 0; }
      .source-nav-links { display: flex; align-items: center; gap: 26px; }
      .source-nav-links a { color: var(--muted); font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
      .source-nav-links a:hover, .source-nav-links a[aria-current="page"] { color: var(--text); text-decoration: none; }
      .source-nav-links a[aria-current="page"] { color: var(--accent); }
      .source-nav-cta, .secondary-cta { color: var(--text); border: 1px solid var(--line); border-radius: 3px; padding: 10px 14px; font: 700 11px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .05em; text-transform: uppercase; }
      .source-nav-cta:hover, .secondary-cta:hover { border-color: rgba(74,222,128,.55); text-decoration: none; }
      .sources-page main { padding: 0; }
      .sources-hero { max-width: 1240px; min-height: 650px; margin: 0 auto; padding: 110px 24px 80px; display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(370px, .92fr); align-items: center; gap: 76px; }
      .sources-page .eyebrow { margin: 0 0 18px; color: var(--accent); font: 700 11px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .2em; }
      .sources-hero .eyebrow span { display: inline-block; width: 7px; height: 7px; margin-right: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 15px var(--accent); }
      .sources-page h1 { max-width: 780px; margin: 0; font-size: clamp(48px, 6.6vw, 88px); line-height: .94; letter-spacing: -.055em; }
      .sources-page h2 { margin: 0; font-size: clamp(32px, 4vw, 54px); line-height: 1; letter-spacing: -.035em; }
      .sources-hero .lede { max-width: 670px; margin: 28px 0 0; font-size: 18px; line-height: 1.7; }
      .hero-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; margin-top: 34px; }
      .sources-page .cta { margin: 0; border-radius: 3px; padding: 14px 18px; font: 800 12px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .055em; text-transform: uppercase; }
      .trust-line { display: flex; flex-wrap: wrap; gap: 8px 22px; margin: 24px 0 0; font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; }
      .trust-line span::before { content: '✓'; margin-right: 6px; color: var(--accent); }
      .signal-console { overflow: hidden; border: 1px solid #243129; border-radius: 6px; background: linear-gradient(145deg, rgba(13,20,16,.97), rgba(5,8,6,.98)); box-shadow: 0 32px 90px rgba(0,0,0,.46), 0 0 50px rgba(74,222,128,.05); }
      .console-bar { height: 40px; padding: 0 13px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--line); font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .12em; }
      .console-bar > span { display: flex; gap: 5px; }
      .console-bar i { width: 7px; height: 7px; border-radius: 50%; background: #36413a; }
      .console-bar i:first-child { background: #ff5f57; } .console-bar i:nth-child(2) { background: #febc2e; } .console-bar i:last-child { background: #28c840; }
      .console-bar strong { color: var(--muted); font-weight: 500; }
      .console-bar em { margin-left: auto; color: var(--accent); font-style: normal; }
      .console-map { position: relative; height: 250px; overflow: hidden; background-image: linear-gradient(rgba(74,222,128,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(74,222,128,.035) 1px, transparent 1px), radial-gradient(ellipse at center, rgba(74,222,128,.1), transparent 62%); background-size: 28px 28px, 28px 28px, auto; }
      .console-map::before { content: ''; position: absolute; width: 260px; height: 130px; left: 50%; top: 50%; transform: translate(-50%,-50%) rotate(-7deg); border: 1px solid rgba(74,222,128,.24); border-radius: 48% 52% 45% 55%; clip-path: polygon(0 15%, 24% 0, 40% 19%, 62% 8%, 100% 35%, 86% 70%, 57% 60%, 42% 100%, 22% 76%, 0 87%); background: rgba(74,222,128,.025); }
      .orbit { position: absolute; left: 50%; top: 50%; width: 330px; height: 110px; transform: translate(-50%,-50%) rotate(16deg); border: 1px solid rgba(96,165,250,.16); border-radius: 50%; } .orbit.two { transform: translate(-50%,-50%) rotate(-25deg); }
      .pulse { position: absolute; width: 7px; height: 7px; border: 1px solid var(--accent); border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 5px rgba(74,222,128,.1), 0 0 14px var(--accent); }
      .p1 { left: 25%; top: 32%; } .p2 { left: 62%; top: 23%; } .p3 { left: 72%; top: 58%; } .p4 { left: 40%; top: 68%; } .p5 { left: 53%; top: 45%; }
      .console-stats { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
      .console-stats > span { padding: 16px; display: grid; border-right: 1px solid var(--line); }
      .console-stats > span:last-child { border-right: 0; }
      .console-stats strong { font-size: 24px; }
      .console-stats small { margin-top: 3px; color: var(--muted); font: 8px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; }
      .signal-console > p { margin: 0; padding: 12px 16px; font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .04em; }
      .signal-console > p span { display: inline-block; width: 6px; height: 6px; margin-right: 7px; border-radius: 50%; background: var(--accent); }
      .proof-rail { max-width: 1240px; margin: 0 auto; display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid var(--line); border-radius: 4px; background: rgba(9,13,11,.72); }
      .proof-rail > span { padding: 22px 24px; display: grid; border-right: 1px solid var(--line); }
      .proof-rail > span:last-child { border-right: 0; }
      .proof-rail strong { font-size: 29px; }
      .proof-rail small { margin-top: 4px; color: var(--muted); font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; }
      .domain-section, .catalog-section { max-width: 1240px; margin: 0 auto; padding: 120px 24px; }
      .section-heading { max-width: 720px; margin-bottom: 48px; }
      .section-heading > p:last-child { margin: 20px 0 0; font-size: 16px; line-height: 1.7; }
      .source-domains { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); border-left: 1px solid var(--line); border-top: 1px solid var(--line); }
      .source-domain-card { position: relative; min-width: 0; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); background: rgba(9,13,11,.55); }
      .source-domain-card button { width: 100%; min-height: 260px; padding: 20px; display: flex; flex-direction: column; align-items: flex-start; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
      .source-domain-card:hover, .source-domain-card:has(button[aria-pressed="true"]) { z-index: 1; background: var(--panel-2); box-shadow: inset 0 0 0 1px rgba(74,222,128,.5); }
      .domain-index, .domain-count { color: #526057; font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .1em; text-transform: uppercase; }
      .domain-count { margin: -13px 0 24px auto; color: var(--accent); }
      .source-domain-card strong { font-size: 16px; line-height: 1.2; }
      .domain-blurb { margin-top: 12px; color: var(--muted); font-size: 12px; line-height: 1.55; }
      .domain-examples { margin-top: auto; padding-top: 18px; display: flex; flex-wrap: wrap; gap: 5px; }
      .domain-examples span, .kind-badge { border: 1px solid var(--line); border-radius: 999px; padding: 3px 7px; color: var(--muted); font: 8px ui-monospace, SFMono-Regular, Menlo, monospace; }
      .domain-docs { display: block; padding: 0 20px 18px; color: var(--muted); font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .07em; }
      .domain-docs:hover { color: var(--accent); text-decoration: none; }
      .trust-section { margin: 0; padding: 100px max(24px, calc((100% - 1192px)/2)); display: grid; grid-template-columns: .8fr 1.2fr; gap: 90px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); background: linear-gradient(100deg, rgba(74,222,128,.045), transparent 55%); }
      .trust-section p { margin-top: 0; font-size: 15px; line-height: 1.75; }
      .catalog-section { padding-bottom: 100px; }
      .catalog-heading { max-width: 790px; }
      .catalog-controls { position: sticky; top: 68px; z-index: 10; margin-bottom: 0; padding: 18px; display: grid; grid-template-columns: minmax(200px, 1.2fr) minmax(150px, .8fr) minmax(140px, .7fr) minmax(160px, .85fr) minmax(160px, .85fr) auto; gap: 12px; align-items: end; border: 1px solid var(--line); background: rgba(6,9,7,.94); backdrop-filter: blur(18px); }
      .catalog-controls label { display: grid; gap: 7px; color: var(--muted); font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .1em; text-transform: uppercase; }
      .catalog-controls input, .catalog-controls select { width: 100%; min-height: 44px; padding: 0 12px; border: 1px solid #2a372f; border-radius: 2px; background: #0b100d; color: var(--text); font: 13px ui-sans-serif, system-ui, sans-serif; }
      .catalog-controls input:focus, .catalog-controls select:focus { outline: 1px solid var(--accent); outline-offset: 1px; }
      .reset-filter { min-height: 44px; padding: 0 16px; border: 1px solid #2a372f; border-radius: 2px; background: transparent; color: var(--text); cursor: pointer; font: 700 10px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; }
      .reset-filter:hover { border-color: var(--accent); }
      .catalog-meta { padding: 15px 2px; display: flex; justify-content: space-between; gap: 20px; align-items: center; }
      .catalog-meta p { margin: 0; font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .06em; text-transform: uppercase; }
      .catalog-meta a { font-size: 12px; }
      .catalog-country-note { margin: 0 2px 15px; color: var(--muted); font-size: 13px; line-height: 1.6; }
      .provider-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-left: 1px solid var(--line); border-top: 1px solid var(--line); }
      .provider-card { min-width: 0; min-height: 180px; padding: 18px; display: flex; flex-direction: column; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); background: rgba(9,13,11,.48); }
      .provider-card:hover { background: var(--panel-2); }
      .provider-domain { color: var(--accent); font: 8px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .1em; text-transform: uppercase; }
      .provider-card h3 { margin: 8px 0 0; font-size: 15px; line-height: 1.3; overflow-wrap: anywhere; }
      .provider-country, .provider-coverage { margin-top: 6px; color: var(--muted); font: 11px ui-sans-serif, system-ui, sans-serif; }
      .kind-badges { margin-top: 14px; display: flex; flex-wrap: wrap; gap: 5px; }
      .provider-hosts { margin-top: auto; padding-top: 18px; display: flex; flex-wrap: wrap; gap: 4px 10px; }
      .provider-hosts a { color: var(--muted); font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
      .provider-hosts a::after { content: ' ↗'; color: #526057; }
      .provider-hosts a:hover { color: var(--text); }
      .provider-card[hidden], .no-results[hidden] { display: none; }
      .no-results, .noscript-note { padding: 40px 20px; border: 1px solid var(--line); text-align: center; }
      .sources-final-cta { padding: 110px 24px; display: grid; place-items: center; text-align: center; border-top: 1px solid var(--line); background: radial-gradient(circle at 50% 80%, rgba(74,222,128,.1), transparent 30rem); }
      .sources-final-cta p:not(.eyebrow) { max-width: 600px; margin: 20px auto 30px; }
      .sources-page footer { border-color: var(--line); }
      .source-footer-inner { max-width: 1240px; margin: 0 auto; padding: 28px 24px 0; display: flex; justify-content: space-between; gap: 30px; }
      .source-footer-inner > span:first-child { display: grid; color: var(--text); }
      .source-footer-inner small { margin-top: 3px; color: var(--muted); }
      .source-footer-links { display: flex; flex-wrap: wrap; gap: 18px; }
      .source-footer-links a { color: var(--muted); }
      @media (max-width: 1100px) { .catalog-controls { grid-template-columns: 1fr 1fr 1fr auto; } .search-control { grid-column: 1 / -1; } }
      @media (max-width: 1000px) { .sources-hero { grid-template-columns: 1fr; gap: 50px; } .signal-console { max-width: 650px; } .source-domains { grid-template-columns: repeat(2, minmax(0, 1fr)); } .catalog-controls { grid-template-columns: 1fr 1fr; } .search-control { grid-column: 1 / -1; } .provider-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
      @media (max-width: 720px) { .source-nav-links { display: none; } .sources-page nav { padding: 0 16px; gap: 10px; } .source-nav-cta { padding: 9px 10px; font-size: 9px; } .sources-hero { min-height: 0; padding: 80px 20px 60px; } .sources-page h1 { font-size: clamp(46px, 15vw, 66px); } .sources-hero .lede { font-size: 16px; } .proof-rail { margin: 0 20px; grid-template-columns: repeat(2, 1fr); } .proof-rail > span:nth-child(2) { border-right: 0; } .proof-rail > span:nth-child(-n+2) { border-bottom: 1px solid var(--line); } .domain-section, .catalog-section { padding: 90px 20px; } .source-domains { grid-template-columns: 1fr; } .source-domain-card button { min-height: 225px; } .trust-section { padding: 80px 20px; grid-template-columns: 1fr; gap: 36px; } .catalog-controls { position: static; grid-template-columns: 1fr; } .search-control { grid-column: auto; } .provider-grid { grid-template-columns: 1fr; } .catalog-meta, .source-footer-inner { align-items: flex-start; flex-direction: column; } .sources-final-cta { padding: 90px 20px; } }
      @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }`;
  const inlineScript = `(() => {
      const search = document.getElementById('source-search');
      const domain = document.getElementById('source-domain');
      const kind = document.getElementById('source-kind');
      const country = document.getElementById('source-country');
      const coverage = document.getElementById('source-coverage');
      const cards = [...document.querySelectorAll('.provider-card')].map((card) => ({
        card,
        searchText: card.textContent.toLowerCase(),
        domain: card.dataset.sourceDomain,
        kinds: new Set(card.dataset.sourceKind.split(' ')),
        country: card.dataset.sourceCountry,
        coverage: new Set((card.dataset.sourceCoverage || '').split(' ').filter(Boolean)),
      }));
      const filterButtons = [...document.querySelectorAll('[data-source-filter]')];
      const results = document.getElementById('source-results');
      const countryNote = document.getElementById('source-country-note');
      const noResults = document.getElementById('source-no-results');
      const applyFilters = () => {
        const query = search.value.trim().toLowerCase();
        let visible = 0;
        for (const entry of cards) {
          const { card } = entry;
          const matchesSearch = !query || entry.searchText.includes(query);
          const matchesDomain = domain.value === 'all' || entry.domain === domain.value;
          const matchesKind = kind.value === 'all' || entry.kinds.has(kind.value);
          const matchesCountry = country.value === 'all' || entry.country === country.value;
          const matchesCoverage = coverage.value === 'all' || entry.coverage.has(coverage.value);
          card.hidden = !(matchesSearch && matchesDomain && matchesKind && matchesCountry && matchesCoverage);
          if (!card.hidden) visible += 1;
        }
        results.textContent = visible + (visible === 1 ? ' provider shown' : ' providers shown');
        const showCountryNote = country.value !== 'all' && country.value !== 'intl';
        const nextCountryNote = showCountryNote
          ? 'This list shows monitored sources based in the selected country or region. Sources based elsewhere also cover it.'
          : '';
        if (countryNote.textContent !== nextCountryNote) countryNote.textContent = nextCountryNote;
        if (countryNote.hidden === showCountryNote) countryNote.hidden = !showCountryNote;
        noResults.hidden = visible !== 0;
        for (const button of filterButtons) {
          const selected = button.dataset.sourceFilter !== 'all' && button.dataset.sourceFilter === domain.value;
          if (button.hasAttribute('aria-pressed')) button.setAttribute('aria-pressed', String(selected));
        }
      };
      search.addEventListener('input', applyFilters);
      domain.addEventListener('change', applyFilters);
      kind.addEventListener('change', applyFilters);
      country.addEventListener('change', applyFilters);
      coverage.addEventListener('change', applyFilters);
      for (const button of filterButtons) button.addEventListener('click', () => {
        search.value = '';
        kind.value = 'all';
        country.value = 'all';
        coverage.value = 'all';
        domain.value = button.dataset.sourceFilter;
        applyFilters();
        if (button.dataset.sourceFilter !== 'all') {
          document.getElementById('catalog').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        }
      });
    })();`;
  return pageDocument({
    baseUrl,
    path,
    title: 'Data Source Catalog | World Monitor',
    description,
    lastmod,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'World Monitor data source catalog',
      description,
      url: absoluteUrl(baseUrl, path),
      inLanguage: 'en-US',
      mainEntity: {
        '@type': 'ItemList',
        numberOfItems: sourceCatalog.length,
      },
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Sources', path },
    ]),
    body,
    bodyClass: 'sources-page',
    headerNav: sourceNav,
    footerBody: sourceFooter,
    extraStyles,
    inlineScript,
    ogType: 'website',
  });
}
