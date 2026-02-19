import type { AirportDelayAlert, FlightDelaySeverity, FlightDelayType, MonitoredAirport } from '@/types';
import { MONITORED_AIRPORTS, FAA_AIRPORTS, DELAY_SEVERITY_THRESHOLDS } from '@/config/airports';
import { createCircuitBreaker, fetchWithCache } from '@/utils';

interface FAADelayInfo {
  airport: string;
  reason: string;
  avgDelay?: number;
  type: FlightDelayType;
}

const breaker = createCircuitBreaker<AirportDelayAlert[]>({ name: 'FAA Flight Delays' });
let faaCache: { data: Map<string, FAADelayInfo>; timestamp: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function determineSeverity(avgDelayMinutes: number, delayedPct?: number): FlightDelaySeverity {
  const t = DELAY_SEVERITY_THRESHOLDS;
  if (avgDelayMinutes >= t.severe.avgDelayMinutes || (delayedPct && delayedPct >= t.severe.delayedPct)) {
    return 'severe';
  }
  if (avgDelayMinutes >= t.major.avgDelayMinutes || (delayedPct && delayedPct >= t.major.delayedPct)) {
    return 'major';
  }
  if (avgDelayMinutes >= t.moderate.avgDelayMinutes || (delayedPct && delayedPct >= t.moderate.delayedPct)) {
    return 'moderate';
  }
  if (avgDelayMinutes >= t.minor.avgDelayMinutes || (delayedPct && delayedPct >= t.minor.delayedPct)) {
    return 'minor';
  }
  return 'normal';
}

function parseDelayTypeFromReason(reason: string): FlightDelayType {
  const r = reason.toLowerCase();
  if (r.includes('ground stop')) return 'ground_stop';
  if (r.includes('ground delay') || r.includes('gdp')) return 'ground_delay';
  if (r.includes('departure')) return 'departure_delay';
  if (r.includes('arrival')) return 'arrival_delay';
  if (r.includes('clos')) return 'ground_stop';
  return 'general';
}

function parseXMLDelays(xml: string): Map<string, FAADelayInfo> {
  const delays = new Map<string, FAADelayInfo>();
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');

  // Parse ground delays
  const groundDelays = doc.querySelectorAll('Ground_Delay_List Ground_Delay');
  groundDelays.forEach((node) => {
    const arpt = node.querySelector('ARPT')?.textContent;
    const reason = node.querySelector('Reason')?.textContent || 'Ground delay';
    const avgDelay = node.querySelector('Avg')?.textContent;
    if (arpt) {
      delays.set(arpt, {
        airport: arpt,
        reason,
        avgDelay: avgDelay ? parseInt(avgDelay, 10) : 30,
        type: 'ground_delay',
      });
    }
  });

  // Parse ground stops
  const groundStops = doc.querySelectorAll('Ground_Stop_List Ground_Stop');
  groundStops.forEach((node) => {
    const arpt = node.querySelector('ARPT')?.textContent;
    const reason = node.querySelector('Reason')?.textContent || 'Ground stop';
    if (arpt) {
      delays.set(arpt, {
        airport: arpt,
        reason,
        avgDelay: 60,
        type: 'ground_stop',
      });
    }
  });

  // Parse arrival/departure delays
  const arrDepDelays = doc.querySelectorAll('Arrival_Departure_Delay_List Delay');
  arrDepDelays.forEach((node) => {
    const arpt = node.querySelector('ARPT')?.textContent;
    const reason = node.querySelector('Reason')?.textContent || 'Delays';
    const minDelay = node.querySelector('Arrival_Delay Min')?.textContent || node.querySelector('Departure_Delay Min')?.textContent;
    const maxDelay = node.querySelector('Arrival_Delay Max')?.textContent || node.querySelector('Departure_Delay Max')?.textContent;
    if (arpt) {
      const min = minDelay ? parseInt(minDelay, 10) : 15;
      const max = maxDelay ? parseInt(maxDelay, 10) : 30;
      const existing = delays.get(arpt);
      if (!existing || existing.type !== 'ground_stop') {
        delays.set(arpt, {
          airport: arpt,
          reason,
          avgDelay: Math.round((min + max) / 2),
          type: parseDelayTypeFromReason(reason),
        });
      }
    }
  });

  // Parse closures
  const closures = doc.querySelectorAll('Airport_Closure_List Airport');
  closures.forEach((node) => {
    const arpt = node.querySelector('ARPT')?.textContent;
    if (arpt && FAA_AIRPORTS.includes(arpt)) {
      delays.set(arpt, {
        airport: arpt,
        reason: 'Airport closure',
        avgDelay: 120,
        type: 'ground_stop',
      });
    }
  });

  return delays;
}

async function fetchFAADelays(): Promise<Map<string, FAADelayInfo>> {
  if (faaCache && Date.now() - faaCache.timestamp < CACHE_TTL) {
    return faaCache.data;
  }

  try {
    const url = '/api/faa-status';

    const xml = await fetchWithCache<string>(url, {
      ttl: 120_000,
      headers: { Accept: 'application/xml' },
      parseAs: 'text',
    });
    const delays = parseXMLDelays(xml);

    faaCache = { data: delays, timestamp: Date.now() };
    console.log(`[Flights] FAA reports ${delays.size} airports with delays`);
    return delays;
  } catch (error) {
    console.error('[Flights] Failed to fetch FAA NASSTATUS:', error);
    return new Map();
  }
}

function generateSimulatedDelay(airport: MonitoredAirport): AirportDelayAlert {
  // Simulated delays based on typical patterns
  // In production, this would be replaced with real API data
  const hour = new Date().getUTCHours();
  const isRushHour = (hour >= 6 && hour <= 10) || (hour >= 16 && hour <= 20);

  // Higher chance of delays during rush hours and at busier airports
  const busyAirports = ['LHR', 'CDG', 'FRA', 'JFK', 'LAX', 'ORD', 'PEK', 'HND', 'DXB', 'SIN'];
  const isBusy = busyAirports.includes(airport.iata);

  // Random factor with weighted probability
  const random = Math.random();
  const delayChance = isRushHour ? 0.35 : 0.15;
  const hasDelay = random < (isBusy ? delayChance * 1.5 : delayChance);

  let avgDelayMinutes = 0;
  let delayType: FlightDelayType = 'general';
  let reason: string | undefined;

  if (hasDelay) {
    // Generate realistic delay values
    const severityRoll = Math.random();
    if (severityRoll < 0.05) {
      // Severe (5% of delays)
      avgDelayMinutes = 60 + Math.floor(Math.random() * 60);
      delayType = Math.random() < 0.3 ? 'ground_stop' : 'ground_delay';
      reason = Math.random() < 0.5 ? 'Weather conditions' : 'Air traffic volume';
    } else if (severityRoll < 0.2) {
      // Major (15% of delays)
      avgDelayMinutes = 45 + Math.floor(Math.random() * 20);
      delayType = 'ground_delay';
      reason = Math.random() < 0.5 ? 'Weather' : 'High traffic volume';
    } else if (severityRoll < 0.5) {
      // Moderate (30% of delays)
      avgDelayMinutes = 25 + Math.floor(Math.random() * 20);
      delayType = Math.random() < 0.5 ? 'departure_delay' : 'arrival_delay';
      reason = 'Congestion';
    } else {
      // Minor (50% of delays)
      avgDelayMinutes = 15 + Math.floor(Math.random() * 15);
      delayType = 'general';
      reason = 'Minor delays';
    }
  }

  return {
    id: `sim-${airport.iata}`,
    iata: airport.iata,
    icao: airport.icao,
    name: airport.name,
    city: airport.city,
    country: airport.country,
    lat: airport.lat,
    lon: airport.lon,
    region: airport.region,
    delayType,
    severity: determineSeverity(avgDelayMinutes),
    avgDelayMinutes,
    reason,
    source: 'computed',
    updatedAt: new Date(),
  };
}

export async function fetchFlightDelays(): Promise<AirportDelayAlert[]> {
  return breaker.execute(async () => {
    const alerts: AirportDelayAlert[] = [];
    const faaDelays = await fetchFAADelays();

    for (const iata of FAA_AIRPORTS) {
      const airport = MONITORED_AIRPORTS.find((a) => a.iata === iata);
      if (!airport) continue;

      const faaDelay = faaDelays.get(iata);
      if (faaDelay) {
        alerts.push({
          id: `faa-${iata}`,
          iata,
          icao: airport.icao,
          name: airport.name,
          city: airport.city,
          country: airport.country,
          lat: airport.lat,
          lon: airport.lon,
          region: airport.region,
          delayType: faaDelay.type,
          severity: determineSeverity(faaDelay.avgDelay || 30),
          avgDelayMinutes: faaDelay.avgDelay || 30,
          reason: faaDelay.reason,
          source: 'faa',
          updatedAt: new Date(),
        });
      }
    }

    // For non-US airports, generate simulated data
    const nonUsAirports = MONITORED_AIRPORTS.filter((a) => a.country !== 'USA');
    for (const airport of nonUsAirports) {
      const simulated = generateSimulatedDelay(airport);
      if (simulated.severity !== 'normal') {
        alerts.push(simulated);
      }
    }

    return alerts;
  }, []);
}

export function getFlightsStatus(): string {
  return breaker.getStatus();
}

export function getAirportByCode(code: string): MonitoredAirport | undefined {
  return MONITORED_AIRPORTS.find(
    (a) => a.iata === code.toUpperCase() || a.icao === code.toUpperCase()
  );
}

export function getAllMonitoredAirports(): MonitoredAirport[] {
  return MONITORED_AIRPORTS;
}
