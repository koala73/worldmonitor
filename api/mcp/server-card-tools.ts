import { TOOL_CATEGORY_BY_NAME } from './domains';
import { TOOL_REGISTRY, toolAccess } from './registry/index';

/**
 * The server card's `tools` list: one public preview per registry tool.
 *
 * scripts/generate-public-product-facts.mjs writes it into
 * public/.well-known/mcp/server-card.json, and api/mcp/handler.ts rebuilds the
 * card from the same projection, so the bundle does not carry a second copy of
 * every tool description.
 */
export function serverCardTools() {
  return TOOL_REGISTRY.map((tool) => {
    const category = TOOL_CATEGORY_BY_NAME[tool.name];
    if (!category) throw new Error(`${tool.name} has no category in api/mcp/domains.ts`);
    return {
      name: tool.name,
      description: tool.description,
      _meta: {
        ...(tool._uiResourceUri ? { ui: { resourceUri: tool._uiResourceUri } } : {}),
        'worldmonitor/access': toolAccess(tool),
        'worldmonitor/category': category,
      },
    };
  });
}
