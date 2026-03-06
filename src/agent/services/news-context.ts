/**
 * Real-time news context fetcher for Agent UI.
 * Uses GDELT DOC API v2 (CORS: *, no auth required).
 * Google News RSS is inaccessible in CN environment.
 */

const GDELT_API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const CACHE_TTL = 10 * 60 * 1000; // 10 min — avoid GDELT rate limiting
const cache = new Map<string, { text: string; ts: number }>();

const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','shall',
  'of','in','on','at','to','for','with','by','from','as','or','and','but',
  'not','no','nor','so','yet','both','either','neither','just','about',
  'what','how','when','where','who','why','which','that','this','these','those',
  'me','my','i','we','our','you','your','he','she','it','they','them','their',
  'tell','please','can','give','show','list','find','explain','describe',
  'latest','recent','current','news','today','now','new','update','report',
  '分析','介绍','告诉','什么','如何','最新','新闻','情况','请','帮',
]);

export function extractKeywords(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 5);
  return words.join(' ');
}

export interface SearchResult {
  title: string;
  snippet: string;
  source: string;
  age: string;
  url: string;
}

interface GdeltDocArticle {
  url: string;
  title: string;
  seendate: string;
  domain: string;
}

async function fetchGdeltResults(query: string, timespan = '24h'): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    query: `${query} sourcelang:eng`,
    mode: 'artlist',
    maxrecords: '8',
    timespan,
    format: 'json',
  });

  const resp = await fetch(`${GDELT_API}?${params}`, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) return [];

  const text = await resp.text();
  if (!text.startsWith('{')) return []; // rate limit message (plain text)

  const data = JSON.parse(text) as { articles?: GdeltDocArticle[] };
  const now = Date.now();

  return (data.articles || []).map(a => {
    const ts = parseGdeltDate(a.seendate);
    return {
      title: a.title,
      snippet: '',
      source: a.domain,
      age: ts ? relativeTime(now - ts) : '',
      url: a.url,
    };
  });
}

// ── Main export ──

export async function fetchNewsContext(userMessage: string): Promise<string | null> {
  const keywords = extractKeywords(userMessage);
  if (!keywords || keywords.split(' ').length < 1) return null;

  const cacheKey = keywords;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.text;

  // Try 24h first, fall back to 3d if no results
  let results = await fetchGdeltResults(keywords, '24h').catch(() => [] as SearchResult[]);
  if (results.length === 0) {
    results = await fetchGdeltResults(keywords, '3d').catch(() => [] as SearchResult[]);
  }

  if (results.length === 0) return null;

  const lines = results.slice(0, 8).map(r => {
    const age = r.age ? `[${r.age}] ` : '';
    const src = r.source ? ` (${r.source})` : '';
    return `• ${age}**${r.title}**${src}`;
  });

  const text = [
    `## 🔍 Real-Time News — ${new Date().toUTCString()}`,
    `Search: "${keywords}"  |  Source: GDELT Global News Index`,
    '',
    ...lines,
    '',
    'IMPORTANT: The above are real-time news articles published within the last 24–72 hours. Use them as your primary source for current events. Cite the source domain when referencing these results.',
  ].join('\n');

  cache.set(cacheKey, { text, ts: Date.now() });
  return text;
}

// ── Utilities ──

function parseGdeltDate(s: string): number | null {
  if (!s || s.length < 8) return null;
  try {
    const y = s.slice(0, 4), mo = s.slice(4, 6), d = s.slice(6, 8);
    const h = s.slice(9, 11) || '00', mi = s.slice(11, 13) || '00';
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:00Z`).getTime();
  } catch { return null; }
}

function relativeTime(ms: number): string {
  if (ms < 0) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
