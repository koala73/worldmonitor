/**
 * Expected analysis-tool failure when every live input is unavailable.
 *
 * The cache key lists are safe, bounded identifiers (never payload content).
 * Dispatch preserves them in JSON-RPC error.data so agents can distinguish a
 * retryable source outage from an implementation failure.
 */
export class McpSourceUnavailableError extends Error {
  readonly unavailableInputs: string[];
  readonly failedInputs: string[];

  constructor(message: string, unavailableInputs: string[], failedInputs: string[]) {
    super(message);
    this.name = 'McpSourceUnavailableError';
    this.unavailableInputs = [...unavailableInputs];
    this.failedInputs = [...failedInputs];
  }
}
