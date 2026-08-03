/**
 * Summarize a Promise.allSettled rejection for Sentry-readable tool errors.
 * Used by get_airspace when both civilian and military upstreams fail (#6085).
 */
export function summarizeSettledFailure(result: PromiseSettledResult<unknown>): string {
  if (result.status === 'fulfilled') return 'ok';
  const reason = result.reason;
  if (reason instanceof Error) {
    if (reason.name === 'TimeoutError' || reason.name === 'AbortError') {
      return reason.name;
    }
    const msg = reason.message.trim();
    if (/^HTTP \d{3}\b/.test(msg)) return msg.slice(0, 32);
    return `${reason.name || 'Error'}: ${msg}`.slice(0, 120);
  }
  if (reason == null) return 'unknown';
  return String(reason).slice(0, 120);
}
