// The travel-advisory registers and the one test of whether a register
// contributed. scripts/seed-security-advisories.mjs uses it for its source
// health (`failedSources` on seed-meta) and the CII scorer uses it on the
// stored item list (`sourcesMissing` on the risk-scores input report), so the
// two cannot disagree about which register is missing.

/**
 * `sourceCountry` of every advisory feed with a `levelParser`: the registers
 * byCountry is built from. Pinned to the seeder's feed list by
 * tests/cii-advisory-provenance.test.mts.
 */
export const ADVISORY_LEVEL_REGISTERS = Object.freeze(['AU', 'US']);

/** An item that gives a country a travel level ('info' and country-less items do not). */
export function isLevelledAdvisoryItem(item) {
  return Boolean(item && typeof item === 'object' && item.country && item.level && item.level !== 'info');
}

/** The registers in `registers` with no levelled item among `items`, sorted. */
export function missingAdvisoryRegisters(items, registers = ADVISORY_LEVEL_REGISTERS) {
  const present = new Set(
    (Array.isArray(items) ? items : []).filter(isLevelledAdvisoryItem).map((item) => String(item.sourceCountry ?? '')),
  );
  return registers.filter((register) => !present.has(register)).sort();
}
