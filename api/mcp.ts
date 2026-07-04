// Vercel-edge route entry. The implementation lives under ./mcp/; this file
// stays here so the deployed route URL (`/api/mcp`) doesn't move.

export const config = { runtime: 'edge' };

export { default } from './mcp/handler';
export { mcpHandler } from './mcp/handler';
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
// 2025-06-18 is negotiated by DEFAULT; the env var survives only as an
// explicit `=off` kill-switch pinning the server back to the legacy floor.
const MCP_PROTOCOL_FLOOR_2025_06_18_DISABLED =
  process.env.MCP_PROTOCOL_FLOOR_2025_06_18 === 'off';
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] =
  MCP_PROTOCOL_FLOOR_2025_06_18_DISABLED
    ? ['2025-03-26']
    : ['2025-03-26', '2025-06-18'];
export const MCP_PROTOCOL_VERSION: string = MCP_PROTOCOL_FLOOR_2025_06_18_DISABLED
  ? '2025-03-26'
  : '2025-06-18';
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
  emitTelemetry,
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
export { buildResourceResponse, RESOURCE_LIST_RESPONSE, RESOURCE_REGISTRY } from './mcp/resources/index';
export { CHOKEPOINT_SLUGS } from './mcp/resources/slugs';

// Test-only escape hatch. Exposes the TOOL_REGISTRY by REFERENCE so mutations
// inside `tests/mcp-tool-output-contracts.test.mjs` (which monkey-patches
// `_execute` on individual RPC tools) propagate through the live binding.
// PROMPT_REGISTRY + RESOURCE_REGISTRY follow the same live-binding contract
// so tests that monkey-patch one (e.g. sabotage cases) observe the same
// array the handler dispatches against.
import { PROMPT_REGISTRY as __PROMPT_REGISTRY } from './mcp/prompts/index';
import { RESOURCE_REGISTRY as __RESOURCE_REGISTRY } from './mcp/resources/index';
import { TOOL_REGISTRY as __TOOL_REGISTRY } from './mcp/registry/index';
export const __testing__ = {
  TOOL_REGISTRY: __TOOL_REGISTRY,
  PROMPT_REGISTRY: __PROMPT_REGISTRY,
  RESOURCE_REGISTRY: __RESOURCE_REGISTRY,
};
