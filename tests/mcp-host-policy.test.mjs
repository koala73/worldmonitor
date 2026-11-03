import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  MCP_CANONICAL_ENDPOINT,
  MCP_CANONICAL_ORIGIN,
  MCP_PRODUCTION_ALIAS_LABELS,
  MCP_PRODUCT_PATHS,
  isMcpAliasRequest,
  mcpCanonicalLocation,
  normalizeMcpHost,
} from '../shared/mcp-host-policy.ts';

describe('shared/mcp-host-policy', () => {
  it('does not classify the canonical apex, localhost, preview, or unknown hosts', () => {
    for (const path of MCP_PRODUCT_PATHS) {
      assert.equal(isMcpAliasRequest('worldmonitor.app', path), false, path);
    }
    assert.equal(isMcpAliasRequest('localhost', '/mcp'), false);
    assert.equal(isMcpAliasRequest('127.0.0.1', '/mcp'), false);
    assert.equal(isMcpAliasRequest('worldmonitor-feature.vercel.app', '/mcp'), false);
    assert.equal(isMcpAliasRequest('staging.worldmonitor.app', '/mcp'), false);
    assert.equal(isMcpAliasRequest('www.worldmonitor.app', '/docs/mcp'), false);
  });

  it('classifies listed production aliases on every product path', () => {
    for (const label of MCP_PRODUCTION_ALIAS_LABELS) {
      for (const path of MCP_PRODUCT_PATHS) {
        assert.equal(
          isMcpAliasRequest(`${label}.worldmonitor.app`, path),
          true,
          `${label} ${path}`,
        );
      }
    }
  });

  it('strips a trailing DNS dot and a port before matching', () => {
    assert.equal(normalizeMcpHost('WWW.worldmonitor.app:443.'), 'www.worldmonitor.app');
    assert.equal(isMcpAliasRequest('www.worldmonitor.app.', '/mcp'), true);
  });

  it('maps /api/mcp to the canonical endpoint and keeps well-known paths', () => {
    assert.equal(mcpCanonicalLocation('/api/mcp'), MCP_CANONICAL_ENDPOINT);
    assert.equal(mcpCanonicalLocation('/mcp'), MCP_CANONICAL_ENDPOINT);
    assert.equal(mcpCanonicalLocation('/.well-known/mcp'), `${MCP_CANONICAL_ORIGIN}/.well-known/mcp`);
    assert.equal(
      mcpCanonicalLocation('/.well-known/mcp.json'),
      `${MCP_CANONICAL_ORIGIN}/.well-known/mcp.json`,
    );
  });
});
