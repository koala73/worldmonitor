import { TOOL_CATEGORY_BY_NAME } from './domains';
import { TOOL_REGISTRY, toolAccess } from './registry/index';
import type { ToolDef } from './types';

/**
 * The server card's `tools` list: one public preview per registry tool.
 *
 * scripts/generate-public-product-facts.mjs writes it into
 * public/.well-known/mcp/server-card.json, and api/mcp/handler.ts rebuilds the
 * card from the same projection, so the bundle does not carry a second copy of
 * every tool description.
 *
 * A tool with no category gets no `worldmonitor/category` key. The generator
 * rejects that state, which fails the deploy build (prebuild:full runs
 * product:facts) and tests/mcp-domains.test.mjs. Leaving the key out keeps a
 * discovery request from throwing if the mismatch reaches a runtime anyway.
 */
export function serverCardTools(
  registry: readonly ToolDef[] = TOOL_REGISTRY,
  categories: Readonly<Record<string, string>> = TOOL_CATEGORY_BY_NAME,
) {
  return registry.map((tool) => ({
    name: tool.name,
    description: tool.description,
    _meta: {
      ...(tool._uiResourceUri ? { ui: { resourceUri: tool._uiResourceUri } } : {}),
      'worldmonitor/access': toolAccess(tool),
      ...(categories[tool.name] ? { 'worldmonitor/category': categories[tool.name] } : {}),
    },
  }));
}
