// Pure forecast-resolution evaluator for Bet 2 (#5007).
//
// This module has no Redis, R2, or wall-clock reads. Callers pass the ledger
// entry, current feed snapshot, observed samples, and nowMs; output is a
// deterministic pending/resolved result with evidence.

import { readFileSync } from 'node:fs';

// Cadence-keyed FRED sets derive from the shared series registry so the
// settlement grace can never disagree with the template's declared cadence.
import { FRED_MONTHLY_FEED_KEYS, FRED_DAILY_FEED_KEYS } from './_fred-series.mjs';
import { finiteObservations } from './_bet-templates-macro.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
export const ACLED_SETTLEMENT_LAG_MS = 2 * DAY_MS;
export const UCDP_SETTLEMENT_LAG_MS = 14 * DAY_MS;
// Default grace before a missing reading VOIDs: a count feed that stays down
// past its settlement lag, or a scalar record that never settles. A live point
// read reaches LATE_READ_MAX_LAG_MS first.
export const VALUE_SETTLEMENT_MAX_LAG_MS = 10 * DAY_MS;
// EIA's weekly petroleum observation date trails publication by roughly one
// week. A deadline just after the covered period may therefore need the next
// report (plus holiday slack) before `asOf` reaches the deadline.
export const EIA_VALUE_SETTLEMENT_MAX_LAG_MS = 14 * DAY_MS;
// Prediction-market settlement (#5525 KTD2): the venue adjudicates after
// endDate; the settlement loader then needs a run to capture it. Pend up to
// this long past the deadline for the adjudicated record before VOIDing.
export const MARKET_SETTLEMENT_FEED_KEY = 'prediction:markets-resolution:v1';
const MARKET_BOOTSTRAP_FEED_KEY = 'prediction:markets-bootstrap:v1';
export const MARKET_SETTLEMENT_MAX_LAG_MS = 14 * DAY_MS;
// FRED (#5525 KTD4): monthly series observations are dated the FIRST of the
// reference month and publish ~2 weeks after the month ENDS, so the first
// observation dated >= a mid-month deadline lands ~45-70 days after that
// deadline. Grace must cover next-observation gap + publication lag. DGS10 is
// a daily series and settles fast.
export const FRED_MONTHLY_VALUE_SETTLEMENT_MAX_LAG_MS = 75 * DAY_MS;
export const FRED_DAILY_VALUE_SETTLEMENT_MAX_LAG_MS = 14 * DAY_MS;

// Feeds that date each reading by its own period or by the venue's
// adjudication, so a read days after the deadline still reports the
// deadline's period. null for a live feed, whose reading is the value at the
// moment it was fetched.
function periodFeedMaxLagMs(feedKey) {
  if (feedKey === 'energy:eia-petroleum:v1') return EIA_VALUE_SETTLEMENT_MAX_LAG_MS;
  if (feedKey === MARKET_SETTLEMENT_FEED_KEY) return MARKET_SETTLEMENT_MAX_LAG_MS;
  if (FRED_MONTHLY_FEED_KEYS.has(feedKey)) return FRED_MONTHLY_VALUE_SETTLEMENT_MAX_LAG_MS;
  if (FRED_DAILY_FEED_KEYS.has(feedKey)) return FRED_DAILY_VALUE_SETTLEMENT_MAX_LAG_MS;
  return null;
}

function valueSettlementMaxLagMs(feedKey) {
  return periodFeedMaxLagMs(feedKey) ?? VALUE_SETTLEMENT_MAX_LAG_MS;
}

// A live point read happens on the first resolver run after the deadline. The
// resolver runs once a day (cron `0 6 * * *`); its runs start between 06:00
// and 06:05 UTC, so that read lands at most one cycle plus a few minutes after
// the deadline. The hour absorbs the start jitter. A missed run puts the next
// read past the bound, and the price it reads is no longer the deadline's.
export const LATE_READ_MAX_LAG_MS = DAY_MS + 60 * 60 * 1000;
export const LATE_READ_VOID_REASON = 'late_read';
export const FEED_UNAVAILABLE_VOID_REASON = 'feed_unavailable';

export function isLivePointRead(spec) {
  const parsed = parseMetricKey(spec?.metricKey);
  return (spec?.window === 'at-deadline' || spec?.window === 'at-endDate')
    && periodFeedMaxLagMs(parsed?.feedKey || spec?.sourceFeed) == null;
}

// The first finite reading taken on time: at or after the deadline and within
// one resolver cycle of it.
export function firstTimelySample(samples, deadline) {
  return normalizeSamples(samples)
    .map(normalizeSample)
    .filter((sample) => sample && Number.isFinite(sample.value) && sample.ts >= deadline && sample.ts - deadline <= LATE_READ_MAX_LAG_MS)
    .sort((a, b) => a.ts - b.ts)[0] || null;
}

const SUPPORTED_FUNCTIONS = new Set(['count', 'riskScore', 'present', 'yesPrice', 'hexCount', 'price', 'value']);
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

  // The bootstrap feed lists only open markets and clips yesPrice to [10, 90],
  // so a read at endDate is the crowd's price, never the market's outcome
  // (#5233). Bets read the settlement feed instead.
  if (parsed.fn === 'yesPrice' && (spec.sourceFeed === MARKET_BOOTSTRAP_FEED_KEY || parsed.feedKey === MARKET_BOOTSTRAP_FEED_KEY)) {
    return voidResult('market_price_not_outcome', entry, spec, parsed, nowMs);
  }

  if (isLivePointRead(spec)) {
    const timely = firstTimelySample(samples, deadline);
    if (timely) return compareResult(timely.value, spec, entry, parsed, nowMs, { readTs: timely.ts });
    if (nowMs - deadline > LATE_READ_MAX_LAG_MS) {
      const reason = feedData == null ? FEED_UNAVAILABLE_VOID_REASON : LATE_READ_VOID_REASON;
      return voidResult(reason, entry, spec, parsed, nowMs, { maxReadLagMs: LATE_READ_MAX_LAG_MS });
    }
  }

  // Settlement gate for scalar `value`/`price` reads at a POINT window
  // (at-deadline). Like count(), a premature or STALE read scores a false
  // YES/NO: a period feed (EIA weekly, dated by `asOf`) may still hold the prior
  // period's value, and a live feed kept warm through a fetch failure
  // (commodities, whose shaper stamps each quote with the envelope
  // `_seed.fetchedAt` as `asOf`) may hold a quote dated days before the
  // deadline. Only resolve once the matched record is dated on/after the
  // deadline day; pend until then, VOID if it never settles. Records with no
  // timestamp fall through (cannot gate). within-horizon is exempt — it resolves
  // from the asOf-stamped sample timeline, not the current feed record.
  const isPointWindow = spec.window === 'at-deadline' || spec.window === 'at-endDate';
  const isSettlementYesPrice = parsed.fn === 'yesPrice'
    && (parsed.feedKey === MARKET_SETTLEMENT_FEED_KEY || spec.sourceFeed === MARKET_SETTLEMENT_FEED_KEY);
  if (isPointWindow && (parsed.fn === 'value' || parsed.fn === 'price' || isSettlementYesPrice)) {
    const settle = valueSettlementResult(parsed, feedData, deadline, nowMs, entry, spec);
    if (settle) return settle;
  }

  if (parsed.fn === 'count') {
    const settlementLagMs = countSettlementLagMs(parsed.feedKey || spec.sourceFeed);
    const sealAfter = deadline + settlementLagMs;
    if (nowMs < sealAfter) {
      return { status: 'pending', evidence: { reason: 'count_settlement_lag', deadline, sealAfter } };
    }
    // Count records are dated and the coverage gate below refuses a pruned
    // window, so only a feed that stays down needs a bound.
    if (feedData == null) {
      if (nowMs >= sealAfter + VALUE_SETTLEMENT_MAX_LAG_MS) return voidResult(FEED_UNAVAILABLE_VOID_REASON, entry, spec, parsed, nowMs);
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
      if (nowMs >= deadline + valueSettlementMaxLagMs(parsed.feedKey || spec.sourceFeed)) {
        return voidResult(FEED_UNAVAILABLE_VOID_REASON, entry, spec, parsed, nowMs);
      }
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

// Point-in-time projection contract (#7075): the metric is read from the
// nearest finite sample within the contract's stored tolerance of its horizon
// deadline, on either side. UNOBSERVED is terminal and distinct from NO (the
// state was never read, not read absent) and from VOID (the contract itself
// was complete). The live feed is never consulted here: a sample the sampler
// did not store inside the tolerance does not exist for this contract.
export function resolveHorizonSpec(entry, nowMs) {
  const spec = entry?.spec;
  const parsed = parseMetricKey(spec?.metricKey);
  const deadline = Number(spec?.deadline ?? entry?.deadline);
  const toleranceMs = Number(spec?.sampleToleranceMs);
  if (spec?.kind !== 'hard' || !parsed || !Number.isFinite(deadline) || !Number.isFinite(Number(spec.threshold)) || !Number.isFinite(toleranceMs)) {
    return voidResult('incomplete_horizon_contract', entry, spec, parsed, nowMs);
  }
  if (nowMs < deadline) {
    return { status: 'pending', evidence: { reason: 'deadline_not_reached', deadline } };
  }
  const nearest = nearestFiniteSample(entry.samples, deadline);
  if (nearest && Math.abs(nearest.ts - deadline) <= toleranceMs) {
    return compareResult(nearest.value, spec, entry, parsed, nowMs, {
      readTs: nearest.ts,
      offsetMs: nearest.ts - deadline,
      sampleToleranceMs: toleranceMs,
    });
  }
  if (nowMs < deadline + toleranceMs) {
    return { status: 'pending', evidence: { reason: 'awaiting_sample_in_tolerance', deadline, sampleToleranceMs: toleranceMs } };
  }
  return {
    status: 'resolved',
    outcome: 'UNOBSERVED',
    evidence: {
      reason: 'no_sample_in_tolerance',
      metricKey: spec.metricKey,
      deadline,
      sampleToleranceMs: toleranceMs,
      nearestSampleTs: nearest?.ts,
      nearestOffsetMs: nearest ? nearest.ts - deadline : undefined,
      resolvedAt: nowMs,
    },
  };
}

function nearestFiniteSample(samples, deadline) {
  let nearest = null;
  for (const sample of samples?.recent || []) {
    const ts = Number(sample?.ts);
    const value = Number(sample?.value);
    if (!Number.isFinite(ts) || !Number.isFinite(value)) continue;
    if (!nearest || Math.abs(ts - deadline) < Math.abs(nearest.ts - deadline)) nearest = { ts, value };
  }
  return nearest;
}

// Freshness gate for a scalar `value` read: is the matched record dated on or
// after the deadline day? Returns null when settled (or when the record carries
// no usable timestamp, so we can't gate — fall through to normal resolution),
// a pending result while within the grace window, or VOID once grace elapses.
function valueSettlementResult(parsed, feedData, deadline, nowMs, entry, spec) {
  const maxLagMs = valueSettlementMaxLagMs(parsed.feedKey || spec?.sourceFeed);
  const record = findMatchingRecord(feedData, parsed.field, parsed.value);
  if (!record) {
    // Whole-feed-down is handled by the window path (source_feed_unavailable);
    // here the feed is PRESENT but the matched record is absent — a partial
    // refresh that dropped this symbol. Pend through the grace so a transient
    // gap doesn't immediately VOID; VOID only if it never returns (#5243 P2).
    if (feedData == null) return null;
    if (nowMs < deadline + maxLagMs) {
      return { status: 'pending', evidence: { reason: 'value_source_record_missing', deadline } };
    }
    return voidResult('value_source_never_settled', entry, spec, parsed, nowMs);
  }
  // A settlement-feed record is the venue's ADJUDICATED outcome — terminal
  // truth regardless of when adjudication was stamped (a market can settle
  // early, dating asOf before the deadline day). Resolve on presence alone.
  if (parsed.feedKey === MARKET_SETTLEMENT_FEED_KEY || spec?.sourceFeed === MARKET_SETTLEMENT_FEED_KEY) return null;
  const asOf = parseAsOfMs(record.asOf ?? record.date);
  if (!Number.isFinite(asOf)) return null; // record present but no timestamp → cannot gate
  const deadlineDay = Math.floor(deadline / DAY_MS) * DAY_MS;
  if (asOf >= deadlineDay) return null; // feed has caught up to the deadline period
  if (nowMs < deadline + maxLagMs) {
    return { status: 'pending', evidence: { reason: 'value_source_not_settled', deadline, asOf } };
  }
  return voidResult('value_source_never_settled', entry, spec, parsed, nowMs);
}

function parseAsOfMs(value) {
  if (value == null) return NaN;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function valueFromRecord(fn, record) {
  switch (fn) {
    case 'riskScore':
      // supply_chain:chokepoints:v4 publishes disruptionScore; the generator
      // renames it to riskScore before the detector reads it, the resolver does not.
      return firstFinite(record.riskScore, record.risk_score, record.disruptionScore, record.score, record.risk);
    case 'yesPrice':
      return firstFinite(record.yesPrice, record.yes_price, record.price, record.probability);
    case 'hexCount':
      return firstFinite(record.hexCount, record.hex_count, record.hexes, record.count);
    case 'price':
      return firstFinite(record.price, record.last, record.value);
    case 'value':
      // Generic scalar read for numeric feeds (energy/economic bet engine,
      // #5233). Feed loaders shape a metric snapshot into records carrying
      // `value` (with `current` as the natural fallback for period feeds).
      return firstFinite(record.value, record.current, record.last, record.price);
    default:
      return NaN;
  }
}

export function extractMetricValue(parsed, feedData) {
  const record = findMatchingRecord(feedData, parsed.field, parsed.value);
  if (parsed.fn === 'present') return record ? 1 : 0;
  if (!record) return NaN;
  return valueFromRecord(parsed.fn, record);
}

// Value AND the source observation time (`asOf`) of the matched record. Callers
// that STORE a sample must stamp it with this asOf, not the cycle time — a stale
// kept-warm reading carries a pre-deadline asOf, so stamping it with the cycle
// time would let a settlement-gated resolution later prefer that stale sample
// over the fresh feed (#5243 P1). asOf is null when the record has no timestamp.
export function extractMetricObservation(parsed, feedData) {
  const record = findMatchingRecord(feedData, parsed.field, parsed.value);
  // present() is a boolean existence check: a missing matched record means the
  // event did NOT occur → observe 0, NOT NaN. Returning NaN here (as the initial
  // refactor did) makes a quiet subject store an error sample instead of a valid
  // 0, so a legitimately-NO within-horizon spec strands with an empty timeline
  // and VOIDs. Mirror extractMetricValue's `record ? 1 : 0`.
  if (parsed.fn === 'present') {
    const asOf = record ? parseAsOfMs(record.asOf ?? record.date) : NaN;
    return { value: record ? 1 : 0, asOf: Number.isFinite(asOf) ? asOf : null };
  }
  if (!record) return { value: NaN, asOf: null };
  const asOf = parseAsOfMs(record.asOf ?? record.date);
  return { value: valueFromRecord(parsed.fn, record), asOf: Number.isFinite(asOf) ? asOf : null };
}

// Feed loaders shape a raw feed snapshot into the record collection the eval's
// metricKey path expression reads. energy:eia-petroleum:v1 stores a flat
// {wti,brent,production,inventory} each {current,...}; bets read it as
// `value(metric==<name>)`, so expose one record per metric carrying `value`.
export function shapeResolutionFeed(key, data) {
  if (key === 'energy:eia-petroleum:v1') {
    const d = data?.data ?? data;
    if (!d || typeof d !== 'object') return data;
    const records = [];
    for (const metric of ['wti', 'brent', 'production', 'inventory']) {
      const m = d[metric];
      const value = Number(m?.current);
      if (Number.isFinite(value)) records.push({ metric, value, unit: m?.unit, asOf: m?.date });
    }
    return records;
  }
  if (key === 'market:commodities-bootstrap:v1') {
    // Enveloped as {_seed, data:{quotes:[...]}}. The eval's iterateRecords only
    // descends into ARRAY children, so the doubly-nested quotes array is
    // invisible as-is — expose it directly so `price(symbol==<SYM>)` resolves.
    // (Also unblocks the pre-existing market commodity-price forecast path.)
    // Quotes carry no per-symbol timestamp; stamp each with the envelope's
    // `_seed.fetchedAt` as `asOf` so the settlement gate can refuse to resolve a
    // stale kept-warm quote (extendExistingTtl preserves the old fetchedAt) as
    // if it were the deadline-time price.
    const fetchedAt = Number(data?._seed?.fetchedAt);
    const d = data?.data ?? data;
    if (Array.isArray(d?.quotes)) {
      return d.quotes.map((q) => (q && typeof q === 'object' && Number.isFinite(fetchedAt) ? { ...q, asOf: fetchedAt } : q));
    }
    return d;
  }
  if (key.startsWith('economic:fred:v1:')) {
    // FRED (#5525): stored as {series:{observations:[{date,value},...]}} per
    // #5098; FRED marks missing values with '.'. Expose one record carrying the
    // latest finite observation — `value(metric==<SERIES>)` reads it, and the
    // observation date is the settlement `asOf` the calendar-derived grace
    // gates on (KTD4). SERIES is the 4th key segment (exact `:0`-suffixed keys).
    const series = key.split(':')[3];
    const d = data?.data ?? data;
    // Shared filter with the bet generator (finiteObservations in
    // _bet-templates-macro.mjs) — the '.'-sentinel handling must not drift
    // between generation and resolution.
    const finite = finiteObservations(d);
    const latest = finite[finite.length - 1];
    return latest ? [{ metric: series, value: latest.value, asOf: latest.date }] : [];
  }
  if (key === MARKET_SETTLEMENT_FEED_KEY) {
    // Settlement feed (#5525 KTD2): records already carry {market, slug,
    // yesPrice, asOf} — expose the array directly.
    const d = data?.data ?? data;
    return Array.isArray(d?.records) ? d.records : (Array.isArray(d) ? d : []);
  }
  // Contract-mode seeds store {_seed, data:{threats|outages|...}}. iterateRecords
  // descends only into arrays, so a raw envelope yields no records and every
  // count reads 0 (#5233). Legacy bare values pass through unchanged.
  return unwrapEnvelope(data).data;
}

// The resolver's keyed feed view: each successfully read key mapped to its
// shaped snapshot. Emission-time shadow checks build the same view so the
// extractor sees identical input at emission and at resolution (#7067).
export function shapeResolutionFeeds(rawByKey) {
  return Object.fromEntries(Object.entries(rawByKey || {}).map(([key, data]) => [key, shapeResolutionFeed(key, data)]));
}

export function selectResolutionFeed(feedsByKey, spec, parsed) {
  return feedsByKey?.[spec?.sourceFeed] ?? feedsByKey?.[parsed?.feedKey];
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
