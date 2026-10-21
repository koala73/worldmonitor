'use strict';

function createPollGenerationGuard({
  poll,
  getGeneration,
  setGeneration,
  stuckAfterMs,
  now = Date.now,
  createAbortController = () => new AbortController(),
  warn = () => {},
} = {}) {
  if (typeof poll !== 'function') throw new TypeError('poll is required');
  if (typeof getGeneration !== 'function' || typeof setGeneration !== 'function') {
    throw new TypeError('generation accessors are required');
  }

  let inFlight = false;
  let startedAt = 0;
  let abortController = null;

  function run({ retryAfterLeaseConflict: requestedLeaseRetry = false } = {}) {
    let retryAfterLeaseConflict = requestedLeaseRetry;
    if (inFlight) {
      const stuckMs = now() - startedAt;
      if (stuckMs <= stuckAfterMs) return false;
      warn(stuckMs);
      try { abortController?.abort(); } catch {}
      inFlight = false;
      abortController = null;
      retryAfterLeaseConflict = true;
    }

    inFlight = true;
    startedAt = now();
    abortController = createAbortController();
    const generation = getGeneration() + 1;
    setGeneration(generation);
    Promise.resolve(poll({
      generation,
      signal: abortController.signal,
      retryAfterLeaseConflict,
    })).catch((error) => warn(0, error)).finally(() => {
      if (generation !== getGeneration()) return;
      inFlight = false;
      abortController = null;
    });
    return true;
  }

  return {
    run,
    isInFlight: () => inFlight,
    startedAt: () => inFlight ? startedAt : 0,
  };
}

module.exports = { createPollGenerationGuard };
