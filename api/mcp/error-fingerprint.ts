/**
 * Stable Sentry grouping fingerprint for an `api/mcp` error capture.
 *
 * Why this exists: the minified edge bundle gives every tool-execution error
 * identical anonymous frames (`(vc/edge/function`, no source map, in_app=false),
 * so Sentry's default stack-based grouping merges ALL api/mcp failures — across
 * every tool AND every status code — into ONE catch-all issue (WORLDMONITOR-T8)
 * whose title only reflects the newest event. That masks a real 5xx spike in one
 * tool behind low-grade auth drift in another. Supplying an explicit fingerprint
 * overrides the stack grouping and splits each failure mode into its own
 * trackable group.
 *
 * Confirmed internal signature/replay rejections share one group across tools.
 * Other sibling HTTP failures retain endpoint/status grouping; missing reasons
 * must not be interpreted as signature failures. Non-HTTP failures use the
 * error name. The step separates execution from post-filter faults.
 *
 * Pure + zero-import so the grouping contract needs no Sentry harness.
 */
export function mcpErrorFingerprint(step: string, toolName: string, err: unknown): string[] {
  const message = err instanceof Error ? err.message : String(err);
  const siblingHttp = message.match(/^([A-Za-z0-9_-]+) HTTP (\d{3})\b/);

  // Signed requests can also fail the gateway entitlement recheck with 401.
  // Only this explicit code identifies the shared signature/replay mechanism.
  if (siblingHttp?.[2] === '401'
    && message === `${siblingHttp[1]} HTTP 401: invalid_internal_mcp_signature`) {
    return ['mcp-internal-auth-401'];
  }

  const signature = siblingHttp
    ? `${siblingHttp[1]}:${siblingHttp[2]}`
    : err instanceof Error
      ? err.name || err.constructor.name
      : 'non-error';
  return [`mcp-${step}`, toolName, signature];
}
