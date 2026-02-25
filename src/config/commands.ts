import type { MapLayers } from '@/types';
import { CURATED_COUNTRIES } from '@/config/countries';

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
};

export const COMMANDS: Command[] = [
  // Navigation (region switching)
  { id: 'nav:global', keywords: ['global', 'world', 'reset', 'home'], label: 'Go to Global view', icon: '\u{1F30D}', category: 'navigate' },
  { id: 'nav:mena', keywords: ['mena', 'middle east', 'mideast'], label: 'Go to Middle East & North Africa', icon: '\u{1F54C}', category: 'navigate' },
  { id: 'nav:eu', keywords: ['europe', 'eu'], label: 'Go to Europe', icon: '\u{1F3F0}', category: 'navigate' },
  { id: 'nav:asia', keywords: ['asia', 'pacific'], label: 'Go to Asia-Pacific', icon: '\u{1F3EF}', category: 'navigate' },
  { id: 'nav:america', keywords: ['america', 'americas', 'us', 'usa'], label: 'Go to Americas', icon: '\u{1F5FD}', category: 'navigate' },
  { id: 'nav:africa', keywords: ['africa'], label: 'Go to Africa', icon: '\u{1F30D}', category: 'navigate' },
  { id: 'nav:latam', keywords: ['latam', 'latin america', 'south america'], label: 'Go to Latin America', icon: '\u{1F30E}', category: 'navigate' },
  { id: 'nav:oceania', keywords: ['oceania', 'australia', 'pacific islands'], label: 'Go to Oceania', icon: '\u{1F30F}', category: 'navigate' },

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
  { id: 'layer:flights', keywords: ['flights', 'aircraft', 'planes'], label: 'Toggle military flights', icon: '\u2708\uFE0F', category: 'layers' },
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
  { id: 'layer:outages', keywords: ['outages', 'internet outages'], label: 'Toggle internet outages', icon: '\u{1F4E1}', category: 'layers' },
  { id: 'layer:tradeRoutes', keywords: ['trade routes', 'shipping lanes', 'trade'], label: 'Toggle trade routes', icon: '\u{1F6A2}', category: 'layers' },

  // Panel navigation (matching actual DEFAULT_PANELS keys)
  { id: 'panel:live-news', keywords: ['news', 'live news', 'headlines'], label: 'Jump to Live News', icon: '\u{1F4F0}', category: 'panels' },
  { id: 'panel:intel', keywords: ['intel', 'intel feed'], label: 'Jump to Intel Feed', icon: '\u{1F50E}', category: 'panels' },
  { id: 'panel:gdelt-intel', keywords: ['gdelt', 'intelligence feed'], label: 'Jump to Live Intelligence', icon: '\u{1F50D}', category: 'panels' },
  { id: 'panel:cii', keywords: ['cii', 'instability', 'country risk'], label: 'Jump to Country Instability', icon: '\u{1F3AF}', category: 'panels' },
  { id: 'panel:cascade', keywords: ['cascade', 'infrastructure cascade'], label: 'Jump to Infrastructure Cascade', icon: '\u{1F517}', category: 'panels' },
  { id: 'panel:strategic-risk', keywords: ['risk', 'strategic risk', 'threat level'], label: 'Jump to Strategic Risk', icon: '\u26A0\uFE0F', category: 'panels' },
  { id: 'panel:politics', keywords: ['world news', 'politics', 'geopolitics'], label: 'Jump to World News', icon: '\u{1F30D}', category: 'panels' },
  { id: 'panel:us', keywords: ['united states', 'us news', 'america news'], label: 'Jump to United States', icon: '\u{1F1FA}\u{1F1F8}', category: 'panels' },
  { id: 'panel:europe', keywords: ['europe news', 'eu news'], label: 'Jump to Europe', icon: '\u{1F1EA}\u{1F1FA}', category: 'panels' },
  { id: 'panel:middleeast', keywords: ['middle east news', 'mideast news'], label: 'Jump to Middle East', icon: '\u{1F54C}', category: 'panels' },
  { id: 'panel:africa', keywords: ['africa news'], label: 'Jump to Africa', icon: '\u{1F30D}', category: 'panels' },
  { id: 'panel:latam', keywords: ['latin america news', 'latam news'], label: 'Jump to Latin America', icon: '\u{1F30E}', category: 'panels' },
  { id: 'panel:asia', keywords: ['asia news', 'asia-pacific news'], label: 'Jump to Asia-Pacific', icon: '\u{1F30F}', category: 'panels' },
  { id: 'panel:energy', keywords: ['energy', 'resources', 'oil news'], label: 'Jump to Energy & Resources', icon: '\u26A1', category: 'panels' },
  { id: 'panel:gov', keywords: ['government', 'gov'], label: 'Jump to Government', icon: '\u{1F3DB}\uFE0F', category: 'panels' },
  { id: 'panel:thinktanks', keywords: ['think tanks', 'thinktanks', 'analysis'], label: 'Jump to Think Tanks', icon: '\u{1F9E0}', category: 'panels' },
  { id: 'panel:polymarket', keywords: ['predictions', 'polymarket', 'forecasts'], label: 'Jump to Predictions', icon: '\u{1F52E}', category: 'panels' },
  { id: 'panel:commodities', keywords: ['commodities', 'gold', 'silver'], label: 'Jump to Commodities', icon: '\u{1F4E6}', category: 'panels' },
  { id: 'panel:markets', keywords: ['markets', 'stocks', 'indices'], label: 'Jump to Markets', icon: '\u{1F4C8}', category: 'panels' },
  { id: 'panel:economic', keywords: ['economic', 'economy', 'fred'], label: 'Jump to Economic Indicators', icon: '\u{1F4CA}', category: 'panels' },
  { id: 'panel:finance', keywords: ['financial', 'finance news'], label: 'Jump to Financial', icon: '\u{1F4B5}', category: 'panels' },
  { id: 'panel:tech', keywords: ['technology', 'tech news'], label: 'Jump to Technology', icon: '\u{1F4BB}', category: 'panels' },
  { id: 'panel:crypto', keywords: ['crypto', 'bitcoin', 'ethereum'], label: 'Jump to Crypto', icon: '\u20BF', category: 'panels' },
  { id: 'panel:heatmap', keywords: ['heatmap', 'sector heatmap'], label: 'Jump to Sector Heatmap', icon: '\u{1F5FA}\uFE0F', category: 'panels' },
  { id: 'panel:ai', keywords: ['ai', 'ml', 'artificial intelligence'], label: 'Jump to AI/ML', icon: '\u{1F916}', category: 'panels' },
  { id: 'panel:macro-signals', keywords: ['macro', 'macro signals', 'liquidity'], label: 'Jump to Market Radar', icon: '\u{1F4C9}', category: 'panels' },
  { id: 'panel:etf-flows', keywords: ['etf', 'etf flows', 'fund flows'], label: 'Jump to BTC ETF Tracker', icon: '\u{1F4B9}', category: 'panels' },
  { id: 'panel:stablecoins', keywords: ['stablecoins', 'usdt', 'usdc'], label: 'Jump to Stablecoins', icon: '\u{1FA99}', category: 'panels' },
  { id: 'panel:monitors', keywords: ['monitors', 'my monitors', 'watchlist'], label: 'Jump to My Monitors', icon: '\u{1F4CB}', category: 'panels' },

  // View / settings
  { id: 'view:dark', keywords: ['dark', 'dark mode', 'night'], label: 'Switch to dark mode', icon: '\u{1F319}', category: 'view' },
  { id: 'view:light', keywords: ['light', 'light mode', 'day'], label: 'Switch to light mode', icon: '\u2600\uFE0F', category: 'view' },
  { id: 'view:fullscreen', keywords: ['fullscreen', 'full screen'], label: 'Toggle fullscreen', icon: '\u26F6', category: 'view' },
  { id: 'view:settings', keywords: ['settings', 'config', 'api keys'], label: 'Open settings', icon: '\u2699\uFE0F', category: 'view' },
  { id: 'view:refresh', keywords: ['refresh', 'reload', 'refresh all'], label: 'Refresh all data', icon: '\u{1F504}', category: 'view' },

  // Time range
  { id: 'time:1h', keywords: ['1h', 'last hour', '1 hour'], label: 'Show events from last hour', icon: '\u{1F550}', category: 'actions' },
  { id: 'time:6h', keywords: ['6h', 'last 6 hours', '6 hours'], label: 'Show events from last 6 hours', icon: '\u{1F555}', category: 'actions' },
  { id: 'time:24h', keywords: ['24h', 'last 24 hours', 'today'], label: 'Show events from last 24 hours', icon: '\u{1F55B}', category: 'actions' },
  { id: 'time:48h', keywords: ['48h', '2 days', 'last 2 days'], label: 'Show events from last 48 hours', icon: '\u{1F4C5}', category: 'actions' },
  { id: 'time:7d', keywords: ['7d', 'week', 'last week', '7 days'], label: 'Show events from last 7 days', icon: '\u{1F5D3}\uFE0F', category: 'actions' },
];

function toFlagEmoji(code: string): string {
  return code.toUpperCase().split('').map(c => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join('');
}

// All ISO 3166-1 alpha-2 codes — Intl.DisplayNames resolves human-readable names at runtime
const ISO_CODES = [
  'AD','AE','AF','AG','AL','AM','AO','AR','AT','AU','AZ','BA','BB','BD','BE','BF',
  'BG','BH','BI','BJ','BN','BO','BR','BS','BT','BW','BY','BZ','CA','CD','CF','CG',
  'CH','CI','CL','CM','CN','CO','CR','CU','CV','CY','CZ','DE','DJ','DK','DM','DO',
  'DZ','EC','EE','EG','ER','ES','ET','FI','FJ','FM','FR','GA','GB','GD','GE','GH',
  'GM','GN','GQ','GR','GT','GW','GY','HN','HR','HT','HU','ID','IE','IL','IN','IQ',
  'IR','IS','IT','JM','JO','JP','KE','KG','KH','KI','KM','KN','KP','KR','KW','KZ',
  'LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MG',
  'MH','MK','ML','MM','MN','MR','MT','MU','MV','MW','MX','MY','MZ','NA','NE','NG',
  'NI','NL','NO','NP','NR','NZ','OM','PA','PE','PG','PH','PK','PL','PS','PT','PW',
  'PY','QA','RO','RS','RU','RW','SA','SB','SC','SD','SE','SG','SI','SK','SL','SM',
  'SN','SO','SR','SS','ST','SV','SY','SZ','TD','TG','TH','TJ','TL','TM','TN','TO',
  'TR','TT','TV','TW','TZ','UA','UG','US','UY','UZ','VA','VC','VE','VN','VU','WS',
  'YE','ZA','ZM','ZW',
];

const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });

const COUNTRY_COMMANDS: Command[] = ISO_CODES.map(code => {
  const curated = CURATED_COUNTRIES[code];
  const name = curated?.name || displayNames.of(code) || code;
  const keywords = curated
    ? [name.toLowerCase(), ...curated.searchAliases]
    : [name.toLowerCase()];
  return {
    id: `country:${code}`,
    keywords,
    label: `Open ${name} brief`,
    icon: toFlagEmoji(code),
    category: 'country' as const,
  };
});

COMMANDS.push(...COUNTRY_COMMANDS);
