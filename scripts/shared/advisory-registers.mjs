// The travel-advisory registers and the one test of whether a register
// contributed. scripts/seed-security-advisories.mjs uses it on everything it
// fetched for its source health (`failedSources` on seed-meta) and publishes
// the outcome as `registersPresent`; the CII scorer reads that field for
// `sourcesMissing` on the risk-scores input report, so the two cannot disagree
// about which register is missing.

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

/**
 * The registers a stored advisory payload is missing, or null when it cannot
 * say. `registersPresent` comes from the seeder's full fetch. The stored item
 * list is only the newest 15 per feed, so a register whose newest items carry
 * no level is absent from it while still being in the index; the list is read
 * only for payloads written before the field existed.
 */
export function missingRegistersFromPayload(payload, registers = ADVISORY_LEVEL_REGISTERS) {
  const present = payload?.registersPresent;
  if (Array.isArray(present)) return registers.filter((register) => !present.includes(register)).sort();
  return Array.isArray(payload?.advisories) ? missingAdvisoryRegisters(payload.advisories, registers) : null;
}
