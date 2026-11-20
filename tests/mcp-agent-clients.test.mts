import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CLAUDE_CONNECTOR_URL,
  CURSOR_INSTALL_URL,
  MCP_AGENT_CLIENTS,
  MCP_SERVER_URL,
  VSCODE_INSTALL_URL,
} from '../src/config/mcp-agent-clients.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('MCP agent client catalog', () => {
  it('points every client at the apex MCP endpoint', () => {
    assert.equal(MCP_SERVER_URL, 'https://worldmonitor.app/mcp');
    for (const client of MCP_AGENT_CLIENTS) {
      const { action } = client;
      if (action.kind === 'command') assert.ok(action.command.includes(MCP_SERVER_URL), client.id);
    }
  });

  it('prefills Claude\'s add-connector dialog with the name and URL', () => {
    const url = new URL(CLAUDE_CONNECTOR_URL);
    assert.equal(url.origin + url.pathname, 'https://claude.ai/customize/connectors');
    assert.equal(url.searchParams.get('modal'), 'add-custom-connector');
    assert.equal(url.searchParams.get('connectorName'), 'World Monitor');
    assert.equal(url.searchParams.get('connectorUrl'), MCP_SERVER_URL);
  });

  it('encodes the Cursor and VS Code install configs their redirects expect', () => {
    const cursor = new URL(CURSOR_INSTALL_URL);
    assert.equal(cursor.origin + cursor.pathname, 'https://cursor.com/install-mcp');
    assert.equal(cursor.searchParams.get('name'), 'worldmonitor');
    assert.deepEqual(JSON.parse(atob(cursor.searchParams.get('config')!)), { url: MCP_SERVER_URL });

    const vscode = new URL(VSCODE_INSTALL_URL);
    assert.equal(vscode.origin + vscode.pathname, 'https://vscode.dev/redirect/mcp/install');
    assert.equal(vscode.searchParams.get('name'), 'worldmonitor');
    assert.deepEqual(JSON.parse(vscode.searchParams.get('config')!), { type: 'http', url: MCP_SERVER_URL });
  });

  it('uses unique ids and only https links', () => {
    const ids = MCP_AGENT_CLIENTS.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const client of MCP_AGENT_CLIENTS) {
      const { action } = client;
      const href = action.kind === 'link' ? action.href : action.kind === 'url' ? action.openHref : undefined;
      if (href) assert.equal(new URL(href).protocol, 'https:', client.id);
    }
  });
});

describe('MCP quickstart docs stay in step with the catalog', () => {
  for (const path of ['docs/mcp-quickstart.mdx', 'docs/zh/mcp-quickstart.mdx']) {
    it(`${path} carries every one-click link and command`, () => {
      const doc = read(path);
      for (const link of [CLAUDE_CONNECTOR_URL, CURSOR_INSTALL_URL, VSCODE_INSTALL_URL]) {
        assert.ok(doc.includes(`](${link})`), `${path} is missing ${link}`);
      }
      for (const client of MCP_AGENT_CLIENTS) {
        const { action } = client;
        if (action.kind !== 'command') continue;
        // The docs split chained commands onto separate lines.
        for (const part of action.command.split(' && ')) {
          assert.ok(doc.includes(part), `${path} is missing the ${client.id} command: ${part}`);
        }
      }
    });
  }
});
