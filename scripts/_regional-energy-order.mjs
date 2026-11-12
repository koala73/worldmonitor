// Railway kills a cron container at 10 minutes, so a tick has 570 s. Four
// 120 s sections (plus kill grace and preflight headroom) fit together; more
// would let a run of timeouts push later feeds out of every tick.
export const REGIONAL_ENERGY_LEAD_GROUP_SIZE = 4;

// Rotate the lead group by one group per completed tick. A feed that keeps
// failing is due on every tick, so a fixed order would let it hold the same
// slot forever; with rotation every feed leads within ceil(n / 4) ticks.
export function orderRegionalEnergySections(sections, turn) {
  if (!Number.isSafeInteger(turn) || turn < 0) throw new TypeError('turn must be a non-negative safe integer');
  if (!sections.length) return [];
  const offset = (turn * REGIONAL_ENERGY_LEAD_GROUP_SIZE) % sections.length;
  return [...sections.slice(offset), ...sections.slice(0, offset)];
}
