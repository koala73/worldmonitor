/**
 * Whether the account holds the travel risk assessment grant (#10451): Pro
 * Business, API Business and Enterprise.
 *
 * The server enforces it in the MCP tool (`api/mcp/auth.ts` reads
 * `features.travelRiskAssessment`). This copy is the browser's presentation
 * gate for the focus bar's "Draft assessment" action, so an account that
 * could not run the tool is not shown it. It protects nothing: the action
 * only copies a request that names the countries the account already sees.
 *
 * `travelRiskAssessment` must be the MERGED value, and `undefined` is
 * fail-closed. `tier >= 1` is the floor no catalog typo can lower, as in
 * `hasTabFocus`.
 */

export interface TravelRiskEntitlement {
  features: { tier: number; travelRiskAssessment?: boolean };
  validUntil: number;
}

export function hasTravelRiskAssessment(
  entitlement: TravelRiskEntitlement | null | undefined,
  now: number,
): boolean {
  if (!entitlement) return false;
  return (
    entitlement.features.tier >= 1 &&
    entitlement.features.travelRiskAssessment === true &&
    entitlement.validUntil >= now
  );
}
