import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { fetchWithTimeout } from '../api/_relay.js';
import { run } from '../cli/src/run.mjs';

async function stalledBodyServer(t) {
  const server = createServer((_req, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.flushHeaders();
    response.write('{');
    // Never end: receiving headers must not disable the request deadline.
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('relay deadline aborts a body stalled after successful headers', { timeout: 3000 }, async t => {
  const url = await stalledBodyServer(t);
  const response = await fetchWithTimeout(url, {}, 100);
  assert.equal(response.status, 200);
  await assert.rejects(response.text(), error => ['AbortError', 'TimeoutError'].includes(error.name));
});

test('relay preserves caller cancellation before its own deadline', async () => {
  const controller = new AbortController();
  controller.abort(new Error('caller cancelled'));
  await assert.rejects(fetchWithTimeout('http://127.0.0.1:1', { signal: controller.signal }, 1000), /caller cancelled/);
});

for (const command of ['health', 'list']) {
  test(`CLI ${command} timeout covers response consumption`, { timeout: 3000 }, async t => {
    const url = await stalledBodyServer(t);
    let stderr = '';
    const args = command === 'list'
      ? ['list', '--spec-url', `${url}/openapi.json`, '--timeout', '100']
      : ['health', '--base-url', url, '--timeout', '100'];
    const exit = await run(args, { stdout: () => {}, stderr: text => { stderr += text; }, env: {} });
    assert.equal(exit, 1);
    assert.match(stderr, /timed out|aborted/i);
  });
}
