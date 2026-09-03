import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  MAX_MCP_PROXY_JSON_DEPTH,
  McpProxyJsonDepthError,
  parseMcpProxyJson,
} from '../api/mcp/bounded-json.ts';

function nestedArray(depth) {
  return '['.repeat(depth) + '0' + ']'.repeat(depth);
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
