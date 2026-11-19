// Redirects must never carry the API key (or session token) to another host:
// fetch forwards custom headers such as X-WorldMonitor-Key on redirect.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, describe, it } from 'node:test';

import { API_KEY_HEADER } from '../src/core.mjs';
import { run } from '../src/run.mjs';
import { createClient } from '../src/tui/data/client.mjs';

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((done) => s.close(done)))));

function listen(handler) {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((ready) => server.listen(0, '127.0.0.1', () => ready(`http://127.0.0.1:${server.address().port}`)));
}

async function redirectPair() {
  const seen = [];
  const target = await listen((req, res) => {
    seen.push({ url: req.url, key: req.headers[API_KEY_HEADER.toLowerCase()] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url.endsWith('openapi.json') ? '{"paths":{}}' : '{"jsonrpc":"2.0","id":1,"result":{}}');
  });
  const origin = await listen((req, res) => {
    req.resume();
    res.writeHead(307, { location: target + req.url });
    res.end();
  });
  return { origin, seen };
}

function io(env) {
  let out = '';
  let err = '';
  return { env, stdout: (s) => (out += s), stderr: (s) => (err += s), get out() { return out; }, get err() { return err; } };
}

describe('redirects', () => {
  it('run() does not follow MCP or REST redirects', async () => {
    const { origin, seen } = await redirectPair();
    const env = { WORLDMONITOR_API_KEY: 'wm_k', WORLDMONITOR_MCP_URL: `${origin}/mcp`, WORLDMONITOR_BASE_URL: origin };
    assert.equal(await run(['tools'], io(env)), 1);
    assert.equal(await run(['health'], io(env)), 1);
    assert.deepEqual(seen, []);
  });

  it('`list` follows the spec redirect but never sends the key', async () => {
    const { origin, seen } = await redirectPair();
    const env = { WORLDMONITOR_API_KEY: 'wm_k', WORLDMONITOR_SPEC_URL: `${origin}/openapi.json` };
    assert.equal(await run(['list'], io(env)), 0);
    assert.deepEqual(seen, [{ url: '/openapi.json', key: undefined }]);
  });

  it('`list` keeps the key across a same-origin spec redirect', async () => {
    const seen = [];
    const origin = await listen((req, res) => {
      if (req.url === '/old.json') {
        res.writeHead(301, { location: '/openapi.json' });
        return res.end();
      }
      seen.push(req.headers[API_KEY_HEADER.toLowerCase()]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"paths":{}}');
    });
    const env = { WORLDMONITOR_API_KEY: 'wm_k', WORLDMONITOR_SPEC_URL: `${origin}/old.json` };
    assert.equal(await run(['list'], io(env)), 0);
    assert.deepEqual(seen, ['wm_k']);
  });

  it('the TUI client does not follow redirects', async () => {
    const { origin, seen } = await redirectPair();
    const client = createClient({ baseUrl: `${origin}///`, apiKey: 'wm_k' });
    await assert.rejects(client.getJson('/api/bootstrap', { auth: 'session' }), { status: 307 });
    assert.equal(client.baseUrl, origin);
    assert.deepEqual(seen, []);
  });
});
