// Pure forecast-resolution evaluator for Bet 2 (#5007).
//
// This module has no Redis, R2, or wall-clock reads. Callers pass the ledger
// entry, current feed snapshot, observed samples, and nowMs; output is a
// deterministic pending/resolved result with evidence.

import { readFileSync } from 'node:fs';

const DAY_MS = 24 * 60 * 60 * 1000;
export const ACLED_SETTLEMENT_LAG_MS = 2 * DAY_MS;
export const UCDP_SETTLEMENT_LAG_MS = 14 * DAY_MS;

const SUPPORTED_FUNCTIONS = new Set(['count', 'riskScore', 'present', 'yesPrice', 'hexCount', 'price']);
const COUNTRY_ALIASES = loadCountryAliases();

export function countSettlementLagMs(feedKey) {
  const key = String(feedKey || '');
  if (key.includes('ucdp-events')) return UCDP_SETTLEMENT_LAG_MS;
  // ACLED-sourced count feeds (conflict + unrest Protests) are dated by
  // event_date, which trails ingestion by ~1-2 days; seal after that lag so the
  // count is never read before the source has caught up to the deadline (a
  // premature read scores a false NO). Cyber is intentionally excluded: its
  // firstSeenAt is a near-real-time observation stamp, not a lagged event date.
  if (key.includes('acled') || key.includes('unrest')) return ACLED_SETTLEMENT_LAG_MS;
  return 0;
}

export function parseMetricKey(metricKey) {
  if (typeof metricKey !== 'string' || !metricKey) return null;
  const pipe = metricKey.indexOf('|');
  if (pipe <= 0) return null;
  const feedKey = metricKey.slice(0, pipe);
  const expr = metricKey.slice(pipe + 1);
  const open = expr.indexOf('(');
  const close = expr.lastIndexOf(')');
  if (open <= 0 || close <= open + 1 || close !== expr.length - 1) return null;

  const fn = expr.slice(0, open);
  const args = expr.slice(open + 1, close);
  const eq = args.indexOf('==');
  if (eq <= 0) return null;
  const field = args.slice(0, eq);
  const value = args.slice(eq + 2);
  if (!feedKey || !fn || !field || !value) return null;
  return { feedKey, fn, field, value };
}

export function resolveHardSpec(entry, feedData, samples, nowMs) {
  const spec = entry?.spec || entry?.resolution;
  const parsed = parseMetricKey(spec?.metricKey);
  if (!spec || spec.kind !== 'hard') return voidResult('not_hard_spec', entry, spec, parsed, nowMs);
  if (!parsed || !SUPPORTED_FUNCTIONS.has(parsed.fn)) return voidResult('unsupported_metric_key', entry, spec, parsed, nowMs);
  if (!Number.isFinite(Number(spec.deadline ?? entry?.deadline))) return voidResult('missing_deadline', entry, spec, parsed, nowMs);
  if (!Number.isFinite(Number(spec.threshold))) return voidResult('missing_threshold', entry, spec, parsed, nowMs);

  const deadline = Number(spec.deadline ?? entry.deadline);
  if (nowMs < deadline) {
    return { status: 'pending', evidence: { reason: 'deadline_not_reached', deadline } };
  }

  if (parsed.fn === 'count') {
    const settlementLagMs = countSettlementLagMs(parsed.feedKey || spec.sourceFeed);
    const sealAfter = deadline + settlementLagMs;
    if (nowMs < sealAfter) {
      return { status: 'pending', evidence: { reason: 'count_settlement_lag', deadline, sealAfter } };
    }
    if (feedData == null) {
      return { status: 'pending', evidence: { reason: 'source_feed_unavailable', deadline, metricKey: spec.metricKey } };
    }
    const generatedAt = Number(entry?.generatedAt ?? entry?.firstSeenAt);
    if (!Number.isFinite(generatedAt)) return voidResult('missing_generated_at', entry, spec, parsed, nowMs);
    // Source-coverage gating (has the feed caught up to the deadline? was the
    // scored window pruned?) assumes a homogeneous, dated snapshot where
    // feed-wide min/max timestamps describe every country series -- true for
    // the lagged UCDP GED / ACLED conflict feeds. Live feeds (settlement lag 0:
    // cyber, unrest) carry heterogeneous observation windows whose max
    // timestamp trails the deadline by design, so the same gate would strand
    // them pending forever; resolve those directly. See #5063.
    const coverage = settlementLagMs > 0 ? summarizeRecordCoverage(feedData) : null;
    if (coverage) {
      if (!coverage.count || !Number.isFinite(coverage.maxTs)) {
        return {
          status: 'pending',
          evidence: {
            reason: 'count_source_no_dated_records',
            deadline,
            metricKey: spec.metricKey,
            sourceRecordCount: coverage.count,
          },
        };
      }
      if (coverage.maxTs < deadline) {
        return {
          status: 'pending',
          evidence: {
            reason: 'count_source_lags_deadline',
            deadline,
            metricKey: spec.metricKey,
            sourceMaxTs: coverage.maxTs,
            sourceRecordCount: coverage.count,
          },
        };
      }
    }
    const count = countMatchingRecords(feedData, parsed.field, parsed.value, generatedAt, deadline);
    if (coverage && Number.isFinite(coverage.minTs) && coverage.minTs > generatedAt && !partialCountEstablishesOutcome(count, spec)) {
      return voidResult('count_source_window_not_retained', entry, spec, parsed, nowMs, {
        sourceMinTs: coverage.minTs,
        sourceMaxTs: coverage.maxTs,
        sourceRecordCount: coverage.count,
        partialMetricValue: count,
      });
    }
    return compareResult(count, spec, entry, parsed, nowMs, {
      sampleSpan: summarizeSamples(samples),
      ...(coverage ? { sourceCoverage: coverage } : {}),
    });
  }

  if (spec.window === 'at-deadline' || spec.window === 'at-endDate') {
    const sample = selectFirstSampleAtOrAfter(samples, deadline);
    const feedValue = extractMetricValue(parsed, feedData);
    if (feedData == null && !sample) {
      return { status: 'pending', evidence: { reason: 'source_feed_unavailable', deadline, metricKey: spec.metricKey } };
    }
    const value = sample && Number.isFinite(sample.value) ? sample.value : feedValue;
    const readTs = sample?.ts ?? nowMs;
    if (!Number.isFinite(value)) return voidResult('no_establishable_metric', entry, spec, parsed, nowMs);
    return compareResult(value, spec, entry, parsed, nowMs, { readTs });
  }

  if (spec.window === 'within-horizon') {
    const timeline = sampleValuesWithin(samples, Number(entry?.generatedAt ?? entry?.firstSeenAt), deadline);
    const feedValue = extractMetricValue(parsed, feedData);
    if (Number.isFinite(feedValue) && nowMs <= deadline) timeline.push({ ts: nowMs, value: feedValue });
    if (!timeline.length) return voidResult('no_establishable_metric', entry, spec, parsed, nowMs);

    if (parsed.fn === 'present') {
      const value = timeline.some((s) => s.value >= 1) ? 1 : 0;
      return compareResult(value, spec, entry, parsed, nowMs, { sampleSpan: summarizeSamples(samples) });
    }

    if (spec.operator === 'crosses') {
      const crossed = timeline.some((s) => crossesThreshold(s.value, spec.threshold, spec.baselineValue));
      const best = crossed
        ? firstCrossing(timeline, spec.threshold, spec.baselineValue)
        : timeline[timeline.length - 1];
      return compareResult(best?.value, spec, entry, parsed, nowMs, { sampleSpan: summarizeSamples(samples), crossed });
    }

    const value = aggregateTimeline(parsed.fn, timeline);
    return compareResult(value, spec, entry, parsed, nowMs, { sampleSpan: summarizeSamples(samples) });
  }

  return voidResult('unsupported_window', entry, spec, parsed, nowMs);
}

export function extractMetricValue(parsed, feedData) {
  const record = findMatchingRecord(feedData, parsed.field, parsed.value);
  if (parsed.fn === 'present') return record ? 1 : 0;
  if (!record) return NaN;

  switch (parsed.fn) {
    case 'riskScore':
      return firstFinite(record.riskScore, record.risk_score, record.score, record.risk);
    case 'yesPrice':
      return firstFinite(record.yesPrice, record.yes_price, record.price, record.probability);
    case 'hexCount':
      return firstFinite(record.hexCount, record.hex_count, record.hexes, record.count);
    case 'price':
      return firstFinite(record.price, record.last, record.value);
    default:
      return NaN;
  }
}

function compareResult(value, spec, entry, parsed, nowMs, extraEvidence = {}) {
  if (!Number.isFinite(value)) return voidResult('no_establishable_metric', entry, spec, parsed, nowMs);
  const threshold = Number(spec.threshold);
  const yes = compare(value, spec.operator, threshold, spec.baselineValue, parsed);
  return {
    status: 'resolved',
    outcome: yes ? 'YES' : 'NO',
    evidence: {
      metricValue: value,
      comparison: comparisonString(value, spec.operator, threshold, spec.baselineValue),
      metricKey: spec.metricKey,
      resolvedAt: nowMs,
      ...extraEvidence,
    },
  };
}

function voidResult(reason, entry, spec, parsed, nowMs, extraEvidence = {}) {
  return {
    status: 'resolved',
    outcome: 'VOID',
    evidence: {
      reason,
      metricKey: spec?.metricKey,
      parsed,
      resolvedAt: nowMs,
      id: entry?.id,
      ...extraEvidence,
    },
  };
}

function compare(value, operator, threshold, baselineValue, parsed) {
  if (operator === '>=') return value >= threshold;
  if (operator === '<=') return value <= threshold;
  if (operator === 'crosses' && parsed?.fn === 'yesPrice') return value >= threshold;
  if (operator === 'crosses') return crossesThreshold(value, threshold, baselineValue);
  return false;
}

function crossesThreshold(value, threshold, baselineValue) {
  if (!Number.isFinite(value) || !Number.isFinite(Number(threshold))) return false;
  const baseline = Number(baselineValue);
  if (!Number.isFinite(baseline)) return value >= threshold;
  if (baseline <= threshold) return value >= threshold;
  return value <= threshold;
}

function firstCrossing(timeline, threshold, baselineValue) {
  return timeline.find((sample) => crossesThreshold(sample.value, threshold, baselineValue)) || null;
}

function comparisonString(value, operator, threshold, baselineValue) {
  if (operator === 'crosses') {
    return `${formatNumber(value)} crosses ${formatNumber(threshold)} from ${formatNumber(baselineValue)}`;
  }
  return `${formatNumber(value)} ${operator} ${formatNumber(threshold)}`;
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value));
}

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function normalizeComparable(value) {
  return String(value ?? '').trim().toLowerCase();
}

// UCDP GED and ACLED name the same country differently: UCDP carries a former
// name in parentheses ("DR Congo (Zaire)", "Myanmar (Burma)", "Yemen (North
// Yemen)") and ACLED drops the article ("Democratic Republic of Congo" vs the
// alias file's "...of the Congo"). A conflict forecast's region is UCDP-named
// but now resolves against the ACLED feed, so canonicalize both toward a shared
// token — parenthetical alternate and the "the" article removed — before
// bridging through country-names.json. Verified collision-free against that
// file (no two ISO codes collapse to the same canonical form).
function canonicalCountryToken(value) {
  return normalizeComparable(value)
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\bthe\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The tokens a country value should be looked up / indexed under: its plain
// normalized form plus, when different, its canonical form.
function countryNameTokens(value) {
  const normalized = normalizeComparable(value);
  if (!normalized) return [];
  const canonical = canonicalCountryToken(value);
  return canonical && canonical !== normalized ? [normalized, canonical] : [normalized];
}

function valueEquals(actual, expected) {
  return normalizeComparable(actual) === normalizeComparable(expected);
}

function countryValueEquals(actual, expected) {
  const actualAliases = countryAliases(actual);
  const expectedAliases = countryAliases(expected);
  for (const alias of actualAliases) {
    if (expectedAliases.has(alias)) return true;
  }
  return false;
}

function metricValueEquals(actual, expected, field) {
  return field === 'country' ? countryValueEquals(actual, expected) : valueEquals(actual, expected);
}

function findMatchingRecord(feedData, field, value) {
  for (const record of iterateRecords(feedData)) {
    if (record && typeof record === 'object' && metricValueEquals(record[field], value, field)) return record;
    if (record && typeof record === 'object') {
      const aliases = fieldAliases(field);
      if (aliases.some((alias) => metricValueEquals(record[alias], value, field))) return record;
    }
  }
  return null;
}

function fieldAliases(field) {
  if (field === 'market') return ['market', 'title', 'question'];
  if (field === 'route') return ['route', 'name', 'label', 'chokepoint'];
  if (field === 'country') return ['country', 'country_name', 'countryName', 'countryCode', 'iso2', 'location'];
  if (field === 'region') return ['region', 'name', 'label'];
  return [field];
}

function loadCountryAliases() {
  const byToken = new Map();
  const link = (a, b) => {
    if (!a || !b) return;
    if (!byToken.has(a)) byToken.set(a, new Set());
    byToken.get(a).add(b);
  };
  try {
    const raw = JSON.parse(readFileSync(new URL('../shared/country-names.json', import.meta.url), 'utf8'));
    for (const [name, code] of Object.entries(raw || {})) {
      const normalizedCode = normalizeComparable(code);
      if (!normalizedCode) continue;
      // Index each name under both its plain and canonical tokens so a UCDP
      // parenthetical / ACLED article-dropped form still bridges to the ISO code
      // that every other spelling of the country shares.
      for (const token of countryNameTokens(name)) {
        link(token, normalizedCode);
        link(normalizedCode, token);
      }
    }
  } catch {
    // Country aliases are a best-effort bridge for mixed ISO/name feeds.
  }
  return byToken;
}

function countryAliases(value) {
  const aliases = new Set();
  for (const token of countryNameTokens(value)) {
    aliases.add(token);
    const direct = COUNTRY_ALIASES.get(token);
    if (direct) {
      for (const alias of direct) aliases.add(alias);
    }
  }
  return aliases;
}

function countMatchingRecords(feedData, field, value, startMs, endMs) {
  let count = 0;
  for (const record of iterateRecords(feedData)) {
    if (!record || typeof record !== 'object') continue;
    const matches = [field, ...fieldAliases(field)].some((key) => metricValueEquals(record[key], value, field));
    if (!matches) continue;
    const ts = extractRecordTime(record);
    if (Number.isFinite(ts) && ts >= startMs && ts <= endMs) count += 1;
  }
  return count;
}

function partialCountEstablishesOutcome(count, spec) {
  const threshold = Number(spec?.threshold);
  if (!Number.isFinite(count) || !Number.isFinite(threshold)) return false;
  if (spec?.operator === '>=') return count >= threshold;
  if (spec?.operator === '<=') return count > threshold;
  return false;
}

// Count specs currently resolve only against homogeneous dated snapshots
// (UCDP GED), where feed-wide min/max dates describe every country series.
// Do not reuse this coverage gate for heterogeneous feeds unless it is scoped
// to the metric filter first.
function summarizeRecordCoverage(feedData) {
  let count = 0;
  let minTs = NaN;
  let maxTs = NaN;
  for (const record of iterateRecords(feedData)) {
    if (!record || typeof record !== 'object') continue;
    const ts = extractRecordTime(record);
    if (!Number.isFinite(ts)) continue;
    count += 1;
    if (!Number.isFinite(minTs) || ts < minTs) minTs = ts;
    if (!Number.isFinite(maxTs) || ts > maxTs) maxTs = ts;
  }
  return { count, minTs, maxTs };
}

function extractRecordTime(record) {
  return firstFinite(
    record.ts,
    record.timestamp,
    record.generatedAt,
    record.firstSeenAt,
    record.lastSeenAt,
    record.occurredAt,
    record.dateStart,
    record.date_start && Date.parse(record.date_start),
    record.event_date && Date.parse(record.event_date),
    record.date && Date.parse(record.date),
    record.eventDate && Date.parse(record.eventDate),
  );
}

function* iterateRecords(value, depth = 0) {
  if (depth > 4 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) yield* iterateRecords(item, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  if (looksLikeRecord(value)) yield value;
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) yield* iterateRecords(child, depth + 1);
  }
}

function looksLikeRecord(value) {
  return Object.values(value).some((child) => typeof child !== 'object' || child == null);
}

function normalizeSamples(samples) {
  if (Array.isArray(samples)) return samples;
  if (Array.isArray(samples?.recent)) return samples.recent;
  if (Array.isArray(samples?.observations)) return samples.observations;
  if (Array.isArray(samples?.values)) return samples.values;
  return [];
}

function selectFirstSampleAtOrAfter(samples, deadline) {
  return normalizeSamples(samples)
    .map(normalizeSample)
    .filter((sample) => sample && sample.ts >= deadline && Number.isFinite(sample.value))
    .sort((a, b) => a.ts - b.ts)[0] || null;
}

function sampleValuesWithin(samples, startMs, endMs) {
  return normalizeSamples(samples)
    .map(normalizeSample)
    .filter((sample) => sample && Number.isFinite(sample.value))
    .filter((sample) => !Number.isFinite(startMs) || (sample.ts >= startMs && sample.ts <= endMs))
    .sort((a, b) => a.ts - b.ts);
}

function normalizeSample(sample) {
  if (!sample || typeof sample !== 'object') return null;
  const ts = firstFinite(sample.ts, sample.timestamp, sample.readTs);
  const value = firstFinite(sample.value, sample.metricValue);
  if (!Number.isFinite(ts)) return null;
  return { ts, value };
}

function summarizeSamples(samples) {
  const normalized = normalizeSamples(samples).map(normalizeSample).filter(Boolean);
  if (!normalized.length) return { count: 0 };
  return {
    count: normalized.length,
    firstTs: Math.min(...normalized.map((s) => s.ts)),
    lastTs: Math.max(...normalized.map((s) => s.ts)),
  };
}

function aggregateTimeline(fn, timeline) {
  if (fn === 'riskScore' || fn === 'hexCount') return Math.max(...timeline.map((s) => s.value));
  return timeline[timeline.length - 1]?.value;
}
