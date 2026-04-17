import type { MapLayers } from '@/types';
import { CURATED_COUNTRIES } from '@/config/countries';
// boundary-ignore: commands are built lazily at runtime via getAllCommands()
import { getCurrentLanguage, t } from '@/services/i18n';
import { toFlagEmoji } from '@/utils/country-flag';

export interface Command {
  id: string;
  keywords: string[];
  label: string;
  icon: string;
  category: 'navigate' | 'layers' | 'panels' | 'view' | 'actions' | 'country';
}

export const LAYER_PRESETS: Record<string, (keyof MapLayers)[]> = {
  military: ['bases', 'nuclear', 'flights', 'military', 'waterways'],
  finance: ['stockExchanges', 'financialCenters', 'centralBanks', 'commodityHubs', 'economic', 'tradeRoutes'],
  infra: ['cables', 'pipelines', 'datacenters', 'spaceports', 'minerals'],
  intel: ['conflicts', 'hotspots', 'protests', 'ucdpEvents', 'displacement'],
  minimal: ['conflicts', 'hotspots'],
};

// Maps command suffix → actual MapLayers key when they differ
export const LAYER_KEY_MAP: Record<string, keyof MapLayers> = {
  cyber: 'cyberThreats',
  ucdp: 'ucdpEvents',
  gps: 'gpsJamming',
  cii: 'ciiChoropleth',
  iran: 'iranAttacks',
  radiation: 'radiationWatch',
  natural: 'natural',
};

export const COMMANDS: Command[] = [
  // Navigation (region switching)
  { id: 'nav:global', keywords: ['global', 'world', 'reset', 'home'], label: 'Map: Global view', icon: '\u{1F30D}', category: 'navigate' },
  { id: 'nav:mena', keywords: ['mena', 'middle east', 'mideast'], label: 'Map: Middle East & North Africa', icon: '\u{1F54C}', category: 'navigate' },
  { id: 'nav:eu', keywords: ['europe', 'eu'], label: 'Map: Europe', icon: '\u{1F3F0}', category: 'navigate' },
  { id: 'nav:asia', keywords: ['asia', 'pacific'], label: 'Map: Asia-Pacific', icon: '\u{1F3EF}', category: 'navigate' },
  { id: 'nav:america', keywords: ['america', 'americas', 'us', 'usa'], label: 'Map: Americas', icon: '\u{1F5FD}', category: 'navigate' },
  { id: 'nav:africa', keywords: ['africa'], label: 'Map: Africa', icon: '\u{1F30D}', category: 'navigate' },
  { id: 'nav:latam', keywords: ['latam', 'latin america', 'south america'], label: 'Map: Latin America', icon: '\u{1F30E}', category: 'navigate' },
  { id: 'nav:oceania', keywords: ['oceania', 'australia', 'pacific islands'], label: 'Map: Oceania', icon: '\u{1F30F}', category: 'navigate' },

  // Layer presets (toggle groups)
  { id: 'layers:military', keywords: ['military', 'military layers', 'show military'], label: 'Show military layers', icon: '\u{1F396}\uFE0F', category: 'layers' },
  { id: 'layers:finance', keywords: ['finance layers', 'show finance', 'financial'], label: 'Show finance layers', icon: '\u{1F4B0}', category: 'layers' },
  { id: 'layers:infra', keywords: ['infrastructure', 'infra layers', 'show infrastructure'], label: 'Show infrastructure layers', icon: '\u{1F3D7}\uFE0F', category: 'layers' },
  { id: 'layers:intel', keywords: ['intelligence', 'intel layers', 'show intel', 'conflicts only'], label: 'Show intelligence layers', icon: '\u{1F50D}', category: 'layers' },
  { id: 'layers:all', keywords: ['all layers', 'show all', 'enable all'], label: 'Enable all layers', icon: '\u{1F441}\uFE0F', category: 'layers' },
  { id: 'layers:none', keywords: ['hide all', 'clear layers', 'no layers', 'disable all'], label: 'Hide all layers', icon: '\u{1F6AB}', category: 'layers' },
  { id: 'layers:minimal', keywords: ['minimal', 'minimal layers', 'clean'], label: 'Minimal layers (conflicts + hotspots)', icon: '\u2728', category: 'layers' },

  // Individual layer toggles
  { id: 'layer:ais', keywords: ['ais', 'ships', 'vessels', 'maritime'], label: 'Toggle AIS vessel tracking', icon: '\u{1F6A2}', category: 'layers' },
  { id: 'layer:flights', keywords: ['flights', 'aviation', 'aircraft', 'planes', 'airport', 'delays', 'notam', 'closures'], label: 'Toggle aviation layer', icon: '\u2708\uFE0F', category: 'layers' },
  { id: 'layer:conflicts', keywords: ['conflicts', 'battles'], label: 'Toggle conflict zones', icon: '\u2694\uFE0F', category: 'layers' },
  { id: 'layer:hotspots', keywords: ['hotspots', 'crises'], label: 'Toggle intel hotspots', icon: '\u{1F4CD}', category: 'layers' },
  { id: 'layer:protests', keywords: ['protests', 'unrest', 'riots'], label: 'Toggle protests & unrest', icon: '\u270A', category: 'layers' },
  { id: 'layer:cables', keywords: ['cables', 'undersea', 'submarine cables'], label: 'Toggle undersea cables', icon: '\u{1F310}', category: 'layers' },
  { id: 'layer:pipelines', keywords: ['pipelines', 'oil', 'gas pipelines'], label: 'Toggle pipelines', icon: '\u{1F6E2}\uFE0F', category: 'layers' },
  { id: 'layer:nuclear', keywords: ['nuclear', 'reactors'], label: 'Toggle nuclear facilities', icon: '\u2622\uFE0F', category: 'layers' },
  { id: 'layer:bases', keywords: ['bases', 'military bases'], label: 'Toggle military bases', icon: '\u{1F3DB}\uFE0F', category: 'layers' },
  { id: 'layer:fires', keywords: ['fires', 'wildfires'], label: 'Toggle satellite fires', icon: '\u{1F525}', category: 'layers' },
  { id: 'layer:weather', keywords: ['weather'], label: 'Toggle weather overlay', icon: '\u{1F324}\uFE0F', category: 'layers' },
  { id: 'layer:cyber', keywords: ['cyber', 'cyber threats'], label: 'Toggle cyber threats', icon: '\u{1F6E1}\uFE0F', category: 'layers' },
  { id: 'layer:displacement', keywords: ['displacement', 'refugees', 'idp'], label: 'Toggle displacement flows', icon: '\u{1F3C3}', category: 'layers' },
  { id: 'layer:climate', keywords: ['climate', 'anomalies'], label: 'Toggle climate anomalies', icon: '\u{1F321}\uFE0F', category: 'layers' },
  { id: 'layer:outages', keywords: ['outages', 'internet outages', 'internet disruptions', 'disruptions'], label: 'Toggle internet disruptions', icon: '\u{1F4E1}', category: 'layers' },
  { id: 'layer:tradeRoutes', keywords: ['trade routes', 'shipping lanes', 'trade'], label: 'Toggle trade routes', icon: '\u{1F6A2}', category: 'layers' },
  { id: 'layer:gps', keywords: ['gps', 'gps jamming', 'jamming', 'spoofing'], label: 'Toggle GPS jamming', icon: '\u{1F4E1}', category: 'layers' },
  { id: 'layer:satellites', keywords: ['satellites', 'orbital', 'surveillance', 'space'], label: 'Toggle orbital surveillance', icon: '\u{1F6F0}\uFE0F', category: 'layers' },
  { id: 'layer:ucdp', keywords: ['ucdp', 'armed conflict', 'armed conflict events'], label: 'Toggle armed conflict events', icon: '\u2694\uFE0F', category: 'layers' },
  { id: 'layer:iran', keywords: ['iran', 'iran attacks'], label: 'Toggle Iran attacks', icon: '\u{1F3AF}', category: 'layers' },
  { id: 'layer:irradiators', keywords: ['irradiators', 'gamma', 'radiation'], label: 'Toggle gamma irradiators', icon: '\u2623\uFE0F', category: 'layers' },
  { id: 'layer:radiation', keywords: ['radiation', 'radnet', 'safecast', 'anomalies'], label: 'Toggle radiation anomalies', icon: '\u2622\uFE0F', category: 'layers' },
  { id: 'layer:spaceports', keywords: ['spaceports', 'launch sites', 'rockets'], label: 'Toggle spaceports', icon: '\u{1F680}', category: 'layers' },
  { id: 'layer:datacenters', keywords: ['datacenters', 'data centers', 'ai data'], label: 'Toggle AI data centers', icon: '\u{1F5A5}\uFE0F', category: 'layers' },
  { id: 'layer:military', keywords: ['military activity', 'mil activity'], label: 'Toggle military activity', icon: '\u{1F396}\uFE0F', category: 'layers' },
  { id: 'layer:natural', keywords: ['natural events', 'earthquakes', 'volcanoes', 'tsunamis'], label: 'Toggle natural events', icon: '\u{1F30B}', category: 'layers' },
  { id: 'layer:waterways', keywords: ['waterways', 'chokepoints', 'straits', 'canals'], label: 'Toggle strategic waterways', icon: '\u2693', category: 'layers' },
  { id: 'layer:economic', keywords: ['economic centers', 'gdp'], label: 'Toggle economic centers', icon: '\u{1F4B0}', category: 'layers' },
  { id: 'layer:minerals', keywords: ['minerals', 'rare earth', 'critical minerals', 'lithium'], label: 'Toggle critical minerals', icon: '\u{1F48E}', category: 'layers' },
  { id: 'layer:cii', keywords: ['cii', 'instability index', 'country instability'], label: 'Toggle CII instability', icon: '\u{1F30E}', category: 'layers' },
  { id: 'layer:dayNight', keywords: ['day night', 'terminator', 'shadow', 'day/night'], label: 'Toggle day/night overlay', icon: '\u{1F31C}', category: 'layers' },
  { id: 'layer:sanctions', keywords: ['sanctions', 'embargoes'], label: 'Toggle sanctions', icon: '\u{1F6AB}', category: 'layers' },

  // Panel navigation (matching actual DEFAULT_PANELS keys)
  { id: 'panel:live-news', keywords: ['news', 'live news', 'headlines'], label: 'Panel: Live News', icon: '\u{1F4F0}', category: 'panels' },
  { id: 'panel:intel', keywords: ['intel', 'intel feed'], label: 'Panel: Intel Feed', icon: '\u{1F50E}', category: 'panels' },
  { id: 'panel:gdelt-intel', keywords: ['gdelt', 'intelligence feed'], label: 'Panel: Live Intelligence', icon: '\u{1F50D}', category: 'panels' },
  { id: 'panel:cii', keywords: ['cii', 'instability', 'country risk'], label: 'Panel: Country Instability', icon: '\u{1F3AF}', category: 'panels' },
  { id: 'panel:cascade', keywords: ['cascade', 'infrastructure cascade'], label: 'Panel: Infrastructure Cascade', icon: '\u{1F517}', category: 'panels' },
  { id: 'panel:strategic-risk', keywords: ['risk', 'strategic risk', 'threat level'], label: 'Panel: Strategic Risk', icon: '\u26A0\uFE0F', category: 'panels' },
  { id: 'panel:cross-source-signals', keywords: ['cross source', 'signal aggregator', 'composite escalation', 'multi signal'], label: 'Panel: Cross-Source Signals', icon: '\u{1F4E1}', category: 'panels' },
  { id: 'panel:politics', keywords: ['world news', 'politics', 'geopolitics'], label: 'Panel: World News', icon: '\u{1F30D}', category: 'panels' },
  { id: 'panel:us', keywords: ['united states', 'us news', 'america news'], label: 'Panel: United States', icon: '\u{1F1FA}\u{1F1F8}', category: 'panels' },
  { id: 'panel:europe', keywords: ['europe news', 'eu news'], label: 'Panel: Europe', icon: '\u{1F1EA}\u{1F1FA}', category: 'panels' },
  { id: 'panel:middleeast', keywords: ['middle east news', 'mideast news'], label: 'Panel: Middle East', icon: '\u{1F54C}', category: 'panels' },
  { id: 'panel:africa', keywords: ['africa news'], label: 'Panel: Africa', icon: '\u{1F30D}', category: 'panels' },
  { id: 'panel:latam', keywords: ['latin america news', 'latam news'], label: 'Panel: Latin America', icon: '\u{1F30E}', category: 'panels' },
  { id: 'panel:asia', keywords: ['asia news', 'asia-pacific news'], label: 'Panel: Asia-Pacific', icon: '\u{1F30F}', category: 'panels' },
  { id: 'panel:energy', keywords: ['energy', 'resources', 'oil news'], label: 'Panel: Energy & Resources', icon: '\u26A1', category: 'panels' },
  { id: 'panel:energy-complex', keywords: ['energy complex', 'oil markets', 'gas markets', 'energy prices'], label: 'Panel: Energy Complex', icon: '\u{1F6E2}\uFE0F', category: 'panels' },
  { id: 'panel:oil-inventories', keywords: ['oil inventories', 'crude stocks', 'spr', 'strategic petroleum', 'eia inventories', 'iea stocks', 'days of cover', 'oil reserves', 'gas storage'], label: 'Panel: Oil Inventories', icon: '\u{1F6E2}\uFE0F', category: 'panels' },
  { id: 'panel:energy-crisis', keywords: ['energy crisis', 'iea policy', 'crisis response', 'hormuz policy', 'fuel rationing', 'conservation measures'], label: 'Panel: Energy Crisis Policies', icon: '\u{26A1}', category: 'panels' },
  { id: 'panel:gov', keywords: ['government', 'gov'], label: 'Panel: Government', icon: '\u{1F3DB}\uFE0F', category: 'panels' },
  { id: 'panel:policy', keywords: ['policy', 'ai policy', 'regulation', 'tech policy'], label: 'Panel: AI Policy & Regulation', icon: '\u{1F4DC}', category: 'panels' },
  { id: 'panel:thinktanks', keywords: ['think tanks', 'thinktanks', 'analysis'], label: 'Panel: Think Tanks', icon: '\u{1F9E0}', category: 'panels' },
  { id: 'panel:polymarket', keywords: ['predictions', 'polymarket', 'forecasts'], label: 'Panel: Predictions', icon: '\u{1F52E}', category: 'panels' },
  { id: 'panel:commodities', keywords: ['commodities', 'gold', 'silver'], label: 'Panel: Commodities', icon: '\u{1F4E6}', category: 'panels' },
  { id: 'panel:markets', keywords: ['markets', 'stocks', 'indices'], label: 'Panel: Markets', icon: '\u{1F4C8}', category: 'panels' },
  { id: 'panel:economic', keywords: ['economic', 'economy', 'fred'], label: 'Panel: Economic Indicators', icon: '\u{1F4CA}', category: 'panels' },
  { id: 'panel:trade-policy', keywords: ['trade', 'tariffs', 'wto', 'trade policy', 'sanctions', 'restrictions'], label: 'Panel: Trade Policy', icon: '\u{1F4CA}', category: 'panels' },
  { id: 'panel:sanctions-pressure', keywords: ['sanctions pressure', 'ofac', 'designation', 'sanctions'], label: 'Panel: Sanctions Pressure', icon: '\u{1F6AB}', category: 'panels' },
  { id: 'panel:supply-chain', keywords: ['supply chain', 'shipping', 'chokepoint', 'minerals', 'freight', 'logistics'], label: 'Panel: Supply Chain', icon: '\u{1F6A2}', category: 'panels' },
  { id: 'maritime-activity', keywords: ['maritime activity', 'port activity', 'tanker traffic', 'trade volumes', 'port calls'], label: 'Maritime Activity', icon: '\u26F3', category: 'panels' },
  { id: 'panel:energy-profile', keywords: ['energy profile', 'country energy', 'oil imports', 'energy exposure', 'jodi', 'iea energy', 'energy shock'], label: 'Energy Profile', icon: '⚡', category: 'panels' },
  { id: 'panel:finance', keywords: ['financial', 'finance news'], label: 'Panel: Financial', icon: '\u{1F4B5}', category: 'panels' },
  { id: 'panel:tech', keywords: ['technology', 'tech news'], label: 'Panel: Technology', icon: '\u{1F4BB}', category: 'panels' },
  { id: 'panel:crypto', keywords: ['crypto', 'bitcoin', 'ethereum'], label: 'Panel: Crypto', icon: '\u20BF', category: 'panels' },
  { id: 'panel:stock-analysis', keywords: ['stock analysis', 'equity analysis', 'premium stocks'], label: 'Panel: Stock Analysis', icon: '\u{1F4C8}', category: 'panels' },
  { id: 'panel:stock-backtest', keywords: ['backtest', 'stock backtest', 'backtesting', 'strategy'], label: 'Panel: Stock Backtesting', icon: '\u{1F4C9}', category: 'panels' },
  { id: 'panel:daily-market-brief', keywords: ['daily brief', 'market brief', 'morning brief'], label: 'Panel: Daily Market Brief', icon: '\u{1F4CB}', category: 'panels' },
  { id: 'panel:market-implications', keywords: ['market implications', 'trade signals', 'ai signals', 'long short hedge', 'trade thesis'], label: 'Panel: AI Market Implications', icon: '\u{1F4CA}', category: 'panels' },
  { id: 'panel:heatmap', keywords: ['heatmap', 'sector heatmap', 'sector pe', 'pe ratio', 'valuations', 'forward pe', 'trailing pe', 'sector beta'], label: 'Panel: Sector Heatmap', icon: '\u{1F5FA}\uFE0F', category: 'panels' },
  { id: 'panel:ai', keywords: ['ai', 'ml', 'artificial intelligence'], label: 'Panel: AI/ML', icon: '\u{1F916}', category: 'panels' },
  { id: 'panel:macro-signals', keywords: ['macro', 'macro signals', 'liquidity'], label: 'Panel: Market Radar', icon: '\u{1F4C9}', category: 'panels' },
  { id: 'panel:fear-greed', keywords: ['fear', 'greed', 'fear and greed', 'sentiment', 'fear greed index'], label: 'Panel: Fear & Greed', icon: '\u{1F4CA}', category: 'panels' },
  { id: 'panel:aaii-sentiment', keywords: ['aaii', 'investor sentiment', 'bull bear', 'sentiment survey', 'aaii survey', 'contrarian'], label: 'Panel: AAII Investor Sentiment', icon: '\u{1F4CA}', category: 'panels' },
  { id: 'panel:market-breadth', keywords: ['breadth', 'market breadth', 'advance decline', 'above sma', 'stocks above moving average', '200 day', '50 day'], label: 'Panel: Market Breadth', icon: '\u{1F4CA}', category: 'panels' },
  { id: 'panel:hormuz-tracker', keywords: ['hormuz', 'strait of hormuz', 'shipping', 'crude oil', 'lng', 'fertilizer', 'tanker', 'wto'], label: 'Panel: Hormuz Trade Tracker', icon: '\u{1F6A2}', category: 'panels' },
  { id: 'panel:etf-flows', keywords: ['etf', 'etf flows', 'fund flows'], label: 'Panel: BTC ETF Tracker', icon: '\u{1F4B9}', category: 'panels' },
  { id: 'panel:stablecoins', keywords: ['stablecoins', 'usdt', 'usdc'], label: 'Panel: Stablecoins', icon: '\u{1FA99}', category: 'panels' },
  { id: 'panel:monitors', keywords: ['monitors', 'my monitors', 'watchlist'], label: 'Panel: My Monitors', icon: '\u{1F4CB}', category: 'panels' },
  { id: 'panel:map', keywords: ['map', 'globe', 'global map'], label: 'Panel: Global Map', icon: '\u{1F5FA}\uFE0F', category: 'panels' },
  { id: 'panel:live-webcams', keywords: ['webcams', 'live cameras', 'cctv'], label: 'Panel: Live Webcams', icon: '\u{1F4F7}', category: 'panels' },
  { id: 'panel:windy-webcams', keywords: ['windy', 'weather cam', 'weather webcam', 'weather cameras'], label: 'Panel: Live Weather Cams', icon: '\u{1F4F9}', category: 'panels' },
  { id: 'panel:chat-analyst', keywords: ['wm analyst', 'analyst', 'ai analyst', 'chat analyst', 'ask ai', 'intelligence analyst'], label: 'Panel: WM Analyst', icon: '\u{1F916}', category: 'panels' },
  { id: 'panel:insights', keywords: ['insights', 'ai insights', 'analysis'], label: 'Panel: AI Insights', icon: '\u{1F4A1}', category: 'panels' },
  { id: 'panel:strategic-posture', keywords: ['strategic posture', 'ai posture', 'posture assessment'], label: 'Panel: AI Strategic Posture', icon: '\u{1F3AF}', category: 'panels' },
  { id: 'panel:forecast', keywords: ['forecast', 'ai forecast', 'predictions ai'], label: 'Panel: AI Forecasts', icon: '\u{1F52E}', category: 'panels' },
  { id: 'panel:deduction', keywords: ['deduct', 'deduction', 'ai deduction', 'situation analysis', 'scenario analysis'], label: 'Panel: AI Deduction', icon: '\u{1F9E0}', category: 'panels' },
  { id: 'panel:regional-intelligence', keywords: ['regional intelligence', 'regional brief', 'region snapshot', 'balance vector', 'regime', 'mena brief', 'east asia brief', 'europe brief', 'scenarios', 'transmission paths'], label: 'Panel: Regional Intelligence', icon: '\u{1F30D}', category: 'panels' },
  { id: 'panel:military-correlation', keywords: ['force posture', 'military correlation', 'military posture'], label: 'Panel: Force Posture', icon: '\u{1F396}\uFE0F', category: 'panels' },
  { id: 'panel:escalation-correlation', keywords: ['escalation', 'escalation monitor', 'escalation risk'], label: 'Panel: Escalation Monitor', icon: '\u{1F4C8}', category: 'panels' },
  { id: 'panel:economic-correlation', keywords: ['economic warfare', 'economic correlation', 'sanctions impact'], label: 'Economic Warfare', icon: '\u{1F4B1}', category: 'panels' },
  { id: 'panel:disaster-correlation', keywords: ['disaster cascade', 'disaster correlation', 'natural disaster'], label: 'Panel: Disaster Cascade', icon: '\u{1F30A}', category: 'panels' },
  { id: 'panel:satellite-fires', keywords: ['fires', 'satellite fires', 'wildfires', 'fire detections'], label: 'Panel: Fires', icon: '\u{1F525}', category: 'panels' },
  { id: 'panel:gulf-economies', keywords: ['gulf', 'gulf economies', 'gcc', 'saudi', 'uae'], label: 'Panel: Gulf Economies', icon: '\u{1F3D7}\uFE0F', category: 'panels' },
  { id: 'panel:gcc-investments', keywords: ['gcc investments', 'gcc funds', 'gulf investments', 'sovereign wealth'], label: 'Panel: GCC Investments', icon: '\u{1F4B0}', category: 'panels' },
  { id: 'panel:giving', keywords: ['giving', 'philanthropy', 'awards', 'donations'], label: 'Panel: Global Giving', icon: '\u{1F49D}', category: 'panels' },
  { id: 'panel:ucdp-events', keywords: ['ucdp', 'armed conflict', 'conflict events', 'war data'], label: 'Panel: UCDP Conflict Events', icon: '\u2694\uFE0F', category: 'panels' },
  { id: 'panel:displacement', keywords: ['displacement', 'refugees', 'unhcr', 'idp'], label: 'Panel: UNHCR Displacement', icon: '\u{1F3C3}', category: 'panels' },
  { id: 'panel:climate', keywords: ['climate', 'climate anomalies', 'temperature', 'weather patterns'], label: 'Panel: Climate Anomalies', icon: '\u{1F321}\uFE0F', category: 'panels' },
  { id: 'panel:population-exposure', keywords: ['population', 'exposure', 'population exposure', 'affected population'], label: 'Panel: Population Exposure', icon: '\u{1F465}', category: 'panels' },
  { id: 'panel:security-advisories', keywords: ['advisories', 'travel advisory', 'security advisory', 'travel warning'], label: 'Panel: Security Advisories', icon: '\u{1F6C2}', category: 'panels' },
  { id: 'panel:oref-sirens', keywords: ['sirens', 'oref', 'israel sirens', 'red alert', 'iron dome'], label: 'Panel: Israel Sirens', icon: '\u{1F6A8}', category: 'panels' },
  { id: 'panel:telegram-intel', keywords: ['telegram', 'telegram intel', 'osint'], label: 'Panel: Telegram Intel', icon: '\u{1F4E8}', category: 'panels' },
  { id: 'panel:airline-intel', keywords: ['airline', 'airline intelligence', 'aviation intel', 'flight news'], label: 'Panel: Airline Intelligence', icon: '\u2708\uFE0F', category: 'panels' },
  { id: 'panel:tech-readiness', keywords: ['tech readiness', 'digital readiness', 'technology index'], label: 'Panel: Tech Readiness Index', icon: '\u{1F4F1}', category: 'panels' },
  { id: 'panel:world-clock', keywords: ['clock', 'world clock', 'time zones', 'timezone'], label: 'Panel: World Clock', icon: '\u{1F570}\uFE0F', category: 'panels' },
  { id: 'panel:layoffs', keywords: ['layoffs', 'layoff tracker', 'job cuts', 'redundancies'], label: 'Panel: Layoffs Tracker', icon: '\u{1F4C9}', category: 'panels' },
  { id: 'panel:radiation-watch', keywords: ['radiation', 'nuclear', 'radnet', 'safecast', 'radiation watch'], label: 'Panel: Radiation Watch', icon: '\u2622\uFE0F', category: 'panels' },
  { id: 'panel:thermal-escalation', keywords: ['thermal', 'thermal escalation', 'heat signature', 'infrared'], label: 'Panel: Thermal Escalation', icon: '\u{1F321}\uFE0F', category: 'panels' },
  { id: 'panel:security', keywords: ['cybersecurity', 'security news', 'hacking', 'breaches', 'vulnerabilities'], label: 'Panel: Cybersecurity', icon: '\u{1F512}', category: 'panels' },

  // Economic / price panels
  { id: 'panel:consumer-prices', keywords: ['consumer prices', 'cpi', 'inflation', 'cost of living'], label: 'Panel: Consumer Prices', icon: '\u{1F6D2}', category: 'panels' },
  { id: 'panel:grocery-basket', keywords: ['grocery', 'grocery basket', 'grocery index', 'food prices', 'supermarket'], label: 'Panel: Grocery Index', icon: '\u{1F96C}', category: 'panels' },
  { id: 'panel:bigmac', keywords: ['bigmac', 'big mac', 'big mac index', 'purchasing power parity', 'ppp'], label: 'Panel: Big Mac Index', icon: '\u{1F354}', category: 'panels' },
  { id: 'panel:fuel-prices', keywords: ['fuel prices', 'gas prices', 'gasoline', 'diesel', 'petrol', 'fuel cost', 'pump prices'], label: 'Panel: Fuel Prices', icon: '\u26FD', category: 'panels' },
  { id: 'panel:fao-food-price-index', keywords: ['fao', 'food price index', 'ffpi', 'food prices', 'cereals', 'fao food', 'global food prices', 'food inflation'], label: 'Panel: FAO Food Price Index', icon: '\u{1F33E}', category: 'panels' },
  { id: 'panel:national-debt', keywords: ['national debt', 'debt clock', 'government debt', 'deficit'], label: 'Panel: National Debt Clock', icon: '\u{1F4B8}', category: 'panels' },
  { id: 'panel:fsi', keywords: ['fsi', 'financial stress', 'financial stress indicator', 'systemic risk'], label: 'Panel: Financial Stress Indicator', icon: '\u{1F4C9}', category: 'panels' },
  { id: 'panel:yield-curve', keywords: ['yield curve', 'rates', 'treasury', 'ecb rates', 'bond yield', 'inversion'], label: 'Panel: Yield Curve & Rates', icon: '\u{1F4C8}', category: 'panels' },
  { id: 'panel:earnings-calendar', keywords: ['earnings', 'earnings calendar', 'eps', 'quarterly results'], label: 'Panel: Earnings Calendar', icon: '\u{1F4C5}', category: 'panels' },
  { id: 'panel:economic-calendar', keywords: ['economic calendar', 'macro events', 'nonfarm payrolls', 'gdp release', 'fomc'], label: 'Panel: Economic Calendar', icon: '\u{1F4C6}', category: 'panels' },
  { id: 'panel:cot-positioning', keywords: ['cot', 'cot positioning', 'commitments of traders', 'futures positioning', 'cftc'], label: 'Panel: CFTC COT Positioning', icon: '\u{1F4CA}', category: 'panels' },
  { id: 'panel:liquidity-shifts', keywords: ['liquidity', 'liquidity shifts', 'oil gold silver', 'top stocks', 'positioning'], label: 'Panel: Liquidity Shifts', icon: '\u{1F4B0}', category: 'panels' },
  { id: 'panel:positioning-247', keywords: ['positioning', '24/7', 'perp', 'perpetual', 'hyperliquid', 'funding rate', 'open interest', 'derivatives stress'], label: 'Panel: 24/7 Positioning', icon: '\u{1F4C8}', category: 'panels' },
  { id: 'panel:macro-tiles', keywords: ['macro tiles', 'macro indicators', 'macro overview'], label: 'Panel: Macro Indicators', icon: '\u{1F9E9}', category: 'panels' },
  { id: 'panel:defense-patents', keywords: ['defense patents', 'r&d signal', 'military research', 'defense r&d'], label: 'Panel: R&D Signal', icon: '\u{1F9EA}', category: 'panels' },
  { id: 'panel:climate-news', keywords: ['climate news', 'climate headlines', 'environment news', 'climate intelligence', 'carbon brief', 'copernicus'], label: 'Panel: Climate News', icon: '\u{1F30D}', category: 'panels' },
  { id: 'panel:disease-outbreaks', keywords: ['disease outbreaks', 'outbreaks', 'who alerts', 'epidemic', 'health alerts', 'promed'], label: 'Panel: Disease Outbreaks', icon: '\u{1F9A0}', category: 'panels' },
  { id: 'panel:social-velocity', keywords: ['social velocity', 'reddit trending', 'social signals', 'viral', 'trending posts'], label: 'Panel: Social Velocity', icon: '\u{1F4F1}', category: 'panels' },
  { id: 'panel:wsb-ticker-scanner', keywords: ['wsb', 'wallstreetbets', 'reddit stocks', 'ticker scanner', 'social sentiment', 'meme stocks'], label: 'Panel: WSB Ticker Scanner', icon: '\u{1F680}', category: 'panels' },

  // Crypto panels
  { id: 'panel:crypto-heatmap', keywords: ['crypto sectors', 'crypto heatmap', 'altcoin sectors'], label: 'Panel: Crypto Sectors', icon: '\u{1F7E9}', category: 'panels' },
  { id: 'panel:defi-tokens', keywords: ['defi', 'defi tokens', 'decentralized finance'], label: 'Panel: DeFi Tokens', icon: '\u{1FA99}', category: 'panels' },
  { id: 'panel:ai-tokens', keywords: ['ai tokens', 'ai crypto', 'artificial intelligence tokens'], label: 'Panel: AI Tokens', icon: '\u{1F916}', category: 'panels' },
  { id: 'panel:other-tokens', keywords: ['alt tokens', 'altcoins', 'other tokens', 'small cap crypto'], label: 'Panel: Alt Tokens', icon: '\u{1F4B9}', category: 'panels' },

  // Tech variant panels
  { id: 'panel:startups', keywords: ['startups', 'startup news', 'vc news'], label: 'Panel: Startups & VC', icon: '\u{1F680}', category: 'panels' },
  { id: 'panel:vcblogs', keywords: ['vc blogs', 'venture capital essays', 'investor insights'], label: 'Panel: VC Insights', icon: '\u{1F4DD}', category: 'panels' },
  { id: 'panel:unicorns', keywords: ['unicorns', 'unicorn tracker', 'billion dollar startups'], label: 'Panel: Unicorn Tracker', icon: '\u{1F984}', category: 'panels' },
  { id: 'panel:accelerators', keywords: ['accelerators', 'demo day', 'yc', 'y combinator'], label: 'Panel: Accelerators & Demo Days', icon: '\u{1F3C6}', category: 'panels' },
  { id: 'panel:funding', keywords: ['funding', 'venture capital', 'vc rounds', 'series a'], label: 'Panel: Funding & VC', icon: '\u{1F4B0}', category: 'panels' },
  { id: 'panel:hardware', keywords: ['hardware', 'semiconductors', 'chips', 'nvidia', 'amd'], label: 'Panel: Semiconductors & Hardware', icon: '\u{1F4BE}', category: 'panels' },
  { id: 'panel:cloud', keywords: ['cloud', 'aws', 'azure', 'gcp', 'infrastructure'], label: 'Panel: Cloud & Infrastructure', icon: '\u2601\uFE0F', category: 'panels' },
  { id: 'panel:dev', keywords: ['developer', 'dev community', 'open source', 'github'], label: 'Panel: Developer Community', icon: '\u{1F9D1}\u200D\u{1F4BB}', category: 'panels' },
  { id: 'panel:ipo', keywords: ['ipo', 'spac', 'earnings', 'mergers', 'acquisitions', 'm&a'], label: 'Panel: IPOs, Earnings & M&A', icon: '\u{1F4C4}', category: 'panels' },
  { id: 'panel:producthunt', keywords: ['product hunt', 'new products', 'launches'], label: 'Panel: Product Hunt', icon: '\u{1F3AF}', category: 'panels' },
  { id: 'panel:events', keywords: ['tech events', 'conferences', 'summits'], label: 'Panel: Tech Events', icon: '\u{1F4C5}', category: 'panels' },
  { id: 'panel:regionalStartups', keywords: ['global startups', 'startup news', 'international startups'], label: 'Panel: Global Startup News', icon: '\u{1F30D}', category: 'panels' },
  { id: 'panel:github', keywords: ['github trending', 'trending repos', 'open source trending'], label: 'GitHub Trending', icon: '\u{1F431}', category: 'panels' },
  { id: 'panel:internet-disruptions', keywords: ['internet disruptions', 'outages', 'internet outage', 'connectivity'], label: 'Internet Disruptions', icon: '\u{1F310}', category: 'panels' },
  { id: 'panel:service-status', keywords: ['service status', 'uptime', 'status page', 'downtime'], label: 'Service Status', icon: '\u{1F7E2}', category: 'panels' },
  { id: 'panel:fin-regulation', keywords: ['financial regulation', 'sec', 'cftc', 'banking regulation'], label: 'Financial Regulation', icon: '\u{1F4DC}', category: 'panels' },

  // Finance variant panels
  { id: 'panel:analysis', keywords: ['market analysis', 'equity analysis', 'technical analysis'], label: 'Market Analysis', icon: '\u{1F4CA}', category: 'panels' },
  { id: 'panel:bonds', keywords: ['bonds', 'fixed income', 'treasuries', 'yield'], label: 'Fixed Income', icon: '\u{1F4B3}', category: 'panels' },
  { id: 'panel:forex', keywords: ['forex', 'currencies', 'fx', 'exchange rates'], label: 'Forex & Currencies', icon: '\u{1F4B1}', category: 'panels' },
  { id: 'panel:derivatives', keywords: ['derivatives', 'options', 'futures', 'swaps'], label: 'Derivatives & Options', icon: '\u{1F4C9}', category: 'panels' },
  { id: 'panel:institutional', keywords: ['institutional', 'hedge funds', 'private equity', 'pe funds'], label: 'Hedge Funds & PE', icon: '\u{1F3E6}', category: 'panels' },
  { id: 'panel:fintech', keywords: ['fintech', 'trading tech', 'financial technology', 'payments'], label: 'Fintech & Trading Tech', icon: '\u{1F4F2}', category: 'panels' },
  { id: 'panel:gold-silver', keywords: ['gold', 'silver', 'precious metals', 'xau', 'xag'], label: 'Gold & Silver', icon: '\u{1F947}', category: 'panels' },
  { id: 'panel:gold-intelligence', keywords: ['gold intelligence', 'gold ratio', 'gold silver ratio', 'xau fx', 'gold positioning', 'gold cot'], label: 'Panel: Gold Intelligence', icon: '\u{1F947}', category: 'panels' },
  { id: 'panel:base-metals', keywords: ['base metals', 'copper', 'aluminum', 'zinc', 'nickel'], label: 'Base Metals', icon: '\u2692\uFE0F', category: 'panels' },
  { id: 'panel:centralbanks', keywords: ['central banks', 'fed', 'ecb', 'boe', 'monetary policy'], label: 'Central Bank Watch', icon: '\u{1F3DB}\uFE0F', category: 'panels' },
  { id: 'panel:markets-news', keywords: ['markets news', 'financial news', 'wall street', 'stock news'], label: 'Markets News', icon: '\u{1F4F0}', category: 'panels' },
  { id: 'panel:economic-news', keywords: ['economic news', 'economy news', 'macro news', 'gdp news'], label: 'Economic News', icon: '\u{1F4F0}', category: 'panels' },
  { id: 'panel:commodities-news', keywords: ['commodities news', 'commodity markets news', 'raw materials news'], label: 'Commodities News', icon: '\u{1F4F0}', category: 'panels' },
  { id: 'panel:crypto-news', keywords: ['crypto news', 'bitcoin news', 'blockchain news', 'defi news'], label: 'Crypto News', icon: '\u{1F4F0}', category: 'panels' },
  { id: 'panel:gccNews', keywords: ['gcc news', 'gulf news', 'saudi news', 'uae news', 'middle east business'], label: 'GCC Business News', icon: '\u{1F1F8}\u{1F1E6}', category: 'panels' },

  // Commodity variant panels
  { id: 'panel:commodity-news', keywords: ['commodity news', 'mining news', 'resource news'], label: 'Commodity News', icon: '\u{1F4F0}', category: 'panels' },
  { id: 'panel:mining-news', keywords: ['mining news', 'mineral news', 'mining industry'], label: 'Mining News', icon: '\u26CF\uFE0F', category: 'panels' },
  { id: 'panel:mining-companies', keywords: ['mining companies', 'miners', 'mining stocks'], label: 'Mining Companies', icon: '\u{1F3ED}', category: 'panels' },
  { id: 'panel:critical-minerals', keywords: ['critical minerals', 'rare earth', 'lithium', 'cobalt', 'strategic minerals'], label: 'Critical Minerals', icon: '\u{1F48E}', category: 'panels' },
  { id: 'panel:commodity-regulation', keywords: ['commodity regulation', 'mining regulation', 'resource policy'], label: 'Regulation & Policy', icon: '\u{1F4DC}', category: 'panels' },

  // Positive / happy panels
  { id: 'panel:positive-feed', keywords: ['good news', 'positive news', 'optimistic', 'uplifting'], label: 'Panel: Good News Feed', icon: '\u{1F33F}', category: 'panels' },
  { id: 'panel:breakthroughs', keywords: ['breakthroughs', 'science breakthroughs', 'discoveries'], label: 'Panel: Breakthroughs', icon: '\u{1F9EC}', category: 'panels' },
  { id: 'panel:progress', keywords: ['human progress', 'progress', 'global progress'], label: 'Panel: Human Progress', icon: '\u{1F4C8}', category: 'panels' },
  { id: 'panel:counters', keywords: ['live counters', 'counters', 'real time counters'], label: 'Panel: Live Counters', icon: '\u{1F522}', category: 'panels' },
  { id: 'panel:spotlight', keywords: ['spotlight', 'hero', 'today hero', 'inspiring'], label: "Panel: Today's Hero", icon: '\u2B50', category: 'panels' },
  { id: 'panel:digest', keywords: ['digest', '5 good things', 'good things', 'daily digest'], label: 'Panel: 5 Good Things', icon: '\u{1F4F0}', category: 'panels' },
  { id: 'panel:species', keywords: ['conservation', 'wildlife', 'endangered species', 'conservation wins'], label: 'Panel: Conservation Wins', icon: '\u{1F43C}', category: 'panels' },
  { id: 'panel:renewable', keywords: ['renewable energy', 'solar', 'wind energy', 'green energy'], label: 'Panel: Renewable Energy', icon: '\u2600\uFE0F', category: 'panels' },

  // View / settings
  { id: 'view:dark', keywords: ['dark', 'dark mode', 'night'], label: 'Switch to dark mode', icon: '\u{1F319}', category: 'view' },
  { id: 'view:light', keywords: ['light', 'light mode', 'day'], label: 'Switch to light mode', icon: '\u2600\uFE0F', category: 'view' },
  { id: 'view:fullscreen', keywords: ['fullscreen', 'full screen'], label: 'Toggle fullscreen', icon: '\u26F6', category: 'view' },
  { id: 'view:settings', keywords: ['settings', 'config', 'api keys'], label: 'Open settings', icon: '\u2699\uFE0F', category: 'view' },
  { id: 'view:refresh', keywords: ['refresh', 'reload', 'refresh all'], label: 'Refresh all data', icon: '\u{1F504}', category: 'view' },
  { id: 'view:resilience', keywords: ['resilience', 'resilience score', 'baseline', 'stress', 'country resilience'], label: 'Toggle resilience score', icon: '\u{1F6E1}\uFE0F', category: 'view' },
  { id: 'view:route-explorer', keywords: ['route', 'explorer', 'ship', 'shipping', 'freight', 'cargo', 'lane', 'hs code', 'hs2', 'import', 'export', 'plan a shipment'], label: 'Route Explorer \u2014 plan a shipment', icon: '\u{1F6A2}', category: 'view' },

  // Time range
  { id: 'time:1h', keywords: ['1h', 'last hour', '1 hour'], label: 'Show events from last hour', icon: '\u{1F550}', category: 'actions' },
  { id: 'time:6h', keywords: ['6h', 'last 6 hours', '6 hours'], label: 'Show events from last 6 hours', icon: '\u{1F555}', category: 'actions' },
  { id: 'time:24h', keywords: ['24h', 'last 24 hours', 'today'], label: 'Show events from last 24 hours', icon: '\u{1F55B}', category: 'actions' },
  { id: 'time:48h', keywords: ['48h', '2 days', 'last 2 days'], label: 'Show events from last 48 hours', icon: '\u{1F4C5}', category: 'actions' },
  { id: 'time:7d', keywords: ['7d', 'week', 'last week', '7 days'], label: 'Show events from last 7 days', icon: '\u{1F5D3}\uFE0F', category: 'actions' },
];

// All ISO 3166-1 alpha-2 codes — Intl.DisplayNames resolves human-readable names at runtime
const ISO_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AL', 'AM', 'AO', 'AR', 'AT', 'AU', 'AZ', 'BA', 'BB', 'BD', 'BE', 'BF',
  'BG', 'BH', 'BI', 'BJ', 'BN', 'BO', 'BR', 'BS', 'BT', 'BW', 'BY', 'BZ', 'CA', 'CD', 'CF', 'CG',
  'CH', 'CI', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO',
  'DZ', 'EC', 'EE', 'EG', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FM', 'FR', 'GA', 'GB', 'GD', 'GE', 'GH',
  'GM', 'GN', 'GQ', 'GR', 'GT', 'GW', 'GY', 'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IN', 'IQ',
  'IR', 'IS', 'IT', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KZ',
  'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MG',
  'MH', 'MK', 'ML', 'MM', 'MN', 'MR', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NE', 'NG',
  'NI', 'NL', 'NO', 'NP', 'NR', 'NZ', 'OM', 'PA', 'PE', 'PG', 'PH', 'PK', 'PL', 'PS', 'PT', 'PW',
  'PY', 'QA', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SI', 'SK', 'SL', 'SM',
  'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SY', 'SZ', 'TD', 'TG', 'TH', 'TJ', 'TL', 'TM', 'TN', 'TO',
  'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VN', 'VU', 'WS',
  'YE', 'ZA', 'ZM', 'ZW',
];

let _cachedLang = '';
let _cachedCountryCommands: Command[] = [];
let _cachedAllCommands: Command[] = [];

const KEYWORD_I18N_MAP: Record<string, string> = {
  military: 'commands.keywords.military',
  finance: 'commands.keywords.finance',
  financial: 'commands.keywords.finance',
  infrastructure: 'commands.keywords.infrastructure',
  intelligence: 'commands.keywords.intelligence',
  news: 'commands.keywords.news',
  dark: 'commands.keywords.dark',
  light: 'commands.keywords.light',
  settings: 'commands.keywords.settings',
  fullscreen: 'commands.keywords.fullscreen',
  refresh: 'commands.keywords.refresh',
};

function injectLocalizedKeywords(commands: Command[]): Command[] {
  const lang = getCurrentLanguage();
  if (lang === 'en') return commands;

  return commands.map(cmd => {
    const extra: string[] = [];
    for (const kw of cmd.keywords) {
      const i18nKey = KEYWORD_I18N_MAP[kw];
      if (i18nKey) {
        const localized = t(i18nKey).toLowerCase();
        if (localized !== kw && !cmd.keywords.includes(localized)) {
          extra.push(localized);
        }
      }
    }
    if (extra.length === 0) return cmd;
    return { ...cmd, keywords: [...cmd.keywords, ...extra] };
  });
}

function buildCountryCommands(): Command[] {
  const lang = getCurrentLanguage();
  if (lang === _cachedLang && _cachedCountryCommands.length > 0) {
    return _cachedCountryCommands;
  }

  const displayNames = new Intl.DisplayNames([lang], { type: 'region' });

  const result = ISO_CODES.flatMap(code => {
    const curated = CURATED_COUNTRIES[code];
    const name = displayNames.of(code) || curated?.name || code;
    const keywords = curated
      ? [name.toLowerCase(), curated.name.toLowerCase(), ...curated.searchAliases].filter(Boolean)
      : [name.toLowerCase()];
    return [
      {
        id: `country-map:${code}`,
        keywords: [...keywords, 'map'],
        label: name,
        icon: toFlagEmoji(code),
        category: 'navigate' as const,
      },
      {
        id: `country:${code}`,
        keywords: [...keywords, 'brief'],
        label: name,
        icon: toFlagEmoji(code),
        category: 'country' as const,
      },
    ];
  });

  _cachedLang = lang;
  _cachedCountryCommands = result;
  _cachedAllCommands = [...injectLocalizedKeywords(COMMANDS), ...result];
  return result;
}

export function getAllCommands(): Command[] {
  buildCountryCommands();
  return _cachedAllCommands.length > 0 ? _cachedAllCommands : COMMANDS;
}
