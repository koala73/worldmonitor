/**
 * Side-channel for handlers to attach response headers without modifying codegen.
 *
 * Handlers set headers via setResponseHeader(ctx.request, key, value).
 * The gateway reads and applies them after the handler returns.
 * WeakMap ensures automatic cleanup when the Request is GC'd.
 */

const channel = new WeakMap<Request, Record<string, string>>();

export function setResponseHeader(req: Request, key: string, value: string): void {
  let headers = channel.get(req);
  if (!headers) {
    headers = {};
    channel.set(req, headers);
  }
  headers[key] = value;
}

export function markNoCacheResponse(req: Request): void {
  setResponseHeader(req, 'X-No-Cache', '1');
}

export function markNoStoreFallbackResponse<T>(req: Request, payload: T): T {
  markNoCacheResponse(req);
  return payload;
}

export function drainResponseHeaders(req: Request): Record<string, string> | undefined {
  const headers = channel.get(req);
  if (headers) channel.delete(req);
  return headers;
}

/**
 * Success-status override side-channel (same WeakMap pattern as headers above).
 *
 * The sebuf-generated servers emit `status: 200` for every successful RPC —
 * there is no per-RPC status-code annotation — so async-enqueue endpoints
 * (e.g. RunScenario's legacy 202 Accepted contract) cannot express their
 * status from inside a handler. Handlers call
 * setSuccessStatusOverride(ctx.request, 202) and the gateway swaps the status
 * after the handler returns. The gateway applies it only when the handler
 * actually produced a 200 on a POST: thrown ApiError statuses always win, and
 * GET success flows keep 200 (their ETag/304 + CDN-cache handling assumes it).
 */
const statusOverrides = new WeakMap<Request, number>();

export function setSuccessStatusOverride(req: Request, status: number): void {
  statusOverrides.set(req, status);
}

export function drainSuccessStatusOverride(req: Request): number | undefined {
  const status = statusOverrides.get(req);
  if (status !== undefined) statusOverrides.delete(req);
  return status;
}
