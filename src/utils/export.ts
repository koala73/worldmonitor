import type { NewsItem, ClusteredEvent, MarketData, CyberThreat, Monitor } from '@/types';
import type { PredictionMarket } from '@/services/prediction';
import type { IntelligenceCache } from '@/app/app-context';
import type { GpsJamData } from '@/services/gps-interference';
import type { ConvergenceCard } from '@/services/correlation-engine';
import { t } from '@/services/i18n';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';


type ExportFormat = 'json' | 'csv';

export interface ExportMeta {
  exportedAt: string;
  note: string;
}

export interface ExportData {
  meta?: ExportMeta;
  timestamp: number;
  news?: NewsItem[];
  newsClusters?: ClusteredEvent[];
  newsByCategory?: Record<string, NewsItem[]>;
  markets?: MarketData[];
  predictions?: PredictionMarket[];
  intelligence?: IntelligenceCache;
  cyberThreats?: CyberThreat[];
  gpsJamming?: GpsJamData;
  convergenceCards?: Omit<ConvergenceCard, 'assessment'>[];
  monitors?: Monitor[];
}

// Strip LLM-derived threat annotations so AI does not feed back into itself.
// Keyword and ML (local model) classifications are retained.
function sanitizeNewsItem(item: NewsItem): NewsItem {
  if (item.threat?.source !== 'llm') return item;
  const { threat: _t, ...rest } = item;
  return rest as NewsItem;
}

function sanitizeCluster(cluster: ClusteredEvent): ClusteredEvent {
  return {
    ...cluster,
    threat: cluster.threat?.source === 'llm' ? undefined : cluster.threat,
    allItems: cluster.allItems.map(sanitizeNewsItem),
  };
}

function sanitizeData(data: ExportData): ExportData {
  return {
    ...data,
    news: data.news?.map(sanitizeNewsItem),
    newsClusters: data.newsClusters?.map(sanitizeCluster),
    newsByCategory: data.newsByCategory
      ? Object.fromEntries(
          Object.entries(data.newsByCategory).map(([k, items]) => [k, items.map(sanitizeNewsItem)]),
        )
      : undefined,
  };
}

export function exportToJSON(data: ExportData, filename = 'worldmonitor-export'): void {
  const jsonStr = JSON.stringify(sanitizeData(data), null, 2);
  downloadFile(jsonStr, `${filename}.json`, 'application/json');
}

export function exportToCSV(data: ExportData, filename = 'worldmonitor-export'): void {
  const clean = sanitizeData(data);
  const lines: string[] = [];

  lines.push(`# WorldMonitor Export — ${new Date(clean.timestamp).toISOString()}`);
  lines.push('# Note: CSV is a structured summary. Use JSON export for full fidelity.');
  if (clean.meta?.note) lines.push(`# ${clean.meta.note}`);
  lines.push('');

  // News — prefer raw items over clusters; clusters lose individual sources
  const newsItems = clean.news ?? [];
  if (newsItems.length > 0) {
    lines.push('=== NEWS ===');
    lines.push('Title,Source,Link,Published,IsAlert,ThreatLevel,ThreatCategory');
    newsItems.forEach(item => {
      lines.push(csvRow([
        item.title,
        item.source,
        item.link,
        item.pubDate?.toISOString() || '',
        String(item.isAlert),
        item.threat?.level ?? '',
        item.threat?.category ?? '',
      ]));
    });
    lines.push('');
  }

  if (clean.markets && clean.markets.length > 0) {
    lines.push('=== MARKETS ===');
    lines.push('Symbol,Name,Price,Change');
    clean.markets.forEach(m => {
      lines.push(csvRow([m.symbol, m.name, String(m.price ?? ''), String(m.change ?? '')]));
    });
    lines.push('');
  }

  if (clean.predictions && clean.predictions.length > 0) {
    lines.push('=== PREDICTIONS ===');
    lines.push('Title,Yes Price,Volume');
    clean.predictions.forEach(p => {
      lines.push(csvRow([p.title, String(p.yesPrice), String(p.volume ?? '')]));
    });
    lines.push('');
  }

  const intel = clean.intelligence;
  if (intel) {
    if (intel.protests?.events && intel.protests.events.length > 0) {
      lines.push('=== PROTESTS ===');
      lines.push('Title,Country,EventType,Severity,Time');
      intel.protests.events.forEach(e => {
        lines.push(csvRow([e.title, e.country, e.eventType, e.severity, e.time.toISOString()]));
      });
      lines.push('');
    }

    if (intel.earthquakes && intel.earthquakes.length > 0) {
      lines.push('=== EARTHQUAKES ===');
      lines.push('Place,Magnitude,DepthKm,OccurredAt,URL');
      intel.earthquakes.forEach(e => {
        lines.push(csvRow([e.place, String(e.magnitude), String(e.depthKm), new Date(e.occurredAt * 1000).toISOString(), e.sourceUrl]));
      });
      lines.push('');
    }

    if (intel.outages && intel.outages.length > 0) {
      lines.push('=== INTERNET OUTAGES ===');
      lines.push('Title,Country,Severity,PubDate,Link');
      intel.outages.forEach(o => {
        lines.push(csvRow([o.title, o.country, o.severity, o.pubDate.toISOString(), o.link]));
      });
      lines.push('');
    }

    if (intel.flightDelays && intel.flightDelays.length > 0) {
      lines.push('=== FLIGHT DELAYS ===');
      lines.push('Airport,IATA,City,Country,DelayType,Severity,AvgDelayMin,Source');
      intel.flightDelays.forEach(d => {
        lines.push(csvRow([d.name, d.iata, d.city, d.country, d.delayType, d.severity, String(d.avgDelayMinutes), d.source]));
      });
      lines.push('');
    }

    if (intel.military?.flights && intel.military.flights.length > 0) {
      lines.push('=== MILITARY FLIGHTS ===');
      lines.push('Callsign,HexCode,AircraftType,Operator,Country,Lat,Lon');
      intel.military.flights.forEach(f => {
        lines.push(csvRow([f.callsign, f.hexCode, f.aircraftType, f.operator, f.operatorCountry, String(f.lat), String(f.lon)]));
      });
      lines.push('');
    }

    if (intel.military?.vessels && intel.military.vessels.length > 0) {
      lines.push('=== MILITARY VESSELS ===');
      lines.push('Name,MMSI,Country,VesselType,Lat,Lon');
      intel.military.vessels.forEach(v => {
        lines.push(csvRow([v.name, v.mmsi, v.operatorCountry, v.vesselType, String(v.lat), String(v.lon)]));
      });
      lines.push('');
    }

    if (intel.iranEvents && intel.iranEvents.length > 0) {
      lines.push('=== IRAN EVENTS ===');
      lines.push('Title,Category,Location,Severity,Timestamp');
      intel.iranEvents.forEach(e => {
        lines.push(csvRow([e.title, e.category, e.locationName, e.severity, e.timestamp]));
      });
      lines.push('');
    }

    if (intel.orefAlerts) {
      lines.push('=== OREF ALERTS ===');
      lines.push('ActiveAlerts,History24h');
      lines.push(csvRow([String(intel.orefAlerts.alertCount), String(intel.orefAlerts.historyCount24h)]));
      lines.push('');
    }

    if (intel.advisories && intel.advisories.length > 0) {
      lines.push('=== SECURITY ADVISORIES ===');
      lines.push('Title,Source,Level,Country,PubDate,Link');
      intel.advisories.forEach(a => {
        lines.push(csvRow([a.title, a.source, a.level ?? '', a.country ?? '', a.pubDate.toISOString(), a.link]));
      });
      lines.push('');
    }

    if (intel.radiation?.observations && intel.radiation.observations.length > 0) {
      lines.push('=== RADIATION MONITORING ===');
      lines.push('Location,Country,Value,Unit,ObservedAt');
      intel.radiation.observations.forEach(s => {
        lines.push(csvRow([s.location, s.country, String(s.value), s.unit, s.observedAt.toISOString()]));
      });
      lines.push('');
    }

    if (intel.imageryScenes && intel.imageryScenes.length > 0) {
      lines.push('=== SATELLITE IMAGERY ===');
      lines.push('ID,Satellite,DateTime,ResolutionM,Mode');
      intel.imageryScenes.forEach(s => {
        lines.push(csvRow([s.id, s.satellite, s.datetime, String(s.resolutionM), s.mode]));
      });
      lines.push('');
    }

    if (intel.sanctions) {
      lines.push('=== SANCTIONS ===');
      lines.push('# See JSON export for full sanctions data');
      lines.push(`TotalCount,${intel.sanctions.totalCount}`);
      lines.push(`SDNCount,${intel.sanctions.sdnCount}`);
      lines.push(`NewEntries,${intel.sanctions.newEntryCount}`);
      lines.push('');
    }

    if (intel.thermalEscalation) {
      lines.push('=== THERMAL ESCALATION ===');
      lines.push('# See JSON export for full thermal data');
      lines.push(`ClusterCount,${intel.thermalEscalation.summary.clusterCount}`);
      lines.push(`ElevatedCount,${intel.thermalEscalation.summary.elevatedCount}`);
      lines.push('');
    }

    if (intel.usniFleet) {
      lines.push('=== USNI FLEET ===');
      lines.push('# See JSON export for full fleet data');
      lines.push(`Vessels,${intel.usniFleet.vessels?.length ?? 0}`);
      lines.push('');
    }

    if (intel.aircraftPositions && intel.aircraftPositions.length > 0) {
      lines.push('=== AIRCRAFT POSITIONS ===');
      lines.push(`# ${intel.aircraftPositions.length} positions — see JSON for full data`);
      lines.push('');
    }
  }

  if (clean.cyberThreats && clean.cyberThreats.length > 0) {
    lines.push('=== CYBER THREATS ===');
    lines.push('Indicator,Type,Severity,Country,Source,FirstSeen');
    clean.cyberThreats.forEach(c => {
      lines.push(csvRow([c.indicator, c.indicatorType, String(c.severity), c.country ?? '', c.source, c.firstSeen ?? '']));
    });
    lines.push('');
  }

  if (clean.gpsJamming) {
    lines.push('=== GPS JAMMING ===');
    lines.push('FetchedAt,TotalHexes,HighCount,MediumCount');
    const s = clean.gpsJamming.stats;
    lines.push(csvRow([clean.gpsJamming.fetchedAt, String(s.totalHexes), String(s.highCount), String(s.mediumCount)]));
    lines.push('# Per-hex data available in JSON export');
    lines.push('');
  }

  if (clean.convergenceCards && clean.convergenceCards.length > 0) {
    lines.push('=== SIGNAL CONVERGENCE ===');
    lines.push('Domain,Title,Score,Trend,Countries');
    clean.convergenceCards.forEach(c => {
      lines.push(csvRow([c.domain, c.title, String(c.score), c.trend, c.countries.join(';')]));
    });
    lines.push('');
  }

  if (clean.monitors && clean.monitors.length > 0) {
    lines.push('=== MONITORS ===');
    lines.push('Name,Keywords,Color');
    clean.monitors.forEach(m => {
      lines.push(csvRow([m.name ?? '', m.keywords.join(';'), m.color]));
    });
    lines.push('');
  }

  downloadFile(lines.join('\n'), `${filename}.csv`, 'text/csv');
}

export interface CountryBriefExport {
  country: string;
  code: string;
  score?: number;
  level?: string;
  trend?: string;
  components?: { unrest: number; conflict: number; security: number; information: number };
  signals?: Record<string, number | string | null>;
  brief?: string;
  headlines?: Array<{ title: string; source: string; link: string; pubDate?: string }>;
  generatedAt: string;
}

export interface CountryEvidenceSourceInput {
  title?: string | null;
  source?: string | null;
  link?: string | null;
  pubDate?: string | Date | null;
}

export interface CountryEvidenceBundleInput {
  country: string;
  code: string;
  context?: string;
  score?: number;
  level?: string;
  trend?: string;
  components?: CountryBriefExport['components'];
  signals?: Record<string, unknown>;
  brief?: string;
  headlines?: CountryEvidenceSourceInput[];
  generatedAt?: string;
  exportedAt?: string;
  briefGeneratedAt?: string;
  briefCached?: boolean;
}

export interface CountryEvidenceSignal {
  label: string;
  value: string;
}

export interface CountryEvidenceSource {
  title: string;
  publisher?: string;
  url?: string;
  publishedAt?: string;
  freshness: string;
  note?: string;
}

export interface CountryEvidenceBundle {
  country: string;
  code: string;
  context: string;
  exportedAt: string;
  generatedAt?: string;
  briefGeneratedAt?: string;
  briefCacheStatus?: 'cached' | 'fresh';
  score?: number;
  level?: string;
  trend?: string;
  components?: CountryBriefExport['components'];
  signals: CountryEvidenceSignal[];
  brief?: string;
  sources: CountryEvidenceSource[];
  freshnessNotes: string[];
  provenanceDisclaimer: string;
}

export const COUNTRY_EVIDENCE_PROVENANCE_DISCLAIMER =
  'This WorldMonitor evidence bundle packages user-visible context and source metadata for analyst handoff. It is not a legal evidentiary record; verify source availability, timestamps, and claims before reuse.';

const SIGNAL_LABELS: Record<string, string> = {
  criticalNews: 'Critical news',
  protests: 'Protests',
  militaryFlights: 'Military flights nearby',
  militaryVessels: 'Military vessels nearby',
  militaryFlightsInCountry: 'Military flights inside borders',
  militaryVesselsInCountry: 'Military vessels inside borders',
  outages: 'Internet outages',
  aisDisruptions: 'AIS disruptions',
  satelliteFires: 'Satellite fires',
  radiationAnomalies: 'Radiation anomalies',
  temporalAnomalies: 'Temporal anomalies',
  cyberThreats: 'Cyber threats',
  earthquakes: 'Earthquakes',
  displacementOutflow: 'Displacement outflow',
  climateStress: 'Climate stress',
  conflictEvents: 'Conflict events',
  activeStrikes: 'Active strikes',
  orefSirens: 'Active OREF sirens',
  orefHistory24h: 'OREF sirens in 24h',
  aviationDisruptions: 'Aviation disruptions',
  travelAdvisories: 'Travel advisories',
  travelAdvisoryMaxLevel: 'Maximum travel advisory',
  gpsJammingHexes: 'GPS jamming zones',
  thermalEscalations: 'Thermal escalations',
  sanctionsDesignations: 'Sanctions designations',
  sanctionsNewDesignations: 'New sanctions designations',
};

const SECRET_ASSIGNMENT_RE = /\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret(?:[_-]?access[_-]?key)?|client[_-]?secret|token|password|authorization|cookie|session))\b(\s*)([:=])(\s*)(["']?)([^"'\s,;]{6,})(["']?)/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g;
const AWS_ACCESS_KEY_ID_RE = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const AWS_SECRET_ACCESS_KEY_RE = /\b(?=[A-Za-z0-9/+=]{40}\b)(?=[A-Za-z0-9/+=]{0,39}[A-Z])(?=[A-Za-z0-9/+=]{0,39}[a-z])(?=[A-Za-z0-9/+=]{0,39}\d)[A-Za-z0-9/+=]{40}\b/g;
const COMMON_SECRET_RE = /\b(?:sk[-_][A-Za-z0-9_-]{12,}|wm_[A-Za-z0-9_=-]{12,}|ghp_[A-Za-z0-9_=-]{12,}|github_pat_[A-Za-z0-9_=-]{12,}|AIza[A-Za-z0-9_-]{20,}|xox[abprsc]-[A-Za-z0-9-]{10,})\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const USER_ID_RE = /\buser_[A-Za-z0-9_-]{6,}\b/g;
const SECRET_URL_PARAM_NAME_RE = /(?:^|[_\-.])(?:api[_\-.]?key|access[_\-.]?key(?:[_\-.]?id)?|awsaccess[_\-.]?key(?:[_\-.]?id)?|secret(?:[_\-.]?access[_\-.]?key)?|client[_\-.]?secret|token|id[_\-.]?token|auth(?:orization)?|password|passwd|pwd|cookie|session|jwt|signature|sig|credential|key)(?:$|[_\-.])/i;

function regexMatches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matches = pattern.test(value);
  pattern.lastIndex = 0;
  return matches;
}

function isSecretishAssignmentValue(value: string): boolean {
  const clean = value.trim();
  if (
    regexMatches(AWS_ACCESS_KEY_ID_RE, clean)
    || regexMatches(AWS_SECRET_ACCESS_KEY_RE, clean)
    || regexMatches(COMMON_SECRET_RE, clean)
    || regexMatches(JWT_RE, clean)
  ) {
    return true;
  }

  if (clean.length < 16 || !/[A-Za-z]/.test(clean) || !/\d/.test(clean)) return false;
  const classes = [
    /[a-z]/.test(clean),
    /[A-Z]/.test(clean),
    /\d/.test(clean),
    /[-_=+/]/.test(clean),
  ].filter(Boolean).length;
  return classes >= 3 || clean.length >= 24;
}

function sanitizeEvidenceText(value: unknown): string {
  return String(value ?? '')
    .replace(BEARER_RE, 'Bearer [redacted-secret]')
    .replace(SECRET_ASSIGNMENT_RE, (match, key, beforeOperator, operator, afterOperator, openingQuote, secretValue, closingQuote) => {
      if (operator === ':' && !isSecretishAssignmentValue(secretValue)) return match;
      return `${key}${beforeOperator}${operator}${afterOperator}${openingQuote}[redacted-secret]${closingQuote}`;
    })
    .replace(AWS_ACCESS_KEY_ID_RE, '[redacted-secret]')
    .replace(AWS_SECRET_ACCESS_KEY_RE, '[redacted-secret]')
    .replace(COMMON_SECRET_RE, '[redacted-secret]')
    .replace(JWT_RE, '[redacted-secret]')
    .replace(EMAIL_RE, '[redacted-email]')
    .replace(USER_ID_RE, '[redacted-user-id]')
    .trim();
}

function isSensitiveUrlParamName(name: string): boolean {
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
  return SECRET_URL_PARAM_NAME_RE.test(normalized);
}

function sanitizeEvidenceUrlSearchParams(parsed: URL): void {
  if (!parsed.search) return;
  const sanitized = new URLSearchParams();
  let changed = false;
  parsed.searchParams.forEach((value, key) => {
    const sensitiveKey = isSensitiveUrlParamName(key);
    const sanitizedValue = sensitiveKey ? '[redacted-secret]' : sanitizeEvidenceText(value);
    if (sensitiveKey || sanitizedValue !== value) changed = true;
    sanitized.append(key, sanitizedValue);
  });
  if (changed) parsed.search = sanitized.toString() ? `?${sanitized.toString()}` : '';
}

function sanitizeEvidenceUrlFragment(parsed: URL): void {
  if (!parsed.hash) return;
  const fragment = parsed.hash.slice(1);
  const sanitized = sanitizeEvidenceText(fragment);
  if (sanitized !== fragment) parsed.hash = sanitized;
}

function normalizeEvidenceUrl(value: unknown): string | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    if (parsed.username) parsed.username = '[redacted-user-id]';
    if (parsed.password) parsed.password = '[redacted-secret]';
    sanitizeEvidenceUrlSearchParams(parsed);
    sanitizeEvidenceUrlFragment(parsed);
    return parsed.toString().replace(/[()]/g, (char) => char === '(' ? '%28' : '%29');
  } catch {
    return undefined;
  }
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : undefined;
}

function signalLabel(key: string): string {
  return SIGNAL_LABELS[key] ?? key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildEvidenceSignals(signals: Record<string, unknown> | undefined): CountryEvidenceSignal[] {
  if (!signals) return [];
  return Object.entries(signals)
    .filter(([, value]) => {
      if (typeof value === 'number') return value > 0;
      if (typeof value === 'string') return value.trim().length > 0;
      return value != null && value !== false;
    })
    .map(([key, value]) => ({
      label: signalLabel(key),
      value: sanitizeEvidenceText(value),
    }));
}

function freshnessForSource(publishedAt: string | undefined, exportedAt: string): string {
  if (!publishedAt) return 'Published timestamp unavailable; freshness could not be computed.';
  const published = new Date(publishedAt).getTime();
  const exported = new Date(exportedAt).getTime();
  if (!Number.isFinite(published) || !Number.isFinite(exported)) {
    return 'Published timestamp unavailable; freshness could not be computed.';
  }
  const ageMs = Math.max(0, exported - published);
  const ageHours = Math.floor(ageMs / 3_600_000);
  if (ageHours < 48) return `${ageHours}h old at export.`;
  return `${Math.floor(ageHours / 24)}d old at export.`;
}

function buildEvidenceSources(
  headlines: CountryEvidenceSourceInput[] | undefined,
  exportedAt: string,
): CountryEvidenceSource[] {
  return (headlines ?? [])
    .filter((headline) => Boolean(
      sanitizeEvidenceText(headline.title)
      || sanitizeEvidenceText(headline.source)
      || normalizeEvidenceUrl(headline.link)
      || normalizeIsoTimestamp(headline.pubDate),
    ))
    .map((headline, index) => {
      const title = sanitizeEvidenceText(headline.title) || `Source ${index + 1} (title unavailable)`;
      const publisher = sanitizeEvidenceText(headline.source) || undefined;
      const url = normalizeEvidenceUrl(headline.link);
      const publishedAt = normalizeIsoTimestamp(headline.pubDate);
      const hadUnsafeOrMissingUrl = Boolean(headline.link) && !url;
      return {
        title,
        publisher,
        url,
        publishedAt,
        freshness: freshnessForSource(publishedAt, exportedAt),
        note: url
          ? undefined
          : hadUnsafeOrMissingUrl
            ? 'URL omitted because it was missing or unsafe.'
            : 'URL unavailable; citation link was not provided.',
      };
    });
}

function buildFreshnessNotes(input: CountryEvidenceBundleInput, exportedAt: string): string[] {
  const notes: string[] = [`Exported at ${exportedAt}.`];
  const briefGeneratedAt = normalizeIsoTimestamp(input.briefGeneratedAt ?? input.generatedAt);
  if (briefGeneratedAt) {
    notes.push(`Brief generated at ${briefGeneratedAt}${input.briefCached === true ? ' from cache' : ''}.`);
  } else {
    notes.push('Brief generation timestamp unavailable.');
  }
  if (!input.headlines || input.headlines.length === 0) {
    notes.push('No headline source list was available for this export.');
  }
  return notes;
}

function markdownListValue(value: string | number | undefined): string {
  const clean = sanitizeEvidenceText(value);
  return clean || 'Unavailable';
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[[\]\\]/g, '\\$&');
}

function escapeMarkdownInline(value: string): string {
  return sanitizeEvidenceText(value)
    .replace(/\s+/g, ' ')
    .replace(/([\\`*_{}\[\]()#+\-.!|<>])/g, '\\$1');
}

function renderQuotedEvidenceBlock(value: string): string[] {
  return value.split(/\r?\n/).map((line) => `> ${line}`);
}

export function buildCountryEvidenceBundle(input: CountryEvidenceBundleInput): CountryEvidenceBundle {
  const exportedAt = normalizeIsoTimestamp(input.exportedAt) ?? new Date().toISOString();
  const generatedAt = normalizeIsoTimestamp(input.generatedAt);
  const briefGeneratedAt = normalizeIsoTimestamp(input.briefGeneratedAt ?? input.generatedAt);
  const brief = sanitizeEvidenceText(input.brief);
  return {
    country: sanitizeEvidenceText(input.country),
    code: sanitizeEvidenceText(input.code).toUpperCase(),
    context: sanitizeEvidenceText(input.context) || 'Country dossier',
    exportedAt,
    generatedAt,
    briefGeneratedAt,
    briefCacheStatus: input.briefCached === true ? 'cached' : input.briefCached === false ? 'fresh' : undefined,
    score: input.score,
    level: sanitizeEvidenceText(input.level) || undefined,
    trend: sanitizeEvidenceText(input.trend) || undefined,
    components: input.components,
    signals: buildEvidenceSignals(input.signals),
    brief: brief || undefined,
    sources: buildEvidenceSources(input.headlines, exportedAt),
    freshnessNotes: buildFreshnessNotes(input, exportedAt),
    provenanceDisclaimer: COUNTRY_EVIDENCE_PROVENANCE_DISCLAIMER,
  };
}

export function renderCountryEvidenceMarkdown(bundle: CountryEvidenceBundle): string {
  const lines: string[] = [];
  lines.push(`# WorldMonitor Evidence Bundle: ${bundle.country} (${bundle.code})`);
  lines.push('');
  lines.push(`- Context: ${markdownListValue(bundle.context)}`);
  lines.push(`- Exported at: ${markdownListValue(bundle.exportedAt)}`);
  if (bundle.generatedAt) lines.push(`- Bundle generated at: ${markdownListValue(bundle.generatedAt)}`);
  if (bundle.briefGeneratedAt) {
    const cacheSuffix = bundle.briefCacheStatus ? ` (${bundle.briefCacheStatus})` : '';
    lines.push(`- Brief generated at: ${markdownListValue(bundle.briefGeneratedAt)}${cacheSuffix}`);
  }
  lines.push('');

  lines.push('## Risk Context');
  if (bundle.score != null) {
    lines.push(`- Instability score: ${bundle.score}/100`);
    lines.push(`- Level: ${markdownListValue(bundle.level)}`);
    lines.push(`- Trend: ${markdownListValue(bundle.trend)}`);
  } else {
    lines.push('- Instability score: unavailable in this dossier.');
  }
  if (bundle.components) {
    lines.push(`- Components: unrest ${bundle.components.unrest}, conflict ${bundle.components.conflict}, security ${bundle.components.security}, information ${bundle.components.information}`);
  }
  lines.push('');

  lines.push('## Selected Signals');
  if (bundle.signals.length > 0) {
    bundle.signals.forEach((signal) => {
      lines.push(`- ${signal.label}: ${signal.value}`);
    });
  } else {
    lines.push('- No active signal counts were available in this dossier.');
  }
  lines.push('');

  if (bundle.brief) {
    lines.push('## Intelligence Brief');
    lines.push('');
    lines.push(...renderQuotedEvidenceBlock(bundle.brief));
    lines.push('');
  }

  lines.push('## Sources');
  if (bundle.sources.length > 0) {
    bundle.sources.forEach((source, index) => {
      const title = source.url
        ? `[${escapeMarkdownLinkText(source.title)}](${source.url})`
        : escapeMarkdownInline(source.title);
      const label = `${index + 1}. ${title}`;
      lines.push(label);
      lines.push(`   - Publisher: ${escapeMarkdownInline(markdownListValue(source.publisher))}`);
      lines.push(`   - Published at: ${markdownListValue(source.publishedAt)}`);
      lines.push(`   - Freshness: ${source.freshness}`);
      if (source.note) lines.push(`   - Note: ${source.note}`);
    });
  } else {
    lines.push('- No source links were available for this export.');
  }
  lines.push('');

  lines.push('## Freshness Notes');
  bundle.freshnessNotes.forEach((note) => lines.push(`- ${note}`));
  lines.push('');

  lines.push('## Provenance Disclaimer');
  lines.push(bundle.provenanceDisclaimer);
  lines.push('');
  return lines.join('\n');
}

export function exportCountryEvidenceMarkdown(data: CountryEvidenceBundleInput): void {
  const bundle = buildCountryEvidenceBundle(data);
  const timestamp = bundle.exportedAt.replace(/[:.]/g, '-');
  downloadFile(
    renderCountryEvidenceMarkdown(bundle),
    `country-evidence-${bundle.code}-${timestamp}.md`,
    'text/markdown;charset=utf-8',
  );
}

export function exportCountryBriefJSON(data: CountryBriefExport): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  downloadFile(JSON.stringify(data, null, 2), `country-brief-${data.code}-${timestamp}.json`, 'application/json');
}

export function exportCountryBriefCSV(data: CountryBriefExport): void {
  const lines: string[] = [];
  lines.push(`Country Brief: ${data.country} (${data.code})`);
  lines.push(`Generated: ${data.generatedAt}`);
  lines.push('');
  if (data.score != null) {
    lines.push(`Score,${data.score}`);
    lines.push(`Level,${data.level || ''}`);
    lines.push(`Trend,${data.trend || ''}`);
  }
  if (data.components) {
    lines.push('');
    lines.push('Component,Value');
    lines.push(`Unrest,${data.components.unrest}`);
    lines.push(`Conflict,${data.components.conflict}`);
    lines.push(`Security,${data.components.security}`);
    lines.push(`Information,${data.components.information}`);
  }
  if (data.signals) {
    lines.push('');
    lines.push('Signal,Count');
    for (const [k, v] of Object.entries(data.signals)) {
      lines.push(csvRow([k, String(v)]));
    }
  }
  if (data.headlines && data.headlines.length > 0) {
    lines.push('');
    lines.push('Title,Source,Link,Published');
    data.headlines.forEach(h => lines.push(csvRow([h.title, h.source, h.link, h.pubDate || ''])));
  }
  if (data.brief) {
    lines.push('');
    lines.push('Intelligence Brief');
    lines.push(`"${data.brief.replace(/"/g, '""')}"`);
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  downloadFile(lines.join('\n'), `country-brief-${data.code}-${timestamp}.csv`, 'text/csv');
}

function csvRow(values: string[]): string {
  return values.map(v => `"${(v || '').replace(/"/g, '""')}"`).join(',');
}

function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export class ExportPanel {
  private element: HTMLElement;
  private isOpen = false;
  private getData: () => ExportData;

  constructor(getDataFn: () => ExportData) {
    this.getData = getDataFn;
    this.element = document.createElement('div');
    this.element.className = 'export-panel-container';
    setTrustedHtml(this.element, trustedHtml(`
      <button class="export-btn" title="${t('common.exportData')}">⬇</button>
      <div class="export-menu hidden">
        <button class="export-option" data-format="csv">${t('common.exportCsv')}</button>
        <button class="export-option" data-format="json">${t('common.exportJson')}</button>
      </div>
    `, "legacy direct innerHTML migration"));

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    const btn = this.element.querySelector('.export-btn')!;
    const menu = this.element.querySelector('.export-menu')!;

    btn.addEventListener('click', () => {
      this.isOpen = !this.isOpen;
      menu.classList.toggle('hidden', !this.isOpen);
    });

    document.addEventListener('click', (e) => {
      if (!this.element.contains(e.target as Node)) {
        this.isOpen = false;
        menu.classList.add('hidden');
      }
    });

    this.element.querySelectorAll('.export-option').forEach(option => {
      option.addEventListener('click', () => {
        const format = (option as HTMLElement).dataset.format as ExportFormat;
        this.export(format);
        this.isOpen = false;
        menu.classList.add('hidden');
      });
    });
  }

  private export(format: ExportFormat): void {
    const data = this.getData();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `worldmonitor-${timestamp}`;

    if (format === 'json') {
      exportToJSON(data, filename);
    } else {
      exportToCSV(data, filename);
    }
  }

  public getElement(): HTMLElement {
    return this.element;
  }
}
