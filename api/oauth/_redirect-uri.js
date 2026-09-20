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
  // Cursor Agents and web; Grok Bot registers both Cursor entries
  'https://www.cursor.com/agents/mcp/oauth/callback',
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
]);

// Enforced at registration (api/oauth/register.js) and re-checked before a Pro
// grant is minted (api/internal/mcp-grant-mint.ts), so tightening the list
// also fails closed for clients registered under the old one.
export function isAllowedRedirectUri(uri) {
  if (ALLOWED_REDIRECT_URIS.has(uri)) return true;
  // localhost / 127.0.0.1 any port (Claude Code, Cursor, VS Code, MCP Inspector)
  try {
    const u = new URL(uri);
    return (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.protocol === 'http:';
  } catch { return false; }
}

// Where the authorization code goes, as shown on the consent screens
// (api/oauth/authorize.js, api/internal/mcp-grant-context.ts). A custom-scheme
// callback keeps its scheme: `anysphere.cursor-mcp` alone reads like a web host.
export function redirectDisplayHost(uri) {
  const u = new URL(uri);
  return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname : `${u.protocol}//${u.hostname}`;
}
