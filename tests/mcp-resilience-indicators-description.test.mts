// get_resilience_indicators states its indicator count and how many indicators
// move with current events. Both are counts over INDICATOR_REGISTRY, so adding
// an indicator or changing a cadence must fail here instead of leaving the
// tools/list text stale.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { INDICATOR_REGISTRY } from '../server/worldmonitor/resilience/v1/_indicator-registry.ts';
const { __testing__ } = await import('../api/mcp.ts');

const description: string = __testing__.TOOL_REGISTRY.find((t: { name: string }) => t.name === 'get_resilience_indicators').description;
const count = (cadences: string[]) => INDICATOR_REGISTRY.filter((i) => cadences.includes(i.cadence)).length;

describe('get_resilience_indicators description', () => {
  it('states the registered indicator count', () => {
    assert.match(description, new RegExp(`across all ${INDICATOR_REGISTRY.length} registered indicators`));
  });

  it('states how many indicators are annual and how many follow current events', () => {
    assert.match(description, new RegExp(`${count(['annual'])} indicators update annually`));
    assert.match(description, new RegExp(`${count(['realtime', 'daily'])} move with current events`));
  });
});
