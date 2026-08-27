import { ensureHydrated, getHydratedData } from '@/services/bootstrap';
import type { NaturalEvent } from '@/types';
import type { WeatherAlert } from '@/services/weather';

export interface ImdProductHealth {
  status: string;
  reason?: string | null;
  recordCount: number;
  warningCount?: number;
  carried?: boolean;
}

export interface ImdCycloneMarineSnapshot {
  coverageState?: string;
  skipReason?: string | null;
  generatedAt?: number;
  products?: Record<string, ImdProductHealth>;
  cycloneEvents?: NaturalEvent[];
  portAlerts?: WeatherAlert[];
  marineBulletins?: WeatherAlert[];
  sourceName?: string;
  sourceUrl?: string;
  attribution?: string;
}

export interface ImdMappedProducts {
  coverageState: string;
  cycloneEvents: NaturalEvent[];
  portAlerts: WeatherAlert[];
  marineBulletins: WeatherAlert[];
  sourceName: string;
  sourceUrl: string;
}

const EMPTY: ImdMappedProducts = {
  coverageState: 'unavailable',
  cycloneEvents: [],
  portAlerts: [],
  marineBulletins: [],
  sourceName: 'India Meteorological Department',
  sourceUrl: 'https://api.imd.gov.in/public/api_reference.html',
};

function asDate(value: unknown, fallback: number): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return new Date(value);
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  return new Date(fallback);
}

function mapAlert(raw: WeatherAlert, generatedAt: number): WeatherAlert {
  return {
    ...raw,
    onset: asDate(raw.onset, generatedAt),
    expires: asDate(raw.expires, generatedAt),
  };
}

function mapCyclone(raw: NaturalEvent, generatedAt: number): NaturalEvent {
  return {
    ...raw,
    date: asDate(raw.date, generatedAt),
    category: raw.category || 'severeStorms',
    closed: Boolean(raw.closed),
  };
}

export function mapImdSnapshot(snapshot: ImdCycloneMarineSnapshot | null | undefined): ImdMappedProducts {
  if (!snapshot || typeof snapshot !== 'object') return EMPTY;
  const generatedAt = Number(snapshot.generatedAt) || Date.now();
  return {
    coverageState: String(snapshot.coverageState || 'unavailable'),
    cycloneEvents: (snapshot.cycloneEvents || []).map((event) => mapCyclone(event, generatedAt)),
    portAlerts: (snapshot.portAlerts || []).map((alert) => mapAlert(alert, generatedAt)),
    marineBulletins: (snapshot.marineBulletins || []).map((alert) => mapAlert(alert, generatedAt)),
    sourceName: snapshot.sourceName || EMPTY.sourceName,
    sourceUrl: snapshot.sourceUrl || EMPTY.sourceUrl,
  };
}

export async function fetchImdCycloneMarine(): Promise<ImdMappedProducts> {
  const hydrated = (getHydratedData('imdCycloneMarine') ?? await ensureHydrated('imdCycloneMarine')) as ImdCycloneMarineSnapshot | undefined;
  if (!hydrated) return EMPTY;
  return mapImdSnapshot(hydrated);
}
