import type { CyberThreat, CyberThreatIndicatorType, CyberThreatSeverity, CyberThreatSource, CyberThreatType } from '@/types';
import { createCircuitBreaker, fetchWithCache } from '@/utils';

const API_URL = '/api/cyber-threats';
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;
const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;

export interface CyberThreatSourceStatus {
  ok: boolean;
  count: number;
  reason?: string;
}

export interface CyberThreatsMeta {
  partial: boolean;
  sources: {
    feodo: CyberThreatSourceStatus;
    urlhaus: CyberThreatSourceStatus;
    c2intel: CyberThreatSourceStatus;
    otx: CyberThreatSourceStatus;
    abuseipdb: CyberThreatSourceStatus;
  };
  cachedAt?: string;
}

const breaker = createCircuitBreaker<CyberThreat[]>({ name: 'Cyber Threats' });

let lastMeta: CyberThreatsMeta = {
  partial: false,
  sources: {
    feodo: { ok: false, count: 0 },
    urlhaus: { ok: false, count: 0 },
    c2intel: { ok: false, count: 0 },
    otx: { ok: false, count: 0 },
    abuseipdb: { ok: false, count: 0 },
  },
};

function clampInt(rawValue: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(rawValue)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(rawValue as number)));
}

function asSeverity(value: unknown): CyberThreatSeverity {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'critical') return 'critical';
  if (normalized === 'high') return 'high';
  if (normalized === 'medium') return 'medium';
  return 'low';
}

function asThreatType(value: unknown): CyberThreatType {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'c2_server') return 'c2_server';
  if (normalized === 'malware_host') return 'malware_host';
  if (normalized === 'phishing') return 'phishing';
  return 'malicious_url';
}

function asIndicatorType(value: unknown): CyberThreatIndicatorType {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'domain') return 'domain';
  if (normalized === 'url') return 'url';
  return 'ip';
}

function asSource(value: unknown): CyberThreatSource {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'urlhaus') return 'urlhaus';
  if (normalized === 'c2intel') return 'c2intel';
  if (normalized === 'otx') return 'otx';
  if (normalized === 'abuseipdb') return 'abuseipdb';
  return 'feodo';
}

function hasValidCoordinates(lat: number, lon: number): boolean {
  return Number.isFinite(lat)
    && Number.isFinite(lon)
    && lat >= -90
    && lat <= 90
    && lon >= -180
    && lon <= 180;
}

function sanitizeThreat(threat: unknown): CyberThreat | null {
  if (!threat || typeof threat !== 'object') return null;

  const record = threat as Partial<CyberThreat>;
  const indicator = String(record.indicator ?? '').trim();
  if (!indicator) return null;

  const lat = Number(record.lat);
  const lon = Number(record.lon);
  if (!hasValidCoordinates(lat, lon)) return null;

  const tags = Array.isArray(record.tags)
    ? record.tags
      .map((tag) => String(tag ?? '').trim().slice(0, 40).toLowerCase())
      .filter(Boolean)
      .slice(0, 8)
    : [];

  return {
    id: String(record.id ?? `${record.source || 'feodo'}:${record.indicatorType || 'ip'}:${indicator}`).slice(0, 255),
    type: asThreatType(record.type),
    source: asSource(record.source),
    indicator: indicator.slice(0, 255),
    indicatorType: asIndicatorType(record.indicatorType),
    lat,
    lon,
    country: record.country ? String(record.country).slice(0, 64) : undefined,
    severity: asSeverity(record.severity),
    malwareFamily: record.malwareFamily ? String(record.malwareFamily).slice(0, 80) : undefined,
    tags,
    firstSeen: record.firstSeen ? String(record.firstSeen) : undefined,
    lastSeen: record.lastSeen ? String(record.lastSeen) : undefined,
  };
}

function sanitizeSourceStatus(value: unknown): CyberThreatSourceStatus {
  if (!value || typeof value !== 'object') {
    return { ok: false, count: 0 };
  }

  const source = value as Partial<CyberThreatSourceStatus>;
  return {
    ok: Boolean(source.ok),
    count: Number.isFinite(Number(source.count)) ? Number(source.count) : 0,
    reason: source.reason ? String(source.reason).slice(0, 200) : undefined,
  };
}

export async function fetchCyberThreats(options: { limit?: number; days?: number } = {}): Promise<CyberThreat[]> {
  const limit = clampInt(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const days = clampInt(options.days, DEFAULT_DAYS, 1, MAX_DAYS);

  return breaker.execute(async () => {
    const payload = await fetchWithCache<{
      success?: boolean;
      partial?: boolean;
      data?: unknown[];
      sources?: { feodo?: unknown; urlhaus?: unknown; c2intel?: unknown; otx?: unknown; abuseipdb?: unknown };
      cachedAt?: string;
    }>(`${API_URL}?limit=${limit}&days=${days}`, {
      ttl: 120_000,
      headers: { Accept: 'application/json' },
    });

    if (payload.success === false) {
      throw new Error('Cyber threat endpoint returned success=false');
    }

    const threats = Array.isArray(payload.data)
      ? payload.data.map(sanitizeThreat).filter((item): item is CyberThreat => Boolean(item))
      : [];

    lastMeta = {
      partial: Boolean(payload.partial),
      sources: {
        feodo: sanitizeSourceStatus(payload.sources?.feodo),
        urlhaus: sanitizeSourceStatus(payload.sources?.urlhaus),
        c2intel: sanitizeSourceStatus(payload.sources?.c2intel),
        otx: sanitizeSourceStatus(payload.sources?.otx),
        abuseipdb: sanitizeSourceStatus(payload.sources?.abuseipdb),
      },
      cachedAt: payload.cachedAt,
    };

    return threats;
  }, []);
}

export function getCyberThreatsMeta(): CyberThreatsMeta {
  return {
    partial: lastMeta.partial,
    sources: {
      feodo: { ...lastMeta.sources.feodo },
      urlhaus: { ...lastMeta.sources.urlhaus },
      c2intel: { ...lastMeta.sources.c2intel },
      otx: { ...lastMeta.sources.otx },
      abuseipdb: { ...lastMeta.sources.abuseipdb },
    },
    cachedAt: lastMeta.cachedAt,
  };
}

export function getCyberThreatsStatus(): string {
  return breaker.getStatus();
}
