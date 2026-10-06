import type { RawSignalsValue, RawSignalsResult, RawSignalOutcome } from './country-raw-signals';

export type { RawSignalsValue, RawSignalsResult, RawSignalOutcome } from './country-raw-signals';
export const RAW_SIGNAL_FAMILIES = ['earthquakes', 'outages', 'advisories', 'thermal'] as const;
export type RawSignalFamily = typeof RAW_SIGNAL_FAMILIES[number];
export const RAW_SIGNAL_PATH = '/__country-view/signals-raw';
export const RAW_SIGNAL_BODY_BYTES = 524288;
export const RAW_SIGNAL_ENVELOPE_BYTES = 131072;
export const RAW_SIGNAL_READS = {
  earthquakes: '/api/seismology/v1/list-earthquakes?page_size=500',
  outages: '/api/infrastructure/v1/list-internet-outages',
  advisories: '/api/intelligence/v1/list-security-advisories',
  thermal: '/api/thermal/v1/list-thermal-escalations?max_items=12',
} as const;

export const RAW_SIGNAL_PROFILES = {
  earthquakes: { scope: 'Returned global weekly USGS and NRCan earthquake sample, at most 500 events; country matches only.', attribution: 'USGS and Natural Resources Canada (NRCan). Original event times; provider completeness is unknown.', observationWindow: 'Weekly USGS feed and NRCan merge' },
  outages: { scope: 'Curated Cloudflare Radar observations from the 28-day, at most 50-annotation profile; includes ended outages and supported first locations.', attribution: 'Cloudflare Radar Internet outage observations.', observationWindow: '28-day producer profile' },
  advisories: { scope: 'Returned recency-sorted advisory sample, at most 15 rows per publisher; full country index is not counted. Producer success is unknown.', attribution: 'Travel advisory publishers identified on each returned row.', observationWindow: null },
  thermal: { scope: 'First 12 global thermal clusters, then country filter. Reported window is producer metadata; capture time and complete coverage are unknown.', attribution: 'Derived thermal watch combines NASA FIRMS, Canadian Wildland Fire Information System (CWFIS), and British Columbia wildfire inputs.', observationWindow: 'Reported producer window' },
} as const;

export function failedRawSignal(family: RawSignalFamily, state: 'locked' | 'unavailable', retrievedAt: string, reason: string): RawSignalOutcome {
  return { ...RAW_SIGNAL_PROFILES[family], state, records: null, partial: false, snapshotAt: null, computationAt: null, sourceVersion: null, retrievedAt, reason };
}

export function assembleRawSignals(countryCode: string, sources: RawSignalsValue['sources'], retrievedAt: string): RawSignalsResult {
  const outcomes = Object.values(sources);
  return { section: 'signalsRaw', state: outcomes.some(source => source.state === 'observed') ? 'ready' : outcomes.every(source => source.state === 'locked') ? 'locked' : 'unavailable',
    value: { countryCode, sources, missing: RAW_SIGNAL_FAMILIES.filter(family => sources[family].state !== 'observed' || sources[family].partial) }, retrievedAt };
}

export function projectRawSignals(value: RawSignalsValue, countryName: string, hasGeography: boolean, contains: (lat: number, lon: number) => boolean) {
  const { sources, countryCode } = value;
  const exact = (source: RawSignalOutcome) => source.state === 'observed' && !source.partial;
  const earthquakes = hasGeography && exact(sources.earthquakes) ? sources.earthquakes.records!.filter(row => contains(row.location.latitude, row.location.longitude)).length : null;
  const outages = exact(sources.outages) ? sources.outages.records!.filter(row => row.country.toLowerCase() === countryName.toLowerCase() || hasGeography && contains(row.location.latitude, row.location.longitude)).length : null;
  const rows = exact(sources.advisories) ? sources.advisories.records!.filter(row => row.country === countryCode) : null;
  const rank: Record<string, number> = { 'do-not-travel': 4, reconsider: 3, caution: 2, normal: 1, info: 0 };
  let travelAdvisoryMaxLevel: string | null = null;
  for (const row of rows ?? []) if ((rank[row.level] ?? 0) > (rank[travelAdvisoryMaxLevel ?? ''] ?? 0)) travelAdvisoryMaxLevel = row.level;
  const thermalEscalations = exact(sources.thermal) ? sources.thermal.records!.filter(row => row.countryCode === countryCode && row.status !== 'normal').length : null;
  return { earthquakes, outages, travelAdvisories: rows?.length ?? null, travelAdvisoryMaxLevel, thermalEscalations };
}
