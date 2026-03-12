import type { NormalizedStory } from '@/types/news-reader';
import type { NewsItem } from '@/types';
import { SOURCE_TIERS } from '@/ingestion/feeds';

// ── Stop words for keyword extraction & clean title ───────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
  'should', 'may', 'might', 'must', 'can', 'could', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'between', 'under',
  'again', 'further', 'then', 'once', 'and', 'but', 'or', 'nor', 'not',
  'so', 'yet', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
  'about', 'up', 'out', 'if', 'its', 'it', 'he', 'she', 'they', 'we',
  'you', 'i', 'me', 'my', 'his', 'her', 'our', 'their', 'this', 'that',
  'these', 'those', 'what', 'which', 'who', 'whom', 'when', 'where',
  'why', 'how', 'all', 'any', 'new', 'also', 'says', 'said', 'over',
]);

// ── HTML & text utilities ─────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, (entity) => {
    const el = document.createElement('textarea');
    el.innerHTML = entity;
    return el.value;
  });
}

function normalizeTitle(title: string): string {
  return stripHtml(title)
    .replace(/\s+/g, ' ')
    .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '')
    .trim();
}

function makeCleanTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w))
    .join(' ');
}

function extractKeywords(title: string): string[] {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  // Count frequencies
  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }

  // Return top-5 by frequency, then alphabetically
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([w]) => w);
}

// ── SHA-256 hash for story ID ─────────────────────────────────────────────

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Main normalization function ───────────────────────────────────────────

export async function normalizeNewsItem(
  item: NewsItem,
  feedRegion?: string,
  feedCategory?: string,
): Promise<NormalizedStory> {
  const title = normalizeTitle(item.title);
  const id = await sha256(`${item.source}::${item.link}`);

  return {
    id,
    title,
    cleanTitle: makeCleanTitle(title),
    source: item.source,
    sourceTier: SOURCE_TIERS[item.source] ?? 4,
    url: item.link,
    publishedAt: item.pubDate,
    ingestedAt: new Date(),
    region: feedRegion || 'Global',
    category: feedCategory || item.threat?.category || 'general',
    keywords: extractKeywords(title),
    threatLevel: item.threat?.level || 'info',
    clusterId: null,
    imageUrl: item.imageUrl || null,
    lang: item.lang || 'en',
  };
}

export async function normalizeBatch(
  items: NewsItem[],
  feedRegion?: string,
  feedCategory?: string,
): Promise<NormalizedStory[]> {
  return Promise.all(items.map(item => normalizeNewsItem(item, feedRegion, feedCategory)));
}
