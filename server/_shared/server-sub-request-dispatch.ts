import { issueSubRequestAdmission, SUB_REQUEST_MARKER_HEADER } from './sub-request-admission';
import {
  chargeServerSubRequestOperation,
  formatTrustedRateLimitPrincipal,
  resolveServerSubRequestCharge,
} from './rate-limit';

export type ServerSubRequestFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type ServerSubRequestDispatchResult =
  | { kind: 'dispatched'; response: Response }
  | { kind: 'refused'; status: number; body: unknown };

export interface ServerSubRequestDispatchOptions {
  inbound: Request;
  target: URL;
  headers: HeadersInit;
  fetchImpl?: ServerSubRequestFetch;
  redirect?: RequestRedirect;
  signal?: AbortSignal;
}

/**
 * Charge, admit, and dispatch one same-origin server sub-request as one
 * operation. Fan-out features use this boundary instead of assembling the
 * security steps independently, so none can omit caller attribution, the
 * pre-dispatch charge, or the single-use inner-gateway admission.
 */
export async function dispatchServerSubRequest(
  options: ServerSubRequestDispatchOptions,
): Promise<ServerSubRequestDispatchResult> {
  if (options.target.origin !== new URL(options.inbound.url).origin) {
    return {
      kind: 'refused',
      status: 400,
      body: { error: 'Cross-origin sub-requests are not allowed' },
    };
  }
  const charge = resolveServerSubRequestCharge(options.inbound);
  const refused = await chargeServerSubRequestOperation(
    options.inbound,
    options.target.pathname,
    charge,
  );
  if (refused) return { kind: 'refused', ...refused };

  const headers = new Headers(options.headers);
  const admission = await issueSubRequestAdmission(
    new Request(options.target, { method: 'GET', headers }),
    charge.opts.principalUserId
      ? formatTrustedRateLimitPrincipal(
          charge.opts.principalUserId,
          charge.opts.principalScope ?? 'session',
        )
      : null,
  );
  if (!admission) {
    return {
      kind: 'refused',
      status: 503,
      body: { error: 'Rate-limit service temporarily unavailable' },
    };
  }
  headers.set(SUB_REQUEST_MARKER_HEADER, admission);

  const fetchImpl = options.fetchImpl
    ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const response = await fetchImpl(options.target.toString(), {
    method: 'GET',
    headers,
    redirect: options.redirect,
    signal: options.signal,
  });
  return { kind: 'dispatched', response };
}
