/**
 * #6113 — the chokepoint-flows dataset served the raw seeder blob on the MCP
 * surface with no FlowSource taxonomy: not discoverable (the output schema
 * declared bare `additionalProperties: {type:'object'}`) and not narrowed
 * (`toFlowSource` never ran on the cache-tool path), while the REST handler
 * both declared and enforced the closed enum since #6101.
 *
 * Option 1 from the issue — narrow AND declare in the same change, so the
 * declaration and the served bytes move together (the
 * contract-gate-field-names-miss-value-axis defect class): the tool's
 * `_postFilter` narrows `source` onto the taxonomy exactly like the REST
 * boundary does, and the schema declares the enum an agent can discover from
 * `tools/list`. Both sides import one shared taxonomy module, typed
 * exhaustively against the generated `FlowSource`, so a proto change is a
 * compile error in each consumer rather than silent drift.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';

const tool = CACHE_TOOLS.find((t) => t.name === 'get_chokepoint_status');

/** The wire taxonomy #6101 promoted (generated FlowSource union). */
const WIRE_TAXONOMY = ['FLOW_SOURCE_UNSPECIFIED', 'portwatch-dwt', 'portwatch-counts'];

function flowsData() {
  return {
    'chokepoint-flows': {
      hormuz_strait: {
        currentMbd: 2.6, baselineMbd: 21, flowRatio: 0.123, disrupted: true,
        source: 'portwatch-dwt', hazardAlertLevel: 'RED', hazardAlertName: 'HORMUZ-26',
      },
      suez: {
        currentMbd: 7.6, baselineMbd: 7.6, flowRatio: 1.001, disrupted: false,
        // An undeclared basis a newer seeder deploy could emit — the exact
        // value class the REST boundary narrows and MCP served verbatim.
        source: 'satellite-blend', hazardAlertLevel: null, hazardAlertName: null,
      },
      panama: {
        currentMbd: 1.1, baselineMbd: 1.2, flowRatio: 0.917, disrupted: false,
        source: null, hazardAlertLevel: null, hazardAlertName: null,
      },
      // The drift axis flow-source.ts names as the reason narrowing is
      // centralised: a case variant and a whitespace-padded value. Both are
      // undeclared today, and if narrowFlowSource ever learns to case-fold or
      // trim, these two assertions are what forces the REST twin to learn it in
      // the same edit instead of silently diverging.
      gibraltar: {
        currentMbd: 3, baselineMbd: 3, flowRatio: 1, disrupted: false,
        source: 'Portwatch-Dwt', hazardAlertLevel: null, hazardAlertName: null,
      },
      dover_strait: {
        currentMbd: 2, baselineMbd: 2, flowRatio: 1, disrupted: false,
        source: ' portwatch-dwt ', hazardAlertLevel: null, hazardAlertName: null,
      },
      korea_strait: {
        // `source` key absent ENTIRELY — the case the REST twin pins as
        // `korea_strait: flow(undefined)` in chokepoint-flow-source-taxonomy
        // .test.mts. REST emits FLOW_SOURCE_UNSPECIFIED for it, so MCP must
        // too; a presence guard here would serve the field missing instead.
        currentMbd: 0.4, baselineMbd: 0.4, flowRatio: 1, disrupted: false,
        hazardAlertLevel: null, hazardAlertName: null,
      },
    },
  };
}

describe('get_chokepoint_status FlowSource taxonomy (#6113)', () => {
  // Every assertion below reads the RETURNED object, because that is what
  // api/mcp/dispatch.ts serves (`result = tool._postFilter(structuredClone(
  // data), params)`), not the caller's reference.
  //
  // Honest limit on what that buys: selectDatasets shallow-copies
  // (api/mcp/filters.ts:189), so the flows map and its entries are the SAME
  // objects in both. Reading the return therefore pins the top-level shape the
  // dispatcher serves, but it canNOT distinguish "mutated in place" from
  // "rebuilt" — an entry-rebuilding refactor stays invisible either way. The
  // end-to-end block at the bottom of this file is what actually crosses the
  // structuredClone + JSON boundary; trust that one for served-bytes claims.
  it('narrows an out-of-taxonomy source to FLOW_SOURCE_UNSPECIFIED and keeps declared values verbatim', () => {
    assert.ok(tool, 'tool must exist in CACHE_TOOLS');

    const served = tool._postFilter(flowsData(), {});

    const flows = served['chokepoint-flows'];
    assert.equal(flows.hormuz_strait.source, 'portwatch-dwt', 'a declared basis passes through untouched');
    assert.equal(
      flows.suez.source, 'FLOW_SOURCE_UNSPECIFIED',
      'an undeclared seeder value must be narrowed, not served verbatim — the schema promise must be kept by the code',
    );
    assert.equal(flows.panama.source, 'FLOW_SOURCE_UNSPECIFIED', 'an explicit null basis narrows too');
    assert.equal(
      flows.korea_strait.source, 'FLOW_SOURCE_UNSPECIFIED',
      'an entry that omits `source` entirely must be narrowed, not served with the field missing — REST emits UNSPECIFIED for the same blob',
    );
    assert.equal(
      flows.gibraltar.source, 'FLOW_SOURCE_UNSPECIFIED',
      'a case variant of a declared basis is NOT a member — narrowing does not case-fold today, and REST must adopt it in the same edit if it ever does',
    );
    assert.equal(
      flows.dover_strait.source, 'FLOW_SOURCE_UNSPECIFIED',
      'a whitespace-padded declared basis is NOT a member — narrowing does not trim today',
    );
    assert.equal(flows.hormuz_strait.currentMbd, 2.6, 'narrowing must not disturb the numeric fields');
  });

  it('narrows on the filtered path too (chokepoint param applied)', () => {
    const served = tool._postFilter(flowsData(), { chokepoint: 'suez' });

    assert.deepEqual(Object.keys(served['chokepoint-flows']), ['suez']);
    assert.equal(served['chokepoint-flows'].suez.source, 'FLOW_SOURCE_UNSPECIFIED');
  });

  // `dataset` is the one argument shape where selectDatasets (api/mcp/filters
  // .ts:187-192) builds a genuinely NEW top-level object rather than returning
  // the input reference — the branch where "assert on input" and "assert on
  // return" could diverge. Nothing else in this file exercises it.
  it('narrows on the dataset-selected path, where the returned object is not the input object', () => {
    const input = flowsData();
    const served = tool._postFilter(input, { dataset: ['chokepoint-flows'] });

    assert.notEqual(served, input, 'selectDatasets must have built a new top-level object for this case');
    assert.deepEqual(Object.keys(served), ['chokepoint-flows'], 'only the requested dataset is served');
    assert.equal(served['chokepoint-flows'].suez.source, 'FLOW_SOURCE_UNSPECIFIED');
    assert.equal(served['chokepoint-flows'].korea_strait.source, 'FLOW_SOURCE_UNSPECIFIED');
  });

  it('leaves an absent or null chokepoint-flows dataset alone', () => {
    let served: Record<string, unknown> | undefined;
    assert.doesNotThrow(() => { served = tool._postFilter({ 'chokepoint-flows': null }, {}); });
    assert.equal(served!['chokepoint-flows'], null);

    assert.doesNotThrow(() => tool._postFilter({}, {}));
  });

  // The guard is `entry && typeof entry === 'object'`; the test above only
  // covers the dataset itself being null/absent. These are the per-ENTRY
  // branches — a filter throw is not loud, it is silent: dispatch.ts catches it
  // and falls back to the RAW un-narrowed blob, so a crash here would quietly
  // undo the enum guarantee rather than fail the call.
  it('tolerates null and non-object entries inside a populated map', () => {
    const data = {
      'chokepoint-flows': {
        suez: null,
        panama: 'not-an-object',
        hormuz_strait: { currentMbd: 2.6, source: 'satellite-blend' },
      },
    };

    const served = tool._postFilter(data, {});

    assert.equal(served['chokepoint-flows'].suez, null, 'a null entry is left alone, not crashed on');
    assert.equal(served['chokepoint-flows'].panama, 'not-an-object', 'a non-object entry is left alone');
    assert.equal(
      served['chokepoint-flows'].hormuz_strait.source, 'FLOW_SOURCE_UNSPECIFIED',
      'a malformed sibling must not stop the good entry from being narrowed',
    );
  });

  it('declares the closed taxonomy in the output schema an agent discovers', () => {
    const flowsSchema = tool.outputSchema.properties.data.properties['chokepoint-flows'];
    const valueSchema = flowsSchema.additionalProperties;
    assert.equal(valueSchema.type, 'object');
    assert.deepEqual(
      valueSchema.properties.source.enum, WIRE_TAXONOMY,
      'the enum an agent sees from tools/list must be the taxonomy the served bytes are narrowed onto',
    );
    // The declared value shape carries the real flow fields, not a bare
    // object — the coverage fixture stops passing trivially.
    for (const field of ['currentMbd', 'baselineMbd', 'flowRatio', 'disrupted', 'hazardAlertLevel']) {
      assert.ok(valueSchema.properties[field], `schema must declare ${field}`);
    }
  });
});

/**
 * #6113's acceptance asks for a test that "drives the MCP tool ... and asserts
 * the SERVED value is narrowed — not just that the schema validates". The block
 * above calls `_postFilter` directly, which does not cross the dispatcher: it
 * misses `structuredClone`, the fail-open try/catch, and JSON serialization.
 * This drives a real `tools/call` through api/mcp.ts and reads the bytes a
 * client actually receives, matching the bar the REST twin's own gate sets in
 * tests/chokepoint-flow-source-taxonomy.test.mts.
 */
describe('get_chokepoint_status narrows source end-to-end through tools/call (#6113)', () => {
  const VALID_KEY = 'wm_test_key_flow_source';
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  // An undeclared basis, an explicit null, and a missing key — the three
  // classes that must all reach the client as FLOW_SOURCE_UNSPECIFIED.
  const FLOWS = {
    suez: { currentMbd: 7.6, baselineMbd: 7.6, flowRatio: 1.001, disrupted: false, source: 'satellite-blend' },
    panama: { currentMbd: 1.1, baselineMbd: 1.2, flowRatio: 0.917, disrupted: false, source: null },
    korea_strait: { currentMbd: 0.4, baselineMbd: 0.4, flowRatio: 1, disrupted: false },
    hormuz_strait: { currentMbd: 2.6, baselineMbd: 21, flowRatio: 0.123, disrupted: true, source: 'portwatch-dwt' },
  };

  beforeEach(() => {
    process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    globalThis.fetch = async (url, init) => {
      const u = url.toString();
      if (u.endsWith('/pipeline')) {
        const commands = JSON.parse(init.body);
        return Response.json(commands.map(() => ({ result: 0 })));
      }
      if (u.includes(`/get/${encodeURIComponent('energy:chokepoint-flows:v1')}`)) {
        return Response.json({ result: JSON.stringify(FLOWS) });
      }
      // Every other key (the five sibling datasets and all seed-meta reads)
      // answers empty: this test is about the flows dataset only, and a stale
      // aggregate does not suppress the payload.
      return Response.json({ result: null });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const k of Object.keys(process.env)) if (!(k in originalEnv)) delete process.env[k];
    Object.assign(process.env, originalEnv);
  });

  it('serves no source value outside the declared enum', async () => {
    const mod = await import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);

    const res = await mod.default(new Request('https://worldmonitor.app/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': VALID_KEY },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'get_chokepoint_status', arguments: {} },
      }),
    }));

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result?.content, 'tools/call must return content');
    const served = JSON.parse(body.result.content[0].text).data['chokepoint-flows'];

    assert.equal(served.hormuz_strait.source, 'portwatch-dwt', 'a declared basis survives the round trip verbatim');
    for (const id of ['suez', 'panama', 'korea_strait']) {
      assert.ok(
        WIRE_TAXONOMY.includes(served[id].source),
        `${id} reached the client as "${served[id].source}", outside the enum the outputSchema advertises`,
      );
      assert.equal(served[id].source, 'FLOW_SOURCE_UNSPECIFIED');
    }
  });

  // KNOWN LIMIT, pinned rather than claimed away. api/mcp/dispatch.ts wraps
  // `_postFilter` in a try/catch that falls back to the RAW, un-narrowed `data`
  // on any non-stored-contract throw, so the closed-enum guarantee holds only
  // while the WHOLE filter body avoids throwing — not just the narrowing loop,
  // which is total over any JSON shape. The reachable trigger today is
  // pre-existing and downstream of the narrowing: narrowNested dereferences
  // `c.id` on every chokepoint-baselines row, so a null row throws once a
  // `chokepoint` argument is supplied.
  //
  // This asserts what the code ACTUALLY does, so the day someone makes the
  // enum fail closed (or the fallback stops discarding the narrowed clone),
  // this test goes red and the decision is deliberate instead of accidental.
  it('fails OPEN: a throw later in the filter serves the raw un-narrowed source', async () => {
    globalThis.fetch = async (url, init) => {
      const u = url.toString();
      if (u.endsWith('/pipeline')) {
        const commands = JSON.parse(init.body);
        return Response.json(commands.map(() => ({ result: 0 })));
      }
      if (u.includes(`/get/${encodeURIComponent('energy:chokepoint-flows:v1')}`)) {
        return Response.json({ result: JSON.stringify(FLOWS) });
      }
      // A null row makes narrowNested's `c.id` deref throw — but only once the
      // `chokepoint` argument below sends the filter down that branch.
      if (u.includes(`/get/${encodeURIComponent('energy:chokepoint-baselines:v1')}`)) {
        return Response.json({ result: JSON.stringify({ chokepoints: [null] }) });
      }
      return Response.json({ result: null });
    };

    const mod = await import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
    const res = await mod.default(new Request('https://worldmonitor.app/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': VALID_KEY },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'get_chokepoint_status', arguments: { chokepoint: 'suez' } },
      }),
    }));

    assert.equal(res.status, 200, 'the fail-open path must still answer 200, not surface the filter bug');
    const body = await res.json();
    assert.ok(body.result?.content, 'tools/call must return content on the fail-open path');
    const served = JSON.parse(body.result.content[0].text).data['chokepoint-flows'];

    assert.equal(
      served.suez.source, 'satellite-blend',
      'CURRENT behaviour: the fallback discards the narrowed clone, so an undeclared basis reaches the client verbatim despite the outputSchema advertising a closed enum. Change this assertion only alongside a deliberate decision to make the enum fail closed.',
    );
    assert.ok(
      !WIRE_TAXONOMY.includes(served.suez.source),
      'and that served value is outside the declared enum — this is the gap, stated plainly',
    );
  });
});
