import type { Feed } from '@/types';

// Helper to create RSS proxy URL (Vercel)
const rss = (url: string) => `/api/rss-proxy?url=${encodeURIComponent(url)}`;

// Railway proxy for feeds blocked by Vercel IPs
const wsRelayUrl = import.meta.env.VITE_WS_RELAY_URL || '';
const railwayBaseUrl = wsRelayUrl
  ? wsRelayUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '')
  : '';
const railwayRss = (url: string) =>
  railwayBaseUrl ? `${railwayBaseUrl}/rss?url=${encodeURIComponent(url)}` : rss(url);

// Source tier system for prioritization (lower = more authoritative)
// Tier 1: Wire services & Official sources - fastest, most reliable
// Tier 2: Major outlets - high-quality journalism
// Tier 3: Specialty sources - domain expertise
// Tier 4: Aggregators & blogs - useful but less authoritative
export const SOURCE_TIERS: Record<string, number> = {
  // Tier 1 - Wire Services & Official Sources
  'Reuters': 1,
  'Bloomberg': 1,
  'OpenAI': 1,
  'Anthropic': 1,
  'Google AI': 1,
  'DeepMind': 1,
  'Meta AI': 1,
  'SEC': 1,
  'Federal Reserve': 1,

  // Tier 2 - Major Tech Outlets
  'TechCrunch': 2,
  'The Verge': 2,
  'Ars Technica': 2,
  'CNBC Tech': 2,
  'Bloomberg Tech': 2,
  'Financial Times': 2,
  'WSJ Tech': 2,
  'Reuters Tech': 2,

  // Tier 3 - Specialty Tech/AI Publications
  'MIT Tech Review': 3,
  'VentureBeat AI': 3,
  'AI News': 3,
  'The Information': 3,
  'Protocol': 3,
  'Axios AI': 3,
  'Wired AI': 3,
  'IEEE Spectrum': 3,
  'ArXiv AI': 3,
  'Layoffs.fyi': 3,

  // Tier 4 - Aggregators & Community
  'Hacker News': 4,
  'Product Hunt': 4,
  'Reddit r/MachineLearning': 4,
  'Dev Community': 4,
};

export function getSourceTier(sourceName: string): number {
  return SOURCE_TIERS[sourceName] ?? 4;
}

export type SourceType = 'wire' | 'company' | 'tech-media' | 'research' | 'market' | 'community' | 'other';

export const SOURCE_TYPES: Record<string, SourceType> = {
  // Wire services
  'Reuters': 'wire',
  'Bloomberg': 'wire',

  // Tech companies & AI labs
  'OpenAI': 'company',
  'Anthropic': 'company',
  'Google AI': 'company',
  'DeepMind': 'company',
  'Meta AI': 'company',
  'Microsoft AI': 'company',

  // Tech media
  'TechCrunch': 'tech-media',
  'The Verge': 'tech-media',
  'Ars Technica': 'tech-media',
  'CNBC Tech': 'tech-media',
  'Bloomberg Tech': 'tech-media',
  'Wired AI': 'tech-media',
  'Protocol': 'tech-media',

  // Research & Academic
  'MIT Tech Review': 'research',
  'ArXiv AI': 'research',
  'IEEE Spectrum': 'research',
  'AI News': 'research',

  // Market/Finance
  'Financial Times': 'market',
  'WSJ Tech': 'market',
  'Reuters Tech': 'market',
  'SEC': 'market',
  'Federal Reserve': 'market',

  // Community
  'Hacker News': 'community',
  'Product Hunt': 'community',
  'Reddit r/MachineLearning': 'community',
};

export function getSourceType(sourceName: string): SourceType {
  return SOURCE_TYPES[sourceName] ?? 'other';
}

// Propaganda risk assessment - simplified for tech/AI focus (always returns low risk)
export interface SourceRiskProfile {
  risk: 'low' | 'medium' | 'high';
  stateAffiliated?: string;
  knownBiases?: string[];
  note?: string;
}

export function getSourcePropagandaRisk(sourceName: string): SourceRiskProfile {
  // For tech/AI sources, we don't need propaganda risk assessment
  // All sources are independent tech media
  return { risk: 'low' };
}

export const FEEDS: Record<string, Feed[]> = {
  // Core Tech News
  tech: [
    { name: 'TechCrunch', url: rss('https://techcrunch.com/feed/') },
    { name: 'The Verge', url: rss('https://www.theverge.com/rss/index.xml') },
    { name: 'Ars Technica', url: rss('https://feeds.arstechnica.com/arstechnica/technology-lab') },
    { name: 'Hacker News', url: rss('https://hnrss.org/frontpage') },
    { name: 'MIT Tech Review', url: rss('https://www.technologyreview.com/feed/') },
    { name: 'Wired', url: rss('https://www.wired.com/feed/rss') },
    { name: 'Engadget', url: rss('https://www.engadget.com/rss.xml') },
    { name: 'The Information', url: rss('https://www.theinformation.com/feed') },
  ],

  // AI & Machine Learning
  ai: [
    { name: 'AI News', url: rss('https://news.google.com/rss/search?q=(OpenAI+OR+Anthropic+OR+Google+AI+OR+"large+language+model"+OR+ChatGPT+OR+Claude+OR+"AI+model")+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'VentureBeat AI', url: rss('https://venturebeat.com/category/ai/feed/') },
    { name: 'The Verge AI', url: rss('https://www.theverge.com/rss/ai-artificial-intelligence/index.xml') },
    { name: 'MIT Tech Review AI', url: rss('https://www.technologyreview.com/topic/artificial-intelligence/feed') },
    { name: 'ArXiv AI', url: rss('https://export.arxiv.org/rss/cs.AI') },
    { name: 'ArXiv ML', url: rss('https://export.arxiv.org/rss/cs.LG') },
    { name: 'ArXiv NLP', url: rss('https://export.arxiv.org/rss/cs.CL') },
    { name: 'Wired AI', url: rss('https://www.wired.com/feed/tag/ai/latest/rss') },
    { name: 'OpenAI Blog', url: rss('https://openai.com/blog/rss.xml') },
    { name: 'Anthropic News', url: rss('https://news.google.com/rss/search?q=site:anthropic.com+OR+Anthropic+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Google AI Blog', url: rss('https://blog.google/technology/ai/rss/') },
    { name: 'DeepMind Blog', url: rss('https://deepmind.google/blog/rss.xml') },
  ],

  // Startups & Venture Capital
  startups: [
    { name: 'TechCrunch Startups', url: rss('https://techcrunch.com/category/startups/feed/') },
    { name: 'Product Hunt', url: rss('https://www.producthunt.com/feed') },
    { name: 'Startup News', url: rss('https://news.google.com/rss/search?q=(startup+OR+"Series+A"+OR+"Series+B"+OR+funding+OR+venture+capital+OR+YC)+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Y Combinator', url: rss('https://news.ycombinator.com/rss') },
    { name: 'TechCrunch Funding', url: rss('https://techcrunch.com/tag/funding/feed/') },
    { name: 'The Information Startups', url: rss('https://www.theinformation.com/startups/feed') },
  ],

  // Finance & Markets (Tech focus)
  finance: [
    { name: 'CNBC Tech', url: rss('https://www.cnbc.com/id/19854910/device/rss/rss.html') },
    { name: 'Bloomberg Tech', url: rss('https://feeds.bloomberg.com/technology/news.rss') },
    { name: 'Financial Times Tech', url: rss('https://www.ft.com/technology?format=rss') },
    { name: 'WSJ Tech', url: rss('https://feeds.a.dj.com/rss/RSSWSJD.xml') },
    { name: 'Reuters Tech', url: rss('https://news.google.com/rss/search?q=site:reuters.com+technology+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'MarketWatch Tech', url: rss('https://feeds.marketwatch.com/marketwatch/technology') },
    { name: 'Yahoo Finance Tech', url: rss('https://finance.yahoo.com/news/rssindex') },
  ],

  // Tech Layoffs & Industry News
  layoffs: [
    { name: 'Layoffs.fyi', url: rss('https://layoffs.fyi/feed/') },
    { name: 'TechCrunch Layoffs', url: rss('https://techcrunch.com/tag/layoffs/feed/') },
    { name: 'Layoffs News', url: rss('https://news.google.com/rss/search?q=(tech+layoffs+OR+"job+cuts"+OR+"workforce+reduction")+when:2d&hl=en-US&gl=US&ceid=US:en') },
  ],

  // Cybersecurity & Safety
  security: [
    { name: 'Krebs on Security', url: rss('https://krebsonsecurity.com/feed/') },
    { name: 'The Hacker News', url: rss('https://feeds.feedburner.com/TheHackersNews') },
    { name: 'Bleeping Computer', url: rss('https://www.bleepingcomputer.com/feed/') },
    { name: 'Dark Reading', url: rss('https://www.darkreading.com/rss.xml') },
    { name: 'Security Week', url: rss('https://www.securityweek.com/feed/') },
    { name: 'CISA Alerts', url: railwayRss('https://www.cisa.gov/cybersecurity-advisories/all.xml') },
  ],

  // AI Policy & Regulation
  policy: [
    { name: 'AI Regulation', url: rss('https://news.google.com/rss/search?q=("AI+regulation"+OR+"AI+Act"+OR+"AI+policy"+OR+"AI+safety"+OR+"AI+governance")+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Tech Policy', url: rss('https://news.google.com/rss/search?q=(FTC+OR+"antitrust"+OR+"tech+regulation"+OR+"data+privacy")+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'SEC Tech', url: rss('https://www.sec.gov/news/pressreleases.rss') },
    { name: 'Federal Reserve', url: rss('https://www.federalreserve.gov/feeds/press_all.xml') },
  ],

  // Developer Community
  dev: [
    { name: 'GitHub Blog', url: rss('https://github.blog/feed/') },
    { name: 'Stack Overflow Blog', url: rss('https://stackoverflow.blog/feed/') },
    { name: 'Dev.to', url: rss('https://dev.to/feed') },
    { name: 'Hashnode', url: rss('https://hashnode.com/rss') },
    { name: 'CSS-Tricks', url: rss('https://css-tricks.com/feed/') },
  ],

  // Semiconductor & Hardware
  hardware: [
    { name: 'NVIDIA News', url: rss('https://news.google.com/rss/search?q=NVIDIA+OR+"AI+chips"+OR+"GPU"+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Semiconductor News', url: rss('https://news.google.com/rss/search?q=(semiconductor+OR+TSMC+OR+Intel+OR+AMD+OR+chip)+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'AnandTech', url: rss('https://www.anandtech.com/rss/') },
    { name: 'Tom\'s Hardware', url: rss('https://www.tomshardware.com/feeds/all') },
  ],

  // Cloud & Infrastructure
  cloud: [
    { name: 'AWS News', url: rss('https://aws.amazon.com/blogs/aws/feed/') },
    { name: 'Azure Updates', url: rss('https://azurecomcdn.azureedge.net/en-us/updates/feed/') },
    { name: 'Google Cloud Blog', url: rss('https://cloudblog.withgoogle.com/rss/') },
    { name: 'Cloud News', url: rss('https://news.google.com/rss/search?q=(AWS+OR+Azure+OR+"Google+Cloud"+OR+cloud+computing)+when:2d&hl=en-US&gl=US&ceid=US:en') },
  ],
};

// Alert keywords for tech/AI events
export const ALERT_KEYWORDS = [
  // AI milestones
  'breakthrough', 'agi', 'superintelligence', 'new model', 'gpt-5', 'claude 4',

  // Company events
  'acquisition', 'merger', 'ipo', 'funding', 'shutdown', 'bankruptcy',
  'layoffs', 'hiring freeze', 'ceo', 'resignation',

  // Security
  'breach', 'hack', 'vulnerability', 'zero-day', 'ransomware', 'exploit',
  'data leak', 'security flaw',

  // Regulatory
  'regulation', 'antitrust', 'lawsuit', 'investigation', 'fine', 'ban',
  'executive order', 'legislation',

  // Market
  'crash', 'rally', 'record high', 'record low', 'volatility',

  // Tech events
  'outage', 'downtime', 'service disruption', 'breaking', 'urgent',
  'emergency patch', 'recall',
];

// Major tech companies to track (company names for filtering/matching)
export const TECH_COMPANY_NAMES = [
  'OpenAI', 'Anthropic', 'Google', 'Microsoft', 'Meta', 'Apple', 'Amazon',
  'NVIDIA', 'AMD', 'Intel', 'Tesla', 'SpaceX', 'Salesforce', 'Oracle',
  'IBM', 'SAP', 'Adobe', 'Shopify', 'Stripe', 'Databricks', 'Snowflake',
  'Palantir', 'Unity', 'Roblox', 'Spotify', 'Netflix', 'Uber', 'Airbnb',
];
