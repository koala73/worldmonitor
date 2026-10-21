// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from '../_json-response.js';

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------
export function withMcpNoStore(extraHeaders: Record<string, string> = {}): Record<string, string> {
  return { ...extraHeaders, 'Cache-Control': 'no-store' };
}

export function rpcOk(id: unknown, result: unknown, extraHeaders: Record<string, string> = {}): Response {
  return jsonResponse({ jsonrpc: '2.0', id: id ?? null, result }, 200, withMcpNoStore(extraHeaders));
}

// `status` defaults to 200 — JSON-RPC errors ride HTTP 200 by convention here.
// Pass an explicit status only for the transport-level escalations the error
// catalog documents (e.g. 413 for an over-cap body, #7406).
export function rpcError(
  id: unknown,
  code: number,
  message: string,
  extraHeaders: Record<string, string> = {},
  data?: unknown,
  status = 200,
): Response {
  return jsonResponse(
    {
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    },
    status,
    withMcpNoStore(extraHeaders),
  );
}
