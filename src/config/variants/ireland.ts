// Ireland Tech variant - IrishTech Daily
import type { PanelConfig, MapLayers, Feed } from '@/types';
import type { VariantConfig } from './base';
import { rssProxyUrl } from '@/utils';

// Re-export base config
export * from './base';

// Ireland geographic bounds for map locking (expanded to show UK context)
// SW corner: -15, 48 (includes more Atlantic)
// NE corner: 2, 60 (includes UK mainland)
export const IRELAND_BOUNDS = {
  sw: { lng: -20, lat: 45 },
  ne: { lng: 5, lat: 62 },
} as const;

// Minimum zoom level - lower = more zoomed out
export const IRELAND_MIN_ZOOM = 3;

// Center of Ireland for default map position
export const IRELAND_CENTER = {
  lat: 53.5,
  lng: -8.0,
} as const;

// Default zoom for Ireland variant (more zoomed out than min)
export const IRELAND_DEFAULT_ZOOM = 5;

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

  // 半导体产业新闻
  ieSemiconductors: [
    { 
      name: 'Intel Ireland', 
      url: rss('https://news.google.com/rss/search?q=Intel+Ireland+when:7d&hl=en-IE&gl=IE&ceid=IE:en') 
    },
    { 
      name: 'Silicon Republic - Semiconductors', 
      url: rss('https://www.siliconrepublic.com/tag/semiconductors/feed') 
    },
    { 
      name: 'EU Chips Act Ireland', 
      url: rss('https://news.google.com/rss/search?q=%22EU+Chips+Act%22+Ireland+when:14d&hl=en-IE&gl=IE&ceid=IE:en') 
    },
    { 
      name: 'Semiconductor Industry Ireland', 
      url: rss('https://news.google.com/rss/search?q=(semiconductor+OR+%22chip+manufacturing%22+OR+fab)+Ireland+when:14d&hl=en-IE&gl=IE&ceid=IE:en') 
    },
    { 
      name: 'Analog Devices Ireland', 
      url: rss('https://news.google.com/rss/search?q=%22Analog+Devices%22+(Ireland+OR+Limerick)+when:14d&hl=en-IE&gl=IE&ceid=IE:en') 
    },
    { 
      name: 'Tyndall National Institute', 
      url: rss('https://news.google.com/rss/search?q=%22Tyndall+National+Institute%22+OR+%22Tyndall+Cork%22+when:14d&hl=en-IE&gl=IE&ceid=IE:en') 
    },
  ],

  // 爱尔兰商业新闻（使用 Google News 搜索）
  ieBusiness: [
    { name: 'Irish Times Business', url: rss('https://news.google.com/rss/search?q=site:irishtimes.com+business+when:7d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Irish Independent Business', url: rss('https://news.google.com/rss/search?q=site:independent.ie+business+when:7d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'RTE Business', url: rss('https://news.google.com/rss/search?q=site:rte.ie+business+when:7d&hl=en-IE&gl=IE&ceid=IE:en') },
  ],

  // 爱尔兰科技并购（M&A）
  ieDeals: [
    { name: 'Irish Tech M&A', url: rss('https://news.google.com/rss/search?q=(Ireland+OR+Irish+OR+Dublin)+(tech+OR+startup)+(acquisition+OR+acquires+OR+merger+OR+takeover)+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Irish Times Deals', url: rss('https://news.google.com/rss/search?q=site:irishtimes.com+(acquisition+OR+merger)+tech+Ireland+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Silicon Republic Deals', url: rss('https://news.google.com/rss/search?q=site:siliconrepublic.com+(acquisition+OR+merger+OR+deal)+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
  ],

  // 爱尔兰大厂招聘
  ieJobs: [
    // LinkedIn hiring signal (news-indexed)
    { name: 'LinkedIn Ireland Tech Hiring', url: rss('https://news.google.com/rss/search?q=site:linkedin.com/jobs+(Ireland+OR+Dublin)+(Google+OR+AWS+OR+Amazon+OR+Meta+OR+Microsoft+OR+OpenAI+OR+Anthropic+OR+xAI+OR+Azure)+when:7d&hl=en-IE&gl=IE&ceid=IE:en') },

    // Big-tech hiring in Ireland (broad)
    { name: 'Ireland Big Tech Hiring', url: rss('https://news.google.com/rss/search?q=(Ireland+OR+Dublin)+(Google+OR+AWS+OR+Amazon+OR+Meta+OR+Microsoft+OR+OpenAI+OR+Anthropic+OR+xAI+OR+Azure)+("hiring"+OR+"job"+OR+"careers")+when:7d&hl=en-IE&gl=IE&ceid=IE:en') },

    // Company careers pages (via Google News index)
    { name: 'Google Careers Ireland', url: rss('https://news.google.com/rss/search?q=site:careers.google.com+(Dublin+OR+Ireland)+(software+OR+ai+OR+cloud)+when:14d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'AWS Jobs Ireland', url: rss('https://news.google.com/rss/search?q=site:amazon.jobs+(Dublin+OR+Ireland)+("AWS"+OR+"Amazon+Web+Services")+when:14d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Meta Careers Ireland', url: rss('https://news.google.com/rss/search?q=site:metacareers.com+(Dublin+OR+Ireland)+(engineering+OR+ai)+when:14d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Microsoft Careers Ireland', url: rss('https://news.google.com/rss/search?q=site:jobs.careers.microsoft.com+(Dublin+OR+Ireland)+(azure+OR+ai+OR+cloud)+when:14d&hl=en-IE&gl=IE&ceid=IE:en') },

    // Local boards as fallback signal
    { name: 'IrishJobs Tech', url: rss('https://news.google.com/rss/search?q=site:irishjobs.ie+technology+jobs+Ireland+when:7d&hl=en-IE&gl=IE&ceid=IE:en') },
  ],
};

// Ireland variant panels
export const PANELS: Record<string, PanelConfig> = {
  ieTech: { name: 'Irish Tech', enabled: true, priority: 1 },
  ieAcademic: { name: 'Academia', enabled: true, priority: 2 },
  ieSemiconductors: { name: 'Semiconductors', enabled: true, priority: 3 },
  ieDeals: { name: 'Tech M&A', enabled: true, priority: 4 },
  ieJobs: { name: 'Big Tech Jobs', enabled: true, priority: 5 },
  startups: { name: 'Startups', enabled: true, priority: 6 },
  ieSummits: { name: 'Summits', enabled: true, priority: 7 },
  ieBusiness: { name: 'Business', enabled: true, priority: 8 },
  ai: { name: 'AI/ML', enabled: true, priority: 9 },
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
  semiconductorHubs: true, // 半导体设施
  irelandDataCenters: true, // 爱尔兰数据中心
  irelandTechHQs: true, // EMEA 科技公司总部
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
