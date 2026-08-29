/**
 * Derive the AIR-contact near band for Cockpit presentation.
 *
 * This state is deliberately independent from 3D model admission. A contact
 * inside the band stays an aircraft silhouette even when 3D is off, its model
 * is still loading, or the model budget is full. Contacts outside the band are
 * compact dots. Retained contacts use the wider KEEP radius so crossing the
 * ADD boundary cannot make the visual oscillate.
 *
 * @param {Set<string>} previousIds - Contacts retained by the prior update.
 * @param {Iterable<[string, number]>} distancesSquared - Contact id and squared distance in metres.
 * @param {number} addDistanceM - Radius for contacts entering the near band.
 * @param {number} keepDistanceM - Radius for contacts already in the near band.
 * @returns {Set<string>} The next near-contact set.
 */
export function nextCockpitNearContacts(
  previousIds,
  distancesSquared,
  addDistanceM,
  keepDistanceM,
) {
  const previous = previousIds instanceof Set ? previousIds : new Set();
  const addSq = Math.max(0, Number(addDistanceM) || 0) ** 2;
  const keepSq = Math.max(addSq, (Math.max(0, Number(keepDistanceM) || 0) ** 2));
  const next = new Set();

  for (const [id, distanceSq] of distancesSquared || []) {
    if (!id || !Number.isFinite(distanceSq) || distanceSq < 0) continue;
    const limitSq = previous.has(id) ? keepSq : addSq;
    if (distanceSq <= limitSq) next.add(id);
  }

  return next;
}

