export type AttemptedSummarizationProvider = 'ollama' | 'groq' | 'openrouter' | 'browser';

export interface SummarizationAttemptState {
  lastAttemptedProvider: AttemptedSummarizationProvider | 'none';
}

interface SummarizationOutcomeLogger {
  debug(message: string): void;
  warn(message: string): void;
}

export function createSummarizationAttemptState(): SummarizationAttemptState {
  return { lastAttemptedProvider: 'none' };
}

export function markSummarizationAttempt(
  state: SummarizationAttemptState,
  provider: AttemptedSummarizationProvider,
): void {
  state.lastAttemptedProvider = provider;
}

/**
 * #5377: a chain can be declined by design when no provider passes its
 * eligibility/availability gate. Keep that expected path at debug while
 * reserving the outage-shaped warning for a provider that was attempted.
 */
export function logChainOutcome(
  prefix: string,
  state: SummarizationAttemptState,
  logger: SummarizationOutcomeLogger = console,
): void {
  if (state.lastAttemptedProvider === 'none') {
    logger.debug(`${prefix} Summarization skipped: no eligible provider (entitlement-gated or unavailable); using designed fallback`);
  } else {
    logger.warn(`${prefix} All providers failed`);
  }
}
