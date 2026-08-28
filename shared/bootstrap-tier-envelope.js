/**
 * KV/R2 envelope for a preassembled public bootstrap tier.
 *
 * `schemaVersion` is the Worker serving contract. The publisher (Railway) and
 * the api-cors-preflight Worker deploy independently, so Stage 2 must not
 * serve a legacy `{ tier, generatedAt, payload }` envelope written before the
 * publisher mirrored origin's canadaAlerts cutover (#7291). Unversioned or
 * mismatched envelopes fall through to origin.
 *
 * Bump this integer when the served payload contract changes in a way that
 * would make a mixed Worker/publisher deploy incorrect.
 */
export const BOOTSTRAP_TIER_ENVELOPE_SCHEMA_VERSION = 1;

export function buildBootstrapTierEnvelope({ generatedAt, tier, payload }) {
  return {
    schemaVersion: BOOTSTRAP_TIER_ENVELOPE_SCHEMA_VERSION,
    generatedAt,
    tier,
    payload,
  };
}
