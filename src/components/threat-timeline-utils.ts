import type { ServerInsightStory, ServerInsights, ServerThreatTimeline } from '@/services/insights-loader';
import type { ClusteredEvent } from '@/types';

export const THREAT_LEVELS = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type TimelineThreatLevel = typeof THREAT_LEVELS[number];

export const THREAT_LEVEL_LABELS: Record<TimelineThreatLevel, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

export const THREAT_LEVEL_COLORS: Record<TimelineThreatLevel, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#38bdf8',
  info: '#94a3b8',
};

const SEVERITY_RANK: Record<TimelineThreatLevel, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export interface ThreatTimelineItem {
  id: string;
  title: string;
  source: string;
  sourceUrl: string;
  category: string;
  threatLevel: TimelineThreatLevel;
  rawThreatLevel: string;
  timestampMs: number;
  isAlert: boolean;
  sourceCount: number;
  provenance: string;
}

export interface ThreatTimelineDay {
  key: string;
  label: string;
  startMs: number;
  counts: Record<TimelineThreatLevel, number>;
  total: number;
  /** True when the history does not cover the whole day (before recording began, or after the last update). */
  partial?: boolean;
}

export interface ThreatTimelineGroup {
  level: TimelineThreatLevel;
  label: string;
  count: number;
  items: ThreatTimelineItem[];
}

export interface ThreatTimelineState {
  days: ThreatTimelineDay[];
  groups: ThreatTimelineGroup[];
  totals: Record<TimelineThreatLevel, number>;
  items: ThreatTimelineItem[];
  status: 'ok' | 'degraded';
  statusMessage: string;
  degradedReasons: string[];
  hasData: boolean;
  /** Set when day counts come from the seeded history rather than the listed items. */
  historyStoryCount?: number;
}

export interface ThreatTimelineTrend {
  label: string;
  copy: string;
  className: string;
}

export function normalizeThreatLevel(value: unknown): TimelineThreatLevel {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'critical' || normalized === 'high' || normalized === 'medium' || normalized === 'low' || normalized === 'info') {
    return normalized;
  }
  if (normalized === 'elevated' || normalized === 'moderate') {
    return 'medium';
  }
  return 'info';
}

export function normalizeServerInsightStories(insights: Pick<ServerInsights, 'topStories' | 'generatedAt'>): ThreatTimelineItem[] {
  const generatedAtMs = parseTimestampMs(insights.generatedAt) ?? Date.now();
  return insights.topStories
    .map((story, index) => normalizeServerInsightStory(story, index, generatedAtMs))
    .filter((item): item is ThreatTimelineItem => item !== null);
}

export function normalizeClusterStories(clusters: ClusteredEvent[]): ThreatTimelineItem[] {
  return clusters
    .map((cluster, index) => normalizeClusterStory(cluster, index))
    .filter((item): item is ThreatTimelineItem => item !== null);
}

export function buildThreatTimelineState(
  inputItems: ThreatTimelineItem[],
  options: { nowMs?: number; status?: 'ok' | 'degraded'; statusMessage?: string } = {},
): ThreatTimelineState {
  const nowMs = options.nowMs ?? Date.now();
  const todayStart = utcDayStartMs(nowMs);
  const startMs = todayStart - (6 * DAY_MS);
  const endMs = todayStart + DAY_MS;
  const dayMap = new Map<string, ThreatTimelineDay>();
  const totals = emptyCounts();
  const degradedReasons: string[] = [];
  let invalidTimestampCount = 0;

  for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
    const dayStart = startMs + (dayIndex * DAY_MS);
    const key = dayKey(dayStart);
    dayMap.set(key, {
      key,
      label: dayLabel(dayStart),
      startMs: dayStart,
      counts: emptyCounts(),
      total: 0,
    });
  }

  const inWindowItems: ThreatTimelineItem[] = [];
  for (const item of inputItems) {
    if (!Number.isFinite(item.timestampMs)) {
      invalidTimestampCount++;
      continue;
    }
    if (item.timestampMs < startMs || item.timestampMs >= endMs) {
      continue;
    }
    const key = dayKey(item.timestampMs);
    const day = dayMap.get(key);
    if (!day) continue;
    day.counts[item.threatLevel] += 1;
    day.total += 1;
    totals[item.threatLevel] += 1;
    inWindowItems.push(item);
  }

  if (invalidTimestampCount > 0) {
    degradedReasons.push(`${invalidTimestampCount} item(s) missing a valid timestamp`);
  }
  if (options.status === 'degraded' && options.statusMessage) {
    degradedReasons.push(options.statusMessage);
  }

  const sortedItems = [...inWindowItems].sort(compareThreatTimelineItems);
  const groups = THREAT_LEVELS
    .map((level) => ({
      level,
      label: THREAT_LEVEL_LABELS[level],
      count: totals[level],
      items: sortedItems.filter((item) => item.threatLevel === level).slice(0, 5),
    }))
    .filter((group) => group.count > 0);

  return {
    days: [...dayMap.values()],
    groups,
    totals,
    items: sortedItems,
    status: options.status ?? 'ok',
    statusMessage: options.statusMessage ?? '',
    degradedReasons,
    hasData: sortedItems.length > 0,
  };
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function readHistoryCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Day counts from the seeded seven-day history; the grouped list stays the
 * current top stories. Returns null when the payload carries no usable
 * history, so the caller can fall back to binning the listed items.
 */
export function buildThreatTimelineStateFromHistory(
  history: ServerThreatTimeline | undefined,
  topItems: ThreatTimelineItem[],
  options: { nowMs?: number; status?: 'ok' | 'degraded'; statusMessage?: string } = {},
): ThreatTimelineState | null {
  if (!history || !Array.isArray(history.days)) return null;
  const countsByDate = new Map<string, Record<TimelineThreatLevel, number>>();
  for (const day of history.days) {
    if (!day || typeof day.date !== 'string' || !DAY_KEY_RE.test(day.date) || !day.counts) continue;
    const counts = emptyCounts();
    for (const level of THREAT_LEVELS) counts[level] = readHistoryCount(day.counts[level]);
    countsByDate.set(day.date, counts);
  }
  if (countsByDate.size === 0) return null;
  const recordedDates = [...countsByDate.keys()].sort();
  const lastRecorded = recordedDates[recordedDates.length - 1]!;
  const recordingSince = typeof history.recordingSince === 'string' && DAY_KEY_RE.test(history.recordingSince)
    ? history.recordingSince
    : recordedDates[0]!;

  const nowMs = options.nowMs ?? Date.now();
  const todayStart = utcDayStartMs(nowMs);
  const totals = emptyCounts();
  const days: ThreatTimelineDay[] = [];
  for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
    const dayStart = todayStart - ((6 - dayIndex) * DAY_MS);
    const key = dayKey(dayStart);
    const counts = countsByDate.get(key) ?? emptyCounts();
    let total = 0;
    for (const level of THREAT_LEVELS) {
      totals[level] += counts[level];
      total += counts[level];
    }
    days.push({
      key,
      label: dayLabel(dayStart),
      startMs: dayStart,
      counts,
      total,
      partial: key < recordingSince || key > lastRecorded,
    });
  }

  const degradedReasons: string[] = [];
  if (options.status === 'degraded' && options.statusMessage) degradedReasons.push(options.statusMessage);
  const sortedItems = topItems.filter(item => Number.isFinite(item.timestampMs)).sort(compareThreatTimelineItems);
  const groups = THREAT_LEVELS
    .map((level) => {
      const levelItems = sortedItems.filter((item) => item.threatLevel === level);
      return { level, label: THREAT_LEVEL_LABELS[level], count: levelItems.length, items: levelItems.slice(0, 5) };
    })
    .filter((group) => group.count > 0);
  const historyStoryCount = THREAT_LEVELS.reduce((sum, level) => sum + totals[level], 0);

  return {
    days,
    groups,
    totals,
    items: sortedItems,
    status: options.status ?? 'ok',
    statusMessage: options.statusMessage ?? '',
    degradedReasons,
    hasData: historyStoryCount > 0 || sortedItems.length > 0,
    historyStoryCount,
  };
}

export function countHighSeverityDays(state: ThreatTimelineState): number {
  return state.days.filter((day) => day.counts.critical + day.counts.high > 0).length;
}

export function describeThreatTimelineTrend(days: ThreatTimelineDay[]): ThreatTimelineTrend {
  // A comparison against days the history never covered would read an empty
  // past as a rising present.
  const partialDays = days.filter(day => day.partial).length;
  if (partialDays > 0) {
    const recorded = days.length - partialDays;
    return { label: 'Building', copy: `${recorded} of ${days.length} days fully recorded`, className: 'noisy' };
  }
  const firstThree = days.slice(0, 3).reduce((sum, day) => sum + day.counts.critical + day.counts.high, 0);
  const lastThree = days.slice(-3).reduce((sum, day) => sum + day.counts.critical + day.counts.high, 0);
  if (lastThree === 0 && firstThree === 0) {
    return { label: 'Quiet', copy: 'No critical/high days', className: 'quiet' };
  }
  // A move must be both absolute (2+) and relative (25%+): the seeded history
  // counts dozens of critical/high stories a week, where a swing of two is noise.
  if (isMaterialRise(lastThree, firstThree)) {
    return { label: 'Worsening', copy: `${lastThree} recent vs ${firstThree} earlier`, className: 'worsening' };
  }
  if (isMaterialRise(firstThree, lastThree)) {
    return { label: 'Easing', copy: `${lastThree} recent vs ${firstThree} earlier`, className: 'easing' };
  }
  return { label: 'Noisy', copy: `${lastThree} recent vs ${firstThree} earlier`, className: 'noisy' };
}

function isMaterialRise(next: number, previous: number): boolean {
  return next - previous >= 2 && next >= previous * 1.25;
}

export function compareThreatTimelineItems(a: ThreatTimelineItem, b: ThreatTimelineItem): number {
  const severityDelta = SEVERITY_RANK[b.threatLevel] - SEVERITY_RANK[a.threatLevel];
  if (severityDelta !== 0) return severityDelta;
  const timeDelta = b.timestampMs - a.timestampMs;
  if (timeDelta !== 0) return timeDelta;
  return b.sourceCount - a.sourceCount;
}

function normalizeServerInsightStory(story: ServerInsightStory, index: number, fallbackTimestampMs: number): ThreatTimelineItem | null {
  const timestampMs = parseTimestampMs(story.pubDate) ?? fallbackTimestampMs;
  const source = cleanSource(story.primarySource) || 'News Digest';
  const rawThreatLevel = String(story.threatLevel ?? '');
  return {
    id: `server-${index}-${stableSlug(story.primaryTitle)}`,
    title: story.primaryTitle || 'Untitled intelligence item',
    source,
    sourceUrl: story.primaryLink || '',
    category: story.category || 'general',
    threatLevel: normalizeThreatLevel(rawThreatLevel),
    rawThreatLevel,
    timestampMs,
    isAlert: Boolean(story.isAlert),
    // #6428: the timeline renders "N sources", a corroboration claim, so it
    // counts PUBLISHERS. story.sourceCount is the article count. Fail closed
    // to 1 (renders nothing) on a payload predating the publisher count.
    sourceCount: Number.isFinite(story.uniqueSourceCount) ? story.uniqueSourceCount! : 1,
    provenance: inferProvenance(source),
  };
}

function normalizeClusterStory(cluster: ClusteredEvent, index: number): ThreatTimelineItem | null {
  const timestampMs = parseTimestampMs(cluster.lastUpdated) ?? parseTimestampMs(cluster.firstSeen);
  if (timestampMs === null) return null;
  const topSource = cluster.topSources[0];
  const source = cleanSource(topSource?.name || cluster.primarySource) || 'News Digest';
  const rawThreatLevel = String(cluster.threat?.level ?? 'info');
  return {
    id: cluster.id || `cluster-${index}-${stableSlug(cluster.primaryTitle)}`,
    title: cluster.primaryTitle || 'Untitled intelligence item',
    source,
    sourceUrl: topSource?.url || cluster.primaryLink || '',
    category: cluster.threat?.category || 'general',
    threatLevel: normalizeThreatLevel(rawThreatLevel),
    rawThreatLevel,
    timestampMs,
    isAlert: Boolean(cluster.isAlert),
    sourceCount: Number.isFinite(cluster.uniquePublisherCount) ? cluster.uniquePublisherCount : 1,
    provenance: inferProvenance(source, cluster.threat?.source),
  };
}

function inferProvenance(source: string, threatSource?: string): string {
  const normalizedThreatSource = String(threatSource ?? '').trim().toLowerCase();
  if (normalizedThreatSource === 'keyword') return 'Keyword fallback';
  const normalizedSource = source.toLowerCase();
  if (normalizedSource.includes('acled')) return 'ACLED';
  if (normalizedSource.includes('news digest')) return 'News Digest';
  return source || 'News Digest';
}

function cleanSource(source: string | undefined): string {
  return String(source ?? '').replace(/\s+/g, ' ').trim();
}

function emptyCounts(): Record<TimelineThreatLevel, number> {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

function parseTimestampMs(value: Date | string | number | undefined): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function utcDayStartMs(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function dayKey(ms: number): string {
  return new Date(utcDayStartMs(ms)).toISOString().slice(0, 10);
}

function dayLabel(ms: number): string {
  const date = new Date(ms);
  const month = MONTHS[date.getUTCMonth()] ?? 'Jan';
  return `${month} ${date.getUTCDate()}`;
}

function stableSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
}
