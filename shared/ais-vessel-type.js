/**
 * AIS ship-type code → the three transit buckets the chokepoint counters use.
 *
 * Lives in `shared/` so the AIS relay and its tests load the same function:
 * the relay boots a live server on import, so a test can never require it
 * directly, and the previous test regex-sliced this body out of the relay and
 * `new Function`'d it — which passed no matter what the relay actually did.
 *
 * Codes follow ITU-R M.1371 ship-and-cargo type: 70-79 cargo, 80-89 tanker.
 * Everything else (passenger, fishing, tug, naval, unknown) is 'other'.
 */
export function classifyVesselType(shipType) {
  if (shipType >= 80 && shipType <= 89) return 'tanker';
  if (shipType >= 70 && shipType <= 79) return 'cargo';
  return 'other';
}
