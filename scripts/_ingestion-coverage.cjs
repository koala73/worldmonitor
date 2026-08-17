'use strict';

// Shared operational contract for relay-backed ingestion routes. The relay
// records these classes without changing the data-serving fallback behavior;
// callers can therefore distinguish expected throttling from application
// faults and can decide whether the served result is still usable.
const OUTCOME_FIELDS = Object.freeze([
  'success',
  'throttle',
  'timeout',
  'authRejection',
  'fallback',
  'terminalFailure',
]);

const AVIATION_MIN_SERVED_COVERAGE = 0.5;
const RSS_MIN_SERVED_COVERAGE = 0.7;

function isTimeoutError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return error?.name === 'TimeoutError' || /timed? ?out|timeout|timed out/.test(message);
}

function classifyUpstreamOutcome({ status, error } = {}) {
  if (status === 429) return 'throttle';
  if (status === 401 || status === 403) return 'authRejection';
  if (isTimeoutError(error) || status === 408 || status === 504) return 'timeout';
  if (Number.isFinite(status) && status >= 200 && status < 300) return 'success';
  return 'terminalFailure';
}

function nextBackoffMs(previousFailures, baseMs, maxMs) {
  const failures = Math.max(0, Math.floor(Number(previousFailures) || 0));
  const base = Math.max(1, Number(baseMs) || 1);
  const cap = Math.max(base, Number(maxMs) || base);
  const delay = Math.min(base * (2 ** failures), cap);
  // Add jitter (±25%) to prevent thundering herd when multiple feeds
  // enter backoff at the same time (e.g., after a correlated failure).
  // Jitter is bounded by the cap so repeated calls never exceed maxMs.
  return Math.min(cap, Math.round(delay * (0.75 + Math.random() * 0.5)));
}

function summarizeServedCoverage({ requests = 0, served = 0, minimum } = {}) {
  const observed = Math.max(0, Math.floor(Number(requests) || 0));
  const delivered = Math.max(0, Math.min(observed, Math.floor(Number(served) || 0)));
  const minimumCoverage = Math.max(0, Math.min(1, Number(minimum) || 0));
  const servedCoverage = observed > 0 ? Number((delivered / observed).toFixed(4)) : null;
  return {
    requests: observed,
    served: delivered,
    servedCoverage,
    minimumCoverage,
    status: observed === 0 ? 'not_observed' : servedCoverage < minimumCoverage ? 'degraded' : 'ok',
  };
}

module.exports = {
  AVIATION_MIN_SERVED_COVERAGE,
  OUTCOME_FIELDS,
  RSS_MIN_SERVED_COVERAGE,
  classifyUpstreamOutcome,
  isTimeoutError,
  nextBackoffMs,
  summarizeServedCoverage,
};
