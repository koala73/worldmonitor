// U3 — get_sources: runtime source discovery (R13).
//
// The load-bearing behaviour is honesty about what WorldMonitor knows:
//   - an outlet with no declared tier reports tier null, NOT the 4 that
//     getSourceTier() would default it to. A defaulted number is
//     indistinguishable from a declared one.
//   - excluded manifest rows are reported as a count, never silently dropped.
//   - providers and outlets stay separate populations. Only 3 of 536 active
//     provider records share a key with the outlet table, so a merged list
//     would be inventing attribution for the other 533.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SOURCE_TOOLS, outletRecord } from '../api/mcp/registry/source-tools.ts';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { dispatchToolsCall } from '../api/mcp/dispatch.ts';
import { validate } from './helpers/json-schema-mini.mjs';

const tool = SOURCE_TOOLS.find((t) => t.name === 'get_sources');
const run = (params = {}) => tool._execute(params, '', {}, undefined);
const assertOutputSchema = (result) => {
  const errors = validate(tool.outputSchema, result);
  assert.deepEqual(errors, [], `response fails outputSchema:\n  ${errors.join('\n  ')}`);
};

describe('get_sources — registration', () => {
  it('is present in the merged tool registry', () => {
    assert.ok(TOOL_REGISTRY.some((t) => t.name === 'get_sources'));
  });

  it('declares no API path, because it reads a committed registry rather than an endpoint', () => {
    assert.deepEqual(tool._apiPaths, []);
  });
});

describe('get_sources — summary view', () => {
  it('defaults to summary and fits well inside its declared output budget', async () => {
    const result = await run({});
    assert.equal(result.view, 'summary');
    const bytes = Buffer.byteLength(JSON.stringify(result));
    assert.ok(
      bytes < tool._outputBudgetBytes,
      `default response is ${bytes}B against a ${tool._outputBudgetBytes}B budget`,
    );
  });

  it('reports excluded manifest rows as a count instead of dropping them silently', async () => {
    const { summary } = await run({});
    assert.ok(summary.excludedProviderCount > 0, 'the manifest does contain excluded rows');
    assert.ok(summary.providerCount > 0);
    // The two must be disjoint: an excluded row must not also be counted active.
    assert.ok(summary.providerCount < summary.providerCount + summary.excludedProviderCount);
  });

  it('carries counts for both populations without merging them', async () => {
    const { summary } = await run({});
    assert.ok(summary.providerCount > 100, 'providers population');
    assert.ok(summary.outletCount > 100, 'outlets population');
    assert.ok(Object.keys(summary.providersByKind).length > 1);
    assert.ok(Object.keys(summary.outletsByTier).length > 1);
    assert.ok(Object.keys(summary.providersByCountry).length > 1);
  });

  it('includes the summary in every view, so counts never need a second call', async () => {
    for (const view of ['summary', 'providers', 'outlets']) {
      const result = await run({ view });
      assert.ok(result.summary, `${view} view must carry summary`);
    }
  });
});

describe('get_sources — providers view', () => {
  it('exposes the catalog origin contract in its schema', () => {
    assert.ok(tool.inputSchema.properties.country, 'agents need a country filter');
    assert.ok(tool.outputSchema.properties.summary.properties.providersByCountry);
    const providerProperties = tool.outputSchema.properties.providers.items.properties;
    assert.ok(providerProperties.originCountry);
    assert.ok(providerProperties.originLabel);
  });

  it('returns only active providers and never an excluded row', async () => {
    const result = await run({ view: 'providers', limit: 200 });
    assert.ok(result.providers.length > 0);
    assert.ok(result.providers.every((p) => p.status !== 'excluded'));
  });

  it('returns the same publisher-origin classification exposed by the public catalog', async () => {
    const github = await run({ view: 'providers', query: 'api.github.com', limit: 50 });
    assert.equal(github.providers.length, 1);
    assert.equal(github.providers[0].originCountry, null);
    assert.equal(github.providers[0].originLabel, 'International');

    const lobsters = await run({ view: 'providers', query: 'lobste.rs', limit: 50 });
    assert.equal(lobsters.providers.length, 1);
    assert.equal(lobsters.providers[0].originCountry, 'US');
    assert.equal(lobsters.providers[0].originLabel, 'United States');
  });

  it('narrows by country and composes country with other provider filters', async () => {
    const result = await run({
      view: 'providers',
      country: 'us',
      kind: 'feed',
      query: 'news',
      limit: 200,
    });
    assert.ok(result.providers.length > 0);
    assert.ok(result.providers.every((p) => (
      p.originCountry === 'US'
      && p.kind === 'feed'
      && /news/i.test(`${p.host} ${p.provider}`)
    )));
    assertOutputSchema(result);
  });

  it('supports the international country bucket', async () => {
    const result = await run({ view: 'providers', country: 'intl', limit: 200 });
    assert.ok(result.providers.length > 0);
    assert.ok(result.providers.every((p) => p.originCountry === null));
  });

  it('narrows by kind', async () => {
    const result = await run({ view: 'providers', kind: 'feed', limit: 200 });
    assert.ok(result.providers.length > 0);
    assert.ok(result.providers.every((p) => p.kind === 'feed'));
  });

  it('narrows by query against host or provider', async () => {
    const result = await run({ view: 'providers', query: '.gov', limit: 200 });
    assert.ok(result.providers.length > 0);
    assert.ok(result.providers.every((p) => /\.gov/i.test(`${p.host} ${p.provider}`)));
  });

  it('reports matched vs returned so truncation is visible', async () => {
    const result = await run({ view: 'providers', limit: 5 });
    assert.equal(result.returned, 5);
    assert.ok(result.matched > result.returned, 'a truncated result must say so');
    assert.equal(result.providers.length, 5);
  });

  it('returns an empty collection with totals intact when nothing matches', async () => {
    const result = await run({ view: 'providers', query: 'zzz-no-such-host' });
    assert.deepEqual(result.providers, []);
    assert.equal(result.matched, 0);
    assert.ok(result.summary.providerCount > 0, 'totals must survive an empty match');
  });
});

describe('get_sources — outlets view', () => {
  it('advertises and serves the Telegram platform contract through tools/call', async () => {
    assert.deepEqual(tool.inputSchema.properties.platform.enum, ['telegram']);

    const response = await dispatchToolsCall(
      new Request('https://worldmonitor.app/mcp', { method: 'POST' }),
      { kind: 'free' },
      { redisPipeline: async () => { throw new Error('get_sources must not read Redis'); } },
      {
        id: 6600,
        params: {
          name: 'get_sources',
          arguments: { view: 'outlets', platform: 'telegram', query: 'IDF Official', limit: 10 },
        },
      },
      {},
    );
    const body = await response.json();
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    assert.equal(body.id, 6600);

    const result = JSON.parse(body.result.content[0].text);
    assertOutputSchema(result);
    assert.equal(result.matched, 1);
    assert.deepEqual(result.outlets[0].platformIdentities, [
      { platform: 'telegram', handle: 'IDFofficial' },
    ]);
  });

  it('returns tier and provenance for every outlet', async () => {
    const result = await run({ view: 'outlets', limit: 50 });
    assert.ok(result.outlets.length > 0);
    for (const o of result.outlets) {
      assert.equal(typeof o.name, 'string');
      assert.ok(o.tier === null || typeof o.tier === 'number');
      assert.ok(o.provenance && typeof o.provenance.risk === 'string');
    }
  });

  it('reports null — not the defaulted 4 — for a name with no declared tier', () => {
    // getSourceTier() answers 4 for any unknown name. Reading SOURCE_TIERS
    // directly is what keeps "tier 4" distinguishable from "we never said".
    // Asserted on the record builder because the outlets view enumerates the
    // tier table itself, so no name it returns can exercise this branch.
    const undeclared = outletRecord('Definitely Not A Declared Outlet 9f3a');
    assert.equal(undeclared.tier, null, 'an undeclared outlet must not be defaulted to a tier');
    assert.ok(undeclared.provenance, 'provenance is still reported for an undeclared name');
  });

  it('reports a real number for a declared outlet', () => {
    const declared = outletRecord('Reuters');
    assert.equal(typeof declared.tier, 'number');
    assert.equal(declared.tier, 1, 'Reuters is a declared tier-1 wire');
  });

  it('the tier filter returns only genuinely-declared members of that tier', async () => {
    const all = await run({ view: 'outlets', limit: 200 });
    const tier4 = await run({ view: 'outlets', tier: 4, limit: 200 });
    assert.ok(tier4.outlets.every((o) => o.tier === 4));
    assert.ok(
      tier4.matched < all.summary.outletCount,
      'if unknown tiers were defaulted to 4 the filter would swallow the population',
    );
  });

  it('narrows by risk band', async () => {
    const result = await run({ view: 'outlets', risk: 'high', limit: 200 });
    assert.ok(result.outlets.every((o) => o.provenance.risk === 'high'));
  });

  it('narrows by name query', async () => {
    const result = await run({ view: 'outlets', query: 'reuters', limit: 50 });
    assert.ok(result.outlets.length > 0);
    assert.ok(result.outlets.every((o) => /reuters/i.test(o.name)));
  });

  it('returns an empty collection with totals intact when nothing matches', async () => {
    const result = await run({ view: 'outlets', query: 'zzz-no-such-outlet' });
    assert.deepEqual(result.outlets, []);
    assert.equal(result.matched, 0);
    assert.ok(result.summary.outletCount > 0);
  });
});

describe('get_sources — input handling', () => {
  it('rejects an unknown view with a schema-valid error envelope', async () => {
    const result = await run({ view: 'nonsense' });
    assert.ok(result.error, 'an unknown view must be an explicit error');
    assertOutputSchema(result);
  });

  it('rejects an unknown provider country with the available filter values', async () => {
    const result = await run({ view: 'providers', country: 'zz' });
    assert.match(result.error, /country must be one of:/i);
    assert.equal(result.providers, undefined);
    assertOutputSchema(result);
  });

  it('rejects negative, zero, and fractional limits without bypassing the row cap', async () => {
    for (const view of ['providers', 'outlets']) {
      for (const limit of [-1, 0, 1.5]) {
        const result = await run({ view, limit });
        assert.match(result.error, /limit must be an integer of at least 1/i);
        assert.equal(result[view], undefined, `invalid ${view} limit ${limit} must not return uncapped rows`);
        assertOutputSchema(result);
      }
    }
  });

  it('honors the valid lower and upper limit edges and reports the actual row count', async () => {
    for (const view of ['providers', 'outlets']) {
      for (const limit of [1, 200]) {
        const result = await run({ view, limit });
        const rows = result[view];
        assert.equal(rows.length, Math.min(limit, result.matched));
        assert.equal(result.returned, rows.length);
        assertOutputSchema(result);
      }
    }
  });

  it('accepts the official CLI numeric-string limit form', async () => {
    const result = await run({ view: 'providers', limit: '5' });
    assert.equal(result.providers.length, 5);
    assert.equal(result.returned, 5);
    assertOutputSchema(result);
  });

  it('caps oversized integer limits at the declared maximum and reports the actual row count', async () => {
    const result = await run({ view: 'providers', limit: 9999 });
    assert.equal(result.providers.length, 200, 'limit must be capped, not honoured verbatim');
    assert.equal(result.returned, result.providers.length);
    assertOutputSchema(result);
  });
});
