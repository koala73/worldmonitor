import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RETIRED_TOOLS, TOOL_ALIASES, TOOL_LIST_RESPONSE, TOOL_REGISTRY } from '../api/mcp/registry/index.ts';

const RETIRED_NAMES = ['generate_forecasts', 'get_toronto_reported_occurrences', 'get_toronto_calls_attended'];
const ALIAS_NAMES = [
  'get_tariff_trends',
  'get_energy_storage',
  'get_internet_activity',
  'get_eu_housing_cycle',
  'get_eu_quarterly_gov_debt',
  'get_eu_industrial_production',
  'list_five_factor_scorecards',
  'search_flight_prices_by_date',
];

describe('retired MCP tools', () => {
  it('lists exactly the retired names, and none of them is registered', () => {
    assert.deepEqual(RETIRED_TOOLS.map(tool => tool.name), RETIRED_NAMES);
    const registered = new Set(TOOL_REGISTRY.map(tool => tool.name));
    for (const name of [...RETIRED_NAMES, ...ALIAS_NAMES]) assert.equal(registered.has(name), false, name);
  });

  it('keeps retired names and aliases out of tools/list', () => {
    const listed = new Set(TOOL_LIST_RESPONSE.map(tool => tool.name));
    for (const name of [...RETIRED_NAMES, ...ALIAS_NAMES]) assert.equal(listed.has(name), false, name);
  });

  it('keeps every retired name and alias callable', () => {
    for (const name of RETIRED_NAMES) assert.equal(TOOL_ALIASES.resolve(name, {}).kind, 'retired', name);
    assert.deepEqual([...TOOL_ALIASES.aliasNames()].sort(), [...ALIAS_NAMES].sort());
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

  it('keeps retired names and aliases off the server card and the agent card', () => {
    const card = JSON.parse(readFileSync(new URL('../public/.well-known/mcp/server-card.json', import.meta.url), 'utf8'));
    const names = new Set(card.tools.map(tool => tool.name));
    const agentCard = readFileSync(new URL('../public/.well-known/agent-card.json', import.meta.url), 'utf8');
    for (const name of [...RETIRED_NAMES, ...ALIAS_NAMES]) {
      assert.equal(names.has(name), false, name);
      assert.equal(agentCard.includes(name), false, name);
    }
  });
});
