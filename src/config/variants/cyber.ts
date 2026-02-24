// Cyber/GATRA variant - cybersecurity intelligence dashboard
//
// Includes the GATRA integration layer:
//   - GatraSOCDashboardPanel  (src/panels/gatra-soc-panel.ts)
//   - GATRA alerts map layer  (src/layers/gatra-alerts-layer.ts)
//   - GATRA connector service (src/gatra/connector.ts)
import type { PanelConfig, MapLayers } from '@/types';
import type { VariantConfig } from './base';

// Re-export base config
export * from './base';

// Cyber-focused feeds configuration
import type { Feed } from '@/types';

const rss = (url: string) => `/api/rss-proxy?url=${encodeURIComponent(url)}`;

export const FEEDS: Record<string, Feed[]> = {
  // Core Cybersecurity News
  security: [
    { name: 'Krebs on Security', url: rss('https://krebsonsecurity.com/feed/') },
    { name: 'Bleeping Computer', url: rss('https://www.bleepingcomputer.com/feed/') },
    { name: 'The Hacker News', url: rss('https://feeds.feedburner.com/TheHackersNews') },
    { name: 'Dark Reading', url: rss('https://www.darkreading.com/rss.xml') },
    { name: 'Schneier on Security', url: rss('https://www.schneier.com/feed/') },
    { name: 'SecurityWeek', url: rss('https://www.securityweek.com/feed/') },
    { name: 'The Record', url: rss('https://therecord.media/feed') },
    { name: 'CSO Online', url: rss('https://www.csoonline.com/feed/') },
  ],

  // Indonesian Cyber Sources
  indonesia: [
    { name: 'BSSN News', url: rss('https://www.bssn.go.id/feed/') },
    { name: 'Indonesia Cyber', url: rss('https://news.google.com/rss/search?q=(BSSN+OR+"Badan+Siber"+OR+Indonesia+cybersecurity+OR+Indonesia+cyber+attack)+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'APJII News', url: rss('https://news.google.com/rss/search?q=APJII+OR+"internet+Indonesia"+OR+"digital+Indonesia"+when:7d&hl=en-US&gl=US&ceid=US:en') },
  ],

  // Threat Intelligence
  threats: [
    { name: 'CISA Advisories', url: rss('https://www.cisa.gov/cybersecurity-advisories/all.xml') },
    { name: 'US-CERT Alerts', url: rss('https://www.cisa.gov/uscert/ncas/alerts.xml') },
    { name: 'NIST CVE', url: rss('https://news.google.com/rss/search?q=(CVE+OR+"zero+day"+OR+"critical+vulnerability")+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Exploit DB', url: rss('https://news.google.com/rss/search?q=("exploit"+OR+"proof+of+concept"+OR+"CVE")+cybersecurity+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Cyber Incidents', url: rss('https://news.google.com/rss/search?q=(cyber+attack+OR+data+breach+OR+ransomware+OR+hacking)+when:3d&hl=en-US&gl=US&ceid=US:en') },
  ],

  // Ransomware & Malware
  malware: [
    { name: 'Ransomware News', url: rss('https://news.google.com/rss/search?q=ransomware+attack+OR+ransomware+gang+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Malware Analysis', url: rss('https://news.google.com/rss/search?q=malware+analysis+OR+malware+campaign+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'APT Groups', url: rss('https://news.google.com/rss/search?q=(APT+OR+"advanced+persistent+threat"+OR+"state+sponsored")+cyber+when:7d&hl=en-US&gl=US&ceid=US:en') },
  ],

  // Infrastructure & ICS/OT Security
  infrastructure: [
    { name: 'ICS Security', url: rss('https://news.google.com/rss/search?q=(ICS+OR+SCADA+OR+"operational+technology"+OR+OT)+cybersecurity+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Critical Infrastructure', url: rss('https://news.google.com/rss/search?q="critical+infrastructure"+cyber+OR+attack+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Submarine Cable News', url: rss('https://news.google.com/rss/search?q="submarine+cable"+OR+"undersea+cable"+sabotage+OR+damage+OR+security+when:7d&hl=en-US&gl=US&ceid=US:en') },
  ],

  // Nation-State & Geopolitical Cyber
  geoCyber: [
    { name: 'Cyber Warfare', url: rss('https://news.google.com/rss/search?q="cyber+warfare"+OR+"cyber+espionage"+OR+"nation+state"+hacking+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'China Cyber', url: rss('https://news.google.com/rss/search?q=China+cyber+espionage+OR+China+hacking+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Russia Cyber', url: rss('https://news.google.com/rss/search?q=Russia+cyber+attack+OR+Russia+hacking+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'North Korea Cyber', url: rss('https://news.google.com/rss/search?q="North+Korea"+cyber+OR+Lazarus+Group+when:14d&hl=en-US&gl=US&ceid=US:en') },
  ],

  // Security Research & Vendor Blogs
  research: [
    { name: 'Google Project Zero', url: rss('https://googleprojectzero.blogspot.com/feeds/posts/default?alt=rss') },
    { name: 'Microsoft Security', url: rss('https://www.microsoft.com/en-us/security/blog/feed/') },
    { name: 'Google TAG', url: rss('https://blog.google/threat-analysis-group/rss/') },
    { name: 'Mandiant Blog', url: rss('https://www.mandiant.com/resources/blog/rss.xml') },
    { name: 'CrowdStrike Blog', url: rss('https://www.crowdstrike.com/blog/feed/') },
    { name: 'Palo Alto Unit 42', url: rss('https://unit42.paloaltonetworks.com/feed/') },
  ],

  // Policy & Regulation
  policy: [
    { name: 'Cyber Policy', url: rss('https://news.google.com/rss/search?q=cybersecurity+regulation+OR+cybersecurity+policy+OR+cybersecurity+law+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'NIST Framework', url: rss('https://news.google.com/rss/search?q=NIST+cybersecurity+framework+when:14d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'EU Cyber', url: rss('https://news.google.com/rss/search?q=(NIS2+OR+ENISA+OR+"EU+cybersecurity")+when:14d&hl=en-US&gl=US&ceid=US:en') },
  ],

  // AI & Security
  aiSecurity: [
    { name: 'AI Security', url: rss('https://news.google.com/rss/search?q=("AI+security"+OR+"machine+learning"+cybersecurity+OR+"adversarial+AI")+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'AI for SOC', url: rss('https://news.google.com/rss/search?q=("AI+SOC"+OR+"AI+threat+detection"+OR+"automated+security")+when:7d&hl=en-US&gl=US&ceid=US:en') },
  ],
};

// Panel configuration for cyber/GATRA dashboard
export const DEFAULT_PANELS: Record<string, PanelConfig> = {
  map: { name: 'Global Cyber Map', enabled: true, priority: 1 },
  'live-news': { name: 'Cyber Headlines', enabled: true, priority: 1 },
  insights: { name: 'AI Insights', enabled: true, priority: 1 },
  'gatra-soc': { name: 'GATRA SOC', enabled: true, priority: 1 },
  security: { name: 'Cybersecurity News', enabled: true, priority: 1 },
  indonesia: { name: 'Indonesia Cyber (BSSN)', enabled: true, priority: 1 },
  threats: { name: 'Threat Intelligence', enabled: true, priority: 1 },
  malware: { name: 'Ransomware & Malware', enabled: true, priority: 1 },
  infrastructure: { name: 'Infrastructure Security', enabled: true, priority: 1 },
  geoCyber: { name: 'Nation-State Cyber', enabled: true, priority: 1 },
  research: { name: 'Security Research', enabled: true, priority: 1 },
  policy: { name: 'Cyber Policy', enabled: true, priority: 2 },
  aiSecurity: { name: 'AI & Security', enabled: true, priority: 2 },
  monitors: { name: 'My Monitors', enabled: true, priority: 2 },
};

// Cyber-focused map layers
export const DEFAULT_MAP_LAYERS: MapLayers = {
  conflicts: true,
  bases: false,
  cables: true,
  pipelines: false,
  hotspots: false,
  ais: false,
  nuclear: false,
  irradiators: false,
  sanctions: false,
  weather: false,
  economic: false,
  waterways: false,
  outages: true,
  cyberThreats: true,
  datacenters: true,
  protests: false,
  flights: false,
  military: true,
  natural: true,
  spaceports: false,
  minerals: false,
  fires: true,
  // Data source layers
  ucdpEvents: false,
  displacement: false,
  climate: false,
  // Tech layers
  startupHubs: false,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: false,
  // Finance layers
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: false,
  gulfInvestments: false,
  // GATRA SOC layer — enabled by default in cyber variant
  gatraAlerts: true,
};

// Mobile defaults for cyber variant
export const MOBILE_DEFAULT_MAP_LAYERS: MapLayers = {
  conflicts: true,
  bases: false,
  cables: true,
  pipelines: false,
  hotspots: false,
  ais: false,
  nuclear: false,
  irradiators: false,
  sanctions: false,
  weather: false,
  economic: false,
  waterways: false,
  outages: true,
  cyberThreats: true,
  datacenters: false,
  protests: false,
  flights: false,
  military: false,
  natural: true,
  spaceports: false,
  minerals: false,
  fires: true,
  // Data source layers
  ucdpEvents: false,
  displacement: false,
  climate: false,
  // Tech layers
  startupHubs: false,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: false,
  // Finance layers
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: false,
  gulfInvestments: false,
  // GATRA SOC layer — enabled on mobile too
  gatraAlerts: true,
};

export const VARIANT_CONFIG: VariantConfig = {
  name: 'cyber',
  description: 'Cybersecurity & GATRA threat intelligence dashboard',
  panels: DEFAULT_PANELS,
  mapLayers: DEFAULT_MAP_LAYERS,
  mobileMapLayers: MOBILE_DEFAULT_MAP_LAYERS,
};
