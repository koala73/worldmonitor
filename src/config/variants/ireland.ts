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
  // 爱尔兰科技新闻 (含 AI Companies: OpenAI, Anthropic, xAI, DeepMind)
  ieTech: [
    { name: 'Silicon Republic', url: rss('https://www.siliconrepublic.com/feed') },
    { name: 'Tech Central', url: rss('https://www.techcentral.ie/feed/') },
    { name: 'Business Plus', url: rss('https://businessplus.ie/feed/') },
    { name: 'Irish Tech News', url: rss('https://irishtechnews.ie/feed/') },
    // AI Companies in Ireland (FR #178)
    { name: 'OpenAI Ireland', url: rss('https://news.google.com/rss/search?q=OpenAI+(Ireland+OR+Dublin)+when:14d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Anthropic Ireland', url: rss('https://news.google.com/rss/search?q=Anthropic+(Ireland+OR+Dublin)+when:14d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'xAI Ireland', url: rss('https://news.google.com/rss/search?q=xAI+(Ireland+OR+Dublin)+when:14d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'DeepMind Ireland', url: rss('https://news.google.com/rss/search?q=(DeepMind+OR+"Google+DeepMind")+(Ireland+OR+Dublin)+when:14d&hl=en-IE&gl=IE&ceid=IE:en') },
  ],

  // 爱尔兰学术机构（通过 Google News）
  // 爱尔兰学术机构新闻（9所大学 + 研究机构）
  ieAcademic: [
    // Dublin Universities
    { 
      name: 'TCD News', 
      url: rss('https://news.google.com/rss/search?q=site:tcd.ie+when:7d&hl=en-IE&gl=IE&ceid=IE:en') 
    },
    { 
      name: 'UCD News', 
      url: rss('https://news.google.com/rss/search?q=site:ucd.ie+when:7d&hl=en-IE&gl=IE&ceid=IE:en') 
    },
    { 
      name: 'DCU News', 
      url: rss('https://news.google.com/rss/search?q=site:dcu.ie+when:7d&hl=en-IE&gl=IE&ceid=IE:en') 
    },
    { 
      name: 'TU Dublin News', 
      url: rss('https://news.google.com/rss/search?q=site:tudublin.ie+when:7d&hl=en-IE&gl=IE&ceid=IE:en') 
    },
    { 
      name: 'RCSI News', 
      url: rss('https://news.google.com/rss/search?q=site:rcsi.com+when:7d&hl=en-IE&gl=IE&ceid=IE:en') 
    },

    // Regional Universities
    { 
      name: 'Maynooth University News', 
      url: rss('https://news.google.com/rss/search?q=site:maynoothuniversity.ie+when:7d&hl=en-IE&gl=IE&ceid=IE:en') 
    },
    { 
      name: 'UCC News', 
      url: rss('https://news.google.com/rss/search?q=site:ucc.ie+when:7d&hl=en-IE&gl=IE&ceid=IE:en') 
    },
    { 
      name: 'University of Galway News', 
      url: rss('https://news.google.com/rss/search?q=site:universityofgalway.ie+when:7d&hl=en-IE&gl=IE&ceid=IE:en') 
    },
    { 
      name: 'UL News', 
      url: rss('https://news.google.com/rss/search?q=site:ul.ie+when:7d&hl=en-IE&gl=IE&ceid=IE:en') 
    },

    // Research Institutions
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

  // 欧洲创业生态 (含 Startup Hubs & Accelerators: NDRC, Dogpatch, YC, Techstars)
  startups: [
    { name: 'EU Startups', url: rss('https://www.eu-startups.com/feed/') },
    { name: 'Tech.eu', url: rss('https://tech.eu/feed/') },
    { name: 'Sifted (Europe)', url: rss('https://sifted.eu/feed') },
    { name: 'TechCrunch Startups', url: rss('https://techcrunch.com/category/startups/feed/') },
    // Irish Accelerators & Startup Hubs (FR #178)
    { name: 'NDRC Ireland', url: rss('https://news.google.com/rss/search?q=NDRC+(Ireland+OR+Dublin+OR+startup)+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Dogpatch Labs', url: rss('https://news.google.com/rss/search?q="Dogpatch+Labs"+(Dublin+OR+startup)+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Y Combinator Ireland', url: rss('https://news.google.com/rss/search?q="Y+Combinator"+(Ireland+OR+Irish+OR+Dublin)+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Techstars Dublin', url: rss('https://news.google.com/rss/search?q=Techstars+(Ireland+OR+Dublin)+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Enterprise Ireland Startups', url: rss('https://news.google.com/rss/search?q="Enterprise+Ireland"+(startup+OR+accelerator+OR+"high+potential")+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Dublin Startup Ecosystem', url: rss('https://news.google.com/rss/search?q=(Dublin+OR+Ireland)+(startup+ecosystem+OR+"startup+hub"+OR+"Demo+Day")+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
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
    // Enterprise software M&A and earnings
    { name: 'Enterprise Tech M&A', url: rss('https://news.google.com/rss/search?q=(Datadog+OR+Dynatrace+OR+ServiceNow+OR+Workday+OR+SAP+OR+Oracle+OR+Bloomberg)+(acquisition+OR+merger+OR+earnings+OR+"quarterly+results")+when:14d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Splunk Cisco Integration', url: rss('https://news.google.com/rss/search?q=Splunk+Cisco+(acquisition+OR+integration+OR+merger)+when:30d&hl=en-US&gl=US&ceid=US:en') },
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

    // Enterprise software companies hiring in Ireland
    { name: 'Enterprise Tech Jobs Ireland', url: rss('https://news.google.com/rss/search?q=(Ireland+OR+Dublin+OR+Galway)+(Datadog+OR+Dynatrace+OR+ServiceNow+OR+Workday+OR+SAP+OR+Oracle+OR+Bloomberg+OR+Splunk)+(hiring+OR+jobs+OR+careers)+when:14d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'ServiceNow Dublin Jobs', url: rss('https://news.google.com/rss/search?q=ServiceNow+Dublin+(hiring+OR+jobs+OR+"Centre+of+Excellence")+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
  ],

  // 企业软件公司爱尔兰新闻
  ieEnterpriseTech: [
    // Monitoring & Observability companies in Ireland
    { name: 'Datadog Ireland', url: rss('https://news.google.com/rss/search?q=Datadog+(Ireland+OR+Dublin)+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Dynatrace Ireland', url: rss('https://news.google.com/rss/search?q=Dynatrace+(Ireland+OR+Dublin)+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Splunk Ireland', url: rss('https://news.google.com/rss/search?q=Splunk+(Ireland+OR+Galway)+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },

    // Enterprise software companies in Ireland
    { name: 'ServiceNow Ireland', url: rss('https://news.google.com/rss/search?q=ServiceNow+(Ireland+OR+Dublin)+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Workday Ireland', url: rss('https://news.google.com/rss/search?q=Workday+(Ireland+OR+Dublin)+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'SAP Ireland', url: rss('https://news.google.com/rss/search?q=SAP+(Ireland+OR+Dublin)+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Oracle Ireland', url: rss('https://news.google.com/rss/search?q=Oracle+(Ireland+OR+Dublin)+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },

    // Financial data
    { name: 'Bloomberg Ireland', url: rss('https://news.google.com/rss/search?q=Bloomberg+(Ireland+OR+Dublin)+office+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
  ],

  // 基础设施新闻：数据中心 + 海底光缆 (FR #178)
  ieInfrastructure: [
    // Data Center News
    { name: 'Data Center Ireland', url: rss('https://news.google.com/rss/search?q=("data+center"+OR+"data+centre")+(Ireland+OR+Dublin)+when:14d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Google Data Center Ireland', url: rss('https://news.google.com/rss/search?q=Google+("data+center"+OR+"data+centre")+(Ireland+OR+Dublin)+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Microsoft Azure Ireland', url: rss('https://news.google.com/rss/search?q=(Microsoft+OR+Azure)+("data+center"+OR+"data+centre")+(Ireland+OR+Dublin)+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'AWS Data Center Ireland', url: rss('https://news.google.com/rss/search?q=(AWS+OR+"Amazon+Web+Services")+("data+center"+OR+"data+centre")+(Ireland+OR+Dublin)+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Meta Data Center Ireland', url: rss('https://news.google.com/rss/search?q=(Meta+OR+Facebook)+("data+center"+OR+"data+centre")+(Ireland+OR+Clonee)+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Equinix Ireland', url: rss('https://news.google.com/rss/search?q=Equinix+(Ireland+OR+Dublin)+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },

    // Submarine Cable News
    { name: 'Submarine Cable Ireland', url: rss('https://news.google.com/rss/search?q=("submarine+cable"+OR+"undersea+cable")+(Ireland+OR+Dublin+OR+Galway)+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Hibernia Express', url: rss('https://news.google.com/rss/search?q="Hibernia+Express"+(cable+OR+Ireland)+when:90d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'AEC-1 Cable', url: rss('https://news.google.com/rss/search?q="AEC-1"+(cable+OR+Ireland+OR+transatlantic)+when:90d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'IRIS Cable Iceland', url: rss('https://news.google.com/rss/search?q=("IRIS+cable"+OR+"Ireland+Iceland+cable")+when:90d&hl=en-IE&gl=IE&ceid=IE:en') },
    { name: 'Cable Landing Station Ireland', url: rss('https://news.google.com/rss/search?q="cable+landing"+(Ireland+OR+Dublin+OR+Galway)+when:90d&hl=en-IE&gl=IE&ceid=IE:en') },

    // Infrastructure Investment
    { name: 'Data Center Investment Ireland', url: rss('https://news.google.com/rss/search?q=("data+center"+OR+"data+centre")+(investment+OR+construction+OR+expansion)+(Ireland+OR+Dublin)+when:30d&hl=en-IE&gl=IE&ceid=IE:en') },
  ],
};

// Ireland variant panels
export const PANELS: Record<string, PanelConfig> = {
  ieTech: { name: 'Irish Tech', enabled: true, priority: 1 },
  ieAcademic: { name: 'Academia', enabled: true, priority: 2 },
  ieSemiconductors: { name: 'Semiconductors', enabled: true, priority: 3 },
  ieDeals: { name: 'Tech M&A', enabled: true, priority: 4 },
  ieJobs: { name: 'Big Tech Jobs', enabled: true, priority: 5 },
  ieEnterpriseTech: { name: 'Enterprise Tech', enabled: true, priority: 6 },
  startups: { name: 'Startups', enabled: true, priority: 7 },
  ieSummits: { name: 'Summits', enabled: true, priority: 8 },
  ieInfrastructure: { name: 'Infrastructure', enabled: true, priority: 9 }, // FR #178: Data Centers + Submarine Cables
  ieBusiness: { name: 'Business', enabled: true, priority: 10 },
  ai: { name: 'AI/ML', enabled: true, priority: 11 },
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
  cloudRegions: false, // 禁用 - 与 Data Centers 重复，用户更关心物理位置 (FR #170)
  accelerators: true, // 加速器
  techHQs: true,      // 科技公司总部
  techEvents: true,   // 科技活动
  semiconductorHubs: true, // 半导体设施
  irelandDataCenters: true, // 爱尔兰数据中心
  irelandTechHQs: true, // EMEA 科技公司总部
  irishUnicorns: true, // 爱尔兰本土独角兽
  irelandAICompanies: true, // AI 公司 (Anthropic, OpenAI, xAI)
  irelandUniversities: true, // 大学 (TCD, UCD, DCU, etc.)
  submarineCables: true, // 海底光缆 (FR #174)
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

  // Brand configuration
  brand: {
    displayName: 'IrishTech Daily',
    logoText: 'IRISHTECH',
    headerText: 'IRISHTECH DAILY',
  },

  // Map configuration
  map: {
    center: IRELAND_CENTER,
    defaultZoom: IRELAND_DEFAULT_ZOOM,
    minZoom: IRELAND_MIN_ZOOM,
    bounds: IRELAND_BOUNDS,
  },

  // Feature flags
  features: {
    irelandRelevanceFilter: true,
    disableCountryOverlay: true,
    expandedAttribution: true,
  },
};
