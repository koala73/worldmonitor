import type { NewsItem } from '../types';

export function normalizeHeadlineKey(title: string): string {
  return title
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

export interface DedupedHeadline {
  item: NewsItem;
  extraSources: string[];
}

export function dedupeHeadlines(items: NewsItem[]): DedupedHeadline[] {
  const byKey = new Map<string, DedupedHeadline>();
  for (const it of items) {
    const key = normalizeHeadlineKey(it.title);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { item: it, extraSources: [] });
      continue;
    }
    if (it.source && it.source !== existing.item.source && !existing.extraSources.includes(it.source)) {
      existing.extraSources.push(it.source);
    }
  }
  return [...byKey.values()];
}
