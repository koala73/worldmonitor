import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RETIRED_TOOLS, TOOL_ALIASES, TOOL_LIST_RESPONSE, TOOL_REGISTRY } from '../api/mcp/registry/index.ts';

describe('retired MCP tools', () => {
  it('lists only generate_forecasts, and that name is not registered', () => {
    assert.deepEqual(RETIRED_TOOLS.map(tool => tool.name), ['generate_forecasts']);
    const registered = new Set(TOOL_REGISTRY.map(tool => tool.name));
    assert.equal(registered.has('generate_forecasts'), false);
    assert.equal(registered.has('get_tariff_trends'), false);
  });

  it('keeps retired names and the tariff alias out of tools/list', () => {
    const listed = new Set(TOOL_LIST_RESPONSE.map(tool => tool.name));
    assert.equal(listed.has('generate_forecasts'), false);
    assert.equal(listed.has('get_tariff_trends'), false);
  });

  it('resolves generate_forecasts as a retired definition and the live forecast tool as registered', () => {
    const retired = TOOL_ALIASES.resolve('generate_forecasts', {});
    assert.equal(retired.kind, 'retired');
    if (retired.kind !== 'retired') return;
    assert.equal(retired.tool.name, 'generate_forecasts');
    const live = TOOL_ALIASES.resolve('get_forecast_predictions', {});
    assert.equal(live.kind, 'registered');
    if (live.kind !== 'registered') return;
    assert.equal(live.tool.name, 'get_forecast_predictions');
    assert.equal(TOOL_ALIASES.resolve('no_such_tool', {}).kind, 'unknown');
    assert.equal(TOOL_ALIASES.resolve('get_tariff_trends', {}).kind, 'alias');
  });

  it('keeps retired names and the tariff alias off the server card and the agent card', () => {
    const card = JSON.parse(readFileSync(new URL('../public/.well-known/mcp/server-card.json', import.meta.url), 'utf8'));
    const names = new Set(card.tools.map(tool => tool.name));
    assert.equal(names.has('generate_forecasts'), false);
    assert.equal(names.has('get_tariff_trends'), false);
    const agentCard = readFileSync(new URL('../public/.well-known/agent-card.json', import.meta.url), 'utf8');
    assert.equal(agentCard.includes('get_tariff_trends'), false);
    assert.equal(agentCard.includes('generate_forecasts'), false);
  });
});
