import type { NewsItem } from '@/types';
import { jaccardSimilarity, tokenize } from '@/utils/analysis-constants';

export type EventComparisonConfidence = 'low' | 'medium' | 'high';

export interface EventComparisonSignals {
  text: number;
  time: number;
  geo: number | null;
}

export interface EventComparison {
  similarity: number;
  confidence: EventComparisonConfidence;
  sharedFeatures: string[];
  differingFeatures: string[];
  signals: EventComparisonSignals;
}

export interface ClusterCoherenceSummary {
  coherence: number;
  confidence: EventComparisonConfidence;
  comparisonCount: number;
  weakestPair: EventComparison | null;
}

export interface EventComparisonEnvelope {
  envelopeType: 'wm.event_comparison.v1';
  leftEvent: {
    id: string;
    title: string;
    timestamp: string;
    geo: { lat: number; lon: number } | null;
    source: string;
  };
  rightEvent: {
    id: string;
    title: string;
    timestamp: string;
    geo: { lat: number; lon: number } | null;
    source: string;
  };
  comparison: EventComparison;
  meta: {
    generatedBy: 'wm.event_comparison';
    version: 'v1';
  };
}

export interface EventComparisonMcpOptions {
  mcpServerUrl?: string;
  mcpProxyUrl?: string;
  fallbackToLocal?: boolean;
}

const ITIR_COMPARE_TOOL = 'itir.compare_observations';
const DEFAULT_MCP_PROXY_URL = '/api/mcp-proxy';

const GEO_DISTANCE_WINDOW_KM = 100;
const GEO_PROXIMITY_WINDOW_KM = 50;
const TIME_DISTANCE_WINDOW_MS = 6 * 60 * 60 * 1000;
const TIME_PROXIMITY_WINDOW_MS = 2 * 60 * 60 * 1000;
const SHARED_TOKEN_LIMIT = 5;
const MAX_COHERENCE_ITEMS = 250;

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalizeTitle(item: NewsItem): string {
  return item.title.trim();
}

function buildStableEventId(item: NewsItem): string {
  const raw = `${item.source}|${item.link}|${item.pubDate.toISOString()}`;
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (let index = 0; index < raw.length; index++) {
    const charCode = raw.charCodeAt(index);
    h1 = Math.imul(h1 ^ charCode, 0x01000193);
    h2 = Math.imul(h2 ^ charCode, 0x01000193);
  }
  const part1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const part2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `evt-${part1}-${part2}`;
}

function toGeo(item: NewsItem): { lat: number; lon: number } | null {
  return item.lat == null || item.lon == null ? null : { lat: item.lat, lon: item.lon };
}

function toConfidence(similarity: number): EventComparisonConfidence {
  if (similarity >= 0.75) return 'high';
  if (similarity >= 0.45) return 'medium';
  return 'low';
}

function haversineKm(left: { lat: number; lon: number }, right: { lat: number; lon: number }): number {
  const radiusKm = 6371;
  const dLat = toRadians(right.lat - left.lat);
  const dLon = toRadians(right.lon - left.lon);
  const lat1 = toRadians(left.lat);
  const lat2 = toRadians(right.lat);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return radiusKm * c;
}

function toRadians(value: number): number {
  return value * (Math.PI / 180);
}

export function compareNewsItems(left: NewsItem, right: NewsItem): EventComparison {
  const leftTokens = tokenize(normalizeTitle(left));
  const rightTokens = tokenize(normalizeTitle(right));
  const text = jaccardSimilarity(leftTokens, rightTokens);

  const timeDiffMs = Math.abs(left.pubDate.getTime() - right.pubDate.getTime());
  const time = clamp(1 - (timeDiffMs / TIME_DISTANCE_WINDOW_MS));

  const leftGeo = toGeo(left);
  const rightGeo = toGeo(right);
  const geoDistanceKm = leftGeo && rightGeo ? haversineKm(leftGeo, rightGeo) : null;
  const geo = geoDistanceKm == null ? null : clamp(1 - (geoDistanceKm / GEO_DISTANCE_WINDOW_KM));

  const scoreParts = geo == null ? [text, time] : [text, time, geo];
  const similarity = roundMetric(scoreParts.reduce((sum, value) => sum + value, 0) / scoreParts.length);

  const sharedTokens = [...leftTokens].filter(token => rightTokens.has(token)).slice(0, SHARED_TOKEN_LIMIT);
  const sharedFeatures: string[] = [];
  if (sharedTokens.length > 0) {
    sharedFeatures.push(`shared terms: ${sharedTokens.join(', ')}`);
  }
  if (left.locationName && right.locationName && left.locationName.toLowerCase() === right.locationName.toLowerCase()) {
    sharedFeatures.push(`shared location label: ${left.locationName}`);
  }
  if (timeDiffMs <= TIME_PROXIMITY_WINDOW_MS) {
    sharedFeatures.push(`time window: ${Math.round(timeDiffMs / 60000)} minutes apart`);
  }
  if (geoDistanceKm != null && geoDistanceKm <= GEO_PROXIMITY_WINDOW_KM) {
    sharedFeatures.push(`geo proximity: ${Math.round(geoDistanceKm)} km`);
  }

  const differingFeatures: string[] = [];
  if (left.source !== right.source) {
    differingFeatures.push(`sources differ: ${left.source} vs ${right.source}`);
  }
  if (timeDiffMs > TIME_PROXIMITY_WINDOW_MS) {
    differingFeatures.push(`time offset: ${Math.round(timeDiffMs / 3600000)}h`);
  }
  if (geoDistanceKm != null && geoDistanceKm > GEO_PROXIMITY_WINDOW_KM) {
    differingFeatures.push(`geo offset: ${Math.round(geoDistanceKm)} km`);
  }
  if (sharedTokens.length === 0) {
    differingFeatures.push('no shared title terms');
  }

  return {
    similarity,
    confidence: toConfidence(similarity),
    sharedFeatures,
    differingFeatures,
    signals: {
      text: roundMetric(text),
      time: roundMetric(time),
      geo: geo == null ? null : roundMetric(geo),
    },
  };
}

function buildItirObservation(item: NewsItem) {
  return {
    source_system: 'worldmonitor',
    source_scope: 'external',
    observed_time: item.pubDate.toISOString(),
    text: [item.title, item.locationName].filter(Boolean).join(' ').trim(),
    geometry: toGeo(item),
    source: item.source,
    source_id: item.link,
    anchor_refs: {
      source: item.source,
      link: item.link,
    },
  };
}

function parseItirSignals(raw: unknown): EventComparisonSignals {
  if (!raw || typeof raw !== 'object') {
    return { text: 0, time: 0, geo: 0 };
  }
  const data = raw as Record<string, unknown>;
  const signalBag = typeof data.signals === 'object' && data.signals !== null
    ? data.signals as Record<string, unknown>
    : data;
  const text = typeof signalBag.text === 'number' ? signalBag.text : typeof signalBag.textSimilarity === 'number' ? signalBag.textSimilarity : 0;
  const time = typeof signalBag.time === 'number' ? signalBag.time : typeof signalBag.timeSimilarity === 'number' ? signalBag.timeSimilarity : 0;
  const geoRaw = signalBag.geo;
  const geo = typeof geoRaw === 'number' ? geoRaw : typeof signalBag.geoSimilarity === 'number' ? signalBag.geoSimilarity : null;
  return {
    text: roundMetric(clamp(text)),
    time: roundMetric(clamp(time)),
    geo: geo === null ? null : roundMetric(clamp(geo)),
  };
}

function parseItirComparableFeatures(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const data = raw as Record<string, unknown>;
  const shared: unknown = data.shared_features ?? data.sharedFeatures ?? data.sharedFeature ?? data.shared?.features;
  if (Array.isArray(shared) && shared.every(item => typeof item === 'string')) {
    return shared;
  }
  return [];
}

function parseItirDistinctFeatures(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const data = raw as Record<string, unknown>;
  const distinct = data.distinct_features ?? data.distinctFeatures;

  if (Array.isArray(distinct) && distinct.every(item => typeof item === 'string')) {
    return distinct;
  }
  if (distinct && typeof distinct === 'object' && !Array.isArray(distinct)) {
    const bag = distinct as Record<string, unknown>;
    const leftOnly = Array.isArray(bag.left_only) ? bag.left_only : [];
    const rightOnly = Array.isArray(bag.right_only) ? bag.right_only : [];
    return [...leftOnly, ...rightOnly].filter((value): value is string => typeof value === 'string');
  }
  return [];
}

function parseItirComparisonResult(raw: unknown): EventComparison {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid ITIR comparison response payload');
  }
  const data = raw as Record<string, unknown>;
  const confidenceRaw = typeof data.confidence === 'string' ? data.confidence : undefined;
  const confidence = toConfidence(typeof data.similarity === 'number' ? data.similarity : 0.0);

  if (typeof data.similarity !== 'number' || Number.isNaN(data.similarity)) {
    throw new Error('ITIR comparison response missing similarity');
  }

  return {
    similarity: roundMetric(clamp(data.similarity)),
    confidence: confidenceRaw === 'low' || confidenceRaw === 'medium' || confidenceRaw === 'high'
      ? confidenceRaw
      : confidence,
    sharedFeatures: parseItirComparableFeatures(data),
    differingFeatures: parseItirDistinctFeatures(data),
    signals: parseItirSignals(data),
  };
}

async function callItirCompare(left: NewsItem, right: NewsItem, options: EventComparisonMcpOptions = {}): Promise<EventComparison> {
  const serverUrl = options.mcpServerUrl?.trim();
  if (!serverUrl) {
    throw new Error('No ITIR MCP server configured');
  }

  const response = await fetch(options.mcpProxyUrl ?? DEFAULT_MCP_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serverUrl,
      toolName: ITIR_COMPARE_TOOL,
      toolArgs: { left: buildItirObservation(left), right: buildItirObservation(right) },
    }),
  });
  if (!response.ok) {
    throw new Error(`ITIR MCP call failed: HTTP ${response.status}`);
  }
  const payload = await response.json() as { result?: unknown; error?: string };
  if (payload.error) throw new Error(payload.error);
  if (!payload.result) throw new Error('ITIR MCP call returned no result');

  return parseItirComparisonResult(payload.result);
}

export async function compareNewsItemsWithItir(
  left: NewsItem,
  right: NewsItem,
  options: EventComparisonMcpOptions = {},
): Promise<EventComparison> {
  try {
    return await callItirCompare(left, right, options);
  } catch (error) {
    if (options.fallbackToLocal === false) {
      throw error;
    }
    return compareNewsItems(left, right);
  }
}

export function scoreClusterCoherence(items: NewsItem[]): ClusterCoherenceSummary {
  if (items.length < 2) {
    return {
      coherence: 1,
      confidence: 'high',
      comparisonCount: 0,
      weakestPair: null,
    };
  }

  const cappedItems = items.length > MAX_COHERENCE_ITEMS ? items.slice(0, MAX_COHERENCE_ITEMS) : items;
  const comparisons: EventComparison[] = [];
  for (let leftIndex = 0; leftIndex < cappedItems.length; leftIndex++) {
    const left = cappedItems[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < cappedItems.length; rightIndex++) {
      const right = cappedItems[rightIndex];
      if (!right) continue;
      comparisons.push(compareNewsItems(left, right));
    }
  }

  const coherence = roundMetric(
    comparisons.reduce((sum, comparison) => sum + comparison.similarity, 0) / comparisons.length
  );
  const weakestPair = [...comparisons].sort((left, right) => left.similarity - right.similarity)[0] ?? null;
  return {
    coherence,
    confidence: toConfidence(coherence),
    comparisonCount: comparisons.length,
    weakestPair,
  };
}

export function buildEventComparisonEnvelope(
  left: NewsItem,
  right: NewsItem,
  comparison = compareNewsItems(left, right),
): EventComparisonEnvelope {
  return {
    envelopeType: 'wm.event_comparison.v1',
    leftEvent: {
      id: buildStableEventId(left),
      title: left.title,
      timestamp: left.pubDate.toISOString(),
      geo: toGeo(left),
      source: left.source,
    },
    rightEvent: {
      id: buildStableEventId(right),
      title: right.title,
      timestamp: right.pubDate.toISOString(),
      geo: toGeo(right),
      source: right.source,
    },
    comparison,
    meta: {
      generatedBy: 'wm.event_comparison',
      version: 'v1',
    },
  };
}
