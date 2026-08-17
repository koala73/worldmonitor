/**
 * Contract-first services that may exist before their runtime is allowed to route.
 *
 * Extracted from scripts/enforce-sebuf-api-contract.mjs so the classification logic is
 * importable — and therefore testable — without executing the gate's top-level scan.
 *
 * Keep this list narrow. Each entry must name the issue whose acceptance removes the
 * exception, an owner, and a review date. The checks below reject an entry once its
 * service disappears, once it gains an HTTP gateway, or once its review date passes:
 * the first two end the deferral by design, and the third exists because neither of
 * them fires in the state that actually rots — the service sits gateway-less forever
 * because the tracking issue was deprioritised or closed unimplemented. Nothing here
 * reads GitHub, so the date is the only thing that forces a human to re-affirm.
 */
export const DEFERRED_GENERATED_SERVICES = new Map([
  [
    'company_monitoring/v1',
    {
      removalIssue: '#6003',
      owner: '@koala73',
      // Re-affirm or remove by this date. Chosen as ~3 months from the contract landing
      // (2026-08-05); shorten it if #6003 is scheduled sooner.
      reviewBy: '2026-11-05',
    },
  ],
]);

/**
 * Classifies every deferred entry against what the tree actually contains.
 *
 * @param {object} args
 * @param {Map<string, {removalIssue: string, owner: string, reviewBy: string}>} args.deferred
 * @param {Set<string>} args.seenGeneratedServices  keys found under the generated server tree
 * @param {Set<string>} args.seenGatewayDomains     keys that have an api/ gateway
 * @param {boolean} args.generatedTreePresent       whether the generated server dir exists at all
 * @param {string} args.today                       ISO date (YYYY-MM-DD) used for expiry
 * @returns {Array<{file: string, message: string, remedy: string}>}
 */
export function collectDeferredServiceViolations({
  deferred,
  seenGeneratedServices,
  seenGatewayDomains,
  generatedTreePresent,
  today,
}) {
  const violations = [];
  const file = 'scripts/lib/sebuf-deferred-services.mjs';

  for (const [key, entry] of deferred) {
    const { removalIssue, owner, reviewBy } = entry;

    // "Absent generated tree" and "service was removed" are indistinguishable from an
    // empty seenGeneratedServices, and they need opposite fixes. Only claim the service
    // is gone when we actually scanned a tree that could have contained it.
    if (generatedTreePresent && !seenGeneratedServices.has(key)) {
      violations.push({
        file,
        message: `deferred generated service ${key} no longer exists`,
        remedy: `Remove its DEFERRED_GENERATED_SERVICES entry (tracked by ${removalIssue}, owner ${owner}).`,
      });
      continue;
    }

    if (seenGatewayDomains.has(key)) {
      violations.push({
        file,
        message: `deferred generated service ${key} now has an HTTP gateway`,
        remedy: `Remove its DEFERRED_GENERATED_SERVICES entry (tracked by ${removalIssue}, owner ${owner}).`,
      });
      continue;
    }

    if (reviewBy && today > reviewBy) {
      violations.push({
        file,
        message: `deferred generated service ${key} passed its ${reviewBy} review date`,
        remedy: `${owner}: land ${removalIssue} and remove this entry, or push reviewBy out with a written reason.`,
      });
    }
  }

  return violations;
}
