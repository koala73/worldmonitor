import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  MAX_MCP_PROXY_JSON_CONTAINERS,
  MAX_MCP_PROXY_JSON_DEPTH,
  McpProxyJsonContainerError,
  McpProxyJsonDepthError,
  createMcpProxyJsonBudget,
  parseMcpProxyJson,
} from '../api/mcp/bounded-json.ts';

function nestedArray(depth) {
  return '['.repeat(depth) + '0' + ']'.repeat(depth);
}

function emptyObjectArray(containerCount) {
  const objectCount = containerCount - 1;
  return `[${objectCount > 0 ? '{}' + ',{}'.repeat(objectCount - 1) : ''}]`;
}

describe('parseMcpProxyJson', () => {
  it('accepts the exact nesting limit without changing the value', () => {
    const text = nestedArray(MAX_MCP_PROXY_JSON_DEPTH);
    assert.deepEqual(parseMcpProxyJson(text), JSON.parse(text));
  });

  it('rejects one level over the nesting limit', () => {
    assert.throws(
      () => parseMcpProxyJson(nestedArray(MAX_MCP_PROXY_JSON_DEPTH + 1)),
      McpProxyJsonDepthError,
    );
  });

  it('accepts the exact container limit', () => {
    const parsed = parseMcpProxyJson(emptyObjectArray(MAX_MCP_PROXY_JSON_CONTAINERS));

    assert.equal(parsed.length, MAX_MCP_PROXY_JSON_CONTAINERS - 1);
  });

  it('rejects one container over the limit before parsing', () => {
    assert.throws(
      () => parseMcpProxyJson(emptyObjectArray(MAX_MCP_PROXY_JSON_CONTAINERS + 1)),
      McpProxyJsonContainerError,
    );
  });

  it('spends one shared budget across calls so frames cannot each get a fresh limit', () => {
    const budget = createMcpProxyJsonBudget();
    const half = Math.floor(MAX_MCP_PROXY_JSON_CONTAINERS / 2);

    parseMcpProxyJson(emptyObjectArray(half), budget);
    assert.equal(budget.containers, half);

    assert.throws(
      () => parseMcpProxyJson(emptyObjectArray(MAX_MCP_PROXY_JSON_CONTAINERS), budget),
      McpProxyJsonContainerError,
    );
  });

  it('gives each caller a fresh budget when none is supplied', () => {
    const text = emptyObjectArray(MAX_MCP_PROXY_JSON_CONTAINERS);

    assert.equal(parseMcpProxyJson(text).length, MAX_MCP_PROXY_JSON_CONTAINERS - 1);
    assert.equal(parseMcpProxyJson(text).length, MAX_MCP_PROXY_JSON_CONTAINERS - 1);
  });

  it('ignores structural characters inside escaped JSON strings', () => {
    const value = {
      braces: '{[not structure]}',
      escaped: '\\"[{still text}]',
      slash: '\\\\',
    };
    const text = JSON.stringify(value);

    assert.deepEqual(parseMcpProxyJson(text), value);
  });

  it('keeps native malformed-JSON behavior below the depth limit', () => {
    assert.throws(() => parseMcpProxyJson('{"value":]'), SyntaxError);
  });
});
