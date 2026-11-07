import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { anthropicComplete } from '../server/_shared/llm-anthropic.ts';

test('Anthropic deadline survives SDK header-timer cleanup', { timeout: 6000 }, async t => {
  let receivedHeaders = false;
  const server = createServer((_req, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.flushHeaders();
    response.write('{');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const originalFetch = globalThis.fetch;
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  t.after(async () => {
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  globalThis.fetch = async (_input, init) => {
    const response = await originalFetch(`http://127.0.0.1:${address.port}`, init);
    receivedHeaders = true;
    return response;
  };
  await assert.rejects(anthropicComplete({
    apiKey: 'fixture', model: 'fixture', messages: [{ role: 'user', content: 'fixture' }],
    maxTokens: 16, effort: 'low', timeoutMs: 1000,
  }));
  assert.equal(receivedHeaders, true, 'deadline must terminate body consumption after successful headers');
});
