/**
 * Sentry severity for a failed relay request.
 *
 * `AbortError` is our own budget firing. The edge runtime also drops upstream
 * connections that were already established, and those rejections are the same
 * class of routine transport churn: the handler neither caused them nor can
 * fix them. WORLDMONITOR-R1 is one such group, `Error: Network connection
 * lost.`, which paged at `error` while the abort arm sat at `warning`
 * (WORLDMONITOR-11G) — one condition split across two severities.
 *
 * "Not an AbortError" is the wrong discriminator. A relay refusing connections
 * or resolving to nothing IS a defect and must keep paging. The boundary is
 * whether a connection was established and then lost. `connect ETIMEDOUT` sits
 * on the defect side for that reason: a handshake that expired never carried a
 * request, so it reports a persistent routing or firewall outage rather than
 * churn. `fetch failed` is absent too, because undici uses it as a generic
 * wrapper that hides ECONNREFUSED.
 *
 * Matching is anchored and `code` outranks the message. Both guard the same
 * hole: relay diagnostics quote syscall names in prose, and an unanchored
 * substring would read `upstream reported ECONNRESET to its peer` as a drop.
 *
 * Shared by api/telegram-feed.js and api/rss-proxy.js (WORLDMONITOR-17M).
 *
 * @param {{ name?: string, message?: string, code?: string } | null | undefined} error
 * @returns {'warning' | 'error'}
 */
const RELAY_DROP_CODES = new Set(['ECONNRESET']);
const RELAY_DROP_MESSAGES = [
  /^Network connection lost\.?$/i,
  /^(?:read |write )?ECONNRESET$/i,
  /^socket hang up$/i,
  /^terminated$/i,
];

export function relayFailureLevel(error) {
  if (error?.name === 'AbortError') return 'warning';
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code) return RELAY_DROP_CODES.has(code) ? 'warning' : 'error';
  const msg = error?.message || String(error ?? '');
  return RELAY_DROP_MESSAGES.some(pattern => pattern.test(msg)) ? 'warning' : 'error';
}
