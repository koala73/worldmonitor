import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

import { SERVER_INSTRUCTIONS } from '../api/mcp/constants.ts';
import {
  buildPublicTool,
  TOOL_LIST_RESPONSE,
  TOOL_REGISTRY,
  toolWeight,
} from '../api/mcp/registry/index.ts';
import { RESOURCE_TEMPLATE_LIST_RESPONSE } from '../api/mcp/resources/index.ts';

const accessFor = (name) => TOOL_LIST_RESPONSE
  .find((tool) => tool.name === name)?._meta?.['worldmonitor/access'];
const weightFor = (name) => TOOL_LIST_RESPONSE
  .find((tool) => tool.name === name)?._meta?.['worldmonitor/weight'];

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

  it('publishes what every tool COSTS, on every tool', () => {
    // An API-tier caller is charged 1, 2 or 3 units per call. Without this the
    // only way to learn the price is to watch the allowance resource move, and
    // it is emitted unconditionally because the cost belongs to the TOOL —
    // tools/list is served on paths that hold no budget at all.
    assert.equal(weightFor('get_market_data'), 1, 'a cache read costs one REST-request unit');
    assert.equal(weightFor('get_country_risk'), 2, 'an _execute tool fetches downstream once');
    assert.equal(weightFor('get_country_brief'), 3, 'the double-fetch override must reach the wire');
    // The marker is a price, not a verdict: `worldmonitor/access` decides
    // whether anything is charged at all, so the free-tier tool still publishes
    // what its work costs.
    assert.equal(weightFor('get_sources'), 2);
    assert.equal(accessFor('get_sources'), 'free');

    for (const tool of TOOL_REGISTRY) {
      assert.equal(
        weightFor(tool.name),
        toolWeight(tool),
        `${tool.name} advertised weight must be the charged weight`,
      );
    }
  });

  it('keeps tools/list and describe_tool weight metadata identical', () => {
    for (const listed of TOOL_LIST_RESPONSE) {
      const internal = TOOL_REGISTRY.find((tool) => tool.name === listed.name);
      assert.ok(internal, `${listed.name} must exist in the internal registry`);
      const described = buildPublicTool(internal, { compressDescriptions: false });
      assert.equal(
        described._meta?.['worldmonitor/weight'],
        listed._meta?.['worldmonitor/weight'],
        `${listed.name} tools/list and describe_tool weight metadata`,
      );
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
