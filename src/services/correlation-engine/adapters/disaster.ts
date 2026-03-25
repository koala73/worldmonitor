// boundary-ignore: AppContext is an aggregate type that lives in app/ by design
import type { AppContext } from '@/app/app-context';
import type { DomainAdapter, SignalEvidence } from '../types';

// v1 weights: wildfire and cable_alert deferred — renormalized to sum to 1.0.
const WEIGHTS: Record<string, number> = {
  earthquake: 0.55,
  infra_outage: 0.45,
};

export const disasterAdapter: DomainAdapter = {
  domain: 'disaster',
  label: 'Disaster Cascade',
  clusterMode: 'geographic',
  spatialRadius: 500,
  timeWindow: 96,
  threshold: 20,
  weights: WEIGHTS,

  collectSignals(ctx: AppContext): SignalEvidence[] {
    const signals: SignalEvidence[] = [];
    const now = Date.now();
    const windowMs = 96 * 60 * 60 * 1000;
    const cache = ctx.intelligenceCache;

    // Earthquakes (proto type: location?.latitude/longitude, occurredAt: number)
    const quakes = cache.earthquakes ?? [];
    for (const q of quakes) {
      const age = now - (q.occurredAt ?? now);
      if (age > windowMs) continue;
      if (q.location?.latitude == null || q.location?.longitude == null) continue;

      // Severity from magnitude: M2=10, M3=20, M4=35, M5=55, M6=75, M7+=95
      const severity = Math.min(100, Math.max(10, (q.magnitude - 1.5) * 17));

      signals.push({
        type: 'earthquake',
        source: 'usgs',
        severity,
        lat: q.location.latitude,
        lon: q.location.longitude,
        timestamp: q.occurredAt,
        label: `M${q.magnitude.toFixed(1)} \u2014 ${q.place}`,
        rawData: q,
      });
    }

    // Infrastructure outages — exclude outages in countries with active conflict
    // events (those are already captured by the escalation adapter to avoid
    // inflating correlation scores with duplicate signals)
    const conflictCountries = new Set(
      (cache.protests?.events ?? [])
        .filter(p => {
          const age = now - (p.time?.getTime?.() ?? now);
          return age <= windowMs;
        })
        .map(p => p.country)
        .filter(Boolean),
    );
    const outages = cache.outages ?? [];
    for (const o of outages) {
      const age = now - (o.pubDate?.getTime?.() ?? now);
      if (age > windowMs) continue;
      if (o.country && conflictCountries.has(o.country)) continue;
      // Skip outages with sentinel 0/0 coordinates (no real location)
      if (o.lat == null || o.lon == null || (o.lat === 0 && o.lon === 0)) continue;

      const severityMap: Record<string, number> = { total: 90, major: 70, partial: 40 };

      signals.push({
        type: 'infra_outage',
        source: 'signal-aggregator',
        severity: severityMap[o.severity] ?? 30,
        lat: o.lat,
        lon: o.lon,
        country: o.country,
        timestamp: o.pubDate?.getTime?.() ?? now,
        label: `Infra outage: ${o.title}`,
        rawData: o,
      });
    }

    // TODO: Add wildfire (FIRMS) and cable health signals when available
    // in AppContext.intelligenceCache.

    return signals;
  },

  generateTitle(cluster: SignalEvidence[]): string {
    const types = new Set(cluster.map(s => s.type));
    const parts: string[] = [];

    if (types.has('earthquake')) {
      const maxMag = Math.max(
        ...cluster
          .filter(s => s.type === 'earthquake')
          .map(s => (s.rawData as { magnitude?: number })?.magnitude ?? 0),
      );
      parts.push(`M${maxMag.toFixed(1)} seismic`);
    }
    if (types.has('infra_outage')) parts.push('infra disruption');

    const quakePlace = cluster.find(s => s.type === 'earthquake')?.label?.split('\u2014')[1]?.trim();

    return parts.length > 0
      ? `Disaster cascade: ${parts.join(' + ')}${quakePlace ? ` \u2014 ${quakePlace}` : ''}`
      : 'Disaster convergence detected';
  },
};
