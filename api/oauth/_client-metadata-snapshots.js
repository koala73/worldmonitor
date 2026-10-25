// Vetted copies of the trusted client documents, captured from each vendor's
// live URL on 2026-10-17 (tests/fixtures/oauth-cimd/live-documents.json), trimmed
// to the fields validateDocument reads.
//
// Used only when the live fetch fails in a retryable way. ChatGPT and Codex
// answer every request from Vercel Functions with a 403 page (#9244), and a
// copy pinned to the exact listed URL is the document we reviewed when we
// listed it. A live 404/410 or an invalid live document still rejects, so a
// vendor withdrawing or changing its document takes effect.
//
// Add an entry when adding a URL to TRUSTED_CLIENT_METADATA_URLS;
// tests/oauth-cimd.test.mjs checks the two stay in step with the fixture.
export const CLIENT_METADATA_SNAPSHOTS = {
  'https://claude.ai/oauth/mcp-oauth-client-metadata': {
    client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    client_name: 'Claude',
    redirect_uris: [
      'https://claude.ai/api/mcp/auth_callback'
    ],
    token_endpoint_auth_method: 'none',
    grant_types: [
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:jwt-bearer'
    ],
    response_types: [
      'code'
    ]
  },
  'https://claude.ai/oauth/claude-code-client-metadata': {
    client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
    client_name: 'Claude Code',
    redirect_uris: [
      'http://localhost/callback',
      'http://127.0.0.1/callback'
    ],
    token_endpoint_auth_method: 'none',
    grant_types: [
      'authorization_code',
      'refresh_token'
    ],
    response_types: [
      'code'
    ]
  },
  'https://chatgpt.com/oauth/client.json': {
    client_id: 'https://chatgpt.com/oauth/client.json',
    client_name: 'ChatGPT',
    redirect_uris: [
      'https://chatgpt.com/connector_platform_oauth_redirect'
    ],
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_methods_supported: [
      'none',
      'private_key_jwt'
    ],
    grant_types: [
      'authorization_code',
      'refresh_token'
    ],
    response_types: [
      'code'
    ]
  },
  'https://chatgpt.com/oauth/codex/client.json': {
    client_id: 'https://chatgpt.com/oauth/codex/client.json',
    client_name: 'Codex',
    redirect_uris: [
      'http://127.0.0.1/callback',
      'http://localhost/callback'
    ],
    token_endpoint_auth_method: 'none',
    token_endpoint_auth_methods_supported: [
      'none'
    ],
    grant_types: [
      'authorization_code',
      'refresh_token'
    ],
    response_types: [
      'code'
    ]
  },
  'https://cursor.com/oauth/mcp-client.json': {
    client_id: 'https://cursor.com/oauth/mcp-client.json',
    client_name: 'Cursor',
    redirect_uris: [
      'https://www.cursor.com/agents/mcp/oauth/callback',
      'https://www.cursor.com/bot/mcp/oauth/callback',
      'https://grok.com/connectors-oauth-exchange-code/',
      'http://localhost:8787/callback',
      'http://127.0.0.1:8787/callback'
    ],
    token_endpoint_auth_method: 'none',
    grant_types: [
      'authorization_code',
      'refresh_token'
    ],
    response_types: [
      'code'
    ]
  },
  'https://grok.com/oauth/mcp-client.json': {
    client_id: 'https://grok.com/oauth/mcp-client.json',
    client_name: 'Grok',
    redirect_uris: [
      'https://grok.com/connectors-oauth-exchange-code/',
      'https://console.x.ai/connectors-oauth-exchange-code/'
    ],
    token_endpoint_auth_method: 'none',
    grant_types: [
      'authorization_code',
      'refresh_token'
    ],
    response_types: [
      'code'
    ]
  },
  'https://vscode.dev/oauth/client-metadata.json': {
    client_id: 'https://vscode.dev/oauth/client-metadata.json',
    client_name: 'Visual Studio Code',
    redirect_uris: [
      'http://127.0.0.1:33418/',
      'https://vscode.dev/redirect'
    ],
    token_endpoint_auth_method: 'none',
    grant_types: [
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:device_code'
    ],
    response_types: [
      'code'
    ]
  },
  'https://goose-docs.ai/oauth/client-metadata.json': {
    client_id: 'https://goose-docs.ai/oauth/client-metadata.json',
    client_name: 'goose',
    redirect_uris: [
      'http://127.0.0.1/oauth_callback',
      'http://[::1]/oauth_callback'
    ],
    token_endpoint_auth_method: 'none',
    grant_types: [
      'authorization_code',
      'refresh_token'
    ],
    response_types: [
      'code'
    ]
  },
  'https://www.notion.so/oauth/mcp-client-metadata.json': {
    client_id: 'https://www.notion.so/oauth/mcp-client-metadata.json',
    client_name: 'Notion',
    redirect_uris: [
      'https://www.notion.so/workflows/mcp/oauth/callback'
    ],
    token_endpoint_auth_method: 'none',
    grant_types: [
      'authorization_code',
      'refresh_token'
    ],
    response_types: [
      'code'
    ]
  },
  'https://app.notion.com/oauth/mcp-client-metadata.json': {
    client_id: 'https://app.notion.com/oauth/mcp-client-metadata.json',
    client_name: 'Notion',
    redirect_uris: [
      'https://app.notion.com/workflows/mcp/oauth/callback'
    ],
    token_endpoint_auth_method: 'none',
    grant_types: [
      'authorization_code',
      'refresh_token'
    ],
    response_types: [
      'code'
    ]
  },
  'https://linear.app/.well-known/oauth-client-metadata/mcp.json': {
    client_id: 'https://linear.app/.well-known/oauth-client-metadata/mcp.json',
    client_name: 'Linear',
    redirect_uris: [
      'https://linear.app/connect/mcp/callback'
    ],
    token_endpoint_auth_method: 'none',
    grant_types: [
      'authorization_code',
      'refresh_token'
    ],
    response_types: [
      'code'
    ]
  },
  'https://api.lovable.dev/.well-known/oauth-client': {
    client_id: 'https://api.lovable.dev/.well-known/oauth-client',
    client_name: 'Lovable',
    redirect_uris: [
      'https://api.lovable.dev/workspaces/connectors/mcp/oauth/callback'
    ],
    token_endpoint_auth_method: 'none',
    grant_types: [
      'authorization_code',
      'refresh_token'
    ],
    response_types: [
      'code'
    ]
  },
  'https://api.factory.ai/mcp/oauth-client': {
    client_id: 'https://api.factory.ai/mcp/oauth-client',
    client_name: 'Factory Droid',
    redirect_uris: [
      'http://127.0.0.1/callback',
      'http://127.0.0.1:54621/callback',
      'http://127.0.0.1:54622/callback',
      'http://127.0.0.1:54623/callback',
      'https://dev.app.factory.ai/mcp/oauth/callback',
      'https://staging.app.factory.ai/mcp/oauth/callback',
      'https://preprod.app.factory.ai/mcp/oauth/callback',
      'https://app.factory.ai/mcp/oauth/callback',
      'https://dev.app.eu.factory.ai/mcp/oauth/callback',
      'https://staging.app.eu.factory.ai/mcp/oauth/callback',
      'https://preprod.app.eu.factory.ai/mcp/oauth/callback',
      'https://app.eu.factory.ai/mcp/oauth/callback',
      'http://localhost:3002/mcp/oauth/callback',
      'http://127.0.0.1:3002/mcp/oauth/callback'
    ],
    token_endpoint_auth_method: 'none',
    grant_types: [
      'authorization_code',
      'refresh_token'
    ],
    response_types: [
      'code'
    ]
  },
  'https://api.conductor.build/oauth/client-metadata.json': {
    client_id: 'https://api.conductor.build/oauth/client-metadata.json',
    client_name: 'Conductor',
    redirect_uris: [
      'https://api.conductor.build/oauth/callback'
    ],
    token_endpoint_auth_method: 'none',
    grant_types: [
      'authorization_code',
      'refresh_token'
    ],
    response_types: [
      'code'
    ]
  },
  'https://www.skydive.com/api/v1/external-oauth/client-metadata': {
    client_id: 'https://www.skydive.com/api/v1/external-oauth/client-metadata',
    client_name: 'Skydive',
    redirect_uris: [
      'https://www.skydive.com/api/v1/external-oauth/callback'
    ],
    token_endpoint_auth_method: 'none',
    grant_types: [
      'authorization_code',
      'refresh_token'
    ],
    response_types: [
      'code'
    ]
  },
  'https://www.mcpjam.com/.well-known/oauth/client-metadata.json': {
    client_id: 'https://www.mcpjam.com/.well-known/oauth/client-metadata.json',
    client_name: 'MCPJam',
    redirect_uris: [
      'http://127.0.0.1:6274/oauth/callback',
      'http://127.0.0.1:6274/callback',
      'http://127.0.0.1:6274/oauth/callback/debug',
      'http://localhost:6274/oauth/callback',
      'http://localhost:6274/callback',
      'http://localhost:6274/oauth/callback/debug',
      'http://127.0.0.1:5173/oauth/callback',
      'http://127.0.0.1:5173/oauth/callback/debug',
      'http://localhost:5173/oauth/callback',
      'http://localhost:5173/oauth/callback/debug',
      'https://app.mcpjam.com/oauth/callback',
      'https://app.mcpjam.com/oauth/callback/debug',
      'https://staging.mcpjam.com/oauth/callback',
      'https://staging.mcpjam.com/oauth/callback/debug',
      'https://score.mcpjam.com/oauth/callback',
      'https://score.mcpjam.com/oauth/callback/debug',
      'https://www.score.mcpjam.com/oauth/callback',
      'https://www.score.mcpjam.com/oauth/callback/debug'
    ],
    token_endpoint_auth_method: 'none',
    grant_types: [
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:device_code'
    ],
    response_types: [
      'code'
    ]
  }
};
