// Drift guard named by api/mcp/types.ts::_weight.
//
// The shared API-tier budget charges 1 for a cache read, 2 for one downstream
// fetch, and 1 + N when an `_execute` body fetches N times. The class default
// in `toolWeight` covers the first two; the two tools that fetch twice must
// publish `_weight`. A later direct second fetch that forgets the override
// would keep billing 2 while every named-example test stayed green.
//
// This file re-derives fan-out from each execution function so that cannot
// happen silently.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { TOOL_REGISTRY, toolWeight } from '../api/mcp/registry/index.ts';

/**
 * Direct authenticated downstream fan-out of one `_execute` body.
 *
 * Counts `fetch(` in the function itself, not helpers it calls. A fetch
 * counts only when the same function also signs via `buildAuthHeaders` —
 * after tsx that is `(0, import_auth.buildAuthHeaders)(...)`.
 *
 * Published weight is `1 + fan-out` (the MCP call plus each signed fetch),
 * so a second fetch must set `_weight: 3`.
 */
function directAuthenticatedFanOut(execute) {
  const src = Function.prototype.toString.call(execute);
  if (!src.includes('buildAuthHeaders')) return 0;
  return (src.match(/\bfetch\s*\(/g) ?? []).length;
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value >= 1;
}

describe('fan-out matcher', () => {
  it('counts each fetch in a function that also signs', () => {
    const buildAuthHeaders = () => ({});
    async function twoFetches() {
      await buildAuthHeaders();
      await fetch('https://example.test/a');
      await fetch('https://example.test/b');
    }
    assert.equal(directAuthenticatedFanOut(twoFetches), 2);
  });

  it('ignores fetch in a function that never signs', () => {
    async function unsigned() {
      await fetch('https://example.test/a');
      await fetch('https://example.test/b');
    }
    assert.equal(directAuthenticatedFanOut(unsigned), 0);
  });
});

describe('toolWeight class defaults', () => {
  it('a cache tool (no _execute) charges 1', () => {
    assert.equal(toolWeight({ name: 'cache_example' }), 1);
  });

  it('an execution tool charges 2', () => {
    assert.equal(toolWeight({ name: 'rpc_example', _execute: async () => ({}) }), 2);
  });

  it('an explicit _weight overrides the class default', () => {
    assert.equal(toolWeight({ name: 'cache_override', _weight: 4 }), 4);
    assert.equal(
      toolWeight({ name: 'rpc_override', _execute: async () => ({}), _weight: 3 }),
      3,
    );
  });
});

describe('registry class defaults match the published table', () => {
  const cacheTools = TOOL_REGISTRY.filter((tool) => typeof tool._execute !== 'function');
  const executeTools = TOOL_REGISTRY.filter((tool) => typeof tool._execute === 'function');

  it('every cache tool without an override bills 1', () => {
    assert.ok(cacheTools.length >= 20, 'cache-tool floor: the catalog did not vanish');
    for (const tool of cacheTools) {
      if (tool._weight !== undefined) continue;
      assert.equal(toolWeight(tool), 1, `${tool.name} is a cache read and must bill 1`);
    }
  });

  it('every execution tool without an override bills 2', () => {
    assert.ok(executeTools.length >= 20, 'execution-tool floor: the catalog did not vanish');
    for (const tool of executeTools) {
      if (tool._weight !== undefined) continue;
      assert.equal(toolWeight(tool), 2, `${tool.name} is an _execute tool and must bill 2`);
    }
  });
});

describe('explicit _weight values', () => {
  it('every published override is a positive integer matching 1 + derived fan-out', () => {
    const overrides = TOOL_REGISTRY.filter((tool) => tool._weight !== undefined);
    assert.ok(
      overrides.length >= 2,
      'the two double-fetch tools must keep publishing _weight; do not delete the overrides to silence this',
    );
    for (const tool of overrides) {
      assert.ok(
        isPositiveInt(tool._weight),
        `${tool.name}._weight must be a positive integer, got ${JSON.stringify(tool._weight)}`,
      );
      assert.equal(
        typeof tool._execute,
        'function',
        `${tool.name} publishes _weight but has no _execute — cache tools use the class default`,
      );
      const fanOut = directAuthenticatedFanOut(tool._execute);
      assert.equal(
        tool._weight,
        1 + fanOut,
        `${tool.name}._weight is ${tool._weight} but its _execute signs ${fanOut} fetch(es); ` +
          'the override must be 1 + that fan-out',
      );
      assert.equal(toolWeight(tool), tool._weight);
    }
  });
});

describe('derived downstream fan-out', () => {
  it('a second authenticated fetch in _execute requires the matching weight override', () => {
    const multiFetch = [];
    for (const tool of TOOL_REGISTRY) {
      if (typeof tool._execute !== 'function') continue;
      const fanOut = directAuthenticatedFanOut(tool._execute);
      if (fanOut < 2) continue;
      multiFetch.push({ name: tool.name, fanOut, weight: tool._weight });
      assert.ok(
        isPositiveInt(tool._weight),
        `${tool.name} fetches ${fanOut} times but has no _weight override — ` +
          `it would bill ${toolWeight(tool)} instead of ${1 + fanOut}`,
      );
      assert.equal(
        tool._weight,
        1 + fanOut,
        `${tool.name} fetches ${fanOut} times so _weight must be ${1 + fanOut}`,
      );
      assert.equal(toolWeight(tool), 1 + fanOut);
    }
    assert.ok(
      multiFetch.length >= 2,
      `expected get_country_brief and get_airspace to derive as multi-fetch, found ${JSON.stringify(multiFetch)}`,
    );
    assert.deepEqual(
      multiFetch.map((row) => row.name).sort(),
      ['get_airspace', 'get_country_brief'],
      'the multi-fetch set drifted — add the new tool\'s _weight or fix the fan-out matcher',
    );
  });
});
