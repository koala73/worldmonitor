import type { MatchedAcquisition } from '@/services/orbital/match';
import { getCurrentLanguageTag, t } from '@/services/i18n';

/** `25.1120°N 55.1390°E`, four decimals so the label matches the point that was looked up. */
export function formatTargetCoordinates(point: { lat: number; lon: number }): string {
  const lat = `${Math.abs(point.lat).toFixed(4)}\u00b0${point.lat >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(point.lon).toFixed(4)}\u00b0${point.lon >= 0 ? 'E' : 'W'}`;
  return `${lat} ${lon}`;
}

/** `ACQUIRED 10:51:54 GST · 10 M`: the image time in the viewer's zone and its ground resolution. */
export function formatAcquiredLine(acquisition: Pick<MatchedAcquisition, 'startMs' | 'endMs' | 'resolutionM'>, timeZone?: string): string {
  const time = new Intl.DateTimeFormat(getCurrentLanguageTag(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format((acquisition.startMs + acquisition.endMs) / 2);
  const resolution = acquisition.resolutionM >= 1000 ? `${Math.round(acquisition.resolutionM / 1000)} KM` : `${Math.round(acquisition.resolutionM)} M`;
  return t('orbitalWatch.replay.acquired', { time, resolution });
}
