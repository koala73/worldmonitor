// Shared fail-closed parser for producer-owned per-entity freshness reports.
// Health config owns the expected scope and budget; producer metadata only
// supplies observations that must satisfy this contract.

function hasOwnField(value, field) {
  return value !== null
    && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, field);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function entityList(value) {
  return Array.isArray(value)
    ? value
        .filter((entity) => typeof entity === 'string')
        .slice(0, 40)
        .map((entity) => entity.slice(0, 8))
    : [];
}

// Returns a private `fieldPresent` bit in addition to the wire fields. A JSON
// field that is present but malformed is a producer regression; only a truly
// absent field can receive deployment-order activation grace.
export function buildContentFreshnessAssessment(meta, requirement, now) {
  if (!requirement) return null;

  const block = meta?.contentFreshness;
  const fieldPresent = hasOwnField(meta, 'contentFreshness');
  const blockPresent = isPlainObject(block);
  const count = nonNegativeInteger;
  const coveredCount = count(block?.coveredCount);
  const freshCount = count(block?.freshCount);
  const staleCount = count(block?.staleCount);
  const unknownCount = count(block?.unknownCount);
  const criticalCountries = entityList(block?.criticalCountries);
  const criticalFreshCount = count(block?.criticalFreshCount);
  const expectedCountries = Array.isArray(requirement.countries)
    ? requirement.countries
    : [];
  const expectedBudgetMinutes = Number(requirement.budgetMinutes);
  const criticalOldestObservedAt = finiteNumber(block?.criticalOldestObservedAt);
  const criticalAgeMs = criticalOldestObservedAt === null || !Number.isFinite(now)
    ? null
    : now - criticalOldestObservedAt;
  const criticalAgeMinutes = criticalAgeMs === null
    ? null
    : Math.round(criticalAgeMs / 60_000);
  const declaredScopeCoversExpected = expectedCountries.length > 0
    && expectedCountries.every((entity) => criticalCountries.includes(entity));

  const unusableReasons = [];
  if (coveredCount === null) unusableReasons.push('covered_count_unusable');
  if (freshCount === null) unusableReasons.push('fresh_count_unusable');
  else if (coveredCount !== null && freshCount > coveredCount) {
    unusableReasons.push('fresh_exceeds_covered');
  }
  if (staleCount === null) unusableReasons.push('stale_count_unusable');
  if (unknownCount === null) unusableReasons.push('unknown_count_unusable');
  if (
    coveredCount !== null
    && freshCount !== null
    && staleCount !== null
    && unknownCount !== null
    && freshCount + staleCount + unknownCount !== coveredCount
    // Keep the existing, more specific diagnostic stable when freshCount is
    // itself above the covered denominator.
    && freshCount <= coveredCount
  ) {
    unusableReasons.push('content_counts_inconsistent');
  }
  if (!declaredScopeCoversExpected) unusableReasons.push('declared_scope_narrowed');
  if (criticalFreshCount === null) unusableReasons.push('critical_fresh_count_unusable');
  else if (criticalFreshCount > criticalCountries.length) {
    unusableReasons.push('critical_fresh_exceeds_declared');
  }
  if (criticalFreshCount !== null && coveredCount !== null && criticalFreshCount > coveredCount) {
    unusableReasons.push('critical_fresh_exceeds_covered');
  }
  if (!Number.isFinite(expectedBudgetMinutes) || expectedBudgetMinutes <= 0) {
    unusableReasons.push('expected_budget_unusable');
  }
  // A block claiming every critical country is fresh but carrying no usable
  // observation time cannot be re-aged, so its freshness is unprovable.
  if (
    blockPresent
    && criticalOldestObservedAt === null
    && criticalFreshCount !== null
    && criticalCountries.length > 0
    && criticalFreshCount === criticalCountries.length
  ) {
    unusableReasons.push('critical_observation_time_unusable');
  }

  const usable = unusableReasons.length === 0;
  const budgetMs = Number.isFinite(expectedBudgetMinutes) && expectedBudgetMinutes > 0
    ? expectedBudgetMinutes * 60_000
    : null;
  return {
    fieldPresent,
    usable,
    unusableReasons,
    expectedCriticalCountries: expectedCountries,
    budgetMinutes: Number.isFinite(expectedBudgetMinutes) ? expectedBudgetMinutes : null,
    coveredCount,
    freshCount,
    staleCount,
    unknownCount,
    staleCountries: entityList(block?.staleCountries),
    staleCountriesTruncated: count(block?.staleCountriesTruncated) ?? 0,
    oldestObservedAt: finiteNumber(block?.oldestObservedAt),
    oldestObservedCountry: typeof block?.oldestObservedCountry === 'string'
      ? block.oldestObservedCountry.slice(0, 8)
      : null,
    oldestAgeMinutes: finiteNumber(block?.oldestAgeMinutes) === null
      ? null
      : Math.round(block.oldestAgeMinutes),
    criticalCountries,
    criticalFreshCount,
    criticalStaleCountries: entityList(block?.criticalStaleCountries),
    criticalMissingCountries: count(block?.criticalMissingCountries),
    criticalOldestObservedAt,
    criticalOldestObservedCountry: typeof block?.criticalOldestObservedCountry === 'string'
      ? block.criticalOldestObservedCountry.slice(0, 8)
      : null,
    criticalOldestAgeMinutes: criticalAgeMinutes,
    // Compare raw milliseconds inclusively. The producer treats exactly-at-
    // budget as stale; rounded minutes would accept up to 29,999ms over.
    contentStale: usable
      ? criticalFreshCount < criticalCountries.length
        || criticalAgeMs === null
        || criticalAgeMs < 0
        || (budgetMs !== null && criticalAgeMs >= budgetMs)
      : false,
  };
}

export function projectContentFreshnessForWire(assessment) {
  if (!assessment) return null;
  const { fieldPresent: _fieldPresent, ...wire } = assessment;
  return wire;
}
