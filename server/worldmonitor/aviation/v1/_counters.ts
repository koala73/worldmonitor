/**
 * Per-provider aviation handler counters.
 *
 * In-memory counters accumulated across handler invocations within the same
 * edge function instance. Values are reset on cold start; consumers that need
 * durable counters should read from the relay's rolling metrics instead.
 */

export interface ProviderCounters {
  aviationStackSuccess: number;
  aviationStackTimeout: number;
  aviationStackAuthRejection: number;
  aviationStackTerminalFailure: number;
  notamSuccess: number;
  notamTimeout: number;
  notamAuthRejection: number;
  notamTerminalFailure: number;
  aviationNewsSuccess: number;
  aviationNewsTimeout: number;
  aviationNewsAuthRejection: number;
  aviationNewsFallback: number;
  aviationNewsTerminalFailure: number;
}

const counters: ProviderCounters = {
  aviationStackSuccess: 0,
  aviationStackTimeout: 0,
  aviationStackAuthRejection: 0,
  aviationStackTerminalFailure: 0,
  notamSuccess: 0,
  notamTimeout: 0,
  notamAuthRejection: 0,
  notamTerminalFailure: 0,
  aviationNewsSuccess: 0,
  aviationNewsTimeout: 0,
  aviationNewsAuthRejection: 0,
  aviationNewsFallback: 0,
  aviationNewsTerminalFailure: 0,
};

export function incrementProviderCounter(
  provider: keyof ProviderCounters,
  amount = 1,
): void {
  counters[provider] += amount;
}

export function getProviderCounters(): Readonly<ProviderCounters> {
  return { ...counters };
}

export function resetProviderCounters(): void {
  for (const key of Object.keys(counters) as (keyof ProviderCounters)[]) {
    counters[key] = 0;
  }
}