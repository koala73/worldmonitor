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

export function drainResponseHeaders(req: Request): Record<string, string> | undefined {
  const headers = channel.get(req);
  if (headers) channel.delete(req);
  return headers;
}
