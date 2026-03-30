import type { BreakingAlert } from './breaking-news-alerts';
import { getRecentBreakingAlerts } from './breaking-news-alerts';
import type { CorrelationSignal } from './correlation';
import { getRecentSignals } from './correlation';
import { buildLocalLogisticsBriefItems, getCachedLocalLogistics, type LocalLogisticsSnapshot } from './local-logistics';
import { haversineKm } from './proximity-filter';
import {
  buildSavedPlaceWeatherBriefItems,
  getCachedSavedPlaceWeather,
  type SavedPlaceWeatherSnapshot,
} from './saved-place-weather';
import { getSavedPlace, getSavedPlaces, type SavedPlace } from './saved-places';
import { isOffline, readOfflineCacheEntry, writeOfflineCacheEntry } from './offline-alert-cache';
import { getStormPreparednessForPlace, summarizeStormPreparedness, type PlaceStormPreparedness } from './storm-preparedness';

export interface PlaceBriefItem {
  kind: 'breaking' | 'signal' | 'preparedness' | 'forecast' | 'logistics';
  label: string;
  value: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  link?: string;
}

export interface PlaceBrief {
  placeId: string;
  headline: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  items: PlaceBriefItem[];
  generatedAt: Date;
  isStale: boolean;
  staleAgeMs: number;
}

interface CachedPlaceBrief {
  placeId: string;
  headline: string;
  severity: PlaceBrief['severity'];
  items: PlaceBriefItem[];
  generatedAtMs: number;
}

interface PlaceBriefOptions {
  breakingAlerts?: BreakingAlert[];
  signals?: CorrelationSignal[];
  stormPreparedness?: PlaceStormPreparedness | null;
  forecastSnapshot?: SavedPlaceWeatherSnapshot | null;
  logisticsSnapshot?: LocalLogisticsSnapshot | null;
  offline?: boolean;
  now?: number;
}

const PLACE_BRIEF_CACHE_PREFIX = 'saved-place-brief';

function placeBriefCacheKey(placeId: string): string {
  return `${PLACE_BRIEF_CACHE_PREFIX}:${placeId}`;
}

function briefSeverityFromSignal(signal: CorrelationSignal): PlaceBrief['severity'] {
  if (signal.confidence > 0.8) return 'high';
  if (signal.confidence > 0.65) return 'medium';
  return 'low';
}

function computeSeverity(items: PlaceBriefItem[]): PlaceBrief['severity'] {
  if (items.some((item) => item.severity === 'critical')) return 'critical';
  if (items.some((item) => item.severity === 'high')) return 'high';
  if (items.some((item) => item.severity === 'medium')) return 'medium';
  return 'low';
}

function isBreakingAlertNearPlace(place: SavedPlace, alert: BreakingAlert): boolean {
  if (Array.isArray(alert.placeIds) && alert.placeIds.includes(place.id)) return true;
  if (!Number.isFinite(alert.lat) || !Number.isFinite(alert.lon)) return false;
  return haversineKm(alert.lat as number, alert.lon as number, place.lat, place.lon) <= place.radiusKm;
}

function isSignalNearPlace(place: SavedPlace, signal: CorrelationSignal): boolean {
  return Array.isArray(signal.data.placeIds) && signal.data.placeIds.includes(place.id);
}

function serializeBrief(brief: PlaceBrief): CachedPlaceBrief {
  return {
    placeId: brief.placeId,
    headline: brief.headline,
    severity: brief.severity,
    items: brief.items,
    generatedAtMs: brief.generatedAt.getTime(),
  };
}

function deserializeBrief(cached: CachedPlaceBrief, now: number): PlaceBrief {
  return {
    placeId: cached.placeId,
    headline: cached.headline,
    severity: cached.severity,
    items: cached.items,
    generatedAt: new Date(cached.generatedAtMs),
    isStale: true,
    staleAgeMs: Math.max(0, now - cached.generatedAtMs),
  };
}

function buildCalmHeadline(place: SavedPlace): string {
  return `No recent critical alerts within ${place.radiusKm} km`;
}

function buildAlertItems(place: SavedPlace, breakingAlerts: BreakingAlert[]): PlaceBriefItem[] {
  return breakingAlerts
    .filter((alert) => isBreakingAlertNearPlace(place, alert))
    .sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime())
    .slice(0, 3)
    .map((alert) => ({
      kind: 'breaking' as const,
      label: alert.headline,
      value: [alert.source, alert.origin.replace(/_/g, ' ')].join(' · '),
      severity: alert.threatLevel,
      link: alert.link,
    }));
}

function buildSignalItems(place: SavedPlace, signals: CorrelationSignal[]): PlaceBriefItem[] {
  return signals
    .filter((signal) => isSignalNearPlace(place, signal))
    .sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime())
    .slice(0, 2)
    .map((signal) => ({
      kind: 'signal' as const,
      label: signal.title,
      value: signal.description,
      severity: briefSeverityFromSignal(signal),
    }));
}

function buildPreparednessItems(stormPreparedness: PlaceStormPreparedness | null): PlaceBriefItem[] {
  if (!stormPreparedness) return [];

  const summary = summarizeStormPreparedness(stormPreparedness) ?? stormPreparedness.detail;
  return [
    {
      kind: 'preparedness',
      label: stormPreparedness.headline,
      value: summary,
      severity: stormPreparedness.severity,
    },
    ...stormPreparedness.guidance.slice(0, 2).map((action) => ({
      kind: 'preparedness' as const,
      label: 'Next action',
      value: action,
      severity: stormPreparedness.severity === 'critical' ? 'high' : stormPreparedness.severity,
    })),
  ];
}

export function buildPlaceBrief(
  place: SavedPlace,
  breakingAlerts: BreakingAlert[] = [],
  signals: CorrelationSignal[] = [],
  stormPreparedness: PlaceStormPreparedness | null = null,
  forecastSnapshot: SavedPlaceWeatherSnapshot | null = null,
  logisticsSnapshot: LocalLogisticsSnapshot | null = null,
  now = Date.now(),
): PlaceBrief {
  const items = [
    ...buildPreparednessItems(stormPreparedness),
    ...buildSavedPlaceWeatherBriefItems(forecastSnapshot, 2),
    ...buildAlertItems(place, breakingAlerts),
    ...buildSignalItems(place, signals),
    ...buildLocalLogisticsBriefItems(logisticsSnapshot, 2),
  ];

  if (items.length === 0) {
    return {
      placeId: place.id,
      headline: buildCalmHeadline(place),
      severity: 'low',
      items: [
        {
          kind: 'signal',
          label: 'Local status',
          value: 'No recent saved-place matches in the live alert stream.',
          severity: 'low',
        },
      ],
      generatedAt: new Date(now),
      isStale: false,
      staleAgeMs: 0,
    };
  }

  const lead = items.find((item) => item.kind !== 'logistics');
  return {
    placeId: place.id,
    headline: lead?.label ?? buildCalmHeadline(place),
    severity: computeSeverity(items),
    items,
    generatedAt: new Date(now),
    isStale: false,
    staleAgeMs: 0,
  };
}

export function getPlaceBriefSnapshot(
  place: SavedPlace,
  options: PlaceBriefOptions = {},
): PlaceBrief {
  const now = options.now ?? Date.now();
  const breakingAlerts = options.breakingAlerts ?? getRecentBreakingAlerts();
  const signals = options.signals ?? getRecentSignals();
  const stormPreparedness = options.stormPreparedness ?? getStormPreparednessForPlace(place);
  const forecastSnapshot = options.forecastSnapshot ?? getCachedSavedPlaceWeather(place.id);
  const logisticsSnapshot = options.logisticsSnapshot ?? getCachedLocalLogistics(place.id);
  const offline = options.offline ?? isOffline();

  if (offline && breakingAlerts.length === 0 && signals.length === 0 && !stormPreparedness && !forecastSnapshot && !logisticsSnapshot) {
    const cached = readOfflineCacheEntry<CachedPlaceBrief>(placeBriefCacheKey(place.id));
    if (cached) {
      return deserializeBrief(cached.data, now);
    }
  }

  const brief = buildPlaceBrief(place, breakingAlerts, signals, stormPreparedness, forecastSnapshot, logisticsSnapshot, now);
  writeOfflineCacheEntry(placeBriefCacheKey(place.id), serializeBrief(brief));
  return brief;
}

export function getSavedPlaceBrief(placeId: string): PlaceBrief | null {
  const place = getSavedPlace(placeId);
  if (!place) return null;
  return getPlaceBriefSnapshot(place);
}

export function getSavedPlaceBriefs(): PlaceBrief[] {
  return getSavedPlaces().map((place) => getPlaceBriefSnapshot(place));
}
