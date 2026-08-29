/** Decide whether a loaded aircraft participates in a proximity query.
 *
 * `modelRendering` is the OWNERSHIP question, not `model.show`: a model that
 * exists but is hidden, unplaced, or still loading is not what the operator sees,
 * and the billboard flag is what answers for the contact in those states. Reading
 * a bare `show` here counted a contact whose model had been admitted but was
 * drawing nothing. */
export function aircraftIncludedInNearby({
  isTracked = false,
  billboardShown = false,
  modelRendering = false,
  includeHidden = false,
} = {}) {
  return Boolean(includeHidden || isTracked || billboardShown || modelRendering);
}
