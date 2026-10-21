// Import-safe definition for the Railway resilience-validation cron bundle.
//
// This is deliberately separate from _bundle-runner.mjs so tests can verify
// the deployed schedule and member set without loading environment or Redis
// setup. Keep intervalMs equal to the runner's WEEK constant (604_800_000).
export const RESILIENCE_VALIDATION_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const RESILIENCE_VALIDATION_BUNDLE_NAME = 'resilience-validation';

export const RESILIENCE_VALIDATION_BUNDLE_MEMBERS = Object.freeze([
  Object.freeze({
    label: 'External-Benchmark',
    script: 'benchmark-resilience-external.mjs',
    intervalMs: RESILIENCE_VALIDATION_WEEK_MS,
    timeoutMs: 300_000,
  }),
  Object.freeze({
    label: 'Outcome-Backtest',
    script: 'backtest-resilience-outcomes.mjs',
    intervalMs: RESILIENCE_VALIDATION_WEEK_MS,
    timeoutMs: 300_000,
  }),
  Object.freeze({
    label: 'Sensitivity-Suite',
    script: 'validate-resilience-sensitivity.mjs',
    intervalMs: RESILIENCE_VALIDATION_WEEK_MS,
    timeoutMs: 600_000,
  }),
]);
