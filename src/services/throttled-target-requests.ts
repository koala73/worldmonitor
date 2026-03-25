export interface NamedSymbolTarget {
  symbol: string;
  name: string;
}

interface AvailabilityResult {
  available: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runThrottledTargetRequests<TTarget extends NamedSymbolTarget, TResult extends AvailabilityResult>(
  targets: TTarget[],
  request: (target: TTarget) => Promise<TResult>,
  delayMs = 200,
): Promise<TResult[]> {
  const results: TResult[] = [];
  for (let i = 0; i < targets.length; i++) {
    if (i > 0) await sleep(delayMs);
    try {
      const result = await request(targets[i]!);
      if (result.available) results.push(result);
    } catch {
      // Skip failed individual requests.
    }
  }
  return results;
}
