import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

// Guards for the official MCP registry publication artifacts
// (registry.modelcontextprotocol.io, namespace app.worldmonitor):
// - public/.well-known/mcp-registry-auth is the HTTP domain-verification
//   surface. If it 404s or its format drifts, every future `mcp-publisher
//   login http` fails and the namespace is unrecoverable without DNS access.
// - server.json is the published registry entry. Its version/remote must
//   track the MCP server card; on a SERVER_VERSION bump, bump server.json
//   too and republish (`mcp-publisher publish` with the domain key at
//   ~/.config/worldmonitor/mcp-registry-ed25519.pem).
describe('mcp registry publication artifacts', () => {
  const authFile = readFileSync(join(ROOT, 'public/.well-known/mcp-registry-auth'), 'utf-8');
  const serverJson = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf-8'));
  const serverCard = JSON.parse(
    readFileSync(join(ROOT, 'public/.well-known/mcp/server-card.json'), 'utf-8'),
  );

  it('mcp-registry-auth carries a single MCPv1 ed25519 key line', () => {
    assert.match(
      authFile,
      /^v=MCPv1; k=ed25519; p=[A-Za-z0-9+/]{43}=\n$/,
      'format must stay `v=MCPv1; k=ed25519; p=<base64>` — the registry parses it verbatim',
    );
  });

  it('server.json stays in the app.worldmonitor namespace with the canonical remote', () => {
    assert.equal(serverJson.name, 'app.worldmonitor/mcp');
    assert.equal(serverJson.remotes.length, 1);
    assert.equal(serverJson.remotes[0].type, 'streamable-http');
    assert.equal(
      serverJson.remotes[0].url,
      serverCard.url,
      'registry remote must match the server card MCP endpoint',
    );
    assert.equal(serverJson.websiteUrl, 'https://www.worldmonitor.app');
  });

  it('server.json version tracks the server card (bump both + republish on SERVER_VERSION change)', () => {
    assert.equal(
      serverJson.version,
      serverCard.version,
      'SERVER_VERSION bumped without bumping server.json — update it and republish to registry.modelcontextprotocol.io (see test header)',
    );
  });
});
