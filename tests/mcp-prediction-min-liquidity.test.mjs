import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';

const tool = TOOL_REGISTRY.find((entry) => entry.name === 'get_prediction_markets');

function payload() {
  return {
    'markets-bootstrap': {
      geopolitical: [
        { title: 'deep', liquidity: 250000, source: 'polymarket' },
        { title: 'thin', liquidity: 900, source: 'polymarket' },
        { title: 'unreported', source: 'kalshi' },
        { title: 'exact', liquidity: 5000, source: 'polymarket' },
      ],
      tech: [{ title: 'tech thin', liquidity: 10 }],
      finance: [{ title: 'finance deep', liquidity: 80000 }, { title: 'finance unreported' }],
    },
  };
}

function titles(data, bucket) {
  return data['markets-bootstrap'][bucket].map((market) => market.title);
}

describe('get_prediction_markets min_liquidity', () => {
  it('declares liquidity on every bucket item and a non-negative min_liquidity argument', () => {
    assert.ok(tool, 'get_prediction_markets must be registered');
    assert.equal(tool.inputSchema.properties.min_liquidity.type, 'number');
    assert.equal(tool.inputSchema.properties.min_liquidity.minimum, 0);
    assert.match(tool.inputSchema.properties.min_liquidity.description, /without[^.]*liquidity[^.]*dropped/i);
    const buckets = tool.outputSchema.properties.data.properties['markets-bootstrap'].properties;
    for (const bucket of ['geopolitical', 'tech', 'finance']) {
      assert.equal(buckets[bucket].items.properties.liquidity.type, 'number', `${bucket} items omit liquidity`);
    }
  });

  it('keeps markets at or above the threshold and drops markets without a liquidity value', () => {
    const filtered = tool._postFilter(payload(), { min_liquidity: 5000 });
    assert.deepEqual(titles(filtered, 'geopolitical'), ['deep', 'exact']);
    assert.deepEqual(titles(filtered, 'tech'), []);
    assert.deepEqual(titles(filtered, 'finance'), ['finance deep']);
  });

  it('applies the threshold before limit so thin markets do not consume the cap', () => {
    const filtered = tool._postFilter(payload(), { min_liquidity: '1000', limit: 2 });
    assert.deepEqual(titles(filtered, 'geopolitical'), ['deep', 'exact']);
  });

  it('leaves every market in place when min_liquidity is omitted or zero', () => {
    for (const params of [{}, { min_liquidity: 0 }]) {
      const filtered = tool._postFilter(payload(), params);
      assert.equal(filtered['markets-bootstrap'].geopolitical.length, 4);
      assert.equal(filtered['markets-bootstrap'].finance.length, 2);
    }
  });
});
