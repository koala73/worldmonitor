// The hosted product MCP transport has one public endpoint. Keep this policy
// dependency-free because it runs in both Vercel middleware and the Edge API
// handler that receives rewritten and dotted well-known paths.
export const MCP_CANONICAL_ENDPOINT = 'https://worldmonitor.app/mcp';
export const MCP_CANONICAL_LINK = `<${MCP_CANONICAL_ENDPOINT}>; rel="canonical"`;

const MCP_ALIAS_HOSTS: ReadonlySet<string> = new Set([
  'www.worldmonitor.app',
  'api.worldmonitor.app',
  'tech.worldmonitor.app',
  'finance.worldmonitor.app',
  'commodity.worldmonitor.app',
  'happy.worldmonitor.app',
  'energy.worldmonitor.app',
]);

const MCP_POLICY_PATHS: ReadonlySet<string> = new Set([
  '/mcp',
  '/api/mcp',
  '/.well-known/mcp',
  '/.well-known/mcp.json',
]);

export function normalizeMcpHost(raw: string): string {
  return raw.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

export function isMcpAliasRequest(host: string, pathname: string): boolean {
  return MCP_POLICY_PATHS.has(pathname) && MCP_ALIAS_HOSTS.has(normalizeMcpHost(host));
}

export function mcpCanonicalLocation(pathname: string): string {
  return pathname === '/api/mcp'
    ? MCP_CANONICAL_ENDPOINT
    : `https://worldmonitor.app${pathname}`;
}
