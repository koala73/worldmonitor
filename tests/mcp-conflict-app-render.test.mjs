import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { Ratelimit } from '@upstash/ratelimit';
import { makeProDeps, proReq, callBody, HMAC_SECRET } from './helpers/mcp-pro-deps.mjs';
import { CONFLICT_EVENTS_APP_HTML } from '../api/mcp/ui/conflict-events-app.ts';

const originalFetch = globalThis.fetch;
const originalLimiter = Ratelimit.slidingWindow;
const originalEnv = { ...process.env };
const attemptedNetwork = [];
const fixtureReads = [];
const limiterCalls = [];
const fetchedAt = Date.parse('2026-10-03T16:00:00Z');
const sourceOriginal = 'Controlled UCDP cited publisher';
const events = Array.from({ length: 8 }, (_, i) => ({
  id: 'controlled-' + i,
  sideA: 'Controlled side A ' + (i + 1), sideB: 'Controlled side B',
  violenceType: 'UCDP_VIOLENCE_TYPE_STATE_BASED', country: 'Controlled country',
  deathsBest: i === 0 ? undefined : i === 1 ? 0 : i * 10,
  dateStart: i === 0 ? 'unknown' : '2026-10-02T12:00:00Z',
  sourceOriginal,
}));
const twentyEvents = Array.from({ length: 20 }, (_, eventIndex) => ({ ...events[2], id: 'twenty-' + eventIndex, sideA: 'Twenty event ' + eventIndex }));
const largeEvents = Array.from({ length: 160 }, (_, i) => ({
  ...events[2], id: 'large-' + i, sideA: 'Large event ' + i + ' ' + 'x'.repeat(1500),
}));
let activeEvents = events;
let missingUcdp = false;
let missingUcdpMeta = false;
let payloadAnnualFailedPages;
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
let handler;
before(async () => {
process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
process.env.MCP_TELEMETRY = 'false';
process.env.UPSTASH_REDIS_REST_URL = 'https://fixture-only.upstash.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-only-no-credential';
delete process.env.LOCAL_API_MODE;
delete process.env.VERCEL_ENV;
delete process.env.AXIOM_TOKEN;
delete process.env.AXIOM_DATASET;
Ratelimit.slidingWindow = (tokens, window) => () => ({
  async limit(_ctx, key) {
    limiterCalls.push({ tokens, window, key });
    return { success: true, limit: tokens, remaining: tokens - 1, reset: Date.now() + 60000, pending: Promise.resolve() };
  },
});
globalThis.fetch = async (url, opts) => {
  const address = new URL(String(url));
  if (address.origin !== 'https://fixture-only.upstash.invalid' || !address.pathname.startsWith('/get/')) {
    attemptedNetwork.push({ url: String(url), method: opts?.method || 'GET' });
    throw new Error('Unexpected network call');
  }
  const key = decodeURIComponent(address.pathname.slice(5));
  fixtureReads.push(key);
  let value = null;
  if (key === 'conflict:ucdp-events:v1') value = missingUcdp ? null : { events: activeEvents, fetchedAt, version: 'controlled', candidateVersion: 'controlled+partial', candidateComplete: false, ...(payloadAnnualFailedPages === undefined ? {} : { annualFailedPages: payloadAnnualFailedPages }) };
  else if (key === 'unrest:events:v1') value = { events: [] };
  else if (key === 'risk:scores:sebuf:stale:v8') value = { ciiScores: [] };
  else if (key === 'conflict:iran-events:v1') value = { events: [] };
  else if (key === 'seed-meta:conflict:ucdp-events') value = missingUcdpMeta ? null : { fetchedAt, recordCount: activeEvents.length, candidateVersion: 'controlled+partial', candidateComplete: false, annualFailedPages: 2 };
  else if (key === 'seed-meta:unrest:events') value = { fetchedAt, recordCount: activeEvents.length };
  else throw new Error('Unexpected fixture key ' + key);
  return json({ result: value === null ? null : JSON.stringify(value) });
};
  ({ mcpHandler: handler } = await import('../api/mcp.ts'));
});
after(() => {
  globalThis.fetch = originalFetch;
  Ratelimit.slidingWindow = originalLimiter;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  assert.deepEqual(attemptedNetwork, []);
});

async function result(args = {}, state = 'normal') {
  activeEvents = state === 'large' ? largeEvents : state === 'twenty' ? twentyEvents : state === 'empty' ? [] : events;
  missingUcdp = state === 'missing';
  missingUcdpMeta = state === 'metadata-missing';
  payloadAnnualFailedPages = missingUcdpMeta ? 5 : undefined;
  const { deps } = makeProDeps();
  const response = await handler(proReq('POST', callBody('get_conflict_events', args)), deps);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.result.isError, undefined);
  return body.result;
}
async function mount(wire, check) {
  const win = new Window({ url: 'https://worldmonitor.app/' });
  try {
    win.document.write(CONFLICT_EVENTS_APP_HTML);
    win.eval(win.document.querySelector('script').textContent);
    const messages = [];
    win.eval('window.parent').postMessage = message => messages.push(message);
    let reads = 0;
    win.fetch = async () => { reads++; throw new Error('Unexpected browser read'); };
    const send = async value => {
      win.dispatchEvent(new win.MessageEvent('message', {
        source: win.eval('window.parent'),
        data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { result: value } },
      }));
      await win.happyDOM.waitUntilComplete();
    };
    await send(wire);
    await check(win.document, send);
    assert.equal(reads, 0);
    assert.equal(messages.filter(m => ['tools/call', 'ui/call-tool'].includes(m?.method)).length, 0);
  } finally { await win.happyDOM.close(); }
}

describe('Conflict Events actual-handler supported envelopes', () => {
  for (const [name, args, count] of [
    ['full', {}, 8], ['summary', { summary: true }, 3],
    ['whole-envelope projection', { jmespath: '@' }, 8],
    ['summary whole-envelope projection', { summary: true, jmespath: '@' }, 3],
  ]) {
    it(name + ' preserves supplied events and selected-envelope snapshot metadata', async () => {
      const wire = await result(args);
      await mount(wire, doc => {
        const rows = doc.querySelectorAll('.evt');
        assert.equal(rows.length, count);
        assert.match(rows[0].textContent, /Controlled side A 1/);
        assert.equal(rows[0].querySelector('.evt-deaths'), null);
        assert.doesNotMatch(rows[0].textContent, /unknown|Invalid Date/);
        assert.equal(rows[1].querySelector('.evt-deaths').textContent, '0 deaths');
        assert.match(rows[1].textContent, /Controlled country.*State-based.*2026-10-02/);
        assert.match(doc.getElementById('foot').textContent, /Snapshot: 2026-10-03T16:00:00.000Z \(stale\)/);
      });
    });
  }
  it('does not invent events from an arbitrary side-name projection', async () => {
    const wire = await result({ jmespath: 'data."ucdp-events".events[].sideA' });
    await mount(wire, doc => {
      assert.equal(doc.querySelectorAll('.evt').length, 0);
      assert.match(doc.getElementById('list').textContent, /temporarily unavailable/);
      assert.equal(doc.getElementById('foot').textContent, '');
    });
  });
  it('keeps the byte-fitted full list partial and the existing 14-row display cap', async () => {
    const wire = await result({ limit: 0 }, 'large');
    const data = wire.structuredContent.data;
    assert.ok(Buffer.byteLength(wire.content[0].text) <= 131072);
    assert.equal(data.partial, true);
    await mount(wire, doc => {
      assert.equal(doc.querySelectorAll('.evt').length, 14);
      assert.ok(doc.getElementById('foot').textContent.includes('Source response includes ' + data.truncation.returned_event_count + ' of 160 events (output limit).'));
      assert.match(doc.getElementById('foot').textContent, /\(stale\)/);
    });
  });
  it('keeps an authoritative empty projected list distinct from a missing source', async () => {
    const wire = await result({ jmespath: '@' }, 'empty');
    await mount(wire, doc => {
      assert.equal(doc.querySelectorAll('.evt').length, 0);
      assert.equal(doc.getElementById('list').textContent, 'No conflict events available.');
    });
  });
  it('replaces loaded rows with a later missing-source result', async () => {
    const full = await result({ jmespath: '@' });
    const missing = await result({}, 'missing');
    await mount(full, async (doc, send) => {
      assert.equal(doc.querySelectorAll('.evt').length, 8);
      await send(missing);
      assert.equal(doc.querySelectorAll('.evt').length, 0);
      assert.match(doc.getElementById('list').textContent, /temporarily unavailable/);
      assert.doesNotMatch(doc.getElementById('list').textContent, /No conflict events available/);
    });
  });
});


describe('Conflict Events supplied coverage and attribution', () => {
  for (const [name, args, shown, countText] of [
    ['full', { limit: 0 }, 14, 'Showing 14 of 20 loaded UCDP events.'],
    ['summary', { limit: 0, summary: true }, 3, 'Summary sample: 3 of 20 UCDP events.'],
    ['projected', { limit: 0, jmespath: '@' }, 14, 'Showing 14 of 20 loaded UCDP events.'],
    ['projected summary', { limit: 0, summary: true, jmespath: '@' }, 3, 'Summary sample: 3 of 20 UCDP events.'],
  ]) {
    it(name + ' preserves coverage, loaded counts and each original publisher', async () => {
      const wire = await result(args, 'twenty');
      const envelope = wire.structuredContent.projection || wire.structuredContent;
      assert.equal(envelope.conflict_source.ucdp.candidateComplete, false);
      assert.equal(envelope.conflict_source.ucdp.annualFailedPages, 2);
      await mount(wire, doc => {
        assert.equal(doc.querySelectorAll('.evt').length, shown);
        assert.ok(doc.getElementById('foot').textContent.includes(countText));
        assert.match(doc.getElementById('foot').textContent, /Candidate completeness not confirmed/);
        assert.match(doc.getElementById('foot').textContent, /Candidate release fetched partially/);
        assert.match(doc.getElementById('foot').textContent, /Annual base pages failed: 2/);
        for (const row of doc.querySelectorAll('.evt')) assert.ok(row.textContent.includes(sourceOriginal));
      });
    });
  }
  it('retains a known payload failed-page count through the real relay when metadata is missing', async () => {
    for (const args of [{}, { summary: true }, { jmespath: '@' }]) {
      const wire = await result(args, 'metadata-missing');
      const envelope = wire.structuredContent.projection || wire.structuredContent;
      assert.equal(envelope.data['ucdp-events'].annualFailedPages, 5);
      assert.notEqual(envelope.conflict_source.ucdp.annualFailedPages, 5);
      await mount(wire, doc => {
        assert.match(doc.getElementById('foot').textContent, /Annual base pages failed: 5/);
        assert.doesNotMatch(doc.getElementById('foot').textContent, /failed-page count unknown/);
      });
    }
  });
  it('keeps both valid failure counts visible when metadata and payload disagree', async () => {
    for (const [metadataCount, payloadCount] of [[0, 5], [5, 0], [2, 5]]) {
      const wire = await result();
      wire.structuredContent.conflict_source.ucdp.annualFailedPages = metadataCount;
      wire.structuredContent.data['ucdp-events'].annualFailedPages = payloadCount;
      await mount(wire, doc => {
        const text = doc.getElementById('foot').textContent;
        assert.match(text, /Annual base failed-page counts disagree/);
        assert.ok(text.includes('source metadata ' + metadataCount));
        assert.ok(text.includes('events payload ' + payloadCount));
      });
    }
  });
  it('uses only valid failure counts and preserves an agreed zero', async () => {
    const wire = await result();
    for (const [metadataCount, payloadCount, expected] of [[null, 5, 5], ['2', 5, 5], [2, -1, 2], [0, 0, 0], [2, 2, 2]]) {
      wire.structuredContent.conflict_source.ucdp.annualFailedPages = metadataCount;
      wire.structuredContent.data['ucdp-events'].annualFailedPages = payloadCount;
      await mount(wire, doc => {
        assert.ok(doc.getElementById('foot').textContent.includes('Annual base pages failed: ' + expected));
        assert.doesNotMatch(doc.getElementById('foot').textContent, /disagree|count unknown/);
      });
    }
  });
  it('allows literal long publisher tokens to wrap within the attribution row', async () => {
    const wire = await result();
    const publisher = 'publisher'.repeat(60);
    wire.structuredContent.data['ucdp-events'].events[0].sourceOriginal = publisher;
    await mount(wire, doc => {
      const attribution = [...doc.querySelectorAll('.evt-meta')].find(node => node.textContent === 'Source: ' + publisher);
      assert.ok(attribution);
      assert.equal(doc.defaultView.getComputedStyle(attribution).overflowWrap, 'anywhere');
    });
  });
  it('does not call an unfetched candidate partial and does not claim unknown metadata complete', async () => {
    const wire = await result();
    const envelope = wire.structuredContent;
    envelope.conflict_source = { ucdp: { candidateComplete: false, candidateVersion: null, annualFailedPages: 0 } };
    envelope.data['ucdp-events'].candidateVersion = null;
    await mount(wire, async (doc, send) => {
      assert.match(doc.getElementById('foot').textContent, /Candidate completeness not confirmed/);
      assert.doesNotMatch(doc.getElementById('foot').textContent, /fetched partially/);
      delete envelope.conflict_source;
      delete envelope.data['ucdp-events'].candidateComplete;
      await send(wire);
      assert.match(doc.getElementById('foot').textContent, /Candidate completeness unknown/);
      assert.match(doc.getElementById('foot').textContent, /Annual base failed-page count unknown/);
      assert.doesNotMatch(doc.getElementById('foot').textContent, /completeness confirmed|fetched partially/);
    });
  });
  it('keeps an explicit incomplete flag when supplied metadata conflicts', async () => {
    const wire = await result();
    const envelope = wire.structuredContent;
    for (const [source, payload] of [[true, false], [false, true]]) {
      envelope.conflict_source = { ucdp: { candidateComplete: source, candidateVersion: 'controlled', annualFailedPages: 0 } };
      envelope.data['ucdp-events'].candidateComplete = payload;
      envelope.data['ucdp-events'].candidateVersion = 'controlled';
      await mount(wire, doc => {
        assert.match(doc.getElementById('foot').textContent, /Candidate completeness not confirmed/);
        assert.doesNotMatch(doc.getElementById('foot').textContent, /completeness confirmed|fetched partially/);
      });
    }
    envelope.conflict_source.ucdp.candidateComplete = true;
    envelope.data['ucdp-events'].candidateComplete = true;
    await mount(wire, doc => {
      assert.match(doc.getElementById('foot').textContent, /Candidate completeness confirmed/);
      assert.match(doc.getElementById('foot').textContent, /Annual base pages failed: 0/);
      assert.doesNotMatch(doc.getElementById('foot').textContent, /not confirmed|fetched partially/);
    });
  });
  it('does not confirm completeness when a supplied version explicitly says partial', async () => {
    const wire = await result();
    wire.structuredContent.conflict_source = { ucdp: { candidateComplete: true, candidateVersion: 'controlled+partial', annualFailedPages: 0 } };
    wire.structuredContent.data['ucdp-events'].candidateComplete = true;
    await mount(wire, doc => {
      assert.match(doc.getElementById('foot').textContent, /Candidate completeness not confirmed/);
      assert.match(doc.getElementById('foot').textContent, /Candidate release fetched partially/);
      assert.doesNotMatch(doc.getElementById('foot').textContent, /completeness confirmed/);
    });
  });
  it('shows authoritative zero counts for empty full and summary lists', async () => {
    for (const args of [{}, { summary: true }]) {
      const wire = await result(args, 'empty');
      await mount(wire, doc => {
        assert.equal(doc.getElementById('list').textContent, 'No conflict events available.');
        assert.match(doc.getElementById('foot').textContent, /(?:Showing|Summary sample:) 0 of 0/);
      });
    }
  });
  it('renders publisher markup as literal text and omits absent publishers', async () => {
    const wire = await result();
    const rows = wire.structuredContent.data['ucdp-events'].events;
    const hostile = '<img src=x onerror="alert(1)"> original publisher';
    rows[0].sourceOriginal = hostile;
    delete rows[1].sourceOriginal;
    await mount(wire, doc => {
      assert.ok(doc.querySelectorAll('.evt')[0].textContent.includes(hostile));
      assert.equal(doc.querySelectorAll('.evt img').length, 0);
      assert.doesNotMatch(doc.querySelectorAll('.evt')[1].textContent, /Source:/);
    });
  });
  it('treats malformed summary totals and source metadata as unknown', async () => {
    const wire = await result({ summary: true }, 'twenty');
    const envelope = wire.structuredContent.projection;
    envelope.conflict_source = { ucdp: { candidateComplete: 'true', annualFailedPages: '2' } };
    delete envelope.data['ucdp-events'].candidateComplete;
    delete envelope.data['ucdp-events'].candidateVersion;
    for (const [count, failedPages] of [[undefined, undefined], [null, null], ['20', '2'], [-1, -1], [1, 1.5], [1.5, NaN]]) {
      envelope.data['ucdp-events'].events.count = count;
      envelope.conflict_source.ucdp.annualFailedPages = failedPages;
      await mount(wire, doc => {
        assert.match(doc.getElementById('foot').textContent, /Summary sample: 3 UCDP events; total unknown/);
        assert.match(doc.getElementById('foot').textContent, /Candidate completeness unknown/);
        assert.match(doc.getElementById('foot').textContent, /Annual base failed-page count unknown/);
        assert.doesNotMatch(doc.getElementById('foot').textContent, /completeness confirmed|pages failed: 2/);
      });
    }
  });
  it('does not turn an empty summary sample into authoritative no-events', async () => {
    const wire = await result({ summary: true }, 'twenty');
    const envelope = wire.structuredContent.projection;
    envelope.data['ucdp-events'].events.sample = [];
    await mount(wire, doc => {
      assert.match(doc.getElementById('list').textContent, /Summary contains no supplied event samples/);
      assert.match(doc.getElementById('foot').textContent, /Summary sample: 0 of 20 UCDP events/);
      assert.doesNotMatch(doc.getElementById('list').textContent, /No conflict events available/);
    });
  });
  it('keeps byte-budget truncation separate from the local display cap', async () => {
    const wire = await result({ limit: 0 }, 'large');
    const loaded = wire.structuredContent.data['ucdp-events'].events.length;
    await mount(wire, doc => {
      assert.ok(doc.getElementById('foot').textContent.includes('Showing 14 of ' + loaded + ' loaded UCDP events.'));
      assert.ok(doc.getElementById('foot').textContent.includes('Source response includes ' + loaded + ' of 160 events (output limit).'));
    });
  });
  it('counts appended rows and clears coverage and attribution after missing data', async () => {
    const full = await result({}, 'twenty');
    full.structuredContent.data['ucdp-events'].events[0] = null;
    const missing = await result({}, 'missing');
    await mount(full, async (doc, send) => {
      assert.match(doc.getElementById('foot').textContent, /Showing 13 of 20 loaded UCDP events/);
      await send(missing);
      assert.equal(doc.querySelectorAll('.evt').length, 0);
      assert.doesNotMatch(doc.getElementById('foot').textContent, /Showing|Candidate|Annual base/);
      assert.doesNotMatch(doc.getElementById('list').textContent, /Controlled UCDP cited publisher|No conflict events/);
    });
  });
});
