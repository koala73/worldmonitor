import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { getOptionalUpstashCreds } from './_upstash-rest.mjs';
import {
  CHINA_COVERAGE_ENTRIES,
  CHINA_COVERAGE_REASON_CODES as REASON,
  chinaCoverageRedisKeys,
} from './china-coverage-manifest.mjs';

const MINUTE_MS = 60_000;

function valuesAtPath(root, path = []) {
  let values = [root];
  for (const segment of path) {
    const next = [];
    for (const value of values) {
      if (segment === '*') {
        if (Array.isArray(value)) next.push(...value);
        else if (value && typeof value === 'object') next.push(...Object.values(value));
      } else if (value && typeof value === 'object' && segment in value) {
        next.push(value[segment]);
      }
    }
    values = next;
  }
  return values;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 1_000_000_000_000) return value;
    if (value >= 1_000_000_000) return value * 1_000;
    if (Number.isInteger(value) && value >= 1900 && value <= 2200) return Date.UTC(value, 11, 31);
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const token = value.trim();
  if (/^\d{4}$/.test(token)) return Date.UTC(Number(token), 11, 31);
  if (/^\d{4}-\d{2}$/.test(token)) {
    const [year, month] = token.split('-').map(Number);
    return Date.UTC(year, month, 0, 23, 59, 59, 999);
  }
  const parsed = Date.parse(token);
  return Number.isFinite(parsed) ? parsed : null;
}

function newestTimestamp(items, timestampPaths) {
  const timestamps = [];
  for (const item of items) {
    for (const path of timestampPaths ?? []) {
      for (const value of valuesAtPath(item, path)) {
        const parsed = timestampMs(value);
        if (parsed != null) timestamps.push(parsed);
      }
    }
  }
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function hasSubstantiveValue(value, ignoredFields = new Set()) {
  if (value == null) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some((item) => hasSubstantiveValue(item, ignoredFields));
  if (typeof value === 'object') {
    return Object.entries(value).some(([key, child]) => !ignoredFields.has(key) && hasSubstantiveValue(child, ignoredFields));
  }
  return false;
}

function probeContent(payload, probe) {
  if (!payload || typeof payload !== 'object') return { status: 'missing', rows: [] };

  if (probe.kind === 'object') {
    if (probe.requiredTruthyPaths?.some((path) => !valuesAtPath(payload, path).some(Boolean))) {
      return { status: 'empty', rows: [payload] };
    }
    return { status: 'present', rows: [payload] };
  }
  if (probe.kind === 'object-property') {
    const value = valuesAtPath(payload, probe.path)[0];
    return value && typeof value === 'object' ? { status: 'present', rows: [value] } : { status: 'missing', rows: [] };
  }

  const source = valuesAtPath(payload, probe.path)[0];
  if (!Array.isArray(source)) return { status: 'missing', rows: [] };
  const wanted = new Set((probe.values ?? []).map(String));
  const matched = source.filter((row) => wanted.has(String(row?.[probe.field] ?? '')));

  if (probe.kind === 'array-coverage') {
    const presentValues = new Set(matched.map((row) => String(row?.[probe.field] ?? '')));
    if (presentValues.size === 0) return { status: 'missing', rows: [], required: wanted.size, present: 0 };
    if (presentValues.size < wanted.size) {
      return { status: 'partial', rows: matched, required: wanted.size, present: presentValues.size };
    }
    return { status: 'present', rows: matched, required: wanted.size, present: presentValues.size };
  }

  return matched.length > 0 ? { status: 'present', rows: matched } : { status: 'missing', rows: [] };
}

function evaluateTransport(entry, data, meta, now) {
  const cfg = entry.transport;
  const source = cfg.key.startsWith('seed-meta:') ? meta[cfg.key] : data[cfg.key];
  if (!source || typeof source !== 'object') return { status: 'missing', ageMin: null, maxAgeMin: cfg.maxAgeMin };
  if (source.status === 'error') return { status: 'error', ageMin: null, maxAgeMin: cfg.maxAgeMin };
  const fetchedAt = newestTimestamp([source], cfg.timestampPaths);
  if (fetchedAt == null) return { status: 'missing', ageMin: null, maxAgeMin: cfg.maxAgeMin };
  const ageMin = Math.round((now - fetchedAt) / MINUTE_MS);
  return {
    status: ageMin < 0 || ageMin > cfg.maxAgeMin ? 'stale' : 'fresh',
    ageMin,
    maxAgeMin: cfg.maxAgeMin,
  };
}

function evaluateContent(entry, data, now) {
  const cfg = entry.content;
  const probed = probeContent(data[cfg.key], cfg.probe);
  const result = {
    status: probed.status,
    ageMin: null,
    maxAgeMin: cfg.maxAgeMin,
    ...(probed.required != null ? { required: probed.required, present: probed.present } : {}),
  };
  if (probed.status === 'missing' || probed.status === 'partial' || probed.status === 'empty') return result;

  const ignored = new Set([
    cfg.probe.field,
    ...(cfg.probe.timestampPaths ?? [])
      .map((path) => path[path.length - 1])
      .filter((part) => part && part !== '*'),
  ]);
  if (!probed.rows.some((row) => hasSubstantiveValue(row, ignored))) return { ...result, status: 'empty' };

  const observedAt = newestTimestamp(probed.rows, cfg.probe.timestampPaths);
  if (observedAt == null) return { ...result, status: 'timestamp_missing' };
  const ageMin = Math.round((now - observedAt) / MINUTE_MS);
  return { ...result, status: ageMin < 0 || ageMin > cfg.maxAgeMin ? 'stale' : 'fresh', ageMin };
}

function reasonCodesFor(transport, content) {
  const reasons = [];
  if (transport.status === 'missing') reasons.push(REASON.TRANSPORT_MISSING);
  if (transport.status === 'stale') reasons.push(REASON.TRANSPORT_STALE);
  if (transport.status === 'error') reasons.push(REASON.TRANSPORT_ERROR);
  if (content.status === 'missing') reasons.push(REASON.CHINA_ROW_MISSING);
  if (content.status === 'empty') reasons.push(REASON.CHINA_ROW_EMPTY);
  if (content.status === 'partial') reasons.push(REASON.CHINA_COVERAGE_PARTIAL);
  if (content.status === 'timestamp_missing') reasons.push(REASON.CONTENT_TIMESTAMP_MISSING);
  if (content.status === 'stale') reasons.push(REASON.CONTENT_STALE);
  return reasons;
}

export function evaluateChinaCoverage({
  entries = CHINA_COVERAGE_ENTRIES,
  data = {},
  meta = {},
  now = Date.now(),
} = {}) {
  const evaluated = entries.map((entry) => {
    if (entry.launchStatus !== 'launched') {
      return {
        id: entry.id,
        label: entry.label,
        ownerIssue: entry.ownerIssue,
        launchStatus: entry.launchStatus,
        status: entry.launchStatus,
        transport: { status: 'not_applicable', ageMin: null, maxAgeMin: null },
        content: { status: 'not_applicable', ageMin: null, maxAgeMin: null },
        reasonCodes: [REASON.NOT_LAUNCHED],
      };
    }

    const transport = evaluateTransport(entry, data, meta, now);
    const content = evaluateContent(entry, data, now);
    const reasonCodes = reasonCodesFor(transport, content);
    const bothMissing = transport.status === 'missing' && content.status === 'missing';
    return {
      id: entry.id,
      label: entry.label,
      ownerIssue: entry.ownerIssue,
      launchStatus: entry.launchStatus,
      status: reasonCodes.length === 0 ? 'healthy' : bothMissing ? 'unavailable' : 'degraded',
      transport,
      content,
      reasonCodes,
    };
  });

  const launched = evaluated.filter((entry) => entry.launchStatus === 'launched');
  const counts = {
    total: evaluated.length,
    launched: launched.length,
    planned: evaluated.filter((entry) => entry.launchStatus === 'planned').length,
    blocked: evaluated.filter((entry) => entry.launchStatus === 'blocked').length,
    healthy: launched.filter((entry) => entry.status === 'healthy').length,
    degraded: launched.filter((entry) => entry.status === 'degraded').length,
    unavailable: launched.filter((entry) => entry.status === 'unavailable').length,
  };
  let status = 'healthy';
  if (launched.length > 0 && counts.unavailable === launched.length) status = 'unavailable';
  else if (counts.degraded > 0 || counts.unavailable > 0) status = 'degraded';

  return {
    schemaVersion: 1,
    countryCode: 'CN',
    status,
    evaluatedAt: new Date(now).toISOString(),
    counts,
    entries: evaluated,
  };
}

function parseRedisJson(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') throw new Error('Redis coverage value was not JSON text');
  try {
    return unwrapEnvelope(JSON.parse(raw)).data;
  } catch {
    throw new Error('Redis coverage value was malformed JSON');
  }
}

export async function readChinaCoverageInputs(entries = CHINA_COVERAGE_ENTRIES) {
  const credentials = getOptionalUpstashCreds();
  if (!credentials) throw new Error('Redis not configured');
  const keys = chinaCoverageRedisKeys(entries);
  const ordered = [...keys.data, ...keys.meta];
  const response = await fetch(`${credentials.restUrl}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'worldmonitor-ops/1.0 (+https://worldmonitor.app)',
    },
    body: JSON.stringify(chinaCoverageReadCommands(ordered)),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Redis pipeline failed: HTTP ${response.status}`);
  const results = await response.json();
  if (!Array.isArray(results) || results.length !== ordered.length) {
    throw new Error('Redis pipeline returned an incomplete response');
  }
  const errorCount = results.filter((result) => result?.error).length;
  if (errorCount > 0) throw new Error(`Redis pipeline returned ${errorCount} command error(s)`);
  const data = {};
  const meta = {};
  for (let index = 0; index < ordered.length; index++) {
    const key = ordered[index];
    const value = parseRedisJson(results[index]?.result);
    if (index < keys.data.length) data[key] = value;
    else meta[key] = value;
  }
  return { data, meta };
}

export function chinaCoverageReadCommands(keys) {
  return keys.map((key) => ['GET', key]);
}

export function formatChinaCoverageHuman(summary) {
  const lines = [
    `China coverage: ${String(summary.status).toUpperCase()} (${summary.counts.healthy}/${summary.counts.launched} launched healthy; ${summary.counts.planned} planned; ${summary.counts.blocked} blocked)`,
    `Evaluated: ${summary.evaluatedAt}`,
  ];
  for (const entry of summary.entries) {
    const reasons = entry.reasonCodes.length > 0 ? ` [${entry.reasonCodes.join(',')}]` : '';
    lines.push(`- ${entry.id}: ${entry.status} transport=${entry.transport.status} content=${entry.content.status}${reasons}`);
  }
  return lines.join('\n');
}
