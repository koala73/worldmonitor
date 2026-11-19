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
 * rejects that state and tests/mcp-domains.test.mjs fails on it; the deploy
 * build runs neither, so the served card must not throw on it.
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
