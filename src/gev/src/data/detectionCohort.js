const DEFAULT_MAX_COHORT = 256;

/** Resolve the review-mandated bounded materialization cap for a layer quota. */
export function cohortCapForQuota(quota) {
  const normalized = Math.max(0, Math.floor(Number(quota) || 0));
  return Math.min(DEFAULT_MAX_COHORT, Math.max(64, normalized * 4));
}

/** Stable FNV-1a identity hash used only on solve ticks. */
export function stableIdentityHash(layerId, sourceId) {
  const text = `${String(layerId)}\u0000${String(sourceId)}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Negative means a is a better deterministic contender than b. */
export function compareCohortContenders(a, b) {
  const priorityDelta = (Number(b?._cohortPriority) || 0) - (Number(a?._cohortPriority) || 0);
  if (priorityDelta) return priorityDelta;
  const bandDelta = (Number(b?._cohortBand) || 0) - (Number(a?._cohortBand) || 0);
  if (bandDelta) return bandDelta;
  const hashDelta = (Number(a?._cohortHash) >>> 0) - (Number(b?._cohortHash) >>> 0);
  if (hashDelta) return hashDelta;
  return String(a?._cohortSourceId).localeCompare(String(b?._cohortSourceId));
}

function isWorse(a, b) {
  return compareCohortContenders(a, b) > 0;
}

/**
 * Streaming deterministic contender reservoir. The heap retains at most 256
 * non-incumbents per layer, so a 12k-object scan never creates or sorts a full
 * rich-candidate population.
 */
export class BoundedCohort {
  constructor(maxSize = DEFAULT_MAX_COHORT, hardMax = DEFAULT_MAX_COHORT) {
    const ceiling = Math.max(1, Math.floor(Number(hardMax) || DEFAULT_MAX_COHORT));
    this.maxSize = Math.max(1, Math.min(ceiling, Math.floor(Number(maxSize) || DEFAULT_MAX_COHORT)));
    this.incumbents = [];
    this.heap = [];
  }

  consider(observation, incumbent = false) {
    if (!observation) return;
    if (incumbent) {
      this.incumbents.push(observation);
      return;
    }
    if (this.heap.length < this.maxSize) {
      this.heap.push(observation);
      this._bubbleUp(this.heap.length - 1);
      return;
    }
    if (compareCohortContenders(observation, this.heap[0]) >= 0) return;
    this.heap[0] = observation;
    this._siftDown(0);
  }

  values(limit = this.maxSize) {
    const cap = Math.max(0, Math.min(this.maxSize, Math.floor(Number(limit) || 0)));
    const incumbents = this.incumbents.slice().sort(compareCohortContenders).slice(0, cap);
    const remaining = Math.max(0, cap - incumbents.length);
    if (remaining === 0) return incumbents;
    const contenders = this.heap.slice().sort(compareCohortContenders).slice(0, remaining);
    return incumbents.concat(contenders);
  }

  _bubbleUp(index) {
    let current = index;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (!isWorse(this.heap[current], this.heap[parent])) break;
      [this.heap[current], this.heap[parent]] = [this.heap[parent], this.heap[current]];
      current = parent;
    }
  }

  _siftDown(index) {
    let current = index;
    while (true) {
      const left = current * 2 + 1;
      const right = left + 1;
      let worst = current;
      if (left < this.heap.length && isWorse(this.heap[left], this.heap[worst])) worst = left;
      if (right < this.heap.length && isWorse(this.heap[right], this.heap[worst])) worst = right;
      if (worst === current) return;
      [this.heap[current], this.heap[worst]] = [this.heap[worst], this.heap[current]];
      current = worst;
    }
  }
}
