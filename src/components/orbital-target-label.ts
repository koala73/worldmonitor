import type { MatchedAcquisition } from '@/services/orbital/match';
import { t } from '@/services/i18n';
import { formatOrbitalTime } from '@/components/OrbitalWatchPage';

/** `25.1120°N 55.1390°E`, four decimals so the label matches the point that was looked up. */
export function formatTargetCoordinates(point: { lat: number; lon: number }): string {
  const lat = `${Math.abs(point.lat).toFixed(4)}\u00b0${point.lat >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(point.lon).toFixed(4)}\u00b0${point.lon >= 0 ? 'E' : 'W'}`;
  return `${lat} ${lon}`;
}

/** `ACQUIRED Sun, 8 Nov · 07:11 UTC · 10 M`: the image time in the lookup's display zone and its ground resolution. */
export function formatAcquiredLine(acquisition: Pick<MatchedAcquisition, 'startMs' | 'endMs' | 'resolutionM'>): string {
  const time = formatOrbitalTime((acquisition.startMs + acquisition.endMs) / 2, 'when');
  const resolution = acquisition.resolutionM >= 1000 ? `${Math.round(acquisition.resolutionM / 1000)} KM` : `${Math.round(acquisition.resolutionM)} M`;
  return t('orbitalWatch.replay.acquired', { time, resolution });
}
