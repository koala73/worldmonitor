import { MONITOR_COLORS } from '@/config/variants/base';
import type { BreakingAlert } from '@/services/breaking-news-alerts';
import type { ListCrossSourceSignalsResponse } from '@/services/cross-source-signals';
import { getSecretState } from '@/services/runtime-config';
import type { SecurityAdvisory } from '@/services/security-advisories';
import type {
  Monitor,
  MonitorMatchMode,
  MonitorSourceKind,
  NewsItem,
  ThreatLevel,
} from '@/types';

export const FREE_MONITOR_LIMIT = 3;

const FREE_MONITOR_SOURCES: MonitorSourceKind[] = ['news', 'breaking'];
const DEFAULT_MONITOR_SOURCES: MonitorSourceKind[] = ['news'];

export interface MonitorFeedInput {
  news: NewsItem[];
  advisories?: SecurityAdvisory[];
  crossSourceSignals?: ListCrossSourceSignalsResponse['signals'];
  breakingAlerts?: BreakingAlert[];
}

export interface MonitorMatch {
  id: string;
  monitorId: string;
  monitorName: string;
  monitorColor: string;
  sourceKind: MonitorSourceKind;
  title: string;
  subtitle: string;
  summary: string;
  link?: string;
  timestamp: number;
  severity?: ThreatLevel;
  matchedTerms: string[];
}

export interface MonitorHighlight {
  color: string;
  monitorId: string;
  matchedTerms: string[];
}

function trimText(value: string | undefined): string {
  return (value || '').trim();
}

function uniqueKeywords(items: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items || []) {
    const normalized = item.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function uniqueSources(items: MonitorSourceKind[] | undefined): MonitorSourceKind[] {
  const out: MonitorSourceKind[] = [];
  const seen = new Set<MonitorSourceKind>();
  for (const item of items || []) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function normalizeSources(items: MonitorSourceKind[] | undefined): MonitorSourceKind[] {
  const out = uniqueSources(items);
  return out.length > 0 ? out : [...DEFAULT_MONITOR_SOURCES];
}

function filterFreeSources(items: MonitorSourceKind[] | undefined): MonitorSourceKind[] {
  const freeSources = uniqueSources(items).filter((source) => FREE_MONITOR_SOURCES.includes(source));
  return freeSources.length > 0 ? freeSources : [...FREE_MONITOR_SOURCES];
}

function resolveSourcesForMatching(items: MonitorSourceKind[] | undefined): MonitorSourceKind[] {
  return items === undefined ? [...DEFAULT_MONITOR_SOURCES] : uniqueSources(items);
}

function inferMonitorName(keywords: string[], fallbackIndex: number): string {
  if (keywords.length === 0) return `Monitor ${fallbackIndex + 1}`;
  return keywords.slice(0, 2).join(' + ');
}

export function hasMonitorProAccess(): boolean {
  return getSecretState('WORLDMONITOR_API_KEY').present || hasStoredProKey();
}

export function monitorUsesProFeatures(monitor: Monitor): boolean {
  const excludeKeywords = uniqueKeywords(monitor.excludeKeywords);
  const sources = normalizeSources(monitor.sources);
  return excludeKeywords.length > 0 || sources.some((source) => !FREE_MONITOR_SOURCES.includes(source));
}

export function normalizeMonitor(input: Monitor, index = 0): Monitor {
  const includeKeywords = uniqueKeywords(input.includeKeywords ?? input.keywords);
  const excludeKeywords = uniqueKeywords(input.excludeKeywords);
  const now = Date.now();
  return {
    ...input,
    id: trimText(input.id) || `id-${crypto.randomUUID()}`,
    name: trimText(input.name) || inferMonitorName(includeKeywords, index),
    keywords: includeKeywords,
    includeKeywords,
    excludeKeywords,
    color: trimText(input.color) || MONITOR_COLORS[index % MONITOR_COLORS.length] || 'var(--status-live)',
    matchMode: input.matchMode === 'all' ? 'all' : 'any',
    sources: normalizeSources(input.sources),
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : now,
  };
}

export function normalizeMonitors(monitors: Monitor[]): Monitor[] {
  return (monitors || []).map((monitor, index) => normalizeMonitor(monitor, index));
}

export function prepareMonitorsForRuntime(monitors: Monitor[], proAccess = hasMonitorProAccess()): Monitor[] {
  const normalized = normalizeMonitors(monitors);
  return normalized
    .slice(0, proAccess ? normalized.length : FREE_MONITOR_LIMIT)
    .map((monitor) => {
      if (proAccess) return monitor;
      return {
        ...monitor,
        excludeKeywords: [],
        sources: filterFreeSources(monitor.sources),
      };
    });
}

export function mergeMonitorEdits(existing: Monitor, draft: Monitor, proAccess = hasMonitorProAccess()): Monitor {
  if (proAccess || !monitorUsesProFeatures(existing)) return draft;

  const freeSources = uniqueSources(draft.sources).filter((source) => FREE_MONITOR_SOURCES.includes(source));
  const lockedSources = uniqueSources(existing.sources).filter((source) => !FREE_MONITOR_SOURCES.includes(source));
  return {
    ...draft,
    excludeKeywords: uniqueKeywords(existing.excludeKeywords),
    sources: uniqueSources([...freeSources, ...lockedSources]),
  };
}

function matchesKeyword(haystack: string, keyword: string): boolean {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) return false;
  if (/\s/.test(normalizedKeyword)) {
    return haystack.includes(normalizedKeyword);
  }
  const escaped = normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i');
  if (re.test(haystack)) return true;

  // Broad monitor terms like "iran" should also catch close derivatives such as
  // "iranian" without requiring users to enumerate every suffix manually.
  if (/^[a-z0-9]{4,}$/.test(normalizedKeyword)) {
    const prefixRe = new RegExp(`(^|[^a-z0-9])${escaped}[a-z0-9]+`, 'i');
    return prefixRe.test(haystack);
  }

  return false;
}

function evaluateTextRule(
  haystack: string,
  includeKeywords: string[],
  excludeKeywords: string[],
  matchMode: MonitorMatchMode,
): string[] {
  if (includeKeywords.length === 0) return [];

  const matchedIncludes = includeKeywords.filter((keyword) => matchesKeyword(haystack, keyword));
  const includeMatch = matchMode === 'all'
    ? matchedIncludes.length === includeKeywords.length
    : matchedIncludes.length > 0;
  if (!includeMatch) return [];

  const matchedExcludes = excludeKeywords.filter((keyword) => matchesKeyword(haystack, keyword));
  if (matchedExcludes.length > 0) return [];

  return matchedIncludes;
}

function advisorySeverity(level: SecurityAdvisory['level']): ThreatLevel {
  switch (level) {
    case 'do-not-travel': return 'critical';
    case 'reconsider': return 'high';
    case 'caution': return 'medium';
    case 'normal': return 'low';
    default: return 'info';
  }
}

function crossSourceSeverity(level: string | undefined): ThreatLevel {
  switch (level) {
    case 'CROSS_SOURCE_SIGNAL_SEVERITY_CRITICAL': return 'critical';
    case 'CROSS_SOURCE_SIGNAL_SEVERITY_HIGH': return 'high';
    case 'CROSS_SOURCE_SIGNAL_SEVERITY_MEDIUM': return 'medium';
    case 'CROSS_SOURCE_SIGNAL_SEVERITY_LOW': return 'low';
    default: return 'info';
  }
}

function dedupeMatches(matches: MonitorMatch[]): MonitorMatch[] {
  const seen = new Set<string>();
  const out: MonitorMatch[] = [];
  for (const match of matches) {
    const key = `${match.monitorId}:${match.sourceKind}:${match.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(match);
  }
  return out;
}

function asTimestamp(input: Date | number | undefined): number {
  if (typeof input === 'number') return input;
  if (input instanceof Date) return input.getTime();
  return Date.now();
}

export function evaluateMonitorMatches(
  monitors: Monitor[],
  feed: MonitorFeedInput,
  options?: { proAccess?: boolean },
): MonitorMatch[] {
  const runtimeMonitors = prepareMonitorsForRuntime(monitors, options?.proAccess);
  if (runtimeMonitors.length === 0) return [];

  const matches: MonitorMatch[] = [];

  for (const monitor of runtimeMonitors) {
    const includeKeywords = uniqueKeywords(monitor.includeKeywords ?? monitor.keywords);
    const excludeKeywords = uniqueKeywords(monitor.excludeKeywords);
    const matchMode = monitor.matchMode === 'all' ? 'all' : 'any';
    const sources = resolveSourcesForMatching(monitor.sources);

    if (sources.includes('news')) {
      for (const item of feed.news || []) {
        const extraDescription = trimText((item as NewsItem & { description?: string; summary?: string }).description)
          || trimText((item as NewsItem & { description?: string; summary?: string }).summary);
        const haystack = [
          item.title,
          item.locationName,
          extraDescription,
        ].filter(Boolean).join(' ').toLowerCase();
        const matchedTerms = evaluateTextRule(haystack, includeKeywords, excludeKeywords, matchMode);
        if (matchedTerms.length === 0) continue;
        matches.push({
          id: item.link || `${item.source}:${item.title}`,
          monitorId: monitor.id,
          monitorName: monitor.name || 'Monitor',
          monitorColor: monitor.color,
          sourceKind: 'news',
          title: item.title,
          subtitle: item.source,
          summary: item.locationName || item.link,
          link: item.link,
          timestamp: asTimestamp(item.pubDate),
          severity: item.threat?.level,
          matchedTerms,
        });
      }
    }

    if (sources.includes('breaking')) {
      for (const item of feed.breakingAlerts || []) {
        const haystack = [
          item.headline,
          item.source,
          item.origin,
        ].filter(Boolean).join(' ').toLowerCase();
        const matchedTerms = evaluateTextRule(haystack, includeKeywords, excludeKeywords, matchMode);
        if (matchedTerms.length === 0) continue;
        matches.push({
          id: item.id,
          monitorId: monitor.id,
          monitorName: monitor.name || 'Monitor',
          monitorColor: monitor.color,
          sourceKind: 'breaking',
          title: item.headline,
          subtitle: item.source,
          summary: item.origin.replace(/_/g, ' '),
          link: item.link,
          timestamp: asTimestamp(item.timestamp),
          severity: item.threatLevel,
          matchedTerms,
        });
      }
    }

    if (sources.includes('advisories')) {
      for (const item of feed.advisories || []) {
        const haystack = [
          item.title,
          item.source,
          item.country,
          item.sourceCountry,
          item.level,
        ].filter(Boolean).join(' ').toLowerCase();
        const matchedTerms = evaluateTextRule(haystack, includeKeywords, excludeKeywords, matchMode);
        if (matchedTerms.length === 0) continue;
        matches.push({
          id: item.link || `${item.source}:${item.title}`,
          monitorId: monitor.id,
          monitorName: monitor.name || 'Monitor',
          monitorColor: monitor.color,
          sourceKind: 'advisories',
          title: item.title,
          subtitle: item.source,
          summary: [item.country, item.level].filter(Boolean).join(' · '),
          link: item.link,
          timestamp: asTimestamp(item.pubDate),
          severity: advisorySeverity(item.level),
          matchedTerms,
        });
      }
    }

    if (sources.includes('cross-source')) {
      for (const item of feed.crossSourceSignals || []) {
        const haystack = [
          item.theater,
          item.summary,
          item.type,
          ...(item.contributingTypes || []),
        ].filter(Boolean).join(' ').toLowerCase();
        const matchedTerms = evaluateTextRule(haystack, includeKeywords, excludeKeywords, matchMode);
        if (matchedTerms.length === 0) continue;
        matches.push({
          id: item.id,
          monitorId: monitor.id,
          monitorName: monitor.name || 'Monitor',
          monitorColor: monitor.color,
          sourceKind: 'cross-source',
          title: item.theater,
          subtitle: 'Cross-source signal',
          summary: item.summary,
          timestamp: asTimestamp(item.detectedAt),
          severity: crossSourceSeverity(item.severity),
          matchedTerms,
        });
      }
    }
  }

  return dedupeMatches(matches).sort((a, b) => b.timestamp - a.timestamp);
}

export function buildNewsMonitorHighlights(
  monitors: Monitor[],
  news: NewsItem[],
  options?: { proAccess?: boolean },
): Map<string, MonitorHighlight> {
  const matches = evaluateMonitorMatches(monitors, { news }, options)
    .filter((match) => match.sourceKind === 'news');
  const out = new Map<string, MonitorHighlight>();
  for (const match of matches) {
    if (!match.link || out.has(match.link)) continue;
    out.set(match.link, {
      color: match.monitorColor,
      monitorId: match.monitorId,
      matchedTerms: match.matchedTerms,
    });
  }
  return out;
}

export function applyMonitorHighlightsToNews(
  monitors: Monitor[],
  news: NewsItem[],
  options?: { proAccess?: boolean },
): NewsItem[] {
  const highlightMap = buildNewsMonitorHighlights(monitors, news, options);
  return (news || []).map((item) => {
    const highlight = item.link ? highlightMap.get(item.link) : undefined;
    return {
      ...item,
      ...(highlight ? { monitorColor: highlight.color } : { monitorColor: undefined }),
    };
  });
}

function hasStoredProKey(): boolean {
  try {
    const cookie = document.cookie || '';
    const cookieEntries = cookie.split(';').map((entry) => entry.trim()).filter(Boolean);
    const hasCookieKey = (name: string): boolean => cookieEntries.some((entry) => {
      const separatorIndex = entry.indexOf('=');
      const key = separatorIndex >= 0 ? entry.slice(0, separatorIndex).trim() : entry.trim();
      if (key !== name) return false;
      const rawValue = separatorIndex >= 0 ? entry.slice(separatorIndex + 1).trim() : '';
      if (!rawValue) return false;
      try {
        return decodeURIComponent(rawValue).trim().length > 0;
      } catch {
        return rawValue.length > 0;
      }
    });
    if (hasCookieKey('wm-widget-key') || hasCookieKey('wm-pro-key')) return true;
  } catch {
    // ignore
  }

  try {
    const hasStoredKey = (name: 'wm-widget-key' | 'wm-pro-key'): boolean => {
      const value = localStorage.getItem(name);
      return typeof value === 'string' && value.trim().length > 0;
    };
    return hasStoredKey('wm-widget-key') || hasStoredKey('wm-pro-key');
  } catch {
    return false;
  }
}
