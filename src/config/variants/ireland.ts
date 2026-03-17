// Ireland Tech variant - IrishTech Daily
import type { PanelConfig, MapLayers, Feed } from '@/types';
import type { VariantConfig } from './base';
import { rssProxyUrl } from '@/utils';

// Re-export base config
export * from './base';

const rss = rssProxyUrl;

// Ireland-specific FEEDS configuration
export const FEEDS: Record<string, Feed[]> = {
  // 爱尔兰科技新闻
  ieTech: [
    { name: 'Silicon Republic', url: rss('https://www.siliconrepublic.com/feed') },
    { name: 'Tech Central', url: rss('https://www.techcentral.ie/feed/') },
    { name: 'Business Plus', url: rss('https://businessplus.ie/feed/') },
    { name: 'Irish Tech News', url: rss('https://irishtechnews.ie/feed/') },
  ],

  // 爱尔兰学术机构（通过 Google News）
  ieAcademic: [
    { 
      name: 'TCD News', 
      url: rss('https://news.google.com/rss/search?q=site:tcd.ie+when:7d&hl=en-IE&gl=IE&ceid=IE:en') 
    },
    { 
      name: 'UCD News', 
      url: rss('https://news.google.com/rss/search?q=site:ucd.ie+when:7d&hl=en-IE&gl=IE&ceid=IE:en') 
    },
    { 
      name: 'SFI Announcements', 
      url: rss('https://news.google.com/rss/search?q=site:sfi.ie+when:7d&hl=en-IE&gl=IE&ceid=IE:en') 
    },
    { 
      name: 'Enterprise Ireland', 
      url: rss('https://news.google.com/rss/search?q=site:enterprise-ireland.com+when:7d&hl=en-IE&gl=IE&ceid=IE:en') 
    },
  ],

  // 全球科技新闻（复用）
  tech: [
    { name: 'TechCrunch', url: rss('https://techcrunch.com/feed/') },
    { name: 'Hacker News', url: rss('https://hnrss.org/frontpage') },
    { name: 'The Verge', url: rss('https://www.theverge.com/rss/index.xml') },
  ],

  // AI/ML
  ai: [
    { name: 'AI News', url: rss('https://news.google.com/rss/search?q=(OpenAI+OR+Anthropic+OR+Google+AI+OR+"AI+model")+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'ArXiv AI', url: rss('https://export.arxiv.org/rss/cs.AI') },
    { name: 'ArXiv ML', url: rss('https://export.arxiv.org/rss/cs.LG') },
  ],

  // 欧洲创业生态
  startups: [
    { name: 'EU Startups', url: rss('https://www.eu-startups.com/feed/') },
    { name: 'Tech.eu', url: rss('https://tech.eu/feed/') },
    { name: 'Sifted (Europe)', url: rss('https://sifted.eu/feed') },
    { name: 'TechCrunch Startups', url: rss('https://techcrunch.com/category/startups/feed/') },
  ],

  // 爱尔兰科技峰会
  ieSummits: [
    { name: 'Dublin Tech Summit', url: rss('https://news.google.com/rss/search?q="Dublin+Tech+Summit"+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Web Summit', url: rss('https://news.google.com/rss/search?q="Web+Summit"+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'SaaStock', url: rss('https://news.google.com/rss/search?q="SaaStock"+Dublin+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
  ],

  // 爱尔兰商业新闻
  ieBusiness: [
    { name: 'Irish Times Business', url: rss('https://www.irishtimes.com/business/rss') },
    { name: 'Irish Independent Business', url: rss('https://www.independent.ie/business/rss') },
    { name: 'RTE Business', url: rss('https://www.rte.ie/feeds/business/') },
  ],
};

// Ireland variant panels
export const PANELS: Record<string, PanelConfig> = {
  ieTech: { name: 'Irish Tech', enabled: true, priority: 1 },
  ieAcademic: { name: 'Academia', enabled: true, priority: 2 },
  tech: { name: 'Global Tech', enabled: true, priority: 3 },
  ai: { name: 'AI/ML', enabled: true, priority: 4 },
  startups: { name: 'Startups', enabled: true, priority: 5 },
  ieSummits: { name: 'Summits', enabled: true, priority: 6 },
  ieBusiness: { name: 'Business', enabled: true, priority: 7 },
};

// Ireland map layers (minimal for tech focus)
const IRELAND_MAP_LAYERS: MapLayers = {
  conflicts: false,
  bases: false,
  cables: false,
  pipelines: false,
  hotspots: false,
  ais: false,
  nuclear: false,
  irradiators: false,
  sanctions: false,
  weather: false,
  economic: false,
  waterways: false,
  outages: false,
  cyberThreats: false,
  datacenters: true,  // 爱尔兰有很多数据中心
  protests: false,
  flights: false,
  military: false,
  natural: false,
  spaceports: false,
  minerals: false,
  fires: false,
  ucdpEvents: false,
  displacement: false,
  climate: false,
  startupHubs: true,  // 科技创业中心
  cloudRegions: true, // 云区域
  accelerators: true, // 加速器
  techHQs: true,      // 科技公司总部
  techEvents: true,   // 科技活动
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: false,
  gulfInvestments: false,
  positiveEvents: false,
  kindness: false,
  happiness: false,
  speciesRecovery: false,
  renewableInstallations: false,
  tradeRoutes: false,
  iranAttacks: false,
  gpsJamming: false,
  satellites: false,
  ciiChoropleth: false,
  dayNight: false,
  miningSites: false,
  processingPlants: false,
  commodityPorts: false,
  webcams: false,
};

// Ireland variant config
export const VARIANT_CONFIG: VariantConfig = {
  name: 'IrishTech Daily',
  description: "Ireland's tech pulse, daily",
  panels: PANELS,
  mapLayers: IRELAND_MAP_LAYERS,
  mobileMapLayers: IRELAND_MAP_LAYERS,
};
