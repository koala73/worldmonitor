import type { Feed } from '@/types';
import { FEEDS } from '@/config/feeds';
import { STORAGE_KEYS } from '@/config/variants/base';

export interface CustomFeedEntry {
  id: string;
  name: string;
  url: string;
  category: string;
}

const MAX_CUSTOM_FEEDS = 20;

export function loadCustomFeeds(): CustomFeedEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.customFeeds);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as CustomFeedEntry[];
  } catch {
    return [];
  }
}

export function saveCustomFeeds(feeds: CustomFeedEntry[]): void {
  localStorage.setItem(STORAGE_KEYS.customFeeds, JSON.stringify(feeds));
}

export function addCustomFeed(entry: Omit<CustomFeedEntry, 'id'>): CustomFeedEntry {
  const feeds = loadCustomFeeds();

  if (feeds.length >= MAX_CUSTOM_FEEDS) {
    throw new Error(`Maximum of ${MAX_CUSTOM_FEEDS} custom feeds reached`);
  }

  // Check duplicate URL among custom feeds
  if (feeds.some(f => f.url === entry.url)) {
    throw new Error('This feed URL already exists');
  }

  // Check duplicate URL among built-in feeds
  for (const feedList of Object.values(FEEDS)) {
    if (!feedList) continue;
    for (const f of feedList) {
      const builtinUrl = typeof f.url === 'string' ? f.url : Object.values(f.url)[0];
      if (builtinUrl?.includes(encodeURIComponent(entry.url)) || builtinUrl === entry.url) {
        throw new Error('This feed URL is already a built-in source');
      }
    }
  }

  // Auto-append " (Custom)" if name matches a built-in feed
  let name = entry.name;
  const allBuiltinNames = new Set<string>();
  for (const feedList of Object.values(FEEDS)) {
    if (feedList) feedList.forEach(f => allBuiltinNames.add(f.name));
  }
  if (allBuiltinNames.has(name)) {
    name = `${name} (Custom)`;
  }

  const newEntry: CustomFeedEntry = {
    id: `custom-${Date.now()}`,
    name,
    url: entry.url,
    category: entry.category,
  };

  feeds.push(newEntry);
  saveCustomFeeds(feeds);
  return newEntry;
}

export function removeCustomFeed(id: string): void {
  const feeds = loadCustomFeeds();
  const entry = feeds.find(f => f.id === id);
  if (!entry) return;

  // Clean name from disabled sources
  const disabledRaw = localStorage.getItem(STORAGE_KEYS.disabledFeeds);
  if (disabledRaw) {
    try {
      const disabled: string[] = JSON.parse(disabledRaw);
      const cleaned = disabled.filter(s => s !== entry.name);
      localStorage.setItem(STORAGE_KEYS.disabledFeeds, JSON.stringify(cleaned));
    } catch { /* ignore */ }
  }

  saveCustomFeeds(feeds.filter(f => f.id !== id));
}

export function getMergedFeeds(): Record<string, Feed[]> {
  const merged: Record<string, Feed[]> = {};
  for (const [key, feeds] of Object.entries(FEEDS)) {
    merged[key] = feeds ? [...feeds] : [];
  }

  const custom = loadCustomFeeds();
  for (const entry of custom) {
    const proxyUrl = `/api/rss-proxy?url=${encodeURIComponent(entry.url)}`;
    const feed: Feed = { name: entry.name, url: proxyUrl };

    const existing = merged[entry.category];
    if (existing) {
      existing.push(feed);
    } else {
      merged[entry.category] = [feed];
    }
  }

  return merged;
}

export function getCustomFeedNames(): Set<string> {
  return new Set(loadCustomFeeds().map(f => f.name));
}

export async function validateRssUrl(url: string): Promise<{ valid: boolean; title?: string; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const proxyUrl = `/api/rss-proxy?url=${encodeURIComponent(url)}`;
    const res = await fetch(proxyUrl, { signal: controller.signal });

    if (!res.ok) {
      return { valid: false, error: `HTTP ${res.status}` };
    }

    const text = await res.text();

    if (!text.includes('<rss') && !text.includes('<feed') && !text.includes('<channel')) {
      return { valid: false, error: 'Not a valid RSS/Atom feed' };
    }

    // Extract title
    const titleMatch = text.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
    const title = titleMatch?.[1]?.trim() || '';

    return { valid: true, title };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { valid: false, error: 'Request timed out' };
    }
    return { valid: false, error: 'Failed to fetch feed' };
  } finally {
    clearTimeout(timeout);
  }
}
