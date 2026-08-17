/**
 * MCP paid-funnel attribution (#6716).
 *
 * Shared so the MCP denial upgrade URL, create-checkout allowlist, and the
 * /pro marketing page all agree on the campaign marker without drifting.
 */

export const MCP_UPGRADE_UTM_SOURCE = 'mcp';
export const MCP_UPGRADE_UTM_MEDIUM = 'agent';
export const MCP_UPGRADE_UTM_CAMPAIGN = 'mcp-paid-funnel';

export const MCP_ATTRIBUTION_SOURCE = MCP_UPGRADE_UTM_CAMPAIGN;

export const MCP_UPGRADE_URL =
  `https://worldmonitor.app/pro`
  + `?utm_source=${MCP_UPGRADE_UTM_SOURCE}`
  + `&utm_medium=${MCP_UPGRADE_UTM_MEDIUM}`
  + `&utm_campaign=${MCP_UPGRADE_UTM_CAMPAIGN}`;

export function isMcpAttributionSource(value: unknown): value is string {
  return value === MCP_ATTRIBUTION_SOURCE;
}

export function normalizeCheckoutAttributionSource(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return isMcpAttributionSource(trimmed) ? trimmed : undefined;
}

/** Read the MCP campaign from a URL search string (inbound /pro visit). */
export function readMcpAttributionFromSearch(search: string): string | undefined {
  const params = new URLSearchParams(
    search.startsWith('?') || search.startsWith('#') ? search : `?${search}`,
  );
  const campaign = params.get('utm_campaign');
  return isMcpAttributionSource(campaign) ? campaign : undefined;
}
