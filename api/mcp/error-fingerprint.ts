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
 * Signature derivation:
 *  - Sibling-fetch failures are thrown as `<inner-endpoint> HTTP <status>`
 *    (see api/mcp/registry/rpc-tools.ts). Key on `<endpoint>:<status>` and drop
 *    any trailing `: <reason>` so `HTTP 401` and
 *    `HTTP 401: invalid_internal_mcp_signature` coalesce into one group rather
 *    than fragmenting on the variable reason token.
 *  - Any other failure (timeout, abort, TypeError from a bad _postFilter) keys
 *    on the stable error name so distinct runtime faults stay separable.
 *
 * The `step` distinguishes the two capture sites in dispatch.ts (`tool-execution`
 * vs `post-filter`) so a post-filter bug never re-merges with the fetch path.
 *
 * Pure + zero-import by design so it is unit-testable from the `tests/*.test.mjs`
 * runner without a Sentry DSN or a full dispatch harness.
 */
export function mcpErrorFingerprint(step: string, toolName: string, err: unknown): string[] {
  const message = err instanceof Error ? err.message : String(err);
  const siblingHttp = message.match(/^([A-Za-z0-9_-]+) HTTP (\d{3})\b/);
  const signature = siblingHttp
    ? `${siblingHttp[1]}:${siblingHttp[2]}`
    : err instanceof Error
      ? err.name || err.constructor.name
      : 'non-error';
  return [`mcp-${step}`, toolName, signature];
}
