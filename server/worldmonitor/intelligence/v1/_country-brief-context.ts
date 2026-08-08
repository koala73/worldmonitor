// Shared (anonymous-tier) grounding context for the country intel brief.
//
// Why this exists: the v3 cache key hashed the CALLER-supplied context
// snapshot. Anonymous dashboard traffic rebuilds that snapshot from live
// data, so every visitor minted a fresh key and the 6h TTL was illusory —
// ~6.4k uncached LLM generations/day (#4892). Anonymous callers now share
// one server-grounded cache entry per (country, lang, energy-year); the
// caller-personalized path is reserved for premium requests, whose volume
// is small and whose auth makes per-context keys affordable.
//
// The grounding assembly mirrors the MCP `get_country_brief` tool
// (api/mcp/registry/rpc-tools.ts), which already built the same
// "Brief source articles / Headlines" block from the news digest — the
// server is simply the right place to do it once for everyone.

import { getCachedJson } from '../../../_shared/redis';

const DIGEST_KEY_EN = 'news:digest:v1:full:en';
const MAX_GROUNDING_ITEMS = 15;
const MAX_SOURCES = 6;
const MAX_CONTEXT_CHARS = 4000;

export interface SharedBriefSource {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
}

export interface SharedCountryContext {
  contextSnapshot: string;
  sources: SharedBriefSource[];
}

const EMPTY_CONTEXT: SharedCountryContext = { contextSnapshot: '', sources: [] };

export interface CountryIntelCacheKeyOpts {
  countryCode: string;
  lang: string;
  isPremium: boolean;
  /** 16-char sha prefix of the caller context, or 'base' when absent. Premium-only input. */
  contextHash: string;
  /** 8-char sha prefix of the premium framework, or ''. Premium-only input. */
  frameworkHash: string;
  /** OWID energy data-year, or '' when unavailable. */
  energyYear: string;
}

export function deriveCountryIntelCacheKey(opts: CountryIntelCacheKeyOpts): string {
  // v4 → v5 (2026-07-06, #4944): intel briefs moved to deepseek-v4-flash;
  // v4 rows carry old-model prose and must age out at cutover.
  const energyTag = opts.energyYear ? `:e${opts.energyYear}` : '';
  if (!opts.isPremium) {
    // Anonymous tier: caller inputs must not reach the key, or the shared
    // cache degenerates back into a per-caller one (and one caller's
    // context could mint entries served to everyone).
    return `ci-sebuf:v5:${opts.countryCode}:${opts.lang}:shared${energyTag}`;
  }
  const fw = opts.frameworkHash ? `:${opts.frameworkHash}` : '';
  return `ci-sebuf:v5:${opts.countryCode}:${opts.lang}:${opts.contextHash}${fw}${energyTag}`;
}

interface DigestItemForBrief {
  title?: unknown;
  snippet?: unknown;
  source?: unknown;
  link?: unknown;
  url?: unknown;
  pubDate?: unknown;
  publishedAt?: unknown;
  date?: unknown;
}

// Local copy of chat-analyst-context's flattenDigest: importing that module
// here would pull the whole analyst context assembly into this handler's
// edge bundle for 15 lines of shape-tolerant flattening.
function flattenDigest(digest: unknown): DigestItemForBrief[] {
  if (!digest || typeof digest !== 'object') return [];
  if (Array.isArray(digest)) return digest as DigestItemForBrief[];
  const d = digest as Record<string, unknown>;
  if (d.categories && typeof d.categories === 'object') {
    const items: DigestItemForBrief[] = [];
    for (const bucket of Object.values(d.categories as Record<string, unknown>)) {
      const b = bucket as Record<string, unknown>;
      if (Array.isArray(b.items)) items.push(...(b.items as DigestItemForBrief[]));
    }
    return items;
  }
  if (Array.isArray(d.items)) return d.items as DigestItemForBrief[];
  return [];
}

function clipText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? `${text.slice(0, maxLen - 1).trim()}...` : text;
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function normalizeDate(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive word-boundary match — for display NAMES only. */
export function includesCountryTerm(text: string, term: string): boolean {
  const normalizedTerm = term.trim().toLowerCase();
  if (!normalizedTerm) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizedTerm)}(?=$|[^a-z0-9])`, 'i').test(text);
}

/**
 * ISO codes match ONLY as uppercase tokens in the raw (non-lowercased) text.
 * Codes like IN, US, AT, NO collide with common English words — a
 * case-insensitive match swept "rally in Europe" into India's shared brief
 * (post-#4898 review, P2). Real code mentions in headlines are uppercase
 * ("US announces…", "exports from IN"); anything else is prose.
 */
export function includesCountryCodeToken(text: string, code: string): boolean {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return false;
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(normalized)}(?=$|[^A-Za-z0-9])`).test(text);
}

export interface CountryMatchTerms {
  code: string;
  names: string[];
}

export function countryBriefSearchTerms(countryCode: string): CountryMatchTerms {
  const code = countryCode.trim().toUpperCase();
  const names: string[] = [];
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code);
    // Unknown regions come back as a code echo or the ICU "Unknown Region"
    // sentinel — neither is a real name, and an echoed code as a lowercase
    // word-match term would reintroduce the stopword collision this split
    // exists to prevent.
    if (name && name.toUpperCase() !== code && name.toLowerCase() !== 'unknown region') {
      names.push(name.toLowerCase());
    }
  } catch {
    /* Intl.DisplayNames can be missing in constrained runtimes. */
  }
  return { code, names };
}

/** Display name is the primary signal; the ISO code counts only as an uppercase token. */
export function matchesCountry(rawText: string, terms: CountryMatchTerms): boolean {
  if (terms.names.some((name) => includesCountryTerm(rawText, name))) return true;
  return includesCountryCodeToken(rawText, terms.code);
}

function collectBriefSources(items: DigestItemForBrief[], maxSources = MAX_SOURCES): SharedBriefSource[] {
  const out: SharedBriefSource[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const url = normalizeUrl(item.link ?? item.url);
    const title = clipText(item.title, 160);
    const source = clipText(item.source, 80);
    if (!url || !title || !source || seen.has(url)) continue;
    out.push({ title, source, url, publishedAt: normalizeDate(item.publishedAt ?? item.pubDate ?? item.date) });
    seen.add(url);
    if (out.length >= maxSources) break;
  }
  return out;
}

function briefSourceContextLines(sources: SharedBriefSource[]): string[] {
  return sources.map((source, index) => {
    const payload: Record<string, string> = { title: source.title, source: source.source, url: source.url };
    if (source.publishedAt) payload.publishedAt = source.publishedAt;
    return `Source [${index + 1}]: ${JSON.stringify(payload)}`;
  });
}

export function buildSharedCountryContext(digest: unknown, countryCode: string): SharedCountryContext {
  const allItems = flattenDigest(digest).filter(
    (item) => typeof item.title === 'string' && item.title.length > 0,
  );
  if (allItems.length === 0) return EMPTY_CONTEXT;

  const terms = countryBriefSearchTerms(countryCode);
  // Raw text, NOT lowercased — the uppercase-token code match depends on the
  // original casing surviving to this point.
  const countryItems = allItems.filter((item) => {
    const text = `${typeof item.title === 'string' ? item.title : ''} ${typeof item.snippet === 'string' ? item.snippet : ''}`;
    return matchesCountry(text, terms);
  });

  // No country match → ground on the top global items instead. A generic
  // world-situation brief beats an empty prompt (mirrors the MCP tool).
  const groundingItems = (countryItems.length > 0 ? countryItems : allItems).slice(0, MAX_GROUNDING_ITEMS);
  const sources = collectBriefSources(groundingItems);
  const sourceLines = sources.length > 0 ? ['Brief source articles:', ...briefSourceContextLines(sources)] : [];
  const headlineLines = groundingItems
    .map((item) => (typeof item.title === 'string' ? item.title : ''))
    .filter(Boolean);
  const contextSnapshot = [...sourceLines, 'Headlines:', ...headlineLines].join('\n').slice(0, MAX_CONTEXT_CHARS);
  return { contextSnapshot, sources };
}

/** Read the shared digest and build country grounding. Failure → empty context (brief still generates). */
export async function fetchSharedCountryContext(countryCode: string): Promise<SharedCountryContext> {
  try {
    const digest = await getCachedJson(DIGEST_KEY_EN, true);
    return buildSharedCountryContext(digest, countryCode);
  } catch {
    return EMPTY_CONTEXT;
  }
}
