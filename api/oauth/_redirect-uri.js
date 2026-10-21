// OAuth redirect_uri policy shared by the registration, consent, and Pro grant
// routes. Route entries import this helper, never each other (AGENTS.md).

// DCR is not open to arbitrary redirect URIs: the registered callback receives
// the authorization code. Each entry is a vendor-owned MCP client callback,
// matched exactly as that client sends it. Sources are listed in
// docs/mcp-overview.mdx#redirect-uri-allowlist.
const ALLOWED_REDIRECT_URIS = new Set([
  // Claude
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  // Cursor Agents, Cursor Bot, and web; Grok Bot registers the Cursor entries.
  // https://cursor.com/oauth/mcp-client.json lists both https callbacks.
  'https://www.cursor.com/agents/mcp/oauth/callback',
  'https://www.cursor.com/bot/mcp/oauth/callback',
  'cursor://anysphere.cursor-mcp/oauth/callback',
  // ChatGPT: the stable callback requires RFC 9207 `iss` (api/oauth/authorize.js)
  'https://chatgpt.com/connector_platform_oauth_redirect',
  // Grok
  'https://grok.com/connectors-oauth-exchange-code/',
  'https://console.x.ai/connectors-oauth-exchange-code/',
  // VS Code for the Web (desktop VS Code uses loopback)
  'https://vscode.dev/redirect',
  'https://insiders.vscode.dev/redirect',
  // Perplexity
  'https://www.perplexity.ai/rest/connections/oauth_callback',
  'https://enterprise.perplexity.ai/rest/connections/oauth_callback',
  // Mistral Le Chat
  'https://callback.mistral.ai/v1/integrations_auth/oauth2_callback',
  // Devin
  'https://api.devin.ai/mcp/oauth/callback',
  // Google Antigravity
  'https://antigravity.google/oauth-callback',
  // Vercel Connect
  'https://connect.vercel.com/callback',
  // Make.com MCP Client (https://apps.make.com/mcp-client)
  'https://www.make.com/oauth/cb/mcp',
  // Glama connector test profiles and personal connections, then Glama MCP
  // Inspector (both routes are in Glama's shipped route manifest)
  'https://glama.ai/api/app/mcp/oauth/callback',
  'https://glama.ai/mcp/inspector/oauth/callback',
  // Microsoft 365 Copilot MCP plugins (MicrosoftDocs/m365copilot-docs build-mcp-plugins.md)
  'https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect',
  // Meta Muse custom connectors (sent as agent.meta.ai, which 302s to the
  // Meta-owned muse.ai; issue #9527)
  'https://agent.meta.ai/api/hatch/oauth/callback',
  // The clients below publish CIMD documents (the cited URL) and prefer CIMD,
  // which api/oauth/_client-metadata.js accepts. These entries remain for
  // clients that still register through DCR.
  // Notion (https://www.notion.so/oauth/mcp-client-metadata.json,
  // https://app.notion.com/oauth/mcp-client-metadata.json)
  'https://www.notion.so/workflows/mcp/oauth/callback',
  'https://app.notion.com/workflows/mcp/oauth/callback',
  // Linear (https://linear.app/.well-known/oauth-client-metadata/mcp.json)
  'https://linear.app/connect/mcp/callback',
  // Lovable (https://api.lovable.dev/.well-known/oauth-client)
  'https://api.lovable.dev/workspaces/connectors/mcp/oauth/callback',
  // Factory production hosts (https://api.factory.ai/mcp/oauth-client)
  'https://app.factory.ai/mcp/oauth/callback',
  'https://app.eu.factory.ai/mcp/oauth/callback',
  // Conductor (https://api.conductor.build/oauth/client-metadata.json)
  'https://api.conductor.build/oauth/callback',
  // Skydive (https://www.skydive.com/api/v1/external-oauth/client-metadata)
  'https://www.skydive.com/api/v1/external-oauth/callback',
  // MCPJam production hosts (https://www.mcpjam.com/.well-known/oauth/client-metadata.json)
  'https://app.mcpjam.com/oauth/callback',
  'https://score.mcpjam.com/oauth/callback',
]);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Enforced at registration (api/oauth/register.js) and re-checked before a Pro
// grant is minted (api/internal/mcp-grant-mint.ts), so tightening the list
// also fails closed for clients registered under the old one.
export function isAllowedRedirectUri(uri) {
  if (ALLOWED_REDIRECT_URIS.has(uri)) return true;
  // localhost / 127.0.0.1 / [::1] any port (Claude Code, Cursor, VS Code, MCP
  // Inspector; goose registers [::1]). WHATWG URL keeps the IPv6 brackets.
  try {
    const u = new URL(uri);
    return LOOPBACK_HOSTS.has(u.hostname) && u.protocol === 'http:';
  } catch { return false; }
}

// Where the authorization code goes, as shown on the consent screens
// (api/oauth/authorize.js, api/internal/mcp-grant-context.ts). A custom-scheme
// callback keeps its scheme: `anysphere.cursor-mcp` alone reads like a web host.
export function redirectDisplayHost(uri) {
  const u = new URL(uri);
  return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname : `${u.protocol}//${u.hostname}`;
}
