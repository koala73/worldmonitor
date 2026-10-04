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
const largeEvents = Array.from({ length: 160 }, (_, i) => ({
  ...events[2], id: 'large-' + i, sideA: 'Large event ' + i + ' ' + 'x'.repeat(1500),
}));
let activeEvents = events;
let missingUcdp = false;
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
  if (key === 'conflict:ucdp-events:v1') value = missingUcdp ? null : { events: activeEvents, fetchedAt, version: 'controlled', candidateVersion: 'controlled+partial', candidateComplete: false };
  else if (key === 'unrest:events:v1') value = { events: [] };
  else if (key === 'risk:scores:sebuf:stale:v8') value = { ciiScores: [] };
  else if (key === 'conflict:iran-events:v1') value = { events: [] };
  else if (key === 'seed-meta:conflict:ucdp-events' || key === 'seed-meta:unrest:events') value = { fetchedAt, recordCount: activeEvents.length };
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
  activeEvents = state === 'large' ? largeEvents : events;
  missingUcdp = state === 'missing';
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
