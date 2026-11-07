// The hosted product MCP transport has one public endpoint. Keep this policy
// dependency-free because it runs in both Vercel middleware and the Edge API
// handler that receives rewritten and dotted well-known paths.
export const MCP_CANONICAL_ENDPOINT = 'https://worldmonitor.app/mcp';
export const MCP_CANONICAL_ORIGIN = 'https://worldmonitor.app';
export const MCP_CANONICAL_LINK = `<${MCP_CANONICAL_ENDPOINT}>; rel="canonical"`;
export const MCP_CANONICAL_ENDPOINT_ERROR_CODE = -32000;
export const MCP_CANONICAL_ENDPOINT_ERROR_MESSAGE = `Use ${MCP_CANONICAL_ENDPOINT}`;
export const MCP_CANONICAL_ENDPOINT_ERROR_DATA = {
  reason: 'canonical_endpoint_required',
  endpoint: MCP_CANONICAL_ENDPOINT,
} as const;

export const MCP_PRODUCTION_ALIAS_LABELS = [
  'www',
  'api',
  'tech',
  'finance',
  'commodity',
  'happy',
  'energy',
] as const;

// Non-canonical hosts that still serve the transport paths. They are never
// published (every document names MCP_CANONICAL_ENDPOINT), and their
// well-known server cards keep redirecting. api. stays served because its OAuth
// discovery names itself as the resource: connectors configured with the api.
// host's /mcp (Claude-User sent ~1,300 requests a day on 2026-11-06) completed
// consent and token exchange, then got 410 on every call.
export const MCP_SERVED_ALIAS_LABELS = ['api'] as const;

// Aliases whose MCP paths are retired: GET/HEAD 308, transport operations 410.
export const MCP_RETIRED_ALIAS_LABELS = MCP_PRODUCTION_ALIAS_LABELS.filter(
  (label) => !(MCP_SERVED_ALIAS_LABELS as readonly string[]).includes(label),
);

const MCP_ALIAS_HOSTS: ReadonlySet<string> = new Set(
  MCP_PRODUCTION_ALIAS_LABELS.map((label) => `${label}.worldmonitor.app`),
);

const MCP_SERVED_ALIAS_HOSTS: ReadonlySet<string> = new Set(
  MCP_SERVED_ALIAS_LABELS.map((label) => `${label}.worldmonitor.app`),
);

const MCP_TRANSPORT_PATHS: ReadonlySet<string> = new Set(['/mcp', '/api/mcp']);

export const MCP_PRODUCT_PATHS = [
  '/mcp',
  '/api/mcp',
  '/.well-known/mcp',
  '/.well-known/mcp.json',
] as const;

const MCP_POLICY_PATHS: ReadonlySet<string> = new Set(MCP_PRODUCT_PATHS);

export function normalizeMcpHost(raw: string): string {
  return raw.toLowerCase().replace(/\.+$/, '').replace(/:\d+$/, '');
}

/**
 * True for any MCP product path on a listed production alias, served or
 * retired. Middleware uses it to hand every such request to the MCP handler
 * before generic bot gates, which would otherwise 403 a transport call.
 */
export function isMcpProductionAliasPath(host: string, pathname: string): boolean {
  return MCP_POLICY_PATHS.has(pathname) && MCP_ALIAS_HOSTS.has(normalizeMcpHost(host));
}

/** True when the request must get the migration response instead of MCP. */
export function isMcpAliasRequest(host: string, pathname: string): boolean {
  if (!isMcpProductionAliasPath(host, pathname)) return false;
  return !(MCP_SERVED_ALIAS_HOSTS.has(normalizeMcpHost(host)) && MCP_TRANSPORT_PATHS.has(pathname));
}

export function mcpCanonicalLocation(pathname: string): string {
  return pathname === '/api/mcp'
    ? MCP_CANONICAL_ENDPOINT
    : `${MCP_CANONICAL_ORIGIN}${pathname}`;
}
