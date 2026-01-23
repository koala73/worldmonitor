import type { PredictionMarket } from '@/types';
import { createCircuitBreaker } from '@/utils';
import { SITE_VARIANT } from '@/config';

interface PolymarketMarket {
  question: string;
  outcomes?: string[];
  outcomePrices?: string;
  volume?: string;
  volumeNum?: number;
  closed?: boolean;
  tags?: Array<{ slug: string }>;
}

const breaker = createCircuitBreaker<PredictionMarket[]>({ name: 'Polymarket' });

// Tech/AI/Startup keywords for tech variant
const TECH_KEYWORDS = [
  // AI & ML
  'ai', 'artificial intelligence', 'openai', 'chatgpt', 'gpt', 'claude', 'anthropic', 'google ai', 'gemini',
  'machine learning', 'neural', 'llm', 'agi', 'deepmind', 'midjourney', 'stable diffusion', 'copilot',
  // Tech Companies
  'apple', 'google', 'microsoft', 'amazon', 'meta', 'facebook', 'nvidia', 'tesla', 'spacex',
  'twitter', 'x.com', 'tiktok', 'bytedance', 'alibaba', 'tencent', 'samsung', 'intel', 'amd', 'tsmc',
  // Startups & VC
  'startup', 'ipo', 'unicorn', 'valuation', 'funding', 'series a', 'series b', 'y combinator', 'vc',
  'venture capital', 'acquisition', 'merger', 'layoff', 'layoffs',
  // Tech Topics
  'crypto', 'bitcoin', 'ethereum', 'blockchain', 'web3', 'nft',
  'autonomous', 'self-driving', 'robotics', 'drone', 'ev', 'electric vehicle',
  'quantum', 'chip', 'semiconductor', 'gpu', 'processor',
  'cybersecurity', 'hack', 'breach', 'ransomware',
  'social media', 'app store', 'cloud', 'saas', 'software',
  // Tech Regulation
  'antitrust', 'ftc', 'eu commission', 'tech regulation', 'data privacy', 'gdpr',
  // Tech Leaders
  'elon musk', 'sam altman', 'mark zuckerberg', 'sundar pichai', 'satya nadella', 'tim cook', 'jensen huang',
];

// Geopolitical keywords for filtering relevant markets
const GEOPOLITICAL_KEYWORDS = [
  // Conflicts & Military
  'war', 'military', 'invasion', 'attack', 'strike', 'troops', 'nato', 'nuclear',
  'missile', 'drone', 'ceasefire', 'peace', 'conflict', 'terrorist', 'hamas', 'hezbollah',
  // Countries & Leaders
  'russia', 'ukraine', 'china', 'taiwan', 'iran', 'israel', 'gaza', 'palestine',
  'north korea', 'syria', 'putin', 'zelensky', 'xi jinping', 'netanyahu', 'kim jong',
  // Politics & Elections
  'president', 'election', 'elections', 'congress', 'senate', 'parliament', 'government', 'minister',
  'trump', 'biden', 'administration', 'democrat', 'republican', 'vote', 'impeach',
  // Economics & Trade
  'fed', 'interest rate', 'interest rates', 'inflation', 'recession', 'gdp', 'tariff', 'tariffs', 'sanction', 'sanctions',
  'oil', 'opec', 'economy', 'trade war', 'currency', 'debt', 'default',
  // Global Issues
  'climate', 'pandemic', 'who', 'un ', 'united nations', 'eu ', 'european union',
  'summit', 'treaty', 'alliance', 'coup', 'protest', 'protests', 'uprising', 'refugee', 'refugees',
];

// Sports/Entertainment to exclude
const EXCLUDE_KEYWORDS = [
  'nba', 'nfl', 'mlb', 'nhl', 'fifa', 'world cup', 'super bowl', 'championship',
  'playoffs', 'oscar', 'grammy', 'emmy', 'box office', 'movie', 'album', 'song',
  'tiktok', 'youtube', 'streamer', 'influencer', 'celebrity', 'kardashian',
  'bachelor', 'reality tv', 'mvp', 'touchdown', 'home run', 'goal scorer',
  // Awards / film / music / TV
  'academy award', 'academy awards', 'oscars', 'bafta', 'golden globe', 'cannes', 'sundance', 'tony',
  'documentary', 'feature film', 'film', 'filmmaker', 'tv', 'series', 'season', 'episode',
  'actor', 'actress', 'director', 'album', 'song', 'soundtrack',
];

// Tag slugs from Polymarket that clearly indicate non-geopolitical categories
const EXCLUDE_TAGS = [
  'entertainment', 'sports', 'culture', 'film', 'movie', 'music', 'awards', 'tv', 'celebrity'
];

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsKeyword(normalized: string, keyword: string): boolean {
  const kw = normalizeText(keyword);
  if (!kw) return false;
  if (kw.includes(' ')) {
    const padded = ` ${normalized} `;
    const phrase = ` ${kw} `;
    return padded.includes(phrase);
  }
  const re = new RegExp(`\\b${escapeRegExp(kw)}(s|es)?\\b`, 'i');
  return re.test(normalized);
}

function tagsAreExcluded(tags: Array<{ slug: string }> | undefined): boolean {
  if (!tags || tags.length === 0) return false;
  return tags.some(tag => {
    const tagNorm = normalizeText(tag.slug.replace(/-/g, ' '));
    return EXCLUDE_TAGS.some(ex => containsKeyword(tagNorm, ex) || tagNorm.includes(normalizeText(ex)));
  });
}

function isRelevant(title: string, tags?: Array<{ slug: string }>): boolean {
  const normalized = normalizeText(title);
  if (!normalized) return false;

  if (tagsAreExcluded(tags)) return false;

  // Exclude sports/entertainment
  if (EXCLUDE_KEYWORDS.some(kw => containsKeyword(normalized, kw))) {
    return false;
  }

  // Use variant-specific keywords
  const keywords = SITE_VARIANT === 'tech' ? TECH_KEYWORDS : GEOPOLITICAL_KEYWORDS;
  return keywords.some(kw => containsKeyword(normalized, kw));
}

export async function fetchPredictions(): Promise<PredictionMarket[]> {
  return breaker.execute(async () => {
    const response = await fetch('/api/polymarket?closed=false&order=volume&ascending=false&limit=100');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: PolymarketMarket[] = await response.json();

    const parsed = data
      .map((market) => {
        let yesPrice = 50;
        try {
          const pricesStr = market.outcomePrices;
          if (pricesStr) {
            const prices: string[] = JSON.parse(pricesStr);
            if (Array.isArray(prices) && prices.length >= 1 && prices[0]) {
              const parsed = parseFloat(prices[0]);
              if (!isNaN(parsed)) yesPrice = parsed * 100;
            }
          }
        } catch { /* Keep default */ }

        const volume = market.volumeNum ?? (market.volume ? parseFloat(market.volume) : 0);
        return {
          title: market.question || '',
          yesPrice,
          volume,
          tags: market.tags || [],
        };
      });

    return parsed
      .filter((p) => {
        if (!p.title || isNaN(p.yesPrice)) return false;

        // Must be relevant to variant (tech or geopolitical)
        if (!isRelevant(p.title, p.tags)) return false;

        // Must have meaningful signal (not 50/50) or high volume
        const discrepancy = Math.abs(p.yesPrice - 50);
        return discrepancy > 5 || (p.volume && p.volume > 50000);
      })
      .map((p) => ({
        title: p.title,
        yesPrice: p.yesPrice,
        volume: p.volume,
      }))
      .slice(0, 15);
  }, []);
}

export function getPolymarketStatus(): string {
  return breaker.getStatus();
}
