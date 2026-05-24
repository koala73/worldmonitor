import { TOOL_DESCRIPTION_MAX_BYTES } from '../constants';
import { JMESPATH_SCHEMA } from '../jmespath';
import type { PublicToolShape, ToolDef } from '../types';
import { compressDescription, utf8ByteLength } from '../utils';
import { CACHE_TOOLS } from './cache-tools';
import { RPC_TOOLS } from './rpc-tools';

// Merged tool registry — cache tools first (no `_execute`), then RPC tools
// (with `_execute`). Order is observable: `tools/list` emits tools in
// this same order, and `describe_tool({tool_name: 'nonexistent'})` returns
// the available-list sorted before responding.
export const TOOL_REGISTRY: ToolDef[] = [...CACHE_TOOLS, ...RPC_TOOLS];

// Public shape for tools/list — strips internal _-prefixed fields, adds MCP
// annotations, and injects the universal `summary` flag (issue #3678) into
// every cache tool's advertised schema. Cache tools are uniformly summarisable;
// RPC/_execute tools have bespoke response shapes and aren't covered.
export const SUMMARY_SCHEMA = {
  type: 'boolean',
  description: 'Return counts + 3-item samples instead of full lists. Useful when you only need shape/size or want to budget context before drilling in.',
} as const;

// Collision guard — fail fast at module load if a future PR hand-declares
// `jmespath` (or `summary` on a cache tool) on a tool's inputSchema. The
// universal injection below would silently overwrite the hand-declared
// version; failing loud forces the author to resolve the duplication.
for (const tool of TOOL_REGISTRY) {
  const props = tool.inputSchema.properties;
  if (props && 'jmespath' in props) {
    throw new Error(`api/mcp/registry/index.ts: tool "${tool.name}" declares its own 'jmespath' property — collides with universal JMESPATH_SCHEMA injection. Remove the per-tool declaration.`);
  }
  if (tool._execute === undefined && props && 'summary' in props) {
    throw new Error(`api/mcp/registry/index.ts: cache tool "${tool.name}" declares its own 'summary' property — collides with universal SUMMARY_SCHEMA injection. Remove the per-tool declaration.`);
  }
}

// Shared public-shape builder (v1.5.0). SINGLE source of truth for what
// `tools/list` and `describe_tool` emit. Both surfaces go through this
// helper so they can never drift.
//
// Always recursively deep-clones property schemas AND the injected
// SUMMARY_SCHEMA / JMESPATH_SCHEMA consts via `structuredClone`. Without
// this, mutating any returned property (including nested `enum` / `items.enum`
// arrays, e.g. `get_market_data.asset_classes.items.enum`) would corrupt
// the registry or the module-level schema consts. Codex Round 2 explicitly
// flagged shallow `{ ...prop }` as insufficient for these shapes.
//
// `_*`-prefixed internal fields (_apiPaths, _cacheKeys, _seedMetaKey,
// _maxStaleMin, _freshnessChecks, _coverageKeys, _postFilter, _execute)
// are NEVER enumerated — the function only constructs a fresh object with
// the public-shape fields (name, description, inputSchema, annotations).
//
// `opts.compressDescriptions` — when true (the tools/list call path),
// the tool's top-level `description` is run through compressDescription.
// When false (the describe_tool call path), full text is preserved.
export function buildPublicTool(
  tool: ToolDef,
  opts: { compressDescriptions: boolean },
): PublicToolShape {
  const isCacheTool = tool._execute === undefined;

  // Recursively clone each property schema. Handles both direct `enum: [...]`
  // arrays and nested `items.enum: [...]` arrays — both shapes appear in
  // TOOL_REGISTRY (e.g. get_market_data's `asset_class.items.enum` and
  // `get_news_intelligence.topic.enum`). `structuredClone` is a Web Platform
  // global on Vercel edge + Node 18+ (no polyfill needed).
  const clonedProperties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tool.inputSchema.properties)) {
    clonedProperties[key] = structuredClone(value);
  }

  // Inject the universal schemas as CLONES, not bare references, so that
  // mutating `result.inputSchema.properties.jmespath.description` doesn't
  // corrupt the module-level JMESPATH_SCHEMA const.
  if (isCacheTool) {
    clonedProperties.summary = structuredClone(SUMMARY_SCHEMA);
  }
  clonedProperties.jmespath = structuredClone(JMESPATH_SCHEMA);

  const description = opts.compressDescriptions
    ? compressDescription(tool.description, TOOL_DESCRIPTION_MAX_BYTES)
    : tool.description;

  return {
    name: tool.name,
    description,
    inputSchema: {
      type: tool.inputSchema.type,
      properties: clonedProperties,
      required: [...tool.inputSchema.required],
    },
    // Deep-clone for the same reason as inputSchema.properties — mutating the
    // returned object must not corrupt the module-level outputSchema literal.
    outputSchema: structuredClone(tool.outputSchema),
    // Per-tool annotations declared on each registry entry (v1.7.0).
    // Deep-cloned so a mutating client can't poison the registry literal —
    // matches the inputSchema.properties + outputSchema treatment above.
    annotations: structuredClone(tool.annotations),
  };
}

export const TOOL_LIST_RESPONSE = TOOL_REGISTRY.map((tool) => buildPublicTool(tool, { compressDescriptions: true }));
// Tools-list payload is static at module load — precompute its wire size so
// the per-session `mcp.tools_list_emitted` telemetry line doesn't re-stringify
// ~5 KB on every initialize.
export const TOOL_LIST_BYTES = utf8ByteLength(JSON.stringify(TOOL_LIST_RESPONSE));
