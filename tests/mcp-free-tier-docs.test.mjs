// Static discovery surfaces must advertise the same credential-free tool
// roster that the runtime registry authorizes. This catches server-card drift
// without creating a second hand-maintained list.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';

describe('MCP free-tier discovery parity', () => {
  it('keeps the static server-card free-access marker in parity with the registry', () => {
    const card = JSON.parse(readFileSync(
      new URL('../public/.well-known/mcp/server-card.json', import.meta.url),
      'utf8',
    ));
    const registryFreeTools = TOOL_REGISTRY
      .filter((tool) => tool._freeTier === true)
      .map((tool) => tool.name)
      .sort();
    const cardFreeTools = card.tools
      .filter((tool) => tool._meta?.['worldmonitor/access'] === 'free')
      .map((tool) => tool.name)
      .sort();

    assert.deepEqual(
      cardFreeTools,
      registryFreeTools,
      'server-card free access must derive from the same registry roster as tools/list',
    );
    assert.deepEqual(cardFreeTools, ['get_sources'], 'get_sources must remain the sole free data tool');
  });

  it('does not advertise describe_tool as anonymous', () => {
    const agentView = JSON.parse(readFileSync(
      new URL('../public/agent-view.json', import.meta.url),
      'utf8',
    ));
    const developerGuide = readFileSync(
      new URL('../public/developers/llms.txt', import.meta.url),
      'utf8',
    );

    assert.doesNotMatch(agentView.endpoints.mcp.note, /describe_tool (?:is|are) anonymous/i);
    assert.match(agentView.endpoints.mcp.note, /describe_tool.*subscription auth/i);
    assert.doesNotMatch(agentView.authentication.summary, /describe_tool.*anonymous/i);
    assert.match(developerGuide, /`describe_tool` requires subscription credentials/i);
  });

  it('keeps published dashboard-key quotas aligned with runtime enforcement', () => {
    const card = JSON.parse(readFileSync(
      new URL('../public/.well-known/mcp/server-card.json', import.meta.url),
      'utf8',
    ));
    const overview = readFileSync(
      new URL('../docs/mcp-overview.mdx', import.meta.url),
      'utf8',
    );

    assert.equal(card.rateLimits.dailyByPlan.apiStarter, 50);
    assert.equal(card.rateLimits.dailyByPlan.apiBusiness, 50);
    assert.match(card.rateLimits.notes, /Dashboard-issued wm_ API keys use the 50\/day default/i);
    assert.doesNotMatch(overview, /wm_….*no MCP daily reservation/i);
    assert.match(overview, /Dashboard-issued.*wm_….*50\/day default/i);
  });
});
