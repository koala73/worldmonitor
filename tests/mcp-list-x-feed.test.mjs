import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HMAC_SECRET, PRO_USER_ID } from './helpers/mcp-pro-deps.mjs';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_HMAC = process.env.MCP_INTERNAL_HMAC_SECRET;

beforeEach(() => {
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_HMAC === undefined) delete process.env.MCP_INTERNAL_HMAC_SECRET;
  else process.env.MCP_INTERNAL_HMAC_SECRET = ORIGINAL_HMAC;
});

describe('MCP list_x_feed R4 policy (#6654 / #6635)', () => {
  it('returns permalink + derived facts and strips tweet bodies', async () => {
    const tool = TOOL_REGISTRY.find((entry) => entry.name === 'list_x_feed');
    assert.ok(tool, 'list_x_feed must be registered');
    assert.ok(typeof tool._execute === 'function');
    assert.deepEqual(tool._apiPaths, ['GET /api/intelligence/v1/list-x-feed']);
    assert.deepEqual(tool._coverageKeys, ['intelligence:x-feed:v1']);

    globalThis.fetch = async (url) => {
      assert.match(String(url), /\/api\/intelligence\/v1\/list-x-feed\?/);
      return new Response(JSON.stringify({
        enabled: true,
        count: 1,
        posts: [{
          id: 'Reuters:123',
          accountName: 'Reuters',
          handle: 'Reuters',
          permalink: 'https://x.com/Reuters/status/123',
          facts: ['Reuters posted at 2026-08-18T12:00:00.000Z', 'topic:breaking'],
          text: 'SECRET BODY must not reach MCP partners',
          contentState: 'active',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const result = await tool._execute(
      { limit: 20, topic: 'breaking' },
      'https://worldmonitor.app',
      { kind: 'pro', userId: PRO_USER_ID },
    );
    assert.equal(result.enabled, true);
    assert.equal(result.count, 1);
    assert.equal(result.posts[0].permalink, 'https://x.com/Reuters/status/123');
    assert.ok(Array.isArray(result.posts[0].facts));
    assert.equal('text' in result.posts[0], false);
    assert.doesNotMatch(JSON.stringify(result), /SECRET BODY/);
  });
});
