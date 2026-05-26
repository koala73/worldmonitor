import type { NewsItem } from '../types';

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

export function normalizeHeadlineKey(title: string): string {
  return decodeHtmlEntities(title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 2)
    .slice(0, 8)
    .join(' ');
}

function fallbackHeadlineKey(title: string): string {
  return decodeHtmlEntities(title).toLowerCase().trim().replace(/\s+/g, ' ');
}

export interface DedupedHeadline {
  item: NewsItem;
  extraSources: string[];
}

export type TierLookup = (item: NewsItem) => number;

export function dedupeHeadlines(
  items: NewsItem[],
  tierOf?: TierLookup,
): DedupedHeadline[] {
  const getTier: TierLookup = tierOf ?? ((it) => (typeof it.tier === 'number' ? it.tier : 4));
  const groups = new Map<string, NewsItem[]>();
  const order: string[] = [];
  for (const it of items) {
    let key = normalizeHeadlineKey(it.title);
    if (!key) key = fallbackHeadlineKey(it.title);
    if (!key) key = it.link || `__idx_${order.length}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(it);
    } else {
      groups.set(key, [it]);
      order.push(key);
    }
  }

  const out: DedupedHeadline[] = [];
  for (const key of order) {
    const group = groups.get(key);
    if (!group || group.length === 0) continue;
    const primary = [...group].sort((a, b) => {
      const ta = getTier(a);
      const tb = getTier(b);
      if (ta !== tb) return ta - tb;
      const da = a.pubDate instanceof Date ? a.pubDate.getTime() : new Date(a.pubDate).getTime();
      const db = b.pubDate instanceof Date ? b.pubDate.getTime() : new Date(b.pubDate).getTime();
      return (Number.isFinite(db) ? db : 0) - (Number.isFinite(da) ? da : 0);
    })[0]!;
    const extraSources: string[] = [];
    for (const other of group) {
      if (other === primary) continue;
      if (other.source && other.source !== primary.source && !extraSources.includes(other.source)) {
        extraSources.push(other.source);
      }
    }
    out.push({ item: primary, extraSources });
  }
  return out;
}
