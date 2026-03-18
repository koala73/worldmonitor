// boundary-ignore: AppContext is an aggregate type that lives in app/ by design
import type { AppContext } from '@/app/app-context';
import type { DomainAdapter, SignalEvidence } from '../types';

// v1 weights: only military_flight, ais_gap, military_vessel collected.
// gps_jamming and base_activity deferred — renormalized to sum to 1.0.
const WEIGHTS: Record<string, number> = {
  military_flight: 0.40,
  ais_gap: 0.30,
  military_vessel: 0.30,
};

const STRIKE_TYPES = new Set(['fighter', 'bomber', 'attack']);
const SUPPORT_TYPES = new Set(['tanker', 'awacs', 'surveillance', 'electronic_warfare']);

export const militaryAdapter: DomainAdapter = {
  domain: 'military',
  label: 'Force Posture',
  clusterMode: 'geographic',
  spatialRadius: 500,
  timeWindow: 24,
  threshold: 20,
  weights: WEIGHTS,

  collectSignals(ctx: AppContext): SignalEvidence[] {
    const signals: SignalEvidence[] = [];
    const now = Date.now();
    const windowMs = 24 * 60 * 60 * 1000;
    const cache = ctx.intelligenceCache;

    // Military flights
    const flights = cache.military?.flights ?? [];
    for (const f of flights) {
      const age = now - (f.lastSeen?.getTime?.() ?? now);
      if (age > windowMs) continue;

      const isStrike = STRIKE_TYPES.has(f.aircraftType);
      const isSupport = SUPPORT_TYPES.has(f.aircraftType);
      const severity = isStrike ? 80 : isSupport ? 60 : 55;

      signals.push({
        type: 'military_flight',
        source: 'signal-aggregator',
        severity,
        lat: f.lat,
        lon: f.lon,
        country: f.operatorCountry,
        timestamp: f.lastSeen?.getTime?.() ?? now,
        label: `${f.operator} ${f.aircraftType} ${f.callsign}`,
        rawData: f,
      });
    }

    // Military vessels + AIS gap detection
    const vessels = cache.military?.vessels ?? [];
    for (const v of vessels) {
      const age = now - (v.lastAisUpdate?.getTime?.() ?? now);
      if (age > windowMs) continue;

      // Dark vessels (AIS gap) are a separate, high-severity signal
      if (v.isDark || (v.aisGapMinutes != null && v.aisGapMinutes > 60)) {
        const gapSeverity = v.aisGapMinutes != null
          ? Math.min(100, 50 + v.aisGapMinutes / 10)
          : 75;
        signals.push({
          type: 'ais_gap',
          source: 'signal-aggregator',
          severity: gapSeverity,
          lat: v.lat,
          lon: v.lon,
          country: v.operatorCountry,
          timestamp: v.lastAisUpdate?.getTime?.() ?? now,
          label: `AIS dark: ${v.name} (${v.aisGapMinutes ?? '?'}min gap)`,
          rawData: v,
        });
      }

      const severity = v.vesselType === 'carrier' ? 90
        : v.vesselType === 'destroyer' ? 70
        : v.vesselType === 'submarine' ? 80
        : 50;

      signals.push({
        type: 'military_vessel',
        source: 'signal-aggregator',
        severity,
        lat: v.lat,
        lon: v.lon,
        country: v.operatorCountry,
        timestamp: v.lastAisUpdate?.getTime?.() ?? now,
        label: `${v.operator} ${v.vesselType} ${v.name}`,
        rawData: v,
      });
    }

    return signals;
  },

  generateTitle(cluster: SignalEvidence[]): string {
    const types = new Set(cluster.map(s => s.type));
    const countries = [...new Set(cluster.map(s => s.country).filter(Boolean))];
    const countryLabel = countries.slice(0, 2).join('/') || 'Unknown region';

    const hasFlights = types.has('military_flight');
    const hasVessels = types.has('military_vessel');

    const flightTypes = new Set(
      cluster
        .filter(s => s.type === 'military_flight')
        .map(s => (s.rawData as { aircraftType?: string })?.aircraftType)
        .filter(Boolean),
    );
    const hasStrikePackage = [...STRIKE_TYPES].some(t => flightTypes.has(t)) &&
                             [...SUPPORT_TYPES].some(t => flightTypes.has(t));

    if (hasStrikePackage) return `Strike packaging detected \u2014 ${countryLabel}`;
    if (hasFlights && hasVessels) return `Combined air-naval activity \u2014 ${countryLabel}`;
    if (hasFlights) return `Military flight cluster \u2014 ${countryLabel}`;
    if (hasVessels) return `Naval vessel concentration \u2014 ${countryLabel}`;
    return `Military activity convergence \u2014 ${countryLabel}`;
  },
};
