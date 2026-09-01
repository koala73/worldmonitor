// Static discovery surfaces must advertise the same credential-free tool
// roster that the runtime registry authorizes. This catches server-card drift
// without creating a second hand-maintained list.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { PRODUCT_CATALOG, SHARED_API_BUDGET } from '../convex/config/productCatalog.ts';

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

    // The published daily allowance must equal the catalog budget enforcement
    // charges. Publishing 50 for the API tiers while the meter applied their
    // REST budget is what told an API Starter customer they had 1,000 MCP
    // calls/day; pin both halves so the card cannot drift from the catalog again.
    const starter = PRODUCT_CATALOG.api_starter.features.planLimits;
    const business = PRODUCT_CATALOG.api_business.features.planLimits;
    assert.equal(starter.mcpCallsPerDay, SHARED_API_BUDGET, 'API Starter shares its REST budget');
    assert.equal(business.mcpCallsPerDay, SHARED_API_BUDGET, 'API Business shares its REST budget');
    assert.equal(card.rateLimits.dailyByPlan.apiStarter, starter.apiRequestsPerDay);
    assert.equal(card.rateLimits.dailyByPlan.apiBusiness, business.apiRequestsPerDay);
    assert.equal(card.rateLimits.dailyByPlan.pro, PRODUCT_CATALOG.pro_monthly.features.planLimits.mcpCallsPerDay);
    assert.deepEqual(
      card.rateLimits.dailyBudgetSharedWithRestByPlan,
      ['apiStarter', 'apiBusiness'],
      'the card must say WHICH plans share, or 1000 reads as a separate MCP allowance',
    );
    assert.doesNotMatch(overview, /wm_….*no MCP daily reservation/i);
    // Both credential doors resolve one budget — the property KTD6 protected
    // with a hardcoded 50 and the shared budget now gives by construction.
    assert.match(overview, /Both the OAuth and `wm_…` doors resolve the same budget/i);
  });
});
