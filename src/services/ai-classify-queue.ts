/**
 * Throttle gate for AI threat-classification dispatch.
 *
 * Identity used to dedupe: link (when present, lowercase host + tracker
 * params stripped + fragment dropped) → falls back to title.
 *
 * Background: the previous title-only identity collapsed distinct articles
 * sharing a wire headline ("Reuters: Iran fires missiles at..." reposted
 * with the same headline by multiple outlets) into one dedupe slot, so
 * only the first got an AI threat upgrade. The link-keyed identity makes
 * each article-as-a-URL its own dedupe key; the title fallback preserves
 * the original behavior when an upstream feed lacks a link.
 *
 * NOTE: this is NOT an admission gate. The caller in src/services/rss.ts
 * only invokes canQueueAiClassification for items where
 * `threat.source === 'keyword'` — articles already keyword-classified that
 * are eligible for an AI confidence upgrade. A dropped enqueue does NOT
 * drop the article from the feed; it just means the article's threat
 * label stays at keyword confidence instead of being upgraded.
 */

// Import from the leaf variant module rather than '@/config' (the barrel)
// so node:test runners that don't provide Vite's import.meta.env can load
// this file without pulling in the entire config chain (feeds.ts →
// @/utils/proxy → import.meta.env.DEV crash). See route-explorer-keyboard
// test header for the broader Vite/Node compat pattern.
import { SITE_VARIANT } from '@/config/variant';

const AI_CLASSIFY_DEDUP_MS = 30 * 60 * 1000;
const AI_CLASSIFY_WINDOW_MS = 60 * 1000;
const AI_CLASSIFY_MAX_PER_WINDOW =
  SITE_VARIANT === 'finance' ? 40 : SITE_VARIANT === 'tech' ? 60 : 80;
export const AI_CLASSIFY_MAX_PER_FEED =
  SITE_VARIANT === 'finance' ? 2 : SITE_VARIANT === 'tech' ? 2 : 3;

const aiRecentlyQueued = new Map<string, number>();
const aiDispatches: number[] = [];

// Tracker params commonly appended by feed publishers / share-link
// rewriters that do NOT change which article a URL points at. Stripping
// them lets the same article shared by two different feeds with different
// utm tagging collapse into one dedupe slot. We intentionally keep this
// list small and well-known — broader canonicalization (RFC 3986 normal
// form, query-param sorting, path-segment collapsing) belongs in a real
// URL canonicalizer, not a throttle gate.
const TRACKER_PARAM_PREFIXES = ['utm_'];
const TRACKER_PARAM_EXACT = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
]);

function normalizeLink(link: string): string | null {
  try {
    const url = new URL(link);
    // Lowercased host; some publishers ship mixed-case hostnames.
    url.hostname = url.hostname.toLowerCase();
    // Fragment is a client-side anchor — never identifies a different
    // article on its own.
    url.hash = '';
    // Strip well-known tracker params.
    const toDelete: string[] = [];
    for (const name of url.searchParams.keys()) {
      const lower = name.toLowerCase();
      if (TRACKER_PARAM_EXACT.has(lower)) {
        toDelete.push(name);
        continue;
      }
      if (TRACKER_PARAM_PREFIXES.some((p) => lower.startsWith(p))) {
        toDelete.push(name);
      }
    }
    for (const name of toDelete) url.searchParams.delete(name);
    return url.href;
  } catch {
    // Malformed link → signal fall-through to title identity.
    return null;
  }
}

function titleKey(title: string): string {
  return `title:${title.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

function toAiKey(identity: { link?: string; title: string }): string {
  if (identity.link && identity.link.length > 0) {
    const normalized = normalizeLink(identity.link);
    if (normalized !== null) return `link:${normalized}`;
    // normalizeLink returned null → malformed URL → fall back to title.
  }
  return titleKey(identity.title);
}

export function canQueueAiClassification(identity: { link?: string; title: string }): boolean {
  const now = Date.now();
  while (aiDispatches.length > 0 && now - aiDispatches[0]! > AI_CLASSIFY_WINDOW_MS) {
    aiDispatches.shift();
  }
  for (const [key, queuedAt] of aiRecentlyQueued) {
    if (now - queuedAt > AI_CLASSIFY_DEDUP_MS) {
      aiRecentlyQueued.delete(key);
    }
  }
  if (aiDispatches.length >= AI_CLASSIFY_MAX_PER_WINDOW) {
    return false;
  }

  const key = toAiKey(identity);
  const lastQueued = aiRecentlyQueued.get(key);
  if (lastQueued && now - lastQueued < AI_CLASSIFY_DEDUP_MS) {
    return false;
  }

  aiDispatches.push(now);
  aiRecentlyQueued.set(key, now);
  return true;
}

/**
 * Test-only reset hook. Clears the module-scope dedupe map and dispatch
 * window so tests can drive the queue across multiple scenarios without
 * order-dependency. Matches the naming convention at
 * `insights-loader.ts:104 __resetServerInsightsCacheForTests`.
 *
 * @internal
 */
export function __resetAiClassifyQueueForTests(): void {
  aiRecentlyQueued.clear();
  aiDispatches.length = 0;
}
