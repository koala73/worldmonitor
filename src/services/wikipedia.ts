// Wikipedia REST API — no key, CORS-friendly, called directly from the browser.
// https://en.wikipedia.org/api/rest_v1/page/summary/{title}

export interface WikiSummary {
  title: string;
  displayTitle: string;
  extract: string;
  thumbnail?: { source: string; width: number; height: number };
  pageUrl: string;
}

const cache = new Map<string, { data: WikiSummary; ts: number }>();
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export async function fetchWikiSummary(title: string): Promise<WikiSummary | null> {
  if (!title) return null;
  const key = title.toLowerCase().trim();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;
  try {
    const encoded = encodeURIComponent(title.replace(/ /g, '_'));
    const res = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const d = await res.json();
    if (d.type === 'disambiguation') return null;
    const summary: WikiSummary = {
      title: d.title ?? title,
      displayTitle: d.displaytitle ?? d.title ?? title,
      extract: d.extract ?? '',
      thumbnail: d.thumbnail ? {
        source: d.thumbnail.source,
        width: d.thumbnail.width,
        height: d.thumbnail.height,
      } : undefined,
      pageUrl: d.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encoded}`,
    };
    cache.set(key, { data: summary, ts: Date.now() });
    return summary;
  } catch {
    return null;
  }
}
