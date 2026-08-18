import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

import { SERVER_INSTRUCTIONS } from '../api/mcp/constants.ts';
import {
  buildPublicTool,
  TOOL_LIST_RESPONSE,
  TOOL_REGISTRY,
} from '../api/mcp/registry/index.ts';
import { RESOURCE_TEMPLATE_LIST_RESPONSE } from '../api/mcp/resources/index.ts';

const accessFor = (name) => TOOL_LIST_RESPONSE
  .find((tool) => tool.name === name)?._meta?.['worldmonitor/access'];

describe('agent-visible MCP access contract', () => {
  it('labels anonymous, authenticated-free-account, and subscription-only tools', () => {
    assert.equal(accessFor('get_sources'), 'free');
    assert.equal(accessFor('get_market_data'), 'free-account');
    assert.equal(accessFor('get_country_risk'), 'subscription');

    for (const tool of TOOL_REGISTRY) {
      const expected = tool._freeTier === true
        ? 'free'
        : tool._execute === undefined || tool.name === 'describe_tool'
          ? 'free-account'
          : 'subscription';
      assert.equal(accessFor(tool.name), expected, `${tool.name} access marker`);
    }
  });

  it('keeps tools/list and describe_tool access metadata identical', () => {
    for (const listed of TOOL_LIST_RESPONSE) {
      const internal = TOOL_REGISTRY.find((tool) => tool.name === listed.name);
      assert.ok(internal, `${listed.name} must exist in the internal registry`);
      const described = buildPublicTool(internal, { compressDescriptions: false });
      assert.equal(
        described._meta?.['worldmonitor/access'],
        listed._meta?.['worldmonitor/access'],
        `${listed.name} tools/list and describe_tool access metadata`,
      );
    }
  });

  it('labels each resource template with the access class of its backing tool', () => {
    const byUri = new Map(
      RESOURCE_TEMPLATE_LIST_RESPONSE.map((resource) => [resource.uriTemplate, resource]),
    );
    assert.equal(
      byUri.get('worldmonitor://chokepoints/{slug}/status')?._meta?.['worldmonitor/access'],
      'free-account',
    );
    assert.equal(
      byUri.get('worldmonitor://markets/{symbol}/quote')?._meta?.['worldmonitor/access'],
      'free-account',
    );
    assert.equal(
      byUri.get('worldmonitor://countries/{iso2}/risk')?._meta?.['worldmonitor/access'],
      'subscription',
    );
  });

  it('keeps the public server-card tool preview and account resource in parity', () => {
    const card = JSON.parse(readFileSync(
      new URL('../public/.well-known/mcp/server-card.json', import.meta.url),
      'utf8',
    ));
    for (const tool of TOOL_LIST_RESPONSE) {
      const preview = card.tools.find((entry) => entry.name === tool.name);
      assert.ok(preview, `${tool.name} must appear in the server card`);
      assert.equal(
        preview._meta?.['worldmonitor/access'],
        tool._meta?.['worldmonitor/access'],
        `${tool.name} server-card access marker`,
      );
    }
    assert.deepEqual(card.metadata.accountAllowanceResource, {
      uri: 'worldmonitor://account/mcp-allowance',
      discovery: 'Authenticated user-bound resources/list only',
      quotaExempt: true,
    });
  });

  it('does not promise structured data on every denial class', () => {
    assert.doesNotMatch(SERVER_INSTRUCTIONS, /Every denial carries/i);
    assert.match(SERVER_INSTRUCTIONS, /structured (?:paid-funnel|account-access) denials/i);
    assert.match(SERVER_INSTRUCTIONS, /other rate-limit and service errors may omit/i);
  });
});
