// A retired tool leaves every published surface (tools/list, describe_tool,
// the server card, docs) but stays callable under its old name, so a client
// that hard-coded it keeps working. generate_forecasts was retired because it
// read the same published list as get_forecast_predictions while its name
// claimed it started a forecast run. A renamed tool keeps its old name the
// same way, as an alias of the renamed definition: get_tariff_trends carried
// no tariff data and is now get_price_and_debt_indicators.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RETIRED_TOOLS, TOOL_LIST_RESPONSE, TOOL_REGISTRY, findCallableTool } from '../api/mcp/registry/index.ts';

const RETIRED = ['generate_forecasts', 'get_tariff_trends'];

describe('retired MCP tools', () => {
  it('lists exactly the retired names, none of them registered', () => {
    assert.deepEqual(RETIRED_TOOLS.map(tool => tool.name), RETIRED);
    const registered = new Set(TOOL_REGISTRY.map(tool => tool.name));
    for (const name of RETIRED) assert.equal(registered.has(name), false, `${name} must not be in TOOL_REGISTRY`);
  });

  it('keeps retired tools out of tools/list', () => {
    const listed = new Set(TOOL_LIST_RESPONSE.map(tool => tool.name));
    for (const name of RETIRED) assert.equal(listed.has(name), false, `${name} must not be listed`);
  });

  it('still resolves a retired name for tools/call', () => {
    for (const name of RETIRED) assert.equal(findCallableTool(name)?.name, name);
    assert.equal(findCallableTool('get_forecast_predictions')?.name, 'get_forecast_predictions');
    assert.equal(findCallableTool('no_such_tool'), undefined);
  });

  it('keeps retired tools off the server card', () => {
    const card = JSON.parse(readFileSync(new URL('../public/.well-known/mcp/server-card.json', import.meta.url), 'utf8'));
    const names = new Set(card.tools.map(tool => tool.name));
    for (const name of RETIRED) assert.equal(names.has(name), false, `${name} must not be on the server card`);
  });

  it('serves a renamed tool under its old name with the new definition', () => {
    const current = TOOL_REGISTRY.find(tool => tool.name === 'get_price_and_debt_indicators');
    assert.ok(current, 'get_price_and_debt_indicators must be registered');
    const alias = findCallableTool('get_tariff_trends');
    assert.equal(alias.name, 'get_tariff_trends');
    assert.equal(alias.inputSchema, current.inputSchema);
    assert.equal(alias._postFilter, current._postFilter);
    assert.deepEqual(alias._cacheKeys, current._cacheKeys);
    assert.deepEqual(alias._freshnessChecks, current._freshnessChecks);
  });
});
