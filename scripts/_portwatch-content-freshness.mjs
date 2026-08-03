// PortWatch content-freshness policy. The seeder owns fetching and persistence;
// this module owns the bounded report, critical refresh deadline, and queue
// ordering so those contracts can be tested without loading the full runner.

export const PORTWATCH_CONTENT_FRESHNESS_BUDGET_MINUTES = 72 * 60;
export const PORTWATCH_CONTENT_FRESHNESS_CADENCE_MINUTES = 12 * 60;
export const PORTWATCH_MAX_REPORTED_STALE_COUNTRIES = 40;
export const PORTWATCH_CONTENT_FRESHNESS_ACTIVATION_KEY =
  'seed-activated:supply_chain:portwatch-ports:content-freshness';
export const PORTWATCH_DECISION_CRITICAL_COUNTRIES = Object.freeze(['CN', 'HK']);

export function isCriticalContentRefreshDue({
  iso2,
  prevPayload,
  now = Date.now(),
  budgetMinutes = PORTWATCH_CONTENT_FRESHNESS_BUDGET_MINUTES,
  cadenceMinutes = PORTWATCH_CONTENT_FRESHNESS_CADENCE_MINUTES,
  criticalCountries = PORTWATCH_DECISION_CRITICAL_COUNTRIES,
}) {
  if (!new Set(criticalCountries).has(iso2)) return false;
  const observedAt = typeof prevPayload?.fetchedAt === 'string'
    ? Date.parse(prevPayload.fetchedAt)
    : Number.NaN;
  if (!Number.isFinite(observedAt)) return true;
  const ageMs = now - observedAt;
  if (ageMs < 0) return true;
  const budgetMs = budgetMinutes * 60_000;
  const leadMs = Math.max(0, cadenceMinutes * 60_000);
  // Reserve the next scheduled run before the hard budget. This keeps a
  // cache-hit critical payload out of the seven-day cache path early enough
  // that a normal 12h cadence still has a chance to refresh it before 72h.
  return ageMs >= Math.max(0, budgetMs - leadMs);
}

export function orderColdFetchQueue(
  needsFetch,
  criticalCountries = PORTWATCH_DECISION_CRITICAL_COUNTRIES,
) {
  const critical = new Set(criticalCountries);
  const lastAttemptAt = (item) => {
    const prev = item?.prevPayload;
    if (!prev || typeof prev !== 'object') return Number.NEGATIVE_INFINITY;
    if (Number.isFinite(prev.refreshAttemptedAt)) return prev.refreshAttemptedAt;
    if (Number.isFinite(prev.cacheWrittenAt)) return prev.cacheWrittenAt;
    return Number.NEGATIVE_INFINITY;
  };
  const stableId = (item) => String(item?.iso2 || item?.iso3 || '');
  const priority = (item) => (critical.has(item?.iso2) ? 0 : 1);
  return [...needsFetch].sort((a, b) => {
    const priorityOrder = priority(a) - priority(b);
    if (priorityOrder !== 0) return priorityOrder;
    const ageOrder = lastAttemptAt(a) - lastAttemptAt(b);
    return ageOrder || stableId(a).localeCompare(stableId(b));
  });
}

export function buildContentFreshnessReport({
  countryData,
  now = Date.now(),
  budgetMinutes = PORTWATCH_CONTENT_FRESHNESS_BUDGET_MINUTES,
  maxStaleCountries = PORTWATCH_MAX_REPORTED_STALE_COUNTRIES,
  criticalCountries = PORTWATCH_DECISION_CRITICAL_COUNTRIES,
}) {
  const budgetMs = budgetMinutes * 60_000;
  const entries = countryData instanceof Map ? [...countryData.entries()] : [];
  const critical = new Set(criticalCountries);
  let freshCount = 0;
  let staleCount = 0;
  let unknownCount = 0;
  let criticalFreshCount = 0;
  let criticalSeen = 0;
  const staleCountries = [];
  const criticalStaleCountries = [];
  let oldestObservedAt = null;
  let oldestObservedCountry = null;
  let criticalOldestObservedAt = null;
  let criticalOldestObservedCountry = null;

  for (const [iso2, payload] of entries) {
    const isCritical = critical.has(iso2);
    if (isCritical) criticalSeen++;
    const observedAt = typeof payload?.fetchedAt === 'string'
      ? Date.parse(payload.fetchedAt)
      : Number.NaN;
    if (!Number.isFinite(observedAt)) {
      unknownCount++;
      staleCountries.push(iso2);
      if (isCritical) criticalStaleCountries.push(iso2);
      continue;
    }
    if (oldestObservedAt === null || observedAt < oldestObservedAt) {
      oldestObservedAt = observedAt;
      oldestObservedCountry = iso2;
    }
    if (isCritical
      && (criticalOldestObservedAt === null || observedAt < criticalOldestObservedAt)) {
      criticalOldestObservedAt = observedAt;
      criticalOldestObservedCountry = iso2;
    }
    const age = now - observedAt;
    // age < 0 is a future-dated observation: an upstream clock skew or a
    // forecast mislabelled as an observation, never evidence of freshness.
    if (age < 0 || age >= budgetMs) {
      staleCount++;
      staleCountries.push(iso2);
      if (isCritical) criticalStaleCountries.push(iso2);
      continue;
    }
    freshCount++;
    if (isCritical) criticalFreshCount++;
  }

  // A declared critical country the run never published cannot be fresh, and
  // must be named rather than quietly dropping out of the denominator.
  for (const iso2 of criticalCountries) {
    if (!(countryData instanceof Map) || !countryData.has(iso2)) {
      criticalStaleCountries.push(iso2);
    }
  }

  staleCountries.sort();
  criticalStaleCountries.sort();
  return {
    budgetMinutes,
    assessedAt: now,
    coveredCount: entries.length,
    freshCount,
    staleCount,
    unknownCount,
    staleCountries: staleCountries.slice(0, maxStaleCountries),
    staleCountriesTruncated: Math.max(0, staleCountries.length - maxStaleCountries),
    oldestObservedAt,
    oldestObservedCountry,
    oldestAgeMinutes: oldestObservedAt === null
      ? null
      : Math.round((now - oldestObservedAt) / 60_000),
    criticalCountries: [...criticalCountries].sort(),
    criticalFreshCount,
    criticalStaleCountries,
    criticalMissingCountries: criticalCountries.length - criticalSeen,
    criticalOldestObservedAt,
    criticalOldestObservedCountry,
    criticalOldestAgeMinutes: criticalOldestObservedAt === null
      ? null
      : Math.round((now - criticalOldestObservedAt) / 60_000),
  };
}

export function buildPortActivityMetaPayload({ countryData, coverage, now = Date.now() }) {
  return {
    fetchedAt: now,
    recordCount: countryData instanceof Map ? countryData.size : 0,
    coverage,
    contentFreshness: buildContentFreshnessReport({ countryData, now }),
  };
}
