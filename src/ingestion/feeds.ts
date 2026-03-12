// Simplified feeds config for AI News Reader
// Adapted from src/config/feeds.ts — kept SOURCE_TIERS + representative feed set

import type { Feed } from '@/types';

// Source tier system for prioritization (lower = more authoritative)
// Tier 1: Wire services — fastest, most reliable breaking news
// Tier 2: Major outlets — high-quality journalism
// Tier 3: Specialty sources — domain expertise
// Tier 4: Aggregators & blogs — useful but less authoritative
export const SOURCE_TIERS: Record<string, number> = {
  // Tier 1 - Wire Services
  'Reuters': 1, 'Reuters World': 1, 'Reuters US': 1, 'Reuters Asia': 1,
  'Reuters LatAm': 1, 'Reuters Business': 1, 'Reuters Energy': 1,
  'Reuters Markets': 1, 'Reuters Commodities': 1,
  'AP News': 1, 'AP Mexico': 1, 'AFP': 1,
  'UPI': 1, 'Xinhua': 1, 'TASS': 1, 'Yonhap News': 1,

  // Tier 2 - Major Outlets
  'BBC World': 2, 'BBC Middle East': 2, 'BBC Asia': 2, 'BBC Africa': 2,
  'BBC Latin America': 2, 'BBC Russian': 2, 'BBC Mundo': 2, 'BBC Persian': 2,
  'BBC Turkce': 2, 'BBC Afrique': 2,
  'CNN World': 2, 'NPR News': 2, 'PBS NewsHour': 2,
  'Al Jazeera': 2, 'Al Arabiya': 2, 'France 24': 2,
  'Guardian World': 2, 'Guardian ME': 2, 'Guardian Americas': 2, 'Guardian Australia': 2,
  'DW News': 2, 'EuroNews': 2, 'Le Monde': 2,
  'Washington Post': 2, 'Wall Street Journal': 2, 'New York Times': 2,
  'Financial Times': 2, 'The Economist': 2, 'Bloomberg': 2,
  'ABC News': 2, 'CBS News': 2, 'NBC News': 2,
  'Politico': 2, 'The Hill': 2, 'Axios': 2,
  'CNBC': 2, 'South China Morning Post': 2, 'Nikkei Asia': 2,

  // Tier 2 - Major Regional
  'Haaretz': 2, 'Kyiv Independent': 2, 'Moscow Times': 2,
  'Der Spiegel': 2, 'Die Zeit': 2, 'El País': 2, 'ANSA': 2,
  'The Hindu': 2, 'Indian Express': 2, 'CNA': 2,
  'News24': 2, 'Meduza': 2,

  // Tier 2 - Defense & Intel
  'Defense One': 2, 'Breaking Defense': 2, 'The War Zone': 2,
  'Defense News': 2, 'USNI News': 2, 'Military Times': 2,
  'Bellingcat': 2, 'Janes': 2,

  // Tier 3 - Specialty
  'Hacker News': 3, 'Ars Technica': 3, 'The Verge': 3,
  'MIT Tech Review': 3, 'TechCrunch': 3,
  'CoinDesk': 3, 'The Diplomat': 3,
  'Foreign Policy': 3, 'Foreign Affairs': 3, 'Atlantic Council': 3,
  'Krebs Security': 3, 'The Hacker News': 3,
  'CrisisWatch': 3, 'IAEA': 3, 'WHO': 3,
  'VentureBeat AI': 3, 'ArXiv AI': 3,
  'Kitco News': 3, 'OilPrice.com': 3,

  // Tier 3 - Government
  'White House': 3, 'State Dept': 3, 'Pentagon': 3,
  'Treasury': 3, 'DOJ': 3, 'Federal Reserve': 3,
  'SEC': 3, 'CDC': 3, 'FEMA': 3, 'DHS': 3,
  'CISA': 3, 'UN News': 3,

  // Tier 3 - Think Tanks
  'CSIS': 3, 'RAND': 3, 'Brookings': 3, 'Carnegie': 3,
  'War on the Rocks': 3, 'AEI': 3,

  // Tier 4 - Aggregators & Blogs
  'AI News': 4, 'MarketWatch': 4, 'Yahoo Finance': 4,
  'Seeking Alpha': 4, 'InSight Crime': 4,
  'Layoffs.fyi': 4, 'TechCrunch Layoffs': 4,
};

export function getSourceTier(name: string): number {
  return SOURCE_TIERS[name] ?? 4;
}

// Feed categories for the news reader
export const READER_FEEDS: Record<string, Feed[]> = {
  world: [
    { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
    { name: 'Guardian World', url: 'https://www.theguardian.com/world/rss' },
    { name: 'AP News', url: 'https://news.google.com/rss/search?q=site:apnews.com+when:1d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Reuters World', url: 'https://news.google.com/rss/search?q=site:reuters.com+world+when:1d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'CNN World', url: 'https://rss.cnn.com/rss/edition_world.rss' },
    { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
    { name: 'France 24', url: 'https://www.france24.com/en/rss' },
    { name: 'DW News', url: 'https://rss.dw.com/xml/rss-en-all' },
  ],
  us: [
    { name: 'Reuters US', url: 'https://news.google.com/rss/search?q=site:reuters.com+US+politics+when:1d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml' },
    { name: 'PBS NewsHour', url: 'https://www.pbs.org/newshour/feeds/rss/headlines' },
    { name: 'ABC News', url: 'https://abcnews.go.com/abcnews/topstories' },
    { name: 'Politico', url: 'https://rss.politico.com/politics-news.xml' },
    { name: 'The Hill', url: 'https://thehill.com/feed/' },
  ],
  tech: [
    { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
    { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab' },
    { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
    { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/feed/' },
    { name: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
  ],
  ai: [
    { name: 'AI News', url: 'https://news.google.com/rss/search?q=(OpenAI+OR+Anthropic+OR+Google+AI+OR+"large+language+model"+OR+ChatGPT)+when:2d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/' },
    { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
    { name: 'ArXiv AI', url: 'https://export.arxiv.org/rss/cs.AI' },
  ],
  finance: [
    { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
    { name: 'MarketWatch', url: 'https://news.google.com/rss/search?q=site:marketwatch.com+markets+when:1d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex' },
    { name: 'Financial Times', url: 'https://www.ft.com/rss/home' },
    { name: 'Reuters Business', url: 'https://news.google.com/rss/search?q=site:reuters.com+business+markets&hl=en-US&gl=US&ceid=US:en' },
  ],
  security: [
    { name: 'Krebs Security', url: 'https://krebsonsecurity.com/feed/' },
    { name: 'The Hacker News', url: 'https://feeds.feedburner.com/TheHackersNews' },
    { name: 'Dark Reading', url: 'https://www.darkreading.com/rss.xml' },
  ],
  science: [
    { name: 'Nature News', url: 'https://feeds.nature.com/nature/rss/current' },
    { name: 'ScienceDaily', url: 'https://www.sciencedaily.com/rss/all.xml' },
    { name: 'Live Science', url: 'https://www.livescience.com/feeds.xml' },
  ],
  crisis: [
    { name: 'CrisisWatch', url: 'https://www.crisisgroup.org/rss' },
    { name: 'IAEA', url: 'https://www.iaea.org/feeds/topnews' },
    { name: 'WHO', url: 'https://www.who.int/rss-feeds/news-english.xml' },
    { name: 'UN News', url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml' },
  ],
};

export function getAllFeeds(): Feed[] {
  return Object.values(READER_FEEDS).flat();
}

export function getFeedsByCategory(category: string): Feed[] {
  return READER_FEEDS[category] ?? [];
}

export function getCategories(): string[] {
  return Object.keys(READER_FEEDS);
}
