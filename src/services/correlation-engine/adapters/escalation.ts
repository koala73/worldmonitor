// boundary-ignore: AppContext is an aggregate type that lives in app/ by design
import type { AppContext } from '@/app/app-context';
import type { DomainAdapter, SignalEvidence } from '../types';
import { matchCountryNamesInText, getCountryAtCoordinates, nameToCountryCode, getCountryNameByCode, iso3ToIso2Code } from '@/services/country-geometry';

// v1 weights: displacement and cii_delta deferred — renormalized to sum to 1.0.
const WEIGHTS: Record<string, number> = {
  conflict_event: 0.45,
  escalation_outage: 0.25,
  news_severity: 0.30,
};

function normalizeToCode(country: string | undefined, lat?: number, lon?: number): string | undefined {
  const trimmed = country?.trim();
  if (trimmed) {
    const fromName = nameToCountryCode(trimmed);
    if (fromName) return fromName;
    if (trimmed.length === 3) {
      const fromIso3 = iso3ToIso2Code(trimmed);
      if (fromIso3) return fromIso3;
    }
    if (trimmed.length === 2) return trimmed.toUpperCase();
  }
  if (lat != null && lon != null && !(lat === 0 && lon === 0)) {
    const geo = getCountryAtCoordinates(lat, lon);
    if (geo?.code) return geo.code;
  }
  return undefined;
}

const ESCALATION_KEYWORDS = /\b((?:military|armed|air)\s*(?:strike|attack|offensive)|invasion|bombing|missile|airstrike|shelling|drone\s+strike|war(?:fare)?|ceasefire|martial\s+law|armed\s+clash(?:es)?|gunfire|coup(?:\s+attempt)?|insurgent|rebel|militia|terror(?:ist|ism)|hostage|siege|blockade|mobiliz(?:ation|e)|escalat(?:ion|ing|e)|retaliat|deploy(?:ment|ed)|incursion|annex(?:ation|ed)|occupation|humanitarian\s+crisis|refugee|evacuat|nuclear|chemical\s+weapon|biological\s+weapon)\b/i;

export const escalationAdapter: DomainAdapter = {
  domain: 'escalation',
  label: 'Escalation Monitor',
  clusterMode: 'country',
  spatialRadius: 0,
  timeWindow: 48,
  threshold: 20,
  weights: WEIGHTS,

  collectSignals(ctx: AppContext): SignalEvidence[] {
    const signals: SignalEvidence[] = [];
    const now = Date.now();
    const windowMs = 48 * 60 * 60 * 1000;
    const cache = ctx.intelligenceCache;

    // Conflict/protest events — ProtestSeverity is 'low' | 'medium' | 'high'
    const protests = cache.protests?.events ?? [];
    for (const p of protests) {
      const age = now - (p.time?.getTime?.() ?? now);
      if (age > windowMs) continue;

      const normalizedCountry = normalizeToCode(p.country, p.lat, p.lon);
      if (!normalizedCountry) continue;

      const severityMap: Record<string, number> = { high: 85, medium: 55, low: 30 };
      const severity = severityMap[p.severity] ?? 40;

      signals.push({
        type: 'conflict_event',
        source: 'signal-aggregator',
        severity,
        lat: p.lat,
        lon: p.lon,
        country: normalizedCountry,
        timestamp: p.time?.getTime?.() ?? now,
        label: `${p.eventType}: ${p.title}`,
        rawData: p,
      });
    }

    // Internet outages — skip 0/0 sentinel coordinates
    const outages = cache.outages ?? [];
    for (const o of outages) {
      const age = now - (o.pubDate?.getTime?.() ?? now);
      if (age > windowMs) continue;
      if (o.lat != null && o.lon != null && o.lat === 0 && o.lon === 0) continue;

      const normalizedCountry = normalizeToCode(o.country, o.lat, o.lon);
      if (!normalizedCountry) continue;

      const severityMap: Record<string, number> = { total: 90, major: 70, partial: 40 };
      const severity = severityMap[o.severity] ?? 30;

      signals.push({
        type: 'escalation_outage',
        source: 'signal-aggregator',
        severity,
        lat: o.lat,
        lon: o.lon,
        country: normalizedCountry,
        timestamp: o.pubDate?.getTime?.() ?? now,
        label: `${o.severity} outage: ${o.title}`,
        rawData: o,
      });
    }

    // High-severity news clusters — extract country from title
    const clusters = ctx.latestClusters ?? [];
    for (const c of clusters) {
      if (!c.threat || c.threat.level === 'info' || c.threat.level === 'low') continue;
      const age = now - (c.lastUpdated.getTime());
      if (age > windowMs) continue;
      if (!ESCALATION_KEYWORDS.test(c.primaryTitle)) continue;

      const severity = c.threat.level === 'critical' ? 85
        : c.threat.level === 'high' ? 65
        : 45;

      // Extract country from title text
      const matchedCountries = matchCountryNamesInText(c.primaryTitle);
      const normalizedCountry = normalizeToCode(matchedCountries[0], c.lat, c.lon);
      if (!normalizedCountry) continue;

      signals.push({
        type: 'news_severity',
        source: 'analysis-core',
        severity,
        lat: c.lat,
        lon: c.lon,
        country: normalizedCountry,
        timestamp: c.lastUpdated.getTime(),
        label: c.primaryTitle,
        rawData: c,
      });
    }

    // Only keep outage signals for countries that also have conflict events
    const conflictCountries = new Set(
      signals.filter(s => s.type === 'conflict_event').map(s => s.country).filter(Boolean),
    );
    return signals.filter(s => s.type !== 'escalation_outage' || conflictCountries.has(s.country));
  },

  generateTitle(cluster: SignalEvidence[]): string {
    const types = new Set(cluster.map(s => s.type));
    const countries = [...new Set(cluster.map(s => s.country).filter(Boolean))];
    const code = countries[0];
    const countryLabel = code ? getCountryNameByCode(code) ?? code : 'Unknown';

    const parts: string[] = [];
    if (types.has('conflict_event')) parts.push('conflict');
    if (types.has('escalation_outage')) parts.push('comms disruption');
    if (types.has('news_severity')) parts.push('news escalation');

    return parts.length > 0
      ? `${parts.join(' + ')} \u2014 ${countryLabel}`
      : `Escalation signals \u2014 ${countryLabel}`;
  },
};
