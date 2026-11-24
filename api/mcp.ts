// Vercel route entry. The implementation lives under ./mcp/; this file stays
// here so the deployed route URL (`/api/mcp`) doesn't move.

import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { waitUntil } from '@vercel/functions';
import webHandler, { mcpHandler as handleMcpRequest } from './mcp/handler';
import { PRODUCTION_DEPS } from './mcp/auth';
import { latestProtocolVersion, supportedProtocolVersions } from './mcp/constants';

export const config = { runtime: 'nodejs' };

export { mcpHandler } from './mcp/handler';

function toWebRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const host = headers.get('host') ?? 'localhost';
  const protocol = headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https';
  const method = req.method ?? 'GET';
  const init: RequestInit & { duplex?: 'half' } = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(req) as ReadableStream;
    init.duplex = 'half';
  }
  return new Request(new URL(req.url ?? '/', `${protocol}://${host}`), init);
}

async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  if (response.statusText) res.statusMessage = response.statusText;
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') res.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie?.();
  if (cookies?.length) res.setHeader('set-cookie', cookies);
  if (!response.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  await new Promise<void>((resolve, reject) => {
    body.once('error', reject);
    res.once('finish', resolve);
    res.once('close', resolve);
    body.pipe(res);
  });
}

export default async function handler(
  req: Request | IncomingMessage,
  resOrContext?: ServerResponse | { waitUntil: (promise: Promise<unknown>) => void },
): Promise<Response | void> {
  if (req instanceof Request) {
    return webHandler(req, resOrContext as { waitUntil: (promise: Promise<unknown>) => void } | undefined);
  }
  if (!resOrContext || !('writeHead' in resOrContext)) {
    throw new Error('MCP Node handler requires a ServerResponse');
  }
  const response = await handleMcpRequest(toWebRequest(req), PRODUCTION_DEPS, { waitUntil });
  await writeWebResponse(response, resOrContext);
}
export {
  applyPerMinuteLimit,
  buildAuthHeaders,
  PRODUCTION_DEPS,
  resolveAuthContext,
  runProPreChecks,
  wwwAuthHeader,
} from './mcp/auth';
export {
  JMESPATH_MAX_EXPR_BYTES,
  JMESPATH_MAX_OUTPUT_BYTES,
  MAX_JSON_RPC_BODY_BYTES,
  MCP_SUPPORTED_CLIENT_MATRIX,
  negotiateProtocolVersion,
  TOOL_DESCRIPTION_MAX_BYTES,
} from './mcp/constants';

// MCP_SUPPORTED_PROTOCOL_VERSIONS / MCP_PROTOCOL_VERSION snapshot the env at
// THIS module's load. They live here (not in ./mcp/constants) so dynamic
// re-imports of this file under different `process.env.MCP_PROTOCOL_FLOOR_2025_06_18`
// snapshots — see tests/mcp-protocol-version.test.mjs — observe the active
// value. ./mcp/constants's `negotiateProtocolVersion` re-reads env at call
// time, so the runtime handler returns the active value on every request
// regardless of when the shim was loaded.
// 2025-11-25 is negotiated by DEFAULT; MCP_PROTOCOL_2025_11_25=off and
// MCP_PROTOCOL_FLOOR_2025_06_18=off survive as `=off` kill-switches. Both
// snapshots call the same env-reading functions the handler uses.
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = supportedProtocolVersions();
export const MCP_PROTOCOL_VERSION: string = latestProtocolVersion();
export { dispatchToolsCall, executeTool } from './mcp/dispatch';
export { evaluateFreshness } from './mcp/freshness';
export { applyJmespath, JMESPATH_SCHEMA } from './mcp/jmespath';
export { reserveQuota } from './mcp/quota';
export {
  buildPublicTool,
  SUMMARY_SCHEMA,
  TOOL_LIST_BYTES,
  TOOL_LIST_RESPONSE,
  TOOL_REGISTRY,
} from './mcp/registry/index';
export {
  emitMcpRateLimitHit,
  emitTelemetry,
  MCP_DOWNSTREAM_TELEMETRY_KEYS,
  MCP_RATE_LIMIT_HIT_TELEMETRY_KEYS,
  MCP_TOOLCALL_TELEMETRY_KEYS,
  MCP_TOOLS_LIST_TELEMETRY_KEYS,
  principalIdForLog,
  telemetryEnabled,
} from './mcp/telemetry';
export type {
  ApplyJmespathResult,
  JmespathFailKind,
  McpAuthContext,
  McpHandlerDeps,
  PublicToolShape,
} from './mcp/types';
export { compressDescription, utf8ByteLength } from './mcp/utils';

export { buildPromptResponse, PROMPT_LIST_RESPONSE, PROMPT_REGISTRY } from './mcp/prompts/index';
export {
  buildPublicResourceResponse,
  buildResourceResponse,
  isPublicResourceUri,
  PUBLIC_RESOURCE_REGISTRY,
  RESOURCE_LIST_RESPONSE,
  RESOURCE_TEMPLATE_LIST_RESPONSE,
  TEMPLATE_RESOURCE_REGISTRY,
} from './mcp/resources/index';
export { CHOKEPOINT_SLUGS } from './mcp/resources/slugs';

// Test-only escape hatch. Exposes the TOOL_REGISTRY by REFERENCE so mutations
// inside `tests/mcp-tool-output-contracts.test.mjs` (which monkey-patches
// `_execute` on individual RPC tools) propagate through the live binding.
// PROMPT_REGISTRY + the resource registries follow the same live-binding
// contract so tests that monkey-patch one (e.g. sabotage cases) observe the
// same array the handler dispatches against. `RESOURCE_REGISTRY` maps to what
// `resources/list` surfaces (the concrete PUBLIC_RESOURCE_REGISTRY) so the
// capability-parity test's "advertised → non-empty registry" check stays
// aligned with the wire; the data-bearing URI templates are exposed
// separately as TEMPLATE_RESOURCE_REGISTRY.
import { PROMPT_REGISTRY as __PROMPT_REGISTRY } from './mcp/prompts/index';
import {
  PUBLIC_RESOURCE_REGISTRY as __PUBLIC_RESOURCE_REGISTRY,
  TEMPLATE_RESOURCE_REGISTRY as __TEMPLATE_RESOURCE_REGISTRY,
} from './mcp/resources/index';
import { TOOL_REGISTRY as __TOOL_REGISTRY } from './mcp/registry/index';
export const __testing__ = {
  TOOL_REGISTRY: __TOOL_REGISTRY,
  PROMPT_REGISTRY: __PROMPT_REGISTRY,
  RESOURCE_REGISTRY: __PUBLIC_RESOURCE_REGISTRY,
  PUBLIC_RESOURCE_REGISTRY: __PUBLIC_RESOURCE_REGISTRY,
  TEMPLATE_RESOURCE_REGISTRY: __TEMPLATE_RESOURCE_REGISTRY,
};
