/**
 * Outcome classification for the summarization fallback chain (#5377, #5605).
 *
 * A chain that ends without a summary has four distinguishable causes, and
 * only ONE of them is expected. Collapsing them into "did we mark a provider?"
 * is wrong in both directions:
 *
 *   - too quiet: `canAttemptServerSummarization()` returns false both for an
 *     anon/free principal (by design) and for an entitled principal inside the
 *     timed cooldown armed by a real server 403/429. Reporting the second at
 *     `debug` hides a live entitlement outage from the only surface that
 *     observes it — `trackLLMFailure` is a no-op.
 *   - too loud: the circuit breaker returns its default WITHOUT running the
 *     dispatch callback while on cooldown, so a chain that contacted nothing
 *     would still report "All providers failed".
 *
 * Hence an explicit reason on the state plus a pure classifier. Keep this
 * module import-free so it stays loadable under `tsx --test` — summarization.ts
 * itself imports @/services/i18n and cannot be.
 */

export type AttemptedSummarizationProvider = 'ollama' | 'groq' | 'openrouter' | 'browser';

export type SummarizationChainOutcome =
  /** Nothing was eligible: anon/free, feature disabled, or no local model. Expected. */
  | 'no-eligible-provider'
  /** The gate declined because of a recent server 403/429, not entitlement. */
  | 'suppressed'
  /** A provider was eligible but the circuit breaker short-circuited its dispatch. */
  | 'not-dispatched'
  /** At least one provider actually ran and failed to produce a summary. */
  | 'provider-failure';

export interface SummarizationAttemptState {
  /** Provider whose dispatch actually executed. 'none' means nothing ran. */
  lastAttemptedProvider: AttemptedSummarizationProvider | 'none';
  /** A gate denial happened while the post-403/429 cooldown was active. */
  declinedBySuppression: boolean;
  /** An eligible provider's dispatch never ran (breaker open). */
  shortCircuited: boolean;
}

interface SummarizationOutcomeLogger {
  debug(message: string): void;
  warn(message: string): void;
}

export function createSummarizationAttemptState(): SummarizationAttemptState {
  return { lastAttemptedProvider: 'none', declinedBySuppression: false, shortCircuited: false };
}

/**
 * Record a dispatch that ACTUALLY executed. Called from inside the circuit
 * breaker callback, so a short-circuited call can never reach it (#5605) and
 * "gate before mark" is structural rather than a source-order convention.
 */
export function markSummarizationAttempt(
  state: SummarizationAttemptState,
  provider: AttemptedSummarizationProvider,
): void {
  state.lastAttemptedProvider = provider;
}

/** Record that the entitlement gate declined while the 403/429 cooldown was armed. */
export function markSummarizationSuppressed(state: SummarizationAttemptState): void {
  state.declinedBySuppression = true;
}

/** Record that an eligible provider's dispatch was short-circuited by the breaker. */
export function markSummarizationShortCircuited(state: SummarizationAttemptState): void {
  state.shortCircuited = true;
}

/**
 * Pure classifier — the whole decision surface, unit-testable as a truth table.
 * Precedence: a real failed dispatch outranks a suppression, which outranks a
 * short-circuit, because each is a strictly stronger statement about the cause.
 */
export function classifySummarizationChainOutcome(
  state: SummarizationAttemptState,
): SummarizationChainOutcome {
  if (state.lastAttemptedProvider !== 'none') return 'provider-failure';
  if (state.declinedBySuppression) return 'suppressed';
  if (state.shortCircuited) return 'not-dispatched';
  return 'no-eligible-provider';
}

/**
 * Pure level + message mapping. Only the expected decline is quiet; every cause
 * an operator would want to see stays at `warn`, and the outage-shaped
 * "All providers failed" is reserved for a genuine provider failure.
 */
export function describeSummarizationChainOutcome(
  prefix: string,
  outcome: SummarizationChainOutcome,
): { level: 'debug' | 'warn'; message: string } {
  switch (outcome) {
    case 'no-eligible-provider':
      return {
        level: 'debug',
        message: `${prefix} Summarization skipped: no eligible provider (entitlement-gated, disabled, or local model unavailable) — no summary produced`,
      };
    case 'suppressed':
      return {
        level: 'warn',
        message: `${prefix} Summarization unavailable: server denied a recent request (403/429); dispatches are suppressed while the cooldown is active`,
      };
    case 'not-dispatched':
      return {
        level: 'warn',
        message: `${prefix} Summarization unavailable: circuit breaker open, no provider was dispatched`,
      };
    case 'provider-failure':
      return { level: 'warn', message: `${prefix} All providers failed` };
  }
}

export function logChainOutcome(
  prefix: string,
  state: SummarizationAttemptState,
  logger: SummarizationOutcomeLogger = console,
): void {
  const { level, message } = describeSummarizationChainOutcome(
    prefix,
    classifySummarizationChainOutcome(state),
  );
  logger[level](message);
}
