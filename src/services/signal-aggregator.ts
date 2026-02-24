/**
 * Signal Aggregator Service
 * Collects all map signals and correlates them by country/region
 * Feeds geographic context to AI Insights
 */

import type {
  InternetOutage,
  MilitaryFlight,
  MilitaryVessel,
  SocialUnrestEvent,
  AisDisruptionEvent,
} from '@/types';
import { TIER1_COUNTRIES } from '@/config/countries';

export type SignalType =
  | 'internet_outage'
  | 'military_flight'
  | 'military_vessel'
  | 'protest'
  | 'ais_disruption'
  | 'satellite_fire'        // NASA FIRMS thermal anomalies
  | 'temporal_anomaly'      // Baseline deviation alerts

export interface GeoSignal {
  type: SignalType;
  country: string;
  countryName: string;
  lat: number;
  lon: number;
  severity: 'low' | 'medium' | 'high';
  title: string;
  timestamp: Date;
}

export interface CountrySignalCluster {
  country: string;
  countryName: string;
  signals: GeoSignal[];
  signalTypes: Set<SignalType>;
  totalCount: number;
  highSeverityCount: number;
  convergenceScore: number;
}

export interface RegionalConvergence {
  region: string;
  countries: string[];
  signalTypes: SignalType[];
  totalSignals: number;
  description: string;
}

export interface SignalSummary {
  timestamp: Date;
  totalSignals: number;
  byType: Record<SignalType, number>;
  convergenceZones: RegionalConvergence[];
  topCountries: CountrySignalCluster[];
  aiContext: string;
}

const REGION_DEFINITIONS: Record<string, { countries: string[]; name: string }> = {
  middle_east: {
    name: 'Middle East',
    countries: ['IR', 'IL', 'SA', 'AE', 'IQ', 'SY', 'YE', 'JO', 'LB', 'KW', 'QA', 'OM', 'BH'],
  },
  east_asia: {
    name: 'East Asia',
    countries: ['CN', 'TW', 'JP', 'KR', 'KP', 'HK', 'MN'],
  },
  south_asia: {
    name: 'South Asia',
    countries: ['IN', 'PK', 'BD', 'AF', 'NP', 'LK', 'MM'],
  },
  europe_east: {
    name: 'Eastern Europe',
    countries: ['UA', 'RU', 'BY', 'PL', 'RO', 'MD', 'HU', 'CZ', 'SK', 'BG'],
  },
  africa_north: {
    name: 'North Africa',
    countries: ['EG', 'LY', 'DZ', 'TN', 'MA', 'SD', 'SS'],
  },
  africa_sahel: {
    name: 'Sahel Region',
    countries: ['ML', 'NE', 'BF', 'TD', 'NG', 'CM', 'CF'],
  },
};

const COUNTRY_TO_CODE: Record<string, string> = {
  'Iran': 'IR', 'Israel': 'IL', 'Saudi Arabia': 'SA', 'United Arab Emirates': 'AE',
  'Iraq': 'IQ', 'Syria': 'SY', 'Yemen': 'YE', 'Jordan': 'JO', 'Lebanon': 'LB',
  'China': 'CN', 'Taiwan': 'TW', 'Japan': 'JP', 'South Korea': 'KR', 'North Korea': 'KP',
  'India': 'IN', 'Pakistan': 'PK', 'Bangladesh': 'BD', 'Afghanistan': 'AF',
  'Ukraine': 'UA', 'Russia': 'RU', 'Belarus': 'BY', 'Poland': 'PL',
  'Egypt': 'EG', 'Libya': 'LY', 'Sudan': 'SD', 'South Sudan': 'SS',
  'United States': 'US', 'United Kingdom': 'GB', 'Germany': 'DE', 'France': 'FR',
};

function normalizeCountryCode(country: string): string {
  if (country.length === 2) return country.toUpperCase();
  return COUNTRY_TO_CODE[country] || country.slice(0, 2).toUpperCase();
}

function getCountryName(code: string): string {
  return TIER1_COUNTRIES[code] || code;
}

class SignalAggregator {
  private signals: GeoSignal[] = [];
  private readonly WINDOW_MS = 24 * 60 * 60 * 1000;
  // Tracks which source event type each temporal anomaly signal came from
  private temporalSourceMap = new WeakMap<GeoSignal, string>();

  private clearSignalType(type: SignalType): void {
    this.signals = this.signals.filter(s => s.type !== type);
  }

  ingestOutages(outages: InternetOutage[]): void {
    this.clearSignalType('internet_outage');
    for (const o of outages) {
      const code = normalizeCountryCode(o.country);
      this.signals.push({
        type: 'internet_outage',
        country: code,
        countryName: o.country,
        lat: o.lat,
        lon: o.lon,
        severity: o.severity === 'total' ? 'high' : o.severity === 'major' ? 'medium' : 'low',
        title: o.title,
        timestamp: o.pubDate,
      });
    }
    this.pruneOld();
  }

  ingestFlights(flights: MilitaryFlight[]): void {
    this.clearSignalType('military_flight');
    const countryCounts = new Map<string, number>();
    for (const f of flights) {
      const code = this.coordsToCountry(f.lat, f.lon);
      const count = countryCounts.get(code) || 0;
      countryCounts.set(code, count + 1);
    }

    for (const [code, count] of countryCounts) {
      this.signals.push({
        type: 'military_flight',
        country: code,
        countryName: getCountryName(code),
        lat: 0,
        lon: 0,
        severity: count >= 10 ? 'high' : count >= 5 ? 'medium' : 'low',
        title: `${count} military aircraft detected`,
        timestamp: new Date(),
      });
    }
    this.pruneOld();
  }

  ingestVessels(vessels: MilitaryVessel[]): void {
    this.clearSignalType('military_vessel');
    const regionCounts = new Map<string, { count: number; lat: number; lon: number }>();

    for (const v of vessels) {
      const code = this.coordsToCountry(v.lat, v.lon);
      const existing = regionCounts.get(code);
      if (existing) {
        existing.count++;
      } else {
        regionCounts.set(code, { count: 1, lat: v.lat, lon: v.lon });
      }
    }

    for (const [code, data] of regionCounts) {
      this.signals.push({
        type: 'military_vessel',
        country: code,
        countryName: getCountryName(code),
        lat: data.lat,
        lon: data.lon,
        severity: data.count >= 5 ? 'high' : data.count >= 2 ? 'medium' : 'low',
        title: `${data.count} naval vessels near region`,
        timestamp: new Date(),
      });
    }
    this.pruneOld();
  }

  ingestProtests(events: SocialUnrestEvent[]): void {
    this.clearSignalType('protest');
    const countryCounts = new Map<string, { count: number; lat: number; lon: number }>();

    for (const e of events) {
      const code = normalizeCountryCode(e.country) || this.coordsToCountry(e.lat, e.lon);
      const existing = countryCounts.get(code);
      if (existing) {
        existing.count++;
      } else {
        countryCounts.set(code, { count: 1, lat: e.lat, lon: e.lon });
      }
    }

    for (const [code, data] of countryCounts) {
      this.signals.push({
        type: 'protest',
        country: code,
        countryName: getCountryName(code),
        lat: data.lat,
        lon: data.lon,
        severity: data.count >= 10 ? 'high' : data.count >= 5 ? 'medium' : 'low',
        title: `${data.count} protest events`,
        timestamp: new Date(),
      });
    }
    this.pruneOld();
  }

  ingestAisDisruptions(events: AisDisruptionEvent[]): void {
    this.clearSignalType('ais_disruption');
    for (const e of events) {
      const code = this.coordsToCountry(e.lat, e.lon);
      // Map 'elevated' to 'medium' for our type
      const severity: 'low' | 'medium' | 'high' = e.severity === 'elevated' ? 'medium' : e.severity;
      this.signals.push({
        type: 'ais_disruption',
        country: code,
        countryName: e.name,
        lat: e.lat,
        lon: e.lon,
        severity,
        title: e.description,
        timestamp: new Date(),
      });
    }
    this.pruneOld();
  }

  // ============ NEW SIGNAL INGESTION METHODS ============

  /**
   * Ingest satellite fire detection from NASA FIRMS
   * Source: src/services/wildfires
   */
  ingestSatelliteFires(fires: Array<{
    lat: number;
    lon: number;
    brightness: number;
    frp: number;
    region: string;
    acq_date: string;
  }>): void {
    this.clearSignalType('satellite_fire');
    
    for (const fire of fires) {
      const code = this.coordsToCountry(fire.lat, fire.lon) || normalizeCountryCode(fire.region);
      const severity = fire.brightness > 360 ? 'high' : fire.brightness > 320 ? 'medium' : 'low';
      
      this.signals.push({
        type: 'satellite_fire',
        country: code,
        countryName: fire.region,
        lat: fire.lat,
        lon: fire.lon,
        severity,
        title: `Thermal anomaly detected (${Math.round(fire.brightness)}K, ${fire.frp.toFixed(1)}MW)`,
        timestamp: new Date(fire.acq_date),
      });
    }
    this.pruneOld();
  }




  /**
   * Ingest temporal baseline anomalies.
   * Deduplicates by message — safe to call from multiple async sources.
   */
  ingestTemporalAnomalies(anomalies: Array<{
    type: string;
    region: string;
    currentCount: number;
    expectedCount: number;
    zScore: number;
    message: string;
    severity: 'medium' | 'high' | 'critical';
  }>): void {
    // Remove existing temporal signals that match incoming source types
    const incomingSourceTypes = new Set(anomalies.map(a => a.type));
    this.signals = this.signals.filter(s =>
      s.type !== 'temporal_anomaly' ||
      !incomingSourceTypes.has(this.temporalSourceMap.get(s) || '')
    );

    for (const a of anomalies) {
      const signal: GeoSignal = {
        type: 'temporal_anomaly',
        country: 'XX',
        countryName: a.region,
        lat: 0,
        lon: 0,
        severity: a.severity === 'critical' ? 'high' : a.severity === 'high' ? 'high' : 'medium',
        title: a.message,
        timestamp: new Date(),
      };
      this.signals.push(signal);
      this.temporalSourceMap.set(signal, a.type);
    }
    this.pruneOld();
  }

  private coordsToCountry(lat: number, lon: number): string {
    if (lat >= 25 && lat <= 40 && lon >= 44 && lon <= 63) return 'IR';
    if (lat >= 29 && lat <= 33 && lon >= 34 && lon <= 36) return 'IL';
    if (lat >= 15 && lat <= 32 && lon >= 34 && lon <= 55) return 'SA';
    if (lat >= 20 && lat <= 55 && lon >= 73 && lon <= 135) return 'CN';
    if (lat >= 22 && lat <= 25 && lon >= 120 && lon <= 122) return 'TW';
    if (lat >= 8 && lat <= 37 && lon >= 68 && lon <= 97) return 'IN';
    if (lat >= 44 && lat <= 52 && lon >= 22 && lon <= 40) return 'UA';
    if (lat >= 50 && lat <= 82 && lon >= 20 && lon <= 180) return 'RU';
    if (lat >= 22 && lat <= 32 && lon >= 25 && lon <= 35) return 'EG';
    return 'XX';
  }

  private pruneOld(): void {
    const cutoff = Date.now() - this.WINDOW_MS;
    this.signals = this.signals.filter(s => s.timestamp.getTime() > cutoff);
  }

  getCountryClusters(): CountrySignalCluster[] {
    const byCountry = new Map<string, GeoSignal[]>();

    for (const s of this.signals) {
      const existing = byCountry.get(s.country) || [];
      existing.push(s);
      byCountry.set(s.country, existing);
    }

    const clusters: CountrySignalCluster[] = [];

    for (const [country, signals] of byCountry) {
      const signalTypes = new Set(signals.map(s => s.type));
      const highCount = signals.filter(s => s.severity === 'high').length;

      const typeBonus = signalTypes.size * 20;
      const countBonus = Math.min(30, signals.length * 5);
      const severityBonus = highCount * 10;
      const convergenceScore = Math.min(100, typeBonus + countBonus + severityBonus);

      clusters.push({
        country,
        countryName: getCountryName(country),
        signals,
        signalTypes,
        totalCount: signals.length,
        highSeverityCount: highCount,
        convergenceScore,
      });
    }

    return clusters.sort((a, b) => b.convergenceScore - a.convergenceScore);
  }

  getRegionalConvergence(): RegionalConvergence[] {
    const clusters = this.getCountryClusters();
    const convergences: RegionalConvergence[] = [];

    for (const [_regionId, def] of Object.entries(REGION_DEFINITIONS)) {
      const regionClusters = clusters.filter(c => def.countries.includes(c.country));
      if (regionClusters.length < 2) continue;

      const allTypes = new Set<SignalType>();
      let totalSignals = 0;

      for (const cluster of regionClusters) {
        cluster.signalTypes.forEach(t => allTypes.add(t));
        totalSignals += cluster.totalCount;
      }

      if (allTypes.size >= 2) {
        const typeLabels: Record<SignalType, string> = {
          internet_outage: 'internet disruptions',
          military_flight: 'military air activity',
          military_vessel: 'naval presence',
          protest: 'civil unrest',
          ais_disruption: 'shipping anomalies',
          satellite_fire: 'thermal anomalies',
          temporal_anomaly: 'baseline anomalies',
        };

        const typeDescriptions = [...allTypes].map(t => typeLabels[t]).join(', ');
        const countries = regionClusters.map(c => c.countryName).join(', ');

        convergences.push({
          region: def.name,
          countries: regionClusters.map(c => c.country),
          signalTypes: [...allTypes],
          totalSignals,
          description: `${def.name}: ${typeDescriptions} detected across ${countries}`,
        });
      }
    }

    return convergences.sort((a, b) => b.signalTypes.length - a.signalTypes.length);
  }

  generateAIContext(): string {
    const clusters = this.getCountryClusters().slice(0, 5);
    const convergences = this.getRegionalConvergence().slice(0, 3);

    if (clusters.length === 0 && convergences.length === 0) {
      return '';
    }

    const lines: string[] = ['[GEOGRAPHIC SIGNALS]'];

    if (convergences.length > 0) {
      lines.push('Regional convergence detected:');
      for (const c of convergences) {
        lines.push(`- ${c.description}`);
      }
    }

    if (clusters.length > 0) {
      lines.push('Top countries by signal activity:');
      for (const c of clusters) {
        const types = [...c.signalTypes].join(', ');
        lines.push(`- ${c.countryName}: ${c.totalCount} signals (${types}), convergence score: ${c.convergenceScore}`);
      }
    }

    return lines.join('\n');
  }

  getSummary(): SignalSummary {
    const byType: Record<SignalType, number> = {
      internet_outage: 0,
      military_flight: 0,
      military_vessel: 0,
      protest: 0,
      ais_disruption: 0,
      satellite_fire: 0,
      temporal_anomaly: 0,
    };

    for (const s of this.signals) {
      byType[s.type]++;
    }

    return {
      timestamp: new Date(),
      totalSignals: this.signals.length,
      byType,
      convergenceZones: this.getRegionalConvergence(),
      topCountries: this.getCountryClusters().slice(0, 10),
      aiContext: this.generateAIContext(),
    };
  }

  clear(): void {
    this.signals = [];
  }

  getSignalCount(): number {
    return this.signals.length;
  }
}

export const signalAggregator = new SignalAggregator();

export function logSignalSummary(): void {
  const summary = signalAggregator.getSummary();

  console.group('%c[Signal Aggregator]', 'color: #6b8afd; font-weight: bold');
  console.log(`Total signals: ${summary.totalSignals}`);
  console.log('By type:', summary.byType);

  if (summary.convergenceZones.length > 0) {
    console.log('%cConvergence Zones:', 'color: #f59e0b; font-weight: bold');
    for (const z of summary.convergenceZones) {
      console.log(`  ${z.description}`);
    }
  }

  if (summary.topCountries.length > 0) {
    console.log('%cTop Countries:', 'color: #4ade80; font-weight: bold');
    for (const c of summary.topCountries.slice(0, 5)) {
      console.log(`  ${c.countryName}: ${c.totalCount} signals, score ${c.convergenceScore}`);
    }
  }

  console.groupEnd();
}
