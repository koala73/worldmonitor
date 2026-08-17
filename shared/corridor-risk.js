/**
 * CorridorRisk feed adaptation — name mapping and risk-level banding.
 *
 * Lives in `shared/` because the AIS relay ingests this feed and the relay
 * image copies `shared/` but not `server/` (see Dockerfile.relay). Both pieces
 * were previously inline in ais-relay.cjs, where the only way to test them was
 * to regex them out of the source and re-implement the banding in the test —
 * which then passed no matter what the relay actually did.
 */

/**
 * CorridorRisk API corridor name → canonical chokepoint ID.
 *
 * Matched as a case-insensitive substring, so ordering matters: the first
 * entry whose pattern appears in the corridor name wins. 'red sea' maps to
 * Bab el-Mandeb because the feed reports the whole Red Sea transit under the
 * chokepoint that gates it.
 */
export const CORRIDOR_RISK_NAME_MAP = Object.freeze([
  { pattern: 'hormuz', id: 'hormuz_strait' },
  { pattern: 'bab-el-mandeb', id: 'bab_el_mandeb' },
  { pattern: 'red sea', id: 'bab_el_mandeb' },
  { pattern: 'suez', id: 'suez' },
  { pattern: 'south china sea', id: 'taiwan_strait' },
  { pattern: 'black sea', id: 'bosphorus' },
]);

/**
 * Band a 0-100 CorridorRisk score into the risk level the panel renders.
 *
 * Derived from the score rather than read off the feed's own label so the
 * banding stays consistent with every other risk surface in the product.
 * Bands are lower-inclusive: 70 is already critical, 69 is high.
 *
 * @param {number} score
 * @returns {'critical' | 'high' | 'elevated' | 'normal'}
 */
export function deriveCorridorRiskLevel(score) {
  if (score >= 70) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 30) return 'elevated';
  return 'normal';
}
