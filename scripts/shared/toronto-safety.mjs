/**
 * Scripts-only copy of the TPS seed contract.
 *
 * Railway Nixpacks workers copy only scripts/. Keep these constants inside
 * that closure. tests/toronto-safety-qualify.test.mjs locks them to the public
 * shared contract used by the API and browser app.
 */

export const TPS_MCI_SEMANTIC = 'reported_occurrence';
export const TPS_CALLS_SEMANTIC = 'annual_aggregate';
export const TPS_MCI_SOURCE = 'tps-mci';
export const TPS_CALLS_SOURCE = 'tps-calls-attended';
export const TPS_MCI_KEY = 'safety:toronto:tps-mci:v1';
export const TPS_CALLS_KEY = 'safety:toronto:tps-calls-attended:v1';
export const TPS_MCI_META_KEY = 'seed-meta:safety:tps-mci';
export const TPS_CALLS_META_KEY = 'seed-meta:safety:tps-calls-attended';
