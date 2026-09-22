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

const MCP_ALIAS_HOSTS: ReadonlySet<string> = new Set(
  MCP_PRODUCTION_ALIAS_LABELS.map((label) => `${label}.worldmonitor.app`),
);

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

export function isMcpAliasRequest(host: string, pathname: string): boolean {
  return MCP_POLICY_PATHS.has(pathname) && MCP_ALIAS_HOSTS.has(normalizeMcpHost(host));
}

export function mcpCanonicalLocation(pathname: string): string {
  return pathname === '/api/mcp'
    ? MCP_CANONICAL_ENDPOINT
    : `${MCP_CANONICAL_ORIGIN}${pathname}`;
}
