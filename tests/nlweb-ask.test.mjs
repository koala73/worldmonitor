import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

const vercelConfig = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf-8'));

// Guards for the NLWeb surface (orank Access `nlweb-ask` + `nlweb-streaming`):
// POST /ask must return NLWeb-conformant JSON with the `_meta`
// {response_type, version} envelope, and the streaming variant must be SSE
// with the NLWeb event types start → result → complete.
describe('nlweb: /ask endpoint', () => {
  let handler;

  before(async () => {
    const mod = await import(`../api/ask.ts?t=${Date.now()}`);
    handler = mod.default;
  });

  function post(body, headers = {}) {
    return handler(
      new Request('https://worldmonitor.app/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );
  }

  it('POST {query} returns NLWeb JSON with the _meta envelope', async () => {
    const res = await post({ query: 'live shipping chokepoint status' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Content-Type'), /application\/json/);
    const body = await res.json();
    assert.equal(body._meta.response_type, 'list');
    assert.ok(typeof body._meta.version === 'string' && body._meta.version.length > 0);
    assert.ok(body.query_id, 'must carry a query_id');
    assert.ok(Array.isArray(body.results) && body.results.length > 0);
    assert.equal(body.results[0].name, 'get_chokepoint_status');
    for (const r of body.results) {
      for (const field of ['url', 'name', 'site', 'score', 'description', 'schema_object']) {
        assert.ok(field in r, `result missing ${field}`);
      }
      assert.equal(r.site, 'worldmonitor.app');
    }
  });

  it('echoes a caller-provided query_id and caps its length', async () => {
    const res = await post({ query: 'country risk', query_id: 'q-123' });
    const body = await res.json();
    assert.equal(body.query_id, 'q-123');
  });

  it('no-match queries return the honest llms.txt fallback, not a fabricated hit', async () => {
    const res = await post({ query: 'zzzqx unmatchable gibberish' });
    const body = await res.json();
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].url, 'https://worldmonitor.app/llms.txt');
    assert.equal(body.results[0].score, 0);
  });

  it('prefer.streaming=true responds with SSE using start/result/complete event types', async () => {
    const res = await post({ query: 'market data', prefer: { streaming: true } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Content-Type'), /text\/event-stream/);
    const text = await res.text();
    const startIdx = text.indexOf('event: start');
    const resultIdx = text.indexOf('event: result');
    const completeIdx = text.indexOf('event: complete');
    assert.ok(startIdx >= 0, 'must emit a start event');
    assert.ok(resultIdx > startIdx, 'result must follow start');
    assert.ok(completeIdx > resultIdx, 'complete must follow results');
    // Every data line must be valid JSON, and start must carry the _meta envelope.
    const dataLines = text.split('\n').filter((l) => l.startsWith('data: '));
    const frames = dataLines.map((l) => JSON.parse(l.slice(6)));
    assert.ok(frames[0]._meta?.response_type, 'start frame must carry _meta');
    assert.equal(frames[0].message_type, 'start');
    assert.equal(frames.at(-1).message_type, 'complete');
  });

  it('streaming also triggers via top-level flag, Accept header, and ?prefer.streaming=', async () => {
    for (const req of [
      post({ query: 'conflict events', streaming: true }),
      post({ query: 'conflict events' }, { Accept: 'text/event-stream' }),
      handler(new Request('https://worldmonitor.app/ask?query=markets&prefer.streaming=true', { method: 'GET' })),
    ]) {
      const res = await req;
      assert.match(res.headers.get('Content-Type'), /text\/event-stream/);
      await res.text();
    }
  });

  it('query-less streaming probes get the usage envelope as SSE, not JSON', async () => {
    const res = await post({ prefer: { streaming: true } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Content-Type'), /text\/event-stream/);
    const text = await res.text();
    assert.ok(text.includes('event: start'), 'must open with a start event');
    assert.ok(text.includes('event: complete'), 'must close with a complete event');
  });

  it('GET with ?query= works for simple probes', async () => {
    const res = await handler(new Request('https://worldmonitor.app/ask?query=sanctions', { method: 'GET' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body._meta.response_type);
    assert.ok(body.results.length > 0);
  });

  it('form-encoded POST bodies are accepted', async () => {
    const res = await handler(
      new Request('https://worldmonitor.app/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'query=energy+intelligence',
      }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.results.length > 0);
  });

  it('query-less probes get a 200 self-describing NLWeb envelope (scanner existence checks read 4xx as absent)', async () => {
    const empty = await post({});
    assert.equal(empty.status, 200);
    const body = await empty.json();
    assert.ok(body._meta.response_type, 'usage envelope must stay _meta-conformant');
    assert.deepEqual(body.results, []);
    assert.match(body.message, /query/);
    const bareGet = await handler(new Request('https://worldmonitor.app/ask', { method: 'GET' }));
    assert.equal(bareGet.status, 200);
    const bad = await post('{not json');
    assert.equal(bad.status, 400);
  });

  it('unsupported methods → 405; OPTIONS → 204 with CORS', async () => {
    const del = await handler(new Request('https://worldmonitor.app/ask', { method: 'DELETE' }));
    assert.equal(del.status, 405);
    const options = await handler(new Request('https://worldmonitor.app/ask', { method: 'OPTIONS' }));
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('Access-Control-Allow-Origin'), '*');
  });

  it('vercel.json routes /ask to the endpoint and shields it from the SPA catch-all', () => {
    const rewrite = vercelConfig.rewrites.find((r) => r.source === '/ask');
    assert.ok(rewrite, 'missing /ask rewrite');
    assert.equal(rewrite.destination, '/api/ask');
    const catchAll = vercelConfig.rewrites.find(
      (r) => r.destination === '/dashboard.html' && r.source.startsWith('/((?!'),
    );
    assert.ok(catchAll.source.includes('ask'), 'ask must be excluded from the dashboard catch-all');
    const corsBlock = vercelConfig.headers.find((h) => h.source === '/ask');
    assert.ok(corsBlock, 'missing /ask headers block');
  });
});
