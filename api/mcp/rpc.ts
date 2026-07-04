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

export function rpcError(id: unknown, code: number, message: string, extraHeaders: Record<string, string> = {}): Response {
  return jsonResponse({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, 200, withMcpNoStore(extraHeaders));
}
